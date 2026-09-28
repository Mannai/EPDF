const defaultIsMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** Running on macOS (Cmd instead of Ctrl, Mac key symbols). */
export const isMac = defaultIsMac

interface KeyLike {
  key: string
  /** The physical key (`KeyM`, `Digit1`); optional for callers that only have `key`. */
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Matches a keyboard event against a spec such as `mod+shift+h` or `alt+1`. `mod` is Cmd on macOS and
 * Ctrl elsewhere. Modifiers must match exactly (a spec without `shift` does not match Shift+key), and the
 * key part is compared case-insensitively with `event.key`. With Alt held, macOS reports the Option character
 * (Option+M is `µ`), so a letter or digit then also matches by its physical key (`event.code`).
 */
export function matchesShortcut(e: KeyLike, spec: string, isMac = defaultIsMac): boolean {
  const parts = spec.toLowerCase().split('+')
  const key = parts.pop()!
  const want = new Set(parts)
  const wantCtrl = want.has('ctrl') || (want.has('mod') && !isMac)
  const wantMeta = want.has('meta') || (want.has('mod') && isMac)
  const physical = /^[a-z]$/.test(key) ? `key${key}` : /^[0-9]$/.test(key) ? `digit${key}` : null
  return (
    e.ctrlKey === wantCtrl &&
    e.metaKey === wantMeta &&
    e.shiftKey === want.has('shift') &&
    e.altKey === want.has('alt') &&
    (e.key.toLowerCase() === key || (e.altKey && physical !== null && e.code?.toLowerCase() === physical))
  )
}

/**
 * A shortcut written the Windows way (`Ctrl+Shift+S`, `Ctrl+Y`), as a native menu accelerator for this platform:
 * on macOS Ctrl becomes Cmd and Redo's Ctrl+Y becomes Cmd+Shift+Z, as in the menu bar.
 */
export function platformAccelerator(keys: string, isMac = defaultIsMac): string {
  if (!isMac) return keys
  if (/^ctrl\+y$/i.test(keys)) return 'Cmd+Shift+Z'
  return keys.replace(/\bCtrl\b/gi, 'Cmd')
}

const MAC_SYMBOLS: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘', meta: '⌘' }
const MAC_ORDER = ['ctrl', 'alt', 'shift', 'cmd', 'meta']

/**
 * A shortcut written the Windows way, for tooltips and messages: unchanged on Windows and Linux, and on macOS in
 * the Mac's own notation (`Ctrl+Shift+B` → `⇧⌘B`, `Ctrl+Y` → `⇧⌘Z`).
 */
export function shortcutLabel(keys: string, isMac = defaultIsMac): string {
  if (!isMac) return keys
  const parts = platformAccelerator(keys, true).split('+')
  // A trailing "+" key ("Ctrl++") splits into empty parts.
  const key = parts.length > 1 && parts[parts.length - 1] === '' ? '+' : parts.pop()!
  const mods = parts.filter(Boolean).map((p) => p.toLowerCase())
  const sorted = MAC_ORDER.filter((m) => mods.includes(m)).map((m) => MAC_SYMBOLS[m])
  return [...new Set(sorted)].join('') + (key.length === 1 ? key.toUpperCase() : key)
}

export const isEditableTarget = (el: EventTarget | null): boolean => {
  const n = el as HTMLElement | null
  return !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable)
}
