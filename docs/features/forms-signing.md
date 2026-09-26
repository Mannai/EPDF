# Form filling, Add text and visual signatures

Two related features that share code (`src/renderer/src/features/forms/` and `.../sign/`):

1. **Form filling** of AcroForm PDFs, plus **Add text** and **stamps** for flat PDFs (no fields).
2. **Self-signing**: create signatures / initials (draw, type, import), keep them encrypted on this computer,
   and place them on pages.

> **A visual signature is a picture.** It is *not* a cryptographic digital signature: it does not use a
> certificate, does not prove who signed and does not detect later changes to the document. The UI says so
> in the Signatures dialog and in the Sign ribbon, and this document repeats it on purpose.

## What it does

### Form filling
* Fields are read with pdf-lib: text (single line, multiline, password, MaxLen, comb), check box, radio
  group, drop-down (combo, also editable), option list (single/multi select), plus read-only and required
  flags. Push buttons and signature fields are recognised but **not editable** (see limits).
* The fields become real HTML inputs drawn over each widget (page overlay), positioned from the PDF.js
  viewport transform, so they line up on **rotated pages** and at **any zoom**. Font size, color, alignment,
  background and border come from the widget (`/DA`, `/Q`, `/MK`, `/BS`). Fields with several widgets work.
* While a form is showing, the viewer switches PDF.js to `AnnotationMode.ENABLE_FORMS` (widgets are not
  painted twice) and back to `ENABLE` for documents without fields.
* A value is committed when you **leave the field / press Enter / choose** (Ctrl+Enter in a multiline field;
  Escape abandons the edit) — one undo step per completed edit, labelled `Undo Fill “Field name”`, never per
  keystroke. Save writes it with the standard Save commands.
* The value is written with pdf-lib's form API and **real appearance streams** are generated, so other readers
  display it. A field whose text WinAnsi can encode gets pdf-lib's Helvetica appearance
  (`form.updateFieldAppearances`) exactly as before; a field showing any other character (Arabic, Hebrew,
  Cyrillic, Indic, Thai, CJK, ...) gets its appearance from the **text engine** (see "Right-to-left and other
  scripts in fields" below). Only characters that no bundled font contains (e.g. Tibetan) are refused with a
  message instead of drawing empty boxes.
* The inputs on the page use `dir="auto"` and "start" alignment, so Arabic and Hebrew are typed right to left and
  right-aligned, like the saved appearance.
* Keyboard: **Tab / Shift+Tab** walk the fields in page order (top-to-bottom, left-to-right as displayed,
  also on rotated pages), across pages (the viewer scrolls to the next page). Read-only fields and buttons
  are skipped; a radio group is one stop and the arrow keys move inside it. Every field has an accessible
  name: its tooltip (`/TU`), else its name (radio buttons: `<name>: <choice>`).
* A banner (“This form has N fields”) with a **Highlight fields** toggle (also *Tools ▸ Highlight Form
  Fields*). The banner can be dismissed.
* Password-protected documents: shown normally, the banner explains that they can't be filled in (removing a
  password is the Security feature); other edits fail with the standard "password protected" message.

### Add text and stamps (flat PDFs, any PDF)
* Ribbon group **Forms**: **Add text**, **Check**, **Cross**, **Dot**, **Date**. Size (default 12) and color
  live in the ribbon. Click a page to start a text box; type; drag it by *Move*, resize with the corner
  handle (or the arrow keys on those handles); **Add to page** (or Ctrl+Enter) draws it into the page content
  (wrapped to the box, one undo step). Escape cancels. Starting a second box or switching tools
  writes the first one; empty boxes are dropped. Text WinAnsi can encode is drawn with Helvetica as before; any
  other text with the text engine (`drawText` of `@shared/text`): shaped, right-to-left text right-aligned in the
  box, the first baseline where the Helvetica path puts it, lines 1.2 × size apart. The date stamp and the date next
  to a signature follow the same rule (e.g. an Arabic-locale date). The text box itself uses `dir="auto"`.
* Check / cross / dot are vector paths (sharp at any zoom, no font). Date is today's date in the user's
  locale. Text and stamps are drawn upright on rotated pages. They are permanent page content (undoable until
  saved, and visible to text extraction/search after re-opening).

### Signatures
* **Tools ▸ Signatures…** opens the dialog: *Draw* (pointer events: mouse, trackpad, touch, pen; smoothing,
  undo stroke, clear, ink color, optional pen pressure), *Type* (name in one of four bundled script fonts,
  rendered to a transparent PNG), *Import image* (PNG/JPEG; optional near-white background removal with a
  strength slider). Create either **Signatures** or **Initials**; keep up to 24. Names, "Use" and "Delete"
  (with confirmation) are in the same dialog.
