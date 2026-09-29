# epdf-mac-scan (macOS scanner helper)

Epdf's Scan to PDF talks to scanners on macOS through Apple's ImageCaptureCore framework (the framework behind the
Image Capture app). That framework needs native code, so this small command-line program (`main.m`, Objective-C with
ARC) does the talking and Epdf launches it (`src/main/features/scan/backends.ts`).

## Status: tested without a scanner

Built and run on macOS 26 (Apple M2; the Intel half under Rosetta 2), inside the packaged app too. Tested there with no
scanner attached: device discovery (an empty list, in about 4 seconds), the command and parameter handling, "not found"
for a scanner that is not there, and cancelling (tests/unit/scan-mac-helper.test.ts, and the e2e spec "the real macOS
helper answers"). **Opening a real scanner, reading its capabilities and scanning (flatbed, feeder, duplex) have never
been tried**: no scanner was available. The TypeScript side (`src/main/features/scan/`: the line protocol, launching,
cancelling, timeouts, error mapping and page hand-over) is also tested against a stub helper
(`tests/fixtures/scan-stub-helper.mjs`) that speaks the same protocol.

## Protocol

Parameters go in as JSON in the `EPDF_SCAN_PARAMS` environment variable (never on the command line). The first argument
is the command (when it is missing, `command` from the parameters is used). Output is one JSON object per line on
stdout; other lines are ignored.

| command | parameters | output |
|---|---|---|
| `list` | - | `{"type":"devices","devices":[{"id":"...","name":"...","manufacturer":"..."}]}` then `{"type":"done"}` |
| `caps` | `deviceId` | `{"type":"caps","resolutions":[...],"colorModes":["color","gray","bw"],"sources":["flatbed","feeder"],"duplex":false}` then `done` |
| `scan` | `deviceId`, `dpi`, `colorMode` (`color`/`gray`/`bw`), `source` (`flatbed`/`feeder`), `duplex`, `maxPages`, `dir` | `{"type":"progress","message":"..."}`, one `{"type":"page","index":1,"file":"<dir>/page.png","dpi":300}` per page, then `{"type":"done","pages":n}` |

Errors: `{"type":"error","code":"paper_jam|no_paper|paper_problem|offline|busy|warming_up|user_intervention|cover_open|lamp_off|locked|communication|not_found|unavailable|unsupported","message":"..."}`
and exit status 2 (an unknown command and a scan without `dir` give an error without a code). The codes are the ones in
`src/main/features/scan/errors.ts`, which turns them into user messages. Terminating the helper (SIGTERM) ends it with
status 0.

How it behaves:

* `list` browses for local and network (Bonjour) scanners for 3.5 seconds, then answers. A device's `id` is its
  ImageCaptureCore UUID.
* `caps` and `scan` open a session on the device with that `id`; if it has not shown up after 20 seconds the answer is
  `not_found`. `caps` selects each flatbed and document feeder unit in turn and reports the union of their resolutions
  (a device that reports thousands of values, a continuous range, is reduced to the standard ones in it plus its
  smallest and largest).
* `scan` selects the flatbed or the feeder (`unsupported` if the device has none), uses the supported resolution
  nearest to `dpi` (and reports that one as the page's `dpi`), sets colour/gray/black-and-white, the whole flatbed area,
  duplex if asked for and supported, and file-based transfer of PNG files named `page...` into `dir`. It stops after
  `maxPages` pages. An error after at least one page is how a feeder says it is empty, so that is a normal end.

Rules Epdf enforces on the helper's output: page files must be PNG/JPEG/BMP inside the `dir` it was given (anything else is
refused and never read); a helper that prints nothing for 5 minutes (scan) or 45 seconds (list/caps) is killed; cancelling a
scan kills the process.

## Building

```sh
./build.sh          # on a Mac; needs only clang from the Command Line Tools (xcode-select --install)
```

`npm run dist:mac` runs it first. It compiles one universal (arm64 + x86_64) binary for macOS 13 and later, signs it ad
hoc and copies it to `resources/bin/{darwin,mac}-{arm64,x64}/epdf-mac-scan` (`darwin-*` is where `npm run dev` looks,
`mac-*` is what electron-builder's `extraResources` entry `resources/bin/${os}-${arch}` copies into the app as
`Contents/Resources/bin/epdf-mac-scan`). Binaries are not committed (`resources/bin/*` is ignored). It does not use
Swift: the Command Line Tools on a Mac are often older than the macOS they run on, and the Swift compiler then refuses
the system SDK, while clang works.

Signing: electron-builder signs every binary inside the app, the helper included, with the app's identity (ad hoc for
now), the hardened runtime and the app's entitlements. The helper needs no entitlement of its own (it is not sandboxed;
a sandboxed build would need `com.apple.security.device.usb` and network client access for network scanners). When the
app gets a Developer ID, the helper is signed with it in the same way.

## Testing the TypeScript side without a Mac

Set `EPDF_MAC_SCAN_HELPER` to any executable (or a `.mjs` script, which is run with Electron's bundled Node) that speaks
this protocol. On macOS and Linux Epdf then uses it as the scanner backend; on Windows also set `EPDF_SCAN_BACKEND=mac-helper`. `tests/fixtures/scan-stub-helper.mjs` is such a
helper.
