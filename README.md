# Epdf

A desktop PDF application (Electron + TypeScript + React). Works fully offline for all local features.

**Status: 1.0.3-beta.1 (Windows beta).** 1.0.3 fixes the Library (and tall dialogs) sitting under the Windows title
bar, where their buttons could not be clicked. 1.0.2 fixed pages flashing black on every edit and text selection
jumping between paragraphs. New in 1.0.1: the Windows design (title bar with document tabs and
search, task tabs over a one-line ribbon, status bar, Windows 11 dialogs; see `docs/features/chrome.md`) and
View ▸ Use Hardware Acceleration, which is off by default in a Remote Desktop session because GPU-composited windows
flash black through the RDP client. Phases 1–3 are complete: the secure Electron shell and PDF viewer; form
filling, signing, creating/combining/exporting, text and image editing, markup, page organization and printing; OCR,
file-size reduction, password protection, scanning, the form builder, true redaction, file comparison and a local
library. Phase 5 on Windows is in: headers/footers/watermarks, links and bookmarks, performance work, NSIS/MSI
installers, auto-update and the signing pipeline, plus Arabic and other scripts inside PDFs: a shaping text engine
for everything Epdf writes, and logical-order reading for selecting, copying and searching. Not in this beta: the
cloud features (Phase 4), macOS/Linux, editing existing Arabic text in place, and Arabic OCR. The beta is **unsigned**
(Windows SmartScreen warns) and its update feed is a placeholder. Epdf is **self-contained**: nothing besides Epdf
itself needs to be installed (see "Licensing and self-containment").

Each feature has its own page in `docs/features/`; how to add a feature is in `docs/FEATURES.md`.

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22+ (developed on 24 LTS) | includes npm |
| Git | any | optional |

No C++ toolchain is required. The one native module (`better-sqlite3` v13) ships prebuilt N-API binaries for
Windows/macOS/Linux, x64 and arm64, so nothing is compiled — locally, in CI, or for the macOS universal build.

## Setup

```bash
npm install
```

npm 11+ blocks dependency install scripts by default. This repo's `package.json` already lists the approved ones
(`allowScripts`: electron, esbuild, electron-winstaller). If Electron's binary is missing after install, run
`node node_modules/electron/install.js`.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app with hot reload |
| `npm run build` | Production build into `out/` |
| `npm start` | Run the production build |
| `npm run typecheck` | Type-check main/preload and renderer |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | Build, then end-to-end tests (Playwright driving the real Electron app) |
| `npm run test:packaged` | Smoke-test a packaged build (needs `EPDF_PACKAGED_EXE`, see below) |
| `npm run icon` | Regenerate the placeholder icons `build/icon.png` and `build/icon.ico` |
| `npm run perf` / `npm run perf:huge` | Cold-start benchmark of the real app / a 147 MB, 320-page file |

The E2E suite generates its own PDF fixtures (5-page sample, 500-page document, mixed page sizes) into
`test-results/fixtures` — nothing to download.

## Packaging

Artifacts are written to `dist/`. Configuration lives in `electron-builder.yml`.

### Windows (run on Windows)

```powershell
npm run dist:dir     # unpacked app in dist\win-unpacked (fast; good for testing)
npm run dist:win     # NSIS installer (.exe) + MSI, x64
```

| Artifact | For | Notes |
|---|---|---|
| `Epdf-Setup-<version>.exe` | People | Per-user install (no admin rights), choose the folder, Start Menu + Desktop shortcuts, `.pdf` association, Explorer right-click entries (below), uninstaller. Installer text: English, Arabic (right-to-left), French, German, Spanish; it follows the language of Windows. |
| `Epdf <version>.msi` | IT deployment | Per-user, silent (`msiexec /i ... /qn`), shortcuts and `.pdf` association. **Does not add the Explorer right-click entries** (those are NSIS-only). |
| `latest.yml` + `.blockmap` | Auto-update | Upload next to the installer (see "Updates"). |

**Explorer right-click entries.** The NSIS installer adds **Convert to PDF with Epdf** (pictures, Word/Excel/
PowerPoint/OpenDocument, RTF, text, CSV) and **Combine files in Epdf** (the same, plus PDFs) to the context menu.
They run the app with `--convert-to-pdf` / `--combine`; several selected files open one Combine screen. The menu text
follows the installer's language. They live in `build/installer.nsh` and are removed by the uninstaller (as are the
`.pdf` association leftovers and the update cache). User data (settings, library, signatures) is kept on uninstall.

