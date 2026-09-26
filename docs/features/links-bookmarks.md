# Links and bookmarks

Two features that share their PDF plumbing: **links** (clickable regions of a page) and **bookmarks** (the document
outline). Everything is written as standard PDF objects, so every reader honours it, and every change is one undo step
through the edit pipeline (`editPdf`). Nothing needs a network, another program or a native binary.

## Links

Tools ribbon, group **Links** (order 600-699): **Add link** and **Edit links**. The Tools menu has the same actions, and
View ▸ Highlight Links toggles an outline around every link on every page.

### Add link

* **Draw a box** on a page (or click for a default-sized box): a dialog asks where the link goes.
  * *A web address, e-mail address or phone number.* Only `http`, `https`, `mailto` and `tel` are accepted;
    `www.example.com` becomes `https://www.example.com/`, `me@example.com` becomes `mailto:`. `javascript:`, `file:`,
    `data:`, `vbscript:`, `ftp:`, custom schemes, addresses with a user name or password, spaces or control characters are
    refused with a reason, and nothing is written.
  * *A page in this document*, opened at: the top of the page (optionally at a zoom), the whole page, the page width, or
    **a spot you click on the page** (an `XYZ` destination; the dialog steps aside while you click, Escape goes back).
  * *A named destination* chosen from the document's own (catalog `/Dests` dictionary or `/Names` name tree). Documents
    without any show why the choice is unavailable. (Creating new named destinations is not implemented.)
  * Appearance: no border (invisible), thin or dashed outline, and a colour. A description (`/Contents`) is optional.
