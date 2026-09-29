// epdf-mac-scan: the macOS scanner helper for Epdf's "Scan to PDF", built on Apple's ImageCaptureCore framework.
// Objective-C with ARC, compiled with clang by build.sh (no Swift toolchain or Xcode needed).
//
// STATUS: compiled and run on macOS 26 (Apple Silicon, and the Intel half under Rosetta) WITHOUT A SCANNER: device
// discovery ("no scanners"), argument handling and the error paths are tested. Opening a real scanner, reading its
// capabilities and scanning have NOT been tried with real hardware.
//
// Protocol (same as the Windows script; see src/main/features/scan/protocol.ts): one JSON object per line on stdout.
//   epdf-mac-scan list                                -> {"type":"devices","devices":[{"id","name","manufacturer"}]} {"type":"done"}
//   epdf-mac-scan caps   (params in EPDF_SCAN_PARAMS) -> {"type":"caps","resolutions":[..],"colorModes":[..],"sources":[..],"duplex":bool} {"type":"done"}
//   epdf-mac-scan scan   (params in EPDF_SCAN_PARAMS) -> {"type":"progress",..} {"type":"page","index":1,"file":"<dir>/page.png","dpi":300} ... {"type":"done","pages":n}
//   errors                                            -> {"type":"error","code":"paper_jam|no_paper|busy|offline|cover_open|not_found|...","message":".."} and exit status 2
// Parameters are JSON in the EPDF_SCAN_PARAMS environment variable: {"command","deviceId","dpi","colorMode":"color|gray|bw",
// "source":"flatbed|feeder","duplex":bool,"maxPages":n,"dir":"<existing directory for page files>"}.
// The first argument, when given, is the command (it wins over "command" in the parameters).
// Pages are written as PNG files inside `dir`; Epdf reads and deletes them. Cancelling = Epdf terminates this process
// (SIGTERM, exit status 0).
//
// Timing: `list` answers after 3.5 s of device discovery. `caps` and `scan` fail with "not_found" when the device has not
// appeared after 20 s. Everything after that is bounded by Epdf's own idle timeouts (45 s for caps, 5 min for a scan).

#import <Foundation/Foundation.h>
#import <ImageCaptureCore/ImageCaptureCore.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

// MARK: - output helpers

static void emit(NSDictionary *object) {
    if (![NSJSONSerialization isValidJSONObject:object]) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:NULL];
    if (!data) return;
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void fail(NSString *code, NSString *message) __attribute__((noreturn));
static void fail(NSString *code, NSString *message) {
    NSMutableDictionary *o = [NSMutableDictionary dictionaryWithDictionary:@{ @"type": @"error", @"message": message ?: @"" }];
    if (code) o[@"code"] = code;
    emit(o);
    exit(2);
}

/// Maps an ImageCaptureCore error onto the protocol's error codes (by text; the framework's codes are poorly documented).
static NSString *codeFor(NSError *error) {
    NSString *t = error.localizedDescription.lowercaseString ?: @"";
    if ([t containsString:@"jam"]) return @"paper_jam";
    if ([t containsString:@"no paper"] || [t containsString:@"empty"] || [t containsString:@"out of paper"]) return @"no_paper";
    if ([t containsString:@"busy"] || [t containsString:@"in use"]) return @"busy";
    if ([t containsString:@"cover"] || [t containsString:@"door"]) return @"cover_open";
    if ([t containsString:@"offline"] || [t containsString:@"not connected"] || [t containsString:@"disconnected"]) return @"offline";
    if ([t containsString:@"warming"]) return @"warming_up";
    if ([t containsString:@"lock"]) return @"locked";
    return nil;
}

static NSString *errorText(NSError *error) { return error.localizedDescription ?: @"The scanner reported an error."; }

// MARK: - parameters

@interface Params : NSObject
@property (copy) NSString *command;
@property (copy) NSString *deviceId;
@property NSInteger dpi;
@property (copy) NSString *colorMode;
@property (copy) NSString *source;
@property BOOL duplex;
@property NSInteger maxPages;
@property (copy) NSString *dir;
@end

@implementation Params
- (instancetype)initWithJSON:(NSDictionary *)json {
    if ((self = [super init])) {
        NSString *(^str)(NSString *, NSString *) = ^NSString *(NSString *key, NSString *fallback) {
            id v = json[key];
            return [v isKindOfClass:[NSString class]] ? v : fallback;
        };
        NSInteger (^integer)(NSString *, NSInteger) = ^NSInteger(NSString *key, NSInteger fallback) {
            id v = json[key];
            return [v isKindOfClass:[NSNumber class]] ? [v integerValue] : fallback;
        };
        id duplex = json[@"duplex"];
        _command = str(@"command", @"");
        _deviceId = str(@"deviceId", @"");
        _dpi = integer(@"dpi", 300);
        _colorMode = str(@"colorMode", @"color");
        _source = str(@"source", @"flatbed");
        _duplex = [duplex isKindOfClass:[NSNumber class]] ? [duplex boolValue] : NO;
        _maxPages = integer(@"maxPages", 1);
        _dir = str(@"dir", @"");
    }
    return self;
}