Silent install / uninstall, for scripts:

```powershell
.\dist\Epdf-Setup-0.1.0.exe /S                 # install for the current user
.\dist\Epdf-Setup-0.1.0.exe /S /D=C:\Tools\Epdf # ...into a chosen folder
& "$env:LOCALAPPDATA\Programs\Epdf\Uninstall Epdf.exe" /currentuser /S
```

Smoke-test the packaged app:

```powershell
$env:EPDF_PACKAGED_EXE = (Resolve-Path dist\win-unpacked\Epdf.exe).Path
npm run test:packaged
```

### macOS (run on a Mac)

```bash
npm run dist:mac     # universal .dmg (Apple Silicon + Intel) and .zip
```

A universal build must be produced on macOS. The macOS build is configured but has **not been run yet** (Phase 1
was developed on Windows); expect to check it on a Mac or a `macos-latest` CI runner.

### Linux (optional)

`npx electron-builder --linux` produces an AppImage and a deb.

### Code signing

Unsigned builds work locally. For distribution, provide credentials via environment variables — electron-builder
picks them up automatically:

| Platform | Variables |
|---|---|
| Windows | `CSC_LINK` (path/URL/base64 of a `.pfx`) and `CSC_KEY_PASSWORD`; or configure Azure Trusted Signing in `electron-builder.yml` |
| macOS signing | `CSC_LINK` / `CSC_KEY_PASSWORD` (Developer ID Application `.p12`) |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and set `mac.notarize: true` |

Hardened-runtime entitlements are in `build/entitlements.mac.plist`. Verify a signed Windows build with
`Get-AuthenticodeSignature dist\win-unpacked\Epdf.exe` (status `Valid` for a trusted certificate).

**Windows signing, step by step.** Without a signature Windows SmartScreen warns "unknown publisher" on every download.
1. Get a code-signing certificate: an OV/EV certificate from a certificate authority (EV builds reputation with
   SmartScreen immediately; OV builds it over time), or **Azure Trusted Signing** (cheaper, cloud-held key, no hardware token).
2. Build with the certificate: `$env:CSC_LINK = 'C:\keys\epdf.pfx'; $env:CSC_KEY_PASSWORD = '...'; npm run dist:win`.
   The app, the uninstaller and the installer are all signed. (For Azure Trusted Signing, add the `win.azureSignOptions`
   block from the electron-builder docs instead of `CSC_*`.)
3. Set `win.signtoolOptions.publisherName` in `electron-builder.yml` to your certificate's subject name. Then the
   updater also refuses any update that is not signed by that publisher (today it only checks the SHA-512 in `latest.yml`).

The signing pipeline was verified with a throw-away self-signed certificate: the app, `elevate.exe`, the uninstaller
and the installer all carried the signature (`UnknownError` = signed but not from a trusted root, as expected). It has
**not** been run with a real certificate, because none exists yet.

### Updates

The installed app checks for updates from **Help ▸ Check for Updates…** and, unless turned off under
**Help ▸ Check for Updates Automatically**, once a day in the background (first check 20 s after launch, never
during startup). It never downloads without asking, shows progress on the taskbar, and installs **when the app really
quits**, so the usual "Save changes?" prompt can still stop it and no work is lost. Choosing *Restart* installs and
starts the new version. Portable/unpacked runs report that updates are unavailable.

- **Feed**: the `publish` URL in `electron-builder.yml` (a placeholder `https://updates.epdf.example/win` today).
  To release, build, then upload `latest.yml`, `Epdf-Setup-<version>.exe` and its `.blockmap` to that folder on any
  static host. Later versions download only the changed blocks. The download is verified against the SHA-512 in
  `latest.yml`; a corrupted or tampered installer is refused.
- **Test it** with `node scripts/update-e2e.mjs --old <old installer> --feed <folder with the newer build>`
  (add `--tamper` to check that a corrupted download is refused). Both installers must be built with
  `--config.extraMetadata.epdfTestBuild=true`, the only kind that honours `EPDF_UPDATE_URL`, so nothing on a user's
  machine can redirect a release build to another server.

