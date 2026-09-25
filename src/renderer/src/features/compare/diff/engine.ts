import { alignPages } from './align'
import { detectMoves, type Chunk } from './moves'
import { diffPage, type PartRange } from './pageDiff'
import type { Change, ChangeKind, CompareCounts, CompareOptions, CompareResult, Loc, PagePair } from './types'

/**
 * The whole comparison on comparison keys only (no geometry, no PDF.js): align pages, diff each aligned pair,
 * detect moved blocks, classify and order the changes. It runs in a Web Worker in the app and in Node in tests.
 */

export interface EngineHooks {
  progress?(phase: 'align' | 'diff' | 'moves', done: number, total: number): void
}

interface Raw {
  kind: ChangeKind
  /** Pair index of the primary location (the new side when there is one). */
  pair: number
  old: { pair: number; range: PartRange } | null
  new: { pair: number; range: PartRange } | null
  at: number
  edited?: boolean
}

const wholePage = (n: number): PartRange => ({ parts: [[0, n]], span: [0, n] })

const keysOfParts = (keys: string[], r: PartRange): string[] => r.parts.flatMap(([s, e]) => keys.slice(s, e))

export function countsOf(changes: { kind: ChangeKind }[]): CompareCounts {
  const c: CompareCounts = { added: 0, removed: 0, modified: 0, moved: 0, total: changes.length }
  for (const ch of changes) c[ch.kind]++
  return c
}

export function runCompare(oldPages: string[][], newPages: string[][], opts: CompareOptions, hooks: EngineHooks = {}): CompareResult {
  hooks.progress?.('align', 0, 1)
  const pairs: PagePair[] = alignPages(oldPages, newPages)
  hooks.progress?.('align', 1, 1)

  const raws: Raw[] = []
  pairs.forEach((pair, p) => {
    if (pair.old !== null && pair.new !== null) {
      for (const ch of diffPage(oldPages[pair.old - 1], newPages[pair.new - 1], opts)) {
        raws.push({
          kind: ch.kind,
          pair: p,
          old: ch.old ? { pair: p, range: ch.old } : null,
          new: ch.new ? { pair: p, range: ch.new } : null,
          at: ch.at
        })
      }
    } else if (pair.old !== null) {
      const n = oldPages[pair.old - 1].length
      if (n > 0) raws.push({ kind: 'removed', pair: p, old: { pair: p, range: wholePage(n) }, new: null, at: 0 })
    } else if (pair.new !== null) {
      const n = newPages[pair.new - 1].length
      if (n > 0) raws.push({ kind: 'added', pair: p, old: null, new: { pair: p, range: wholePage(n) }, at: 0 })
    }
    if (p % 8 === 0) hooks.progress?.('diff', p, pairs.length)
  })
  hooks.progress?.('diff', pairs.length, pairs.length)

  // ---- moved blocks -----------------------------------------------------------------------------------------
  hooks.progress?.('moves', 0, 1)
  const removed: Chunk[] = []
  const added: Chunk[] = []
  raws.forEach((r, id) => {
    if (r.kind === 'removed' && r.old) removed.push({ id, keys: keysOfParts(oldPages[pairs[r.old.pair].old! - 1], r.old.range), pair: r.old.pair })
    else if (r.kind === 'added' && r.new) added.push({ id, keys: keysOfParts(newPages[pairs[r.new.pair].new! - 1], r.new.range), pair: r.new.pair })
  })
  const gone = new Set<number>()
  const movedRaws: Raw[] = []
  for (const m of detectMoves(removed, added)) {
    const from = raws[m.removed]
    const to = raws[m.added]
    gone.add(m.removed)
    gone.add(m.added)
    movedRaws.push({ kind: 'moved', pair: to.pair, old: from.old, new: to.new, at: to.at, edited: m.edited })
  }
  const all = [...raws.filter((_, i) => !gone.has(i)), ...movedRaws]
  hooks.progress?.('moves', 1, 1)

  // ---- order, number and count ---------------------------------------------------------------------------------
  const order = { removed: 0, modified: 1, added: 2, moved: 3 } as const
  all.sort((a, b) => a.pair - b.pair || a.at - b.at || order[a.kind] - order[b.kind])
  const loc = (side: { pair: number; range: PartRange } | null, which: 'old' | 'new'): Loc | undefined =>
    side ? { pair: side.pair, page: pairs[side.pair][which]!, parts: side.range.parts, span: side.range.span } : undefined
  const changes: Change[] = all.map((r, id) => ({ id, kind: r.kind, pair: r.pair, old: loc(r.old, 'old'), new: loc(r.new, 'new'), ...(r.edited ? { edited: true } : {}) }))

  for (const c of changes) {
    const touched = new Set<number>([c.pair])
    if (c.old) touched.add(c.old.pair)
    if (c.new) touched.add(c.new.pair)
    for (const p of touched) pairs[p].changes++
  }
  const changedPairs = pairs.filter((p) => p.changes > 0 || p.old === null || p.new === null || p.moved).length
  return { pairs, changes, counts: countsOf(changes), changedPairs }
}
