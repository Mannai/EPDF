# Page organization, splitting and printing

Features 9 (page organizer, insert / extract / split) and 10 (printing, Print to PDF).
No new dependencies: everything is built on `pdf-lib` (MIT), `pdfjs-dist` (Apache-2.0) and Electron.

## What the user gets

**Document ▸** *Organize Pages…*, *Insert Pages…*, *Extract Pages…*, *Delete Pages…*, *Split Document…*,
*Rotate Page Clockwise / Counterclockwise* (`Ctrl/Cmd+]`, `Ctrl/Cmd+[`), *Rotate Pages…*
**File ▸** *Print…* (`Ctrl/Cmd+P`), *Print to PDF…*

### Organizer (`pages.organize`)

A full-tab view (`registerView({ id: 'organize', hideToolbar: true })`) with a grid of page thumbnails.

* **Windowed**: only the rows near the viewport are mounted and rendered (a 500-page document keeps well under 80 thumbnails mounted);
  thumbnails render lazily with PDF.js and are cancelled when they scroll away. Thumbnail size slider (remembered).
* **Select**: click, `Ctrl/Cmd+click`, `Shift+click` (range), `Ctrl+A`; keyboard: arrows / Home / End / PageUp / PageDown move
  focus, `Space` toggles the focused page, `Shift+Arrow` extends. Rubber-band selection is *not* implemented.
* **Reorder**: drag with the mouse (drop indicator, ghost label, edge auto-scroll, multi-page drag keeps the pages'
  relative order, `Escape` cancels the drag) **or** with the keyboard: `Alt+Arrow` moves the selected pages one step (a row for
  Up/Down), `Alt+Home/End` to the start/end, or the *Move earlier / later* buttons.
* **Actions** (each one undo step with a readable label such as "Undo Delete page 3"): rotate left/right, delete (asks first for
  5+ pages; refuses to delete every page), duplicate (copy right after each selected page), insert blank pages (size of the
  neighbouring page or A4/Letter/Legal/A3/A5, portrait/landscape, before/after a page), insert pages from another PDF,
  extract, split.
* `Done` / `Escape` / `Enter` return to the viewer (on the focused page). Undo/Redo buttons are in the organizer's toolbar.
* While an edit is applied the grid is busy (`aria-busy`) until the edited document has reloaded, so it never acts on stale pages.
* Accessibility: `listbox`/`option` roles with `aria-activedescendant` (works with the windowing), instructions via
  `aria-describedby`, announcements in the global live region ("Page moved to position 2.", "Deleted 2 pages. 3 pages remain."),
  visible focus and selection that do not rely on colour alone, axe-clean in light and dark.

### Insert from another PDF

Pick the file with a native dialog (`pages:pickPdf` returns the bytes; the renderer never supplies or receives a path), choose
which pages (`1-3, 7, 9-`) and where (start, end, before/after page N). Password-protected sources are refused with a clear
message. Source pages are copied with `copyPages`.

### Extract

Choose pages, pick a file with the native save dialog (`pages:saveExtract`), then Epdf offers *Open* / *Show in folder*.
Optionally removes the pages from the current document afterwards (a separate undo step). Runs as a job (worker thread).

### Split (`pages:split` job)

By **page ranges** ("1-3, 4-10, 11-"), **every N pages**, **maximum file size** or **top-level bookmarks**. The folder is chosen with a
native folder dialog (`pages:pickFolder` returns an opaque token). The job runs in a worker thread with progress and Cancel
in the jobs tray (and in the dialog); cancelling leaves no files. When done the dialog lists the created files with sizes and
*Show in folder*.

* File names: `<document> - 01 - <title>.pdf`. Titles (bookmark text is untrusted) are sanitized: path separators and traversal,
  control / zero-width / bidi-override characters, reserved Windows names (`CON`, `NUL`, `COM1`…), trailing dots and spaces, length.
  Existing files are **never overwritten**: a taken name gets ` (2)`; files are created with exclusive-create (`wx`).
* Size splitting measures real output: each part is grown greedily with galloping + bisection (about `2·log2(pages per part)`
  measurements per part), always between pages. A page that alone exceeds the limit becomes its own part and is reported
  ("Page 4 alone is 700 KB, which is over the limit of 300 KB"). Cost: every measurement builds the candidate part, so splitting a
  huge document by size is slow (it is a cancellable job).
* Bookmarks: parts start at each top-level bookmark's page (sorted by page; bookmarks on one page share a part) and end before the
  next. Pages before the first bookmark become "Front matter". Bookmarks without a resolvable page are skipped and counted in a note.
  Destinations may be explicit arrays, names in the catalog's `/Dests` dictionary or `/Names /Dests` name tree, or `/GoTo`
  actions. Damaged, cyclic or missing outlines never throw.

## How page edits work (`src/shared/features/pages/`)

