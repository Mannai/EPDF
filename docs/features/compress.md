# Reduce File Size (compression)

Feature 13. **File ▸ Reduce File Size…** (`compress.open`) and **File ▸ Reduce Several Files…** (`compress.batch`).
Everything is in-house: `pdf-lib` (MIT), `fflate` (MIT) and Chromium's own image decoder. **No Ghostscript, no qpdf, no external
program, no new dependency.** The only native code involved is the browser's JPEG decoder, which is part of Electron.

## What the user gets

A dialog for the open document with four choices and live numbers:

| Preset | Colour / gray images | 1-bit scans | JPEG quality | Also |
|---|---|---|---|---|
| **High quality** | reduced above 300 dpi (x1.25 tolerance) | 600 dpi | 85 | thumbnails and private data kept |
| **Balanced** (default) | 150 dpi | 300 dpi | 70 | thumbnails and PieceInfo removed |
| **Smallest file** | 96 dpi | 200 dpi | 50 | + fonts trimmed, document properties / XMP and legacy extras removed |
| **Custom** | any | any | any | every toggle below |

* **Current size**, **estimated size** and **saved %** update instantly as options change (the estimate comes from a quick
  analysis of where the bytes are; it is labelled "≈" and is deliberately rough).
* **Reduce file size** runs the real job in a Web Worker with a progress bar and **Cancel**; afterwards the dialog shows the
  **exact** new size and percentage (`data-exact="true"`).
* **Apply** commits the result through `replaceBytes` as **one undo step "Reduce file size"** (Undo/Redo work; nothing is written
  to disk until Save). **Change settings** returns to the options; **Cancel** discards the result.
* A toast summarises: `12.4 MB → 3.1 MB, saved 75%`.
* **Never larger:** if the rewritten file is not smaller the original is kept and the dialog says so
  ("This document is already as small as it can be made with these settings"); Apply is not offered.
* Password-protected documents: `ensureEditable(docId)` runs first; if the document stays locked a toast explains why nothing
  happened. Signed documents get a warning (rewriting the file invalidates the signature). Files over 1 GB are refused with a message.
* **Reduce Several Files…**: choose PDFs in a native dialog, pick a preset, and each result is written **next to its original** as
  `name (reduced).pdf` (`(reduced 2)`, … — an existing file is never overwritten, the original is never modified). Per-file
  status: reduced / already small / skipped (password protected) / failed; overall progress with Cancel; a summary toast.

## Techniques

### Images (the only lossy part)

Implemented in `pdf/images.ts`, `pdf/scan.ts`, `pdf/raster.ts`, `pdf/jpegEncode.ts`, `pdf/jpegDecode.ts`, `pdf/inline.ts`.

1. **Effective resolution from the CTM.** `pdf/scan.ts` walks every page's content stream (through the pure content-stream engine of
   `features/textedit/pdfcontent/`, imported read-only), tracking `q`/`Q`/`cm`, recursing into Form XObjects (with their `/Matrix`),
   annotation appearance streams (BBox→Rect mapping) and honouring `/UserUnit`. The resolution of an image is measured along the
   transformed unit vectors, so rotation and skew are handled. When an image is placed several times, the **largest placement**
   (lowest dpi) decides how far it may be reduced. Images used where their size cannot be known (tiling patterns, Type 3 glyphs,
   unparseable content, budget exhausted) are **never resampled**.
2. **Decide per image** (`optimizeImage`): images below `minImageBytes` (6 KB) are skipped; a colour/gray image above
   `target x 1.25` dpi is box-filter downsampled (streaming, one output image of memory) to the target; photographs are re-encoded
   as JPEG at the preset quality, graphics / screenshots / anything with flat regions stay **lossless Flate with PNG predictors**
   (photo-vs-graphic is decided from distinct values and how often neighbouring pixels repeat exactly). Existing JPEGs are
   re-encoded only when reduced or when their estimated quality (from the quantisation tables) is clearly above the target.
   A replacement is used **only if it is smaller** (JPEG re-encodes without reduction must be at least 10 % smaller).
3. **What is protected:** `DeviceGray/RGB/CMYK`, `CalGray/CalRGB` and `ICCBased(1|3|4)` may become JPEG (the colour-space object,
   including the ICC profile reference, is kept untouched); `Indexed` images are only touched when they must be reduced and are then
   expanded to their base space (and left alone if that is not smaller); `Separation`, `DeviceN`, `Lab` are only reduced losslessly;
   `/Decode` arrays, `/Intent`, `/Interpolate`, `/Matte` are preserved (an SMask with `/Matte` and its parent are skipped); soft masks
   are reduced on their own as 8-bit gray **Flate, never JPEG**; explicit `/Mask` streams and `/ImageMask` stencils stay 1-bit
   (thresholded at 28 % ink so one-pixel rules survive a 3x reduction); colour-key masks (`/Mask [..]`), 16-bit, JPX, CCITT, JBIG2
   and images over 120 megapixels are left as they are.
4. **CMYK** is handled properly: Flate CMYK becomes a 4-component JPEG with an Adobe marker (no colour transform) and CMYK JPEGs are
   decoded with the in-house decoder (Chromium cannot give raw CMYK); `/Decode` is kept.
