# Form builder (feature 18)

Turns an ordinary (flat) PDF into a fillable form, and edits the fields of forms that already have fields.
Code: `src/renderer/src/features/formbuilder/` (pure logic in `logic/`, no PDF.js/DOM imports), main half in
`src/main/features/formbuilder/`, shared zod schema in `src/shared/features/formbuilder.ts`.

## What the user gets

* **Tools ▸ Prepare Form…** opens the *Form fields* panel and the **Edit fields** tool.
  **Tools ▸ Detect Form Fields…** starts automatic detection. Commands: `formbuilder.prepare`,
  `formbuilder.detect` (plus `formbuilder.preview`, `formbuilder.tabOrder`, `formbuilder.exportCsv`,
  `formbuilder.clearForm`, `formbuilder.addField`). No keyboard shortcuts are bound.
* **Ribbon group "Form builder"** (order 400-408): Edit fields, Text field, Check box, Radio group, Dropdown,
  List box, Date field, Signature field, Button. Draw a rectangle on the page (a click drops the default
  size). After one field the tool returns to *Edit fields*; the radio tool stays so several buttons can be drawn
  into one group ("New group" starts another).
* **Every action has a keyboard route**: the panel's *Add to this page* buttons place a field in the middle of the
  page you are looking at (its Name box gets the focus); a focused field frame takes arrow keys (1 pt, Shift = 10 pt)
  to move, Alt+arrows to resize, Delete, Ctrl+C / Ctrl+V / Ctrl+D, Ctrl+A (select all on the page),
  Shift+Space (add to selection), Enter (go to the Name box), Escape (deselect, then leave the tool). Key presses
  that follow each other are one undo step.
* **Selection**: click, Shift/Ctrl+click, rubber band on empty page area, the field list in the panel.
  **Align** (edges/centres), **Distribute** and **Same size** in the ribbon options (they work in the page as the
  reader sees it, also on rotated pages). Copy / Paste / Duplicate / Delete.
* **Preview** (panel switch, or ribbon button): leaves building; the form behaves exactly as for the people who
  fill it (Epdf's normal form overlay). "Check required fields" lists empty required fields; **Clear form** empties
  every fillable field in one undo step (read-only fields keep their content). **Export list (CSV)** writes name,
  type, page, required, read-only, tooltip, options, default value, max length and format (UTF-8 with BOM).
* **Field properties** (right panel, every change is one undo step): name (valid + unique, live check), tooltip
  (`/TU`, also the accessible name in the fill overlay), required, read-only, hidden, default value, max length,
  multi-line, password, comb, alignment, font / size / colour, border colour / width / style, fill, dropdown and
  list options (+ editable / multi-select / default), radio buttons (export values, add / remove buttons, default),
  checkbox export value and default, button caption, and **format / validation**.
* **Tab order editor** (Tab order… in the panel or `formbuilder.tabOrder`): list per page with drag and drop,
  ↑/↓ buttons and Alt+↑/↓ (Alt+Home/End), numbered badges on the page, presets "By rows" / "By columns",
  Apply (one undo step), Revert, Done / Escape.

## Automatic detection (`logic/detect.ts`)

Works from the page's real content, never from pixels: text runs with bounding boxes (the text-editor engine
`textedit/pdfcontent`), and a small content-stream interpreter (`logic/vector.ts`) that collects lines, rectangles,
circles and images (form XObjects, `cm`, dash patterns, thin filled bars as rules, rotated pages). Everything is
analysed in the page as the reader sees it and converted back to user space when fields are created.

| Rule | Field | Confidence (typical) |
|---|---|---|
| a rule directly after a label (`Name: ____` drawn as a line), also dashed / dotted | text | 0.86 |
| a rule with a caption under it | text (signature if the caption says so) | 0.66 |
| a rule under a label with a gap / running on after its label | text | 0.55 - 0.6 |
| `____`, `.....`, `. . . .`, `___/___/____` inside the text | text (date for the slash form) | 0.72 - 0.82 |
| empty rectangle or table cell with a label left / above | text (multi-line when tall) | 0.84 - 0.9 |
| empty table cell under a column header / beside a label cell | text | 0.72 / 0.84 |
| small box with its label printed inside, rest empty | text | 0.56 |
| stroked square 6-20 pt next to text | check box | 0.5 - 0.9 (longer label = lower) |
| 2+ circles in a row or column (question above / left) | radio group with export values from the option labels | 0.86 |
| 2-4 Yes/No-style boxes in a row | radio group | 0.62 |
| a row of 4+ equal empty cells, or a box with equal tick marks | comb text field (max length = cells) | 0.85 |
| label matches date / dob / dd/mm/yyyy | date field (format from the hint) | as the rule |
| label matches signature / sign here / signed by | signature field | as the rule |

Negatives that are handled: underlined headings and words, full-width separator rules, header / footer rules,
page frames, filled dark squares and circles (bullets), framed paragraphs, boxes with text inside, tables that
contain data (a column with text below its header), tables of contents and price lists (dot leaders that lead to
a page number or price), ellipses in prose. A scanned page (a picture and no text or lines) is reported with the
hint to run OCR - nothing is guessed there; a scan with an invisible recognised-text layer is reported too.

