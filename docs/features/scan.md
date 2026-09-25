# Scan to PDF

**File ▸ Scan to PDF…** (command `scan.open`). One dialog with three steps:

1. **Capture**: pages come from a **scanner**, a **webcam** or a **phone on the same network**. Pages from any source
   go into the same list and can be mixed.
2. **Adjust**: drag (or use the arrow keys on) the four corners, rotate, find the page edges automatically, choose the
   clean-up (Colour, Grayscale, Black & white document, Original), straighten crooked text, choose the paper size.
   A live preview shows the corrected page. Pages can be rotated, reordered (Move earlier / later) and deleted.
3. **Save**: file size, then **Save as new PDF…** (native save dialog, atomic write, opens in a tab) or **Add to
   "<open document>"** (inserts the pages at the end or after the current page through the edit pipeline: one undo step,
   autosave, saved with the normal Save). If an OCR feature is present in the build, **Recognize text (OCR) after saving**
   is offered and runs the command `ocr.run` for the resulting document.

Everything is local. Nothing is uploaded anywhere.

## What is in-house and what is optional

| Part | Implementation |
|---|---|
| Page detection, perspective warp, deskew, enhancement, PDF assembly | In-house TypeScript (`src/shared/features/scan/`), runs in a **Web Worker** so the UI never freezes |
| QR code | `qrcode-generator` (MIT) draws the modules; `jsqr` (Apache-2.0) is a **dev/test-only** decoder used to prove the code scans |
| Windows scanners | Windows' own **WIA** COM objects, driven through `powershell.exe` (ships with Windows). Nothing to install |
| macOS scanners | A small Swift helper using the system **ImageCaptureCore** framework (`resources/native/mac-scan/`). **UNTESTED** (see below) |
| Linux scanners | Not supported: the Scanner tab says so; webcam and phone work everywhere |
| Webcam | `getUserMedia({ video })` (camera permission is granted by Epdf to its own pages only, video only) |
| Phone | A temporary HTTP server inside Epdf, no external service |

No external program is required. Scanner support depends on the operating system's own scanner API, and degrades with a clear message where it is unavailable.

## Sources

### Scanner (Windows)

* Lists WIA scanners, then reads what the selected one supports: **resolution**, **colour mode**, **flatbed / document
  feeder**, **duplex**. Scanning is a cancellable **job** (progress and Cancel in the jobs tray and in the dialog); a feeder
  scan loops until the feeder is empty (or "Most pages to scan" is reached). Pages arrive one by one and appear immediately.
* The script is a fixed string passed with `-EncodedCommand`; the only variable input is JSON in the `EPDF_SCAN_PARAMS`
  environment variable, parsed with `ConvertFrom-Json`. There is no shell and no string interpolation of parameters, so a
  device name cannot inject code. Output is a JSON-lines protocol; anything else (PowerShell warnings) is ignored. Idle
  timeouts kill a stuck script; Cancel kills the child process.
* Errors are turned into plain messages from the WIA HRESULT: paper jam, feeder empty, offline, busy, cover open, lamp off,
  scanner locked by another program, not found, and so on (`src/main/features/scan/errors.ts`).
* Pages come back as PNG (BMP as fallback) and are scanned at the resolution you chose; the PDF page size is
  `pixels / dpi * 72`.

### Scanner (macOS) - **UNTESTED**

The TypeScript side (launching a helper from `resources/bin/...`, the JSON-lines protocol, timeouts, cancel, error mapping,
page hand-over, refusing files outside the job folder) is tested against a **stub helper** (a Node script,
`tests/fixtures/scan-stub-helper.mjs`), including an end-to-end run through the real UI.
The **Swift helper itself (`resources/native/mac-scan/main.swift`) has never been compiled or run**: it was written on a
Windows machine. Build it with `resources/native/mac-scan/build.sh` on a Mac and expect to fix compile errors and
ImageCaptureCore quirks. Without the helper, the macOS Scanner tab explains that scanner support is not available in this
copy; webcam and phone still work. Details and the protocol: `resources/native/mac-scan/README.md`.

### Scanner test backend