* Ribbon group **Sign**: **Sign** and **Initials**. Pick a saved one, click the page: a placement box appears
  centered on the click. Drag it, drag the corner handle to resize (aspect ratio is kept), or use the keyboard
  (arrows = 1 pt, Shift+arrows = 10 pt, `+`/`-` = resize, Enter = place, Escape = cancel). **Add date**
  writes the date under the image. Placing embeds the PNG **with its alpha channel** into the page
  (`drawImage`, one undo step `Undo Sign`), upright on rotated pages.
* **Storage:** SQLite table `signatures` (migration 3). The image is base64-encoded and encrypted with
  Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux libsecret/kwallet) *before* it reaches the
  database. If `safeStorage.isEncryptionAvailable()` is false, saving is **refused** with an explanation —
  there is no plain-text fallback. Nothing is ever sent anywhere.
* Channels (validated with zod, size limits: PNG ≤ 1.5 MB, sides ≤ 2400 px, name ≤ 60 chars, ≤ 24 items):
  `sign:list`, `sign:save`, `sign:delete`, `sign:status`, and `forms:font` (bundled fonts by *name* only).

## Right-to-left and other scripts in fields

`forms/appearance.ts` (`writeEngineAppearances`) draws the appearance of text fields (single line, multiline,
comb, password, automatic size), combo boxes, list boxes and push buttons whose text WinAnsi cannot encode:

* **/V** stays the logical string (UTF-16, as typed). `/RV` is dropped as before.
* **/AP /N** is a form XObject with the widget's background and border (`/MK /BG /BC`, `/BS /W`), the rotation of
  `/MK /R`, a clip, and `/Tx BMC … EMC` around the text, which is a nested **`makeTextXObject`** form of the engine:
  shaped, bidi-ordered, subset Type0/Identity-H fonts with `/ToUnicode`, `/ActualText` on right-to-left lines. The
  font family follows the field's `/DA` font (Helv/HeBo → sans, TiRo/TiBo → serif, Cour/CoBo → mono, bold where the
  name says so; the metric-compatible Liberation fonts, then every script's Noto font as fallback).
* **Alignment**: `/Q 1` centres, `/Q 2` right-aligns; `/Q 0` (the default, and what most producers write) means
  *start*: left for left-to-right text, **right for right-to-left text**.
* **Automatic size** (`0 Tf`): single line = as large as the box allows (width and height, measured by the engine);
  multiline = the largest size up to 12 pt whose wrapped text fits the height; comb = every character within ¾ of a
  cell; list boxes = up to 12 pt, the options fitting the height. `/DA` keeps `0 Tf`.
* **Multiline** wraps with the engine's line breaking (UAX #14, Arabic, Thai/CJK dictionary breaks). **Comb** puts
  one grapheme per cell, left to right in logical order. **Password** fields show one `*` per grapheme.
* The field is marked clean afterwards, so pdf-lib's own Helvetica regeneration at save time leaves it alone.
* A field that goes back to WinAnsi text gets pdf-lib's Helvetica appearance again. Our previous appearance stream
  (marked `/EpdfTextAP`) and its nested text form are deleted when a field is redrawn; the old font subset of an
  earlier edit step stays in the file (see limits).

### AcroForm compatibility choice (/DA, /DR, NeedAppearances)

Researched behaviour of other readers (not re-verified here: no Acrobat on this machine):

* A reader shows a field's **existing** `/AP` as long as `/NeedAppearances` is not true; every reader does (PDF.js,
  pdfium/Chrome, Acrobat, Preview, Windows' PDF engine).
* With `/NeedAppearances true`, readers **regenerate** the appearance from `/V` and `/DA`. PDF.js and pdfium do that
  without Arabic shaping or bidi (the value comes out as isolated letters left to right); Acrobat shapes it but needs a
  font it can use. Other producers of RTL forms that set it (e.g. mPDF for "complex scripts") trade correct display
  in Chrome/Firefox for Acrobat regeneration.
* A reader that regenerates (on its own, or when the user edits the field in Acrobat) reads the font from `/DR` by the
  `/DA` name. An embedded **subset** Type0/Identity-H font without a Unicode `cmap` cannot encode new text, so such a
  reader substitutes a font (pdfkit's issue #1789 documents Acrobat doing exactly that); a complete font would be
  hundreds of KB per script.

Epdf's choice, for the most readers showing the right thing:

1. **`/NeedAppearances` is never set** by filling: every reader shows the engine's correct appearance as it is.
2. **`/DA` names the engine font that draws most of the text** (`/EpdfSans 12 Tf 0 g`, `EpdfSerifBd`, `EpdfMono`,
   … with `_2`, `_3` when an earlier edit used the name for another subset), keeping the old size (0 = auto) and
   colour, and **that font is added to `/AcroForm /DR /Font` under the same name**. So `/DA` always names a font that
   exists in `/DR`, with a `/ToUnicode` map and the right glyphs for the current value; a reader that regenerates
   for an edit gets an Arabic-capable font description and, where it cannot use the subset, substitutes (Acrobat
   then shapes the text itself). The name also records the family/weight, so the form builder shows the style that
   was chosen (`EpdfSerifBd` → Times bold).
3. Latin fields keep pdf-lib's behaviour (Helvetica appearance; pdf-lib writes `/Helvetica` into `/DA` without a
   `/DR` entry, as before this change).