5. **Inline images** (`BI … ID … EI`) of at least 4 KB are converted to ordinary image XObjects (same pixels, colour space,
   placement) so they are reduced like any other picture; small ones (icons, glyph bitmaps) stay inline.
6. **JPEG codec (in-house):** `jpegEncode.ts` is a baseline encoder with optimised Huffman tables, 1 / 3 / 4 components and 4:2:0
   subsampling; `jpegDecode.ts` decodes baseline and progressive JPEG. In the app, colour/gray JPEGs are decoded by Chromium
   (`createImageBitmap`, no colour management) with the pure decoder as fallback; CMYK always uses the pure decoder.

### Structure (lossless)

`pdf/structure.ts`, `pdf/graph.ts`, `pdf/writer.ts`.

* **Unused objects** are dropped: the writer emits only what is reachable from the trailer and renumbers densely.
* **Deduplication** by hash + byte comparison with a fixed-point over references (two identical font dictionaries pointing at two
  identical font programs collapse). Candidates: streams, arrays, and dictionaries of type Font / FontDescriptor / ExtGState /
  Encoding / CMap / ColorSpace / Pattern / XObject and function / shading dictionaries. Pages, annotations, form fields, outline
  items, page **contents** and annotation **appearance streams** are never merged.
* **Re-deflate at level 9** (`fflate`): uncompressed streams are deflated; ASCII85 / hex / LZW / run-length chains become Flate;
  Flate streams are inflated and re-deflated with their predictor parameters untouched. Only smaller results are used.
  Metadata streams are never compressed.
* **Object streams + compressed xref stream** (PDF 1.5+): `writer.ts` is our own serialiser (pdf-lib's cannot drop or renumber
  objects); streams are never put in object streams; classic tables are written when object streams are switched off.
* **Optional removals** (each a toggle): document metadata (XMP everywhere; Info reduced to Title and dates), thumbnails (`/Thumb`),
  page-piece info (`/PieceInfo`), JavaScript (name tree, OpenAction, `/A` and `/AA` JavaScript actions), unused named destinations
  (name tree and legacy `/Dests`; skipped automatically when the document has scripts or Named actions), and legacy extras
  (`/Extensions`, `/SpiderInfo`, `/PresSteps`, image `/Alternates`, `/OPI`).

### Fonts (Smallest preset / Custom toggle)

`pdf/ttf.ts` + `pdf/fonts.ts`. Fully embedded **TrueType** fonts in `Type0 / CIDFontType2 / Identity-H|V` (what pdf-lib and many
Office exporters write) are pruned **keeping glyph ids**: unused glyphs get an empty outline, used glyphs (and the components of
composite glyphs such as é) are copied byte for byte, GSUB/GPOS/GDEF/kern/… are dropped, checksums are rebuilt and the font gets
a subset tag. Because ids do not change, no text is re-encoded. A font is touched **only if every use of it has been read**: it must
appear only in the Font resources of pages, forms and patterns that were parsed successfully (no AcroForm `/DR`, no ExtGState
fonts, no unparseable content, private CIDFont/descriptor/file, ≥ 24 KB). Text still copies and searches (ToUnicode is untouched),
but such a font can no longer supply other characters when the text is edited later, which is why it is off in High and Balanced.
Not handled: simple (single-byte) TrueType, CFF/OpenType, Type 1, colour fonts (left whole).

## Code map

```
src/renderer/src/features/compress/
  index.tsx            commands (compress.open, compress.batch) + dialogs
  CompressDialog.tsx   presets, custom options, live sizes, progress, Apply/Cancel
  BatchDialog.tsx      several files
  store.ts / batch.ts  dialog flows (zustand), replaceBytes, toasts
  client.ts            Web Worker client (analyze / compress, cancel = terminate)
  worker.ts            the worker entry; browserCodec.ts = Chromium JPEG decoding
  pdf/                 PURE logic (no DOM, no pdfjs-dist; unit-testable in Node)
    compress.ts        the pipeline (load, removals, inline→XObject, images, fonts, re-deflate, dedupe, write, verify)
    analyze.ts         document analysis + estimateSize()
    options.ts         CompressOptions, presets, sanitising
    scan.ts images.ts inline.ts raster.ts jpegEncode.ts jpegDecode.ts jpegInfo.ts codec.ts
    structure.ts graph.ts streams.ts writer.ts fonts.ts ttf.ts
src/main/features/compress/  menu items + batch channels (batchPick / batchRead / batchWrite behind tokens)
src/shared/features/compress.ts  zod schemas for the batch channels
tests/unit/compress*.test.ts  tests/e2e/compress.spec.ts
```

Channels: `compress:batchPick`, `compress:batchRead`, `compress:batchWrite` (renderer never supplies a path: files are chosen in a
native dialog, main hands back opaque tokens, results are created exclusively next to the source). No shortcut keys.

The pipeline finishes by **re-loading its own output** with pdf-lib and checking the page count; on any failure, or if the result is
not smaller, the original bytes are returned untouched.

## Measured results

