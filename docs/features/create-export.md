# Create PDF, Combine Files and Export To Word / Excel / PowerPoint

Three File-menu features, all local (no network, no cloud), all with long work running as **jobs** with progress and Cancel.

| Menu item | What it does |
|---|---|
| File ▸ **Create PDF from File…** | Pictures (JPEG, PNG, TIFF, HEIC) and documents (txt, csv, docx, xlsx, pptx, odt, ods, odp, rtf) → one PDF per file |
| File ▸ **Create PDF from Web Page…** | A web address → PDF (private, locked-down browser window) |
| File ▸ **Combine Files…** | Mixed files → one PDF: ordering screen, page ranges, bookmarks |
| File ▸ **Export To ▸ Word / Excel / PowerPoint** | The open PDF → .docx / .xlsx / .pptx (approximate layout) |

Code map: `src/renderer/src/features/{create,combine,export}/`, `src/main/features/{create,combine,export}/`,
`src/shared/features/{create,combine,export}.ts`. Channels: `create:*`, `combine:*`, `export:*`. Job kinds:
`create:convert`, `create:web`, `combine:run`. Commands: `create.fromFiles`, `create.fromWeb`, `combine.open`,
`export.docx|xlsx|pptx`.

**The renderer never sends a file path to be read or written.** Files are chosen in native dialogs opened by main; main
hands back opaque ids (`SourceRegistry`) and all payloads (zod-validated) refer to ids. Results are written by main
(atomic write: temp file + fsync + rename) to a path the user chose in a native Save dialog.

## 1. Create PDF

* **Pictures** (`create/images.ts`): JPEG and PNG are embedded as they are (no re-compression), one page per picture, page =
  picture size. The resolution comes from the file (JFIF / EXIF / PNG pHYs; 72 dpi if absent) so a 300 dpi scan is a
  letter-sized page. Options: *Same size as the picture* (default), *Fit on A4*, *Fit on Letter*. **EXIF orientation 1–8** is
  honoured by transforming the picture (the page swaps width/height for the rotated ones). **TIFF** (multi-page, any
  compression `utif2` reads) → one page per frame, flate-compressed RGB (+ soft mask for alpha), TIFF orientation honoured.
  Pages are capped at PDF's 14400 pt limit.
* **HEIC / HEIF** – see “HEIC investigation” below.
* **Web pages** (`create/webPage.ts`): hidden `BrowserWindow` with a private in-memory `partition` (nothing shared or kept),
  `sandbox: true`, `contextIsolation`, no preload, no Node, every permission request denied, only http(s) requests
  (`onBeforeRequest` cancels everything else, incl. redirects to `file:`), `will-navigate`/`will-redirect` limited to http(s),
  pop-ups denied, downloads blocked, mute, hard timeout (45 s, `EPDF_WEB_TIMEOUT_MS` overrides for tests), cancel destroys the
  window. Then `printToPDF` (background graphics on, tagged PDF, A4 or Letter by locale, 0.5 in margins, CSS `@page` respected).
  The address is validated in the dialog **and** in main (`normalizeWebUrl`: a missing scheme becomes `https://`; `file:`,
  `javascript:`, `data:`, `ftp:`, `about:`, … are refused). Option *Run the page’s scripts* can be switched off (renders
  `<noscript>` content, executes nothing). Errors are user-presentable (DNS failure, refused connection, offline, TLS
  certificate invalid, timeout); an HTTP 404/500 page still renders and the result report notes the status.
* **Office documents**: two engines, chosen in the dialog (remembered per user in `create-prefs.json`):
  * **Built-in converter (default, recommended)** – needs nothing installed, see section 2.
  * **LibreOffice (if installed)** – optional high-fidelity engine, see section 3.
* After conversion: one file → native Save dialog (default `<source name>.pdf` beside the source, never overwriting silently);
  several files → a folder chooser and unique names (`name (2).pdf`); the results open in new tabs. Notes about anything
  approximated/unsupported are shown in a report dialog. A failing file does not stop the others.

