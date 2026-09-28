# Comments and markup

Highlight, underline, strikethrough and squiggly text; sticky notes; text boxes; freehand drawing; rectangles,
ellipses, lines and arrows; built-in and custom image stamps; selecting, moving, resizing, recolouring and
deleting any existing annotation; and a **Comments** panel with threads, replies and review status.

Everything is saved as **standard PDF annotations with appearance streams**, so other readers show them, and
every create / change / delete is **one undo step** through the normal edit pipeline (`editPdf`).

Code: `src/renderer/src/features/markup/` (UI) with the PDF logic in `pdf/` (no `pdfjs-dist`, runs in Node);
`src/main/features/markup/` (two tiny channels).

## Using it

The tools are in the **Comment** group of the Tools ribbon. Each tool has its options (colour, opacity, width,
…) at the right end of the ribbon while it is active. `Escape` leaves the tool.

| Tool | Shortcut | How |
|---|---|---|
| Select | `V` | Click an annotation. Drag its frame to move it, drag a handle to resize (text boxes, shapes, drawings, stamps). Arrow keys nudge (1 pt, `Shift` = 10 pt), `Alt`+arrows resize, `Delete` removes (after asking), `Ctrl+C` / `Ctrl+V` copy and paste it (the copy lands a little down and right, selected), `Enter` edits its text, `Esc` deselects. Colour / fill / opacity / width are in the ribbon and in the panel. |
| Highlight / Underline / Strikethrough | `H` / `U` / `K` | Select text on the page with the mouse: the mark is created when you let go. If text is already selected, pressing the shortcut marks it immediately. (Squiggly has no shortcut.) |
| Sticky note | `N` | Click the page (or press `Enter` to place it near the top-left of what you see), type, `Enter` to add, `Shift+Enter` for a new line, `Esc` cancels. |
| Text box | `T` | Drag a rectangle, type, `Ctrl+Enter` (or click away) to add. The box grows downwards if the text does not fit. |
| Draw | `D` | Drag with the mouse or a pen. Smoothing is adjustable. Each stroke is one annotation. |
| Rectangle / Ellipse / Line / Arrow | `R` / `O` / `L` / `A` | Drag. Options: colour, fill, width, opacity, dashed. |
| Stamp | `P` | Pick a stamp in the ribbon (Approved, Not Approved, Draft, Confidential, Final, For Comment, Reviewed, Rejected, Completed, Void, Received, Sign Here) and click the page. **Choose image…** opens a native file dialog for a PNG/JPEG. |

`Ctrl+Alt+M` (or View ▸ Comments Panel, or the **Comments** button in the ribbon) toggles the **Comments panel**
on the right. **Add sticky note to page N** in the panel is the keyboard route to a note.

Shortcuts are bare letters, so they are ignored while you type in a field. They are ordinary commands
(`markup.tool.highlight`, …), so other features or menus can call them.

### Comments panel

* Lists **every** comment/markup annotation of the document, ordered by page then top to bottom, each with
  type icon, page, author, date/time and text (or the kind of mark when there is no text). Links, form fields
  and popups are not comments and are left alone.
* Filter by **type**, **author** and **status**, and search the text (also matches replies). The count is a live
  region.
* Click a row (or press `Enter` on it; `Up`/`Down` move between rows; `Delete` deletes) to go to the page and
  select the annotation. The selected row expands: edit the text, colour, opacity, width, change its status.
  Text is committed on blur or `Enter` (`Shift+Enter` = new line, `Esc` reverts): typing never makes an undo step
  per keystroke.
* **Reply** adds a reply (an annotation with `/IRT` pointing at the parent and `/RT /R`). Replies are shown as a
  thread under the comment and can be edited and deleted.
* **Resolve / Reopen** and the **Status** list set the review state (None, Accepted, Rejected, Completed,
  Cancelled) with review-state annotations (`/StateModel /Review`, `/State`, `/IRT`): the same way Acrobat does.
  The newest one wins. Resolved comments show a check mark and the status text (not colour alone).
* Deleting a comment that has replies asks first; the whole thread goes in one undoable step.
* The **author name** (top of the panel) is written into new annotations and replies. It is stored in this
  computer's app storage (`localStorage`); until you change it, it is the OS user name (`markup:defaultAuthor`).

## What is written to the PDF

All annotations have `/Type /Annot`, `/Subtype`, `/Rect`, `/F 4` (Print), `/P` (page), `/T` (author),
`/M` and `/CreationDate` (PDF dates with the local UTC offset), `/NM` (`epdf-<random>`), `/Contents`, and `/C`,
`/CA` (only when < 1) where they apply. Each has an `/AP /N` form XObject with `/BBox` and `/Resources`.

* **Highlight** `/QuadPoints` (one quad per text line, order TL, TR, BL, BR as displayed, so also right on rotated
  pages), fill in `/C`, appearance uses an ExtGState `/BM /Multiply` with the opacity in `/CA` and `/ca`.
  **Underline / StrikeOut / Squiggly**: stroked lines/zig-zag along the quads.
