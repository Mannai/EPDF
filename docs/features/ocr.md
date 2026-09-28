# OCR: Recognize Text

Tools ▸ **Recognize Text (OCR)…** (command `ocr.run`) turns scanned pages into searchable, selectable, copyable text.
It adds an **invisible text layer** on top of the page: the picture is never touched, and the text is found by search
in Epdf and in other readers (measured: PDF.js, PDFium as in Chrome and Edge, Windows' own PDF engine; right-to-left
scripts included, see "Right-to-left and mixed lines").

Everything runs on this computer, in the app: **no Tesseract, no Python, no cloud service is needed.** The only network
access in all of Epdf is the optional download of extra language packs (see below).

## What the user sees

* A dialog: **Pages** (all / current page / a range such as `1-3, 7, 9-`), **Languages** (multi-select, up to 4),
  **Options** (resolution 150/200/300/400 dpi, improve contrast, straighten tilted pages, recognize pages that already
  contain text, **detect turned pages**). Choices are remembered (`ctx.kv('ocr')`, key `prefs`).
* **Recognize** starts a background job: progress per page and **Cancel** in the jobs tray; the UI never freezes.
* When it is done: a toast "Recognized N pages, M words, average confidence X%." (plus how many pages were found
  turned, were skipped because they already had text, or could not be read) and, if the mean confidence is below 60%,
  a warning.
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
  render at N dpi → grayscale → contrast → deskew → PNG
  [detect turned pages: ──ocr:orientation──► OSD (legacy engine) ──► turned? render again the right way up]
                                     ──ocr:addPage──►  session queue ──► tesseract.js (WASM)
  ◄──────────── words, boxes, baselines, confidence ─────────────────────  (one Tesseract per worker)
  confidence < 75 %?  binarised picture ──ocr:addPage (retry)──► … keep the more confident result
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
  it with `Td`. The font size is Tesseract's line height, the same for all body lines of a page (Tesseract's estimate
  varies from line to line, and readers keep lines of clearly different sizes in separate paragraphs); every word is
  stretched with `Tz` to the box measured in the scan, so selection highlights sit on the words.
* **Words never overlap and spaces fill the gaps.** Tesseract's boxes of neighbouring Arabic words often overlap (final
  letters reach under the next word). Readers order a line's glyphs by position, so each word is shortened to end a
  little before the next one starts, and the space between two words is its own glyph stretched to fill the gap
  exactly: never reaching into the next word, never leaving a hole (a dropped low-confidence word would otherwise
  look like a column gap and split the line).
* **Tilted lines** share one `Tz` per page (PDF.js would otherwise split them), chosen so that 80 % of the words fit
  inside their box (a mean let one oversized speck box push whole lines off the page). Shorter words are spread over
  their box by small moves between their letters (at most 0.08 em and 12 % of a letter: PDF.js and PDFium read larger
  ones as spaces), and gaps are filled with **sized space glyphs**: 36 extra glyphs of the font, from 0.1 to 65 em wide,
  that all map to U+0020. On crooked scans word starts are exact and widths close. All lines of a page within 0.5° of
  the page's median slope get that slope (on a slightly tilted page some lines would otherwise be written straight and
  some tilted, and readers keep lines of different directions apart).
* **Noise is dropped**: words below 15 % confidence; "words" of combining marks only (a speck read as a vowel sign);
  below 60 % confidence, words without a letter or digit and words far smaller than the line's letters; and specks in
  the margin (up to three short words without letters, beyond a gap of more than 2.5 line heights at either end of a
  line: Tesseract adds dust beside a line as "0", "1", "." with fair confidence).
* The layer is a new content stream appended to the page (its own contents are wrapped in `q … Q`). It carries the marker
  `/EpdfOcrLayer true`, so a later run with "force" **replaces** its own earlier layer instead of stacking a second one.
* **Deskew**: the page is rotated against the detected tilt (projection profile, ±8°) before recognition; word boxes are
  mapped back and the text is written along the tilted lines. Tilts below 0.25° are ignored.

### Right-to-left and mixed lines (Arabic, Persian, Urdu, Hebrew)

