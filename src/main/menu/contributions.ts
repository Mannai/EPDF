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

/** A menu item that runs a renderer command registered with `registerCommand(id, ...)`. */
export function commandItem(label: string, id: string, accelerator?: string): MenuItemConstructorOptions {
  return { label, accelerator, click: () => sendCommandImpl(id) }
}
