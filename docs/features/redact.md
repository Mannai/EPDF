# Redaction

**Redaction permanently removes** text, image pixels, drawings, annotations, bookmarks and metadata from the file.
It never just draws a black box: the box is painted *after* the content underneath was destroyed.

* Tools ribbon group **Redact**: **Mark text**, **Mark area**, **Find and mark**, **Apply redactions…**
  (`order` 500-503, no keyboard shortcuts). Menu: **Tools ▸ Redact…**. Commands `redact.open`, `redact.apply`.
* Marks are translucent red boxes on the page; a right-hand **Redaction panel** lists them, edits areas by number,
  runs searches and starts the Apply. Nothing changes in the document until **Apply**.
* **Apply** is one undo step ("Undo Apply redactions") through `editPdf`, and only reversible **until the file is
  saved** (see "After saving").

## Using it

1. **Mark.**
   * *Mark text*: select text on the page; the glyphs under the selection become the mark (exact boxes, rotated text
     included; if a page has no readable text under the selection the rectangle becomes an area mark).
   * *Mark area*: drag a rectangle; select it to move/resize with the handles, the arrow keys (1 pt, Shift 10 pt,
     Alt+arrows resize) or the numeric **Left / Top / Width / Height** fields (points from the top-left of the
     displayed page). The panel's **Add an area** form creates one without the pointer (keyboard operable).
   * *Find and mark*: literal text (match case, whole word), a **built-in pattern**, or a **custom regular
     expression**; all pages or a page range; a review list where each match can be **Marked**, **Skipped**, or
     unmarked again; **Mark all** works on what the page filter shows. Hits that span runs or a line break are
     found (the box of each line is marked). Invisible OCR text is searched too (and flagged "hidden text").
   * Patterns: e-mail, phone (US/international), payment cards (**Luhn** checked), US SSN, national IDs (UK NINO,
     Canada SIN, Spain DNI/NIE, France INSEE, all checksummed), **IBAN** (country length + mod 97), dates (real
     dates only), URLs, IPv4/IPv6.
   * Custom regular expressions are validated as you type and run by an in-house **step-limited engine** (JavaScript
     syntax: classes, groups, alternation, lazy/greedy quantifiers, anchors, `\b`, back-references, look-ahead/
     look-behind, `\p{..}` with the u flag). A pattern that backtracks catastrophically, e.g. `(a+)+$`, is stopped
     after 4 M steps / 1.5 s with a clear message. Unsupported syntax is refused, never guessed.
   * Marks can be undone/redone (**Undo mark / Redo mark**), removed one by one, or cleared.
