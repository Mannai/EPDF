# OCR: Recognize Text

Tools ▸ **Recognize Text (OCR)…** (command `ocr.run`) turns scanned pages into searchable, selectable, copyable text.
It adds an **invisible text layer** on top of the page: the picture is never touched, and the text is found by search
in Epdf and in other readers (PDF.js, Chrome, Acrobat, Preview, poppler).

Everything runs on this computer, in the app: **no Tesseract, no Python, no cloud service is needed.** The only network
access in all of Epdf is the optional download of extra language packs (see below).

## What the user sees

* A dialog: **Pages** (all / current page / a range such as `1-3, 7, 9-`), **Languages** (multi-select, up to 4),
  **Options** (resolution 150/200/300/400 dpi, improve contrast, straighten tilted pages, recognize pages that already
  contain text). Choices are remembered (`ctx.kv('ocr')`, key `prefs`).
* **Recognize** starts a background job: progress per page and **Cancel** in the jobs tray; the UI never freezes.
* When it is done: a toast "Recognized N pages, M words, average confidence X%." (plus how many pages were skipped
  because they already had text, or could not be read) and, if the mean confidence is below 60%, a warning.
* The whole run is **one undo step**, "Recognize text". Nothing is written until the user saves.
* Errors are explained: a password-protected document, a damaged language file, a page that cannot be drawn, no text
  found, the document changed while it was being recognized, a download that failed its integrity check.

## Using it from other features

```ts
runCommand('ocr.run')                                       // menu: the dialog for the active document
runCommand('ocr.run', { docId })                            // Scanning: ALL pages of that document now, saved languages/options
runCommand('ocr.run', { docId, dialog: true })              // the dialog for that document
runCommand('ocr.run', { docId, silent: true })              // like { docId } without the success toast
runCommand('ocr.run', { docId, languages: ['deu', 'eng'] })
```

With a `docId` the caller has already asked the user, so there is no dialog unless `dialog: true`. Errors and the
low-confidence warning are always shown. Pages that already have text are skipped unless the saved "recognize pages that
already contain text" option is on. The returned promise resolves when the run has finished.

## How it works

```
renderer (PDF.js)                      main                                   worker threads
─────────────────                      ────                                   ──────────────
ensureEditable(docId)
open a private PDF.js doc from currentBytes
for each selected page (a few in flight):
  skip if it already has text
  render at N dpi → grayscale → contrast → deskew → PNG ──ocr:addPage──►  session queue ──► tesseract.js (WASM)
  ◄──────────── words, boxes, baselines, confidence ─────────────────────  (one Tesseract per worker)
one editPdf('Recognize text') adds all text layers
```

* **Engine**: `tesseract.js` 7 (Apache-2.0) with `tesseract.js-core` (WebAssembly, LSTM engines only). tesseract.js starts
  its own `worker_threads`; the main process only passes messages. Up to `min(4, cores/2)` workers run in parallel
  (`EPDF_OCR_WORKERS` overrides that for tests). The job is `ocr:run`; cancelling it terminates the threads at once.
* **Streaming**: pages are drawn and sent one at a time (`workers + 1` in flight); a 1000-page scan is never in memory
  as a whole. Pictures larger than 30 megapixels (or 14 000 px on a side) are drawn at a lower resolution.
* **Where files live**: `resources/ocr/eng.traineddata` (tessdata_fast, Apache-2.0, 4.1 MB) is shipped with the app
  (`extraResources` → `<resources>/ocr`); other packs are in `userData/ocr-languages/`. Each run copies the verified
  packs into a per-run temp folder that is deleted afterwards (also on cancel and on errors).
* **Packaged build**: `tesseract.js`, `tesseract.js-core` and the few modules the worker script requires are unpacked from
  the asar (`asarUnpack`) because tesseract.js starts its worker from a file path and the WASM core is read from disk.
  All six WebAssembly cores are shipped (tesseract.js 7 picks one by CPU features, and asks for the non-LSTM build even
  for LSTM-only data); the browser-only `.wasm.js` copies with the WebAssembly embedded as base64 are excluded (~25 MB).

### The text layer

* Words are drawn with **text render mode 3** (`3 Tr`: neither filled nor stroked) in a **glyphless Type0 font**
  (Identity-H, CIDFontType2, an embedded TrueType program whose glyphs are all empty but have real advance widths) with a
  **ToUnicode CMap**. So any script (Latin, Cyrillic, Greek, Arabic, Devanagari, CJK, ...) is extractable without shipping
  a font that covers it, and the layer costs a few KB. PDF.js extraction of Latin (with umlauts), Cyrillic, Greek, CJK,
  Kana, Hangul, Arabic and Devanagari text is covered by unit tests (synthetic words), and real recognition of English +
  Russian text with the downloaded `rus` pack was checked once by hand (not part of the suite, which never downloads
  real packs). Ligature characters are spelled out (`ﬁ` → `fi`).
* **Placement**: word boxes → PDF user space for every `/Rotate`, for MediaBox origins ≠ 0 and CropBoxes (the picture is
  drawn by PDF.js, so the mapping uses the same visible box and rotation), with the text matrix rotated to the reading
  direction. Each line is one text matrix (readers treat a change of matrix as a new line) and its words are moved along
  it with `Td`. The font size is Tesseract's line height; every word is stretched with `Tz` to the box measured in the
  scan, so selection highlights sit on the words. Tilted lines share one `Tz` per page (PDF.js would otherwise split
  them), so on crooked scans word *starts* are exact and word *widths* approximate.
