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
| Right-to-left and complex scripts | Existing text is edited in the order it is stored in the content stream (visual order) — editing existing Arabic/Hebrew text properly is a separate project. **New** Arabic, Hebrew, Indic, Thai or CJK text is drawn by the text engine (shaped, correct order, extractable). Kerning/ligatures of the old font are not kept for it. |
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
