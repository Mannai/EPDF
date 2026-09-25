import { similarity } from './charDiff'
import { diffSequences, type Hunk } from './myers'
import type { CompareOptions } from './types'

/**
 * Word-level comparison of one aligned page pair. Produces structural changes (word index ranges and a kind);
 * the texts shown to the user are attached later from the pages' words.
 */

export interface PartRange {
  /** Word ranges [from, to) that really differ. */
  parts: [number, number][]
  /** Everything from the first to the last differing word, including tiny unchanged gaps between them. */
  span: [number, number]
}

export interface PageChange {
  kind: 'added' | 'removed' | 'modified'
  old: PartRange | null
  new: PartRange | null
  /** Where the change sits in the NEW page's word order (for a removal: the point it was removed at); sorts changes. */
  at: number
}

/** Unchanged words between two edits up to this many merge the edits into one change. */
export const MERGE_GAP = 1
/** A replacement counts as a modification when the old and new text are at least this alike... */
export const MODIFIED_SIMILARITY = 0.35
/** ...or when both sides are this small (one word replaced by another is an edit, not a delete plus an add). */
export const TINY_REPLACEMENT_WORDS = 2

const intern = (table: Map<string, number>, s: string): number => {
  let id = table.get(s)
  if (id === undefined) table.set(s, (id = table.size))
  return id
}

interface TokenHunk {
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

/** Word hunks between two key lists. */
function wordHunks(a: string[], b: string[]): TokenHunk[] {
  const table = new Map<string, number>()
  return diffSequences(a.map((k) => intern(table, k)), b.map((k) => intern(table, k)))
}

/**
 * Whitespace-insensitive comparison: keys are compared character by character (so "Hello world" equals
 * "Helloworld") and every difference is widened to the whole words it touches.
 */
function charModeHunks(a: string[], b: string[]): TokenHunk[] {
  const chars = (keys: string[]): { ids: number[]; owner: number[] } => {
    const ids: number[] = []
    const owner: number[] = []
    keys.forEach((k, t) => {
      for (const ch of k) {
        ids.push(ch.codePointAt(0)!)
        owner.push(t)
      }
    })
    return { ids, owner }
  }
  const A = chars(a)
  const B = chars(b)
  const range = (owner: number[], tokens: number, s: number, e: number): [number, number] => {
    if (e > s) return [owner[s], owner[e - 1] + 1]
    if (s > 0 && s < owner.length && owner[s - 1] === owner[s]) return [owner[s], owner[s] + 1] // an insertion inside a word
    const t = s < owner.length ? owner[s] : tokens
    return [t, t]
  }
  const hunks: TokenHunk[] = []
  for (const h of diffSequences(A.ids, B.ids) as Hunk[]) {
    const ra = range(A.owner, a.length, h.aStart, h.aEnd)
    const rb = range(B.owner, b.length, h.bStart, h.bEnd)
    const last = hunks[hunks.length - 1]
    if (last && (ra[0] < last.aEnd || rb[0] < last.bEnd || (ra[0] === last.aEnd && rb[0] === last.bEnd))) {
      last.aEnd = Math.max(last.aEnd, ra[1])
      last.bEnd = Math.max(last.bEnd, rb[1])
    } else hunks.push({ aStart: ra[0], aEnd: ra[1], bStart: rb[0], bEnd: rb[1] })
  }
  return hunks
}

const joined = (keys: string[], parts: [number, number][]): string => parts.map(([s, e]) => keys.slice(s, e).join(' ')).join(' ')
const count = (parts: [number, number][]): number => parts.reduce((n, [s, e]) => n + (e - s), 0)

/** Changes between the words (comparison keys) of an old and a new page. */
export function diffPage(oldKeys: string[], newKeys: string[], opts: CompareOptions): PageChange[] {
  if (oldKeys.length === newKeys.length && oldKeys.every((k, i) => k === newKeys[i])) return []
  const hunks = opts.ignoreWhitespace ? charModeHunks(oldKeys, newKeys) : wordHunks(oldKeys, newKeys)

  // Group hunks that are separated by at most MERGE_GAP unchanged words.
  const groups: TokenHunk[][] = []
  for (const h of hunks) {
    if (h.aEnd === h.aStart && h.bEnd === h.bStart) continue
    const g = groups[groups.length - 1]
    const last = g?.[g.length - 1]
    if (last && h.aStart - last.aEnd <= MERGE_GAP) g.push(h)
    else groups.push([h])
  }

  const out: PageChange[] = []
  for (const g of groups) {
    const oldParts: [number, number][] = g.filter((h) => h.aEnd > h.aStart).map((h) => [h.aStart, h.aEnd])
    const newParts: [number, number][] = g.filter((h) => h.bEnd > h.bStart).map((h) => [h.bStart, h.bEnd])
    const oldSpan: [number, number] = [g[0].aStart, g[g.length - 1].aEnd]
    const newSpan: [number, number] = [g[0].bStart, g[g.length - 1].bEnd]
    const oldRange: PartRange = { parts: oldParts, span: oldSpan }
    const newRange: PartRange = { parts: newParts, span: newSpan }
    const at = newSpan[0]
    if (oldParts.length === 0) out.push({ kind: 'added', old: null, new: newRange, at })
    else if (newParts.length === 0) out.push({ kind: 'removed', old: oldRange, new: null, at })
    else {
      const nOld = count(oldParts)
      const nNew = count(newParts)
      const alike = similarity(joined(oldKeys, oldParts), joined(newKeys, newParts)) >= MODIFIED_SIMILARITY
      if (alike || (nOld <= TINY_REPLACEMENT_WORDS && nNew <= TINY_REPLACEMENT_WORDS)) out.push({ kind: 'modified', old: oldRange, new: newRange, at })
      else {
        // Unrelated text swapped in: a removal followed by an addition.
        out.push({ kind: 'removed', old: oldRange, new: null, at })
        out.push({ kind: 'added', old: null, new: newRange, at })
      }
    }
  }
  return out
}