* **Link selected text**: select text on a page (with no tool active, the tool's own catcher would draw instead), then
  Tools ▸ Link from Selected Text (Ctrl/Cmd+Alt+K) or the *Link selected text* button of the Add link tool. One link per
  page; a selection over several lines becomes one link with `/QuadPoints`, one quad per line.
* **Add link on page N** (keyboard route): drops a default box on the visible part of the page and opens the dialog; move
  and resize it afterwards with the Edit links tool and the arrow keys.
* **Find addresses…**: reads the text of every page (exact glyph positions from the content-stream engine), lists web and
  e-mail addresses (Arabic and Hebrew sentences included), and lets you tick the ones to convert. Addresses that already
  have a link are listed as "Already linked" and left unticked. Runs in slices with a progress bar and Cancel; the result
  is one undo step.
* **Remove links from the current page / from the document**: asks first, one undo step. Only link annotations are
  removed.

### Edit links

Click a link (any link, including ones made by other software) to select it: a frame with eight handles appears.

* Drag to move, drag a handle to resize. Keyboard: arrows move by 1 pt (10 pt with Shift), Alt+arrows resize, Enter opens
  the editor, Delete removes, Escape deselects. The "Link" list in the options bar selects any link of the document.
* The editor changes the target, border and colour, and description. Links with a `GoToR`, `Launch`, `JavaScript`,
  `Named`, ... action are shown read-only ("kept exactly as it is") and everything else about them (rect, border,
  delete) still works; their action dictionaries and any unknown keys (`/AA`, vendor keys) are never rewritten.

### What is written

`/Type /Annot /Subtype /Link`, `/Rect` (and `/QuadPoints`), `/Border [0 0 w]` and `/BS`, `/C`, `/F 4` (print), `/M`,
`/NM`, and either `/A << /S /URI /URI (...) >>` (7-bit ASCII, percent-encoded) or `/Dest [page /XYZ x y zoom]` (or
`/Fit`, `/FitH`) or `/Dest (name)`. A visible border also gets a small `/AP` stream so it shows wherever appearance
streams are painted, including Epdf's own viewer. Coordinates are computed from the displayed page, so rotated pages and
CropBox offsets are handled.

Epdf's own viewer (PageView, part of the core) keeps making every link clickable, as before: web and mail links leave the
app through the existing safe opener (only `http`, `https` and `mailto`), page links navigate. `tel:` links are written
correctly and work in other readers; Epdf's opener does not forward `tel:`. A multi-line link (QuadPoints) is clickable
over its whole bounding box in Epdf's viewer (the core layer uses the rect); other readers use the quads.

## Bookmarks

A **left sidebar panel** (icon strip next to Page thumbnails; 288 px wide), toggled by View ▸ Bookmarks Panel
(Ctrl/Cmd+Alt+B). Tools ▸ Add Bookmark Here is Ctrl/Cmd+Alt+D.

* **Tree** (ARIA tree pattern, virtualised, so 5,000+ bookmarks stay responsive): expand/collapse with the chevron or
  ←/→, click or Enter to go to the bookmark (page **and** vertical position of `XYZ`, `FitH`, `FitR`; named
  destinations and `/GoTo` actions are resolved), Up/Down/Home/End, `*` opens all siblings, F2 renames, Delete deletes,
  Alt+Up/Down reorders, Alt+Right/Left nests / un-nests. Drag and drop with a drop indicator: a line above/below for
  before/after, a box for "inside". The bookmark for the page being viewed is marked (`aria-current="location"`, a bar and
  bold text); inside a collapsed branch the nearest visible ancestor is marked. Titles use `dir="auto"` with bidi
  isolation, so Arabic, Hebrew, CJK, emoji and mixed titles display sensibly. The filter ignores case and combining marks
  (tashkeel, niqqud, accents).
* **Add**: for the selected text (its text becomes the title) or the top of the visible part of the current page; it goes
  after the selected bookmark and opens its title for editing. **Rename** inline (Enter saves, Escape cancels, leaving the
  field saves). **Delete** asks when the bookmark has children. **Bold / italic / colour**, **Open by default**
  (`/Count` sign), **Point to current view** (changes the destination), *Open all / Close all by default*, *Delete all*.
* **Generate from headings…** (icon in the panel or Tools menu): analyses the document in a **worker thread** (progress in
  the dialog and jobs tray, Cancel terminates it), then shows a **review list**: untick what is not a heading, promote or
  demote with the arrows, see the confidence (High / Medium / Low with a percentage; reasons are in the tooltip).
  Candidates at or above 55 % are pre-selected. Choose to add after the existing bookmarks or replace them; one undo step.
  Documents without text say so (scanned: run OCR first).

### Heading detection

Pure TypeScript (`src/shared/features/bookmarks/headings.ts`, lines from `src/shared/features/textlines.ts`), fed by the
read-only content-stream engine of the text-edit feature (`features/textedit/pdfcontent`): exact glyph positions, font
size, boldness.

* Body size = the most common size by letter count. Candidates are lines that are larger (≥ 1.1×), bold, numbered
  (`1.`, `1.2.3`, `IV.`, Arabic-Indic digits), start with a chapter word (English, French, Spanish, German, Russian,
  Arabic `الفصل الباب القسم الجزء…`, Hebrew `פרק…`, Chinese `第N章`), are common section titles (Introduction, المقدمة, …), or
  are short ALL-CAPS lines with space around them.
* Discarded: running headers/footers (same text in the top/bottom 10 % of ≥ 25 % of the pages, digits ignored), page
  numbers, table-of-contents lines with dot leaders, figure/table captions, bullets, sentences, text in cover-like first
  pages, lines below 85 % of the body size. A single much larger line on the first page is treated as the document title
  (listed, not pre-selected).
* Wrapped headings are joined. Levels come from numbering depth and from clusters of sizes (bold ranks above regular at
  the same size); levels never jump by more than one. Order follows reading order: pages, then full-width headings split a
  page into bands, columns left to right (right to left on right-to-left pages).
* Right-to-left text stored in visual order (what browsers and most producers write) is reordered to logical order; a
  document-wide vote against known heading patterns detects producers that store logical order.
* Destinations are `/XYZ null <top of the heading> null` on the heading's page.

Measured on the generated fixtures of `tests/unit/lb-headings.test.ts` (English report with cover, header, page numbers,
captions, bullets and footnotes; a harder report with a contents page, wrapped chapter titles, bold table header and pull
quote; bold-only manual; ALL-CAPS headings; prose without headings; two-column paper; Arabic book stored in visual and in
logical order; Chinese report), at the default 55 % threshold: precision 100 %, recall 98.9 % (one missed all-caps
heading), level accuracy 100 % except the contents-page title of the harder report (75 % there). These are synthetic
documents that this feature's author wrote: they show the algorithm does what it is designed to do, not how it does on
every real document. Two real producers are covered in the e2e suite: Chromium's own "print to PDF" of a right-to-left
Arabic book (text stored in visual order as shaped presentation forms, with Persian letter variants; both are undone:
NFKC, and folding of heh/yeh/kaf variants in documents that show Arabic-only letters and no Persian-only ones) and of a
two-column English paper. PDFs from Word, LibreOffice, InDesign or scanners were **not** available for verification.

### What is written

`/Outlines` with `/First /Last /Count`, each item with `/Title` (PDFDocEncoding when possible, UTF-16BE with BOM
otherwise), `/Parent /Prev /Next /First /Last /Count` recomputed on every write, `/Dest [page /XYZ ...]`, `/F` (bold =
2, italic = 1), `/C`. Existing items keep their dictionary: an `/A` action (URI, GoToR, ...), structure elements and
vendor keys survive edits of other items; a named destination keeps pointing through its name. Titles are cleaned:
control characters removed, line breaks become spaces, lone surrogates become U+FFFD, at most 1,000 characters. Titles are
read from PDFDocEncoding, UTF-16BE/LE, UTF-8 with BOM, and PDF 1.7 language escapes.

## Interplay with other features

* The **page organizer** (`src/shared/features/pages`) reorders, deletes and extracts pages with its own outline and link
  helpers. Its `dropDanglingOutline` / `dropDanglingLinks` keep our bookmarks and links valid (unit-tested with our
  writers and PDF.js). Reordering keeps bookmark styles and positions. *Extracting or splitting* rebuilds the outline with
  the page organizer's own writer, which keeps titles, destinations and nesting but not bold/italic/colour (a limitation
  of that helper, not changed here).