**Review** (right panel + overlay): every suggestion is a dashed box with a visible tag "kind + confidence".
Confidence slider (default 50%), per-kind toggles, select / select all, *Create all shown*, *Create selected*,
*Reject selected*. Suggestions can be adjusted before committing: drag / resize the box, arrow keys, rename, edit
the label (becomes the tooltip), change text ↔ date ↔ signature. Nothing touches the document until *Create*; the
whole batch is **one** `editPdf` step ("Add 8 detected form fields"). Names come from the nearest label
(`Date of birth:` → `Date_of_birth`, no periods, unique against the document and each other, radio export values
from the option labels). Created fields lie over the printed rule/box and draw no border or fill of their own.

## What is written into the PDF

Real AcroForm objects (pdf-lib): field + widget annotations with the exact `/Rect`, `/P`, `/F`, `/MK` (border,
background, `/R` = page rotation on rotated pages), `/BS`, `/DA`, `/TU`, flags, appearance streams (`/AP`) so the
form shows in other readers; radio groups are one field with one kid widget per button (`/Opt` = export values,
exclusive; NoToggleToOff set); signature fields are an empty `/Sig` with a plain box appearance; `/AcroForm` gets
`/DA` and a `/DR` with the standard fonts the fields use (Helv, HeBo, TiRo, TiBo, Cour, CoBo). We do not set
`/NeedAppearances`: appearances are generated. Tab order: `/Tabs` on the page (`R`, `C`, `S`); a manual order
reorders `/Annots` (other annotations keep their slots) and sets `/Tabs /S`.

### Validation and formats

Stored the way other readers expect: `/AA` JavaScript actions `/F` (format), `/K` (keystroke), `/V` (validate)
calling Acrobat's helpers: `AFNumber_Format/Keystroke(decimals, sep, neg, 0, currency, prepend)`,
`AFRange_Validate`, `AFPercent_*`, `AFDate_FormatEx/KeystrokeEx("dd/mm/yyyy")`, `AFTime_*`, `AFSpecial_*` (ZIP,
ZIP+4, phone, SSN), and small scripts for email and custom regular expressions. **Epdf never executes PDF
JavaScript.** It only writes these scripts; for its own fill experience it recognises the same shapes
(`logic/actions.ts: parseScripts`) and checks the value itself (`checkValue`): a wrong value is refused with a
message (number, range, date validity incl. leap years, ZIP / phone / SSN, email, regex). Regular expressions that
look like nested quantifiers (catastrophic backtracking) or are longer than 200 characters are never evaluated.

### Small extension points added to the forms feature (backwards compatible)

* `forms/model.ts`: `FieldModel.scripts` (the JS text of `/AA /F` and `/V`, as data), `WidgetModel.annotOrder` and
  `FormModel.pageTabs` (page `/Tabs`).
* `forms/tabOrder.ts`: pages with `/Tabs /S` follow `/Annots` order, `/C` walks columns, everything else is the
  previous row order (so existing forms behave as before).
* `forms/values.ts`: `registerValueCheck(fn)`; the text-value validation calls registered checks after the
  built-in ones. The form builder registers the format check.

## Limits (honest list)

* Detection is heuristic. It was tuned on generated forms; see the report for precision / recall. Forms whose
  rules are drawn as many tiny segments, hand-drawn scans, or layouts that put labels far from their blanks will
  miss or mislabel fields; that is what the review step is for.
* Detection looks at upright text. Text turned sideways for the reader is ignored (a note says so).
* Radio groups drawn as squares are only recognised for Yes/No-style pairs; other squares become check boxes.
* Multi-line rich text (`/RV`), XFA forms, calculation scripts and push-button actions are not created or edited.
* Field creation on encrypted documents goes through `ensureEditable` (the Security feature's decrypt hook);
  without that feature the tool says the document is password protected and does nothing.
* Required fields are announced (`aria-required`, "(required)" in the accessible name) and listed by *Check
  required fields*; Epdf does not block saving an incomplete form.
* Non-Latin default values / captions need a font outside the 14 standard fonts and are not supported (the
  filling overlay of the forms feature still handles Unicode values).

## Manual test steps

1. Open a flat form (e.g. `test-results/fixtures/fb-detect.pdf`, generated by `tests/fixtures/form-builder.mjs`).
   Tools ▸ Detect Form Fields… ▸ Detect fields. Move the confidence slider, untick a kind, drag a suggestion,
   rename one, *Create all shown*, Undo (all fields disappear), Redo, Save, reopen: the fields are fillable.
2. Draw one field of each kind with the ribbon tools; use arrow keys / Alt+arrows on a selected field; select
   two fields with Shift+click and use Align / Distribute / Same size.
3. In the panel set Required, Read-only, Maximum length and Format ▸ Number (0 - 999); Save, reopen, try `abc`
   and `1000` in the field (both refused with a message).
4. Tab order…: move a field up, Apply, switch to Preview and press Tab.
5. Open `fb-scan.pdf`: detection says it is a scan and suggests OCR. Open an encrypted PDF: the tool explains it
   cannot edit it.
6. Open the same files in another reader (Acrobat, Chrome, Firefox) to see the appearances, tab order and formats.

## Tests

`tests/unit/formbuilder-detect.test.ts` (fixtures + precision / recall, rotation 90/180/270, scans),
`formbuilder-variants.test.ts` (differently constructed forms and ordinary-document negatives),
`formbuilder-create.test.ts` (creation output re-loaded with pdf-lib, the forms model and PDF.js legacy),
`formbuilder-logic.test.ts` (names, formats, tab-order permutations, align, CSV, detect → apply, forms hooks),
`tests/e2e/form-builder.spec.ts` (detect flow, manual tools, keyboard, properties enforced when filling, tab order in
the fill UI, rotated page, scan / cancel / encrypted paths, CSV + clear form, axe light + dark).
