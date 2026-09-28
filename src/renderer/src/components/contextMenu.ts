import { getCommands, runCommand } from '../features/api'
import { platformAccelerator } from '../features/keys'

/**
 * Right-click menus, shown by main as native Windows menus (src/main/features/chrome/contextMenu.ts). An item either
 * runs a registered command (`command`, so right-click, the ribbon and the menu bar do exactly the same thing) or a
 * local action (`run`). Menus open with the right mouse button, Shift+F10 or the Menu key: the browser fires
 * `contextmenu` for all three.
 */
export type ContextItem =
  | { type: 'separator' }
  | {
      label: string
      command?: string
      run?: () => void | Promise<void>
      enabled?: boolean
      checked?: boolean
      /**
       * The key that does the same thing, shown at the right of the item. Display only: it binds nothing. Written
       * the Windows way (`Ctrl+W`); macOS shows the Cmd equivalent.
       */
      keys?: string
      submenu?: ContextItem[]
    }

interface Wire {
  id?: string
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  enabled?: boolean
  checked?: boolean
  accelerator?: string
  submenu?: Wire[]
}

/** Separators at the ends or next to each other are dropped, so builders can add groups conditionally. */
function tidy(items: ContextItem[]): ContextItem[] {
  const out: ContextItem[] = []
  for (const i of items) {
    if ('type' in i && i.type === 'separator') {
      if (out.length && !('type' in out[out.length - 1]!)) out.push(i)
    } else out.push(i)
  }
  while (out.length && 'type' in out[out.length - 1]!) out.pop()
  return out
}

const commandEnabled = (id: string): boolean => {
  const c = getCommands().find((x) => x.id === id)
  return !!c && (c.enabled ? c.enabled() : true)
}

/** Shows `items` at the pointer (or at the element, for keyboard-opened menus) and runs the chosen one. */
export async function openContextMenu(e: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault?(): void; stopPropagation?(): void }, items: ContextItem[]): Promise<void> {
  e.preventDefault?.()
  e.stopPropagation?.()
  const actions = new Map<string, () => void | Promise<void>>()
  let n = 0
  const wire = (list: ContextItem[]): Wire[] =>
    tidy(list).map((i) => {
      if ('type' in i) return { type: 'separator' }
      if (i.submenu) return { label: i.label, submenu: wire(i.submenu), enabled: i.enabled !== false }
      const id = `m${n++}`
      const run = i.run ?? (i.command ? () => void runCommand(i.command!) : undefined)
      if (run) actions.set(id, run)
      const enabled = (i.enabled ?? true) && (i.command ? commandEnabled(i.command) : true) && !!run
      const accelerator = i.keys === undefined ? undefined : platformAccelerator(i.keys)
      return { id, label: i.label, enabled, type: i.checked === undefined ? 'normal' : 'checkbox', checked: i.checked, accelerator }
    })
  const menu = wire(items)
  if (!menu.length) return
  // A keyboard-opened menu (Shift+F10 / Menu key) reports 0,0: open it at the element instead.
  let { clientX: x, clientY: y } = e
  if (x === 0 && y === 0 && e.currentTarget instanceof Element) {
    const r = e.currentTarget.getBoundingClientRect()
    x = r.left + Math.min(24, r.width / 2)
    y = r.top + Math.min(24, r.height / 2)
  }
  const chosen = await window.epdf.call<string | null>('chrome:contextMenu', { x, y, items: menu })
  if (chosen) await actions.get(chosen)?.()
}