* **Encrypted documents**: reading needs the plain bytes, so the panel offers *Unlock to edit bookmarks*, the link tools
  unlock when activated (`ensureEditable`); editing goes through `editPdf`, whose decrypt hook (Security feature) supplies the
  password PDF.js already accepted or asks for it. Save re-encrypts.

## Files

| Path | What |
|---|---|
| `src/shared/features/pdftext.ts` | PDF text strings: encode/decode, sanitising |
| `src/shared/features/destinations.ts` | destination/name-tree resolver shared by links and bookmarks |
| `src/shared/features/textlines.ts` | runs → lines, bidi reordering (used by headings and address detection) |
| `src/shared/features/bookmarks/headings.ts`, `bookmarks.ts` | heading detector, job payload schema |
| `src/main/features/bookmarks/` | job `bookmarks:detect` (worker thread) and menu items |
| `src/main/features/links/` | menu items only |
| `src/renderer/src/features/bookmarks/` | panel, actions, generate dialog; `pdf/` is pure pdf-lib (model, read, write, tree ops, ops, validator, page lines) |
| `src/renderer/src/features/links/` | tools, overlay, dialogs; `pdf/` is pure pdf-lib (address checks, model, read, ops, geometry, detection) |

Outside these folders (core files, smallest possible edits): `PanelDef.width` in `features/api.ts` and
`components/SidePanels.tsx` (a left panel can now ask for a width; the default stays 160 px). With a second left panel the
sidebar shows a switcher, which the core had as `role="tab"` buttons: that made the document tab bar's tests (`getByRole('tab')`)
count them, so the switcher is now a toolbar of toggle buttons (`aria-pressed`) and the panel a labelled region.

## Tests

* Unit (`tests/unit/lb-*.test.ts`): text strings, address validation, link read/write for every target kind, foreign
  actions preserved, rect/QuadPoints maths on rotated pages with CropBox offsets, outline operations verified by
  re-loading with pdf-lib **and** PDF.js `getOutline()`, a strict `/Outlines` validator, Unicode titles, 5,000-item
  outlines, heading precision/recall, address detection, panel view logic, page-organizer interplay.
* End to end (`tests/e2e/links-bookmarks.spec.ts`): add/edit/delete links by mouse and keyboard, text and detected
  links, click-through, panel editing (all operations by mouse and keyboard, drag and drop), generate flow (English,
  Arabic, cancel, empty), Arabic Save/reopen round trip, encrypted documents, 5,000 bookmarks, axe in light and dark.

## Manual test

1. Open a PDF with headings. View ▸ Bookmarks Panel, then the wand icon: review, untick one, Create; Ctrl+Z undoes it.
2. Select the text of a heading, press Ctrl+Alt+D: type a title, Enter. Drag it onto another bookmark; press Alt+Up.
3. Tools ▸ Add Link Tool: draw a box, type `example.com`, Create; Escape, click the link (opens the browser).
4. Tools ▸ Find Web and E-mail Addresses… on a document containing URLs.
5. Save, then open the file in another reader (the bookmarks and links are there).

## Limits

* No context menu on bookmarks; no multi-select.
* Epdf's viewer ignores destination zoom/fit modes when following a link or bookmark (it keeps the user's zoom); the page
  and vertical position are honoured. Other readers honour the zoom written by the link dialog.
* Named destinations cannot be created, only chosen. URL detection needs a scheme, `www.` or an e-mail address (bare
  `example.com` is not guessed); addresses broken across two lines are not joined.
* Heading detection reads upright text in the page's own coordinates: text on pages rotated through `/Rotate`, vertical
  writing and Type 3 fonts without a Unicode mapping are not analysed. Text order of right-to-left lines is a heuristic.
* Reading the outline re-loads the whole file after each edit (fine for typical files; the cost grows with file size).
