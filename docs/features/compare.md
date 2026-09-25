# Compare files

Compares two versions of a document and shows every difference: a **side-by-side** view of the old and the new
pages with the changed words highlighted, a **summary list** of all changes (added / removed / modified / moved),
**next/previous change** navigation, an optional **visual (pixel) comparison** for pictures and graphics, and
**exports** of the result as a PDF report and as CSV. Nothing in the document is modified (comparison never uses the
edit pipeline) and everything is computed locally.

Code: `src/renderer/src/features/compare/` (UI, extraction, workers) with the engine in `diff/` (pure TypeScript: no
`pdfjs-dist`, no DOM, runs in Node and in a Web Worker); `src/main/features/compare/` (native file picker and report
saving); `src/shared/features/compare.ts` (channel payload schemas).

## Using it

**Tools ▸ Compare Files…** (command `compare.open`) opens a full-tab view for the active document.

1. **Choose** the two versions. The open document is the **New** version; pick the **Old** version with
   **Choose file…** (a native open dialog: the renderer only ever receives the bytes, never a path) or from **open
   tab** (every open document, including background tabs). **Swap** exchanges old and new. Options: *ignore case*,
   *ignore punctuation*, *ignore spacing* (compares letter by letter, so different word spacing or line breaks are
   not differences).
2. **Compare** reads the text of both documents page by page with a progress bar (page counter, **Cancel**), then
   runs the comparison in a worker. A password-protected or damaged input gives a clear message
   (a password prompt is offered first; declining it gives *“…” is password protected and no password was given*).
3. **Results**
   * **Side by side**: one scroller with one aligned row per page pair - Old on the left, New on the right - so
     scrolling, zoom and page position are synchronised by construction. Pages that exist on one side only show a
     dashed placeholder. Zoom out / in / Fit width; *Only pages with changes*. Highlights are drawn from the words'
     real geometry: **removed** (red, struck through) on Old, **added** (green, underlined) on New, **modified**
     (yellow, double underline, the changed characters inside the word marked separately) on both, **moved**
     (blue, dashed frame) on both. Every highlight carries a symbol badge (− + ~ ↔), so colour is never the only cue.
     Clicking a highlight selects that change.
   * **Summary list** (right side): kind checkboxes with counts, *Page* filter with the number of changes per page,
     *Search in changes*, then one entry per change with old → new text (character-level marks inside modified words).
     Click (or ↑/↓ + Enter/Space) to jump to it: both panes scroll to it and it flashes.
   * **Next / Previous change**: **F8** / **Shift+F8** or the ↓ / ↑ buttons; the counter reads “Change 5 of 42” (of the
     filtered list) and a live region announces “Change 5 of 42. Modified on page 3: “100” to “200”.” Navigation wraps.
   * **Visual differences**: renders both pages of a pair at the same scale and compares the pixels in a worker.
     Differences are painted magenta on a faded copy of the new page and framed with dashed outlines; a
     *Sensitivity* slider sets how small a colour change still counts; *Differences / Old page / New page* flips the
     view. **Scan all pages** finds every page pair that differs visually (it runs by itself when there are no text
     differences and up to 100 page pairs). The verdict line then reads e.g. *No text differences, but 1 page
     differs visually.*
   * **Export**: **Export report (PDF)…** (changes listed by page, kind words `[~] MODIFIED` etc.) and **Export
     changes (CSV)…** (UTF-8 with BOM, columns Change, Type, Old page, New page, Old text, New text, Note; cells that
     start with `= + @` or `-` are prefixed with `'` so spreadsheets do not execute them). Both go through a native
     save dialog in main which writes the bytes; the renderer never supplies a path.
   * **New comparison…** returns to step 1. Results survive switching tabs; if the open document is edited
     afterwards a banner offers **Compare again**.

Keyboard: every control is a button/checkbox/select; the panes region and the change list are focusable (arrow
keys, PageUp/PageDown, Home/End). There are no bare-letter shortcuts.

## How it works

* **Extraction** (`extract.ts`): PDF.js `getTextContent` per page; every run becomes an axis-aligned box in the
  displayed page (rotation applied) with its baseline direction. `extractDocument` streams page by page, yields to
  the event loop, reports progress and stops on cancel; a page PDF.js cannot read counts as empty.
* **Normalisation and tokens** (`diff/normalize.ts`): NFKC per character cluster (ligatures fi/ffi, full-width
  forms, decomposed accents), every space kind → one space, typographic quotes and dashes → ASCII, zero-width and
  bidi controls dropped; tokens are words (with inner `. , ' / :` so `1,234.50`, `don't`, `12/03/2024` stay whole),
  single ideographs, or single punctuation marks. Case / punctuation / spacing modes change the comparison keys.
  Words hyphenated at a line end (`exam-` / `ple`) are joined; the joined word keeps one rectangle per line.