Tesseract reports every line in **logical** order (the order it is read and typed) with the box of each word. PDF
readers get logical text back from what a page **draws**: PDF.js, PDFium (Chrome, Edge) and Epdf's page text model take
a line's glyphs as they appear from left to right and run the Unicode bidi algorithm (UAX #9) backwards, as for any
producer's output. So the layer draws each line exactly as the scan shows it (`pdf/bidi.ts`):

* the words from left to right **by their boxes** in the scan (the geometry decides, not the language);
* the letters of each word in the order the bidi algorithm displays them, computed over the **whole line** with the
  paragraph direction that reproduces the word order seen in the scan: digits after Arabic letters are Arabic numbers
  (a typed "2026-48" in an Arabic sentence is displayed, and drawn, as 48-2026), Latin words keep their order, a line
  of English with an Arabic phrase is a left-to-right line;
* brackets inside right-to-left runs stored as the shape seen (rule L4, what PDFium and the model read back), combining
  marks before their letter (every reader reverses the run as a whole); marks, ZWNJ and ZWJ have no advance;
* Tesseract's LRM/RLM around left-to-right runs are used for the ordering and then dropped.

**No /ActualText.** It was measured: a line-level or word-level `/ActualText` gives the model the logical text directly,
but PDFium (Chrome, Edge) then returns every such line reversed character by character (it treats ActualText as
visual text and runs its bidi over it), and PDF.js and Windows ignore it. Visual order with correct positions is what
all four readers read best.

**What each reader extracts** (`tests/unit/ocr-rtl.test.ts`, 10 synthetic lines placed as a scan of them would have
their words; the full texts are written to `test-results/ocr-rtl-readers.txt`):

| Reader | Lines read verbatim | Where it differs |
|---|---|---|
| Epdf (page text model: viewer layer, search, copy, redaction, export, library) | 9 / 10 | "Invoice رقم الفاتورة 48213 total": two logical orders display identically; the model returns the one a reader sees ("Invoice 48213 رقم الفاتورة total", see docs/page-text.md) |
| PDF.js (Firefox, many web viewers) | 6 / 10 | drops ZWNJ (all producers); a vowel mark at the start of a word's drawing is attached to the previous word; an English line with an Arabic phrase is read as right-to-left. Word gaps wider than 0.6 em also split a right-to-left line for it (reversed word order) |
| PDFium (Chrome, Edge) | 7 / 10 | its own number rules: "2026-48" read as displayed (48-2026), "PDF 42" as "42 PDF"; the English line reversed |
| Windows (Windows.Data.Pdf search filter, what Windows Search indexes) | 4 / 10 | joins the page into one paragraph; lines with numbers or Latin come out with those runs in visual position. Every word of letters is found |

The layer before this change (words in logical order, letters of each word reversed) gave 8 / 0 / 7 / 4: PDF.js lost
every space between right-to-left words. On real recognition results (below), every probe word (22 to 35 per page) is
found by all four readers.

**Other tools' OCR layers**: the page text model now reads glyphs drawn with a **mirrored** text matrix
(`-1 0 0 1 x y Tm`, upright glyphs advancing leftwards) from their other end. The Internet Archive's OCR PDFs
("Internet Archive PDF 1.4.25; including mupdf") write right-to-left lines that way, in logical order; they used to read
fully reversed and now read in logical order (`src/shared/pagetext/interpret.ts`, regression test in ocr-rtl.test.ts).

## Languages on demand

English is built in. Also offered (from the official `tesseract-ocr/tessdata_fast` repository, pinned to one commit):
German, French, Spanish, Italian, Portuguese, Dutch, Russian, Arabic, **Persian, Urdu, Hebrew**, Chinese (Simplified),
Japanese, Korean, Hindi, and the optional **page orientation data** (`osd`, 10.1 MB, see below). The sizes and SHA-256
of `ara`, `fas`, `urd`, `heb` and `osd` were checked against the files downloaded from the pinned commit (2026-09-28).

`tessdata_best` was measured and is not usable: its models are float LSTMs, and the tesseract.js core Epdf ships aborts on
them ("missing function DotProductSSE"). The fast Arabic *script* model (`script/Arabic`) read the Arabic, Persian and
Urdu test pages worse than the language models (52 / 41 / 14 % of words on the noisy pages) and is not offered.

