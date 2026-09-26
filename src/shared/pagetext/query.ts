import type { Box, PageTextLine, PageTextModel } from './types'
import { hasComplexScript } from './unicode'

/** Geometry queries on a page text model (highlights, selection rectangles, redaction boxes) and the quality gate. */

export type Quad = [number, number, number, number, number, number, number, number]

/** Index of the line containing text offset `i` (or the nearest line before it). */
export function lineIndexAt(model: PageTextModel, i: number): number {
  const ls = model.lines
  let lo = 0
  let hi = ls.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ls[mid].start <= i) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The quad of character `i`, or null (line breaks). */
export function charQuad(model: PageTextModel, i: number): Quad | null {
  const q = model.charQuad[i]
  if (q === undefined || q < 0) return null
  const a = model.quads
  const o = q * 8
  return [a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5], a[o + 6], a[o + 7]]
}

const quadBox = (q: Quad): Box => ({
  x0: Math.min(q[0], q[2], q[4], q[6]),
  y0: Math.min(q[1], q[3], q[5], q[7]),
  x1: Math.max(q[0], q[2], q[4], q[6]),
  y1: Math.max(q[1], q[3], q[5], q[7])
})

/**
 * Quads covering the characters [start, end): one per visually contiguous stretch of each line (a right-to-left word
 * inside left-to-right text, or a search hit that spans a direction change, gives several), in the text direction.
 */
export function rangeQuads(model: PageTextModel, start: number, end: number): Quad[] {
  const out: Quad[] = []
  if (end <= start || !model.lines.length) return out
  for (let li = lineIndexAt(model, start); li < model.lines.length; li++) {
    const line = model.lines[li]
    if (line.start >= end) break
    const a = Math.max(start, line.start)
    const b = Math.min(end, line.end)
    if (b <= a) continue
    out.push(...lineRangeQuads(model, line, a, b))
  }
  return out
}

function lineRangeQuads(model: PageTextModel, line: PageTextLine, a: number, b: number): Quad[] {
  const rad = (line.angle * Math.PI) / 180
  const ex = Math.cos(rad)
  const ey = Math.sin(rad)
  const nx = -ey
  const ny = ex
  // every character as an interval along the baseline (s) with its extent across it (t)
  const iv: { s0: number; s1: number; t0: number; t1: number }[] = []
  for (let i = a; i < b; i++) {
    const q = charQuad(model, i)
    if (!q) continue
    let s0 = Infinity
    let s1 = -Infinity
    let t0 = Infinity
    let t1 = -Infinity
    for (let k = 0; k < 8; k += 2) {
      const s = q[k] * ex + q[k + 1] * ey
      const t = q[k] * nx + q[k + 1] * ny
      s0 = Math.min(s0, s)
      s1 = Math.max(s1, s)
      t0 = Math.min(t0, t)
      t1 = Math.max(t1, t)
    }
    iv.push({ s0, s1, t0, t1 })
  }
  iv.sort((x, y) => x.s0 - y.s0)
  const merged: typeof iv = []
  const tol = 0.3 * line.size
  for (const x of iv) {
    const m = merged[merged.length - 1]
    if (m && x.s0 <= m.s1 + tol) {
      m.s1 = Math.max(m.s1, x.s1)
      m.t0 = Math.min(m.t0, x.t0)
      m.t1 = Math.max(m.t1, x.t1)
    } else merged.push({ ...x })
  }
  return merged.map((m) => {
    const pt = (s: number, t: number): [number, number] => [s * ex + t * nx, s * ey + t * ny]
    const p0 = pt(m.s0, m.t1)
    const p1 = pt(m.s1, m.t1)
    const p2 = pt(m.s1, m.t0)
    const p3 = pt(m.s0, m.t0)
    return [p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]]
  })
}

/** Axis-aligned boxes of `rangeQuads`. */
export function rangeBoxes(model: PageTextModel, start: number, end: number): Box[] {
  return rangeQuads(model, start, end).map(quadBox)
}

export { quadBox }

/**
 * Whether the model should be used instead of PDF.js's text for a page: the page has right-to-left or complex-script
 * text, and the model read it well (glyphs decoded, fonts understood). `pdfjsText` is what PDF.js extracted.
 */
export function modelIsUsable(model: PageTextModel, pdfjsText: string): boolean {
  const s = model.stats
  if (!model.text.trim()) return false
  if (s.unreliable > 0.05 * s.glyphs) return false
  if (s.unknown > Math.max(2, 0.05 * s.glyphs)) return false
  // the model must have found about as much text as PDF.js (a model that lost text is worse than a mangled one)
  const letters = (t: string): number => (t.match(/[\p{L}\p{N}]/gu) ?? []).length
  const got = letters(model.text)
  const want = letters(pdfjsText.normalize('NFKC'))
  if (want > 20 && got < 0.8 * want) return false
  return true
}

/** True when a page's PDF.js text contains a script PDF.js may garble (RTL, Arabic presentation forms, Indic, ...). */
export const needsPageModel = (pdfjsText: string): boolean => hasComplexScript(pdfjsText)
