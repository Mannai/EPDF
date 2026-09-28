# Developing Epdf

Everything needed to build, test and package Epdf from source. For what the app does, see the
[README](../README.md); for the rules a feature follows, see [Writing an Epdf feature](FEATURES.md).

- [Requirements](#requirements)
- [Setup](#setup)
- [Everyday commands](#everyday-commands)
- [Packaging](#packaging)
- [Architecture](#architecture)
- [Testing](#testing)
- [Licensing and self-containment](#licensing-and-self-containment)

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
| `npm run icon` | Regenerate the icons `build/icon.png` and `build/icon.ico` |
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

Windows reports an MSI's version without the pre-release label (`1.0.6-beta.1` installs as `1.0.6.0`), so every beta
must raise the numeric version, or the MSI won't upgrade.

**Explorer right-click entries.** The NSIS installer adds **Convert to PDF with Epdf** (pictures, Word/Excel/
PowerPoint/OpenDocument, RTF, text, CSV) and **Combine files in Epdf** (the same types) to the context menu. PDFs
get no extra entries: Epdf appears for them only under **Open with**.
They run the app with `--convert-to-pdf` / `--combine`; several selected files open one Combine screen. The menu text
follows the installer's language. They live in `build/installer.nsh` and are removed by the uninstaller (as are the
`.pdf` association leftovers and the update cache). User data (settings, library, signatures) is kept on uninstall.

Silent install / uninstall, for scripts:

```powershell
.\dist\Epdf-Setup-<version>.exe /S                 # install for the current user
.\dist\Epdf-Setup-<version>.exe /S /D=C:\Tools\Epdf # ...into a chosen folder
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

A universal build must be produced on macOS. The macOS build is configured but has **not been run yet**; expect to
check it on a Mac or a `macos-latest` CI runner.

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
    features/   main-process half of each feature (jobs, workers, file formats)
  preload/    the only bridge: exposes a small typed `window.epdf` API via contextBridge
  renderer/   React UI: tabs, ribbon, viewer (PDF.js), thumbnails, search, feature overlays
  shared/     zod schemas, IPC contract and types; the text engine (shared/text) and page text model (shared/pagetext)
tests/
  unit/       Vitest
  e2e/        Playwright + Electron
```

Two subsystems carry the multilingual support and have their own documents:

- [The text engine](text-engine.md) shapes and lays out everything Epdf writes into a page (Arabic joining, bidi,
  complex scripts, font fallback, `/ToUnicode` and `/ActualText`).
- [The page text model](page-text.md) reads existing pages in logical order for selecting, copying, searching and
  editing, including right-to-left text from many producers.

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

SQLite at `<userData>/epdf.db` (WAL). Migrations are append-only (`src/main/db/migrations.ts`). Signatures are stored
encrypted with the operating system's key store; recovery files and version history live under `<userData>`.

### Crash recovery

The renderer reports open tabs (path, page, zoom, layout) to main, which snapshots them transactionally. A
"clean exit" flag is cleared at launch and set on quit, so after a crash the previous tabs are always restored;
after a normal quit they are restored if **restoreOnLaunch** is on (default).

## Testing

`npm test` runs about 2,700 unit tests and `npm run test:e2e` about 450 end-to-end tests that drive the real app
(set `EPDF_E2E_WORKERS` to change the number of parallel workers). The packaged app is covered by `npm run dist:dir`
plus the opt-in packaged specs (set `EPDF_PACKAGED_EXE` to the built `Epdf.exe`, then `npm run test:packaged` and the
`*-packaged.spec.ts` files).

Guard tests worth knowing about: `tests/unit/shortcuts.test.ts` fails on any keyboard-shortcut collision, and
`tests/unit/marker-leak.test.ts` proves a protected document's key never leaks into files derived from it. A few tests
need optional local tools (qpdf, LibreOffice) and skip cleanly without them.

## Licensing and self-containment

Epdf is commercial software, so **AGPL/GPL components are avoided**: no MuPDF, no Ghostscript, no `jszip` (GPL option).
It is **self-contained**: an end user installs Epdf and nothing else. There is no dependency on LibreOffice,
Tesseract, qpdf or any other installed program. Office conversion, OOXML export, content editing, redaction, password
protection and compression are Epdf's own code; OCR uses `tesseract.js` (WASM, Apache-2.0) bundled in the app.
LibreOffice is only an *optional* higher-fidelity engine, used if the user already has it and chooses it. (On a
development machine LibreOffice, qpdf and Tesseract are used only to cross-check Epdf's output in tests; those tests
skip when the tools are absent.)

Bundled fonts (Liberation, Carlito, Caladea, Noto Sans, Aref Ruqaa and several script fonts) are SIL OFL / Apache-2.0
with their license texts in `resources/fonts`. PDF.js, pdf-lib, React, zod, zustand, fflate, utif2 and fontkit are MIT
or Apache-2.0.

Epdf's own code is under the [PolyForm Strict License 1.0.0](../LICENSE.md) (source-available: personal and other
noncommercial use only, no changes or redistribution).

**Third-party notices.** `npm run build` writes `out/THIRD-PARTY-NOTICES.txt` (`scripts/lib/notices.mjs`, a Vite
plugin in `electron.vite.config.ts`): the full license text of every npm package in the main, preload, renderer and
worker bundles, of every runtime `dependency` shipped in `node_modules`, and of the fonts, WebAssembly modules and
data files listed in `ASSET_LICENSE_DIRS`. The installers put it and `LICENSE.txt` in the app's `resources` folder;
**Help ▸ License** and **Help ▸ Third-Party Notices** open them. A new asset folder that ships with its own license
file must be added to `ASSET_LICENSE_DIRS`.