Downloads (the only network use in Epdf; a job with progress and Cancel):

* the URL is `base + <catalogue code>.traineddata`: the renderer only names a catalogue language, never a URL or a path;
* HTTPS only, at most 3 redirects (each again HTTPS), a size limit (2× the catalogue size, ≥ 16 MB, ≤ 64 MB) checked against
  `Content-Length` and while streaming, an idle timeout;
* the **SHA-256 pinned in the catalogue** (`src/shared/features/ocr.ts`) must match, otherwise the file is discarded;
* written to `<code>.traineddata.part`, renamed into place only after verification (atomic); leftovers are swept at start;
* every pack is verified **again** before each run (a tampered file is refused and named).

Test-only overrides (ignored in packaged builds): `EPDF_OCR_BASE_URL` (a local server, plain HTTP allowed only for
`127.0.0.1`/`localhost`) and `EPDF_OCR_TEST_HASHES` (JSON `{code: sha256}`).

## Page orientation (optional)

**Detect turned pages** (off by default) finds pages scanned sideways or upside down *without* a `/Rotate` entry, with
Tesseract's orientation and script detection (`osd.traineddata`, downloaded on demand like a language, same checks).
It runs on Tesseract's legacy engine (tesseract.js ships it), in its own worker thread started for the run on first
use (`src/main/features/ocr/orientation.ts`, channel `ocr:orientation`). A page found turned with a confidence of at
least 2.5 is drawn again the right way up (PDF.js rotation) and recognized that way; the word boxes are mapped back
through the extra turn (`PageGeometry.turn`), so the invisible text lies over the sideways picture, running the way the
picture's text runs. **The page itself is not rotated**: /Rotate is unchanged. When the option is off nothing changes
and nothing is loaded. Measured: 12 of 12 correct (three fixture pages turned by 0/90/180/270 degrees; confidence 6.8
to 12.1), 0.23 to 0.47 s per 300 dpi A5 page. Pages with too little text get no answer and are recognized as they are.

## Recognition quality (measured)

Real recognition with the catalogue's tessdata_fast data, through the app's own steps (contrast, deskew, the retry on a
binarised picture, the text layer, the page text model), on pages printed with Microsoft Edge in Windows fonts and
degraded like a scan (`tests/fixtures/ocr-rtl`: turned 0.3 to 1.1 degrees, softened, grey paper, sensor noise, dust
specks, JPEG, 300 dpi A5). Word recall = expected words found in the page text model's text; CER = character error
rate of the whole page text, reading order included.

| Page (font) | Noisy scan (committed fixture) | Same page without noise and specks |
|---|---|---|
| Arabic letter with dates, amounts, account number (Arial) | 76 % words, CER 24 % | 98-100 % words, CER 3 % |
| Arabic article, one vocalised line (Times New Roman) | 86 %, CER 14 % | 93-94 %, CER 3.5 % |
| Arabic with English words, e-mail, URL (Segoe UI, ara+eng) | 89 %, CER 11 % | 95-100 %, CER 1-3 % |
| Persian with ZWNJ and Persian digits (Tahoma) | 96 %, CER 11 % | 100 %, CER 0 % |
| Hebrew (Arial) | 100 %, CER 1.4 % | 100 %, CER 0 % |
| Urdu (Arial, Naskh) | see Limits | 100 %, CER 0 % |

Typical errors: the Arabic comma read as « or ",", "17123456" read as "1/7123456", a typed "2026-48" returned as displayed
("48-2026": Tesseract gives digit groups in visual order); on noisy pages letters with similar shapes (ح/ج, ت/ث).
One page of a real scanned Arabic document (WHO EMRO EM/RC48/8, PaperPort) was recognized in the app with every line of
its Arabic title block readable and searchable (e.g. "اللجنة الإقليمية", "البند 10 (د) من جدول الأعمال", "الأصل: بالعربية";
"المتعوسط" for المتوسط, "التدمية" for التنمية); its Latin header is only partly read with Arabic alone.

