import type { Rect } from '../../textedit/pdfcontent/matrix'

export type { Rect }

/** Geometry helpers for redaction marks. Rects are in PDF user space (points, y up), x0<=x1, y0<=y1. */

export const rectArea = (r: Rect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0)

export const normRect = (r: Rect): Rect => ({ x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) })

export function intersect(a: Rect, b: Rect): Rect | null {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }
  return r.x0 < r.x1 && r.y0 < r.y1 ? r : null
}

export function unionBox(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let { x0, y0, x1, y1 } = rects[0]
  for (const r of rects) {
    x0 = Math.min(x0, r.x0)
    y0 = Math.min(y0, r.y0)
    x1 = Math.max(x1, r.x1)
    y1 = Math.max(y1, r.y1)
  }
  return { x0, y0, x1, y1 }
}

/** True when the rect overlaps any mark with a positive area (or, for degenerate rects, touches it). */
export function touches(r: Rect, marks: readonly Rect[]): boolean {
  const degenerate = r.x1 - r.x0 <= 1e-9 || r.y1 - r.y0 <= 1e-9
  for (const m of marks) {
    if (degenerate) {
      if (r.x0 >= m.x0 && r.x1 <= m.x1 && r.y0 >= m.y0 && r.y1 <= m.y1) return true
    } else if (r.x0 < m.x1 && m.x0 < r.x1 && r.y0 < m.y1 && m.y0 < r.y1) return true
  }
  return false
}

/**
 * Splits a set of possibly overlapping rects into disjoint rects covering exactly the same area.
 * (Needed for even-odd clipping and exact coverage arithmetic.)
 */
export function disjointRects(rects: readonly Rect[]): Rect[] {
  const rs = rects.map(normRect).filter((r) => r.x1 > r.x0 && r.y1 > r.y0)
  if (rs.length <= 1) return rs
  const xs = [...new Set(rs.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b)
  const slabs: { x0: number; x1: number; ys: [number, number][] }[] = []
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i]
    const x1 = xs[i + 1]
    const spans = rs
      .filter((r) => r.x0 <= x0 && r.x1 >= x1)
      .map((r) => [r.y0, r.y1] as [number, number])
      .sort((a, b) => a[0] - b[0])
    if (!spans.length) continue
    const merged: [number, number][] = []
    for (const s of spans) {
      const last = merged[merged.length - 1]
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
      else merged.push([s[0], s[1]])
    }
    slabs.push({ x0, x1, ys: merged })
  }
  // Merge horizontally adjacent slabs with identical vertical spans.
  const out: Rect[] = []
  let open = new Map<string, Rect>()
  for (const s of slabs) {
    const next = new Map<string, Rect>()
    for (const [y0, y1] of s.ys) {
      const key = `${y0}:${y1}`
      const cur = open.get(key)
      if (cur && cur.x1 === s.x0) {
        cur.x1 = s.x1
        next.set(key, cur)
      } else {
        const r = { x0: s.x0, y0, x1: s.x1, y1 }
        out.push(r)
        next.set(key, r)
      }
    }
    open = next
  }
  return out
}

/** Fraction (0..1) of `r`'s area covered by the marks (which must be disjoint). Degenerate rects count as 0 or 1. */
export function coverage(r: Rect, marks: readonly Rect[]): number {
  const area = rectArea(r)
  if (area <= 1e-12) {
    const cx = (r.x0 + r.x1) / 2
    const cy = (r.y0 + r.y1) / 2
    return marks.some((m) => cx >= m.x0 && cx <= m.x1 && cy >= m.y0 && cy <= m.y1) ? 1 : 0
  }
  let covered = 0
  for (const m of marks) {
    const i = intersect(r, m)
    if (i) covered += rectArea(i)
  }
  return Math.min(1, covered / area)
}

/** A text glyph counts as covered by a mark when at least this fraction of its box lies inside the marks. */
export const GLYPH_COVERAGE = 0.3
