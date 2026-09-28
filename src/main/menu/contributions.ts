import type { MenuItemConstructorOptions } from 'electron'

export type MenuName = 'File' | 'Edit' | 'View' | 'Document' | 'Tools' | 'Window' | 'Help'

export interface MenuContribution {
  menu: MenuName
  /** Where in the menu the items go. Default `end`. */
  position?: 'start' | 'end'
  /** Called each time the menu is (re)built, so labels/enabled state can be dynamic. */
  items: () => MenuItemConstructorOptions[]
}

const contributions: MenuContribution[] = []
let sendCommandImpl: (id: string) => void = () => undefined

/** Features add their own menu items here (e.g. Tools ▸ Compress PDF…). */
export function contributeMenu(c: MenuContribution): void {
  contributions.push(c)
}

export function contributionsFor(menu: MenuName, position: 'start' | 'end'): MenuItemConstructorOptions[] {
  return contributions
    .filter((c) => c.menu === menu && (c.position ?? 'end') === position)
    .flatMap((c) => c.items())
}

export function setCommandSender(fn: (id: string) => void): void {
  sendCommandImpl = fn
}

/**
 * Menu item ids starting with this need an open document: the File button's menu greys them out on the start
 * screen (see features/chrome).
 */
export const NEEDS_DOCUMENT = 'doc:'

/** macOS: id of the application menu (Epdf ▸ About, Hide, Quit), which the ribbon's File button leaves out. */
export const APP_MENU_ID = 'app-menu'

/**
 * A menu item that runs a renderer command registered with `registerCommand(id, ...)`. It works on the open document
 * unless `anyTime` says it also works with none (Create PDF, Combine, Scan, Library...).
 */
export function commandItem(
  label: string,
  id: string,
  accelerator?: string,
  opts: { anyTime?: boolean } = {}
): MenuItemConstructorOptions {
  return { id: (opts.anyTime ? 'cmd:' : NEEDS_DOCUMENT) + id, label, accelerator, click: () => sendCommandImpl(id) }
}