**Preprocessing** (noisy fixtures, word recall for letter / article / mixed / Persian / Hebrew): grey with contrast
stretch and deskew (the old default) 64 / 69 / 75 / 43 / 100 %; nothing 43 / 67 / 77 / 55 / 93 %; global Otsu
binarisation 86 / 81 / 91 / 90 / 96 %; local (Sauvola) binarisation 76 / 86 / 89 / 96 / 67 %; 3x3 median filter
47 / 86 / 73 / 49 / 100 %. With uneven lighting (a shadow darkening a corner to half) grey and Otsu collapse (23-74 %)
and Sauvola holds (74-100 %). On the noise-free pages binarisation changes nothing much (within a few percent) except
Sauvola on Urdu (62 %). Tesseract's confidence ranks the variants correctly on every page measured, so the app keeps
the grey picture and, **only when a page comes out below 75 % mean confidence**, recognizes it once more from the
Sauvola-binarised picture and keeps the more confident result ("Improve contrast" on; clean scans measured 84-92 % and
are never recognized twice): 76 / 86 / 89 / 96 / 100 %.

**Resolution** (the same noisy pages drawn at lower resolution, grey): 300 dpi 64 / 69 / 75 / 43 / 100 %, 200 dpi
69 / 64 / 66 / 59 / 100 %, 150 dpi 67 / 51 / 61 / 57 / 100 %. 300 dpi stays the recommended default.

**Time**: 0.3 to 0.7 s per A5 page at 300 dpi with one worker on this machine; unsure pages about twice that.

## Limits (honest list)

* Page **orientation** is only detected with "Detect turned pages" and its data downloaded. Pages with a `/Rotate` are
  always handled.
* **Urdu on a noisy page**: Tesseract's Urdu model reads the grain of the noisy fixture as text: hundreds of junk words,
  35 % of the real words in the layer (46 % somewhere in Tesseract's output), and 70 s or more for the one page (the
  retry on the binarised picture, which took as long again, is skipped when the first pass took over 30 s). On the same
  page without noise it is perfect. Clean scans of Urdu work; noisy ones do not.
* Nastaliq Urdu (the usual Urdu typeface) was not tested: the fixture is Naskh (Arial).
* **PDF.js** and other readers: see the table above. The ambiguous cases are inherent in the bidi algorithm; ZWNJ is
  dropped by PDF.js for every producer.
* Layout analysis is Tesseract's: multi-column pages usually work, complex tables/forms may read in an odd order.
  Handwriting is not supported. Vertical Japanese needs `jpn_vert`, which is not offered.
* "Recognize pages that already contain text" (force) replaces the layers *this feature* wrote earlier. A text layer added
  by another program is not removed, so the page then contains both.
* Words below 15% confidence are dropped from the layer; the mean confidence in the toast is over the words kept.
* If the document is edited (any edit, undo, redo) while a run is in progress, the result is refused rather than risking
  text on the wrong page.
* The layer is invisible; there is no "show recognized text" view or manual correction of words.
* Tilted lines: see above (approximate widths).
* Readers measured: Epdf's page text model, PDF.js, PDFium (as WebAssembly, the engine of Chrome and Edge; the
  browsers' own viewers were not driven) and Windows' PDF search filter. Acrobat, macOS Preview and poppler were not
  run. Every word of the real-recognition pages is found by all four; the differences are in whole-line order (table
  above).
* The quality figures come from generated pages (Edge-printed, degraded by a model of a scanner) and one real scanned
  page; real scans of other documents (stamps, tables, handwriting, faded copies) will read worse.

## Manual test

1. `node tests/fixtures/ocr.mjs test-results/fixtures` writes `scan1.pdf` (one scanned page), `scan3.pdf`, `scan-rot90.pdf`,
   `scan-rot270.pdf`, `scan-crop.pdf`, `scan-skew.pdf`, `scan-mixed.pdf`, `scan-many.pdf` (14 pages), and two files with an
   undecodable picture. Open one, Tools ▸ Recognize Text (OCR)…, Recognize.
2. Press Ctrl+F and search for "invoice"; select text on the page with the mouse (the words highlight on the picture).
3. Undo (Ctrl+Z) removes the text for all pages at once. Save, and open the file in another reader to check searching.
4. Cancel from the jobs tray during `scan-many.pdf`; the document must be unchanged.
5. Languages: choose German → the dialog says to download it first → Download shows progress and Cancel. Unplug the
   network first to see the clear error.
