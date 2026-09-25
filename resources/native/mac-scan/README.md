# epdf-mac-scan (macOS scanner helper)

Epdf's Scan to PDF talks to scanners on macOS through Apple's ImageCaptureCore framework. That framework needs native
code, so this small command-line program does the talking and Epdf launches it (`src/main/features/scan/backends.ts`).

## Status: UNTESTED

`main.swift` was written against Apple's documented API on a Windows machine. It has **never been compiled or run**.
What *is* tested is the TypeScript side (`src/main/features/scan/`): the line protocol, launching, cancelling, timeouts,
error mapping and page hand-over, all against a stub helper (`tests/fixtures/scan-stub-helper.mjs`) that speaks the same
protocol. Expect to fix compile errors and framework quirks the first time this is built on a Mac.

## Protocol

Parameters go in as JSON in the `EPDF_SCAN_PARAMS` environment variable (never on the command line). The first argument
is the command. Output is one JSON object per line on stdout; other lines are ignored.

| command | parameters | output |
|---|---|---|
| `list` | - | `{"type":"devices","devices":[{"id":"...","name":"...","manufacturer":"..."}]}` then `{"type":"done"}` |
| `caps` | `deviceId` | `{"type":"caps","resolutions":[...],"colorModes":["color","gray","bw"],"sources":["flatbed","feeder"],"duplex":false}` then `done` |
| `scan` | `deviceId`, `dpi`, `colorMode` (`color`/`gray`/`bw`), `source` (`flatbed`/`feeder`), `duplex`, `maxPages`, `dir` | `{"type":"progress","message":"..."}`, one `{"type":"page","index":1,"file":"<dir>/page.png","dpi":300}` per page, then `{"type":"done","pages":n}` |

Errors: `{"type":"error","code":"paper_jam|no_paper|paper_problem|offline|busy|warming_up|user_intervention|cover_open|lamp_off|locked|communication|not_found|unavailable|unsupported","message":"..."}`
and exit status 2. The codes are the ones in `src/main/features/scan/errors.ts`, which turns them into user messages.

Rules Epdf enforces on the helper's output: page files must be PNG/JPEG/BMP inside the `dir` it was given (anything else is
refused and never read); a helper that prints nothing for 5 minutes (scan) or 45 seconds (list/caps) is killed; cancelling a
scan kills the process.

## Building

```sh
./build.sh          # on a Mac with Xcode command line tools
```

This produces a universal binary and copies it to `resources/bin/{darwin,mac}-{arm64,x64}/epdf-mac-scan`
(`darwin-*` is where `npm run dev` looks, `mac-*` is what electron-builder's `extraResources` entry
`resources/bin/${os}-${arch}` copies into the app). Binaries are not committed (`resources/bin/*` is ignored).

For a release build, sign the helper with the same Developer ID as the app (electron-builder does not sign loose
executables in `extraResources` by itself; add `mac.binaries: [Contents/Resources/bin/epdf-mac-scan]` when this ships) and
make sure the hardened-runtime entitlements allow scanner access (`com.apple.security.device.usb` if the app is sandboxed).

## Testing the TypeScript side without a Mac

Set `EPDF_MAC_SCAN_HELPER` to any executable (or a `.mjs` script, which is run with Electron's bundled Node) that speaks
this protocol. On macOS and Linux Epdf then uses it as the scanner backend; on Windows also set `EPDF_SCAN_BACKEND=mac-helper`. `tests/fixtures/scan-stub-helper.mjs` is such a
helper.
