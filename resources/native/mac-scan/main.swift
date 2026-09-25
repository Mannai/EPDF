// epdf-mac-scan: the macOS scanner helper for Epdf's "Scan to PDF" (ImageCaptureCore).
//
// STATUS: written against Apple's documented ImageCaptureCore API but NEVER COMPILED OR RUN by the authors (the
// development machine is Windows). Treat it as UNTESTED until someone has run it against a real scanner on a Mac.
//
// Protocol (same as the Windows script; see src/main/features/scan/protocol.ts): one JSON object per line on stdout.
//   epdf-mac-scan list                              -> {"type":"devices","devices":[{"id","name","manufacturer"}]} {"type":"done"}
//   epdf-mac-scan caps   (params in EPDF_SCAN_PARAMS) -> {"type":"caps","resolutions":[..],"colorModes":[..],"sources":[..],"duplex":bool} {"type":"done"}
//   epdf-mac-scan scan   (params in EPDF_SCAN_PARAMS) -> {"type":"progress",..} {"type":"page","index":1,"file":"<dir>/page1.png","dpi":300} ... {"type":"done","pages":n}
//   errors                                          -> {"type":"error","code":"paper_jam|no_paper|busy|offline|cover_open|not_found|...","message":".."} and exit status 2
// Parameters are JSON in the EPDF_SCAN_PARAMS environment variable: {"command","deviceId","dpi","colorMode":"color|gray|bw",
// "source":"flatbed|feeder","duplex":bool,"maxPages":n,"dir":"<existing directory for page files>"}.
// Pages are written as PNG files inside `dir`; Epdf reads and deletes them. Cancelling = Epdf terminates this process.

import Foundation
import ImageCaptureCore

// MARK: - output helpers

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func fail(_ code: String?, _ message: String) -> Never {
    var o: [String: Any] = ["type": "error", "message": message]
    if let code = code { o["code"] = code }
    emit(o)
    exit(2)
}

/// Maps an ImageCaptureCore error onto the protocol's error codes (by text; the framework's codes are poorly documented).
func codeFor(_ error: Error) -> String? {
    let t = (error as NSError).localizedDescription.lowercased()
    if t.contains("jam") { return "paper_jam" }
    if t.contains("no paper") || t.contains("empty") || t.contains("out of paper") { return "no_paper" }
    if t.contains("busy") || t.contains("in use") { return "busy" }
    if t.contains("cover") || t.contains("door") { return "cover_open" }
    if t.contains("offline") || t.contains("not connected") || t.contains("disconnected") { return "offline" }
    if t.contains("warming") { return "warming_up" }
    if t.contains("lock") { return "locked" }
    return nil
}

struct Params {
    var command = ""
    var deviceId = ""
    var dpi = 300
    var colorMode = "color"
    var source = "flatbed"
    var duplex = false
    var maxPages = 1
    var dir = ""

    init() {}
    init(json: [String: Any]) {
        command = json["command"] as? String ?? ""
        deviceId = json["deviceId"] as? String ?? ""
        dpi = json["dpi"] as? Int ?? 300
        colorMode = json["colorMode"] as? String ?? "color"
        source = json["source"] as? String ?? "flatbed"
        duplex = json["duplex"] as? Bool ?? false
        maxPages = json["maxPages"] as? Int ?? 1
        dir = json["dir"] as? String ?? ""
    }
}

func loadParams() -> Params {
    guard let raw = ProcessInfo.processInfo.environment["EPDF_SCAN_PARAMS"],
          let data = raw.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return Params() }
    return Params(json: json)
}

// MARK: - the helper

final class Helper: NSObject, ICDeviceBrowserDelegate, ICScannerDeviceDelegate {
    let params: Params
    let browser = ICDeviceBrowser()
    var devices: [ICDevice] = []
    var scanner: ICScannerDevice?
    var pages = 0
    var probeQueue: [ICScannerFunctionalUnitType] = []
    var probedResolutions = Set<Int>()
    var probedSources: [String] = []
    var probedDuplex = false

    init(params: Params) {
        self.params = params
        super.init()
    }

    // Browsing ------------------------------------------------------------------------------------------------------

    func startBrowsing() {
        browser.delegate = self
        let mask = ICDeviceTypeMask.scanner.rawValue | ICDeviceLocationTypeMask.local.rawValue | ICDeviceLocationTypeMask.remote.rawValue
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: mask)!
        browser.start()
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        devices.append(device)
        if params.command != "list", let s = device as? ICScannerDevice, id(of: s) == params.deviceId, scanner == nil {
            scanner = s
            s.delegate = self
            s.requestOpenSession()
        }
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {}

    func id(of device: ICDevice) -> String { device.uuidString ?? device.name ?? "scanner" }

    func finishList() {
        let list = devices.compactMap { d -> [String: Any]? in
            guard d is ICScannerDevice else { return nil }
            return ["id": id(of: d), "name": d.name ?? "Scanner", "manufacturer": ""]
        }
        emit(["type": "devices", "devices": list])
        emit(["type": "done"])
        exit(0)
    }

