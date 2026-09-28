# Edit text and images in the page content

Two tools in the **Edit** group of the Tools ribbon change what is drawn on a page, not annotations on top of it:

* **Edit text** (`edit-text`): click a line of text (or, with *Edit: Paragraph*, a whole paragraph), change it in an
  inline editor, press Enter.
* **Edit images** (`edit-images`): select, move, resize, delete, replace and add pictures.

Everything is written into the page's content stream(s) with a purpose-built engine (no MuPDF or any other
copyleft code) and goes through `editPdf`, so each change is **one undo step** ("Undo Edit text", "Undo Move
image", ...), is autosaved/recoverable, and is saved by the normal Save commands. Nothing touches the file until
Save.

## How it works

```
src/renderer/src/features/textedit/
  pdfcontent/          pure TypeScript, no pdfjs-dist import: runs in Node (this is what the unit tests cover)
    content.ts         tokenizer + parser + serializer for content streams (byte-for-byte round trip)
    cmap.ts            /ToUnicode and embedded /Encoding CMaps (codespace, bfchar/bfrange, cidchar/cidrange)
    encodings.ts       WinAnsi / MacRoman / Standard tables, Adobe glyph names (/Differences)
    fonts.ts           decode strings to Unicode, glyph widths, "can this font encode this character?"
    analyze.ts         graphics + text state tracker; text runs, images, Form XObjects, resource inheritance
    blocks.ts          groups runs into line blocks and paragraph blocks (stable ids, editable flag + reason)
    logical.ts         logical (reading-order) blocks for right-to-left / complex-script lines, from the page text model
    logicalEdit.ts     replacing such a block: glyph removal + text engine, font choice (see "Right-to-left ..." below)
    textEdit.ts        the two commit strategies (below)
    imageEdit.ts       move / resize / delete / replace / add images
    write.ts           edit plans, resource additions, write-back of modified streams
  TextEditOverlay.tsx, TextOptions.tsx, commit.ts, pageContent.ts, fontLoader.ts, state.ts, index.tsx
src/renderer/src/features/imageedit/   ImageOverlay.tsx, ImageOptions.tsx, actions.ts, state.ts, index.tsx
src/main/features/imageedit/index.ts   channel `imageedit:pickImage` (native open dialog)
src/shared/features/imageedit.ts       type of the channel's result
```

### The content-stream engine

* **Tokenizer/serializer.** All operators, inline images (`BI`/`ID`/`EI`, with the data length computed from the
  image dictionary or found by validated `EI` search), literal strings with all escapes, hex strings, names with
  `#xx`, arrays, dictionaries, comments and any whitespace. Every parsed operation keeps its original bytes, so
  `serialize(parse(x)) == x` byte for byte; only operations that are changed or created are re-serialized.
  Anything malformed (unterminated string/array/dictionary/inline image, stray delimiters, absurd nesting) throws
  and the page is treated as "cannot be edited safely".
* **State tracking.** `q/Q`, `cm`, `BT/ET`, `Tf Tc Tw Tz TL Ts Tr`, `Td TD Tm T*`, `Tj TJ ' "`, fill colors
  (`g rg k cs sc scn`), `BDC/BMC/EMC` (for `/ActualText`), `gs` fonts, and `Do` into Form XObjects (own resources,
  `/Matrix`, nesting limit, cycle guard). Pages with `/Contents` as one stream, an array, or an indirect array;
  resources inherited from the page tree.
* **Fonts.** Simple fonts: base encoding + `/Differences` (Adobe glyph names, `uniXXXX`, `uXXXXX`) with
  `/ToUnicode` overriding both; widths from `/Widths`, `/MissingWidth`, or the standard-14 metrics (Helvetica/Arial,
  Times, Courier, Symbol, Zapf) when a standard font has no `/Widths`. Type0/CID fonts: Identity-H and embedded
  CMaps, mixed 1/2-byte code spaces, `/W` and `/DW`, `/ToUnicode` for the text.
* **Geometry.** For every text-showing operation: font, size, colour, text-to-user matrix, per-glyph extents and a
  bounding box in PDF user space (compared against PDF.js's own positions and widths in unit tests). For every
  image (`Do` of an Image XObject, or an inline image): box from the CTM, pixel size, XObject name.
* **Blocks.** Runs on one baseline (similar size, no wide gap) become a *line*; consecutive lines with the same
  leading and alignment (left, right or centered) become a *paragraph*. A gap inside a `TJ` or between runs that
  is wide enough to be a word space reads as a space in the editor text.

### Text commit strategies (reported to the user)

1. **In place** ("Edited using the document’s own font"). The changed characters are found by a common
   prefix/suffix diff at the granularity of the document's own glyph codes (a ligature is one unit), and only the
   string operands of the existing `Tj`/`TJ`/`'`/`"` operations are rewritten. Kerning numbers, positioning,
   fonts, colours and everything else stay byte-for-byte. Used when every *new* character can be encoded:
   * embedded and subset fonts: only codes already **used on that page** are assumed to exist in the font
     program (the space is always allowed, it draws nothing);
   * non-subset, non-embedded fonts (standard 14, or with `/Widths`): any character of the encoding that has a
     width;
   * non-subset Type0 fonts: any glyph with an explicit `/W` width and a `/ToUnicode` entry.
2. **Replace.** Otherwise the block's text-showing operations are **removed** from the stream (not painted over)
   and the new text is drawn in a self-contained `q … BT … ET Q` group right after the text object, at the same
   baseline, size, horizontal scale, rise and colour, wrapping inside the original block width (a single line may
   grow towards the page margin before it wraps):
   * with the document's own font (*"Edited using the document’s own font"*) when it can encode the text but the
     edit changed size or colour, or joined/split lines;
   * with the closest standard font (Helvetica / Times / Courier, bold and italic variants) — *"Font not available
     in this PDF — used Helvetica"*;
   * with the bundled **Noto Sans** (regular/bold/italic/bold italic, subset-embedded on demand) for left-to-right
     characters outside WinAnsi that it has (Latin extended, Greek, Cyrillic, ...) — *"Font not available in this
     PDF — used Noto Sans"*;
   * with the **text engine** (`src/shared/text`, see `docs/text-engine.md`) for new text in a script that needs
     shaping or right-to-left ordering (Arabic, Persian, Hebrew, Indic, Thai, ...) and for characters Noto Sans lacks
     (CJK, ...): shaped, in display order, subset Type0 fonts with `/ToUnicode` and `/ActualText`, wrapped at the same
     width and leading, first baseline at the block's origin, in the family of the old font (sans / serif / mono,
     bold, italic) — *"Font not available in this PDF — used Noto Sans Arabic"* (the font that draws most of it).
     A single right-to-left line keeps its right edge where the old text ended (when it fits there). The engine's
     operators are inserted as a `q <text matrix> cm … Q` group in the same place the other strategies use; the
     editor's model is otherwise unchanged. Such characters are also never spliced into an existing run by the
     in-place strategy (they would show as isolated letters in the wrong order);
   * characters that no bundled font has (for example Tibetan) are **refused** with a message; the document is
     unchanged.

   Removing an operation keeps the text position of what follows: if the next show operation continues from
   where the removed one ended, the removed operation is replaced by a `[-n] TJ` that only advances (and `'`/`"`
   keep their line movement). Marked-content `/ActualText`, `/Alt` and `/E` around edited text are removed,
   otherwise text extractors would still return the old words.

   Edits that change the font size or colour (from the tool's options) always use replace.

Unexpected situations abort the edit and leave the document unchanged with a clear message (malformed streams,
text objects without `ET`, shared forms, stale selections, unsupported characters, unreadable images).

### Right-to-left and complex-script text (editing existing Arabic, Persian, Urdu, Hebrew, Indic ...)

The editor's own line builder above reads text in content-stream order, which for these scripts is the *visual*
order, often split into dozens of runs, with vowel marks on displaced baselines and letters whose Unicode value only
the font program or an `/ActualText` span knows. Such lines are therefore read with the **page text model**
(`src/shared/pagetext`, `docs/page-text.md`) and edited as the text a person reads:

1. **Finding the line** (`logical.ts`). On a page with right-to-left / complex-script text (or `/ActualText`, or
   glyphs without Unicode), the model is built from the same pdf-lib document with `glyphLines: true`, which reports
   the logical line every glyph (and every mark attached to a base glyph) belongs to. Each editor glyph (a code at a
   known byte offset of a `Tj`/`TJ`/`'`/`"` operand) is matched to the model's glyph drawn at the same origin
   (0.12 pt, stream order breaks ties). Glyphs the model did not place (letter pieces drawn separately, undecodable
   glyphs, orphan marks, fake-bold copies) go with the rest of their `/ActualText` span, else to the nearest baseline.
   Every model line containing a right-to-left or complex-script character becomes a **logical line block**; lines
   sharing a text operation with one join them. The editor's own blocks containing any of those operations are
   replaced, so nothing is offered twice. Consecutive logical lines of one model block with the same direction and
   size, a regular line pitch and a common edge form a **logical paragraph** (alignment detected: right, left, centre
   or justified). Blocks carry the logical text, the direction, the glyphs they cover per operation, the dominant
   font, size, colour, render mode and baseline.
2. **Editing.** The inline editor shows the logical text with `dir="rtl"` (or `ltr` for a left-to-right line with an
   Arabic word), right-aligned and anchored at the block's right edge for right-to-left text.
3. **Committing** (`logicalEdit.ts`, one `editPdf` step "Edit text"):
   * the block's glyphs are **removed from the content stream**: an operation that only draws the block is replaced by
     the `[-n] TJ` that keeps the position for what follows (or dropped); an operation that also draws other text
     (a table row drawn with one `TJ`) loses just those glyphs, the others keep their exact place (redaction's
     `rewriteShow`); `/ActualText` / `/Alt` / `/E` around them are removed so no reader can extract the old words;
   * the new text is drawn by the **text engine** (HarfBuzz shaping, bidi, `/ToUnicode` + `/ActualText`) in a
     `q cm … Q` group after the last text object involved: same baseline, font size, colour (Gray/RGB/CMYK kept as
     such; other colour spaces as RGB), render mode; a right-to-left line keeps its **right edge** (it grows to the
     left), a left-to-right one its left edge; a paragraph is **re-wrapped** in its old width with its alignment and
     its exact old line pitch (the engine's own CSS-like line boxes would drift when fonts are mixed, so baselines are
     placed at the pitch); the ribbon's font size and colour apply as for other edits; an empty text deletes the line;
   * **font**: the document's own embedded font program is reused when it can shape the new text by itself (TrueType
     or OpenType program, licence bits allow editable embedding and subsetting, every character has a glyph with an
     outline, a GSUB table for scripts that need substitution, and a dual-joining letter really takes its joined form).
     Producer subsets (LibreOffice, Chromium/Edge/Skia, pdf-lib, Epdf's own engine) keep only the glyphs used and drop
     the shaping tables, so in practice this happens with fully embedded fonts. Otherwise the closest **bundled** fonts
     are used, per piece of text: letters of the script get the document font's family when Epdf has it (Noto Naskh /
     Sans Arabic, Noto Sans Hebrew, Arial -> Liberation Sans, Times New Roman -> Liberation Serif), else **Noto Naskh
     Arabic** for Naskh-like fonts (Arial, Times New Roman, Traditional/Simplified Arabic, Amiri, ...) or **Noto Sans
     Arabic** for sans fonts (Tahoma, Segoe UI, Dubai, ...), Noto Nastaliq Urdu for Nastaliq fonts; digits, Latin and
     punctuation get the family of the line's Latin text when Epdf has it, else Liberation Sans / Serif by style. The
     first such edit in a document says so once — *"Font not available in this PDF — used Noto Naskh Arabic (the
     document’s font only contains the letters the document used)"*; later ones only *"Edited — drawn with …"*.

