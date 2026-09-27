# Writing an Epdf feature

This is the contract for adding a feature to Epdf. Read it fully before writing code. A feature is
**self-contained**: it adds new files and (almost) never edits shared ones, so several features can be built
in parallel and merged without conflicts.

## 1. Ground rules

1. **Licensing.** Epdf may be sold. Only add dependencies with permissive licenses (MIT, BSD, Apache-2.0,
   ISC, MPL-2.0 for unmodified use). **No AGPL/GPL/LGPL-static** code: no MuPDF, no Ghostscript, no `mupdf`,
   no `pdfjs`-forks with copyleft, no `poppler` bindings. Check the license of every package (and its
   transitive dependencies) before installing; list new dependencies + licenses in the change description. If a
   task seems to need a copyleft library, implement the needed part yourself instead.
2. **Self-contained.** Epdf is an independent program: an end user installs Epdf and nothing else. No
   feature may *require* LibreOffice, Tesseract, qpdf, Ghostscript, Python, Java or any other program to be
   installed. Implement it in-house (TypeScript, or WASM shipped inside the app: e.g. `tesseract.js`
   for OCR, our own AES-256 for encryption). A native helper may only be (a) bundled inside the installer
   with a permissive license, or (b) an *optional* accelerator that is used only if present and never
   needed for correctness. Anything that depends on the operating system's own components (e.g. HEIC
   codecs) must degrade with a clear message. State in your report exactly what is in-house vs optional.
3. **Offline.** All local features work with no network. Never fetch anything at runtime except where a
   feature explicitly says so (e.g. OCR language packs on demand).
3. **Never execute PDF-embedded JavaScript.** Never render untrusted HTML with scripts enabled.
4. **Security model stays intact.** The renderer is sandboxed (`contextIsolation`, no Node). Anything that
   touches the file system, spawns a process or needs a secret runs in **main** behind a validated channel.
   Never accept a file path from the renderer for reading/writing; use a `docId` and resolve it with
   `ctx.pathOfDoc(docId)`. Validate every payload with zod. Spawn tools with `runProcess` (argument arrays,
   no shell).
5. **Everything editable goes through the edit pipeline** (§3) so it is undoable, autosaved, recoverable
   and saved by the standard Save commands.
6. **Accessibility (WCAG 2.1 AA).** Keyboard-operable, labelled controls, visible focus, no color-only
   meaning, dialogs built on `Modal`, live regions for status. Your feature's UI must pass the axe helper
   (§7). Respect light and dark themes (use the Tailwind tokens: `bg-surface`, `text-ink`, `border-line`,
   `bg-accent`, ...; never hard-code colors except PDF content).
7. **UI never freezes.** Anything that can take more than ~100 ms on a large file (OCR, conversion,
   compression, comparison, big pdf-lib operations on 100 MB+ files) is a **job** (§5) or done in chunks
   that yield to the event loop.
8. **Output must be valid PDF** that opens in other readers. Prefer pdf-lib's public API; if you write raw
   objects, produce proper appearance streams (`/AP`) so annotations/fields display everywhere.
9. **Windows dev machine.** Use PowerShell syntax; put `C:\Program Files\nodejs` on `PATH` first
   (`$env:Path = "C:\Program Files\nodejs;" + $env:Path`). **Do not edit source files with PowerShell
   `Get-Content`/`Set-Content`** (it corrupts UTF-8); use your editor/edit tools. Files are UTF-8 without BOM.
10. Match the surrounding code style (TypeScript strict, 2-space indent, no semicolons, single quotes).

## 2. Anatomy of a feature

