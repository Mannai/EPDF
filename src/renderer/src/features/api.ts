import type { ComponentType, ReactNode } from 'react'
import type { PageViewport } from 'pdfjs-dist'
import type { Tab } from '../state/tabs'
import type { ContextItem } from '../components/contextMenu'

/**
 * Renderer extension points. A feature is a folder `src/renderer/src/features/<name>/` with an
 * `index.ts(x)` that calls the `register*` functions below; it is auto-loaded at startup (see ./index.ts),
 * so adding a feature never means editing a shared file.
 *
 *   registerCommand({ id: 'forms.fill', label: 'Fill form', run: () => ... })   // menus/shortcuts/palette
 *   registerTool({ id: 'highlight', label: 'Highlight', group: 'Comment', icon: <svg/> })  // Tools ribbon
 *   registerPageOverlay(MyOverlay)          // drawn on top of every rendered page
 *   registerPanel({ id: 'comments', side: 'right', ... })   // sidebar panels
 *   registerView({ id: 'organize', ... })   // full-tab modes that replace the page viewer
 *   registerDialog(MyDialogHost)            // always-mounted modal hosts (they show themselves)
 */

/** A button in the Tools ribbon. Selecting it makes it the active tool (`useWorkspace().activeTool`). */
export interface ToolDef {
  id: string
  label: string
  icon: ReactNode
  /** Ribbon group heading, e.g. "Comment", "Forms". */
  group: string
  order?: number
  /** Extra controls shown to the right of the ribbon while this tool is active (color, width, ...). */
  Options?: ComponentType<{ docId: string }>
  /** CSS cursor used over pages while the tool is active. */
  cursor?: string
  /** Called when the tool is activated / deactivated (e.g. to clear a selection). */
  onActivate?: (docId: string) => void
  onDeactivate?: (docId: string) => void
}

export interface PanelDef {
  id: string
  label: string
  icon: ReactNode
  side: 'left' | 'right'
  order?: number
  /** Width in CSS pixels of a LEFT panel (default 160, sized for page thumbnails). */
  width?: number
  Component: ComponentType<{ tab: Tab }>
}

/** A full-tab mode (page organizer, compare, ...). While active it replaces the page viewer. */
export interface ViewDef {
  id: string
  label: string
  Component: ComponentType<{ tab: Tab }>
  /** Hide the standard viewer toolbar and tools ribbon while this view is showing. */
  hideToolbar?: boolean
}

export interface PageOverlayProps {
  docId: string
  /** 0-based page index. */
  pageIndex: number
  pageNumber: number
  /** CSS pixels per PDF point. */
  scale: number
  /** Page size in CSS pixels. */
  width: number
  height: number
  /** Converts between PDF user space and CSS pixels (`convertToViewportPoint` / `convertToPdfPoint`). Null until first render. */
  viewport: PageViewport | null
  /** Increments each time the page canvas was re-rendered (content or zoom changed). */
  renderVersion: number
}

export interface CommandDef {
  id: string
  label: string
  run: (args?: unknown) => void | Promise<void>
  /** Renderer-side keyboard shortcut, e.g. `mod+shift+h` (`mod` = Ctrl on Windows/Linux, Cmd on macOS). */
  shortcut?: string
  enabled?: () => boolean
}

const tools: ToolDef[] = []
const panels: PanelDef[] = []
const views: ViewDef[] = []
const overlays: ComponentType<PageOverlayProps>[] = []
const dialogs: ComponentType[] = []
const commands = new Map<string, CommandDef>()

const dup = (kind: string, id: string): never => {
  throw new Error(`${kind} already registered: ${id}`)
}

export function registerTool(t: ToolDef): void {
  if (tools.some((x) => x.id === t.id)) dup('Tool', t.id)
  tools.push(t)
}
export function registerPanel(p: PanelDef): void {
  if (panels.some((x) => x.id === p.id)) dup('Panel', p.id)
  panels.push(p)
}
export function registerView(v: ViewDef): void {
  if (views.some((x) => x.id === v.id)) dup('View', v.id)
  views.push(v)
}
export function registerPageOverlay(c: ComponentType<PageOverlayProps>): void {
  overlays.push(c)
}
export function registerDialog(c: ComponentType): void {
  dialogs.push(c)
}
export function registerCommand(c: CommandDef): void {
  if (commands.has(c.id)) dup('Command', c.id)
  commands.set(c.id, c)
}

