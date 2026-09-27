import { app, Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'
import { z } from 'zod'

/**
 * Right-click menus. The renderer describes the menu (ids, labels, enabled/checked, separators, one level of
 * submenus); main shows it as a native Windows menu and answers with the chosen id, or null when dismissed. The
 * renderer then runs the matching command, so right-click, the ribbon and the menu bar always do the same thing.
 *
 * Text fields the renderer does not handle get the standard Undo / Cut / Copy / Paste / Select all menu.
 */

export interface ContextItem {
  id?: string
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  enabled?: boolean
  checked?: boolean
  accelerator?: string
  submenu?: ContextItem[]
}

const Item: z.ZodType<ContextItem> = z.lazy(() =>
  z.object({
    id: z.string().max(200).optional(),
    label: z.string().max(200).optional(),
    type: z.enum(['normal', 'separator', 'checkbox']).optional(),
    enabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    accelerator: z.string().max(60).optional(),
    submenu: z.array(Item).max(60).optional()
  })
)
export const ContextMenuRequest = z.object({ x: z.number().finite(), y: z.number().finite(), items: z.array(Item).max(60) })

/**
 * Test hook (never set in normal use): when a test puts a label (or id) in `globalThis.__epdfContextMenuChoose`, the
 * next menu is not shown; that item is chosen instead, and every menu is recorded in `__epdfContextMenus`, so e2e
 * tests can drive right-click without a native menu (which Playwright cannot click).
 */
type TestGlobals = { __epdfContextMenuChoose?: string | null; __epdfContextMenus?: ContextItem[][] }

const flatten = (items: ContextItem[]): ContextItem[] => items.flatMap((i) => [i, ...(i.submenu ? flatten(i.submenu) : [])])

export function showContextMenu(win: BrowserWindow, req: z.infer<typeof ContextMenuRequest>): Promise<string | null> {
  const g = globalThis as TestGlobals
  if (Array.isArray(g.__epdfContextMenus)) g.__epdfContextMenus.push(req.items)
  if (g.__epdfContextMenuChoose != null) {
    const want = g.__epdfContextMenuChoose
    g.__epdfContextMenuChoose = null
    const hit = flatten(req.items).find((i) => (i.label === want || i.id === want) && i.id && i.enabled !== false)
    return Promise.resolve(hit?.id ?? null)
  }
  return new Promise((resolve) => {
    let chosen: string | null = null
    const build = (items: ContextItem[]): MenuItemConstructorOptions[] =>
      items.map((i) =>
        i.type === 'separator'
          ? { type: 'separator' }
          : {
              label: i.label ?? '',
              type: i.submenu ? 'submenu' : (i.type ?? 'normal'),
              enabled: i.enabled !== false,
              checked: i.checked,
              accelerator: i.accelerator,
              registerAccelerator: false, // shown for reference; the real shortcut lives elsewhere
              submenu: i.submenu ? build(i.submenu) : undefined,
              click: i.submenu || !i.id ? undefined : () => (chosen = i.id!)
            }
      )
    Menu.buildFromTemplate(build(req.items)).popup({
      window: win,
      x: Math.round(req.x),
      y: Math.round(req.y),
      // The click handler runs before the menu reports it closed; wait a tick so a chosen item always wins.
      callback: () => setTimeout(() => resolve(chosen), 0)
    })
  })
}

/** Standard edit menu for text fields and plain text the page itself does not give a menu. */
export function installEditableFallback(): void {
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('context-menu', (_ev, p: ContextMenuParams) => {
      const g = globalThis as TestGlobals
      let items: MenuItemConstructorOptions[] = []
      if (p.isEditable) {
        items = [
          { role: 'undo', label: 'Undo', enabled: p.editFlags.canUndo },
          { role: 'redo', label: 'Redo', enabled: p.editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', label: 'Cut', enabled: p.editFlags.canCut },
          { role: 'copy', label: 'Copy', enabled: p.editFlags.canCopy },
          { role: 'paste', label: 'Paste', enabled: p.editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', label: 'Select all', enabled: p.editFlags.canSelectAll }
        ]
      } else if (p.selectionText.trim()) {
        items = [{ role: 'copy', label: 'Copy' }]
      }
      if (!items.length) return
      if (Array.isArray(g.__epdfContextMenus)) g.__epdfContextMenus.push(items.map((i) => ({ label: i.label, type: i.type === 'separator' ? 'separator' : 'normal', enabled: i.enabled !== false })))
      if (g.__epdfContextMenuChoose != null) {
        const want = g.__epdfContextMenuChoose
        g.__epdfContextMenuChoose = null
        const role = items.find((i) => i.label === want)?.role
        const wc = win.webContents
        if (role === 'cut') wc.cut()
        else if (role === 'copy') wc.copy()
        else if (role === 'paste') wc.paste()
        else if (role === 'selectAll') wc.selectAll()
        else if (role === 'undo') wc.undo()
        else if (role === 'redo') wc.redo()
        return
      }
      Menu.buildFromTemplate(items).popup({ window: win, x: p.x, y: p.y })
    })
  })
}
