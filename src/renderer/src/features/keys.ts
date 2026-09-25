const defaultIsMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Matches a keyboard event against a spec such as `mod+shift+h` or `alt+1`. `mod` is Cmd on macOS and
 * Ctrl elsewhere. Modifiers must match exactly (a spec without `shift` does not match Shift+key), and the
 * key part is compared case-insensitively with `event.key`.
 */
export function matchesShortcut(e: KeyLike, spec: string, isMac = defaultIsMac): boolean {
  const parts = spec.toLowerCase().split('+')
  const key = parts.pop()!
  const want = new Set(parts)
  const wantCtrl = want.has('ctrl') || (want.has('mod') && !isMac)
  const wantMeta = want.has('meta') || (want.has('mod') && isMac)
  return (
    e.ctrlKey === wantCtrl &&
    e.metaKey === wantMeta &&
    e.shiftKey === want.has('shift') &&
    e.altKey === want.has('alt') &&
    e.key.toLowerCase() === key
  )
}

export const isEditableTarget = (el: EventTarget | null): boolean => {
  const n = el as HTMLElement | null
  return !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable)
}