+ (Params *)fromEnvironment {
    NSString *raw = NSProcessInfo.processInfo.environment[@"EPDF_SCAN_PARAMS"];
    NSData *data = [raw dataUsingEncoding:NSUTF8StringEncoding];
    id json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
    return [[Params alloc] initWithJSON:[json isKindOfClass:[NSDictionary class]] ? json : @{}];
}
@end

// MARK: - the helper

static BOOL isScanUnit(ICScannerFunctionalUnitType t) {
    return t == ICScannerFunctionalUnitTypeFlatbed || t == ICScannerFunctionalUnitTypeDocumentFeeder;
}

/// The protocol allows at most 4000 resolutions. A device that reports a continuous range (every value from 50 to 4800)
/// is reduced to the standard values in it plus its smallest and largest one.
static NSArray<NSNumber *> *resolutionList(NSIndexSet *set) {
    NSMutableArray<NSNumber *> *all = [NSMutableArray array];
    [set enumerateIndexesUsingBlock:^(NSUInteger i, BOOL *stop) { [all addObject:@(i)]; }];
    if (all.count <= 4000) return all;
    NSMutableIndexSet *few = [NSMutableIndexSet indexSet];
    for (NSNumber *d in @[ @75, @100, @150, @200, @300, @400, @600, @1200, @2400, @4800 ]) {
        if ([set containsIndex:d.unsignedIntegerValue]) [few addIndex:d.unsignedIntegerValue];
    }
    [few addIndex:set.firstIndex];
    [few addIndex:set.lastIndex];
    return resolutionList(few);
}

@interface Helper : NSObject <ICDeviceBrowserDelegate, ICScannerDeviceDelegate>
@property (strong) Params *params;
@property (strong) ICDeviceBrowser *browser;
@property (strong) NSMutableArray<ICDevice *> *devices;
@property (strong) ICScannerDevice *scanner;
@property NSInteger pages;
@property BOOL started;
@property BOOL scanning;
@property (strong) NSNumber *awaitingUnit; // the functional unit type requested with requestSelectFunctionalUnit:, if any
@property (strong) NSMutableArray<NSNumber *> *probeQueue;
@property (strong) NSMutableIndexSet *probedResolutions;
@property (strong) NSMutableArray<NSString *> *probedSources;
@property BOOL probedDuplex;
@property NSInteger reportedDpi;
@end

@implementation Helper

- (instancetype)initWithParams:(Params *)params {
    if ((self = [super init])) {
        _params = params;
        _browser = [[ICDeviceBrowser alloc] init];
        _devices = [NSMutableArray array];
        _probeQueue = [NSMutableArray array];
        _probedResolutions = [NSMutableIndexSet indexSet];
        _probedSources = [NSMutableArray array];
        _reportedDpi = params.dpi;
    }
    return self;
}

- (BOOL)isList { return [self.params.command isEqualToString:@"list"]; }
- (BOOL)isCaps { return [self.params.command isEqualToString:@"caps"]; }

// Browsing ----------------------------------------------------------------------------------------------------------

- (void)startBrowsing {
    self.browser.delegate = self;
    self.browser.browsedDeviceTypeMask = (ICDeviceTypeMask)(ICDeviceTypeMaskScanner | ICDeviceLocationTypeMaskLocal | ICDeviceLocationTypeMaskRemote);
    [self.browser start];
}

- (NSString *)idOf:(ICDevice *)device {
    return device.UUIDString ?: device.name ?: @"scanner";
}

- (void)deviceBrowser:(ICDeviceBrowser *)browser didAddDevice:(ICDevice *)device moreComing:(BOOL)moreComing {
    [self.devices addObject:device];
    if (![self isList] && [device isKindOfClass:[ICScannerDevice class]] && [[self idOf:device] isEqualToString:self.params.deviceId] && !self.scanner) {
        ICScannerDevice *s = (ICScannerDevice *)device;
        self.scanner = s;
        s.delegate = self;
        [s requestOpenSession];
    }
}

- (void)deviceBrowser:(ICDeviceBrowser *)browser didRemoveDevice:(ICDevice *)device moreGoing:(BOOL)moreGoing {}

- (void)finishList {
    NSMutableArray *list = [NSMutableArray array];
    for (ICDevice *d in self.devices) {
        if (![d isKindOfClass:[ICScannerDevice class]]) continue;
        [list addObject:@{ @"id": [self idOf:d], @"name": d.name ?: @"Scanner", @"manufacturer": @"" }];
    }
    emit(@{ @"type": @"devices", @"devices": list });
    emit(@{ @"type": @"done" });
    exit(0);
}