### HEIC investigation (what was verified, on Windows 11, Electron 44 = Chromium 152, Microsoft “HEIF Image Extensions” installed)

* No permissively licensed pure-JS HEIC decoder exists (libheif-js is LGPL): nothing HEIC-related is bundled.
* Chromium **cannot** decode a real `.heic` here: `<img>` reports 0×0, `createImageBitmap` throws “source image could not be
  decoded”, `ImageDecoder.isTypeSupported('image/heic')` and `'image/heif'` are **false** (`'image/avif'` is true), and
  `nativeImage.createFromPath` returns an empty image. (Tested with libheif’s `example.heic`, 1280×854.)
* The **OS** can: `create/heic.ts` converts to JPEG with the operating system’s decoder and embeds the JPEG:
  * Windows – Windows Imaging Component through `powershell.exe` + WPF (`BitmapDecoder`/`JpegBitmapEncoder`, 0.4 s for the
    sample). Needs the free HEIF Image Extensions (and HEVC Video Extensions for most iPhone photos) from the Store.
    File names are never spliced into the script (paths travel in environment variables; the script is a constant, passed
    with `-EncodedCommand`).
  * macOS – `/usr/bin/sips` (built in). **Not run on this machine** (implemented from the documented CLI; unverified).
  * Linux – `heif-convert`, else ImageMagick `magick`/`convert`. **Not run on this machine.**
  * If no decoder works the user sees: ““x.heic” could not be converted: … <platform-specific instructions>”.
* Verified end to end with the real sample through the UI (`EPDF_TEST_HEIC=<file.heic> npx playwright test create-export`);
  without that variable the e2e test skips and a second test checks the failure message with a bogus `.heic`.

## 2. The built-in Office → PDF converter (`src/main/features/create/office/`)

Epdf must be self-contained, so Office documents are converted by **Epdf’s own engine**, in a worker thread
(`create/worker.ts`) with progress and cancel. Supported: **txt, csv, docx, xlsx, pptx, odt, ods, odp, rtf**. Legacy binary
**.doc/.xls/.ppt are not supported in-house** and fail with: “Save it as .docx/.xlsx/.pptx first (or use the optional
LibreOffice engine)”.

**The layout is approximate.** Text is set in bundled metric-compatible fonts and paginated by Epdf; results differ in
detail from Word/Excel/PowerPoint/LibreOffice. The UI says so; whatever is not reproduced is listed as a **warning**
(returned in `CreateResult.notes`, shown in the report dialog) – content is never dropped silently.

Pipeline: format reader → `FlowDocument` (docx, odt, rtf, txt: styles resolved by the reader) → layout/pagination
(`layout.ts`, `paginate.ts`), or → display-list pages directly (xlsx/ods/csv sheets, pptx/odp slides) → one PDF writer
(`ops.ts`, pdf-lib for graphics; **all text through the text engine** `src/shared/text`: HarfBuzz shaping, bidi, font
fallback, subset Type0 fonts with ToUnicode and ActualText). Arabic, right-to-left and complex scripts:
[office-rtl.md](office-rtl.md).

### Bundled fonts (`resources/fonts`, shipped through `extraResources`, licences included)

| Font | Used for | Licence |
|---|---|---|
| Liberation Sans / Serif / Mono (2.1.5) | Arial/Helvetica, Times New Roman, Courier New and most other names | SIL OFL 1.1 (`LICENSE-Liberation.txt`) |
| Carlito | Calibri (and Aptos, Candara, Corbel) | SIL OFL 1.1 (`LICENSE-Carlito.txt`) |
| Caladea | Cambria | SIL OFL 1.1 (`LICENSE-Caladea.txt`) |
| Noto Sans (Regular, Bold) | characters the others lack (Greek, Cyrillic, symbols…) | SIL OFL 1.1 (`LICENSE-NotoSans.txt`) |
| Noto Naskh Arabic, Noto Sans Arabic, Noto Nastaliq Urdu and the text engine's other fonts (`resources/textfonts`) | Arabic-script text of every document font (Arial, Times New Roman, Tahoma, Simplified Arabic… — table in [office-rtl.md](office-rtl.md) §3); Hebrew, Thai, Indic, CJK, symbols, emoji | SIL OFL 1.1 |

