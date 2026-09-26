# Headers and footers, Bates numbering, watermarks and backgrounds (feature 21)

**Document ▸ Header and Footer… / Bates Numbering… / Watermark… / Background…**, or the **Page marks** group of the
Tools ribbon, open one dialog with a tab for each kind. **Document ▸ Remove Headers and Footers / Remove Bates
Numbering / Remove Watermarks / Remove Backgrounds** take them off again. Every Apply, Update and Remove is one undo
step; nothing reaches the file until you save. Password-protected documents are unlocked first (the Security feature's
hook) and stay encrypted when saved.

## What you can add

| Kind | Options |
|---|---|
| Header and footer | Six text boxes (left, centre, right at the top and at the bottom), any script, several lines. Font from the bundled fonts, size, colour, bold/italic; margins from the edges of the visible page; text direction (automatic from the text, left to right, right to left); page range, all/odd/even pages; the number of the first page. |
| Tokens | `{page}`, `{pages}` (the number of the last page of the range), `{date}` (the day you apply it), `{file}` (the document's file name), `{bates}`. `{{` and `}}` write literal braces. Buttons insert them (and ready-made "Page 1 of N" and "صفحة ١ من N") at the cursor of the last text box used. |
| Page numbers | 1, 2, 3 · I, II, III · i, ii, iii · Arabic-Indic ١، ٢، ٣ · Persian ۱، ۲، ۳. Roman numerals cover 1-3999; other numbers are written with Western digits. |
| Dates | 26/9/2026 · 9/26/2026 · 2026-09-26 · 26.09.2026 · 26 September 2026 · September 26, 2026; English or Arabic month names (يناير … ديسمبر); Western, Arabic-Indic or Persian digits (e.g. ٢٦ سبتمبر ٢٠٢٦). |
| Bates numbering | Its own tab and its own marks (so a document can have both a header and Bates numbers): prefix, suffix, number of digits (zero padded, never cut), start number; placed in any of the six boxes (bottom right by default). Numbers count the stamped pages: pages 2-5 starting at 41 get 41, 42, 43, 44. |
| Watermark | Text (several lines, any script), a PNG/JPEG picture, or a page of another PDF (shown the way a reader shows that page: its /Rotate and crop box are honoured). Rotation (counter-clockwise, as you see the page), opacity, scale relative to the page (the rotated mark fits into that % of the page) or of its own size, position (left/centre/right, top/centre/bottom, then move right/up in points), behind or in front of the page content, page range and odd/even, show on screen / show when printing. |
| Background | A colour, a picture or a PDF page; opacity, scale, position, rotation, page range; always behind the content. |

**Right-to-left text.** Everything is drawn by the text engine (`src/shared/text`, see `docs/text-engine.md`): Arabic is
shaped (joining forms, lam-alef) and laid out right to left, numbers inside it stay in reading order, and mixed
Arabic/Hebrew/English lines follow the Unicode bidi algorithm. "صفحة {page} من {pages}" with Arabic-Indic numbers gives
"صفحة ١ من ٣" as an Arabic reader expects. The boxes are *physical* positions: the right box is right-aligned at the
right margin whatever the language. The direction setting decides the paragraph direction when the text mixes
scripts ("Page 1 صفحة" reads left to right with *LTR*, right to left with *RTL*); *Automatic* takes it from the first
letter. Characters no bundled font covers are drawn as the font's missing-glyph box and reported after Apply.

**Page geometry.** Marks are placed on the *visible* page (CropBox clipped to MediaBox), upright as the reader sees
it: on a page with /Rotate 90 the header is at the top of the landscape page you see, not along the side. Pages of
different sizes each get their own placement.

**Presets.** Any tab's settings can be saved under a name, loaded and deleted (kept in Epdf's settings database). A
preset of a picture or PDF-page watermark keeps the file too, up to 4 MB. The dialog also remembers the settings last
applied per tab.

**Preview.** The dialog draws the chosen page (the current page by default; any page can be typed in) with the marks
exactly as Apply will write them: the same code runs on a copy of that page, numbered as that page of the document.

**Update and remove.** When the document already has marks of that kind added by Epdf (also from an earlier session:
the settings are stored in the file), the dialog says so, shows their settings, and offers *Replace them (update)*
(default) or *Keep them and add another*. Update keeps the picture or PDF page of an earlier watermark if you do not
choose a new file. Headers, footers, watermarks and backgrounds added by Acrobat (and other software that marks them the
same way) are recognised too: *Replace* and *Remove* take them off as well (not for Bates, which Acrobat stores as a
header/footer). Removing deletes the objects only the marks used (their forms, fonts, pictures, settings, optional
content groups), so nothing of a removed watermark stays in the saved file.