// ICDeviceDelegate ----------------------------------------------------------------------------------------------------

- (void)device:(ICDevice *)device didOpenSessionWithError:(NSError *)error {
    if (error) fail(codeFor(error) ?: @"communication", errorText(error));
}

- (void)device:(ICDevice *)device didCloseSessionWithError:(NSError *)error {}

- (void)didRemoveDevice:(ICDevice *)device { fail(@"offline", @"The scanner was disconnected."); }

// Once a session is open the framework finds the functional units, selects the default one (didSelectFunctionalUnit)
// and then reports the device as ready. Whichever of these arrives first starts the work, exactly once.
- (void)deviceDidBecomeReady:(ICDevice *)device { [self begin]; }

// ICScannerDeviceDelegate ---------------------------------------------------------------------------------------------

- (void)scannerDeviceDidBecomeAvailable:(ICScannerDevice *)scanner { [self begin]; }

- (BOOL)hasUnit:(ICScannerFunctionalUnitType)type {
    for (NSNumber *n in self.scanner.availableFunctionalUnitTypes) {
        if (n.unsignedIntegerValue == (NSUInteger)type) return YES;
    }
    return NO;
}

- (void)begin {
    if (self.started || !self.scanner) return;
    self.started = YES;
    if ([self isCaps]) {
        for (NSNumber *n in self.scanner.availableFunctionalUnitTypes) {
            if (isScanUnit((ICScannerFunctionalUnitType)n.unsignedIntegerValue)) [self.probeQueue addObject:n];
        }
        [self probeNext];
        return;
    }
    BOOL feeder = [self.params.source isEqualToString:@"feeder"];
    ICScannerFunctionalUnitType wanted = feeder ? ICScannerFunctionalUnitTypeDocumentFeeder : ICScannerFunctionalUnitTypeFlatbed;
    if (![self hasUnit:wanted]) fail(@"unsupported", feeder ? @"This scanner has no document feeder." : @"This scanner has no flatbed.");
    [self select:wanted];
}

/// Selects a functional unit; when it is the selected one already, carries on without asking the device again.
- (void)select:(ICScannerFunctionalUnitType)type {
    ICScannerFunctionalUnit *current = self.scanner.selectedFunctionalUnit;
    if (current && current.type == type) {
        self.awaitingUnit = nil;
        [self useUnit:current];
        return;
    }
    self.awaitingUnit = @(type);
    [self.scanner requestSelectFunctionalUnit:type];
}

- (void)probeNext {
    if (self.probeQueue.count) {
        NSNumber *t = self.probeQueue.firstObject;
        [self.probeQueue removeObjectAtIndex:0];
        [self select:(ICScannerFunctionalUnitType)t.unsignedIntegerValue];
        return;
    }
    NSArray *modes = @[ @"color", @"gray", @"bw" ];
    emit(@{ @"type": @"caps", @"resolutions": resolutionList(self.probedResolutions), @"colorModes": modes, @"sources": self.probedSources, @"duplex": @(self.probedDuplex) });
    emit(@{ @"type": @"done" });
    exit(0);
}

- (void)scannerDevice:(ICScannerDevice *)scanner didSelectFunctionalUnit:(ICScannerFunctionalUnit *)functionalUnit error:(NSError *)error {
    if (!self.awaitingUnit) {
        // The framework's own selection of the default unit after opening the session (or a stray repeat): not an
        // answer to a request of ours. It does mean the device is usable.
        if (!error) [self begin];
        return;
    }
    if (error) fail(codeFor(error), errorText(error));
    if (!functionalUnit || functionalUnit.type != (ICScannerFunctionalUnitType)self.awaitingUnit.unsignedIntegerValue) return;
    self.awaitingUnit = nil;
    [self useUnit:functionalUnit];
}

- (void)useUnit:(ICScannerFunctionalUnit *)fu {
    if ([self isCaps]) {
        [self.probedSources addObject:fu.type == ICScannerFunctionalUnitTypeDocumentFeeder ? @"feeder" : @"flatbed"];
        if (fu.supportedResolutions) [self.probedResolutions addIndexes:fu.supportedResolutions];
        if ([fu isKindOfClass:[ICScannerFunctionalUnitDocumentFeeder class]] && ((ICScannerFunctionalUnitDocumentFeeder *)fu).supportsDuplexScanning) self.probedDuplex = YES;
        [self probeNext];
        return;
    }
    if (self.scanning) return;
    self.scanning = YES;
    [self configureAndScan:fu];
}

