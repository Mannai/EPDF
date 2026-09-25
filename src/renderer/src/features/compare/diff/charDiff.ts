import { diffSequences } from './myers'

/** Character-level highlighting inside modified words and lines, plus a text similarity measure. */

/** Sørensen–Dice coefficient over character bigrams, in [0, 1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a.length && b.length && a[0] === b[0] && a.length === b.length ? 1 : 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  let shared = 0
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2)
    const c = grams.get(g)
    if (c) {
      shared++
      grams.set(g, c - 1)
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1))
}

export type Mark = [number, number]

export interface CharMarks {
  /** Ranges of `a` (UTF-16 offsets) that were removed. */
  a: Mark[]
  /** Ranges of `b` that were added. */
  b: Mark[]
}

const MAX_CHARS = 4000

function mergeMarks(marks: Mark[], text: string, maxGap: number): Mark[] {
  const out: Mark[] = []
  for (const m of marks) {
    const last = out[out.length - 1]
    if (last && m[0] - last[1] <= maxGap && !/\s/.test(text.slice(last[1], m[0]))) last[1] = m[1]
    else out.push([m[0], m[1]])
  }
  return out
}

/**
 * Which characters differ between two strings. Small islands of equal characters between two edits are absorbed
 * (so "12345" -> "1a3b5" reads as one edit), and when the strings share almost nothing the whole of each is marked.
 */
export function charMarks(a: string, b: string): CharMarks {
  if (a === b) return { a: [], b: [] }
  if (a.length > MAX_CHARS || b.length > MAX_CHARS || similarity(a, b) < 0.35) {
    return { a: a.length ? [[0, a.length]] : [], b: b.length ? [[0, b.length]] : [] }
  }
  const hunks = diffSequences(Array.from(a, (c) => c.charCodeAt(0)), Array.from(b, (c) => c.charCodeAt(0)))
  const am: Mark[] = []
  const bm: Mark[] = []
  for (const h of hunks) {
    if (h.aEnd > h.aStart) am.push([h.aStart, h.aEnd])
    if (h.bEnd > h.bStart) bm.push([h.bStart, h.bEnd])
  }
  return { a: mergeMarks(am, a, 1), b: mergeMarks(bm, b, 1) }
}

export interface Segment {
  text: string
  marked: boolean
}

/** Splits `text` into alternating plain / marked segments for display. */
export function segmentsOf(text: string, marks: Mark[]): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const [s, e] of marks) {
    if (s > at) out.push({ text: text.slice(at, s), marked: false })
    if (e > s) out.push({ text: text.slice(s, e), marked: true })
    at = Math.max(at, e)
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false })
  return out
}