**Large documents.** On 500 pages Apply takes about 1.5 s in the app on the development machine (header + footer with
page numbers and an Arabic header, including saving the undo snapshot); a progress line and Cancel appear while it
runs. Cancel leaves the document unchanged. Fonts are embedded once per document as subsets; a watermark on 500
same-size pages adds about 5 KB (one shared form).

## How it is written into the PDF (and why)

Each mark on a page is **one Form XObject** drawn from a small content stream of its own:

```
/Artifact << /Type /Pagination /Subtype /Header /EpdfMark /HeaderFooter >> BDC
q /EpdfMk0 Do Q
EMC
```

* **Tagged-PDF artifacts** (ISO 32000-1 14.8.2.2): headers/footers and Bates numbers are `/Type /Pagination /Subtype
  /Header` or `/Footer`; watermarks `/Type /Pagination /Subtype /Watermark`; backgrounds `/Type /Background` with the
  `/BBox` the standard requires for that type. These are the same artifact types Acrobat writes, so screen readers,
  reflow, "save as text", accessibility checkers and text extraction that honours artifacts treat them as page
  decoration, not body text. `/EpdfMark` is Epdf's own key in the property list (other readers ignore unknown keys).
* **`/PieceInfo` on the Form XObject** (ISO 32000-1 14.5, page-piece dictionaries), with two entries:
  * `ADBE_CompoundType << /Private /Header|/Footer|/Watermark|/Background /LastModified (D:…) >>`: the entry Acrobat
    puts on its own headers, footers, watermarks and backgrounds and uses to find them (e.g. for its Remove commands).
    Epdf does not write Acrobat's private `/DocSettings` (its layout is not public), so Acrobat's *Update* dialog cannot
    show Epdf's settings; *Remove* should find them. **Not verified in Acrobat** (see below).
  * `EpdfPageMarks << /LastModified … /Private << /Group /HeaderFooter|/Bates|/Watermark|/Background /Band /Header|/Footer
    /Settings <ref> /Source <ref> /Id (…) >> >>`: Epdf's own data. `/Settings` is one compressed JSON stream per
    application (shared by all its pages) holding exactly what the dialog showed; `/Source` is the picture/PDF-page
    form so an update can reuse it.
* **Optional content** for watermarks and backgrounds, like Acrobat's: an OCG named "Watermark" or "Background" with
  `/Usage << /PageElement << /Subtype /FG|/BG >> /Print << /PrintState … >> /View << /ViewState … >> /Export … >>`,
  ON in the default configuration, with `/AS` auto-states for the View, Print and Export events. "Show on screen" and
  "Show when printing" set the view/print states. PDF.js (the Epdf viewer, and Epdf's printing, which renders with
  the print intent) follows them.
* **Layering.** Backgrounds are the first content streams of the page, behind-watermarks come next, then the page's
  own content, then front marks. The original content is wrapped once in `q … Q` (streams marked `/EpdfMark /WrapOpen`
  and `/WrapClose`) so its graphics state (a leftover `cm`, colour, clip) cannot leak into the marks. Opacity is applied
  to a mark as a whole (an isolated transparency group), so overlapping glyphs and picture pixels do not darken.
* **Reader space.** Each mark's form has a `/Matrix` that maps the visible page, upright as displayed, to the page's
  user space for its /Rotate (0/90/180/270) and box offsets, and a `/BBox` of the visible page (nothing spills outside).
* **Text** goes through `makeTextXObject` of the text engine: Type0/Identity-H subset fonts shared by the whole
  document, `/ToUnicode`, and `/ActualText` for right-to-left lines. Identical text at the same width (a static header,
  a watermark) is laid out and embedded once; pages with the same geometry share one watermark form; identical small
  content streams are shared between pages.
* **Removal** does not depend on Epdf's separate streams surviving: it parses the page's content (the edit-content
  engine's parser), cuts every `/Artifact` marked-content sequence that draws a mark XObject (a stray `Do` of one is cut
  on its own), keeps the q/Q nesting of the rest intact (Acrobat writes `q /Artifact … BDC … Q EMC`, which is not nested),
  gives the page a new stream (shared streams are never edited in place), deletes the resource names, and then deletes
  the objects that nothing reachable from the document uses any more among those the marks used.
* Pages whose resources are shared with other pages or inherited from the page tree get their own copy before a
  name is added, so a mark on one page never appears in another page's resources.

## Files