2. **Review and apply…** opens the dialog: fill colour, overlay text (none / "REDACTED" / custom), *All metadata*,
   *Hidden data*. **Preview** runs the whole redaction on a private copy, shows a summary ("Removed 14 text runs,
   2 images (regions), 3 annotations, metadata."), the result of the **self-check**, and a **Before / After** view
   of every marked page rendered by PDF.js (After comes from the redacted bytes). **Apply redactions** commits.
3. **Nothing is applied when the self-check fails**; the dialog lists what remains and where.

## What Apply destroys (guaranteed)

Content of the marked pages, per mark (a mark is a set of boxes or exact rotated quads in PDF user space):

| Content | What happens |
|---|---|
| **Text** (`Tj TJ ' "`), all fonts the engine can decode: standard, subset/embedded simple fonts, Type0/CID (Identity-H, embedded CMaps, mixed 1/2-byte codes, `/ToUnicode`) | glyphs whose box is at least **30 %** covered by the marks are cut out of the string; a `TJ` adjustment keeps every survivor at its original position (`'` and `"` are expanded). Covered glyph boxes are exact (a rotated word does not take its neighbours with it). |
| Text that cannot be cut reliably (font not readable: Type 3, vertical writing, Type0 without `/ToUnicode`, predefined CMaps, undecodable glyph under the mark, zero-size text) | **fail closed: the whole text operation is removed**, advance preserved |
| Invisible/OCR text (render mode 3) | removed like any other text |
| **Form XObjects** reached from the page, nested forms, soft-mask groups | processed per use and **copy-on-write**: a form shared with another page, another use or an unmarked area is copied and only the marked use points at the copy; original entries are dropped from the (private) resource dictionaries |
| Marked content `/ActualText /Alt /E` (inline properties or `Properties` resources) around removed content | keys removed |
| **Images** intersecting a mark | pixels under the mark **decoded, set to black, re-encoded** (Flate/LZW/ASCII85/ASCIIHex/RunLength sources → lossless Flate; baseline/progressive 8-bit RGB/gray JPEG → JPEG q95) for Gray/RGB/CMYK/ICCBased/Cal* at 1/2/4/8/16 bits, Indexed (black entry used/added/expanded), `/Decode`, image masks, **SMask and stencil `/Mask` cleared in the same region**; inline images become image objects; the image object is **copied before modifying** (shared images keep their pixels elsewhere) |
| Images that cannot be decoded safely (JPEG 2000, JBIG2, CCITT, CMYK/Lab/Separation JPEG, odd bit depth, huge, corrupt) | **fail closed: the image is removed entirely** and a solid box is drawn in its place; the summary says so |
| **Vector paths** | fully inside a mark: removed; partly inside: clipped so nothing paints under the mark (even-odd clip); unpainted paths under a mark are dropped; clipping paths that lie under a mark keep their effect but lose their shape |
| **Shadings / patterns** | axial/radial shadings and vector-only tiling patterns are clipped around the mark; anything that can carry text/pictures or data (tiling patterns with text/images, function/mesh shadings) is dropped where it paints under a mark and its object is deleted when unused |
| **Annotations** whose `/Rect` meets a mark (text, comments, links, widgets and their values, popups, replies) | removed, with their popups/replies; widgets are detached from their field and the AcroForm |
| Annotations/fields elsewhere that carry the redacted text (`/Contents /RC /T /Subj /V /DV /TU`, or text drawn in their appearance) | removed (widgets: value scrubbed, stale appearance dropped, `/NeedAppearances` set) |
| **Bookmarks, structure `/ActualText /Alt`, Info strings, form values, any other text string** containing the redacted text | the text is replaced by `[redacted]` (case/whitespace/encoding-insensitive) |
| **Named destinations** whose name contains the text | removed (name tree limits fixed up) |
| **XMP** mentioning the text | rewritten with `[redacted]`; unreadable XMP is dropped |
| **Thumbnails, `/PieceInfo`, page `/Metadata`** of redacted pages | removed |
| **JavaScript** that mentions the redacted text | removed |
| Option **All metadata** | Info dictionary emptied, XMP, `/PieceInfo`, `/Metadata` streams, thumbnails of every page |
| Option **Hidden data** | all JavaScript (open action, additional actions, name tree), attachments (name tree + attachment annotations, `/EF`), page labels, `/TU` tooltips, XFA, associated files, collections |
| **Everything else in the file** | the document is **rewritten from scratch** (pdf-lib full save, no incremental section) after a **garbage collection**: every object not reachable from the trailer (replaced streams, deleted annotations, old revisions' objects, orphans) is dropped, so no older revision or unreferenced object still holds the old text |

Then the **overlay** (fill colour + optional text, upright on rotated pages) is drawn as ordinary page content in a
clean graphics state.

### The self-check (fail closed)

Before anything is kept, the result is **re-read from its bytes** and searched independently of the code that
made it:

1. every glyph on a marked page, read with the text-edit engine's own positioning, must lie outside the marks;
2. every image under a mark is decoded and its marked pixels must be black (JPEG: within a few levels);
3. no annotation may remain under a mark;
4. the redacted strings must not occur anywhere: decoded page/form/appearance text (with the fonts), literal /
   UTF-16BE / hex spellings inside every decompressed stream and every text string of every object (object streams
   are expanded), the raw file bytes, and the text PDF.js extracts. Text that legitimately stays outside the
   marks (the same word elsewhere on the page) is allowed: occurrences are compared with what is visible;
5. no unreachable object may remain in the file.

If anything is found the redaction is **not applied**: the dialog lists where (page, object, attachment...). After
Apply the committed bytes are checked again, and rolled back if that ever fails.

## After saving

* Undo works only before the file is saved. After a save that contains the redaction, Epdf reloads the document
  from disk, which **drops the in-memory undo history** (it held the unredacted bytes): a saved redaction cannot be
  undone in the app. "Save As" leaves the original file untouched (a notice says so).
* **Known residue: Epdf's own version history.** Every save keeps a copy of the file that was on disk
  (`versions/`), and autosave keeps a recovery copy. After a redacted document is saved the app **offers to purge
  them** ("Purge version history"); the channel `redact:purgeHistory` (main) deletes all snapshots and the recovery
  copy of that document (the renderer names a `docId`, never a path). If the user keeps them the unredacted content
  stays in Epdf's data folder; a notice says so. Copies made outside Epdf (backups, cloud sync, the original file
  after Save As) are the user's to remove.

## What is NOT guaranteed

* **Embedded font programs are kept.** A subset font contains the outlines of the characters that were used; they
  are not in reading order and the text mapping (`/ToUnicode`) is unchanged, but the *set* of glyphs used on a page
  is still visible to someone inspecting fonts.
* **Content in resources that no operator draws** (an unused form listed in a resource dictionary, glyph procedures
  of Type 3 fonts, Type 3 glyphs drawing images) is not searched. If such content contains the redacted text the
  **self-check refuses** to apply rather than pass it.
* Text or images that only look like the marked content (outlined letters drawn as vector shapes that straddle the
  mark boundary are clipped, not deleted; a scanned page is destroyed only inside the marked pixels — the rest of
  the scan is untouched) are removed visually and by geometry, not by meaning.
* A **glyph is treated as covered at 30 %** of its box; a sliver overlap leaves the character (drawn mark still
  covers it). Text-derived marks (selection, search) use exact glyph boxes, so this only matters for hand-drawn areas.
* **Ambiguous data such as text stored inside an image** is only destroyed if it lies under a mark; OCR is not run.
* Encrypted documents must be unlocked first (`ensureEditable`); if the user declines, nothing is done. When the
  Security feature re-encrypts on save, the redacted file is protected as before.
* Object-level residue **outside the file** (undo history in memory before a save, version snapshots, OS
  thumbnails/search indexes, print spool) is not controlled by this feature.
* JPEG re-encoding is lossy: unmarked parts of a redacted JPEG change slightly (quality 95). Undecodable formats
  lose the whole image (see above).
* Marks belong to page numbers; if pages are reordered after marking, review the marks (the preview shows exactly
  what will happen).

## Files

```
src/renderer/src/features/redact/
  logic/             pure logic (no pdfjs/DOM imports): runs in Node, covered by unit tests
    geom.ts          rects, disjoint decomposition, convex polygon coverage (rotated glyph boxes)
    interp.ts        the redaction interpreter (text, images, forms, paths, patterns, shadings, marked content)
    textRewrite.ts   advance-preserving cut of Tj/TJ/'/"
    imageRedact.ts   pixel destruction for every colour space/filter we support (uses jpeg-js for JPEG)
    pageRedact.ts    page content rewrite + overlay
    prune.ts         drops replaced originals from private resource dictionaries
    docScrub.ts      annotations, fields, bookmarks, destinations, strings, XMP, thumbnails, JS, hidden data, GC
    redact.ts        orchestrator (steps per page, then the document-wide scrub); report + summary
    verify.ts        the independent self-check
    extract.ts       page text with glyph geometry (search, selection)
    search.ts, patterns.ts, safeRegex.ts    find and mark, presets, step-limited regex engine
  store.ts overlay.tsx Panel.tsx Options.tsx ApplyDialog.tsx Preview.tsx apply.ts purge.ts pages.ts index.tsx ...
src/main/features/redact/index.ts   channels redact:historyInfo, redact:purgeHistory; Tools ▸ Redact…
tests/unit/redact-*.test.ts         unit tests (see below)     tests/e2e/redact.spec.ts    end to end
tests/fixtures/redact.mjs           fixtures (the "secret in every form" document, patterns, hidden data, rotated)
tests/support/redactProof.ts        independent residue scan (literal/UTF-16BE/hex/glyph-code spellings)
```

Dependency added: **jpeg-js 0.4.4** (BSD-3-Clause; decoder derived from pdf.js, Apache-2.0; no dependencies) for
JPEG pixel destruction. Everything else is in-house (pdf-lib, the text-edit engine, fflate/pako already present).

## Testing

`npm test` (unit): `redact-proof` (**the proof**: the secret in plain Helvetica, embedded Noto subset, custom-code
TrueType subset, Type0 Identity-H, TJ pieces, across lines, in a form shared by two pages, invisible OCR text,
`/ActualText`, an annotation and `/Contents`, bookmark, form field, Info + XMP, a raw and a JPEG image; after
redaction PDF.js, the content engine and a raw scan of every stream/string/byte find nothing, image pixels are
black / unchanged, unmarked text, links and structure survive), `redact-verify` (mutation tests: the self-check must
notice each deliberately planted residue), `redact-images` (every colour space/filter, masks, inline, shared,
rotated, fail-closed formats), `redact-engine` (font types, forms copy-on-write, marked content, vector/pattern/
shading, overlay, refusals), `redact-scrub`, `redact-geometry`, `redact-patterns`, `redact-regex` (differential
tests against JavaScript RegExp and budget tests), `redact-search`, `redact-store`, `redact-main`.

`npx playwright test tests/e2e/redact.spec.ts`: mark by selection, by area (pointer, keyboard, numbers), by search/
pattern/regex with the review list, rotated page, preview before/after, apply, save, **the saved file is read back
and checked**, undo before save, cancel paths, self-check failure (attachment) then fixed with *Hidden data*, the
version-history purge offer (accepted and kept), encrypted document refusal, axe scans in light and dark.

Manual checks: mark text in a real scanned+OCR document (both the image pixels and the hidden text layer go),
redact in a document with a Type 3 font (whole run removed), look at the saved file in another reader and search it.
