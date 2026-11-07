// Native simulator input over the legacy Indigo HID path. Reads one JSON
// command per line on stdin. Unlike idb's input, this exposes a real move
// phase, so a drag tracks the pointer instead of being a canned swipe.
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <mach/mach_time.h>

@interface SimServiceContext : NSObject
+ (instancetype)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
@end

@interface NSObject (SimHID)
- (instancetype)initWithDevice:(id)device error:(NSError **)error;
- (BOOL)postDarwinNotification:(NSString *)name error:(NSError **)error;
- (BOOL)darwinNotificationSetState:(uint64_t)state
                              name:(NSString *)name
                             error:(NSError **)error;
- (void)sendWithMessage:(void *)message freeWhenDone:(BOOL)freeWhenDone
        completionQueue:(dispatch_queue_t)queue completion:(void (^)(NSError *))completion;
@end

// SimulatorKit builds the Indigo wire messages; we only address and send them.
typedef void *(*MouseFn)(CGPoint *, CGPoint *, uint32_t, NSUInteger, CGSize, uint32_t);
typedef void *(*KeyFn)(uint32_t, uint32_t);
typedef void *(*ButtonFn)(uint32_t, uint32_t, uint32_t);
static MouseFn gMouse;
static KeyFn gKey;
static ButtonFn gButton;
static id gClient;
static id gDevice;

// The HID service the touchscreen lives behind, and a size of 1x1 because the
// builder divides the point by it and we already pass a 0..1 ratio.
static const uint32_t kTouchTarget = 0x32;
static const CGSize kUnit = { 1, 1 };
static const uint32_t kNoEdge = 0;

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

static void sendMessage(void *message) {
  if (!message) return;
  [gClient sendWithMessage:message freeWhenDone:YES completionQueue:dispatch_get_main_queue()
                completion:^(NSError *e) { if (e) fprintf(stderr, "send: %s\n", e.localizedDescription.UTF8String); }];
}

// Indigo wire offsets (Indigo.h, all structs packed). A message is a mach
// header, then innerSize/eventType, then payloads.
static const size_t kMachHeaderBytes = 0x18;
static const size_t kInnerSizeOffset = 0x18;
static const size_t kEventTypeOffset = 0x1c;
static const size_t kPayloadOffset = 0x20;   // eventKind, +4 timestamp, +0x10 event
static const size_t kEventOffset = 0x30;     // the IndigoTouch inside payload 1
static const size_t kTouchBytes = 0x74;      // through the trailing field
static const size_t kPayloadSize = 0x90;     // Swift's sizeof(IndigoPayload)
static const size_t kSecondPayload = 0xb0;   // hand-built messages use the Swift stride
static const size_t kMessageBytes = 0x140;   // sizeof(IndigoMessage) + sizeof(IndigoPayload)
static const uint8_t kEventTypeSingleTouch = 0x02;
static const uint32_t kEventKindTouch = 0x0b;

/**
 * A single-touch Indigo message for one contact.
 *
 * SimulatorKit has no single-touch builder — `IndigoHIDMessageForMouseNSEvent`
 * always emits a *multi*-touch message (eventType 0x03). Sending that raw looks
 * like it works, because SpringBoard's lock screen accepts it, but an unlocked
 * device's apps ignore it entirely. So take the valid IndigoTouch the builder
 * produces and re-envelope it as single-touch (0x02) with a duplicated second
 * contact, which is what Simulator.app itself sends.
 */