## Files
```
src/renderer/src/features/forms/   model.ts (fields → data), values.ts (validate + apply), fonts.ts, draw.ts,
                                   geometry.ts, tabOrder.ts, keys.ts, store.ts, FormsHost.tsx, FieldsOverlay.tsx,
                                   textTool.tsx, index.tsx
src/renderer/src/features/sign/    strokes.ts, imageProcessing.ts (pure), canvasUtil.ts, typed.ts, Pads.tsx,
                                   SignatureDialog.tsx, SignTool.tsx, store.ts, index.tsx
src/main/features/sign/            cipher.ts (SecretCipher interface + safeStorage), store.ts, index.ts
src/main/features/forms/index.ts   bundled-font channel + menu items
src/shared/features/{sign,forms}.ts
src/main/db/migrations.ts          + migration 3 (`signatures`)
resources/fonts/                   bundled fonts and their license texts (electron-builder `extraResources`)
```

## Bundled fonts and dependencies (licenses)
| File (`resources/fonts/`) | Used for | License |
|---|---|---|
| `NotoSans-Regular.ttf` | text in forms / Add text that Helvetica can't encode (Latin, Greek, Cyrillic, Vietnamese) | SIL OFL 1.1 — © The Noto Project Authors (`OFL-NotoSans.txt`) |
| `GreatVibes-Regular.ttf` | typed signatures | SIL OFL 1.1 — © The Great Vibes Pro Project Authors (`OFL-GreatVibes.txt`) |
| `Allura-Regular.ttf` | typed signatures | SIL OFL 1.1 — © The Allura Project Authors (`OFL-Allura.txt`) |
| `Sacramento-Regular.ttf` | typed signatures | SIL OFL 1.1 — © 2012 Brian J. Bonislawsky DBA Astigmatic (AOETI); Reserved Font Name "Sacramento" (`OFL-Sacramento.txt`) |
| `HomemadeApple-Regular.ttf` | typed signatures | Apache License 2.0 — Homemade Apple by Font Diner, from the `apache/` directory of the Google Fonts repository (`LICENSE-Apache-2.0-HomemadeApple.txt`) |

Fonts are unmodified copies from the Google Fonts repository (Noto Sans from notofonts.github.io). The OFL
permits bundling and embedding in documents; the fonts are not sold on their own.

New npm dependency: **`@pdf-lib/fontkit` 1.1.1 — MIT** (fork of foliojs/fontkit, © Devon Govett; its only
dependency `pako` is MIT/Zlib). It is bundled into the renderer to embed the Unicode font. Dev-only:
`pdfjs-dist` (already a dependency) is used by one e2e test as an independent reader.

## Limits and known gaps (honest list)
* **No PDF scripting.** Calculated fields, format/validate/keystroke actions and push-button actions are
  never executed (by design; see FEATURES.md). Push buttons and **digital signature fields are not
  interactive** — they are shown as an outlined marker while *Highlight fields* is on and PDF.js still paints
  their appearance; use the Sign tool for a visual signature anywhere on the page.
* **XFA forms** are not supported (PDF.js is opened with XFA disabled and pdf-lib only edits AcroForm). If a
  file carries both, other readers that prefer XFA may ignore the filled AcroForm values.
* Comb fields are filled and rendered correctly in the saved appearance but are shown as a normal input
  while editing. A widget's own content rotation (`/MK /R`) is ignored in the on-screen input (the generated
  appearance honours it). Auto-sized fields (`0 Tf`) use an approximate size on screen.
* When a field's appearance is regenerated, pdf-lib re-creates it with Helvetica (WinAnsi text) or the engine
  draws it with the Liberation/Noto family matching its `/DA` (other text), so a field that used another font in
  its `/DA` changes typeface. `updateFieldAppearances` also creates appearances for other fields that had none. A
  rich-text value (`/RV`) is replaced by the plain text you enter.
* Every script the bundled fonts cover is written (Arabic, Persian, Urdu, Hebrew, Indic, Thai, CJK, Cyrillic,
  Greek, ...); characters no bundled font has (e.g. Tibetan) are refused, not drawn wrong. Not verified in Acrobat:
  what it does when the user edits such a field there (see the compatibility choice above).
