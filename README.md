# Epdf

A desktop PDF application (Electron + TypeScript + React). Works fully offline for all local features.

**Status: Phase 1 complete** — Electron shell, secure IPC, tabs/windows, native menus, file associations, and the
PDF viewer (feature 1). Later phases are listed at the bottom.

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
| `npm run icon` | Regenerate the placeholder icon at `build/icon.png` |

The E2E suite generates its own PDF fixtures (5-page sample, 500-page document, mixed page sizes) into
`test-results/fixtures` — nothing to download.

## Packaging

Artifacts are written to `dist/`. Configuration lives in `electron-builder.yml`.

### Windows (run on Windows)

```powershell
npm run dist:dir     # unpacked app in dist\win-unpacked (fast; good for testing)
npm run dist:win     # NSIS installer (.exe) + MSI, x64
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
`Get-AuthenticodeSignature dist\win-unpacked\Epdf.exe`. Signing every bundled tool (qpdf, Tesseract, …) is part of
Phase 5, when those tools are added.

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

## Known limitations / not yet verified

- **macOS is unverified**: the universal `.dmg` build, Dock menu and `open-file` handling are written but were not
  run on a Mac.
- **Installers** (`.exe`/`.msi`) are configured, but only the unpacked build (`--dir`) has been produced and tested.
- Password-protected PDFs: the prompt is implemented but has no automated test yet (needs an encrypted fixture,
  which arrives with qpdf in Phase 3).
- Drag-a-tab-out-of-the-window is not implemented; use **Document ▸ Move Tab to New Window**.
- Printing arrives in Phase 2 (feature 10). "Show in folder" is available to the IPC layer but has no UI yet.

## Licensing notes

The project may be sold, so **AGPL components are avoided**: no MuPDF and no Ghostscript. Planned replacements:
pdf-lib and PDF.js for structure/rendering, qpdf (Apache-2.0) for encryption and linearization, Tesseract
(Apache-2.0) for OCR, LibreOffice (MPL-2.0) for Office conversion, and in-house code for true redaction, text
editing and compression. PDF.js, pdf-lib, React, zod and zustand are permissively licensed (Apache-2.0 / MIT).

## Roadmap

- **Phase 2** — features 2–10: forms, signing, create/combine, edit text & images, markup, export, page organizer, print
- **Phase 3** — features 12, 13, 14, 16, 18, 19, 20 and the local library (15)
- **Phase 4** — cloud backend: signature requests (11), sharing (15), shared review (17)
- **Phase 5** — headers/footers/watermarks (21), links & bookmarks (22), performance, installers, signing, auto-update