    // ICDeviceDelegate -----------------------------------------------------------------------------------------------

    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {
        if let error = error { fail(codeFor(error) ?? "communication", error.localizedDescription) }
    }
    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}
    func didRemove(_ device: ICDevice) { fail("offline", "The scanner was disconnected.") }
    func deviceDidBecomeReady(_ device: ICDevice) {}

    // ICScannerDeviceDelegate ----------------------------------------------------------------------------------------

    func scannerDeviceDidBecomeAvailable(_ scanner: ICScannerDevice) {
        if params.command == "caps" {
            probeQueue = scanner.availableFunctionalUnitTypes.compactMap { ICScannerFunctionalUnitType(rawValue: $0.uintValue) }
            probeNext()
        } else {
            let wanted: ICScannerFunctionalUnitType = params.source == "feeder" ? .documentFeeder : .flatbed
            guard scanner.availableFunctionalUnitTypes.contains(where: { $0.uintValue == wanted.rawValue }) else {
                fail("unsupported", params.source == "feeder" ? "This scanner has no document feeder." : "This scanner has no flatbed.")
            }
            scanner.requestSelect(wanted)
        }
    }

    func probeNext() {
        guard let scanner = scanner else { return }
        while let t = probeQueue.first, t != .flatbed && t != .documentFeeder { probeQueue.removeFirst() }
        if let t = probeQueue.first {
            probeQueue.removeFirst()
            scanner.requestSelect(t)
        } else {
            let modes = ["color", "gray", "bw"]
            emit(["type": "caps", "resolutions": probedResolutions.sorted(), "colorModes": modes, "sources": probedSources, "duplex": probedDuplex])
            emit(["type": "done"])
            exit(0)
        }
    }

    func scannerDevice(_ scanner: ICScannerDevice, didSelect functionalUnit: ICScannerFunctionalUnit, error: Error?) {
        if let error = error { fail(codeFor(error), error.localizedDescription) }
        if params.command == "caps" {
            probedSources.append(functionalUnit.type == .documentFeeder ? "feeder" : "flatbed")
            for r in functionalUnit.supportedResolutions { probedResolutions.insert(r) }
            if let feeder = functionalUnit as? ICScannerFunctionalUnitDocumentFeeder, feeder.supportsDuplexScanning { probedDuplex = true }
            probeNext()
            return
        }
        configureAndScan(scanner, functionalUnit)
    }

    func configureAndScan(_ scanner: ICScannerDevice, _ fu: ICScannerFunctionalUnit) {
        // nearest supported resolution
        let supported = Array(fu.supportedResolutions)
        if let best = supported.min(by: { abs($0 - params.dpi) < abs($1 - params.dpi) }) { fu.resolution = best }
        switch params.colorMode {
        case "bw": fu.pixelDataType = .BW; fu.bitDepth = .depth1Bit
        case "gray": fu.pixelDataType = .gray; fu.bitDepth = .depth8Bits
        default: fu.pixelDataType = .RGB; fu.bitDepth = .depth8Bits
        }
        if let flat = fu as? ICScannerFunctionalUnitFlatbed {
            flat.measurementUnit = .inches
            flat.scanArea = NSRect(x: 0, y: 0, width: flat.physicalSize.width, height: flat.physicalSize.height)
        }
        if let feeder = fu as? ICScannerFunctionalUnitDocumentFeeder {
            feeder.duplexScanningEnabled = params.duplex && feeder.supportsDuplexScanning
        }
        scanner.transferMode = .fileBased
        scanner.downloadsDirectory = URL(fileURLWithPath: params.dir, isDirectory: true)
        scanner.documentName = "page"
        scanner.documentUTI = "public.png"
        emit(["type": "progress", "message": "Scanning"])
        scanner.requestScan()
    }

    func scannerDevice(_ scanner: ICScannerDevice, didScanTo url: URL) {
        pages += 1
        emit(["type": "page", "index": pages, "file": url.path, "dpi": params.dpi])
        if pages >= params.maxPages {
            scanner.cancelScan()
        } else {
            emit(["type": "progress", "message": "Scanning page \(pages + 1)"])
        }
    }

    func scannerDevice(_ scanner: ICScannerDevice, didCompleteScanWithError error: Error?) {
        if let error = error, pages == 0 { fail(codeFor(error), error.localizedDescription) }
        // An error after at least one page is how a feeder reports "no more paper": that is a normal end.
        emit(["type": "done", "pages": pages])
        exit(0)
    }
}

// MARK: - main

let params = loadParams()
let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : params.command
var p = params
p.command = command
guard ["list", "caps", "scan"].contains(command) else { fail(nil, "Unknown command") }
if command != "list" && command == "scan" && p.dir.isEmpty { fail(nil, "No output folder given.") }

let helper = Helper(params: p)
signal(SIGTERM) { _ in exit(0) }
helper.startBrowsing()

// list: give the browser a few seconds to report devices, then answer.
if command == "list" {
    DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { helper.finishList() }
} else {
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
        if helper.scanner == nil { fail("not_found", "The scanner was not found.") }
    }
}
RunLoop.main.run()