export const getTools = (): readonly ToolDef[] => [...tools].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
export const getPanels = (side: 'left' | 'right'): readonly PanelDef[] =>
  panels.filter((p) => p.side === side).sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
export const getPanel = (id: string): PanelDef | undefined => panels.find((p) => p.id === id)
export const getViews = (): readonly ViewDef[] => views
export const getView = (id: string): ViewDef | undefined => views.find((v) => v.id === id)
export const getPageOverlays = (): readonly ComponentType<PageOverlayProps>[] => overlays
export const getDialogs = (): readonly ComponentType[] => dialogs
export const getCommands = (): readonly CommandDef[] => [...commands.values()]
export const getCommand = (id: string): CommandDef | undefined => commands.get(id)

/**
 * Right-click menus on pages. Features add their items for "selected text" or "a page" (where nothing is selected):
 *   registerContextItems('selection', 20, (at) => [{ label: 'Highlight', run: () => ... }])
 * Groups are shown in `order`, separated by lines. `at` says which document and page was right-clicked, and what text
 * is selected. The menu itself is shown with openContextMenu() (components/contextMenu.ts).
 */
export type ContextArea = 'selection' | 'page'
export interface ContextAt {
  docId: string
  /** 0-based page that was right-clicked. */
  pageIndex: number
  numPages: number
  /** The selected text (empty on a 'page' menu). */
  selectionText: string
}
type ContextProvider = (at: ContextAt) => ContextItem[]
const contextProviders: { area: ContextArea; order: number; provider: ContextProvider }[] = []

export function registerContextItems(area: ContextArea, order: number, provider: ContextProvider): void {
  contextProviders.push({ area, order, provider })
}

/** The items for a right-click: every feature's group for this area, in order, with separators between groups. */
export function contextItemsFor(area: ContextArea, at: ContextAt): ContextItem[] {
  const out: ContextItem[] = []
  for (const p of [...contextProviders].filter((x) => x.area === area).sort((a, b) => a.order - b.order)) {
    let items: ContextItem[] = []
    try {
      items = p.provider(at)
    } catch (err) {
      console.error('context menu provider failed', err)
    }
    if (items.length === 0) continue
    if (out.length) out.push({ type: 'separator' })
    out.push(...items)
  }
  return out
}

/** Runs a command by id; commands that are disabled or unknown are ignored. */
export async function runCommand(id: string, args?: unknown): Promise<void> {
  const c = commands.get(id)
  if (!c || (c.enabled && !c.enabled())) return
  await c.run(args)
}

/** Test helper. */
/**
 * A step that runs before a document is written to disk (Save, Save As, Save a Copy), e.g. Fill & sign asking whether
 * to lock its items into the page. It may edit the document through `editPdf` (Save / Save As) or transform only the
 * bytes being written (`copy`: the open document must not change). Resolve false to cancel the save.
 */
export type BeforeSave = (docId: string, mode: 'save' | 'copy') => Promise<boolean | { transform(bytes: Uint8Array): Promise<Uint8Array> }>
const beforeSave: BeforeSave[] = []
export function registerBeforeSave(step: BeforeSave): void {
  beforeSave.push(step)
}
/** Runs every before-save step in order; returns false if one cancelled, else the byte transforms to apply. */
export async function runBeforeSave(docId: string, mode: 'save' | 'copy'): Promise<false | ((bytes: Uint8Array) => Promise<Uint8Array>)[]> {
  const transforms: ((bytes: Uint8Array) => Promise<Uint8Array>)[] = []
  for (const step of beforeSave) {
    const r = await step(docId, mode)
    if (r === false) return false
    if (typeof r === 'object') transforms.push(r.transform)
  }
  return transforms
}

export function _resetRegistries(): void {
  tools.length = panels.length = views.length = overlays.length = dialogs.length = 0
  contextProviders.length = 0
  beforeSave.length = 0
  commands.clear()
}