Every organizer edit is a list of `PageSpec`s ("original page *i*", "blank page", "page *j* of the other PDF") passed to
`applyPageSpecs(pdf, specs)` inside one `editPdf` call, so it is one undo step, autosaved, recoverable and saved by Save.
Extract and split use the same function on a private copy (so a part is "the document with only these pages").

What `applyPageSpecs` does, and therefore what is preserved:

| Thing | Behaviour |
|---|---|
| Page order / content / rotation | The page tree is rewritten as one flat `/Pages` node; inherited `Resources`, `MediaBox`, `CropBox`, `Rotate` are copied onto each page first. Rotation is relative to the current rotation. |
| Annotations & links of a page | Stay with their page (original pages keep their identity). Links between pages that stay keep working after moves. |
| Bookmarks | Edited in place (colours, styles, other actions untouched). Destinations to removed pages are dropped; an item that loses its page but has children keeps its title and children; items with nothing left are removed; `Prev/Next/First/Last/Count` are rebuilt. Extracted/split parts carry the bookmarks of their pages. |
| Dead links | Link annotations and `/OpenAction` pointing at removed pages lose their destination. |
| Page labels (`/PageLabels`) | Expanded to one label per page, permuted with the pages, and re-compressed into ranges. Inserted / blank pages have an empty label. Duplicates keep the original's label. |
| Form fields | Fields whose widgets were only on removed pages are removed from `/AcroForm /Fields`. |
| Deleted content | Objects reachable only from removed pages are **deleted from the file** (`pruneUnreachable`), so deleted / non-extracted content is not left hidden in the saved file. |
| Duplicates | A duplicated page shares content and resources with the original (cheap) and gets its own annotations; links keep their targets. |

### Known limits

* **Duplicated pages do not duplicate form-field widgets** (they would need new field names): the copy shows the page content only.
* **Inserted pages**: widgets are dropped; links to pages of the source that were not inserted are dropped (links between inserted
  pages are kept); named-destination links are dropped (they would resolve against the wrong document); the source's bookmarks,
  page labels and structure tree are not imported.
* The tagged-PDF structure tree (`/StructTreeRoot`) is left as is; entries for removed pages may remain (they point at nothing) and
  can still carry alt text of removed pages. Named destinations and the XMP metadata are not rewritten.
* Password-protected documents cannot be edited (`editPdf` refuses; the Security feature owns decryption). Big files are edited on the
  renderer thread (that is how `editPdf` works); extract/split/print preparation run in a worker.
* Undo restores the previous full snapshot, so the organizer does not keep per-page identity across undo: thumbnails re-render.

## Printing

### Technique and why

Two techniques were evaluated by experiment in Electron 44 (throw-away scripts, results summarised here):

* **(a) Chromium's PDF viewer in a hidden window + `webContents.print`.** `printToPDF` on such a window works (page count and
  `pageRanges` were honoured and the output was vector). It was **not chosen** because PDFium's JavaScript engine cannot be turned
  off, so it cannot meet "never execute PDF JavaScript"; and `webContents.print` (the native dialog path) on a PDF viewer cannot be
  verified in CI.
* **(b) Rasterize in the renderer and print an inert HTML document — chosen.** PDF.js (scripting disabled) draws each page at
  150 / 200 / 300 dpi (Draft / Standard / High), sends the JPEGs to main, which lays them out in a static HTML document
  (`shared/features/print/html.ts`: one full-sheet block per page, `100vw × 100vh`, `break-after: page`, collated copies) and
  prints it in a hidden sandboxed window with `webContents.print()` (the native OS dialog). Experiments confirmed that this
  layout produces exactly one sheet per page for A4/Letter, portrait/landscape.
  **Vector quality is lost when printing** (text is 150–300 dpi pixels); the dialog says so. *Print to PDF* is vector.

Guarantees: no PDF JavaScript runs (PDF.js `enableScripting` is off; the print window has `javascript: false`, a CSP of
`default-src 'none'; img-src <job origin>`, its own in-memory session, no permissions, and every request except the job's own images
is cancelled). Nothing is written to disk: page images live in main's memory and are served through a per-job in-memory protocol
handler; the job (and window) is destroyed when printing ends or is cancelled. A private-TEMP e2e test asserts no temp files appear.

### Options

* **Pages**: all / current / custom (`1-3,7`, validated with readable errors; order as typed, duplicates dropped).
* **Copies** 1–99: the sheets are repeated (collated) in the document, so the count is exact and testable. (The OS dialog's own copies
  field still works on top of that.)