### File associations

The installer registers Epdf for `.pdf` ("Open with", double-click, drag onto the icon). Making it the *default*
app is an OS-level user choice: on Windows the **Tools ▸ Set as Default PDF App…** menu opens Settings ▸ Default
apps; on macOS it shows the Get Info ▸ Open with ▸ Change All steps. File associations only take effect for an
installed build, not `npm run dev`.

## Architecture

```
src/
  main/       Electron main process: windows, menus, file access, SQLite, session recovery, protocol
    ipc/        validated IPC handlers (registry.ts enforces sender origin + zod schema on every call)
    services/   document registry (docId → path), epdf-app:// protocol, file watching
    db/         SQLite migrations + repositories (recent files, session, settings)
    windows/    WindowManager (tabs are tracked per window for crash recovery)
    menu/       native menu bar, Dock menu, Windows Jump List
    security/   CSP, permission denial, navigation lock
  preload/    the only bridge: exposes a small typed `window.epdf` API via contextBridge
  renderer/   React UI: tabs, toolbar, viewer (PDF.js), thumbnails, search
  shared/     zod schemas, IPC channel contract and types shared by all three
tests/
  unit/       Vitest (layout math, search, database)
  e2e/        Playwright + Electron
```

### Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; no `remote`, no `webview`.
- The renderer never sees file paths for reading: main issues opaque `docId`s and PDF bytes are streamed to
  PDF.js over a range-capable `epdf-app://app/doc/<docId>` protocol.
- Every IPC call is rejected unless it comes from the app's own top-level frame **and** validates against its zod
  schema. Only whitelisted settings keys can be read or written.
- Strict CSP (`default-src 'none'`, no `unsafe-eval`, `wasm-unsafe-eval` only for PDF.js decoders).
- PDF JavaScript is never executed (no PDF.js scripting sandbox is bundled; XFA disabled). Only `http(s)`/`mailto`
  links leave the app.
- All PDF.js fonts/CMaps/WASM are bundled — no network access is needed to render.

### Local data

SQLite at `<userData>/epdf.db` (WAL). Tables: `recent_files`, `session_tabs`, `settings`, `schema_migrations`.
Migrations are append-only (`src/main/db/migrations.ts`). Later phases add signatures, versions, recovery files and
the content index.

### Crash recovery

The renderer reports open tabs (path, page, zoom, layout) to main, which snapshots them transactionally. A
"clean exit" flag is cleared at launch and set on quit, so after a crash the previous tabs are always restored;
after a normal quit they are restored if **restoreOnLaunch** is on (default).

## Phase 1 feature checklist

- [x] Open from disk, "Open with", drag onto window/tab bar/icon, second launches hand files to the running instance
- [x] Tabs (reorder, keyboard navigation) and multiple windows; move a tab to a new window (Document menu)
- [x] Native menus (File, Edit, View, Document, Tools, Window, Help), Cmd/Ctrl shortcuts, recents (Dock menu, Jump List)
- [x] Zoom (steps, ctrl+wheel), fit width, fit page; continuous / single / two-page layouts
- [x] Thumbnail sidebar, page navigation (box, buttons, Home/End, Go to page)
- [x] Text selection/copy; full-text search across the whole document with highlighted hits, match case, whole word
- [x] Clickable internal and external links; password-protected PDFs prompt for a password
- [x] Lazy, virtualized rendering (a 500-page file mounts ~10 pages); memory released for off-screen pages
- [x] Light/dark following the OS; crash recovery; remembers the last page per file
- [x] Accessible UI: WAI-ARIA tabs/toolbar, keyboard operable, live page announcements, axe-core WCAG 2.1 A/AA clean

## Phase 2 feature checklist

Details, limits and manual test steps for each are in `docs/features/`.

- [x] **Editing pipeline** — every edit is undoable; Save / Save As / Save a Copy; unsaved-changes dot; autosave to
      a recovery folder with crash recovery; local version history with restore; close/quit guard
- [x] **Form filling** and **flat-PDF typing** (`forms-signing.md`) · **visual signatures** stored encrypted (`forms-signing.md`)
- [x] **Create PDF** from images (JPG/PNG/TIFF; HEIC via the OS decoder), web pages, and Office/OpenDocument/RTF/text
      files with Epdf's own converter (`create-export.md`) · **Combine files** with drag/keyboard ordering