Document font names are mapped to a font stack (`fonts.ts`: `mapFontFamily` for the Latin face, `mapComplexFamily` for the
Arabic one); the text engine picks, per character, the first font that has it. Characters no bundled font has are drawn
as the font's empty box and produce a warning. PDF embedding of OFL fonts is permitted; subsets are made by HarfBuzz
(`hb-subset`), the font files are not modified. (`office/fontHinting.ts` is kept for its own test; the engine's subsetter
does not need it.)

### Coverage

* **txt / csv** – txt: monospace, wrapped, tabs, form feed = page break, UTF-8/16 BOM or Windows-1252. csv: RFC 4180, delimiter
  auto-detect, header row bold and repeated, auto column widths, right-aligned numbers, landscape when wide, shrink to 60 %.
* **docx** – page size/margins/orientation/columns, sections, headers/footers (default/first/even, `PAGE`/`NUMPAGES`),
  docDefaults + `basedOn` style chains + table styles with conditional formatting, theme fonts/colours, paragraphs and runs
  (bold/italic/underline/strike/colour/size/font/highlight/super-sub/caps), alignment, spacing, line spacing, indents, tab stops
  with leaders, contextual spacing, bullet/numbered/multilevel lists (start overrides, legal numbering), tables (grid widths,
  spans, vertical merges, borders, shading, padding, repeating header rows, rows split across pages, nested tables), inline and
  anchored PNG/JPEG images (crop), hyperlinks as link annotations, complex and simple fields (TOC results kept), page/column
  breaks, footnotes/endnotes (moved to the end, with a note), tracked changes (accepted view), text boxes (in the flow),
  equations (as text).
* **xlsx / ods** – sheets paginated as tables, column widths/row heights (auto height for wrapped text), fonts, fills,
  borders, alignment/wrap/indent/shrink, text spill into empty neighbours, a full number/date **format-code engine**
  (`numfmt.ts`), shared/inline/rich strings, cached formula values, merged cells, hidden rows/columns/sheets, print areas,
  print titles, fit-to-page and scale, paper sizes/orientation/margins, manual breaks, page order, headers/footers
  (`&L &C &R &P &N &D &T &A`, fonts), gridlines, PNG/JPEG pictures, hyperlinks; conditional formatting (cell-value rules,
  colour scales, data bars). Charts/shapes → labelled placeholder + warning.
* **pptx / odp** – one PDF page per slide at slide size, placeholders inheriting from layout and master, theme
  colours/fonts, backgrounds, text boxes with bullets/numbering/autofit, ~30 preset shapes + custom geometry, connectors with
  arrow heads, pictures with crop/flip, groups, rotation, tables. Hidden slides are skipped (with a warning); charts, SmartArt,
  OLE → placeholder + warning; shadows/gradients/3-D → warning.
* **rtf** – full tokenizer (no recursion), code pages and `\uN`, character/paragraph formatting, tabs, borders, stylesheets,
  tables (merges, header rows), lists, sections/headers/footers, fields, pictures (PNG/JPEG), footnotes.
* **odt** – style chains, master pages with headers/footers/fields, lists, tables, images, hyperlinks, footnotes.

Right-to-left and complex scripts (Arabic first): shaped, bidi-ordered, mirrored paragraphs/lists/tables/sheets in every
format — see [office-rtl.md](office-rtl.md) for what is read per format and what is not handled.

Known limits: no charts/SmartArt/OLE/equations rendering, no text wrapping *around* floating images (they get their own
band), no vertical text, no gradients (flat colour), no page borders/watermarks, footnotes at the end of the
document, comments not printed, formulas without cached values show empty (with a warning), en-US number formats only.