```
src/renderer/src/features/<name>/index.tsx   # REQUIRED entry: calls register*(…) — auto-loaded
src/renderer/src/features/<name>/…           # components, hooks, pure logic
src/main/features/<name>/index.ts            # optional: exports register(ctx) — auto-loaded
src/main/features/<name>/…                   # channels, jobs, workers
src/shared/features/<name>.ts                # optional: zod schemas / types used by both sides
tests/unit/<name>*.test.ts                   # Vitest (pure logic; runs in Node)
tests/e2e/<name>.spec.ts                     # Playwright + Electron (drives the real app)
tests/fixtures/<name>.mjs                    # optional: generates extra fixture PDFs (pdf-lib)
docs/features/<name>.md                      # what it does, limits, how to test manually
```

`index.tsx` files under `features/*/` are loaded by `import.meta.glob`, so **do not edit any registry
file**. The built-in example to copy is `features/core` (commands, dialogs, panel, autosave/recovery) and
`features/core/rotate.ts` + `src/main/features/core/index.ts` (a complete tiny edit feature with a menu item).

### Reusing other features

Pure, DOM-free logic in another feature may be **imported read-only** (e.g. the content-stream engine in
`features/textedit/pdfcontent/`, the form-field model in `features/forms/`, the page-edit engine in
`src/shared/features/pages/`, the markup annotation builders in `features/markup/pdf/`, the Office/PDF writers in
`features/create|export`). Never edit another feature's files: if you need a change, extend through a new file
of your own or wrap the function, and mention it in your report. Talk to other features through
`runCommand('<id>')` (soft dependency: the command may not exist) rather than importing their UI.

### Files you may edit

* Anything inside your own feature folders and test files above.
* `package.json` / `package-lock.json`: only to add dependencies (run `npm install <pkg>`; keep the diff
  minimal).
* `electron-builder.yml`: only to add `extraResources`/`files` entries your feature needs.

### Files you must not edit (shared core)

`src/main/{index,controller}.ts`, `src/main/ipc/*`, `src/main/windows/*`, `src/main/db/*` (except adding a
**new migration** at the end of `MIGRATIONS` if you need tables — see §4), `src/shared/{ipc,schemas,types,channels}.ts`,
`src/preload/*`, `src/renderer/src/{App,main}.tsx`, `src/renderer/src/state/*`, `src/renderer/src/edit/*`,
`src/renderer/src/viewer/*`, `src/renderer/src/components/*`, `src/renderer/src/features/{api,index,keys}.ts`.
If you hit a limitation that truly needs a core change, make the **smallest possible** edit, keep it
backwards compatible, and list it (file + why) in the change description.

## 3. Renderer API

Import from `../api` (i.e. `src/renderer/src/features/api.ts`):

| Function | Purpose |
|---|---|
| `registerCommand({ id, label, run, shortcut?, enabled? })` | A named action. Shortcut like `mod+shift+h` (mod = Ctrl/Cmd). Menu items from main call commands by id. |
| `registerTool({ id, label, icon, group, Options?, cursor?, onActivate?, onDeactivate? })` | A button in the **Tools ribbon** (below the toolbar). Active tool = `useWorkspace().activeTool`. `Escape` deactivates. |
| `registerPageOverlay(Component)` | Rendered on top of **every rendered page** (props: `docId, pageIndex, pageNumber, scale, width, height, viewport, renderVersion`). The layer ignores the mouse; give elements the class `pointer-events-auto` to receive events. Return `null` when your tool is inactive. |
| `registerPanel({ id, label, icon, side: 'left' \| 'right', Component })` | Sidebar panel. Open a right panel with `useWorkspace.getState().setRightPanel(id)`. |
| `registerView({ id, label, Component, hideToolbar? })` | A full-tab mode replacing the page viewer (page organizer, compare). Switch with `useWorkspace.getState().setView(docId, id)` (`null` returns to the viewer). |
| `registerDialog(Component)` | An always-mounted host for your modal(s); it decides when to show itself (typically from a zustand store). Build on `components/Modal`. |
| `registerContextItems(area, order, (at) => items)` | Your group in the right-click menu on pages: `area` is `'selection'` (text is selected) or `'page'`; `at` = `{ docId, pageIndex, numPages, selectionText }`. Items are `{ label, command? \| run?, enabled?, checked?, keys? }` or `{ type: 'separator' }`. Menus on your own elements: `openContextMenu(e, items)` from `components/contextMenu` in an `onContextMenu` handler. See `docs/features/chrome.md`. |