- [x] **Export** to Word, Excel and PowerPoint, written by Epdf's own OOXML writers (`create-export.md`)
- [x] **Edit text and images** in the page content, with an in-house content-stream engine (`edit-content.md`)
- [x] **Comments and markup** saved as standard annotations, with a comments panel, replies and resolve (`markup.md`)
- [x] **Page organizer**, extract, insert, split (ranges / size / bookmarks) and **printing** + Print to PDF (`pages-print.md`)

## Phase 3 feature checklist

- [x] **OCR** — built-in `tesseract.js` (WASM, offline), English bundled, 12 more languages downloaded on demand
      (SHA-256-pinned); adds an invisible, selectable, searchable text layer; runs in worker threads with progress and
      Cancel (`ocr.md`)
- [x] **Reduce File Size** — presets (High / Balanced / Smallest / Custom), image downsampling and recompression with an
      in-house JPEG codec, de-duplication, object streams, optional font trimming, batch mode; never makes a file larger
      (`compress.md`)
- [x] **Password protection** — AES-256 (default), AES-128 and RC4-128; password to open and to edit; permissions;
      protected documents can be opened, edited, and saved still-encrypted; change and remove protection. All crypto is
      Epdf's own, checked against qpdf-made files (`security.md`)
- [x] **Scanning** — Windows scanners (WIA), webcam, and phone photos over the local network via QR code; page-edge
      detection, perspective correction, deskew, contrast/B&W enhancement; save to PDF (`scan.md`)
- [x] **Form builder** — detects fields on flat PDFs, manual field tools, properties panel with validation formats, tab
      order editor (`form-builder.md`)
- [x] **Redaction** — marks by selection, area, search and patterns; permanently removes text, image pixels, annotations,
      bookmarks and metadata; independently verifies the result before applying (`redact.md`)
- [x] **Compare files** — side-by-side text comparison with a change list, F8 navigation, visual diff and exportable
      reports (`compare.md`)
- [x] **Local library** — watched folders (including OneDrive / Google Drive / Dropbox folders, without downloading
      cloud-only files), name and full-text content search, favorites and virtual folders (`library.md`)

## Testing

`npm test` (unit, ~2,100 tests), `npm run test:e2e` (~310 end-to-end tests driving the real app). The packaged app is
covered by `npm run dist:dir` + the opt-in packaged specs (set `EPDF_PACKAGED_EXE` to the built `Epdf.exe`, then
`npm run test:packaged` and the `*-packaged.spec.ts` files). Two guard tests worth knowing about:
`tests/unit/shortcuts.test.ts` fails on any keyboard-shortcut collision, and `tests/unit/marker-leak.test.ts` proves a
protected document's key never leaks into files derived from it. A few tests need optional local tools (qpdf,
LibreOffice) and skip cleanly without them.

## Known limitations / not yet verified

- **macOS and Linux are unverified**: the universal `.dmg` build, Dock menu, `open-file` handling, the macOS/Linux
  HEIC decoders and the macOS/Linux key-storage backends used for signatures are written but were not run.
- **Windows installers** were built and tested by really installing and uninstalling on one Windows 11 machine
  (files, shortcuts, `.pdf` association, uninstall entry, Explorer verbs, full cleanup; NSIS and MSI). Not tested: an
  all-users (admin) install, upgrading over an older *installed* version by running the installer by hand, other Windows
  versions, and whether the Explorer menu entries look right with many other programs installed. The MSI has no
  Explorer right-click entries. The installer's Arabic/French/German/Spanish wording for the menu entries is a machine
  draft that needs native review. In a silent Arabic-only build the Arabic menu text was written to the registry
  correctly, but the installer's own wizard windows were never looked at in any language other than by silent runs.
- **Auto-update** was tested end to end (real 0.1.0 to 0.1.1 update from a local server, relaunch, and a tampered
  download refused), but not against a real host, not with a signed build, and not the "Later" path across a restart.
  The update feed URL is a placeholder until you have a host.
- **Code signing** has not been done with a real certificate (see "Code signing"); users will see SmartScreen warnings
  until it is.
