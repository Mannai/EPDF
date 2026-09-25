import { alignOfBox, buildLines, joinLines, runsOf, textOfRuns, trimRuns, type Line } from './lines'
import type { LineItem, TableBlock, TableCell, TextItem } from './model'

/**
 * Table detection. Two independent strategies, both deliberately conservative (a wrong table is worse than
 * plain paragraphs):
 *  - ruling tables: a connected grid of drawn lines/rectangles with at least 2 x 2 cells;
 *  - aligned tables: consecutive lines whose text falls into the same vertical columns.
 */

// ---------------------------------------------------------------------------------------------------
// Ruling tables
// ---------------------------------------------------------------------------------------------------

interface HSeg {
  y: number
  a: number
  b: number
}
interface VSeg {
  x: number
  a: number
  b: number
}

function mergeH(lines: LineItem[]): HSeg[] {
  const hs = lines.filter((l) => l.y1 === l.y2).map((l) => ({ y: l.y1, a: l.x1, b: l.x2 }))
  hs.sort((p, q) => p.y - q.y || p.a - q.a)
  const out: HSeg[] = []
  for (const h of hs) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.y - h.y) <= 1.5 && h.a <= last.b + 2) last.b = Math.max(last.b, h.b)
    else out.push({ ...h })
  }
  return out
}

function mergeV(lines: LineItem[]): VSeg[] {
  const vs = lines.filter((l) => l.x1 === l.x2).map((l) => ({ x: l.x1, a: l.y1, b: l.y2 }))
  vs.sort((p, q) => p.x - q.x || p.a - q.a)
  const out: VSeg[] = []
  for (const v of vs) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - v.x) <= 1.5 && v.a <= last.b + 2) last.b = Math.max(last.b, v.b)
    else out.push({ ...v })
  }
  return out
}

/** Sorted values collapsed so that values within `tol` become one (their mean). */
export function cluster(values: number[], tol: number): number[] {
  const v = [...values].sort((a, b) => a - b)
  const out: number[][] = []
  for (const x of v) {
    const last = out[out.length - 1]
    if (last && x - last[last.length - 1] <= tol) last.push(x)
    else out.push([x])
  }
  return out.map((g) => g.reduce((s, x) => s + x, 0) / g.length)
}

function cellFrom(items: TextItem[], left: number, right: number): TableCell {
  if (items.length === 0) return { runs: [], text: '', align: 'left', bold: false }
  const lines = buildLines(items)
  const runs = joinLines(lines)
  const x0 = Math.min(...items.map((i) => i.x))
  const x1 = Math.max(...items.map((i) => i.x + i.width))
  return { runs, text: textOfRuns(runs), align: alignOfBox(x0, x1, left, right, 4), bold: runs.length > 0 && runs.every((r) => r.bold) }
}

const indexIn = (edges: number[], v: number): number => {
  let k = 0
  for (let i = 0; i < edges.length - 1; i++) if (v >= edges[i] - 0.5) k = i
  return Math.min(k, edges.length - 2)
}

export function detectRulingTables(rulings: LineItem[], items: TextItem[]): { tables: TableBlock[]; consumed: Set<TextItem> } {
  const consumed = new Set<TextItem>()
  const tables: TableBlock[] = []
  const hs = mergeH(rulings).filter((h) => h.b - h.a >= 8)
  const vs = mergeV(rulings).filter((v) => v.b - v.a >= 8)
  if (hs.length < 2 || vs.length < 2) return { tables, consumed }

  // union-find over segments that touch each other
  const n = hs.length + vs.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  hs.forEach((h, i) =>
    vs.forEach((v, j) => {
      if (v.x >= h.a - 2.5 && v.x <= h.b + 2.5 && h.y >= v.a - 2.5 && h.y <= v.b + 2.5) parent[find(i)] = find(hs.length + j)
    })
  )
  const comps = new Map<number, { h: HSeg[]; v: VSeg[] }>()
  hs.forEach((h, i) => {
    const r = find(i)
    if (!comps.has(r)) comps.set(r, { h: [], v: [] })
    comps.get(r)!.h.push(h)
  })
  vs.forEach((v, j) => {
    const r = find(hs.length + j)
    if (!comps.has(r)) comps.set(r, { h: [], v: [] })
    comps.get(r)!.v.push(v)
  })

  for (const { h, v } of comps.values()) {
    const rowEdges = cluster(h.map((s) => s.y), 2)
    const colEdges = cluster(v.map((s) => s.x), 2)
    if (rowEdges.length < 3 || colEdges.length < 3) continue
    if ((rowEdges.length - 1) * (colEdges.length - 1) > 4000) continue
    const x0 = colEdges[0]
    const x1 = colEdges[colEdges.length - 1]
    const y0 = rowEdges[0]
    const y1 = rowEdges[rowEdges.length - 1]
    if (x1 - x0 < 30 || y1 - y0 < 15) continue
    const inside = items.filter((it) => {
      const cx = it.x + Math.min(it.width, 8) / 2
      const cy = it.y - it.size * 0.3
      return cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 1 && cy <= y1 + 1
    })
    if (inside.length === 0) continue
    const nr = rowEdges.length - 1
    const nc = colEdges.length - 1
    const grid: TextItem[][][] = Array.from({ length: nr }, () => Array.from({ length: nc }, () => []))
    for (const it of inside) grid[indexIn(rowEdges, it.y - it.size * 0.3)][indexIn(colEdges, it.x + 0.5)].push(it)
    const rows = grid.map((r, ri) => r.map((cell, ci) => cellFrom(cell, colEdges[ci], colEdges[ci + 1])))
    if (!rows.some((r) => r.some((c) => c.text))) continue
    inside.forEach((i) => consumed.add(i))
    tables.push({ type: 'table', colEdges, rowEdges, rows, bordered: true, x: x0, y: y0, width: x1 - x0, height: y1 - y0, spaceBefore: 0 })
  }
  tables.sort((a, b) => a.y - b.y)
  return { tables, consumed }
}

