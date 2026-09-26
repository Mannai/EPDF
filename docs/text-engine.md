# The text engine (`src/shared/text`)

One shared, tested implementation of "put text into a PDF correctly, in any script". pdf-lib's `drawText` does no
shaping and no bidi (Arabic comes out disconnected and in the wrong order), knows no fallback fonts, and the standard
fonts only cover Western European text. Everything that draws text (form fields, add-text, markup text boxes and
stamps, headers/footers/watermarks, the Office converter, reports, text editing, redaction overlay text) should use
this instead.

* Arabic first: joining forms, lam-alef, tashkeel placed by the font, Persian/Urdu letters, Nastaliq, kashida
  justification, mirrored brackets, numbers (Western and Arabic-Indic) inside right-to-left text.
* Hebrew, Thai, Devanagari and the other Indic scripts, CJK, Latin ligatures/kerning, emoji (monochrome).
* Output is standard PDF: subsetted Type0/Identity-H fonts embedded once per document, a correct `/ToUnicode` and
  `/ActualText`, appearance-stream helpers. Opens and extracts correctly in PDF.js (and any reader that honours
  ToUnicode/ActualText).
* Pure TypeScript, no DOM: runs in Node, the sandboxed renderer and worker threads. HarfBuzz is WebAssembly bundled
  inside the app. Nothing is downloaded at run time.

## Contents

