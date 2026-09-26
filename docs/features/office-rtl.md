# Office → PDF: Arabic, right-to-left and complex scripts

The built-in Office converter (`src/main/features/create/office/`, see [create-export.md](create-export.md) §2) converts
Arabic (and Hebrew, Persian, Urdu, Thai, Indic, CJK...) documents so that the PDF looks like the document — joined
letters, right-to-left paragraphs, alignment, lists, tables and sheets mirrored — and reads back and searches in
logical order. Nothing is installed or downloaded: all text goes through the text engine (`src/shared/text`,
[docs/text-engine.md](../text-engine.md)) with the bundled fonts.

Contents: [How text is drawn](#drawing) · [Per format](#formats) · [Fonts](#fonts) · [Verification](#verification) ·
[Limits](#limits) · [Files](#files)

<a id="drawing"></a>
## 1. How text is drawn

* **Every text op goes through the engine** (`ops.ts`): Type0/Identity-H subsets, `/ToUnicode` for every glyph and, for
  right-to-left and mixed lines, one `/Span <</ActualText …>>` with the logical text of the whole line. fontkit is no
  longer used. Documents that contain right-to-left text give all their fonts one BaseFont (`EPDFTX+EpdfText`) so
  PDF.js keeps a line together and reorders it itself; other documents keep descriptive names (`ABCDEF+Carlito-Bold`).
* **Measurement = drawing.** Words are measured with HarfBuzz in the fonts they are drawn with (`fonts.ts:measure`), so
  line breaking sees shaped Arabic widths.
* **Lines** (`textline.ts:shapeLine`): the items of a line (text in a style, inline pictures as neutral gaps) get UAX #9
  levels with the paragraph direction (rule L1 for trailing white space), are split into runs of one font, script and
  level, shaped (an Arabic word split across styles — a bold letter — is shaped with a joiner on each side, so its
  letters keep their joined forms), put in visual order (L2), optionally justified, and adjacent runs with the same font
  and level are merged (PDF.js reorders only inside one text run).
* **Paragraph geometry** (`layout.ts:emitLine`) is computed from the paragraph's start edge and mirrored for
  right-to-left paragraphs: start/end indents, first-line/hanging indent, tab stops (measured from the right), the list
  marker (on the right) and alignment are logical. Each stretch between two tabs is ordered on its own (tabs are UAX #9
  segment separators).
* **Justification** widens the spaces. Arabic **kashida** (tatweel inserted by the engine between joined letters) is
  used when the document asks for it: Word `w:jc` `lowKashida`/`mediumKashida`/`highKashida`, RTF `\qk`. (Word's plain
  "Justify" and LibreOffice widen spaces, and so does Epdf.)
* **Fonts per character**: letters take the first font of the style's stack that has them; spaces, digits and
  punctuation take the font of the letters around them when it has them (Word sets the spaces of an Arabic run in the
  Arabic font). A font the layout needs but that is not loaded yet (a CJK or Indic fallback) is loaded after the pass and
  the pass is repeated (`FontCatalog.pending`).
* **Tables** with a right-to-left flag put column 1 on the right; their alignment/indent, cell margins and left/right
  borders are logical (start/end). **Sections** with a right-to-left flag fill their columns from the right.
* **Sheets** with a right-to-left flag are drawn left to right and mirrored inside the printable width (column A on
  the right, text spills to the left). "General" alignment: text goes to the start side of its own direction (Arabic
  right, English left), numbers to the right (as LibreOffice does in right-to-left sheets).

<a id="formats"></a>
## 2. Per format

| Format | What is read |
|---|---|
| DOCX | `w:bidi` paragraphs; `w:rtl` and `w:cs` runs (all characters complex script); otherwise per character: Arabic/Hebrew/Syriac/Thaana/Thai letters use the complex-script properties, neutral characters go with the letters before them; `w:rFonts w:cs` / `w:cstheme` (theme `majorBidi`/`minorBidi`: `a:cs`, else the `script="Arab"` font), `w:szCs`, `w:bCs`, `w:iCs`; `w:jc` start/left/end/right/center/both/distribute and the kashida values, read as logical in bidi paragraphs; `w:ind` start/left and end/right as logical; tab stops; list labels of bidi paragraphs in the complex-script style; `numFmt` `arabicAbjad`, `arabicAlpha`, `hindiNumbers` (Arabic-Indic digits ١٢٣), `hindiCounting` (Devanagari digits), `hindiVowels`, `hindiConsonants`, `hebrew1`, `hebrew2`, `thaiNumbers`, `decimalFullWidth`; `w:tblPr/w:bidiVisual`; `w:sectPr/w:bidi` (columns from the right); headers and footers (their paragraphs carry their own `w:bidi`). The warning "Right-to-left … may not be shaped" is gone. |
| XLSX | `sheetView rightToLeft="1"`; `alignment readingOrder` (1 LTR, 2 RTL, 0 context = first strong character); General alignment by direction; cell text shaped. |
| ODS | table style `style:writing-mode="rl-tb"` → right-to-left sheet; cell paragraph writing mode → reading order. |
| PPTX | `a:pPr rtl="1"`; `algn` is physical in DrawingML (PowerPoint and LibreOffice draw `algn="r"` on the right in both directions) and converted to logical; `marL`/`indent` logical; `a:cs` (and `+mn-cs`/`+mj-cs`, theme `a:cs` / `script="Arab"`); `a:tblPr rtl="1"` tables. |
| ODP | paragraph `style:writing-mode`; `fo:text-align` start/end (logical) and left/right (physical); `style:*-complex` font properties. |
| ODT | `style:writing-mode` rl-tb / lr-tb / `page` (from the page layout); `fo:text-align` start/end logical, left/right physical; `fo:margin-left/right` used as start/end indents (what LibreOffice does: checked); `style:font-name-complex`, `style:font-family-complex`, `style:font-size-complex` (absolute or %), `style:font-weight-complex`, `style:font-style-complex`; table `style:writing-mode="rl-tb"` (and `page` on a right-to-left page) with `table:align` physical. |
| RTF | `\rtlpar`/`\ltrpar` (alignment `\ql \qr` physical, as before), `\rtlch`/`\ltrch`, `\fcs1` (the following `\f \fs \b \i` are complex-script), `\af`, `\afs`, `\ab`, `\ai`, `\adeff`, `\qk` (kashida), `\rtlrow` tables, `\rtlsect`. |
| TXT | each line is a paragraph with its own direction from its first strong character; right-to-left lines start at the right margin. |
| CSV | cells shaped; Arabic cells right-aligned (General alignment by direction). The sheet itself stays left to right (as LibreOffice's CSV import). |

<a id="fonts"></a>
## 3. Fonts: Office Arabic fonts → bundled fonts

A document font name maps to a stack (`fonts.ts`, `ARABIC_FONTS`): the metric-compatible Latin face (unchanged:
Liberation, Carlito, Caladea), the Arabic face below with a size factor, then the engine's fallbacks. For an Arabic font
name the Arabic face comes first. **Line heights** come from the first face of the stack (Liberation Sans for Arial...),
as Word gives an Arabic run in Arial Arial's line height.

The size factor makes Arabic text as **wide** as in the Microsoft font, so lines break at the same words. It is the ratio
of the HarfBuzz advance widths of six paragraphs of ordinary Modern Standard Arabic (`tests/unit/officeArabicFontMetrics.test.ts`,
`EPDF_MEASURE_FONTS=1`, run against the fonts in `C:\Windows\Fonts` of the development machine; the Microsoft fonts are only
read there, never shipped). Single words vary: `الكتابة` is 10 % wider in Noto Naskh than in Arial, `تقرير الربع الأول`
1 % narrower.

| Office font | Arabic drawn with | Size factor | Width ratio measured (MS font / Noto) | Arabic letter height after the factor (mean ink, em) | Line metrics used (asc/desc/gap em) vs the MS font |
|---|---|---|---|---|---|
| Arial | Noto Naskh Arabic | 0.920 | 0.920 | 0.453 vs Arial 0.521 (−13 %) | Liberation Sans 0.905/0.212/0.033 = Arial's |
| Times New Roman | Noto Naskh Arabic | 0.907 | 0.907 | 0.446 vs 0.521 (−14 %) | Liberation Serif 0.891/0.216/0.042 = Times New Roman's |
| Calibri (with Arabic text) | Noto Naskh Arabic | 0.935 | 0.935 | 0.460 vs 0.541 (−15 %) | Carlito = Calibri's |
| Tahoma | Noto Sans Arabic | 1.063 | 1.063 | 0.570 vs 0.595 (−4 %) | Liberation Sans 1.150 em vs Tahoma 1.207 em (lines ~5 % tighter) |
| Segoe UI | Noto Sans Arabic | 1.036 | 1.036 | 0.555 vs 0.615 (−10 %) | Liberation Sans 1.150 em vs Segoe UI 1.330 em (lines ~14 % tighter) |
| Simplified Arabic | Noto Naskh Arabic (first), Latin Liberation Serif | 1 | **not measured** (font not on this machine) | – | Noto Naskh Arabic 1.069/0.634/0 |
| Traditional Arabic | Noto Naskh Arabic (first), Liberation Serif | 1 | not measured | – | Noto Naskh Arabic |
| Arabic Typesetting | Noto Naskh Arabic (first), Liberation Serif | 1 | not measured | – | Noto Naskh Arabic |
| Sakkal Majalla | Noto Naskh Arabic (first), Liberation Serif | 1 | not measured | – | Noto Naskh Arabic |
| Dubai | Noto Sans Arabic (first), Liberation Sans | 1 | not measured | – | Noto Sans Arabic 1.374/0.738/0 |

Other names: Verdana / Microsoft Sans Serif → Noto Sans Arabic ×1.063 (Tahoma's, which Word falls back to); Courier
New → Noto Naskh ×1; Arabic Transparent, Andalus, Aldhabi, Amiri, Scheherazade, Lotus, Mitra, Nazanin, Zar, Badr, KFGQPC…
→ Noto Naskh Arabic; Cairo, Tajawal, Almarai, IBM Plex Sans Arabic, Vazir(matn), Sahel, Koodak, Titr, Yekan, Kufi… → Noto
Sans Arabic; names with Nastaliq/Nastaleeq → Noto Nastaliq Urdu; every other name → Noto Naskh Arabic ×1.

What the table means in practice:
* Arial/Times/Calibri documents: Arabic lines break like LibreOffice's (which uses the real fonts) within about a word per
  paragraph, at the price of Arabic letters about 13–15 % shorter than the Microsoft fonts' (Noto Naskh is a wider design).
  Matching the width was chosen over matching the height because line and page breaks follow from it.
* Traditional Arabic and Arabic Typesetting are compact designs with small letters (documents typically set them 2–4 pt
  larger than Latin text); drawn with Noto Naskh at factor 1 their text comes out noticeably larger and wider, and the
  line height (Noto Naskh 1.70 em) is an estimate. Simplified Arabic, Sakkal Majalla and Dubai could not be measured
  either. Measure them with the test above on a machine that has them, and set the factors in `ARABIC_FONTS`.

<a id="verification"></a>
## 4. Verification

### Corpus (`tests/support/arabicCorpus.ts`, generated by code)

DOCX (bidi paragraphs with start/end/centre/justify/kashida alignment, mixed Arabic + bold Latin + numbers, bullet,
decimal, `arabicAbjad` and `hindiNumbers` lists, a `bidiVisual` table, a tab stop, a start indent, a `szCs`/`bCs` run, an
English paragraph with an Arabic word, a plain English paragraph, a right-to-left header and a footer with a PAGE field,
`sectPr/w:bidi`), XLSX (right-to-left sheet), ODS (rl-tb table), ODT (all alignments incl. physical left/right, an rl-tb
table, complex font properties), RTF (`\rtlpar`, `\af`/`\afs`/`\ab`), PPTX (`rtl` + `algn` r/l/ctr, bullet, `a:cs`), ODP
(rl-tb paragraphs with start/end/left/right/centre, complex font properties), TXT and CSV.
`EPDF_WRITE_CORPUS=1 npx vitest run tests/unit/officeRtlCorpus.test.ts` writes every file, Epdf's PDF and LibreOffice's PDF
to `test-results/office-rtl/`.

### Checks (`tests/unit/officeRtlCorpus.test.ts`, `officeRtlFeatures.test.ts`, `tests/e2e/office-rtl.spec.ts`)

* **Logical order**: every source paragraph is read back with the page text model; one-line paragraphs as exactly one
  line (`مرحبا بالعالم. هذا مستند تجريبي …`, `تأسست شركة Epdf في عام 2024 في المنامة، البحرين.`, `1. الخطوة الأولى`,
  `أ- أولا`, `١. عنصر`, `The capital of Bahrain is المنامة and its currency is BHD.`), wrapped ones as consecutive lines.
* **Visual order, independently of /ActualText**: word positions from the model's glyph boxes (`تأسست` right of `شركة`
  right of `Epdf` right of `عام` right of `2024` right of `المنامة`; table column 1 rightmost; bullets right of their text;
  "(BHD)" at the left end of an Arabic cell), and **PDF.js** (which ignores ActualText) reads the pure-Arabic lines in logical
  order. Lines where a Latin word or a list marker is its own run are returned by PDF.js in visual run order: the PDF.js
  quirk documented in text-engine.md §4; the app's page text model and ActualText-aware readers read them logically.
* **Alignment side** of every paragraph = the expected physical side.
* **Against LibreOffice 26.8** (skipped without it): same side for every paragraph of every format; same column order in
  every table and sheet; the aligned edge within **6 pt** (measured: DOCX, ODT, RTF, PPTX, ODP, XLSX, ODS ≤ 0.5 pt; TXT 5.2 pt,
  Epdf's plain-text margins are 62 pt, LibreOffice's 56.8 pt — unchanged behaviour); wrapped paragraphs within **±1 line**
  (measured: equal line counts everywhere). 6 pt covers cell-padding and margin conventions that differ between the two
  converters; alignment sides and column orders are compared exactly. Vertical positions are not compared: line heights
  follow different fonts (real Arial vs Liberation + Noto).
* Documented differences with LibreOffice (reported by the test, not failures):
  * `arabicAbjad` labels: Epdf `أ ب ج` (alef with hamza, as ECMA-376 shows), LibreOffice `ا ب ج`.
  * `hindiNumbers`: Epdf Arabic-Indic digits `١. ٢. ٣.`, LibreOffice Western digits (its default "Arabic numerals" setting).
  * `bidiVisual` table position: Epdf puts it at the right margin (ECMA-376: `tblInd` is measured from the leading edge,
    the right one for a right-to-left table), LibreOffice at the left margin; column order is the same.
  * A right-to-left sheet cell that starts with Arabic and ends with Latin: Epdf uses Excel's context reading order (first
    strong character: right to left), LibreOffice lays such a cell out left to right.
  * LibreOffice's kashida PDF splits the words at every stretch in text extraction (`وه ذه فق رة`); Epdf's extracts cleanly.
* **Rendering with Windows' own PDF engine** (`scripts/render-winpdf.ps1`, independent of PDF.js), one page per format,
  looked at side by side with LibreOffice's: Arabic fully joined in every format (Naskh and Sans), right-to-left
  paragraphs and alignments identical to LibreOffice's, list markers on the right, Arabic-Indic digits, the bidiVisual and
  ODT/RTF tables with column 1 on the right, sheets with column A on the right, the kashida paragraph stretched with
  tatweel, bold Arabic runs, "PDF" / "Epdf" / "2.0" left to right inside Arabic lines with the trailing period on the
  left. Epdf's Arabic letters are visibly a little smaller than LibreOffice's Arial ones (the factor above).
* **Latin fidelity** against LibreOffice (logged by the existing comparison tests, before this work / after): docx 4 = 4
  pages, 97.8 % / 97.8 % of lines identical; rtf 100 / 100 %; odt 100 / 100 %; LibreOffice-written odt and rtf 100 / 100 %;
  xlsx 100 / 100 %; ods 100 / 100 %; csv 95.3 / 95.3 %; pptx title offset dx 8.69 / 8.69 pt, others ≤ 0.01; odp 0.01 / 0.01.
* **Performance** (`officeRtlFeatures.test.ts`, each in a fresh process, so HarfBuzz and font loading included): 53 pages of
  varied justified Arabic prose with numbers and Latin words (760 paragraphs) in 0.75 s (three runs: 765 / 765 / 747 ms,
  317 KB PDF); the corpus DOCX repeated to 50 pages in 0.46–0.87 s (196 KB PDF). In the app the conversion runs in the
  create worker thread, so the UI stays responsive.

<a id="limits"></a>
## 5. Not handled / not verified

* **Microsoft Word, Excel and PowerPoint were not available**: every comparison is with LibreOffice; where LibreOffice
  and the specification disagree (table position, abjad letters, Hindi digits) Epdf follows the specification, unverified
  in Word.
* The Microsoft fonts Simplified Arabic, Traditional Arabic, Arabic Typesetting, Sakkal Majalla and Dubai were not
  installed: their mappings are unmeasured (factor 1, line metrics of the Noto face).
* **Vertical text** (`tbRl`, `vert`, ODF `tb-rl`): drawn horizontally (with the existing warning for slides).
* Explicit bidi embeddings in DOCX (`w:dir`, `w:bdo`) are read as plain text (their content is kept, the override/
  embedding level is not applied); `w:rtl` does not change the bidi class of characters (Word uses it as the complex-script
  flag). Per-line bidi: the UBA runs on each line with the paragraph direction, not on the whole paragraph (weak types at
  the very start of a wrapped line can resolve differently in rare cases).
* `w:lang w:bidi` is not used for shaping (Arabic is shaped with language `ar`; Persian/Urdu-specific forms that depend on
  the language tag are not selected); Arabic-Indic digit substitution (`w:cs` + numeral settings) is not applied — digits
  are drawn as stored.
* Tables: `\trqr`/`\trql` in RTF right-to-left rows are read as logical; PPTX right-to-left table cell borders are
  mirrored like the grid; RTF `\rtlrow` cell positions are taken from `\cellx` as for left-to-right rows.
* Sheets: headers/footers are not mirrored in right-to-left sheets; ODS/XLSX complex-script cell fonts (`*-complex`,
  font scheme `cs`) are not read (cells use the Arabic face of their Latin font's mapping).
* ODT/ODP: a document with several page layouts of different directions uses the direction of the last layout read for
  paragraphs whose writing mode is "page".
* Kashida placement is the engine's (simplified conventions, `kashida.ts`); Word's low/medium/high degrees are not
  distinguished.
* PDF.js (not the app) returns lines that mix Arabic with a Latin word or a list label in visual run order (see above).

<a id="files"></a>
## 6. Files

```
src/main/features/create/office/
  fonts.ts        engine-backed font catalogue: stacks, Arabic mapping + factors, HarfBuzz measurement, pending fonts
  textline.ts     line builder: bidi, font/script runs, shaping with joining context, visual order, kashida, glyph op
  ops.ts          PDF writer: text through the engine emitter (ToUnicode, ActualText), uniform names for RTL documents
  layout.ts       start-edge geometry mirrored for RTL paragraphs, RTL tables, `cs` style splitting, link merging
  paginate.ts     RTL section columns
  flow.ts         ParaProps.rtl/kashida, Table.rtl, Section.rtl, TextStyle.cs, splitByScript
  docx*.ts odt.ts odfStyles.ts odp.ts rtf.ts pptx.ts drawingml.ts xlsx.ts ods.ts sheet.ts text.ts   readers
tests/support/arabicCorpus.ts soffice.ts fidelity.ts
tests/unit/officeRtlCorpus.test.ts officeRtlFeatures.test.ts officeArabicFontMetrics.test.ts
tests/e2e/office-rtl.spec.ts
```