* **Reading order** (`diff/layout.ts`): recursive XY-cut - split at vertical gutters no run crosses (columns), else
  at the widest horizontal gap (blocks), read leaves as lines. Columns are never interleaved. Each text direction
  (0/90/180/270°) is read in its own frame, so a rotated page reads like the unrotated one; text in a minority
  direction (a margin stamp) is read last.
* **Word geometry** (`diff/words.ts`): a run's width is shared among its characters in proportion to Helvetica's
  advance widths (exact for Helvetica-like fonts, a close approximation otherwise), so a word's box is its true
  position on the page.
* **Page alignment** (`diff/align.ts`): word-trigram fingerprints, an inverted index (repeated headers/footers are
  ignored), the heaviest in-order chain of similar pages as anchors, leftover similar pages as **moved** pages, and an
  order-preserving pairing of what is left between two anchors (a rewritten page) - otherwise a page is added or
  removed. Duplicated pages pair one-to-one in order; blank pages pair with blank pages.
* **Diff** (`diff/myers.ts`, `diff/pageDiff.ts`): Myers' O(ND) algorithm in linear space (minimal edit script,
  property-tested against an LCS reference), hunks slid to their canonical position; changes separated by one
  unchanged word are merged. A replacement is **modified** when old and new text are alike (bigram Dice ≥ 0.35) or
  both are at most two words, otherwise a removal plus an addition. `charDiff.ts` gives the character marks.
* **Moves** (`diff/moves.ts`): removed and added chunks of ≥ 4 words that hold the same (or, for ≥ 6 words, almost
  the same, marked *edited*) text are paired as one **moved** change, also across pages.
* **Engine** (`diff/engine.ts`) runs alignment → per-pair diff → moves → ordering; it works on comparison keys only
  and runs in `engine.worker.ts`. Pixel maths (`diff/pixel.ts`) runs in `pixel.worker.ts`.
* **Memory**: pages are stored as typed arrays (`PageModel`); only the visible rows of the side-by-side view are
  mounted and rendered (canvases are released when a row leaves the window); the visual scan holds one page pair
  at a time.

## Limits (be aware)

* Only text PDF.js can extract is compared. Scanned pages without a text layer show no text differences (the visual
  comparison still works; run OCR first for text).
* Reading order is a heuristic. Tables are read column by column, and a page whose layout changes a lot between
  versions may report moved blocks instead of edits. A two-column page with paragraph gaps that line up exactly
  can be read in interleaved blocks.
* Hyphenation is undone only for `letters-` at a line end followed by a lowercase word; a genuinely hyphenated
  compound broken at the same place (`well-` / `known`) is also joined.
* Diagonal text is treated as the nearest quarter turn. Per-character positions inside a run are proportional
  estimates, so the box of a word inside a long run can be off by a fraction of a character for non-Helvetica fonts.
* The PDF report uses Helvetica, and Noto Sans (the font bundled for forms) for Cyrillic/Greek/Vietnamese text;
  characters neither font has (CJK, Arabic, …) print as `?` in the report (the CSV keeps them). Entries longer
  than 700 characters are shortened in the PDF report (the CSV has the full text).
* The visual comparison renders at 72 dpi for the whole-document scan and 108 dpi for the overlay. Nothing is
  masked out: a different page size shows as a difference at the page edge, and annotations are compared as part of
  the rendered page. Tiny anti-aliasing shifts below the *Sensitivity* setting (and fewer than 12 differing pixels)
  are not reported.
* Changes are numbered and ordered by new-version page and position; a removal is placed at the point it was
  removed. The *Page* filter uses the new page number (the old number for removed text).

## Testing

* Unit (`tests/unit/compare-*.test.ts`): tokenizer/normalisation, hyphenation, reading order incl. rotation, Myers vs
  an LCS reference on thousands of random inputs, classification, page alignment (insert / delete / move /
  duplicate / blank), move detection, highlight geometry, pixel maths, report/CSV, and the whole pipeline against a
  real PDF.js (`compare-pdfjs.test.ts`) on the fixture pair.
* E2E (`tests/e2e/compare.spec.ts`, fixtures built by `tests/support/compareFixtures.ts`): exact counts, jumping and
  DOM geometry of the highlights, F8 navigation, swap, open-tab picker, identical files, visual-only difference and
  slider, encrypted/damaged input, 500-page compare with cancel and windowing, report and CSV re-loaded, Cyrillic,
  options, tab switching, out-of-date banner, axe scans in light and dark.

Manual: open `test-results/fixtures/cmp-report-new.pdf`, **Tools ▸ Compare Files…**, choose `cmp-report-old.pdf` as
Old, **Compare** → 8 changes (3 modified, 2 removed, 2 added, 1 moved); press F8 through them; try
`cmp-visual-old.pdf` / `cmp-visual-new.pdf` (identical text, different picture) and the **Visual differences** view.
(Run `npx playwright test tests/e2e/compare.spec.ts` once to generate the fixtures.)
