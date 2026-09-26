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

Task buttons and the side-panel switcher are toggle buttons (`aria-pressed`), not ARIA tabs: `role="tab"` is reserved for
the open documents, which is what assistive tech (and the tests) treat as "the tabs".

E2E tests click tools through `clickTool(page, idOrLabel)` in `tests/e2e/helpers.ts`, which shows the right task first.

## Dialogs

`Modal` follows Windows 11: a 20 px title with an optional one-line description, and the dialog's last row of buttons
becomes a grey footer band where the buttons share the width and the primary (blue / submit) button comes first
(CSS in `index.css`, "Modal footer"). `size="l"` dialogs (headers & footers) have a fixed height and scroll inside
their panes so the footer stays put. The class is `.modal`, not `.dialog`: pdf.js's viewer CSS styles `.dialog`.