// ---------------------------------------------------------------------------------------------------
// Aligned (borderless) tables
// ---------------------------------------------------------------------------------------------------

function tableFromRun(run: Line[]): TableBlock | null {
  const rows = run.length
  const xmin = Math.floor(Math.min(...run.map((l) => l.x0)))
  const xmax = Math.ceil(Math.max(...run.map((l) => l.x1)))
  const nb = xmax - xmin + 1
  if (nb < 20) return null
  const cover = new Int32Array(nb)
  for (const l of run) {
    const seen = new Uint8Array(nb)
    for (const s of l.segs) for (let x = Math.floor(s.x0) - xmin; x <= Math.ceil(s.x1) - xmin; x++) if (x >= 0 && x < nb) seen[x] = 1
    for (let x = 0; x < nb; x++) cover[x] += seen[x]
  }
  const spanTol = rows >= 5 ? Math.floor(0.2 * rows) : 0
  // channels: contiguous runs of (almost) uncovered bins at least 5pt wide
  const cols: { a: number; b: number }[] = []
  let colStart = -1
  let x = 0
  while (x < nb) {
    if (cover[x] > spanTol) {
      if (colStart < 0) colStart = x
      x++
      continue
    }
    let e = x
    while (e < nb && cover[e] <= spanTol) e++
    if (e - x >= 5 && colStart >= 0) {
      cols.push({ a: colStart + xmin, b: x - 1 + xmin })
      colStart = -1
    }
    x = e
  }
  if (colStart >= 0) cols.push({ a: colStart + xmin, b: nb - 1 + xmin })
  if (cols.length < 2 || cols.length > 30) return null

  const colOf = (v: number): number => {
    let best = 0
    let bestD = Infinity
    cols.forEach((c, i) => {
      const d = v < c.a ? c.a - v : v > c.b ? v - c.b : 0
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  const cells: TableCell[][] = []
  let spanRows = 0
  let filled = 0
  const colFilled = new Array<number>(cols.length).fill(0)
  let chars = 0
  for (const l of run) {
    const row: TableCell[] = cols.map(() => ({ runs: [], text: '', align: 'left', bold: false }))
    let spans = false
    for (const s of l.segs) {
      const c0 = colOf(s.x0 + 1)
      const c1 = colOf(s.x1 - 1)
      if (c1 > c0) spans = true
      const runs = trimRuns(runsOf(s.items))
      if (!runs.length) continue
      const target = row[c0]
      if (target.runs.length) target.runs.push({ ...runs[0], text: ' ' })
      target.runs.push(...runs)
      target.text = textOfRuns(target.runs)
      target.align = alignOfBox(s.x0, s.x1, cols[c0].a, cols[c0].b, 4)
      target.bold = target.runs.length > 0 && target.runs.every((r) => r.bold)
    }
    if (spans) spanRows++
    row.forEach((c, i) => {
      if (c.text) {
        filled++
        colFilled[i]++
        chars += c.text.length
      }
    })
    cells.push(row)
  }
  if (spanRows > spanTol) return null
  if (filled / (rows * cols.length) < 0.6) return null
  if (colFilled.some((n) => n < Math.max(2, Math.ceil(0.5 * rows)))) return null
  if (chars / Math.max(1, filled) > 60) return null

  const colEdges = [cols[0].a, ...cols.slice(1).map((c, i) => (cols[i].b + c.a) / 2), cols[cols.length - 1].b]
  const y0 = run[0].top
  const y1 = run[run.length - 1].bottom
  const rowEdges = [y0, ...run.slice(1).map((l, i) => (run[i].bottom + l.top) / 2), y1]
  return {
    type: 'table',
    colEdges,
    rowEdges,
    rows: cells,
    bordered: false,
    x: colEdges[0],
    y: y0,
    width: colEdges[colEdges.length - 1] - colEdges[0],
    height: y1 - y0,
    spaceBefore: 0
  }
}

/** Replaces runs of table-like lines by tables; other lines pass through in order. */
export function detectAlignedTables(lines: Line[]): (Line | TableBlock)[] {
  const out: (Line | TableBlock)[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].segs.length < 2) {
      out.push(lines[i++])
      continue
    }
    let j = i + 1
    while (j < lines.length && j - i < 400 && lines[j].segs.length >= 2 && lines[j].y - lines[j - 1].y <= 3 * lines[j].size && lines[j].y > lines[j - 1].y) j++
    const t = j - i >= 2 ? tableFromRun(lines.slice(i, j)) : null
    if (t) {
      out.push(t)
      i = j
    } else out.push(lines[i++])
  }
  return out
}
