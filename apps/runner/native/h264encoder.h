// The runner's one H.264 encoder: VideoToolbox, hardware, real time. Shared by
// `simstream.m` (the simulator's display) and `jpegstream.m` (a Chrome tab's
// screencast), so both put the same stream on the video track. Each access
// unit is written to stdout as [4-byte BE length][Annex-B payload].
//
// A header of static functions, not a library: each helper is one `.m`
// compiled on the host by itself (simulator-store.ts `build`).
#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>

static int gFPS = 30, gWidth = 0;
static int gBitrate = 2500000;
static VTCompressionSessionRef gSession = NULL;
/** Source size the session was built for. A rotation (or a resized browser
 *  window) changes the source, and a session only accepts the dimensions it
 *  was created with — so the session has to be rebuilt rather than fed buffers
 *  it will reject. */
static size_t gSourceWidth = 0, gSourceHeight = 0;
static dispatch_queue_t gWrite;

/** `--fps N`, `--width N`, `--bitrate N`: true when argv[*i] was one of them
 *  (and *i now sits on its value). */
static BOOL h264Option(int argc, const char **argv, int *i) {
  if (!strcmp(argv[*i], "--fps") && *i + 1 < argc) { gFPS = atoi(argv[++*i]); return YES; }
  if (!strcmp(argv[*i], "--width") && *i + 1 < argc) { gWidth = atoi(argv[++*i]); return YES; }
  if (!strcmp(argv[*i], "--bitrate") && *i + 1 < argc) { gBitrate = atoi(argv[++*i]); return YES; }
  return NO;
}

/** Once, before the first frame. */
static void h264Start(void) {
  setvbuf(stderr, NULL, _IONBF, 0);
  gWrite = dispatch_queue_create("h264.write", DISPATCH_QUEUE_SERIAL);
}

static void emit(const void *bytes, size_t len) {
  dispatch_sync(gWrite, ^{
    uint8_t header[4] = { (uint8_t)(len >> 24), (uint8_t)(len >> 16),
                          (uint8_t)(len >> 8), (uint8_t)len };
    fwrite(header, 1, 4, stdout);
    fwrite(bytes, 1, len, stdout);
    fflush(stdout);
  });
}

// H.264 on the wire is Annex-B: each NAL prefixed with 00 00 00 01. VideoToolbox
// hands back AVCC (4-byte lengths), and parameter sets separately — they must be
// re-sent before every keyframe or a decoder joining late sees nothing.
static void appendAnnexB(NSMutableData *out, const uint8_t *nal, size_t len) {
  const uint8_t start[4] = { 0, 0, 0, 1 };
  [out appendBytes:start length:4];
  [out appendBytes:nal length:len];
}

static void onEncoded(void *ctx, void *src, OSStatus status, VTEncodeInfoFlags flags,
                      CMSampleBufferRef sample) {
  if (status != noErr) { fprintf(stderr, "encoder callback status %d\n", (int)status); return; }
  if (!sample || !CMSampleBufferDataIsReady(sample)) { fprintf(stderr, "sample not ready\n"); return; }
  NSMutableData *out = [NSMutableData data];

  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  BOOL keyframe = YES;
  if (attachments && CFArrayGetCount(attachments)) {
    CFDictionaryRef d = CFArrayGetValueAtIndex(attachments, 0);
    keyframe = !CFDictionaryContainsKey(d, kCMSampleAttachmentKey_NotSync);
  }
  if (keyframe) {
    CMFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sample);
    size_t count = 0;
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, 0, NULL, NULL, &count, NULL);
    for (size_t i = 0; i < count; i++) {
      const uint8_t *ps = NULL; size_t psLen = 0;
      if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, i, &ps, &psLen, NULL, NULL) == noErr)
        appendAnnexB(out, ps, psLen);
    }
  }

  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
  size_t total = 0; char *data = NULL;
  if (CMBlockBufferGetDataPointer(block, 0, NULL, &total, &data) != noErr) return;
  size_t offset = 0;
  while (offset + 4 <= total) {
    uint32_t len = 0;
    memcpy(&len, data + offset, 4);
    len = CFSwapInt32BigToHost(len);
    offset += 4;
    if (len == 0 || offset + len > total) break;
    appendAnnexB(out, (const uint8_t *)(data + offset), len);
    offset += len;
  }
  emit(out.bytes, out.length);
}

/** Encode one frame. Call from one serial queue only. The caller keeps its
 *  reference to `pixels`. */
static void h264EncodePixels(CVPixelBufferRef pixels) {
  size_t sourceWidth = CVPixelBufferGetWidth(pixels);
  size_t sourceHeight = CVPixelBufferGetHeight(pixels);
  if (gSession && (sourceWidth != gSourceWidth || sourceHeight != gSourceHeight)) {
    fprintf(stderr, "source %zux%zu -> %zux%zu, rebuilding encoder\n",
            gSourceWidth, gSourceHeight, sourceWidth, sourceHeight);
    VTCompressionSessionCompleteFrames(gSession, kCMTimeInvalid);
    VTCompressionSessionInvalidate(gSession);
    CFRelease(gSession);
    gSession = NULL;
  }
  if (!gSession) {
    size_t w = sourceWidth, h = sourceHeight;
    if (gWidth > 0 && w > (size_t)gWidth) {
      h = h * gWidth / w;
      w = gWidth;
    }
    // H.264 chroma is subsampled, so both axes must be even.
    w -= w & 1;
    h -= h & 1;
    NSDictionary *props = @{ (id)kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: @YES };
    OSStatus cs;
    if ((cs = VTCompressionSessionCreate(NULL, (int32_t)w, (int32_t)h, kCMVideoCodecType_H264,
          (__bridge CFDictionaryRef)props, NULL, NULL, onEncoded, NULL, &gSession)) != noErr) {
      fprintf(stderr, "VTCompressionSessionCreate failed: %d\n", (int)cs);
      return;
    }
    VTSessionSetProperty(gSession, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    // B-frames buy compression and cost a frame of latency. Wrong trade for a
    // remote control.
    VTSessionSetProperty(gSession, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
    VTSessionSetProperty(gSession, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
    // One a second. A viewer joining mid-stream, or one that has lost a
    // packet, decodes nothing until the next keyframe arrives — and the far end
    // has no way to ask us for one, so the interval is the only recovery.
    VTSessionSetProperty(gSession, kVTCompressionPropertyKey_MaxKeyFrameInterval,
                         (__bridge CFTypeRef)@(gFPS));
    VTSessionSetProperty(gSession, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                         (__bridge CFTypeRef)@1.0);
    VTSessionSetProperty(gSession, kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFTypeRef)@(gFPS));
    // Without a ceiling the encoder spends whatever a full-screen scroll asks
    // for — measured at 9.4 Mbps. A cap plus a one-second burst limit keeps a
    // busy screen inside something a phone connection can carry.
    VTSessionSetProperty(gSession, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFTypeRef)@(gBitrate));
    VTSessionSetProperty(gSession, kVTCompressionPropertyKey_DataRateLimits,
        (__bridge CFArrayRef)@[@(gBitrate / 8 * 1.5), @1.0]);
    gSourceWidth = sourceWidth;
    gSourceHeight = sourceHeight;
    fprintf(stderr, "h264 session %zux%zu\n", w, h);
  }
  static int64_t n = 0;
  CMTime pts = CMTimeMake(n++, gFPS);
  OSStatus es = VTCompressionSessionEncodeFrame(gSession, pixels, pts, kCMTimeInvalid, NULL, NULL, NULL);
  if (es != noErr) fprintf(stderr, "encode failed: %d\n", (int)es);
}
