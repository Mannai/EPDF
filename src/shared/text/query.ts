import type { GlyphRun, Line, LayoutGlyph, ParagraphLayout } from './types'

/**
 * Geometry queries on a paragraph layout for editing UIs: where is the caret for a text offset, which offset is under
 * a point, which rectangles make up a selection. All coordinates are layout units (x right, y down from the top-left
 * of the paragraph); every offset is a UTF-16 index into `layout.text`.
 */

export interface CaretPosition {
  line: number
  x: number
  /** Top and height of the caret (the line box). */
  y: number
  height: number
}

export interface SelectionRect {
  line: number
  x: number
  y: number
  width: number
  height: number
}

interface Edge {
  /** Logical UTF-16 index of the boundary. */
  index: number
  x: number
}

/** Left/right pen edge of a glyph and the logical range it covers. */
function glyphSpan(g: LayoutGlyph): { left: number; right: number } {
  const left = g.x - g.dx
  return { left, right: left + g.advance }
}

/**
 * Caret edges of a line: for every character boundary the x it maps to. Boundaries inside a ligature are interpolated
 * evenly. In a right-to-left run the logical start of a glyph is its RIGHT edge.
 */
function lineEdges(line: Line): Edge[] {
  const edges: Edge[] = []
  for (const run of line.runs) {
    for (const g of run.glyphs) {
      if (g.chars <= 0) continue
      const { left, right } = glyphSpan(g)
      for (let k = 0; k <= g.chars; k++) {
        const t = g.chars === 0 ? 0 : k / g.chars
        edges.push({ index: g.cluster + k, x: run.rtl ? right - t * (right - left) : left + t * (right - left) })
      }
    }
  }
  return edges
}

/** Position of the caret before the character at `index` (0..text.length). At a bidi boundary the trailing edge of the previous character is preferred when `affinity` is 'upstream'. */
export function caretAt(layout: ParagraphLayout, index: number, affinity: 'upstream' | 'downstream' = 'downstream'): CaretPosition {
  let li = layout.lines.findIndex((l) => index >= l.textStart && index <= l.textEnd)
  if (li < 0) li = index < (layout.lines[0]?.textStart ?? 0) ? 0 : layout.lines.length - 1
  let line = layout.lines[li]
  if (!line) return { line: 0, x: 0, y: 0, height: 0 }
  // A position at the end of one wrapped line equals the start of the next: prefer the next line unless upstream.
  const next = layout.lines[li + 1]
  if (index === line.textEnd && next && next.textStart === index && affinity === 'downstream' && !line.last) {
    li++
    line = next
  }
  const edges = lineEdges(line).filter((e) => e.index === index)
  let x: number
  if (edges.length === 0) {
    x = line.x + (line.rtl ? line.width : 0)
    // index outside the glyphs of this line (e.g. blank line): start of the line in reading direction
    const all = lineEdges(line)
    if (all.length) x = line.rtl ? Math.max(...all.map((e) => e.x)) : Math.min(...all.map((e) => e.x))
    if (index >= line.textEnd && all.length) {
      const last = all.filter((e) => e.index === Math.max(...all.map((z) => z.index)))
      if (last.length) x = last[0]!.x
    }
  } else {
    // Several edges at one index happen at run boundaries: pick by affinity (upstream = the previous character's edge)
    x = (affinity === 'upstream' ? edges[edges.length - 1]! : edges[0]!).x
  }
  return { line: li, x, y: line.y, height: line.height }
}

/** The text offset at a point: the nearest character boundary on the nearest line. */
export function hitTest(layout: ParagraphLayout, x: number, y: number): { index: number; line: number } {
  let li = 0
  for (let i = 0; i < layout.lines.length; i++) {
    const l = layout.lines[i]!
    li = i
    if (y < l.y + l.height) break
  }
  const line = layout.lines[li]
  if (!line) return { index: 0, line: 0 }
  const edges = lineEdges(line)
  if (edges.length === 0) return { index: line.textStart, line: li }
  let best = edges[0]!
  for (const e of edges) if (Math.abs(e.x - x) < Math.abs(best.x - x)) best = e
  return { index: Math.max(line.textStart, Math.min(line.textEnd, best.index)), line: li }
}

/** Rectangles covering the characters [start, end) (one or more per line: a bidi selection can be several pieces). */
export function selectionRects(layout: ParagraphLayout, start: number, end: number): SelectionRect[] {
  const out: SelectionRect[] = []
  if (end <= start) return out
  layout.lines.forEach((line, li) => {
    if (end <= line.textStart || start >= line.textEnd) return
    const pieces: [number, number][] = []
    for (const run of line.runs) {
      for (const g of run.glyphs) {
        if (g.chars <= 0) continue
        const s = Math.max(start, g.cluster)
        const e = Math.min(end, g.cluster + g.chars)
        if (e <= s) continue
        const { left, right } = glyphSpan(g)
        const w = right - left
        const a = (s - g.cluster) / g.chars
        const b = (e - g.cluster) / g.chars
        const x0 = run.rtl ? right - b * w : left + a * w
        const x1 = run.rtl ? right - a * w : left + b * w
        pieces.push([x0, x1])
      }
    }
    pieces.sort((p, q) => p[0] - q[0])
    let cur: [number, number] | null = null
    for (const p of pieces) {
      if (cur && p[0] <= cur[1] + 0.01) cur[1] = Math.max(cur[1], p[1])
      else {
        if (cur) out.push({ line: li, x: cur[0], y: line.y, width: cur[1] - cur[0], height: line.height })
        cur = [p[0], p[1]]
      }
    }
    if (cur) out.push({ line: li, x: cur[0], y: line.y, width: cur[1] - cur[0], height: line.height })
  })
  return out
}

export type { GlyphRun }