static void touch(double x, double y, NSEventType type) {
  CGPoint p = CGPointMake(x, y);
  void *source = gMouse(&p, NULL, kTouchTarget, (NSUInteger)type, kUnit, kNoEdge);
  if (!source) return;
  uint8_t *src = (uint8_t *)source;

  // The builder normalises by the NSSize it was handed; we pass a unit size and
  // a ratio, so write the coordinates back explicitly.
  memcpy(src + kEventOffset + 0x0c, &x, sizeof(double));
  memcpy(src + kEventOffset + 0x14, &y, sizeof(double));

  uint8_t *dst = (uint8_t *)calloc(1, kMessageBytes);
  if (!dst) { free(source); return; }

  // The mach header the builder produced, kept verbatim. A zeroed one is not
  // rejected loudly — the message is simply never delivered, which is why
  // buttons (sent raw, header intact) worked while touches disappeared.
  memcpy(dst, src, kMachHeaderBytes);

  const uint32_t innerSize = (uint32_t)kPayloadSize;
  memcpy(dst + kInnerSizeOffset, &innerSize, sizeof(uint32_t));
  dst[kEventTypeOffset] = kEventTypeSingleTouch;
  memcpy(dst + kPayloadOffset, &kEventKindTouch, sizeof(uint32_t));
  const uint64_t now = mach_absolute_time();
  memcpy(dst + kPayloadOffset + 0x04, &now, sizeof(uint64_t));
  memcpy(dst + kEventOffset, src + kEventOffset, kTouchBytes);
  free(source);

  // The second contact is a copy of the first, marked as the duplicate.
  memcpy(dst + kSecondPayload, dst + kPayloadOffset, kPayloadSize);
  const uint32_t one = 1, two = 2;
  memcpy(dst + kSecondPayload + 0x10, &one, sizeof(uint32_t));
  memcpy(dst + kSecondPayload + 0x14, &two, sizeof(uint32_t));

  sendMessage(dst);
}

static void key(uint32_t code, BOOL down) { sendMessage(gKey(code, down ? 1 : 2)); }

/**
 * Biometric auth, which is not HID at all — it is a Darwin notification, the
 * same one Simulator.app's Features menu posts. Names taken from that binary:
 * "pearl" is Face ID, "fingerTouch" is Touch ID.
 *
 * A match on an unenrolled device is ignored in silence, so enrolment is set
 * first: a state flag, then the change notification BiometricKit watches for.
 */
static void biometric(BOOL face, BOOL match) {
  NSError *err = nil;
  NSString *enrolledKey =
      [NSString stringWithFormat:@"com.apple.BiometricKit_Sim.%@id_enrolled",
                                 face ? @"pearl" : @"touch"];
  [gDevice darwinNotificationSetState:1 name:enrolledKey error:&err];
  [gDevice postDarwinNotification:@"com.apple.BiometricKit.enrollmentChanged"
                            error:&err];

  NSString *name =
      [NSString stringWithFormat:@"com.apple.BiometricKit_Sim.%@.%@",
                                 face ? @"pearl" : @"fingerTouch",
                                 match ? @"match" : @"nomatch"];
  if (![gDevice postDarwinNotification:name error:&err]) {
    fprintf(stderr, "biometric: %s\n", err.localizedDescription.UTF8String);
  }
}

// ButtonEventSource values from Indigo.h. Not sequential, and not the same
// numbering any public API uses.
static uint32_t buttonSource(NSString *name) {
  if ([name isEqual:@"HOME"]) return 0x0;
  if ([name isEqual:@"LOCK"]) return 0x1;
  if ([name isEqual:@"SIDE"]) return 0xbb8;
  if ([name isEqual:@"SIRI"]) return 0x400002;
  if ([name isEqual:@"APPLE_PAY"]) return 0x1f4;
  return UINT32_MAX;
}

static void button(uint32_t source, BOOL down) {
  sendMessage(gButton(source, down ? 1 : 2, kTouchTarget));
}