Set `EPDF_SCANNER_STUB=<folder of png/jpg/bmp images>` and the Scanner tab shows "Test scanner (image folder)". A flatbed
scan hands out the next picture (cycling), a feeder scan all of them (up to "Most pages"). Extra switches:
`EPDF_SCANNER_STUB_ERROR=<paper_jam|no_paper|busy|offline|...>` makes every scan fail with that error,
`EPDF_SCANNER_STUB_DELAY_MS=<ms>` delays each page (to test Cancel).
`EPDF_MAC_SCAN_HELPER=<executable or .mjs>` plus `EPDF_SCAN_BACKEND=mac-helper` (on Windows) selects the macOS helper backend
with any program that speaks the protocol.

### Webcam

Live preview, camera picker, **Capture page** (as many pages as you like; the camera stays on), and an **outline of the
detected page** drawn over the preview (about four times a second, on a small copy in the worker). With **Capture
automatically when the page is steady**, a page is captured once its corners have stayed put for about 1.25 s, the outline
turns green, and nothing more is captured until the page leaves the view or a clearly different page shows up. The camera is
released when you leave the tab or close the dialog. Errors (permission blocked, no camera, camera in use) have their own
messages and a Try again button.

### Phone over the local network

* Epdf starts a **temporary HTTP server on every private IPv4 address** of the computer (RFC 1918 only, one port each,
  chosen at random) and shows a **QR code** for `http://<lan-ip>:<port>/<token>` plus the address as text. If several
  networks exist, pick the one the phone is on (virtual adapters such as WSL or VPNs are marked). The phone opens a small
  self-contained page (no external assets, works without internet) with **Take a photo** and **Choose photos**; pictures
  appear in the dialog as soon as they arrive.
* **Plain-text warning**: the link is plain `http` on the local network, not encrypted. The dialog and the phone page say so.
  Use it on a network you trust.
* Safeguards (all covered by tests over real HTTP, `tests/unit/scan-phone.test.ts`): a random 128-bit token in the path
  (constant-time compare; wrong tokens look like any 404); the link works only while the Phone tab is open (leaving the tab,
  the step or the dialog stops the servers), and expires after 10 minutes at the latest; only `GET /<token>` and
  `POST /<token>/upload` exist (no listing, no files); the upload needs a custom header and same-origin `Origin` /
  `Sec-Fetch-Site`, and the server never sends CORS headers (CSRF); the `Host` header must be one of ours (DNS rebinding);
  requests are rate limited per client with a lockout after repeated wrong tokens; limits: 60 MB per request, 25 MB per
  photo, 20 photos per request, 300 per session, 4 uploads at once, 32 connections, 8 KB of headers, header / idle / request
  time limits (slow-loris); image type is decided from the bytes (JPEG, PNG, WebP), never from the file name or content
  type. Uploaded photos live in memory only.
* iPhones convert HEIC to JPEG when a web page asks for `image/*`, so nothing special is needed. Android sends JPEG.
* If the phone cannot open the link: both devices must be on the same network (guest Wi-Fi usually isolates devices), and
  the operating system firewall must allow Epdf on private networks (Windows asks the first time). The dialog says this and
  reports addresses that could not be opened. "No network" gives its own message.
* `EPDF_PHONE_ADDRESSES=127.0.0.1` (comma list) overrides the interface list, `EPDF_PHONE_TTL_MS` the lifetime (tests).

## Page clean-up pipeline

`src/shared/features/scan/` (pure functions on typed arrays; the same code runs in the worker and in the unit tests):

1. **Detect the page** (`detect.ts`): shrink to about 400 px; two "paper-ness" maps (luma, and min(R,G,B), where coloured
   desks are dark); for a ladder of thresholds take the largest bright blob, fill the holes (text), and turn its convex
   hull into the enclosing quadrilateral by repeatedly collapsing the hull edge that adds the least area; score each candidate
   by size, fit and how much *edge* runs along its sides, so shadows and busy backgrounds lose against the real paper
   boundary. Returns nothing when there is no convincing page; the editor then asks you to drag the corners.
2. **Crop + perspective** (`geometry.ts`): homography from the four corners to an upright rectangle, bilinear sampling. Camera
   pages are snapped to A4 or Letter when their shape is within 8 % (the paper size can be forced or turned off); scanner
   pages keep `pixels / dpi`.