* Each fill of a non-WinAnsi field in a new edit step embeds a new small font subset; the subset of the previous
  step is no longer used but stays in the file (a few KB per edit; pdf-lib does not garbage-collect objects).
* Comb fields fill cells left to right in logical order, also for right-to-left text (combs are meant for digits and
  codes; Acrobat's behaviour for RTL combs was not checked). Password fields drawn by the engine show `*` per
  character; pdf-lib's Latin appearance of a password field shows the value (unchanged, pre-existing).
* Typed signatures are pictures rendered by Chromium in the dialog (`sign/typed.ts`); the script fonts only have Latin
  letters, so other scripts fall back to a system font in the picture. They are not text in the PDF.
* The form model is read with pdf-lib on the main renderer thread after every edit of a document that has
  fields. That is instant for normal forms but can pause the UI for very large (100 MB+) form PDFs.
* Drawing a signature needs a pointer; the *Type* and *Import* tabs are the keyboard-only alternatives.
* "Encrypted at rest" means what `safeStorage` provides: the database file and its backups do not contain
  the image; the key is held by the OS and tied to your OS account. Other programs running as the same OS
  user can ask the OS to decrypt (a property of DPAPI/Keychain/libsecret, not something Epdf can prevent).
* The core viewer turns ArrowLeft/Right, PageUp/Down, Home and End into page navigation for any key event
  that bubbles up to it. Our inputs stop those keys from reaching it (`forms/keys.ts`); other features that
  put inputs on a page need to do the same.

## Manual test steps
1. `npm run build`, launch, open `test-results/fixtures/forms.pdf` (created by `npx playwright test forms-signing`)
   or any fillable PDF. The banner says how many fields it has. Fill every field; Tab/Shift+Tab across the
   pages; watch *Undo* say `Undo Fill “…”` after each field; Save and open the result in Acrobat/Preview/
   Chrome: values are visible. Type `الاسم الكامل` in a text field (right to left, shaped, right-aligned after
   Enter), `שלום 2026` and `你好` in others; `བོད` is refused.
2. Open `flat.pdf`: *Add text* → click → type → Ctrl+Enter; try Check/Cross/Dot/Date; rotate the page
   (*Document ▸ Rotate*) and add more: everything stays upright. Save, re-open, search for the text.
3. *Tools ▸ Signatures…*: draw, type, import a scanned signature (with and without background removal); save
   a signature and initials. Use *Sign*: click, drag/resize/arrow-key, *Add date*, place, Save; check the
   image in another reader (it is transparent, on the page you clicked).
4. On Linux without a keyring (or with `safeStorage` patched off) the dialog must refuse to save.
5. Open an encrypted PDF: the form banner explains it can't be filled; Add text fails with a clear message.

## Tests
* Unit (`tests/unit/forms-*.test.ts`, `sign-*.test.ts`): field-model extraction, validation (MaxLen, checkbox /
  radio / combo / list rules, read-only), applying values to real PDFs (appearance streams, Unicode font,
  refusal, /RV), tab order incl. rotated pages, page geometry for all four rotations and zoom, text/stamp
  drawing (position, wrapping, rotation), font choice, stroke smoothing/pressure, background removal and
  trimming, the encrypted store with a fake cipher (round trip, never plain, refusal, limits, undecryptable
  rows), zod schemas, migration 3.
* Right-to-left and other scripts (`tests/unit/forms-engine.test.ts`, `forms-draw-engine.test.ts`,
  `tests/e2e/text-retrofit.spec.ts`): Arabic/Hebrew/mixed/Devanagari/Thai/CJK values, combo and list options, comb,
  auto size, `/Q`, rotated widgets, `/DA` in `/DR`; saved files read by PDF.js (`fieldValue`, `hasAppearance`) and
  the page text model over the appearances (logical order, right alignment, wrapping); Add text / date stamps /
  signature date in the same scripts and on rotated pages; in the real app the Arabic field and the Arabic Add text
  are compared with Chromium's rendering of the same string (NCC ≥ 0.8, negative control < 0.75). Windows' own PDF
  engine was looked at for `test-results/text-retrofit/forms-arabic.pdf` and `addtext-arabic.pdf`.
* E2E (`tests/e2e/forms-signing.spec.ts`, fixtures from `tests/fixtures/forms-signing.mjs`): fill every field
  type through the UI and re-check the *saved* file with pdf-lib and with PDF.js in Node; undo/redo; Tab
  order; rotated-page form; flat-PDF text (also found by the text layer after reopening); stamps; signature
  draw/type/import, list, place (position/size/aspect/alpha in the saved page, also rotated), delete;
  encryption at rest (PNG bytes searched for in the whole profile), `safeStorage` unavailable, channel
  validation, cancelled dialogs, encrypted PDF, unsupported fields, axe scans (light + dark).