- (void)configureAndScan:(ICScannerFunctionalUnit *)fu {
    // nearest supported resolution (the lower one on a tie)
    __block NSUInteger best = NSNotFound;
    __block NSInteger bestDistance = NSIntegerMax;
    NSInteger want = self.params.dpi;
    [fu.supportedResolutions enumerateIndexesUsingBlock:^(NSUInteger r, BOOL *stop) {
        NSInteger d = labs((NSInteger)r - want);
        if (d < bestDistance) {
            bestDistance = d;
            best = r;
        }
    }];
    if (best != NSNotFound) {
        fu.resolution = best;
        self.reportedDpi = (NSInteger)best;
    }
    if ([self.params.colorMode isEqualToString:@"bw"]) {
        fu.pixelDataType = ICScannerPixelDataTypeBW;
        fu.bitDepth = ICScannerBitDepth1Bit;
    } else if ([self.params.colorMode isEqualToString:@"gray"]) {
        fu.pixelDataType = ICScannerPixelDataTypeGray;
        fu.bitDepth = ICScannerBitDepth8Bits;
    } else {
        fu.pixelDataType = ICScannerPixelDataTypeRGB;
        fu.bitDepth = ICScannerBitDepth8Bits;
    }
    if ([fu isKindOfClass:[ICScannerFunctionalUnitFlatbed class]]) {
        ICScannerFunctionalUnitFlatbed *flat = (ICScannerFunctionalUnitFlatbed *)fu;
        flat.measurementUnit = ICScannerMeasurementUnitInches;
        flat.scanArea = NSMakeRect(0, 0, flat.physicalSize.width, flat.physicalSize.height);
    }
    if ([fu isKindOfClass:[ICScannerFunctionalUnitDocumentFeeder class]]) {
        ICScannerFunctionalUnitDocumentFeeder *feeder = (ICScannerFunctionalUnitDocumentFeeder *)fu;
        feeder.duplexScanningEnabled = self.params.duplex && feeder.supportsDuplexScanning;
    }
    ICScannerDevice *scanner = self.scanner;
    scanner.transferMode = ICScannerTransferModeFileBased;
    scanner.downloadsDirectory = [NSURL fileURLWithPath:self.params.dir isDirectory:YES];
    scanner.documentName = @"page";
    scanner.documentUTI = @"public.png";
    emit(@{ @"type": @"progress", @"message": @"Scanning" });
    [scanner requestScan];
}

- (void)scannerDevice:(ICScannerDevice *)scanner didScanToURL:(NSURL *)url {
    self.pages += 1;
    emit(@{ @"type": @"page", @"index": @(self.pages), @"file": url.path ?: @"", @"dpi": @(self.reportedDpi) });
    if (self.pages >= self.params.maxPages) {
        [scanner cancelScan];
        // The cancelled scan normally completes at once (didCompleteScanWithError). If the device never says so, the
        // pages are in hand anyway: finish instead of waiting for Epdf's idle timeout.
        NSInteger pages = self.pages;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            emit(@{ @"type": @"done", @"pages": @(pages) });
            exit(0);
        });
    } else {
        emit(@{ @"type": @"progress", @"message": [NSString stringWithFormat:@"Scanning page %ld", (long)(self.pages + 1)] });
    }
}

- (void)scannerDevice:(ICScannerDevice *)scanner didCompleteScanWithError:(NSError *)error {
    if (error && self.pages == 0) fail(codeFor(error), errorText(error));
    // An error after at least one page is how a feeder reports "no more paper": that is a normal end.
    emit(@{ @"type": @"done", @"pages": @(self.pages) });
    exit(0);
}

@end

// MARK: - main

static Helper *helper; // strong: the browser and scanner only hold weak references to their delegate

static void onTerminate(int sig) {
    (void)sig;
    _exit(0);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        Params *p = [Params fromEnvironment];
        NSString *command = argc > 1 ? ([NSString stringWithUTF8String:argv[1]] ?: @"") : p.command;
        p.command = command;
        if (![@[ @"list", @"caps", @"scan" ] containsObject:command]) fail(nil, @"Unknown command");
        if ([command isEqualToString:@"scan"] && p.dir.length == 0) fail(nil, @"No output folder given.");

        signal(SIGTERM, onTerminate);
        helper = [[Helper alloc] initWithParams:p];
        [helper startBrowsing];

        if ([command isEqualToString:@"list"]) {
            // give the browser a few seconds to report devices, then answer
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [helper finishList]; });
        } else {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(20 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                if (!helper.scanner) fail(@"not_found", @"The scanner was not found.");
            });
        }
        // A port keeps the run loop alive; the framework delivers its callbacks on the main thread.
        [[NSRunLoop mainRunLoop] addPort:[NSMachPort port] forMode:NSDefaultRunLoopMode];
        for (;;) {
            @autoreleasepool {
                [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate distantFuture]];
            }
        }
    }
    return 0;
}
