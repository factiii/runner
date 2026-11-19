// Native simulator capture + encode. Frames come from the display's own
// callbacks (no polling, no screenshots); each H.264 access unit is written to
// stdout as [4-byte BE length][Annex-B payload].
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <VideoToolbox/VideoToolbox.h>
#import <dlfcn.h>
#import <stdatomic.h>
#import <os/lock.h>

#import "h264encoder.h"

@interface SimServiceContext : NSObject
+ (instancetype)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
@end

@protocol SimDescriptorState <NSObject>
- (unsigned short)displayClass;
@end
@protocol SimPortDescriptor <NSObject>
- (id<SimDescriptorState>)state;
@end

@interface NSObject (SimPrivate)
- (id)io;
- (NSArray *)ioPorts;
- (id)descriptor;
- (id)framebufferSurface;
- (id)ioSurface;
- (void)registerScreenCallbacksWithUUID:(NSUUID *)uuid callbackQueue:(dispatch_queue_t)queue
    frameCallback:(void (^)(void))frame surfacesChangedCallback:(void (^)(id, id))surfaces
    propertiesChangedCallback:(void (^)(id))props;
- (void)registerCallbackWithUUID:(NSUUID *)uuid ioSurfacesChangeCallback:(void (^)(id))cb;
- (void)registerCallbackWithUUID:(NSUUID *)uuid damageRectanglesCallback:(void (^)(NSArray *))cb;
@end

// These port objects raise instead of answering respondsToSelector:, so every
// call has to be attempted rather than checked.
static NSError *guarded(void (^body)(void)) {
  @try { body(); return nil; }
  @catch (NSException *e) { return [NSError errorWithDomain:@"sim" code:1
    userInfo:@{NSLocalizedDescriptionKey: e.reason ?: e.name}]; }
}

