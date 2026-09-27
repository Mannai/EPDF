# Window chrome (Windows design v3)

The app frame follows the design project "Epdf design system", Windows variant (`Epdf Windows v3.dc.html`,
tokens in `tokens/tokens.css`, `tokens/components.css`, `tokens/tailwind.config.mjs`, icons in `ep-icons.js`).

## Layout, top to bottom

| Row | Component | Contents |
|---|---|---|
| Title bar (40 px) | `components/TitleBar.tsx` | App mark, Save / Undo / Redo, the document tabs (`TabBar.tsx`), a centred "Search in document" box, and room for the caption buttons |
| Task row (34 px) | `components/Ribbon.tsx` `RibbonTabs` | Side panel toggle, **File** (pops up the application menu), task buttons |
| Ribbon (40 px card) | `components/Ribbon.tsx` `Ribbon` | The current task's tools, one labelled line; the active tool's options at the end |
| Body | `App.tsx` | Side panel (Pages / Bookmarks switcher, `SidePanels.tsx`), the page viewer, right-hand panels |
| Status bar (28 px) | `components/StatusBar.tsx` | Page navigation; page layout; zoom out / slider / zoom in / zoom level |

## Windows title bar

`WindowManager` creates windows with `titleBarStyle: 'hidden'` and `titleBarOverlay` on Windows only, so Windows itself
draws minimise / maximise / close (snap layouts, hover and the system menu stay native). The overlay colours follow the
theme (`chromeOverlay`, re-applied on `nativeTheme` updates by `src/main/features/chrome`). Empty parts of the title bar
drag the window (`.app-drag`); controls inside it opt out. macOS and Linux keep their native title bar, and the same rows
render under it.

A hidden title bar has no menu bar, but the application menu is still installed, so every accelerator and every feature's
`contributeMenu` item keeps working. **File** calls the `chrome:menu` channel, which pops the menu up under the button:
File's own items first, then Edit, View, Document, Tools, Window and Help as submenus.

## Tasks

`components/ribbonTasks.ts` maps tool groups to tasks: Comment, Draw (the shape and ink tools taken out of Comment),
Edit, Fill & sign (Forms + Sign), Links & forms (Links + Form builder), Redact, Page marks. A group that no task claims
becomes its own task, so a new feature's tools always appear. When a tool is activated from anywhere (menu, shortcut,
command), the ribbon switches to its task.

A task can also show another task's tool (`shared`): Select is on Draw too, so a shape stays selected under Draw after
it is drawn. When the user picks another task, a tool the new task doesn't have is turned off (its button and options
would be out of sight while it kept working: "Mark text" kept marking text for redaction under Comment), and the task's
own panel (`panel`, e.g. the Redaction panel) closes. `leavingTask()` in `ribbonTasks.ts` decides.

Task buttons and the side-panel switcher are toggle buttons (`aria-pressed`), not ARIA tabs: `role="tab"` is reserved for
the open documents, which is what assistive tech (and the tests) treat as "the tabs".

E2E tests click tools through `clickTool(page, idOrLabel)` in `tests/e2e/helpers.ts`, which shows the right task first.

## Right-click menus

Menus are native Windows menus. The renderer describes one (`openContextMenu(e, items)` in `components/contextMenu.ts`),
main shows it (`chrome:contextMenu`, `src/main/features/chrome/contextMenu.ts`) and answers with the chosen item, and the
renderer runs it: a `command` (the same code as the ribbon and the menu bar) or a local `run`. `keys` is only the hint
shown at the right; it binds nothing (the shortcut audit in `tests/unit/shortcuts.test.ts` ignores it). Shift+F10 and the
Menu key open the same menus, placed at the focused element.

| Where | Items |
|---|---|
| Selected text on a page | Copy, Search for "…"; Highlight, Underline, Strikethrough, Squiggly; Link selected text…; Add bookmark for this text; Mark for redaction |
| Empty part of a page | Undo / Redo (named, like the title bar), Select all text on this page, Go to page…; Add sticky note; Add link here…; Add bookmark here; rotate, insert, duplicate, extract, delete this page, Organize pages, Print… |
| Annotation (Select tool) | Edit text, Show in Comments panel, Delete |
| Link (Edit links) | Edit link…, Copy link address, Delete link |
| Form field (Edit fields) | Copy, Paste, Duplicate, Edit tab order, Delete |
| Link on a page (reading) | Open link / Go to linked page, Copy link address |
| Page thumbnail | The page items for that page |
| Document tab | Close, Close other tabs, Close tabs to the right, Move to new window, Show in File Explorer, Copy file path |
| Bookmark | Go to, Rename, Add bookmark here, Point to current view, Nest / Un-nest / Move up / Move down, Bold, Italic, Delete (also the bookmarks toolbar's **…** button, which replaced the six icon buttons) |
| Library file | Open, Open in new window, Show in File Explorer, Favorite, Add to folder…, Remove from this folder, Remove from library… (acts on the selection) |
| Text boxes anywhere | Undo, Redo, Cut, Copy, Paste, Select all (main's fallback for editable fields) |

The page menus are built from every feature's `registerContextItems` group, in `order`. E2E tests pick items through
main's test hook (`contextMenu()` in `tests/e2e/helpers.ts`; spec `tests/e2e/contextmenus.spec.ts`), since Playwright
cannot click a native menu.

## Placing and deleting things on a page

- **Delete / Backspace asks first** on a selected comment, shape, stamp, link, form field, image or redaction mark
  (`state/confirmDelete.ts`). The question has "Don't ask again", which sets the `confirmDelete` setting to false;
  **Edit ▸ Ask Before Deleting** (a menu checkbox, rebuilt whenever the setting changes) turns it back on. Deleting
  from a right-click menu or a Delete button doesn't ask: that is already a deliberate choice. E2E: `answerDelete(page)`.
- **Placed shapes, stamps and text boxes are selected** with the Select tool (`selectPlaced` in markup/actions.ts), so
  their handles and properties show at once: colour, fill, opacity, width, dashed, arrowhead, font size, note icon, and
  which built-in stamp it is. "Keep tool selected" (in those tools' options) stays on the tool instead. Ink keeps
  drawing.
- **Click-to-place tools preview** under the pointer what a click would add, at its real size and position
  (`data-testid="place-ghost"`): markup stamps (built-in and image), sticky notes, text boxes; Fill & sign check,
  cross, dot, date and Add text; signatures and initials; a picture being inserted with Edit images.
- Fill & sign marks and text, and signatures, are still written into the page itself when placed (flattened), so
  they are not editable as objects afterwards (a signature can be moved or deleted with Edit images).

## Dialogs

`Modal` follows Windows 11: a 20 px title with an optional one-line description, and the dialog's last row of buttons
becomes a grey footer band where the buttons share the width and the primary (blue / submit) button comes first
(CSS in `index.css`, "Modal footer"). `size="l"` dialogs (headers & footers) have a fixed height and scroll inside
their panes so the footer stays put. The class is `.modal`, not `.dialog`: pdf.js's viewer CSS styles `.dialog`.
