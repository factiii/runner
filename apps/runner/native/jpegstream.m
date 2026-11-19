// The browser panel's encoder (.specs/browser-panel.md). JPEG frames from a
// Chrome tab's screencast arrive on stdin as [4-byte BE length][JPEG]; each
// H.264 access unit leaves on stdout as [4-byte BE length][Annex-B payload],
// the framing simstream writes, through the same encoder (h264encoder.h).
//
// Chrome sends a frame only when the page changes. The newest one is encoded
// on a timer, as simstream samples the simulator's surface, so a still page
// still gets its keyframe every second: that is a late or lossy viewer's only
// recovery.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <VideoToolbox/VideoToolbox.h>
#import <os/lock.h>

#import "h264encoder.h"

/** A frame larger than this is not a screencast frame: stop rather than
 *  allocate whatever the length field says. */
#define MAX_JPEG_BYTES (32u * 1024u * 1024u)

static CVPixelBufferRef gLatest = NULL;
static os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;

/** Decode one JPEG into a BGRA pixel buffer the encoder takes. NULL when the
 *  bytes are not an image. */
static CVPixelBufferRef decodeJPEG(NSData *jpeg) {
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)jpeg, NULL);
  if (!source) return NULL;
  CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
  CFRelease(source);
  if (!image) return NULL;

  size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
  CVPixelBufferRef pixels = NULL;
  NSDictionary *attrs = @{ (id)kCVPixelBufferIOSurfacePropertiesKey: @{} };
  if (w < 2 || h < 2 ||
      CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA,
                          (__bridge CFDictionaryRef)attrs, &pixels) != kCVReturnSuccess) {
    CGImageRelease(image);
    return NULL;
  }
  CVPixelBufferLockBaseAddress(pixels, 0);
  CGColorSpaceRef rgb = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(pixels), w, h, 8,
      CVPixelBufferGetBytesPerRow(pixels), rgb,
      kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst);
  if (ctx) {
    CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
    CGContextRelease(ctx);
  }
  CGColorSpaceRelease(rgb);
  CVPixelBufferUnlockBaseAddress(pixels, 0);
  CGImageRelease(image);
  if (!ctx) { CVPixelBufferRelease(pixels); return NULL; }
  return pixels;
}

/** Exactly `len` bytes, or NO at end of input. */
static BOOL readFully(void *into, size_t len) {
  return fread(into, 1, len, stdin) == len;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    for (int i = 1; i < argc; i++) h264Option(argc, argv, &i);
    if (gFPS < 1) gFPS = 30;
    h264Start();

    dispatch_source_t tick = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
        dispatch_queue_create("jpeg.encode", DISPATCH_QUEUE_SERIAL));
    dispatch_source_set_timer(tick, dispatch_time(DISPATCH_TIME_NOW, 0),
        (uint64_t)(NSEC_PER_SEC / gFPS), NSEC_PER_SEC / 100);
    dispatch_source_set_event_handler(tick, ^{
      os_unfair_lock_lock(&gLock);
      CVPixelBufferRef pixels = gLatest ? CVPixelBufferRetain(gLatest) : NULL;
      os_unfair_lock_unlock(&gLock);
      if (!pixels) return;
      h264EncodePixels(pixels);
      CVPixelBufferRelease(pixels);
    });
    dispatch_resume(tick);
    fprintf(stderr, "encoding jpeg frames at %d fps\n", gFPS);

    // The read loop is the main thread: stdin closing (the runner detached, or
    // died) ends the process.
    for (;;) {
      @autoreleasepool {
        uint8_t header[4];
        if (!readFully(header, 4)) break;
        uint32_t len = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16) |
                       ((uint32_t)header[2] << 8) | (uint32_t)header[3];
        if (len == 0 || len > MAX_JPEG_BYTES) { fprintf(stderr, "bad frame length %u\n", len); break; }
        NSMutableData *jpeg = [NSMutableData dataWithLength:len];
        if (!readFully(jpeg.mutableBytes, len)) break;
        CVPixelBufferRef pixels = decodeJPEG(jpeg);
        if (!pixels) { fprintf(stderr, "frame is not a decodable image\n"); continue; }
        os_unfair_lock_lock(&gLock);
        CVPixelBufferRef old = gLatest;
        gLatest = pixels;
        os_unfair_lock_unlock(&gLock);
        if (old) CVPixelBufferRelease(old);
      }
    }
    return 0;
  }
}