Real JPEG photographs (1920 x 1200, quality about 97, 0.5 MB, taken from the Windows wallpaper folder and embedded on one page):

| Placed at | High | Balanced | Smallest |
|---|---|---|---|
| 200 dpi | 68 % smaller | 86 % | 94 % |
| 300 dpi | 68 % | 92 % | 97 % |

Other fixtures (numbers are from the tests, see the e2e log lines `[ratio]`, `[stress]`, `[visual]`):

* 3-page report with a Flate photo, a 400 dpi JPEG, a duplicated picture and a graphic (4.18 MB): High 0.41 MB (90 %), Balanced
  0.05 MB (99 %), Smallest 0.01 MB (100 %). The pictures are synthetic smooth noise, which is far easier to compress than real
  photographs: treat these as upper bounds. Rendered difference from the original (mean absolute pixel difference of 255):
  0.0-0.6 for whole pages, 0.6 / 1.4 / 2.0 inside the photo for High / Balanced / Smallest.
* Fully embedded Noto Sans (620 KB font, 4 short pages): 0.32 MB -> 0.06 MB with *Smallest* (fonts trimmed), rendered text
  pixel-identical.
* 24 pages, each an incompressible 1800 x 1200 photo at 300 dpi: **139 MB -> 2.2 MB in 3-5 s**, longest gap between animation
  frames of the UI while it ran: about 30 ms (the work is in a Web Worker).
* Documents that are only text (e.g. the 500-page `large.pdf`): about 1 % (metadata, object streams); nothing else to remove.

## Limits and honest caveats

* Damaged files are refused, not repaired: the parser is strict, so a file with unreadable objects is reported as damaged and left
  exactly as it is (a tolerant parse would rewrite it without the parts it could not read).

* Reducing a document rewrites the whole file: digital signatures no longer verify (the dialog warns), incremental-update history
  is dropped, and byte offsets change.
* Lossy work is limited to images (downsampling and JPEG) and, if you choose it, removals. Nothing else changes the look.
* The estimate is a heuristic. On the synthetic fixtures it is within roughly 0.4x–4x of the real result; the exact size is always
  shown after the run.
* Memory: parsing plus rewriting needs several times the file size in the worker; files over 1 GB are refused. A worker that runs
  out of memory is reported as an error (very large images can still exhaust the renderer's memory). A stream that would
  inflate to more than 768 MB (a decompression bomb) is treated as undecodable and left alone.
* Verified with the production build (`out/`, strict CSP, custom protocol) only; the worker is an ordinary Vite `?worker` asset
  and needs no `extraResources`, but no electron-builder package was run here.
* JPEG: 8-bit Huffman JPEG only (no arithmetic / 12-bit / lossless); such images are left as they are.
* **Linearization ("Fast Web View") is NOT implemented.** A spec-correct linearized file needs hint tables and first-page
  ordering that we could not validate against an independent reference (qpdf is not allowed and none is available here); an
  incorrect one is worse than none, so the feature is absent.
* Fonts: only the TrueType/Identity-H case above; everything else is left whole.

## Tests

```powershell
npx vitest run tests/unit/compress          # unit (Node): codec, scan, images, structure, fonts, inline, batch, corpus, estimate
npx playwright test tests/e2e/compress.spec.ts
```

* Unit: JPEG encoder/decoder round trips and against PDF.js as an independent decoder (including a real progressive JPEG where
  Windows provides one), DPI from CTM (rotation, skew, forms, annotations, UserUnit), per-preset downsample decisions, colour-space
  and mask handling (Gray, ICC, Indexed, CMYK Flate/JPEG, SMask, stencil, colour key, Separation, Decode, 16-bit, corrupt data
  fuzz), deduplication (images, fonts, things that must not merge), unused-object removal with reachability check, object-stream
  round trips checked with pdf-lib **and** PDF.js legacy (page count, text, geometry), re-deflate correctness, every removal
  toggle, "never larger", inline images, font pruning validated glyph-by-glyph with fontkit, batch file access, and all fixture
  generators of the other features run through every preset.
* E2E: each preset through the real UI with the displayed size compared to the saved file, Apply/Undo/Redo/Cancel, visual
  similarity (pages rendered by PDF.js in fresh app instances, per preset thresholds), text still extractable, links / bookmarks /
  form fields / annotations preserved, every image flavour, trimmed font pixel-identical, batch mode (never overwrites, per-file
  errors), password-protected message, a 139 MB fixture generated at test time (reduced to 2.2 MB in ~3 s while the UI kept
  animating, plus Cancel mid-run) and axe scans (light and dark) of the dialogs.

## Manual test

1. Open a PDF with photos → **File ▸ Reduce File Size…** → the estimate appears; switch presets and watch it change.
2. **Reduce file size** → progress → exact new size → **Apply**; **Edit ▸ Undo** restores the original; **Save** writes it.
3. Choose **Custom**, set 72 dpi / quality 30, tick *Document properties*; check the result in another viewer.
4. Run it on the result again: "already as small as it can be".
5. **File ▸ Reduce Several Files…** with a few PDFs (one encrypted, one damaged) and check the `(reduced)` copies next to them.
