import { Menu, nativeTheme, type MenuItem } from 'electron'
import { z } from 'zod'
import { chromeOverlay, customTitleBar } from '../../windows/WindowManager'
import { APP_MENU_ID, NEEDS_DOCUMENT } from '../../menu/contributions'
import { registerFeatureChannel, type MainContext } from '../api'
import { ContextMenuRequest, installEditableFallback, showContextMenu } from './contextMenu'

/**
 * Window chrome for the Windows title bar drawn by the renderer (see docs/features/chrome.md):
 *  - the caption buttons Windows draws over the title bar follow the light/dark theme;
 *  - `chrome:menu` pops up the application menu (File, Edit, View, Document, Tools, Window, Help) under the
 *    title bar's "File" button, because a hidden title bar has no menu bar. The menu itself is unchanged, so every
 *    feature's menu item and every accelerator keep working.
 */
export function register(ctx: MainContext): void {
  // Right-click menus (see ./contextMenu.ts).
  installEditableFallback()
  registerFeatureChannel('chrome:contextMenu', ContextMenuRequest, (req, call) => {
    const win = call.window?.win
    return win ? showContextMenu(win, req) : null
  })

  if (customTitleBar) {
    nativeTheme.on('updated', () => {
      const overlay = chromeOverlay(nativeTheme.shouldUseDarkColors)
      for (const w of ctx.windows.all()) if (!w.win.isDestroyed()) w.win.setTitleBarOverlay(overlay)
    })
  }

  registerFeatureChannel(
    'chrome:menu',
    z.object({ x: z.number().finite(), y: z.number().finite(), hasDocument: z.boolean().optional() }),
    ({ x, y, hasDocument }, call) => {
      const win = call.window?.win
      const app = Menu.getApplicationMenu()
      if (!win || !app) return
      // File's own items first (as Office's File tab), then the other menus as submenus. On the start screen the
      // items that need a document are greyed out (and so is a submenu with nothing left to choose).
      const copy = (item: MenuItem): Electron.MenuItemConstructorOptions => clone(item, hasDocument !== false)
      // macOS puts the application menu (About, Hide, Quit) first; it stays in the menu bar only.
      const [file, ...rest] = (app.items as MenuItem[]).filter((m) => m.id !== APP_MENU_ID)
      const template = [
        ...(file?.submenu?.items ?? []).map(copy),
        { type: 'separator' as const },
        ...rest.filter((m) => m.submenu && m.visible !== false).map(copy)
      ]
      // Test hook (never set in normal use): record the menu instead of showing it, as for right-click menus.
      const g = globalThis as { __epdfFileMenus?: unknown[] }
      if (Array.isArray(g.__epdfFileMenus)) return void g.__epdfFileMenus.push(summary(template))
      Menu.buildFromTemplate(template).popup({ window: win, x: Math.round(x), y: Math.round(y) })
    }
  )
}

interface MenuSummary {
  label: string
  enabled: boolean
  submenu?: MenuSummary[]
}
const summary = (items: Electron.MenuItemConstructorOptions[]): MenuSummary[] =>
  items
    .filter((i) => i.type !== 'separator' && i.visible !== false)
    .map((i) => ({
      label: (i.label ?? String(i.role ?? '')).replace(/&(?!&)/g, '').replace(/&&/g, '&'),
      enabled: i.enabled !== false,
      submenu: Array.isArray(i.submenu) ? summary(i.submenu) : undefined
    }))

/** A live MenuItem as a template (items can't be in two menus at once). Clicks run the original handler. */
export function clone(item: MenuItem, hasDocument = true): Electron.MenuItemConstructorOptions {
  const submenu = item.submenu ? item.submenu.items.map((i) => clone(i, hasDocument)) : undefined
  const usable = (i: Electron.MenuItemConstructorOptions): boolean =>
    i.type !== 'separator' && i.visible !== false && i.enabled !== false
  const enabled =
    item.enabled &&
    (hasDocument || !item.id?.startsWith(NEEDS_DOCUMENT)) &&
    (hasDocument || !submenu || submenu.some(usable))
  return {
    id: item.id,
    label: item.label,
    type: item.type,
    role: item.role,
    accelerator: item.accelerator ?? undefined,
    enabled,
    visible: item.visible,
    checked: item.checked,
    registerAccelerator: false, // the application menu already owns the accelerators
    click: item.role || item.type === 'submenu' ? undefined : (_i, w, e) => item.click(e, w ?? undefined, undefined),
    submenu
  }
}