* **Scaling**: *Fit to printable area* (scales up or down to the sheet; margins come from the print dialog's "printable area"),
  *Actual size* (100 %, centred; a page bigger than the sheet is cropped evenly), *Custom* 10–400 %.
* **Orientation**: Automatic = landscape when most selected pages are landscape (a tie is portrait), or forced. It is a per-job
  setting: the minority orientation is fitted (shrunk), not rotated.
* **Print annotations**: off removes comments, highlights, stamps, links… from a *temporary copy* with pdf-lib (form widgets are
  kept because they carry the field values); the open document is never touched. The preview reflects the setting.
* **Current state**: the pipeline uses `currentBytes`, i.e. unsaved edits are printed.
* **Quality** (dpi) trades sharpness for memory and time. A job is capped at 2 GB of page images; the dialog reports "too large".
* Password-protected documents: pdf-lib cannot read them, so pages are rendered directly from the (already decrypted) PDF.js
  document, with annotations toggled through PDF.js instead of stripped. *Print to PDF* is refused for them.

The whole thing is chunked: the pdf-lib preparation is a job (progress + Cancel in the tray), then pages are rendered one at a time
with a yield between pages; Cancel works between pages.

### Print to PDF

*File ▸ Print to PDF…* is "Save as PDF" of the current state, **vector-preserving**, with the same range and annotation options and
scaling onto a chosen paper (*same as each page* / A4 / Letter). Implementation: pdf-lib extraction of the selected pages, then
(if needed) the page content is wrapped in a transformation matrix and the page boxes and annotation `/Rect`s are scaled and
centred (`scalePages`), so annotations stay in place and appearances stretch with them. Written with the native save dialog.

### Test hook

With the environment variable **`EPDF_PRINT_TO_FILE=<path>`** the print pipeline calls `webContents.printToPDF()` on the same print
document (A4, zero margins, landscape if the job orientation is landscape) and writes the result to that path instead of opening the
system dialog. It exercises everything except the OS dialog and the printer: page selection, annotation stripping, scaling
(page images sized by CSS), copies and orientation. E2E tests assert page counts, sizes, and — by rendering the produced file in a
second app instance — whether highlights/comments are visible and how large content is under fit / actual / custom scaling.

### Virtual "Epdf PDF" printer (not implemented; how it would be done)

* **macOS**: no driver needed. Print dialogs list the actions in `~/Library/PDF Services/` (and `/Library/PDF Services/`); installing
  a small shell script / Automator workflow there named "Open in Epdf" that runs `open -a Epdf "$3"` (the PDF is passed as argument 3)
  makes "PDF ▸ Open in Epdf" appear in every app's print dialog. Alternatively a CUPS backend + PPD in
  `/usr/libexec/cups/backend` for a real queue.
* **Windows**: install a local printer that uses the in-box *Microsoft Print To PDF* driver (`Add-Printer -Name "Epdf PDF"
  -DriverName "Microsoft Print To PDF" -PortName <port>`) on a **redirected/file port** owned by a small port monitor or, on Windows 11,
  a v4 class driver plus a *Print Support App* (PSA) that receives the spooled XPS/PDF and launches `Epdf.exe <file>`. The installer
  (NSIS custom script, elevated) would register the printer, and the uninstaller remove it. Requires code signing for the driver
  package. A cheaper interim: register Epdf as a PDF handler so "Microsoft Print to PDF → Open with Epdf" is one click.
* Neither is implemented here and none of it was tested.

## Security notes

* Main-side channels: `pages:pickPdf`, `pages:pickFolder`, `pages:saveExtract`, `pages:openSaved`, `pages:reveal`,
  `print:begin/addPage/run/cancel/savePdf`, jobs `pages:split`, `pages:extract`, `print:prepare`. Every payload is validated with zod; the
  renderer never supplies a path (native dialogs return bytes or opaque tokens; tokens are only issued by main and resolve to paths only in main).
* Split output names cannot escape the chosen folder and never overwrite; failed or cancelled jobs remove what they wrote.

## Tests

* Unit (Vitest, real PDFs made with pdf-lib and re-loaded): `tests/unit/pages-logic.test.ts` (ranges, selection, navigation, moves, drop
  slot, split planners, file names), `pages-ops.test.ts` (reorder / delete / duplicate / rotate / blank / insert, links, page trees, pruning,
  extract), `pages-outline.test.ts` (outline reading — nested, named, name-tree, actions, cyclic, garbage — outline maintenance, page
  labels), `pages-split.test.ts` (split job with real sizes, bookmarks, file writing), `print.test.ts` (option math, annotation stripping,
  page preparation, scaling, print HTML).
* E2E: `tests/e2e/pages-print.spec.ts` with fixtures from `tests/fixtures/pages-print.mjs`.

## Manual test steps

1. Open a multi-page PDF, *Document ▸ Organize Pages…*. Drag pages, use `Alt+Arrow`, rotate/delete/duplicate/insert; check *Undo* labels.
2. *Insert from PDF…* with a PDF of your own; *Extract…* and open the result; *Split…* by each mode into a folder that already contains files.
3. *File ▸ Print…*: check preview, ranges, copies, scaling, orientation; press *Print…* and pick a real printer (or "Microsoft Print to PDF").
   **This is the part CI cannot cover** — verify the sheet count, that scaling/orientation match, that cancel in the OS dialog just closes.
4. *Print to PDF…* with A4 and 50 % scale; open the result (text must still be selectable).