// Xcode is not always at /Applications/Xcode.app: betas, renamed installs and
// CI images all move it, and `xcode-select` is what decides which one is
// active. Resolving it at run time is the difference between working on this
// Mac and working on any Mac.
static NSString *developerDir(void) {
  const char *override = getenv("DEVELOPER_DIR");
  if (override && *override) return @(override);

  NSTask *task = [NSTask new];
  task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
  task.arguments = @[ @"-p" ];
  NSPipe *pipe = [NSPipe pipe];
  task.standardOutput = pipe;
  task.standardError = [NSFileHandle fileHandleWithNullDevice];
  NSError *err = nil;
  if ([task launchAndReturnError:&err]) {
    NSData *out = [pipe.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    NSString *path = [[NSString alloc] initWithData:out encoding:NSUTF8StringEncoding];
    path = [path stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (path.length) return path;
  }
  return @"/Applications/Xcode.app/Contents/Developer";
}

/** CoreSimulator is installed outside Xcode.app, but a developer dir may carry
 *  its own copy; try both rather than assuming. */
static BOOL loadPrivateFrameworks(NSString *devDir, void **simulatorKit) {
  NSArray<NSString *> *coreSim = @[
    @"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
    [devDir stringByAppendingString:@"/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"]
  ];
  BOOL loadedCore = NO;
  for (NSString *path in coreSim) {
    if (dlopen(path.UTF8String, RTLD_NOW)) { loadedCore = YES; break; }
  }
  NSString *kitPath = [devDir stringByAppendingString:
      @"/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
  void *kit = dlopen(kitPath.UTF8String, RTLD_NOW);
  if (!kit) {
    // Xcode 27 moved SimulatorKit out of Developer/Library/PrivateFrameworks
    // into Contents/SharedFrameworks, beside the Developer directory.
    NSString *shared = [[devDir stringByDeletingLastPathComponent]
        stringByAppendingString:@"/SharedFrameworks/SimulatorKit.framework/SimulatorKit"];
    kit = dlopen(shared.UTF8String, RTLD_NOW);
  }
  if (simulatorKit) *simulatorKit = kit;
  if (!loadedCore || !kit) {
    fprintf(stderr, "Could not load the simulator frameworks from %s\n", devDir.UTF8String);
    return NO;
  }
  return YES;
}

static IOSurfaceRef gSurface = NULL;
static os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;

// The encoder itself (session, Annex-B framing, stdout) is h264encoder.h,
// which the browser panel's jpegstream shares.
static void encodeH264(IOSurfaceRef surface) {
  CVPixelBufferRef pixels = NULL;
  CVReturn cvr = CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, surface, NULL, &pixels);
  if (cvr != kCVReturnSuccess) { fprintf(stderr, "CVPixelBufferCreateWithIOSurface failed: %d\n", cvr); return; }
  h264EncodePixels(pixels);
  CVPixelBufferRelease(pixels);
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 2) { fprintf(stderr, "usage: simstream <udid> [--fps N] [--width N] [--bitrate N]\n"); return 2; }
    NSString *wanted = @(argv[1]);
    for (int i = 2; i < argc; i++) h264Option(argc, argv, &i);
    h264Start();

    NSString *devDir = developerDir();
    if (!loadPrivateFrameworks(devDir, NULL)) return 1;

    NSError *err = nil;
    id ctx = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:devDir error:&err];
    id set = [ctx defaultDeviceSetWithError:&err];
    id device = nil;
    for (id d in [set performSelector:@selector(devices)])
      if ([[[d performSelector:@selector(UDID)] description] caseInsensitiveCompare:wanted] == NSOrderedSame) { device = d; break; }
    if (!device) { fprintf(stderr, "device not found\n"); return 1; }
    id ioClient = [device io];
    if (!ioClient) { fprintf(stderr, "no io client\n"); return 1; }

    id display = nil, fallback = nil;
    for (id port in [ioClient ioPorts]) {
      __block id descriptor = nil;
      guarded(^{ descriptor = [port descriptor]; });
      if (!descriptor) continue;
      __block id<SimDescriptorState> st = nil;
      id<SimPortDescriptor> typed = descriptor;
      if (guarded(^{ st = [typed state]; }) || !st) continue;
      __block int cls = -1;
      if (guarded(^{ cls = [st displayClass]; })) continue;
      if (cls == 0) { display = descriptor; break; }
      if (!fallback) fallback = descriptor;
    }
    if (!display) display = fallback;
    if (!display) { fprintf(stderr, "no display\n"); return 1; }

    void (^onSurface)(id) = ^(id s) {
      os_unfair_lock_lock(&gLock);
      if (gSurface) { CFRelease(gSurface); gSurface = NULL; }
      if (s) gSurface = (IOSurfaceRef)CFRetain((__bridge CFTypeRef)s);
      os_unfair_lock_unlock(&gLock);
    };

    NSUUID *token = [NSUUID UUID];
    dispatch_queue_t cbq = dispatch_queue_create("sim.cb", DISPATCH_QUEUE_SERIAL);
    NSError *newStyle = guarded(^{
      [display registerScreenCallbacksWithUUID:token callbackQueue:cbq
        frameCallback:^{}
        surfacesChangedCallback:^(id fb, id masked) { onSurface(fb); }
        propertiesChangedCallback:^(id p) {}];
    });
    if (newStyle) {
      guarded(^{ [display registerCallbackWithUUID:token ioSurfacesChangeCallback:^(id s) { onSurface(s); }]; });
      guarded(^{ [display registerCallbackWithUUID:token damageRectanglesCallback:^(NSArray *r) {}]; });
      fprintf(stderr, "old-style callbacks\n");
    } else {
      fprintf(stderr, "new-style SimScreen callbacks\n");
    }
    if (!gSurface) {
      __block id s = nil;
      guarded(^{ s = [display framebufferSurface]; });
      if (!s) guarded(^{ s = [display ioSurface]; });
      if (s) onSurface(s);
    }

    // Encode on a timer rather than per callback: the display fires ~60 times a
    // second and the surface is a live buffer, so sampling it on our own cadence
    // costs nothing and never queues work we would have to drop later.
    dispatch_source_t tick = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
        dispatch_queue_create("sim.encode", DISPATCH_QUEUE_SERIAL));
    dispatch_source_set_timer(tick, dispatch_time(DISPATCH_TIME_NOW, 0),
        (uint64_t)(NSEC_PER_SEC / gFPS), NSEC_PER_SEC / 100);
    dispatch_source_set_event_handler(tick, ^{
      os_unfair_lock_lock(&gLock);
      IOSurfaceRef s = gSurface ? (IOSurfaceRef)CFRetain(gSurface) : NULL;
      os_unfair_lock_unlock(&gLock);
      // A blanked or sleeping display vends no surface, and the symptom is
      // otherwise a black panel with no error anywhere. Logged on the change
      // only — a heartbeat here is thousands of lines an hour.
      static int had = -1;
      const int has = s ? 1 : 0;
      if (has != had) {
        had = has;
        fprintf(stderr, "display surface %s\n", has ? "available" : "gone");
      }
      if (!s) return;
      encodeH264(s);
      CFRelease(s);
    });
    dispatch_resume(tick);
    fprintf(stderr, "streaming h264 at %d fps\n", gFPS);
    [[NSRunLoop currentRunLoop] run];
    return 0;
  }
}