Refused (outlined dashed, with the reason): lines on rotated pages or rotated text, lines drawn partly in a form and
partly on the page, shared forms, text objects without `ET`, characters no font can read (the line's text would be
incomplete), and `/ActualText` spans that also cover text outside the block (a paragraph containing both lines is
fine).

### Image operations

* **Move/resize** edit the `cm` in front of the image (when the image is exactly `q … cm /Im Do Q`) or wrap the
  `Do` in `q <cm> … Q`, so no other content is affected. Resizing needs an axis-aligned (or 90°-multiple) image;
  arbitrarily rotated images can only be moved. Works on rotated pages (positions convert through the viewport).
* **Delete** removes the `Do`/inline image (and its `q cm … Q` wrapper). If nothing else references the picture
  (this page, other pages, shared resource dictionaries) the XObject, its soft mask and its resource entry are
  dropped too; otherwise the data stays for whoever still uses it.
* **Replace** (native dialog through `imageedit:pickImage`) embeds the PNG/JPEG and draws it in the old box:
  *Fit* keeps its aspect ratio inside the box, *Fill* covers the box and clips the overflow.
* **Add** appends a new content stream (after closing any unbalanced `q` of the page) with the picture centred at
  the clicked point (or the page centre), at 96 dpi up to half the page size.