- **Never opened in Acrobat, Word/Excel/PowerPoint or Preview.** Output was validated structurally and rendered with
  PDF.js; Office conversion fidelity was compared against LibreOffice, not Microsoft Office.
- **Real-world PDFs**: the text/image editing engine was tested on generated files that imitate Word, Chrome and
  LibreOffice output, not on real third-party files. Set `EPDF_CORPUS_DIR` to run its opt-in corpus test on your own.
- **Physical printing** and the native print dialog were not exercised; printed pages are rasterized.
- **Password-protected PDFs** can be opened, edited and saved (staying encrypted), but Combine and batch file-size
  reduction skip them, and certificate-based (public-key) encryption is not supported. PDF permission flags are
  advisory in other software (see `docs/features/security.md` for the threat model).
- **Hardware and platforms not tested**: no real scanner, phone, or webcam was available (the Windows WIA script,
  webcam preview, and phone upload were tested against stubs, a fake camera and real HTTP requests); the macOS scanner
  helper (Swift) has never been compiled; cloud-folder detection was tested with fakes, not real OneDrive/Drive/Dropbox.
- **OCR**: only English was verified end to end (Russian by hand once); no page-orientation detection; recognized text
  can't be viewed or corrected.
- **Form builder** and **redaction** were tested on generated documents only. Redaction's guarantee (nothing extractable
  from the saved file) is verified by an in-app self-check and by independent tests, and it refuses when it cannot be
  sure; `docs/features/redact.md` states exactly what is and is not removed. Copies outside Epdf's data folder (backups,
  the original left after Save As) are not controlled.
- **Compression** does not do linearization ("Fast Web View"); a wrong one is worse than none.
- **HEIC** depends on the operating system's codec (Microsoft HEIF extension on Windows); everything else is built in.
- Old binary Office formats (`.doc`, `.xls`, `.ppt`) are not converted; save them as `.docx/.xlsx/.pptx` first.
- A spreadsheet that declares absurd repeat counts (a billion cells) is capped at 512 columns x 2000 rows, but
  converting that capped sheet still takes ~40 s.
- **Arabic and other right-to-left text in existing PDFs** is selected, copied and searched in logical order through
  the page text model (`src/shared/pagetext/`, see `docs/page-text.md`), verified on LibreOffice, Chromium, the text
  engine and legacy visual-order files. Its limits (heuristic reading order of complex layouts, fonts without any
  Unicode mapping, vertical writing, tashkeel-sensitive library search) are listed there. Text that Epdf *writes*
  (form fields, Add text, stamps, form builder, text boxes, comparison reports, redaction overlays, headers/footers,
  new text in the text editor) is shaped by the text engine (`src/shared/text/`) whenever the standard fonts cannot
  encode it; `docs/text-engine.md` section 13 lists the rule and each feature. Editing *existing* Arabic text in the
  page content is not supported properly yet, and Acrobat's handling of Epdf's Arabic form fields was not tested.
- Drag-a-tab-out-of-the-window is not implemented; use **Document ▸ Move Tab to New Window**.

## Licensing and self-containment

Epdf may be sold, so **AGPL/GPL components are avoided**: no MuPDF, no Ghostscript, no `jszip` (GPL option).
It is **self-contained**: an end user installs Epdf and nothing else. There is no dependency on LibreOffice,
Tesseract, qpdf or any other installed program. Office conversion, OOXML export, content editing, redaction, password
protection and compression are Epdf's own code; OCR uses `tesseract.js` (WASM, Apache-2.0) bundled in the app.
LibreOffice is only an *optional* higher-fidelity engine, used if the user already has it and chooses it. (On the
development machine LibreOffice, qpdf and Tesseract are installed only to cross-check Epdf's output in tests; those
tests skip when the tools are absent.)
Bundled fonts (Liberation, Carlito, Caladea, Noto Sans, and several script fonts) are SIL OFL / Apache-2.0 with
their license texts in `resources/fonts`. PDF.js, pdf-lib, React, zod, zustand, fflate, utif2 and fontkit are MIT or
Apache-2.0.

## Roadmap

- **Phase 4** — cloud backend: signature requests (11), sharing (15), shared review (17)
- **Phase 5** — headers/footers/watermarks (21), links & bookmarks (22), performance, installers, signing, auto-update
