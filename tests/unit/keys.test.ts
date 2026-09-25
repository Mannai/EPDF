import { describe, expect, it } from 'vitest'
import { matchesShortcut } from '../../src/renderer/src/features/keys'

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
})