// USB HID usage codes. There is no "type a string" event at this level.
static BOOL keycodeFor(unichar c, uint32_t *code, BOOL *shift) {
  *shift = NO;
  if (c >= 'a' && c <= 'z') { *code = c - 'a' + 4; return YES; }
  if (c >= 'A' && c <= 'Z') { *code = c - 'A' + 4; *shift = YES; return YES; }
  if (c >= '1' && c <= '9') { *code = c - '1' + 30; return YES; }
  if (c == '0') { *code = 39; return YES; }
  static const unichar plain[] = { ' ', '\n', '\t', '-', '=', '[', ']', '\\', ';', '\'', '`', ',', '.', '/' };
  static const uint32_t plainCode[] = { 44, 40, 43, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56 };
  static const unichar shifted[] = { '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '{', '}', '|', ':', '"', '~', '<', '>', '?' };
  static const uint32_t shiftedCode[] = { 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56 };
  for (size_t i = 0; i < sizeof(plain) / sizeof(*plain); i++)
    if (plain[i] == c) { *code = plainCode[i]; return YES; }
  for (size_t i = 0; i < sizeof(shifted) / sizeof(*shifted); i++)
    if (shifted[i] == c) { *code = shiftedCode[i]; *shift = YES; return YES; }
  return NO;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 2) { fprintf(stderr, "usage: simhid <udid>  (JSON commands on stdin)\n"); return 2; }
    NSString *wanted = @(argv[1]);
    NSString *devDir = developerDir();
    void *kit = NULL;
    if (!loadPrivateFrameworks(devDir, &kit)) return 1;

    gMouse = (MouseFn)dlsym(kit, "IndigoHIDMessageForMouseNSEvent");
    gKey = (KeyFn)dlsym(kit, "IndigoHIDMessageForKeyboardArbitrary");
    gButton = (ButtonFn)dlsym(kit, "IndigoHIDMessageForButton");
    if (!gMouse || !gKey || !gButton) { fprintf(stderr, "indigo builders missing\n"); return 1; }

    NSError *err = nil;
    id ctx = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:devDir error:&err];
    id set = [ctx defaultDeviceSetWithError:&err];
    id device = nil;
    for (id d in [set performSelector:@selector(devices)])
      if ([[[d performSelector:@selector(UDID)] description] caseInsensitiveCompare:wanted] == NSOrderedSame) { device = d; break; }
    if (!device) { fprintf(stderr, "device not found\n"); return 1; }

    gDevice = device;
    gClient = [[NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient") alloc] initWithDevice:device error:&err];
    if (!gClient) { fprintf(stderr, "hid client: %s\n", err.description.UTF8String); return 1; }
    fprintf(stderr, "indigo hid ready\n");

    NSFileHandle *in = [NSFileHandle fileHandleWithStandardInput];
    NSMutableData *pending = [NSMutableData data];
    while (YES) {
      NSData *chunk = [in availableData];
      if (!chunk.length) break;
      [pending appendData:chunk];
      for (;;) {
        NSRange nl = [pending rangeOfData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]
                                  options:0 range:NSMakeRange(0, pending.length)];
        if (nl.location == NSNotFound) break;
        NSData *line = [pending subdataWithRange:NSMakeRange(0, nl.location)];
        [pending replaceBytesInRange:NSMakeRange(0, nl.location + 1) withBytes:NULL length:0];
        NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
        if (![cmd isKindOfClass:NSDictionary.class]) continue;
        NSString *type = cmd[@"type"];

        if ([type isEqual:@"touch"]) {
          NSString *phase = cmd[@"phase"];
          NSEventType e = [phase isEqual:@"down"] ? NSEventTypeLeftMouseDown
                        : [phase isEqual:@"up"] ? NSEventTypeLeftMouseUp
                        : NSEventTypeLeftMouseDragged;
          touch([cmd[@"x"] doubleValue], [cmd[@"y"] doubleValue], e);
        } else if ([type isEqual:@"tap"]) {
          double x = [cmd[@"x"] doubleValue], y = [cmd[@"y"] doubleValue];
          touch(x, y, NSEventTypeLeftMouseDown);
          usleep(30000);
          touch(x, y, NSEventTypeLeftMouseUp);
        } else if ([type isEqual:@"text"]) {
          NSString *text = cmd[@"text"];
          for (NSUInteger i = 0; i < text.length; i++) {
            uint32_t code; BOOL shift;
            if (!keycodeFor([text characterAtIndex:i], &code, &shift)) continue;
            if (shift) key(225, YES);
            key(code, YES); usleep(6000); key(code, NO);
            if (shift) key(225, NO);
            usleep(6000);
          }
        } else if ([type isEqual:@"button"]) {
          uint32_t source = buttonSource(cmd[@"button"]);
          if (source == UINT32_MAX) { fprintf(stderr, "unknown button\n"); continue; }
          button(source, YES); usleep(60000); button(source, NO);
        } else if ([type isEqual:@"biometric"]) {
          biometric(![cmd[@"kind"] isEqual:@"touch"], [cmd[@"match"] boolValue]);
        } else if ([type isEqual:@"key"]) {
          key((uint32_t)[cmd[@"code"] unsignedIntValue], [cmd[@"down"] boolValue]);
        }
      }
    }
    return 0;
  }
}