The main channel `imageedit:pickImage` takes an empty (strict) payload, shows the dialog itself, checks the file
signature (PNG/JPEG only, at most 40 MB) and returns `{ name, kind, bytes }`. The renderer can never name a path.

## Limits (what is *not* supported, and what you see)

| Situation | Behaviour |
|---|---|
| Scanned pages / images of text | No text to edit: banner "No editable text on this page…"; clicking the page repeats it as a message. |
| OCR layers (render mode 3, invisible text) | Ignored; the banner says the page only has an invisible text layer. |
| Text drawn as vector paths (outlined fonts, some logos, many CAD/print exports) | Not text; nothing to select. |
| Type 3 fonts | Outlined dashed with "it uses a Type 3 font"; cannot be edited. |
| Vertical writing, predefined CJK CMaps (`90ms-RKSJ-H`, ...), Type0 fonts without `/ToUnicode` | Refused with the reason. |
| Fonts with no usable character mapping (embedded, no `/Encoding`, no `/ToUnicode`) | Refused: the letters cannot be read reliably. |
| Characters without a Unicode value in a block | Refused. |
| Rotated, skewed or mirrored text; any text on a page with `/Rotate` ≠ 0 | Shown as not editable ("rotate the page back to 0° first"). Images on rotated pages are supported. |
| Text in a Form XObject that is drawn more than once or referenced from elsewhere | Refused (a change would alter every copy). Single-use forms are editable. Same for images in such forms. |
| Marked content whose `/ActualText`/`/Alt` lives in a `/Properties` resource | Refused (cannot be rewritten in place). |
| Right-to-left and complex scripts | Existing lines and paragraphs are edited as logical text and redrawn by the text engine (above). The whole line (or paragraph) is redrawn, usually in a bundled Noto font, not only the changed word, so its look can change slightly next to untouched lines of the old font. The document's own font is only reused when its embedded program can shape the new text (rare for producer subsets). A rewritten paragraph that needs more lines grows downwards and can overlap what is below it; there is no reflow of the rest of the page. Tables drawn as one line are edited cell by cell only where the model splits them into lines. Lines with characters no font can read are refused. |
| Colours other than DeviceGray/RGB/CMYK (ICC, Separation, patterns) | Replaced text is drawn in the closest DeviceRGB colour. In-place edits keep the original. |
| Per-run styling inside one block | In-place edits keep it. Replace uses the first run's font/size/colour for the whole block. |
| Kerning inside replaced text | Not kept (the new font's own advance widths are used). |
| A line that became wider | Not reflowed in place; may overlap neighbouring text (there is no reflow across separate lines of a line block). |
| Structure tree (`/StructTreeRoot`) alt/actual text, outlines, annotations, XMP | Not searched or rewritten: they may still contain the old words. |
| Encrypted documents | The tools show the same "password protected" message as other edits. |
| Very large pages (> 3 million operators) | Refused as too complex. |

Other things to know:

* The document's old font program is left in the file (other text or later edits may use it); only text-showing
  operations and the page content are changed.
* Analysis parses the whole file once per version of the document with pdf-lib (like every other edit); it only
  runs while one of the two tools is active.
* Bundled font: **Noto Sans** Regular/Bold/Italic/BoldItalic (`src/renderer/src/features/textedit/fonts/*.ttf`),
  Copyright 2018 The Noto Project Authors, licensed under the **SIL Open Font License 1.1** (full text in
  `fonts/OFL.txt`; OFL fonts may be bundled and embedded in documents, and may not be sold on their own). Source:
  https://github.com/notofonts/notofonts.github.io (`fonts/NotoSans/hinted/ttf`). Nothing is fetched at run time.
* New dependencies (both **MIT**, dev-dependencies bundled by Vite): `@pdf-lib/fontkit` 1.1.1 (embedding the
  Unicode font) and `@pdf-lib/standard-fonts` 1.0.0 (standard-14 metrics; already a dependency of pdf-lib, now
  imported directly).

## Keyboard and accessibility

* Text blocks and images are focusable buttons (Tab); Enter/Space starts editing a block or selects an image.
* Text editor: **Enter** applies, **Shift+Enter** inserts a line break, **Escape** cancels (the tool stays active;
  Escape again leaves the tool). Moving to the ribbon's font size / colour controls keeps the editor open;
  **Apply**/**Cancel** buttons are there too.
* Images: arrow keys move the selected image by 1 pt (Shift: 10 pt); a burst of key presses is one undo step.
  **Delete** removes it. The ribbon has exact **X / Y / W / H** fields in points (Y from the bottom), *Keep ratio*,
  *Replace… / Replace as Fit|Fill*, *Delete* and *Add image…* (then click the page or *Place at page center*).
  The drag handles (Shift keeps the aspect ratio) are a pointer convenience; every action has a keyboard path.
* Results are announced as toasts (live regions): the strategy used for text, and errors.

## Manual test

1. Open any PDF made by a word processor, **Edit text**, hover a line (outline), click it, change a word,
   Enter → "Edited using the document’s own font". Undo, Redo, Save, reopen: the word is changed and the old
   word cannot be found with search or by copying text.
1a. Open an Arabic PDF (from Word, LibreOffice or a browser), **Edit text**, click an Arabic line: the editor shows
   it as you read it, right to left. Change a word, Enter: the line is redrawn at the same place, right-aligned, in
   the same size and colour ("Font not available in this PDF — used Noto Naskh Arabic (…)" the first time). Copy the
   line in the viewer, search for the new word, Undo/Redo, Save and reopen.
2. Type a character the document's font lacks (for example `Ω` in a Helvetica document) → "Font not available in
   this PDF — used Noto Sans" (or Helvetica for Latin-1 text).
3. Change the size/colour in the ribbon while the editor is open, Apply.
4. *Edit: Paragraph*, click a paragraph, rewrite it: it re-wraps inside the old width.
5. Click on a scanned page → "No editable text on this page…". Rotate a page → text is outlined dashed with the
   reason; images still work.
6. **Edit images**: drag/resize (Shift), arrow keys, Delete, Replace… (Fit/Fill), Add image… then click, X/Y/W/H
   fields. Save and open the result in another viewer.

## Tests

* Unit (`tests/unit/editcontent-*.test.ts`, Node): tokenizer, serializer and 500-stream fuzz round trips
  (`tokenizer`), pdf-lib generated streams (standard fonts, embedded Type0 subsets, embedded pages, images) and
  an opt-in corpus check (`EPDF_CORPUS_DIR=<folder of PDFs> npm test -- editcontent-roundtrip`), state tracking and
  geometry, block grouping, fonts/CMaps/encodings, in-place and replace edits, refusals and failure injection,
  producer-shaped documents (Word, Chrome/Skia, LibreOffice, pdfTeX, scanners), image math and edits, and
  **PDF.js cross-checks** (positions, widths and extracted text of original and edited files).
* E2E (`tests/e2e/edit-content.spec.ts`): the UI flows above against fixtures from
  `tests/fixtures/edit-content.mjs`, always verifying the saved file with pdf-lib and PDF.js, plus axe scans
  (light and dark).
* Right-to-left editing (`tests/unit/editcontent-rtl.test.ts`, read back with the page text model): every corpus line
  of the LibreOffice, Chromium, text-engine and legacy presentation-form fixtures (`tests/fixtures/pagetext`) is one
  editable block with its logical text; a dozen kinds of edits (word replaced, numbers/dates/Latin in brackets,
  tashkeel, Arabic-Indic digits, lam-alef and punctuation, Latin words, a left-to-right line with an Arabic word,
  Persian, Urdu, Hebrew with and without niqqud, Devanagari) read back exactly, the old line is gone (also from every
  `/ActualText`), every other line is untouched; right edge / left edge, baseline and size kept; RGB, CMYK and gray
  kept, ribbon size and colour applied; deletion; a `TJ` shared by two table cells; paragraphs re-wrapped in the old
  width and pitch (three producers) and a two-column page; font reuse (full embedded font) and fallback (subsets);
  live cross-checks with **headless Microsoft Edge** (Segoe UI, Tahoma, Arial, Times New Roman, colour, a
  left-to-right line) and **LibreOffice** (skipped when not installed). E2E: `tests/e2e/edit-content-rtl.spec.ts`
  (right-to-left editor anchored at the right edge, messages, undo/redo, save, paragraph scope, axe).