### Verification (be aware what this does and does not prove)

* Unit tests build fixtures by hand (Word/Excel/PowerPoint/LibreOffice-style XML) and assert on the produced PDF read back with
  PDF.js: page count and size, text in order, fonts embedded, images present, no text lost on long documents (300+
  paragraphs, 2 000-row sheets, 120-row tables…).
* Comparison tests against **real LibreOffice** (page count + word overlap) exist for docx (files written by LibreOffice),
  xlsx, ods, csv, pptx, rtf, odt; they `skip` when `soffice` is absent. They passed with LibreOffice 26.8 on the dev machine.
* Real-world files (found on the dev machine, compared with LibreOffice 26.8's own PDF; not committed): RTF files written by
  other programs – 10 vs 10, 11 vs 11, 100 vs 101 and 14 vs 13 pages, text overlap 93–99.9 %; docx files written by
  LibreOffice (from those RTFs) – 10 vs 10, 11 vs 11, 14 vs 13 pages; an ODS from LibreOffice’s help – 20 vs 20; xlsx written by
  LibreOffice – 19 vs 20, 1 vs 1. This comparison found and fixed three real problems (rows taller than a page were not split;
  trailing paragraph spacing forced early page breaks; “General” numbers did not fit-to-column).
* Manual spot checks: a multi-page LZW TIFF written by GDI+ (3 pages), real JPEG/PNG written by LibreOffice, PDFs encrypted by
  qpdf (owner-only and user password) are flagged as “password protected or restricted” in Combine.
* Robustness: `officeRobustness.test.ts` feeds truncated, byte-mutated and garbage input to every format (bounded time, presentable
  error) plus a deeply nested RTF and a repeat-count “bomb” ODS.
* **Not verified**: real Microsoft Office documents (none were available); layout fidelity is judged against LibreOffice only.

## 3. Optional LibreOffice engine

Used **only** when LibreOffice is found **and** the user selects it (radio in the Create/Combine dialogs; disabled with
instructions when not found). The built-in engine never depends on it. `create/libreoffice.ts`:

* Discovery: `EPDF_TOOL_SOFFICE` → bundled `resources/bin/<platform>-<arch>/soffice(.exe)` → `PATH` (all through
  `resolveTool('soffice')`), then well-known install locations (Program Files, `/Applications/LibreOffice.app`, `/usr/bin`…).
  `EPDF_DISABLE_SOFFICE_DISCOVERY=1` limits the search to the standard lookup (tests). A missing tool gives a clear
  “needs LibreOffice, which is not installed … install it or switch back to the built-in converter” message.
* Run: `soffice -env:UserInstallation=file:///<private temp profile> --headless --norestore --nolockcheck --nodefault
  --nologo --convert-to pdf --outdir <temp> <temp>/document.<ext>` as an **argument array via `runProcess`** (no shell). The
  input is copied to a neutral name in a private temp folder, so hostile names (`a b; calc.docx`, `--evil`, unicode) never reach
  the command line. 180 s hard timeout, kill on cancel, temp folder removed in a `finally` (retrying on Windows file locks).
  Limitation: on Windows cancel kills `soffice.exe`; a lingering `soffice.bin` can hold the temp profile for a moment.
* Tests use `tests/fixtures/stub-soffice.mjs` (a script selected with `EPDF_TOOL_SOFFICE`; `.js/.mjs` tools run with
  Electron/Node) and the real tool (skipped when absent).
* **Bundling LibreOffice (MPL-2.0) is optional and not done by default.** To ship it, copy the *whole* `program/` tree so that
  `soffice(.exe)` and its libraries are together in `resources/bin/<platform>-<arch>/` (electron-builder’s existing
  `extraResources` copies it to `<resources>/bin`), include LibreOffice’s licence texts and a pointer to its source, and do
  not modify it. Expect ~300–600 MB per platform.

## 4. Combine Files (`combine/merge.ts`, `renderer/features/combine`)

Add files (PDF and everything convertible; non-PDFs are converted first, as jobs), then: **drag rows** to reorder **or**
focus a row’s *Reorder* button and press **Alt+↑ / Alt+↓** (also *Move up/down* buttons; focus is kept, moves are announced in a
live region), per-file **page range** (`1-3, 5, 8-`, validated against the known page count), remove, page count and size shown.
Encrypted or damaged inputs are flagged in the list with the file name and reason and block *Combine* until removed. Result →
Save dialog (`Combined.pdf`) → opens in a tab.

`pdf-lib` merge: `copyPages` keeps page sizes/rotation; **bookmarks**: one bookmark per file (optional) with that file’s own
outline nested below it (named destinations resolved, entries pointing at excluded pages dropped); **internal links** are
re-pointed at the copied pages (links to pages that are not included are removed instead of dragging whole pages along);
**form fields**: widgets’ fields are merged into one AcroForm, clashing top-level names are renamed `name_2`, `name_3`… (listed in
the report), `/DR` fonts merged. Not carried over: document JavaScript, named destinations, page labels, tag structure,
XFA, attachments.

## 5. Command-line verbs (for the Explorer / Finder menu entries – Phase 5 registers them)

```
Epdf --convert-to-pdf <file> [<file>…]   each file → <name>.pdf beside it (unique names), opened in tabs
Epdf --combine <file> [<file>…]          opens the Combine screen with the files (later launches append to it)
```
Parsed in `create/argv.ts`; handled for both the first launch (`process.argv`) and later launches (`second-instance`). The verb and
its files are **removed from argv in place** so the core’s “open PDFs from argv” handling does not also open them as tabs (no
core file was edited; this relies on feature modules loading before `src/main/index.ts` reads `process.argv` and on the
feature’s `second-instance` listener being registered first).

Phase 5 needs: **Windows** – per-extension verbs under `HKCU\Software\Classes\SystemFileAssociations\.<ext>\shell\EpdfConvert\command`
= `"<install>\Epdf.exe" --convert-to-pdf "%1"` (Explorer starts one process per selected file; that is fine, the single-instance
lock forwards each), and `…\EpdfCombine\command` = `"<install>\Epdf.exe" --combine "%1"` (also one launch per file – they
accumulate in one Combine screen; `MultiSelectModel=Player` with several `%1…` arguments is limited to 15 files, an
`IExplorerCommand` handler for the Windows 11 menu has no such limit). Extensions: `docx doc xlsx xls pptx ppt odt ods odp rtf txt csv
jpg jpeg png tif tiff heic heif pdf`. **macOS** – Finder Quick Actions (Automator/Shortcuts, “Run Shell Script”, input =
files) running `/Applications/Epdf.app/Contents/MacOS/Epdf --convert-to-pdf "$@"` (a plain `open -a Epdf --args` does not pass
args to a running instance); `Info.plist` `CFBundleDocumentTypes` for the extra types.

## 6. Export To Word / Excel / PowerPoint (`renderer/features/export`)

File ▸ Export To ▸ … converts the active PDF (including unsaved edits) into an editable Office file. Everything is local:
PDF.js reads text, fonts, colours, rulings, images and links; Epdf’s own OOXML writers (`fflate` zip, no cloud, no copyleft
code) produce the package; a Save dialog picks the destination. The PDF is not modified. **Layout is approximate** (the dialog
says so): Office re-flows text with its own metrics, so line breaks differ, and complex layouts, columns and unusual fonts may
not convert exactly.

* **Word**: paragraphs (lines joined by vertical gaps, indents and line ends; hyphenation removed only when safe), headings from
  relative font size (Heading 1–3), font family/size/bold/italic/colour, left/centre/right/justified alignment, indents, tables
  (ruled grids and aligned columns), inline pictures, external hyperlinks, page size/margins from the text bounding box, a page
  break per PDF page (new section when the page size changes); two-column pages are read column by column.
* **PowerPoint**: one slide per page (slide size = first page size; other sizes scaled), text as positioned text boxes
  (size/font/bold/italic/colour), table cells as shapes, pictures at their positions.
* **Excel**: detected tables become cell grids (numbers stored as numbers: integers, decimals, thousands separators,
  negatives incl. parentheses, percentages, currency; leading-zero codes, phone numbers and dates stay text); option “one sheet
  per detected table” (default; falls back to one per page) or “one sheet per page”.
* Limits: merged cells, wrapped cells in borderless tables, tables with only horizontal rules, footnotes and headers/footers
  (kept as ordinary text), superscripts (may split off their line), RTL/complex scripts, more than 2 columns. Rotated text is
  skipped with a warning; image masks and images over 36 megapixels are skipped with a warning. Scanned PDFs export pictures
  only (warning suggests OCR first). Password-protected PDFs work when they are open in the viewer.
* Verified: strict XML parsing of every part, relationships and content types resolve, text round-trips, and **LibreOffice
  opens and converts all three formats** (unit test, skipped when absent) and the built-in reader converts them back (e2e round
  trip). **Not verified with Microsoft Office.**

## 7. Testing

* Unit (`npm test`): `createImages`, `createMain` (URL validation, argv verbs, LibreOffice args/timeout/cancel/cleanup with the stub,
  HEIC command building and error mapping, pipeline, worker ops), `combineMerge`, `combineReorder`, `office*` (fonts, txt, docx, sheets,
  slides, rtf, odt, hinting, LibreOffice comparisons), `export*` (writers, layout heuristics, extraction with real PDF.js).
* E2E (`tests/e2e/create-export.spec.ts`): create from pictures/TIFF/HEIC (EXIF verified by pixel colour), web pages against a local
  `http.createServer` (404, script on/off, unreachable port, DNS failure, timeout, cancel), the LibreOffice engine with the stub and the
  missing-tool path, cancel of a long conversion with temp-file check, every Office format through the UI, Combine (drag **and**
  keyboard reordering, ranges, encrypted/damaged input, field renaming), command-line verbs (startup and second-instance), export of
  the sample PDF to docx/xlsx/pptx with strict XML validation, the export→convert round trip (also with real LibreOffice), and axe
  scans (light + dark) of every new dialog.
* Environment variables: `EPDF_TOOL_SOFFICE`, `EPDF_DISABLE_SOFFICE_DISCOVERY=1`, `EPDF_WEB_TIMEOUT_MS`, `EPDF_TEST_HEIC=<file>`,
  stub controls `EPDF_STUB_MODE=ok|sleep|fail|nopdf`, `EPDF_STUB_SLEEP_MS`, `EPDF_STUB_LOG`.

Manual checks: (1) Create PDF from a photo taken in portrait on a phone – upright; (2) from a multi-page TIFF scan; (3) from
https://example.com and from a page with scripts, with scripts switched off; (4) from a .docx with a table, a list and an image, then
compare against the original in Word; (5) Combine a PDF, a photo and a .docx, reorder with the mouse and with Alt+arrows using a
screen reader; (6) Export a PDF with headings/table/picture to Word/Excel/PowerPoint and open them in Office; (7) run
`Epdf --convert-to-pdf a.png b.docx` and `Epdf --combine a.pdf b.pdf` from a terminal.

## 8. Dependencies added

| Package | Licence | Where |
|---|---|---|
| `fflate` | MIT | zip read/write (OOXML/ODF packages, PNG deflate) |
| `utif2` | MIT (+ `pako` 1.x, MIT/Zlib) | TIFF decoding |
| `@pdf-lib/fontkit` | MIT | embedding/subsetting the bundled fonts |
| `@xmldom/xmldom` (dev) | MIT | strict XML validation in tests |
| Liberation, Carlito, Caladea, Noto Sans (files) | SIL OFL 1.1 | `resources/fonts` |