1. [Quick start and migration from `page.drawText`](#quick-start)
2. [API](#api)
3. [How Arabic (and every other script) is handled](#pipeline)
4. [PDF output and text extraction (read this before relying on copy/search)](#extraction)
5. [Fonts, stacks and fallback](#fonts)
6. [Search normalisation and visual-order repair](#search)
7. [Layout queries for editing UIs](#queries)
8. [Files, dependencies and licences](#files)
9. [Font inventory](#inventory)
10. [Testing and how correctness was verified](#testing)
11. [Known limits and what was not verified](#limits)
12. [Development tools](#tools)

<a id="quick-start"></a>
## 1. Quick start

### Set up once per process

```ts
// Sandboxed renderer (a feature's index.tsx or first use):
import { useRendererResources } from '@shared/text/renderer'
useRendererResources()                      // reads WASM + fonts from main over the validated `text:resource` channel

// Electron main, worker threads, Node scripts and tests:
import { useNodeResources } from '../main/features/textengine/nodeResources'   // (adjust the relative path)
useNodeResources()                          // reads resources/ (dev) or process.resourcesPath (packaged)
```

The main-process half (`src/main/features/textengine`) is auto-loaded by the app and already calls
`useNodeResources`; workers call it themselves. Then import from `@shared/text`.

### Migration: replace `page.drawText(...)` with `drawText(page, ...)`

```ts
// before (pdf-lib): no shaping, no bidi, one font, no fallback, sync
const font = await pdf.embedFont(StandardFonts.Helvetica)
page.drawText('Hello', { x: 72, y: 700, size: 12, font, color: rgb(0, 0, 0), maxWidth: 200, lineHeight: 14 })

// after (text engine): async, any script, fonts embedded/subset for you
import { drawText } from '@shared/text'
await drawText(page, 'مرحبا بالعالم', { x: 72, y: 700, size: 12, color: [0, 0, 0], maxWidth: 200, lineHeight: 14 })
```

| pdf-lib `drawText` option | text engine |
|---|---|
| `x`, `y` | same: **baseline start of the first line** (for right-to-left text without a width, `x` is the *left* edge; pass `anchor: 'right'` to end at `x`) |
| `size`, `opacity`, `rotate` (`degrees(n)`), `xSkew`, `ySkew` | same (numbers or pdf-lib angle objects) |
| `color: rgb()/grayscale()/cmyk()` | pdf-lib colour objects work unchanged; arrays `[r,g,b]`, `[c,m,y,k]` and a plain gray number also work |
| `font: PDFFont` | `fontStack: [...]`: family names/ids (`'Noto Naskh Arabic'`, `'serif'`, `'Helvetica'`), font bytes `{ bytes, name }`, or a loaded `TextFont`. Bundled fallbacks are appended automatically |
| `maxWidth` | `maxWidth` or `width` (wraps at word boundaries, shaping-aware) |
| `lineHeight` (points) | same (`lineHeight` in points); or `lineSpacing: 1.4` (multiple of the size) |
| `wordBreaks` | not needed: UAX #14 line breaking, Thai/CJK dictionary breaks |
| `blendMode`, `borderWidth`... | not supported (draw with pdf-lib around it) |
| — | `direction`, `align`, `lang`, `features`, `letterSpacing`, `wordSpacing`, `underline`, `strike`, spans, `clip`, `renderMode`, `extraction` |

It is `async` (fonts are loaded on demand). `drawText` returns `{ width, height, lineCount, missing, layout, bbox }`.
`missing` lists characters that no font could draw (they are drawn as the font's `.notdef` and reported; pass
`onMissing: 'throw'` to refuse instead).

### More examples

```ts
import { drawText, drawParagraph, makeTextXObject, measureText, embeddedFontsFor } from '@shared/text'

// Wrapped, right-to-left, justified with kashida, in a box whose TOP-left corner is (x, y):
await drawParagraph(page, arabicParagraph, { x: 72, y: 720, width: 300, size: 11, align: 'justify', fontStack: ['Noto Naskh Arabic'] })

// Mixed content with per-span styles:
await drawParagraph(page, [
  { text: 'الإجمالي: ', weight: 'bold' },
  { text: '1,250.00 ', color: [0.8, 0, 0] },
  { text: 'SAR' }
], { x: 72, y: 600, width: 250, size: 12 })

// An appearance stream for an annotation or form field, in any script:
const ap = await makeTextXObject(pdf, 'الاسم الكامل', { size: 12, width: 160, height: 22, padding: 3, valign: 'middle', align: 'start' })
widgetDict.set(PDFName.of('AP'), pdf.context.obj({ N: ap.ref }))   // ap.ref, ap.bbox, ap.layout

// Measure without drawing:
const m = await measureText('مرحبا', { size: 14 })   // { width, height, lineCount, layout, missing }

// The fonts the document now embeds (one subset per font, shared by all calls and pages):
embeddedFontsFor(pdf).all().map((f) => f.font.family)
```

`pdf.save()` writes the font subsets (a hook in `pdf.fonts`); call `await flushTextFonts(pdf)` only if you serialise the
context another way. Drawing into the same document later extends the same subsets.

<a id="api"></a>
## 2. API

All exported from `@shared/text` (`src/shared/text/index.ts`).

| Function | Purpose |
|---|---|
| `drawText(page, text \| Span[], DrawOptions)` | draw at a baseline point; drop-in for `page.drawText` |
| `drawParagraph(page, text \| Span[], DrawOptions)` | draw inside a box whose top-left is `(x, y)` |
| `makeTextXObject(pdf, text, XObjectOptions)` | Form XObject (`/AP`, field appearances), self-contained resources |
| `measureText / measureParagraph(text, ParagraphOptions)` | width/height/lines without drawing |
| `layoutParagraph(text \| Span[], ParagraphOptions)` | the layout itself: lines, runs, positioned glyphs |
| `caretAt`, `hitTest`, `selectionRects` | geometry for caret/selection code |
| `embeddedFontsFor(pdf)`, `flushTextFonts(pdf)` | per-document font state (`uniformNames`, `all()`) |
| `resolveStack`, `getCatalog`, `loadFontFromBytes`, `TextFont` | font stacks, catalogue, user fonts |
| `shapeText`, `lineBreakOpportunities`, `resolveScripts`, `analyzeBidi` | building blocks (also tested on their own) |
| `normalizeForSearch`, `findNormalized`, `visualToLogical` | search helpers |

`ParagraphOptions` (also accepted by `DrawOptions` and `XObjectOptions`): `width`, `direction` (`ltr|rtl|auto`,
per paragraph), `align` (`start|end|left|right|center|justify`), `justifyLast`, `kashida` (default on),
`lineHeight` (points) or `lineSpacing` (multiple), `tabSize`, `wordBreak` (`normal|phrase`), `breakLongWords`,
`maxLines`, `onMissing`, and the style fields `fontStack`, `weight`, `italic`, `size`, `color`, `opacity`,
`letterSpacing`, `wordSpacing`, `features` (`{ liga: false, smcp: true }` or `'liga=0, ss01'`), `lang` (BCP 47),
`underline`, `strike`, `rise`. `DrawOptions` adds `x`, `y`, `anchor`, `rotate`, `xSkew`, `ySkew`, `renderMode`
(`fill|stroke|fillStroke|invisible`), `strokeColor`, `strokeWidth`, `clip`, `extraction`.

`ParagraphLayout` = `{ text, lines, width, height, boxWidth, missing, directions, truncated }`. Each `Line` has
`runs` (visual left-to-right order), `x`, `y`, `width`, `height`, `baseline`, `ascent`, `descent`, `textStart/End`
(UTF-16 offsets into the source), `rtl`, `last`. Each `GlyphRun` has `font`, `size`, `glyphs`, `level`, `script`,
`style`, `x`, `width`. Each `LayoutGlyph`: `gid`, `cluster` (source offset), `chars` (source characters it carries),
`advance`, `natural`, `x`, `y`, `dx`, `dy`. Coordinates: layout units are points, x right, y down from the paragraph top.

<a id="pipeline"></a>
## 3. Pipeline

1. **Paragraphs** are split at newlines; each gets its own direction (`auto` = first strong character, UAX #9 P2/P3).
2. **Bidi** (`bidi.ts`): `bidi-js` (MIT, implements UBA 13.0 incl. isolates, bracket pairs, numbers) with astral
   characters classified correctly; rules L1 (trailing whitespace per line) and L2 (visual order of runs); mirroring is
   done by HarfBuzz for right-to-left runs. Verified against the official BidiTest/BidiCharacterTest vectors.
3. **Itemization** (`script.ts`, `layout.ts`): script per character (`Script_Extensions`, Common/Inherited resolved from
   context, paired punctuation follows its opener), per-cluster font fallback, style ranges. A run is a stretch with one
   bidi level, script, style and font.
4. **Shaping** (`shape.ts`): HarfBuzz per word (cached per font/direction/script/language/features/text), character
   clusters. Features: everything the font has, toggled with `features`; `lang` selects language-specific forms.
   Letter-spacing is not applied to cursive scripts and switches ligatures off elsewhere (CSS behaviour).
5. **Line breaking** (`linebreak.ts`): UAX #14 rules (classes derived from Unicode properties: see the header for the
   deliberate differences), kinsoku for CJK, `Intl.Segmenter` dictionary breaks for Thai/Lao/Khmer/Myanmar, optional
   phrase breaking for Chinese/Japanese.
6. **Lines** (`layout.ts`): greedy fit, hanging trailing spaces, L1/L2 per line, alignment; justification widens spaces
   (or spreads characters in CJK), and **Arabic kashida** (`kashida.ts`) inserts the font's own tatweel between joined
   letters (never in lam-alef, never after the last letter, seen/sheen/sad/dad first, spread over the words).
7. **Emission** (`pdf/emit.ts`): glyph positions become `TJ` corrections; displaced glyphs (marks, conjunct pieces)
   become synthesised composite glyphs in the subset font (`pdf/composite.ts`); every code has a `/ToUnicode` entry.

<a id="extraction"></a>
## 4. PDF output and text extraction

### What is written

* One `Type0` font per font file and document: `Encoding /Identity-H`, `CIDFontType2` + `FontFile2` for TrueType
  outlines, `CIDFontType0` + `FontFile3 /CIDFontType0C` (raw CFF) for OpenType-CFF (Noto CJK). Subsetting is HarfBuzz's own
  (`hb-subset`, WebAssembly) with glyph ids preserved (CID-keyed CFF keeps the CFF CIDs), hinting dropped, layout tables
  dropped. **A 1,000-word Arabic page adds ~15 KB.**
* `/W` widths are the shaper's advances (0 for marks), so a reader that adds glyph widths lands where the layout put the
  next glyph. Kerning, GPOS offsets and justification are honoured with `TJ` numbers.
* **Composite glyphs.** A shaped cluster is often several glyphs (a letter and its dot/mark components, Devanagari and
  Thai pieces, a base with a GPOS-displaced mark). Drawn as separate glyphs they extract as garbage and need vertical
  repositioning that extractors read as a new line. So every glyph the shaper displaced, and every multi-glyph character,
  becomes one new glyph appended to the TrueType subset (a `glyf` composite with the exact component offsets). One code
  per character, `/ToUnicode` maps it to its source characters, the content stream stays on the baseline. Glyphs shared by
  different characters (Persian/Arabic yeh, digits) get alias codes so `/ToUnicode` stays exact.
* Right-to-left multi-character glyph texts (lam-alef, a base with marks) are stored in visual order in `/ToUnicode`,
  because PDF.js, pdfium and poppler reorder right-to-left glyph strings from visual to logical **character by character**.
* Lines that need it are wrapped in marked content: `/Span << /ActualText <FEFF…> >> BDC … EMC` with the logical text of
  the line (`extraction: 'auto'` = right-to-left, mixed-direction and Indic/Thai/Khmer/Myanmar lines; `'actualText'` =
  every line; `'visual'` = never). Readers that honour ActualText (Acrobat, pdfium, poppler, MuPDF) then return exactly
  the logical text regardless of how they treat glyph order.
* All embedded fonts of a document share one `BaseFont` name (`EPDFTX+EpdfText`) by default: PDF.js starts a new text run
  whenever the font name changes and then keeps runs in *visual* order, so an Arabic sentence with an English word came out
  in the wrong order. With one name the line stays one run and PDF.js's own visual-to-logical reordering applies.
  `embeddedFontsFor(pdf).uniformNames = false` gives descriptive names (`ABCDEF+NotoNaskhArabic-Regular`).

### Measured behaviour (tests/unit/text-extraction.test.ts, PDF.js legacy build)

For the whole corpus (Arabic plain/lam-alef/wrapped/mixed/digits, Persian, Urdu, Hebrew, Thai, Hindi, Bengali, CJK,
emoji, Latin with ligatures) PDF.js `getTextContent()` returns the logical-order string (NFKC-normalised on both sides,
because PDF.js itself NFKC-normalises: `ﬁ` -> `fi`, Thai `ำ` -> `ํา`).

### PDF.js quirks that are **not** ours (documented, tested, worked around where possible)

* **PDF.js ignores `/ActualText`** for `getTextContent()`/search/copy. Correctness in PDF.js therefore relies on ToUnicode +
  its visual-to-logical heuristic, which is why the details above matter.
* **Combining marks.** PDF.js treats any glyph whose text contains a non-spacing mark (Arabic harakat, Hebrew points,
  Devanagari vowel signs) as zero-width and skips its position check. Effects: a word that *starts* (visually) with such a
  glyph after a space gets a second space, and a text run that starts with one is glued to the previous run. The engine
  folds the space into the next glyph (composite trick) to avoid the first effect. The second is not avoidable: in fully
  vocalised Arabic, the case-ending mark of the last word of a line may be reported as a separate item before the line.
  Tests for vocalised text therefore assert "same letters in the same order, same multiset of marks".
* **Neutrals next to right-to-left runs.** PDF.js only reorders the right-to-left *letters* back; numbers, punctuation
  and emoji between/after them in a left-to-right paragraph stay in visual order (`Hello 😀 مرحبا ⭐ 123` extracts as
  `Hello 😀 123 ⭐ مرحبا`). The PDF has the right ActualText; pdfium/Acrobat get it right.
* **PDF.js deletes `<` and `>`** from every right-to-left run (a deliberate line in its bidi code). ToUnicode/ActualText
  in the PDF contain them.
* Search in the app uses PDF.js text, so it inherits the above; `findNormalized` (below) is tolerant of most of it.

Other readers (Acrobat, pdfium/Chrome, poppler, MuPDF, macOS Preview) could not be run here; the ActualText spans are
checked directly (tests parse them and compare with the source text), and the structure is standard.

<a id="fonts"></a>
## 5. Fonts, stacks and fallback

`fontStack` is an ordered list of preferences: family names/ids (`Noto Naskh Arabic`, `noto-sans-arabic`, aliases
`sans`, `serif`, `mono`, `Helvetica`, `Arial`, `Times`, `Courier`, `Calibri`, `Cambria`), font bytes
(`{ bytes, name }`, e.g. a document's own embedded font extracted elsewhere) or loaded `TextFont`s. The bundled
fallbacks are appended: Noto Sans / Liberation Serif, every script font, the CJK fonts in the order for `lang`
(`ja` -> JP first, `ko` -> KR, `zh-Hant`/`TW`/`HK` -> TC, otherwise SC), symbols, math, emoji.

* **Per cluster, first covering font wins** (exactly CSS `font-family` semantics; verified against Chromium). Emoji
  presentation characters prefer the emoji font. Spaces, digits and punctuation therefore come from the first font in your
  stack that has them.
* Coverage comes from the catalogue (`resources/textfonts/text-fonts.json`, generated from the real fonts), so choosing a
  fallback never loads candidates; only the fonts actually used are loaded (CJK fonts are 4-8 MB).
* **Nothing is silently dropped**: uncovered characters are reported in `missing` (with their source index), drawn as
  `.notdef`, or raise with `onMissing: 'throw'`. `fallback: false` in `resolveStack` disables the bundled tail.
* Weight/italic pick the nearest face; a missing bold/italic is synthesised (fill+stroke faux bold, 12 degree shear).
* Fonts from bytes must be TrueType/OpenType (TTC index supported). Variable fonts are instantiated at their default
  location for embedding.

<a id="search"></a>
## 6. Search helpers (`search.ts`)

`normalizeForSearch(text, options)` returns `{ text, starts, ends, toOriginal(a, b) }`. Defaults ("find what the user
means"): Arabic tashkeel and Quranic marks removed; alef variants (أ إ آ ٱ), alef maqsura/Persian ye (ى ی -> ي),
Persian/Urdu kaf and heh variants unified; tatweel removed; presentation forms and ligatures expanded (ﻣﺮﺣﺒﺎ, ﷲ, ﻻ) via
NFKC; Arabic-Indic (٠-٩) and Persian (۰-۹) digits and Arabic punctuation mapped to ASCII; Hebrew points removed;
zero-width/directional format characters removed (NBSP -> space); full-width forms; case folding (ß -> ss). Opt-in:
`taMarbuta` (ة -> ه), `hamza` (ؤ ئ ء), `stripDiacritics` (é -> e). `toOriginal` maps normalised ranges back so highlights
and redaction boxes cover the right characters (a removed mark is covered together with its base letter).
`findNormalized(haystack, needle)` finds all matches and returns ranges of the *original* string.

`visualToLogical(text, { direction })` is **best effort**: it reorders each line as a bidi paragraph (inverting the
common cases of visual-order storage: RTL words, numbers and Latin inside them, mirrored brackets) and then expands
presentation forms. It cannot recover information a visual order lost; treat it as a search aid.

<a id="queries"></a>
## 7. Layout queries

`caretAt(layout, index, affinity?)`, `hitTest(layout, x, y)` and `selectionRects(layout, start, end)` work on a
`ParagraphLayout`; they follow logical order, are bidi-aware (a selection can be several rectangles), interpolate inside
ligatures and work across wrapped lines.

<a id="files"></a>
## 8. Files, dependencies, licences

```
src/shared/text/           engine (index.ts = public API)
  bidi.ts script.ts fonts.ts shape.ts linebreak.ts layout.ts kashida.ts query.ts search.ts types.ts env.ts hb.ts renderer.ts
  pdf/                     draw.ts emit.ts embed.ts composite.ts subset.ts tounicode.ts
  vendor/harfbuzz/         patched harfbuzzjs (MIT), see scripts/vendor-harfbuzz.mjs
src/main/features/textengine/   channel text:resource, nodeResources.ts (Node/worker loader), text:selfTest
src/renderer/src/features/textengine/   window.__epdfTextEngine.selfTest (test hook, no UI)
resources/text/            harfbuzz.wasm, harfbuzz-subset.wasm, LICENSE-HarfBuzz.txt
resources/textfonts/       fonts added by the engine, text-fonts.json (catalogue), OFL-1.1.txt, LICENSE-TextFonts.txt
scripts/                   fetch-text-fonts.mjs build-text-manifest.mjs vendor-harfbuzz.mjs sample-unicode-tests.mjs
```

| Dependency | Licence | Use |
|---|---|---|
| `bidi-js` 1.1.0 | MIT | UAX #9 (runtime dependency) |
| `harfbuzzjs` 1.6.2 (HarfBuzz 14.5.0) | MIT / "Old MIT" | shaping + subsetting; **vendored** (patched glue) and `devDependency` for refreshing; WASM in `resources/text` |
| Noto fonts | SIL OFL 1.1 | see the inventory; licence texts and copyright notices ship with the fonts |
| pdf-lib, pdfjs-dist | MIT / Apache-2.0 | already in the project |

No copyleft code. Everything is bundled: the installer contains the WASM and fonts (`electron-builder.yml`
`extraResources`), nothing is fetched at run time (`scripts/fetch-text-fonts.mjs` is a developer tool).

<a id="inventory"></a>
## 9. Font inventory

New fonts added by the engine live in `resources/textfonts` (29.1 MB of `.ttf`/`.otf`, plus 243 KB catalogue and the
1.1 MB of WebAssembly); the fonts of earlier features stay in `resources/fonts` and are part of the catalogue too.
All Noto files come from the "unhinted" builds of https://github.com/notofonts/notofonts.github.io (commit
`f145d86…`), Noto CJK "SubsetOTF" from https://github.com/notofonts/noto-cjk (`f8d1575…`), Noto Emoji from
https://github.com/google/fonts (`ofl/notoemoji`, variable font pinned to its default weight, `23e54b5…`).

| Family | Category | Scripts | Weights | Outlines | Code points | Size | Origin | Licence |
|---|---|---|---|---|---|---|---|---|
| Noto Sans Arabic | sans | Arab | 400, 700 | TrueType | 1,250 | 277 KB | new | OFL-1.1 |
| Noto Naskh Arabic | serif | Arab | 400, 700 | TrueType | 1,249 | 309 KB | new | OFL-1.1 |
| Noto Nastaliq Urdu | serif | Arab | 400, 700 | TrueType | 409 | 346 KB | new | OFL-1.1 |
| Noto Sans Hebrew | sans | Hebr | 400, 700 | TrueType | 147 | 33 KB | new | OFL-1.1 |
| Noto Sans Thai | sans | Thai | 400, 700 | TrueType | 101 | 41 KB | new | OFL-1.1 |
| Noto Sans Devanagari | sans | Deva | 400, 700 | TrueType | 281 | 359 KB | new | OFL-1.1 |
| Noto Sans Bengali / Tamil / Telugu / Gujarati / Gurmukhi / Kannada / Malayalam | sans | Beng, Taml, Telu, Gujr, Guru, Knda, Mlym | 400, 700 | TrueType | 114-187 each | 70-323 KB each | new | OFL-1.1 |
| Noto Sans Oriya / Sinhala / Thaana / Syriac / Armenian / Georgian / Lao / Khmer / Myanmar / Ethiopic | sans | Orya, Sinh, Thaa, Syrc, Armn, Geor, Laoo, Khmr, Mymr, Ethi | 400 | TrueType | 92-533 each | 18-289 KB each | new | OFL-1.1 |
| Noto Sans SC | cjk | Hani, Hans, Hira, Kana, Bopo | 400 | CFF | 30,890 | 7.9 MB | new | OFL-1.1 |
| Noto Sans TC | cjk | Hani, Hant, Hira, Kana, Bopo | 400 | CFF | 20,745 | 5.4 MB | new | OFL-1.1 |
| Noto Sans JP | cjk | Hani, Jpan, Hira, Kana | 400 | CFF | 16,732 | 4.3 MB | new | OFL-1.1 |
| Noto Sans KR | cjk | Hani, Kore, Hang | 400 | CFF | 23,174 | 4.4 MB | new | OFL-1.1 |
| Noto Sans Symbols / Symbols 2 / Math | symbol | - | 400 | TrueType | 840 / 2,641 / 2,919 | 142 / 656 / 642 KB | new | OFL-1.1 |
| Noto Emoji (monochrome) | emoji | - | 400 | TrueType | 1,489 | 843 KB | new | OFL-1.1 |
| Noto Sans (Latin, Greek, Cyrillic, Vietnamese) | sans | Latn, Grek, Cyrl | 400, 700 + 400i, 700i | TrueType | 3,094 | 2.4 MB | existing (+ italics new) | OFL-1.1 |
| Liberation Sans / Serif / Mono, Carlito, Caladea | sans/serif/mono | Latn, Grek, Cyrl | 4 faces each | TrueType | ~2,300 | 0.3-2.4 MB | existing | OFL-1.1 |
| Allura, Great Vibes, Sacramento, Homemade Apple | script | Latn | 400 | TrueType | - | 78-447 KB | existing | OFL-1.1 / Apache-2.0 |

**CJK size justification.** Simplified, Traditional, Japanese and Korean each need their own glyph forms (Han unification),
so each has its own regional subset OTF from Noto CJK "SubsetOTF" (the regional builds contain only the glyphs of that
region's standards: 4.3-7.9 MB instead of 16 MB per weight for the full pan-CJK font, 36 MB for the variable one).
Together 22 MB, about 75 % of the growth; compressed in the installer they are smaller. Only regular weight is bundled
(bold is synthesised). Total new installer payload: **~30 MB uncompressed** (fonts 29.1 MB + WebAssembly 1.1 MB),
within the 60 MB budget. `dist/win-unpacked/resources/textfonts` measured 29.3 MB.

<a id="testing"></a>
## 10. Testing and how correctness was verified

Unit (`npm test`, files `tests/unit/text-*.test.ts`, 190 tests) and end-to-end (`tests/e2e/text-engine*.spec.ts`).

| What | How |
|---|---|
| Bidi | vendored samples of the official Unicode 13.0.0 `BidiTest.txt` (13k cases) and `BidiCharacterTest.txt` (2.6k cases): levels, paragraph level and reordering including rules L1/L2 |
| Shaping | golden tests: joining forms, lam-alef `rlig`, tashkeel offsets, Persian/Urdu letters, Nastaliq positioning, mirroring, Hebrew points, Thai sara am, Devanagari conjunct and matra reordering, ligatures, kerning, CJK, feature toggles, cache |
| Itemization/fallback | script runs, paired brackets, user font precedence, missing-character reporting, CJK by language, emoji |
| Line breaking | UAX #14 rules, Arabic/Hebrew punctuation, Thai dictionary breaks, CJK kinsoku, phrase breaking |
| Layout | wrapping, newlines, alignment by direction, justification (spaces, kashida, CJK), tabs, spacing, spans, caret/hit-test/selection |
| PDF | structure (fonts, ToUnicode, W, descriptor, subset parses in fontkit), content-stream well-formedness, ActualText, modes/colours/opacity/rotation/clip, appearance streams, once-per-document embedding, size |
| Extraction | PDF.js legacy build extracts the logical text of every corpus item; ActualText spans equal the source |
| **Rendering vs Chromium** | see below |
| Search | Arabic/Hebrew/Latin normalisation cases, index-mapping property tests (300 random strings), `visualToLogical` |
| Performance | `text-bench.test.ts`: 1,000 mixed-script paragraphs |
| Worker threads | `text-worker.test.ts` bundles the engine to CommonJS like electron-vite and runs it in a real `worker_threads` Worker |
| Real app | `text-engine-app.spec.ts`: the renderer writes an Arabic/Hebrew/Hindi/CJK/Thai PDF, the app renders it, its text layer holds the logical text, selecting it (copy) returns the logical string, the app's full-text search finds Arabic and Hebrew words and phrases |
| Packaged build | `text-engine-packaged.spec.ts` (skips without `EPDF_PACKAGED_EXE`): WASM and fonts from `process.resourcesPath` in the renderer and in the main process; a non-whitelisted resource name is refused |

### The Chromium comparison harness (`tests/e2e/text-engine.spec.ts`)

For every corpus item (`tests/support/textCorpus.ts`, 32 items: Arabic Naskh/Sans, lam-alef, tashkeel, wrapped RTL
paragraphs at three widths, Persian, Urdu Naskh and Nastaliq, Hebrew (plain/niqqud), mixed Arabic+Latin+numbers both
directions, Arabic-Indic and Western digits, mirrored brackets/quotes/guillemets, Hebrew mixed wrap, Thai, Hindi, Bengali,
Tamil, Chinese, Japanese, Korean, emoji, Latin ligatures/kerning):

1. the engine writes a PDF (vitest, `text-artifacts.test.ts`);
2. a real Electron window renders it with **PDF.js on a canvas** (same pdfjs-dist as the app);
3. the same lines are rendered by **Chromium's own text engine** (DOM) with the same font files (`@font-face`) and the same
   fallback order, at the same size and line height;
4. both images are converted to ink, cropped to their ink box, blurred (2x 3x3 box) and compared by normalised
   cross-correlation with a +-3 px shift search, plus ink width and height.

Thresholds: NCC >= **0.80**, ink width within 4 % (+2 px), height within 12 % (+3 px). Measured results (this machine):

| Item | NCC | | Item | NCC |
|---|---|---|---|---|
| Arabic Naskh | 0.991 | | Persian | 0.990 |
| Arabic Sans | 0.987 | | Urdu Naskh / Nastaliq | 0.991 / 0.941 |
| lam-alef | 0.990 | | Hebrew / niqqud | 0.982 / 0.990 |
| tashkeel (Naskh / Sans) | 0.991 / 0.992 | | mixed RTL (Latin, digits, %) | 0.986 |
| wrapped 300 / 220 / 150 | 0.967 / 0.966 / 0.972 | | Arabic-Indic + Western digits | 0.986 |
| mirrored brackets, quotes | 0.985 | | mixed wrap (Arabic / Hebrew) | 0.991 / 0.968 |
| English with Arabic | 0.992 | | Thai / Hindi / Bengali / Tamil | 0.990 / 0.989 / 0.992 / 0.989 |
| Chinese / Japanese / Korean | 0.995 / 0.995 / 0.988 | | emoji, Latin | 0.990, 0.995 |

**The comparison has teeth** (negative controls, all must FAIL the threshold): pdf-lib's `drawText` with the same Arabic
font embedded through fontkit: NCC **0.52** (logical order drawn left to right, wrong direction); the engine's own output
with the wrong paragraph direction on mixed text: **0.28**; different text: **0.37**.
Justified lines (kashida) cannot be compared with Chromium (it has no kashida) and are checked for filling their box and
looked at (`test-results/text/compare/ar-justify.png`).
Side-by-side pictures of every comparison (PDF.js on top, Chromium below) are saved in `test-results/text/compare/`.

### Benchmarks (this machine, 1,000 paragraphs of ~30 mixed words, width 300 pt, 12 pt)

| Pass | Time |
|---|---|
| cold (loads fonts, fills caches) | ~255 ms |
| warm (new paragraphs, same vocabulary) | ~157 ms (thresholds: < 1000 ms) |
| shaping cache emptied, fonts loaded | ~167 ms |
| fully cached | ~142 ms |
| 4,000 word pairs in one paragraph | ~140 ms |

<a id="limits"></a>
## 11. Known limits and what was not verified

Verified: everything in section 10. Not verified / not implemented:

* **Other PDF readers** (Acrobat, Chrome's pdfium viewer, poppler/pdftotext, MuPDF, Preview) were not run. ToUnicode,
  ActualText and font structure follow the standards and are checked structurally, and rendering is confirmed with
  PDF.js only. Font embedding of TrueType composites was additionally parsed with fontkit.
* **PDF.js quirks** listed in section 4 remain (vocalised text, neutrals around RTL runs in LTR paragraphs, deleted `<>`).
* **Nastaliq**: shaped and rendered correctly against Chromium (NCC 0.94), but the font's tall glyphs need `lineHeight`
  tuning by the caller; kashida is not applied to Nastaliq (it does not use tatweel).
* **Indic edge cases**: HarfBuzz handles reordering/conjuncts; extraction of conjuncts containing a virama has the
  PDF.js zero-width quirk. Only the bundled fonts' features are available (no font for e.g. Tibetan, Mongolian, N'Ko).
* **Vertical CJK** (vertical writing, `vert`) is not implemented.
* **Colour emoji** are not supported (the bundled emoji font is monochrome outlines); no COLR/SVG/bitmap glyphs.
* **Variable fonts** are used at their default instance; no axes API.
* **UAX #14** is implemented from Unicode properties available in JavaScript (no Line_Break table); it is not
  conformance-tested against `LineBreakTest.txt`. Unicode data follows the JavaScript engine (scripts) and `bidi-js`
  (Unicode 13.0 bidi classes; characters added to Unicode after 13.0 are treated as left-to-right by the bidi step).
* **Hyphenation and soft-hyphen rendering** are not implemented (soft hyphens are break opportunities but do not draw a hyphen).
* **Embedding into existing documents**: fonts are embedded per `PDFDocument` object; editing a document in several
  `editPdf` steps embeds a new (small) subset each time.
* The `text:selfTest` channel and `window.__epdfTextEngine` are diagnostics; nothing in the app calls them.
* Nothing else in the app uses the engine yet (by design: a later stage retrofits the features).

<a id="tools"></a>
## 12. Development tools

* `node scripts/fetch-text-fonts.mjs` (network, developer only): downloads the pinned upstream fonts into `resources/textfonts`.
* `node scripts/build-text-manifest.mjs`: regenerates `resources/textfonts/text-fonts.json` and `LICENSE-TextFonts.txt`
  from the fonts in `resources/fonts` and `resources/textfonts` (coverage is read with HarfBuzz).
* `node scripts/vendor-harfbuzz.mjs`: refreshes the vendored harfbuzzjs glue and the WebAssembly from `node_modules`.
* `node scripts/sample-unicode-tests.mjs` (network): recreates the bidi test samples.
* `npx vitest run tests/unit/text-` runs the engine's unit tests; `npx playwright test tests/e2e/text-engine` the comparison
  harness and the app tests; the packaged test needs `npx electron-builder --win --dir --publish never` and
  `$env:EPDF_PACKAGED_EXE = "dist\win-unpacked\Epdf.exe"`.