6. Arabic: open `tests/fixtures/ocr-rtl/scan-ara-letter.pdf`, download Arabic in the dialog, tick it (untick English),
   Recognize. Ctrl+F "المبلغ" finds two lines; drag across a line from right to left and copy it: the text is in the
   order it is read. `ocr-ara-letter.pdf` in the same folder is that page already recognized (from its noise-free print).
7. Turned pages: tick "Detect turned pages", download its data, and recognize a page scanned sideways (the gated e2e
   test makes one from `scan-ara-letter.pdf`); the toast says the page was found turned.

**Real language data for the tests** (the suite never downloads): put the catalogue's files in a folder and point
`EPDF_OCR_TESSDATA` at it; the real-recognition tests then run instead of skipping.

```powershell
$d = "$env:LOCALAPPDATA\epdf-tessdata"; New-Item -ItemType Directory -Force $d | Out-Null
$base = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/'
foreach ($c in 'ara','fas','urd','heb','osd') { Invoke-WebRequest -UseBasicParsing "$base$c.traineddata" -OutFile "$d\$c.traineddata" }
Get-ChildItem $d | Get-FileHash -Algorithm SHA256   # must match the catalogue (src/shared/features/ocr.ts)
$env:EPDF_OCR_TESSDATA = $d
npx vitest run tests/unit/ocr-rtl-real.test.ts            # add $env:EPDF_OCR_SLOW='1' for the (slow) Urdu page
npx playwright test tests/e2e/ocr-rtl.spec.ts             # after npm run build
```

The measurements of this file come from `test-results/ocr-rtl-real.txt` (written by that test) and
`test-results/ocr-rtl-readers.txt` (ocr-rtl.test.ts). `node tests/fixtures/ocr-rtl/generate.mjs [dir] [--clean]`
regenerates the scans (needs Microsoft Edge; `--clean` writes the noise-free variants, not committed), and
`EPDF_OCR_MAKE_FIXTURES=1 npx vitest run tests/unit/ocr-rtl-fixture.test.ts` remakes `ocr-ara-letter.pdf`.
`powershell -File scripts\ifilter-text.ps1 -Pdf x.pdf` prints what Windows' own PDF engine extracts.

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
* Right-to-left (`tests/unit/ocr-rtl.test.ts`): the visual order of lines (numbers, Latin, brackets, marks, paragraph
  direction from the geometry), word separation, noise and speck filters, one size and slope per page; the layer of 10
  Arabic/Persian/Urdu/Hebrew/mixed lines read back by the page text model, PDF.js, PDFium (`@embedpdf/pdfium`,
  WebAssembly, dev dependency, MIT + BSD/Apache) and Windows' PDF search filter (`scripts/ifilter-text.ps1`; skipped off
  Windows); search hits over each word's box in the scan; redaction of an Arabic word; `/Rotate` 90/180/270, tilted
  lines (model and PDF.js), a dropped word not splitting its line; page orientation (Tesseract's answer, the mapping of
  turned pictures, layers of turned pages); an Internet-Archive-style mirrored OCR layer. `ocr-rtl-real.test.ts`: real
  recognition of the six fixture pages and real orientation detection, skipped without `EPDF_OCR_TESSDATA`.
* E2E (`tests/e2e/ocr-rtl.spec.ts`): the recognized Arabic letter in the viewer (logical text layer, right-to-left mouse
  selection, Copy, find bar with a phrase and a hamza-less query); Persian/Urdu/Hebrew in the dialog; the orientation
  data downloaded from a local stand-in, removed again, with axe (light, dark). With `EPDF_OCR_TESSDATA`: the Arabic data
  downloaded from a local server serving the real file (real hash), a noisy letter recognized, searched and saved; page
  1 of a real WHO EMRO scan (if present on the machine); a sideways scan found turned.
* Packaged (`tests/e2e/ocr-packaged.spec.ts`): skipped unless `EPDF_PACKAGED_EXE` points at a packaged build
  (`npx electron-builder --win --dir --publish never`, then `dist\win-unpacked\Epdf.exe`).
* The scans are generated by `tests/fixtures/ocr.mjs`, which rasterizes text from the bundled Noto Sans outlines in plain
  JavaScript (no canvas, no OS fonts), so they are identical on every machine.
