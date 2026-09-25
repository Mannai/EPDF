import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Keyboard shortcuts are declared in three places: renderer commands (`shortcut: 'mod+shift+h'`), native menu
 * items (`accelerator` / `commandItem(..., 'CmdOrCtrl+S')`) and the viewer's own keys. Two features silently
 * fighting over the same key is a bug users find by accident, so this test scans the sources and fails on any
 * collision. To add a shortcut, pick a free one; to share one deliberately, add it to ALLOWED with a reason.
 */

const ROOT = join(__dirname, '..', '..', 'src')

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
  })

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/cmdorctrl|commandorcontrol|mod/g, 'mod')
    .replace(/command|cmd/g, 'meta')
    .replace(/control/g, 'ctrl')
    .split('+')
    .map((p) => p.trim())
    .sort((a, b) => (a === 'mod' || a === 'ctrl' || a === 'meta' || a === 'alt' || a === 'shift' ? -1 : 1) - (b === 'mod' || b === 'ctrl' || b === 'meta' || b === 'alt' || b === 'shift' ? -1 : 1) || a.localeCompare(b))
    .join('+')

interface Use {
  key: string
  where: string
  kind: 'renderer' | 'menu'
}

function collect(): Use[] {
  const uses: Use[] = []
  for (const f of files(ROOT)) {
    const src = readFileSync(f, 'utf8')
    const rel = relative(ROOT, f).replace(/\\/g, '/')
    const inRenderer = rel.startsWith('renderer/')
    if (inRenderer) {
      for (const m of src.matchAll(/\bshortcut:\s*['"`]([^'"`]+)['"`]/g)) uses.push({ key: norm(m[1]), where: rel, kind: 'renderer' })
    } else if (rel.startsWith('main/')) {
      for (const m of src.matchAll(/['"`]((?:CmdOrCtrl|Ctrl|Cmd|Command|Control|Alt|Shift)(?:\+[A-Za-z0-9=\-[\]\\,./]+)+)['"`]/g)) {
        uses.push({ key: norm(m[1]), where: rel, kind: 'menu' })
      }
    }
  }
  return uses
}

/** key -> reason. Only for collisions that are intentional (same action, or mutually exclusive contexts). */
const ALLOWED: Record<string, string> = {
  'mod+shift+z': 'Redo: one visible (mac) and one hidden (other platforms) menu item for the same command',
  'ctrl+y': 'Redo: visible on Windows/Linux, alongside the hidden mod+shift+z item'
}

describe('keyboard shortcuts', () => {
  const uses = collect()

  it('finds the shortcuts it is supposed to audit (guards against the scanner silently matching nothing)', () => {
    expect(uses.filter((u) => u.kind === 'menu').length).toBeGreaterThan(15)
    expect(uses.filter((u) => u.kind === 'renderer').length).toBeGreaterThan(10)
  })

  it('no two features/menu items claim the same key combination', () => {
    const byKey = new Map<string, Use[]>()
    for (const u of uses) byKey.set(u.key, [...(byKey.get(u.key) ?? []), u])
    const clashes = [...byKey.entries()]
      .filter(([key, list]) => list.length > 1 && !(key in ALLOWED))
      // The same file declaring the same key twice is one declaration for our purposes (per-platform variants).
      .filter(([, list]) => new Set(list.map((u) => u.where)).size > 1 || list.length > 2)
      .map(([key, list]) => `${key}  ←  ${list.map((u) => `${u.where} (${u.kind})`).join(', ')}`)
    expect(clashes).toEqual([])
  })

  it('bare-letter tool shortcuts are unique across features', () => {
    const letters = uses.filter((u) => u.kind === 'renderer' && /^[a-z0-9]$/.test(u.key))
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const u of letters) {
      if (seen.has(u.key)) dupes.push(`'${u.key}': ${seen.get(u.key)} and ${u.where}`)
      else seen.set(u.key, u.where)
    }
    expect(dupes).toEqual([])
  })
})
