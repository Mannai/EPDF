# The page text model (`src/shared/pagetext`)

Logical-order text of **existing** PDF pages, with per-character geometry, for any producer. It is what Epdf uses to
select, copy and search right-to-left and complex-script text (Arabic, Persian, Urdu, Hebrew, Indic, ...), and what
compare, export, the library, redaction and links/bookmarks read those pages with.

PDF.js `getTextContent()` is fine for Latin text but garbles Arabic from most producers: a LibreOffice export of
`مرحبا بالعالم` comes out as `العالم ب ا بمرح`, numbers and brackets inside Arabic lines are misordered
(`Epdf( 26-09-2026)`), vocalised text gets stray spaces, and PDF.js ignores `/ActualText`. The page text model reads
the page content itself and recovers the text as it was typed.

Contents: [API](#api) · [Pipeline](#pipeline) · [Where the app uses it](#app) · [Verification](#verification) ·
[Performance](#performance) · [Limits](#limits) · [Files](#files)

<a id="api"></a>
## API

```ts
import { buildPageText, rangeBoxes, rangeQuads, modelIsUsable, needsPageModel } from '@shared/pagetext'

const model = buildPageText(pdfLibDocument, pageIndex)   // PageTextModel (plain data, structured-cloneable)
model.text                        // logical text: lines in reading order, '\n' between lines
model.lines[i]                    // { start, end, dir: 'ltr'|'rtl', angle, size, baseline, font, bold, italic,
                                  //   x0, y0, x1, y1, block, exact, words: [start, end, ...] }
model.charQuad[k], model.quads    // the glyph quad of character k (8 floats, display space), -1 for line breaks
rangeBoxes(model, a, b)           // axis-aligned boxes of characters [a, b): one per visually contiguous stretch
rangeQuads(model, a, b)           // the same as rotated quads (rotated text)
model.transform                   // user space -> display space (invert it for annotations / redaction marks)
needsPageModel(pdfjsText)         // does this page contain RTL/complex text (worth reading with the model)?
modelIsUsable(model, pdfjsText)   // quality gate: fonts decoded, no text lost compared with PDF.js
```

Geometry is in **display space**: points, origin top-left of the page as shown (CropBox ∩ MediaBox, `/Rotate`
applied, y down), exactly a PDF.js viewport at scale 1 (unit-tested for all four rotations). Multiply by the zoom for
CSS pixels.

Also exported: `interpretPage` (glyphs with geometry, ActualText spans), `visualToLogicalOrder` /
`visualToLogicalText` (the reordering on its own), `normalizeGlyphText`, `hasComplexScript`, `hasRtlChar`.

Renderer side (`src/renderer/src/pdf/pagetext/`): `pageText(pdfjsDoc, pageNo)` returns the text the app uses for a
page (`{ kind: 'pdfjs', text, itemStarts }` or `{ kind: 'model', text, model }`), `pageModel(pdfjsDoc, pageNo)`, and
`renderModelTextLayer(container, model)`. Models are built in a Web Worker from the bytes PDF.js has (`getData()`),
with an in-thread fallback when no worker is available (Node tests).

<a id="pipeline"></a>
## Pipeline

1. **Glyphs** (`interpret.ts`): a content-stream interpreter (text state, `Tm`/`Td`/`TJ`/`Tz`/`Ts`/`Tc`/`Tw`, `'`
   `"`, CTM, Form XObjects, `gs` fonts) records every glyph: Unicode text, origin, advance, box, font, render mode,
   stream order. Marked content: `/ActualText` from inline dictionaries and `/Properties` resources (UTF-16/UTF-8/
   PDFDocEncoding), nested spans (the outermost wins), spans enclosing a form; `/ReversedChars`. Tolerant: an
   unreadable stream keeps what parsed before the error.
2. **Unicode** (`fonts.ts`, `glyphnames.ts`, `sfnt.ts`): `/ToUnicode` first, then the encoding (base encodings,
   `/Differences` glyph names with an extended glyph list: AGL, `afii57xxx`, `alefarabic`, `beh-ar.init`,
   `lam_alef-ar`, `uniXXXX`), Unicode CMaps (`Uni*-UCS2/UTF16`), then the embedded font program (its Unicode cmap in
   reverse, glyph names from `post`). Arabic/Hebrew/Latin presentation forms and ligatures become base letters
   (NFKC on U+FB00-FDFF, U+FE70-FEFF only). Fonts that cannot be decoded (predefined non-Unicode CMaps without
   `/ToUnicode`) are flagged, and such pages keep PDF.js text.
3. **Lines** (`build.ts`): base glyphs are grouped by baseline direction (any angle; vertical writing advances
   downwards) and baseline offset, then split at column gaps (wide gaps, or medium gaps between glyphs drawn far
   apart in the stream). Duplicated glyphs (fake bold) count once.
4. **Marks**: zero-width glyphs and glyphs whose text is only combining marks (harakat, niqqud, matras) attach to the
   base glyph they sit on: first by the producer's `/ActualText` span when it names one base glyph, else by geometry
   (ink box from the font program, else the origin; boundary cases resolved by script direction). Never by stream
   order.
5. **Units**: one per base glyph (+ marks), or one per `/ActualText` span, whose text replaces the glyphs' and is
   aligned back to them (LCS on the visual order the span text would have, then an order-free pass for characters
   drawn out of order such as Indic pre-base vowel signs) so every character keeps a glyph box. Spaces are inserted
   where the gap exceeds 0.16 em.
6. **Logical order** (`visual.ts`), per line, with the paragraph direction of the line (strong-letter majority; lines
   without one take their block's). See the header of `visual.ts`: candidates from the UBA run on the visual string
   and two other starting points, each verified by running the UBA forwards and refined to a fixed point, plus a
   neighbourhood search over neutral runs, bracket pairs and digit runs. A reading is accepted only if it displays
   exactly like the page. Several readings can display identically (the UBA is not injective): they are ranked by
   bracket balance, intact numbers, stream order (when informative) and simplicity. Brackets stored as typed
   characters (LibreOffice, Skia, our engine) and as drawn shapes (legacy producers) are both handled. A line that no
   logical text can display (a producer that ignored the UBA) falls back to "reverse, keep left-to-right runs" and is
   flagged `exact: false`. Indic pre-base vowel signs found before their consonant move after it.
7. **Blocks and reading order**: consecutive lines close in baseline and overlapping become a block; blocks are
   ordered by recursive XY cut (bands top to bottom, columns right to left on right-to-left pages).
8. **Output**: text, one quad per character (ligature glyphs are divided among their characters, right to left in
   right-to-left runs), word boundaries (Intl.Segmenter), line metadata.

Comparison normalisation used by the tests: NFC (canonical order of combining marks) and collapsed whitespace. The
model's text is NFC per glyph cluster.

<a id="app"></a>
## Where the app uses it

| Place | What happens |
|---|---|
| Viewer text layer (`viewer/PageView.tsx`, `pdf/pagetext/textLayer.ts`) | Pages whose PDF.js text contains RTL/complex characters get, once the model is ready (usually well under a second), a text layer built from the model: DOM in logical order (one span per word or space, `<br>` per line), each span on its glyphs (PDF.js's own `.textLayer` CSS, `--font-height` / `--scale-x` / `--rotate`, % positions, so it follows the zoom). Selection, Copy, markup highlights and redaction-by-selection read it. Other pages keep PDF.js's layer. |
| Find bar (`pdf/search.ts`) | `findInText`: the text engine's `normalizeForSearch` on the page text (model text on model pages): tashkeel and Quranic marks, tatweel, alef/yeh/Persian variants, presentation forms, Arabic-Indic and Persian digits, Hebrew points, case folding; mapped back to the original text. Hits on model pages are drawn from the model's glyph boxes. Latin: case, whole word, whitespace and metacharacter behaviour unchanged; ligatures, full-width forms and ß now also match. |
| Compare (`features/compare/extract.ts`, `modelWords.ts`) | Model pages are tokenised from the model's logical lines (the geometric line builder would put RTL words back in visual order). |
| Export (`features/export/extract.ts`) | Model pages give one text item per logical line; Word export writes right-to-left paragraphs with `<w:bidi/>` and runs with `<w:rtl/>`. |
| Library index (`main/features/library/extract.ts`) | Pages with RTL/complex PDF.js text are indexed with the model's text (pdf-lib parses the file lazily, once). |
| Redaction (`features/redact/logic/search.ts`, `verify.ts`) | Search-to-redact finds words in the logical text; the self-check additionally reads those pages in logical order (a leak = an occurrence whose glyphs lie under a mark). |
| Links / bookmarks (`features/bookmarks/pdf/pageLines.ts`, `shared/features/textlines.ts`) | Heading detection and address detection read every page through the model; `visualToLogical` there now uses the model's verified reordering. |
| OCR "page already has text" (`features/ocr/render.ts`) | Unchanged: it only counts characters, which is independent of their order. |
| Redaction's PDF.js reader (`features/redact/pdfjsText.ts`) | Kept as the independent PDF.js reader of the self-check (what other software extracts); the model is added as a second reader, not a replacement. |

<a id="verification"></a>
## Verification

Ground truth: `tests/fixtures/pagetext/corpus.json` (logical source strings). Fixtures (committed, regenerated with
`node tests/fixtures/pagetext/generate.mjs`): LibreOffice (HTML → `writer_web_pdf_Export`: lines, wrapped
paragraphs, two RTL columns, the page with `/Rotate 270`), Chromium `printToPDF` (Skia: lines, paragraphs, columns,
CSS-rotated text, plus Chromium's own box of every word), the text engine (lines, paragraphs, columns, rotated text,
`/Rotate 90`), pdf-lib drawing pre-shaped presentation forms glyph by glyph in visual order (with and without
`/ToUnicode`).

| Test | What |
|---|---|
| `pagetext-producers.test.ts` | every fixture: extracted lines equal the source lines exactly (after NFC + whitespace), every line inverted exactly, no undecoded glyphs; what PDF.js makes of the same files is printed |
| `pagetext-bidi.test.ts` | the official BidiCharacterTest sample read backwards (2,619 cases, all valid, 96.8 % original recovered); 6,000 generated mixed sentences (all valid; original recovered 92 % RTL, 75 % LTR-with-Arabic; the rest are genuine UBA ambiguities); the bug-report cases |
| `pagetext-geometry.test.ts` | the model's box of all 191 words vs Chromium's own layout boxes: within 0.01 pt; display space = PDF.js viewport for every rotation |
| `pagetext-fonts.test.ts` | glyph names, Type 3, Unicode/predefined CMaps, vertical writing, nested and `/Properties` ActualText, ActualText across a form, marks by geometry, gaps → spaces, invisible text, fake bold |
| `pagetext-search.test.ts` | search normalisation (Latin unchanged; Arabic, Persian, Hebrew variants) and every corpus query on three producers, hit boxes inside Chromium's word boxes |
| `pagetext-features.test.ts` | compare (LibreOffice vs Chromium of the same text: 0 changes, 11 with PDF.js text), Word export (logical text in bidi paragraphs), library index, redaction search/apply/self-check, links/bookmarks lines |
| `pagetext-perf.test.ts` | throughput (below) |
| `tests/e2e/pagetext.spec.ts` | the real app: mouse selection of each line and Copy give the logical line (LibreOffice: Arabic plain/vocalised/dates/Arabic-Indic digits/punctuation/Latin inside, Persian, Urdu, Hebrew with and without niqqud, LTR with Arabic); text layers of Chromium, engine, rotated pages, legacy presentation forms, two columns, rotated text; find bar hits checked against Chromium's word boxes and, on LibreOffice, against the line and the rendered ink; the library finds logical Arabic words; a 500-page Latin document keeps PDF.js's layer (timings logged) |

PDF.js on the same fixtures finds, verbatim, 3/16 LibreOffice lines, 2/16 Chromium lines, 14/16 engine lines and
0/6 legacy presentation-form lines; the model reads all of them.

<a id="performance"></a>
## Performance

Measured on the development machine.

| Measurement | This branch | main (same machine, same test) |
|---|---|---|
| 500-page Latin `large.pdf`: launch → first page painted | 721 / 732 / 733 ms | 714 / 717 / 776 ms |
| … scroll 60 pages (one page per frame) until page 61's text layer | 1071 / 1074 / 1076 ms | 1072 / 1074 / 1076 ms |
| … whole-document search | 829 / 831 / 839 ms | 832 / 833 / 835 ms |
| 300-page Arabic PDF (LibreOffice pages, 17.7 MB): page 1 painted | ~1.25 s after launch | (no logical layer) |
| … its logical text layer ready (pdf-lib parses the file in the worker) | ~1.6 s after launch | |
| … page 200: logical layer after going there | ~0.2 s | |
| Node, model build, Latin (45 lines × 13 words) | ~3.7 ms/page (the links/bookmarks reader it replaced: ~2.3) | |
| Node, model build, LibreOffice Arabic pages | ~12 ms/page | |

(`tests/e2e/pagetext.spec.ts` logs the app timings; the main column was measured by building this branch with
main's `PageView.tsx` and `pdf/search.ts` swapped in.) In the viewer Latin pages never build a model: the only added
work is a regex scan of the PDF.js text, which is fetched once as before. The worker keeps at most three parsed
documents.

<a id="limits"></a>
## Limits and what is not verified

- **Other readers** (Acrobat, pdfium, poppler, macOS Preview) were not run; the model is checked against source text,
  PDF.js's viewport and Chromium's layout.
- **Heuristics**: line grouping (baseline tolerance 0.4 em), column splitting (gaps ≥ 1.25 em, or ≥ 0.5 em with a
  stream jump), spaces from gaps (0.16 em), block grouping and XY-cut reading order, paragraph direction by
  strong-letter majority, mark attachment without a font program, the ranking of ambiguous bidi readings. Tables,
  sidebars and complex magazine layouts may be read in a different order than a human would.
- **Ambiguity**: when several logical texts display identically, the chosen one can differ from what was typed
  (e.g. `42 PDF` vs `PDF 42` next to Arabic in a visual-order file). Files with `/ActualText` (our engine,
  LibreOffice, Skia per cluster) avoid most of it.
- **Fonts without `/ToUnicode`** whose glyphs are pieces of letters (a shaper decomposed them into dotless skeletons
  and dots, as pdf-lib/fontkit does with Noto) cannot be read: the pieces have no Unicode. Subset fonts without
  cmap or glyph names are unreadable and reported (`stats.unknown`); such pages keep PDF.js text. A glyph shared by
  Arabic and Persian yeh (same shape in the middle of a word) is read as Arabic yeh.
- **Type 3 fonts**: decoded from `/Differences` names only; glyph boxes from `FontBBox`/`FontMatrix` approximations.
- **Vertical writing**: basic support (Identity-V advances, one column = one line, columns right to left); not
  tested on real CJK vertical documents; `W2`/`DW2` metrics used, no `vert` feature knowledge.
- **Predefined CJK CMaps** other than the Unicode ones (e.g. `90ms-RKSJ-H`) without `/ToUnicode` are not decoded (such
  pages keep PDF.js text, which ships the CMaps).
- **Indic**: reordering relies on `/ActualText` or one-glyph-per-cluster output (engine, Chromium, LibreOffice checked
  on Devanagari); only pre-base vowel signs are moved heuristically; reph and other reorderings in files without
  ActualText are not handled.
- **ActualText spanning several lines** (hyphenation) is ignored in favour of the glyphs' text.
- **Encrypted documents** opened with a password in PDF.js but not unlocked for editing keep PDF.js text (pdf-lib
  cannot parse them).
- **Text layer**: spans are stretched per word with the browser's `sans-serif` font; highlight edges inside a word
  follow the browser's shaping, not the PDF's glyphs (search highlights use the exact glyph boxes).
- **Library search** is logical-order now but still sensitive to tashkeel (the index tokenizer keeps harakat), and
  existing index entries are only rebuilt when a file changes.
- **Docx bidi alignment** (`w:jc` in `w:bidi` paragraphs) follows Word's start/end reading of left/right; it was not
  checked in Microsoft Word.

<a id="files"></a>
## Files

```
src/shared/pagetext/      index.ts (API) build.ts interpret.ts fonts.ts sfnt.ts glyphnames.ts unicode.ts visual.ts query.ts types.ts
src/renderer/src/pdf/pagetext/   index.ts (pageText, worker client) worker.ts protocol.ts textLayer.ts
tests/fixtures/pagetext/  corpus.json generate.mjs html.cjs chromium.cjs engine.ts + generated PDFs and word boxes
tests/unit/pagetext-*.test.ts  tests/e2e/pagetext.spec.ts
```

No new dependencies: pdf-lib, bidi-js and the text engine's search normalisation were already in the project.
Everything runs offline, in-process or in a worker; LibreOffice is used only to regenerate fixtures.