* **Right-to-left** words are stored in visual order (Tesseract reports logical order; readers run the bidi algorithm).
* The layer is a new content stream appended to the page (its own contents are wrapped in `q … Q`). It carries the marker
  `/EpdfOcrLayer true`, so a later run with "force" **replaces** its own earlier layer instead of stacking a second one.
* **Deskew**: the page is rotated against the detected tilt (projection profile, ±8°) before recognition; word boxes are
  mapped back and the text is written along the tilted lines. Tilts below 0.25° are ignored.

## Languages on demand

English is built in. Also offered (from the official `tesseract-ocr/tessdata_fast` repository, pinned to one commit):
German, French, Spanish, Italian, Portuguese, Dutch, Russian, Arabic, Chinese (Simplified), Japanese, Korean, Hindi.

Downloads (the only network use in Epdf; a job with progress and Cancel):

* the URL is `base + <catalogue code>.traineddata`: the renderer only names a catalogue language, never a URL or a path;
* HTTPS only, at most 3 redirects (each again HTTPS), a size limit (2× the catalogue size, ≥ 16 MB, ≤ 64 MB) checked against
  `Content-Length` and while streaming, an idle timeout;
* the **SHA-256 pinned in the catalogue** (`src/shared/features/ocr.ts`) must match, otherwise the file is discarded;
* written to `<code>.traineddata.part`, renamed into place only after verification (atomic); leftovers are swept at start;
* every pack is verified **again** before each run (a tampered file is refused and named).

Test-only overrides (ignored in packaged builds): `EPDF_OCR_BASE_URL` (a local server, plain HTTP allowed only for
`127.0.0.1`/`localhost`) and `EPDF_OCR_TEST_HASHES` (JSON `{code: sha256}`).

## Limits (honest list)

* Page **orientation** is not detected: a page that is scanned sideways or upside down *without* a `/Rotate` entry is
  recognized poorly (Tesseract's orientation model `osd` is not bundled). Pages with a `/Rotate` are handled.
* Layout analysis is Tesseract's: multi-column pages usually work, complex tables/forms may read in an odd order.
  Handwriting is not supported. Vertical Japanese needs `jpn_vert`, which is not offered.
* "Recognize pages that already contain text" (force) replaces the layers *this feature* wrote earlier. A text layer added
  by another program is not removed, so the page then contains both.
* Words below 15% confidence are dropped from the layer; the mean confidence in the toast is over the words kept.
* If the document is edited (any edit, undo, redo) while a run is in progress, the result is refused rather than risking
  text on the wrong page.
* The layer is invisible; there is no "show recognized text" view or manual correction of words.
* Tilted lines: see above (approximate widths). Other readers than PDF.js were not available for testing here.

## Manual test

1. `node tests/fixtures/ocr.mjs test-results/fixtures` writes `scan1.pdf` (one scanned page), `scan3.pdf`, `scan-rot90.pdf`,
   `scan-rot270.pdf`, `scan-crop.pdf`, `scan-skew.pdf`, `scan-mixed.pdf`, `scan-many.pdf` (14 pages), and two files with an
   undecodable picture. Open one, Tools ▸ Recognize Text (OCR)…, Recognize.
2. Press Ctrl+F and search for "invoice"; select text on the page with the mouse (the words highlight on the picture).
3. Undo (Ctrl+Z) removes the text for all pages at once. Save, and open the file in another reader to check searching.
4. Cancel from the jobs tray during `scan-many.pdf`; the document must be unchanged.
5. Languages: choose German → the dialog says to download it first → Download shows progress and Cancel. Unplug the
   network first to see the clear error.

## Tests

* Unit (`tests/unit/ocr-*.test.ts`): layout math for all `/Rotate` values, CropBox offsets, tilt and deskew; ToUnicode CMap,
  glyphless font structure and checksums; content-stream generation; text layer read back with PDF.js for Latin, Cyrillic,
  Greek, CJK, Hangul, Arabic, Devanagari and ligatures; page/line grouping in PDF.js output; catalogue and hash checks;
  the download state machine against a local `http.createServer` (mismatch, redirects, size limits, cancel, timeouts);
  real recognition with the bundled engine (cancel, progress, failed pages); skew detection; the renderer flow with fakes
  (encrypted, cancel, skip, force, failures, concurrent edits).
* E2E (`tests/e2e/ocr.spec.ts`): the full UI on generated scans (see above), including saved-file verification, undo/redo,
  cancel, progress, skipping pages with text, rotated/cropped/crooked scans, language download from a local server (with a
  hash mismatch and a cancel), airplane mode, an encrypted document, a damaged language file, channel validation, memory
  on a long scan, axe (light and dark) and keyboard use.
* Packaged (`tests/e2e/ocr-packaged.spec.ts`): skipped unless `EPDF_PACKAGED_EXE` points at a packaged build
  (`npx electron-builder --win --dir --publish never`, then `dist\win-unpacked\Epdf.exe`).
* The scans are generated by `tests/fixtures/ocr.mjs`, which rasterizes text from the bundled Noto Sans outlines in plain
  JavaScript (no canvas, no OS fonts), so they are identical on every machine.