State & helpers you can import:

* `state/tabs` — `useTabs`, `selectActiveTab`, `Tab` (`docId`, `name`, `path`, `view: {page, zoom, …}`, `numPages`, `status`).
* `state/actions` — `activeTab()`, `openFiles()`, `pageTo()`, …
* `state/notify` — `notify('error'|'info'|'success', message, action?)`, `errorMessage(err)`.
* `state/confirm` — `askConfirm({ title, message, buttons, cancelValue })` → chosen `value`.
* `state/jobs` — `startJob<R>(kind, payload)` → `{ promise, cancel }`. Progress + Cancel show in the jobs tray automatically.
* `state/viewerOptions` — `useViewerOptions.getState().setAnnotationMode(AnnotationMode.ENABLE_FORMS)` stops
  PDF.js painting form widgets on the page canvas (use it when you draw your own interactive inputs); restore
  `ENABLE` when your feature is inactive. `DISABLE` hides all annotations.
* `state/workspace` — `useWorkspace` (active tool, panels, views).
* `pdf/docCache` — `getLoaded(docId)` → `{ doc: PDFDocumentProxy, numPages, sizes }` for reading page content with PDF.js.
* `pdf/search` — text extraction helpers (`getPageText`).
* `viewer/layout` — `CSS_SCALE` (96/72), page/zoom math.

### The edit pipeline (`edit/session`)

```ts
import { editPdf, replaceBytes, currentBytes, undo, redo } from '../../edit/session'

await editPdf(docId, 'Delete page 3', (pdf) => { pdf.removePage(2) })   // pdf-lib PDFDocument
replaceBytes(docId, 'Compress', bytesFromAJob)                            // externally produced result
const bytes = await currentBytes(docId)                                   // what the user currently sees
```

* Each call is **one undo step** with that label (shown as "Undo Delete page 3").
* Edits to one document are **serialized**; `currentBytes`, save, undo and close wait for in-flight edits.
* Nothing is written to disk until the user saves. Autosave, crash recovery, version history, the unsaved
  dot and the close/quit guard are automatic.
* **Encrypted documents** go through hooks (`edit/hooks.ts`): `registerEditHooks({ decrypt, beforeWrite })`.
  `editPdf` calls `decrypt(docId, bytes)` when pdf-lib says a document is encrypted; if a hook returns plaintext
  it silently becomes the document's baseline (no undo step, not "unsaved"). **Every write out of memory** —
  Save, Save As, Save a Copy and the autosaved recovery copy — goes through `bytesForWriting(docId)`, which runs
  all `beforeWrite` hooks (Security re-encrypts there, so a protected document never reaches disk as plaintext).
  If you write document bytes anywhere the user's file could end up, use `bytesForWriting`, not `currentBytes`.
  **A NEW file derived from a document's working copy** (extract/split pages, Print to PDF, any export that
  re-uses the loaded `PDFDocument`) must call `stripProtectionMarker(pdf)` from
  `src/shared/features/protectionMarker.ts` before saving: the working copy of an unlocked, protected document
  carries a marker holding the file's encryption key, and it must never end up in a different file. In-place
  edits must NOT strip it (it is what makes Save re-encrypt). `tests/unit/marker-leak.test.ts` guards this.
  Features that read a document with pdf-lib themselves call `await ensureEditable(docId)` first (false = the
  user declined to unlock). Without a `decrypt` hook, `editPdf` throws `EditError('… password protected …')`.
  Catch errors and `notify('error', …)`.
* The viewer reloads automatically after every edit; page numbers may change, so re-read state after awaiting.
* Never mutate bytes returned by `currentBytes`.

### Coordinates