3. **Deskew** (`deskew.ts`): projection-profile search over +-15 degrees; applied only when the evidence is strong and the
   angle is at least 0.3 degrees.
4. **Enhance** (`enhance.ts`): a background (paper brightness) estimate on a small copy removes shadows and uneven light;
   *Colour* does it per channel (also white-balances), *Grayscale* on luma, *Black & white document* thresholds the flattened
   page (Otsu, clamped) and produces pure black and white. *Original* changes nothing.
5. **PDF** (`assemble.ts`): page by page, so large scans never keep more than the compressed data. Colour, grayscale and
   original pages are **JPEG** (quality by the file-size setting); black & white pages are **1-bit `/DeviceGray` images with
   Flate + PNG predictor** (a generated A4 text page at 300 dpi is about 26 KB; real pages with more detail and noise are
   larger, but far smaller than JPEG). Page size in points comes from the dpi or the paper size.

Not implemented: CCITT G4 / JBIG2 for black & white pages (Flate with a predictor is used instead), drag-and-drop reordering
(use Move earlier / later), per-page clean-up choices (the clean-up applies to all pages), perspective aspect-ratio recovery
beyond snapping to A4 / Letter, blank-page removal, OCR itself (that is another feature: this one only calls `ocr.run`).

## Files

```
src/shared/features/scan.ts                 channel schemas, types
src/shared/features/scan/*                  image, geometry, detect, deskew, enhance, pipeline, assemble, qr
src/main/features/scan/                     index (channels, job, menu), backends, wia, helper, protocol, errors,
                                            phoneServer, phonePage, multipart, lan
src/renderer/src/features/scan/             dialog, panels, page editor, store, worker/
resources/native/mac-scan/                  Swift helper source, build.sh, README (UNTESTED)
tests/unit/scan-*.test.ts, tests/e2e/scan.spec.ts, tests/support/scanImages.ts, tests/fixtures/scan-stub-helper.mjs
```

Channels (`scan:` prefix): `environment`, `session`, `endSession`, `devices`, `capabilities`, `phoneStart`, `phoneStop`,
`save`; job `scan:acquire`; events `scan:page`, `scan:phoneImage`, `scan:phoneStatus`. There are no shortcuts (menu item and
command only).

## Manual test steps

1. **Test scanner**: `$env:EPDF_SCANNER_STUB = "C:\some\folder\of\pngs"; npm run dev`. File ▸ Scan to PDF…, Scan, Next, tweak
   corners with the arrow keys, pick Black & white, Next, Save. Open the PDF in another reader.
2. **Real Windows scanner** (not verified by the authors): plug in a scanner, open the dialog, choose it, try flatbed, then
   the document feeder with several sheets, duplex if it has it, and cancel in the middle. Pull the paper / open the cover
   to see the messages.
3. **Webcam**: Webcam tab, hold a sheet on a dark table under a lamp, watch the outline, tick auto-capture and hold still.
4. **Phone**: Phone tab, scan the QR code, take a photo of a sheet on a desk. Then close the dialog and reload the phone page:
   it must fail. Try the URL from another device to check the firewall message.
5. **Add to open document**: open a PDF, scan a page, Save step, Add to "...", then Edit ▸ Undo.

## Verified vs not verified

Verified by tests: everything in the pipeline on generated photos (rotated, perspective, shadows, noise, busy backgrounds:
56 of 60 random hard scenes within 3 % corner error, the misses being scenes where a shaded page is as dark as the desk),
the Windows WIA script for enumeration and error paths on a machine **with no scanner** (real PowerShell run), the stub and
helper protocols, the phone server over real HTTP, the QR round trip, the whole UI flow with the test scanner, the fake
camera (including a Y4M clip of a sheet for outline and auto-capture) and a real browser engine loading the phone page.

**Not verified**: scanning with a real scanner (flatbed, feeder, duplex, WIA property quirks of individual drivers), the
macOS Swift helper, a real phone browser and real Wi-Fi (firewall behaviour), real webcam quality and autofocus.