* **Sticky note** `/Text` with `/Name /Note|/Comment`, `/Open false`, 24×24 pt icon appearance.
* **Text box** `/FreeText` with `/DA` (`… rg /Helv 12 Tf`), `/Q`, `/BS`, fill in `/C`; the appearance wraps the text
  with Helvetica metrics and clips it to the box. Text WinAnsi cannot encode (Arabic, Hebrew, Cyrillic, CJK, ...) is
  drawn by the **text engine** instead: a nested `makeTextXObject` form inside the clip (shaped, right-to-left where
  needed, subset fonts with `/ToUnicode` and `/ActualText`), wrapped with the engine's line breaking; `/Q 0` means
  *start* (right-aligned for right-to-left text), 1 centre, 2 right; the box grows to fit using the engine's
  measurement. Such boxes also get **`/RC`** (the logical text as XHTML rich text, one `<p dir="rtl|auto">` per line)
  and **`/DS`** (`font: 12pt Helvetica,'Noto Sans','Noto Sans Arabic',...; color: #rrggbb; text-align: start`), with
  the same size and colour as `/DA`, so readers that rebuild the box from rich text (Acrobat) keep the direction.
  `/Contents` is always the logical plain text. Changing such a box back to WinAnsi text removes `/RC` and `/DS`.
* **Drawing** `/Ink` with `/InkList` (smoothed), `/BS /W`.
* **Shapes** `/Square` and `/Circle` (`/IC` fill, `/BS` width + dash), `/Line` with `/L`, `/LE [/None /OpenArrow]`
  and `/IT /LineArrow` for arrows.
* **Stamps** `/Stamp` with `/Name` (standard PDF names where they exist), vector appearance drawn programmatically
  (Helvetica-Bold, no images); custom stamps embed the image as an XObject in the appearance.
* **Reply / status** `/Text` with `/IRT`, `/RT /R`, `/F 28`, no appearance; status adds `/StateModel /Review`
  and `/State`.

On pages with `/Rotate`, text-bearing appearances (text box, stamps, note icon) are authored upright and rotated
back with the form's `/Matrix`, so they read correctly on the rotated page. CropBox offsets are respected.

Existing annotations are edited **without destroying what we do not understand**: only `/Rect` and geometry
(`/QuadPoints`, `/InkList`, `/L`, …) move on a move; an annotation's own appearance is only redrawn when Epdf
created it, or for the standard types recoloured from their own properties. Cloud-bordered shapes and lines with
unusual endings are never redrawn. Link, Widget, Popup, Redact and other non-markup annotations are never touched.

## Limits (deliberately not done)

* No Polygon / PolyLine / cloud tools (they can be listed, moved, deleted and have their text edited).
* No popup annotations are created; readers show `/Contents` on hover.
* No rich-text editing: text is plain (Epdf writes `/RC` only as the plain text in rich-text form for non-WinAnsi
  boxes). Text in a text box's appearance uses the standard Helvetica when WinAnsi can encode it, otherwise the text
  engine (every bundled script; characters no bundled font has show as the font's missing-glyph box). `/DA` refers
  to `/Helv` without adding it to the AcroForm resources (no AcroForm is created for annotations), so a reader that
  re-edits the text uses `/DS`/`/RC` or falls back to its default font. Not verified in Acrobat.
* Built-in stamp labels are English and drawn with Helvetica-Bold; sticky notes draw only an icon (no text in the
  appearance). There is no callout tool.
* Comments in password-protected documents cannot be listed (editing is refused by the pipeline anyway).
* Annotations are read by loading the whole document with pdf-lib after every edit while the panel or the Select
  tool is in use. On very large files (hundreds of MB) this takes noticeable time on the UI thread.
* Dragging a text selection exactly to the far edge of a line can extend it to the following lines in Chromium
  (a property of the viewer's text layer, not of the tool).
* Not verified against Acrobat / Preview (not available here); see "Testing" for what was checked instead.

## Testing

```powershell
npx vitest run tests/unit/markup          # pure logic: geometry, quads, appearance streams, ops, threads, hit-test
npx playwright test tests/e2e/markup.spec.ts   # NB: give the file path; "markup" alone matches the repository folder name
```

* Unit tests re-load every produced PDF with pdf-lib and assert the dictionaries and the appearance streams'
  `/BBox`, `/Matrix`, operators and resources, plus a strict structural validator (balanced `q/Q`, `BT/ET`, font
  and XObject resources resolve, `/IRT` and `/P` resolve).
* E2E drives the real app: creates every annotation type through the UI, undoes/redoes each, saves, re-reads the
  file with pdf-lib, reopens it and compares rendered pixels with the untouched fixture. It covers the panel,
  replies/resolve, editing annotations written by other software (`tests/fixtures/markup.mjs`), rotated pages,
  keyboard-only note creation and axe scans in light and dark.

### Manual checks worth doing

1. Highlight a sentence, save, open the file in Acrobat, Preview or Chrome: the highlight, its author and comment
   appear; the highlight multiplies over the text.
2. Reply and resolve in Epdf, save, open in Acrobat: the thread and the "Completed" state are shown.
3. Open a file annotated in Acrobat, use Select to move/delete an annotation, save and reopen in Acrobat.
4. Rotate a page (Document ▸ Rotate Page Clockwise), add a text box and a stamp, save and open elsewhere.

## Changes outside this feature's folders

* `src/renderer/src/viewer/Viewer.tsx`: the size-change counter is a local counter (after an edit the reloaded
  document restarted its own counter, so pages that differ from page 1, e.g. rotated ones, stayed squashed to
  page 1's size until something else triggered a layout).
* `src/renderer/src/index.css`: `--scale-round-x/y` defined on `.epdf-page`, without which the pdf.js text layer of a
  rotated page had an invalid size (selections and search hits missed the text on `/Rotate` pages).
* `src/renderer/src/components/ToolsBar.tsx`: pressed tool buttons use `bg-accent/10` instead of `/15`; the label
  of an active tool failed the 4.5:1 contrast rule in the dark theme.