```
src/shared/features/headerfooter.ts           settings schemas (zod), defaults, preset and channel schemas
src/main/features/headerfooter/               presets + last settings (ctx.kv), picture/PDF picker, menu items
src/renderer/src/features/headerfooter/
  index.tsx store.ts actions.ts               commands, ribbon buttons, edit-pipeline actions
  Dialog.tsx Forms.tsx Fields.tsx icons.tsx   the dialog
  preview.ts                                  PDF.js rendering of the preview
  pdf/                                        pure pdf-lib + text engine: tokens, geometry, marks, apply, remove, ops, preview
tests/unit/headerfooter-*.test.ts             tokens, geometry (judged by PDF.js viewports), marks/remove/update, sources, presets, 500 pages, sample PDFs
tests/e2e/headerfooter.spec.ts                the real app
tests/fixtures/headerfooter.mjs               fixture PDFs and a PNG
```

No new dependencies. Nothing is installed or downloaded at run time; fonts are the bundled ones.

## Testing

* `npx vitest run tests/unit/headerfooter` — tokens in every number system and date format; placement on rotated
  (0/90/180/270/-90), offset and cropped pages and mixed sizes, checked against PDF.js's own viewport (the text must be
  upright at the expected place of what the reader sees); PDF-page sources with every /Rotate; artifact and PieceInfo
  structure; Arabic header glyphs identical to the text engine's own rendering, in right-to-left visual order, with the
  logical text in ActualText and in PDF.js extraction; Hebrew; Bates; behind/front ordering; transparency group;
  optional content per intent (PDF.js); remove/update/add round trips on saved-and-reopened files (no text, objects,
  fonts or OCGs left; merged content streams; Acrobat-style marks with non-nested q/Q); shared/inherited resources;
  presets; 500 pages (time, progress, cancel, one subset per font, size).
* `npx playwright test tests/e2e/headerfooter.spec.ts` — in the real app, checking the rendered page pixels: the Arabic
  header "صفحة ١ من ٣" at the top centre and, rendered by PDF.js, compared with Chromium's own rendering of the same
  line in the same font (NCC 0.99; a negative control with unjoined letters in the wrong order scores 0.60); Hebrew and
  mixed text on a /Rotate 90 page and a cropped page (upright: compared with the upright page, and a 180° turned copy
  must not match); Bates on 3 pages from the ribbon; a red text watermark behind an opaque block (hidden there) and a
  blue picture in front (on top); background colour on a page range; print-only watermark hidden on screen; a page of
  another PDF as the watermark; a file that is not a picture; undo/redo; save, reopen, update from the stored settings,
  presets across a restart, remove; an encrypted document (stays encrypted, marks inside); 500 pages with progress and
  Cancel; axe (light and dark, every tab) and keyboard.
* Manual: open a document, **Document ▸ Header and Footer…**, type `صفحة {page} من {pages}` in *Header center*, choose
  *Page numbers: ١، ٢، ٣* and *Font: Noto Naskh Arabic*; the preview shows it; Apply; Undo/Redo; Save; reopen and open
  the dialog again (it shows the saved settings, *Update*); **Document ▸ Remove Headers and Footers**.
  `tests/unit/headerfooter-artifacts.test.ts` writes `test-results/headerfooter/winpdf-sample*.pdf` (Arabic header,
  Hebrew footer, translucent rotated Arabic/English watermark, picture, background; upright and /Rotate 90) for looking
  at with other readers.

## Limits and what was not verified

* **Acrobat was not available**: the Acrobat-compatible marking (artifact types, `ADBE_CompoundType`, the OCG usage)
  follows Acrobat's documented/observed structure but was not opened in Acrobat. Whether Acrobat's *Remove* finds
  Epdf's marks, and how its *Update* reacts to the missing `/DocSettings`, is unknown. Acrobat-made marks were tested
  with hand-built files of the same structure, not with files made by Acrobat.
* Rendering was checked with PDF.js (app) and Windows' own PDF engine (Windows.Data.Pdf, manually: the sample PDFs,
  upright and rotated). Not checked: Acrobat, Chrome/pdfium, macOS Preview, printing on paper.
* Print/screen visibility relies on viewers honouring optional-content usage (PDF.js and Acrobat do; some simple viewers
  ignore it and show everything).
* **Bates numbering across several documents is not implemented** (one document at a time; you can continue a
  sequence by setting the start number). Acrobat's options *shrink the page to fit the header*, *use page labels* and
  *appearance of the date as a field that updates* are not implemented; the date is fixed when you apply.
* Headers wrap at the space between the side margins; very long text therefore grows downwards (top) or upwards
  (bottom) into the page rather than being shrunk.
* An image watermark's "own size" treats one pixel as one point.
* The Hebrew default is the bundled Noto Sans Hebrew; scripts without a bundled font (e.g. Tibetan) are reported as
  missing characters.
* Removing a mark keeps Epdf's two tiny `q`/`Q` wrapper streams on the page (harmless; later front marks reuse them).