`viewport.convertToViewportPoint(x, y)` / `convertToPdfPoint(x, y)` convert between PDF user space
(points, origin bottom-left, y up) and CSS pixels on the page (origin top-left, y down). Page `/Rotate` is
already applied by the viewport. Write annotations/fields in **PDF user space** (unrotated page space) —
convert points through `viewport.convertToPdfPoint`, and remember `page.getRotation()` for rotated pages.

## 4. Main-process API

`src/main/features/<name>/index.ts`:

```ts
import { z } from 'zod'
import type { MainContext } from '../api'
import { registerFeatureChannel, sendFeatureEvent } from '../api'
import { commandItem, contributeMenu } from '../../menu/contributions'

export function register(ctx: MainContext): void {
  registerFeatureChannel('ocr:languages', z.object({}), async () => listLanguages())
  registerFeatureChannel('ocr:run', z.object({ docId: z.string(), lang: z.string() }), async ({ docId }, { window }) => {
    const path = ctx.pathOfDoc(docId)            // never trust a path from the renderer
    …
  })
  contributeMenu({ menu: 'Tools', items: () => [commandItem('OCR…', 'ocr.open')] })
}
```

* Renderer calls a channel with `window.epdf.call<Result>('ocr:languages', payload)`. Channel names are
  `<feature>:<action>` (lowerCamel), unique across the app; unknown channels and invalid payloads are rejected.
  Binary payloads (`Uint8Array`) are fine.
* Push events to the renderer: `sendFeatureEvent(window | 'all', 'ocr:progress', payload)`; subscribe with
  `window.epdf.onFeature('ocr:progress', cb)` (returns an unsubscribe fn).
* `ctx` gives `controller`, `repos` (SQLite), `files`, `jobs`, `windows`, `pathOfDoc(docId)`.
* **Small persistent state** (settings, remembered choices, caches of small JSON): `ctx.kv('<feature>')` →
  `get(key, fallback)` / `set(key, value)` / `delete(key)` / `keys()`. Use this instead of tables.
* **SQLite tables** only when you truly need relational data or an index (a migration number is assigned to you
  in your task; append it at the end of `MIGRATIONS` in `src/main/db/migrations.ts`, never edit existing ones).
  Put queries in your own repo class in your feature folder (take `ctx.repos.db`). Never store secrets in plain text —
  use Electron `safeStorage` to encrypt them.
* **Native tools (optional only — see rule 2):** `resolveTool('soffice')` from `services/tools` returns an
  executable path (bundled `resources/bin/<platform>-<arch>/`, or `EPDF_TOOL_<NAME>` env override, or PATH) or
  `null`. Use it only for *optional* accelerators; the feature must work without it. Do not commit binaries.
  Tests that exercise an optional tool must `test.skip` with a clear message when it is unavailable.

## 5. Background jobs (never block the UI)

```ts
// main: src/main/features/<name>/index.ts
import createWorker from './myWorker?nodeWorker'            // electron-vite bundles it (worker_threads)
ctx.jobs.register('ocr:page', 'Recognizing text', payloadSchema, (payload, jobCtx) =>
  runInWorker<Result>(createWorker, payload, jobCtx))       // progress + cancel handled for you

// or run a native tool without blocking:
ctx.jobs.register('qpdf:encrypt', 'Encrypting', schema, async (p, jobCtx) => {
  await runProcess(requireTool('qpdf', 'Encryption'), [...args], jobCtx)
})

// myWorker.ts
import { serveJob } from '../../jobs/serveJob'
serveJob<Payload, Result>(async (payload, report) => { report(0.5, 'Halfway'); return result })
```

Renderer: `const { promise, cancel } = startJob<Result>('ocr:page', payload)`. Cancelling terminates workers
and kills child processes. Payload/result must be structured-cloneable. Write big intermediate files to
`app.getPath('temp')` inside a per-job directory and **delete them in a `finally`** (no leaked temp files).

