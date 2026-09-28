import { describe, expect, it } from 'vitest'
import { matchesShortcut, platformAccelerator, shortcutLabel } from '../../src/renderer/src/features/keys'

const ev = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})

describe('matchesShortcut', () => {
  it('maps mod to Ctrl on Windows/Linux and Cmd on macOS', () => {
    expect(matchesShortcut(ev('h', { ctrlKey: true }), 'mod+h', false)).toBe(true)
    expect(matchesShortcut(ev('h', { metaKey: true }), 'mod+h', false)).toBe(false)
    expect(matchesShortcut(ev('h', { metaKey: true }), 'mod+h', true)).toBe(true)
    expect(matchesShortcut(ev('h', { ctrlKey: true }), 'mod+h', true)).toBe(false)
  })
  it('requires modifiers to match exactly', () => {
    expect(matchesShortcut(ev('h', { ctrlKey: true, shiftKey: true }), 'mod+h', false)).toBe(false)
    expect(matchesShortcut(ev('h', { ctrlKey: true, shiftKey: true }), 'mod+shift+h', false)).toBe(true)
    expect(matchesShortcut(ev('h'), 'mod+h', false)).toBe(false)
  })
  it('matches plain keys and is case-insensitive', () => {
    expect(matchesShortcut(ev('H'), 'h', false)).toBe(true)
    expect(matchesShortcut(ev('h', { altKey: true }), 'h', false)).toBe(false)
    expect(matchesShortcut(ev('1', { altKey: true }), 'alt+1', false)).toBe(true)
  })
  it('matches Option shortcuts on macOS by the physical key (Option+M types µ)', () => {
    expect(matchesShortcut({ ...ev('µ', { metaKey: true, altKey: true }), code: 'KeyM' }, 'mod+alt+m', true)).toBe(true)
    expect(matchesShortcut({ ...ev('¡', { altKey: true }), code: 'Digit1' }, 'alt+1', true)).toBe(true)
    // without Alt the typed character decides, so a remapped layout keeps its letters
    expect(matchesShortcut({ ...ev('z', { metaKey: true }), code: 'KeyY' }, 'mod+y', true)).toBe(false)
    expect(matchesShortcut({ ...ev('µ', { metaKey: true, altKey: true }), code: 'KeyK' }, 'mod+alt+m', true)).toBe(false)
  })
})

describe('shortcut notation per platform', () => {
  it('menu accelerators use Cmd on macOS and stay as written elsewhere', () => {
    expect(platformAccelerator('Ctrl+W', false)).toBe('Ctrl+W')
    expect(platformAccelerator('Ctrl+Y', false)).toBe('Ctrl+Y')
    expect(platformAccelerator('Ctrl+W', true)).toBe('Cmd+W')
    expect(platformAccelerator('Ctrl+Alt+D', true)).toBe('Cmd+Alt+D')
    expect(platformAccelerator('Ctrl+Y', true)).toBe('Cmd+Shift+Z')
    expect(platformAccelerator('Delete', true)).toBe('Delete')
  })
  it('labels use the Mac symbols in Apple order on macOS', () => {
    expect(shortcutLabel('Ctrl+S', false)).toBe('Ctrl+S')
    expect(shortcutLabel('Ctrl+S', true)).toBe('⌘S')
    expect(shortcutLabel('Ctrl+Shift+B', true)).toBe('⇧⌘B')
    expect(shortcutLabel('Ctrl+Alt+G', true)).toBe('⌥⌘G')
    expect(shortcutLabel('Ctrl+Y', true)).toBe('⇧⌘Z')
    expect(shortcutLabel('Ctrl+-', true)).toBe('⌘-')
    expect(shortcutLabel('Ctrl+=', true)).toBe('⌘=')
    expect(shortcutLabel('Ctrl+[', true)).toBe('⌘[')
    expect(shortcutLabel('Ctrl++', true)).toBe('⌘+')
    expect(shortcutLabel('Shift+F8', true)).toBe('⇧F8')
    expect(shortcutLabel('F8', true)).toBe('F8')
  })
})
