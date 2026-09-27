import { Menu, nativeTheme, type MenuItem } from 'electron'
import { z } from 'zod'
import { chromeOverlay, customTitleBar } from '../../windows/WindowManager'
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

  registerFeatureChannel('chrome:menu', z.object({ x: z.number().finite(), y: z.number().finite() }), ({ x, y }, call) => {
    const win = call.window?.win
    const app = Menu.getApplicationMenu()
    if (!win || !app) return
    // File's own items first (as Office's File tab), then the other menus as submenus.
    const [file, ...rest] = app.items as MenuItem[]
    const template = [
      ...(file?.submenu?.items ?? []).map(clone),
      { type: 'separator' as const },
      ...rest.filter((m) => m.submenu && m.visible !== false).map(clone)
    ]
    Menu.buildFromTemplate(template).popup({ window: win, x: Math.round(x), y: Math.round(y) })
  })
}

/** A live MenuItem as a template (items can't be in two menus at once). Clicks run the original handler. */
function clone(item: MenuItem): Electron.MenuItemConstructorOptions {
  return {
    label: item.label,
    type: item.type,
    role: item.role,
    accelerator: item.accelerator ?? undefined,
    enabled: item.enabled,
    visible: item.visible,
    checked: item.checked,
    registerAccelerator: false, // the application menu already owns the accelerators
    click: item.role || item.type === 'submenu' ? undefined : (_i, w, e) => item.click(e, w ?? undefined, undefined),
    submenu: item.submenu ? item.submenu.items.map(clone) : undefined
  }
}