## 6. Persistence conventions

* User data lives under `app.getPath('userData')`. Recovery/version files are handled by core.
* Settings that must survive restarts: prefer your own SQLite table; renderer-visible global settings are
  a core concern.

## 7. Testing (required — every feature ships with tests)

Run from the repository root (PowerShell):

```powershell
$env:Path = "C:\Program Files\nodejs;" + $env:Path
npm run typecheck          # must be clean
npm test                   # Vitest unit tests
npm run build              # production build (e2e runs against out/)
npx playwright test <name> # your e2e spec
npx playwright test        # the whole suite must still pass before you finish
```

* **Unit tests** (`tests/unit/<name>*.test.ts`, Node environment): test the PDF logic, parsers, schemas,
  and pure state. Modules that import `pdfjs-dist` cannot load in Node — keep testable logic in modules that
  only use `pdf-lib`/pure TS. Assert on **real PDF output** (re-load the saved bytes with pdf-lib and inspect
  it), not on mocks.
* **E2E tests** (`tests/e2e/<name>.spec.ts`): use `tests/e2e/helpers.ts` — `launch({ files, env })`,
  `copyFixture(name)` (always edit copies, never shared fixtures), `menuClick(app, 'Menu', 'Item')`,
  `gotoPage`, `canvasHasInk`, `axeViolations(page, label)`, `crash(app)`, `quitDiscarding(app, page)`,
  `contextMenu(app, target, 'Item label')` (right-click and pick an item; `null` only records the menu).
  Tests that end with unsaved edits must end with `quitDiscarding` (a plain `app.close()` waits on the
  "Save changes?" prompt). Verify the **saved file on disk** with pdf-lib, and that it renders.
* Fixtures: generate deterministic PDFs with pdf-lib in `tests/fixtures/<name>.mjs` (call it from your spec
  with `execFileSync(process.execPath, [...])` in `test.beforeAll`), or reuse `tests/fixtures/generate.mjs`
  outputs (`sample.pdf` 5 pages, `large.pdf` 500 pages, `mixed.pdf` mixed sizes, in `test-results/fixtures`).
* Accessibility: include an `axeViolations` scan of your feature's UI in each relevant state (light + dark).
* Include failure paths (bad input, cancelled dialog, missing tool, encrypted doc) — not just the happy path.
* Every bug you find while testing gets a regression test.

### Lessons from the first round (please follow)

* Run your spec by **file path** (`npx playwright test tests/e2e/<name>.spec.ts`): a bare name also matches your
  repository's folder name and runs everything.
* Never kill Electron by name; several engineers test on the same machine. Kill only PIDs you started. Tests
  must not leave windows open: end any test that can finish with unsaved edits using `quitDiscarding`.
* Tests share the CPU with other engineers: use generous timeouts and re-run a flaky test before blaming the code.
* `tests/unit/shortcuts.test.ts` scans all sources for keyboard-shortcut / menu-accelerator collisions and fails on
  any. Pick a free key (bare-letter tool keys are global: check the existing ones first).
* The **camera** is available only through `getUserMedia({ video })` on Epdf's own pages (video only; every other
  permission is denied). For tests set env `EPDF_FAKE_MEDIA=1` to get a synthetic camera without a prompt.
* A wrong-looking result is worse than a refusal: when input is unsupported, say so with a clear message.

## 8. Definition of done

1. `npm run typecheck`, `npm test`, `npm run build` and the **full** `npx playwright test` all pass.
2. New unit + e2e tests cover the feature and its failure modes; axe scan is clean.
3. `docs/features/<name>.md` explains behavior, limitations, and manual test steps.
4. You committed your work on your branch (small, descriptive commits).
5. The change description lists: what was built, files touched outside your folders (with reasons), new
   dependencies (+ license), tests added (counts), **what you could not verify or did not implement**, and
   any core limitations you hit. Do not overstate: if something is best-effort, say so.
