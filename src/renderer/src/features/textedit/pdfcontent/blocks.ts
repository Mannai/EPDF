import type { PageAnalysis, TextRun } from './analyze'
import type { Color } from './analyze'
import type { PdfFont } from './fonts'
import type { Rect } from './matrix'

/**
 * Groups text runs into editable blocks: lines (runs on one baseline that belong together) and paragraphs
 * (consecutive lines with the same leading and alignment). Blocks never mix content from different streams
 * or forms, and they carry everything the editor needs (text, geometry, style, whether editing is allowed).
 */

export type Atom =
  | { kind: 'glyph'; run: TextRun; glyph: number; text: string }
  | { kind: 'virtual'; text: string }

export interface TextLine {
  runs: TextRun[]
  /** Baseline y and horizontal extent in user space. */
  baseline: number
  x0: number
  x1: number
  atoms: Atom[]
  text: string
  bbox: Rect
  /** Font size in user space (points). */
  size: number
}

export interface TextBlock {
  id: string
  level: 'line' | 'paragraph'
  source: string
  lines: TextLine[]
  runs: TextRun[]
  atoms: Atom[]
  /** Lines joined with "\n". */
  text: string
  bbox: Rect
  /** Font size in user space (points) of the first run. */
  size: number
  font: PdfFont
  color: Color
  /** Distance between baselines in user space (0 for a single line). */
  leading: number
  editable: boolean
  reason?: string
}

export interface BlockSet {
  lines: TextBlock[]
  paragraphs: TextBlock[]
}

const userSize = (r: TextRun): number => r.size * Math.abs(r.matrix[3])
const baselineOf = (r: TextRun): number => r.matrix[5] + r.matrix[3] * r.rise
function extent(r: TextRun): [number, number] {
  if (r.glyphs.length === 0) return [r.matrix[4], r.matrix[4]]
  const lo = Math.min(...r.glyphs.map((g) => g.x0))
  const hi = Math.max(...r.glyphs.map((g) => g.x1))
  return [r.matrix[4] + r.matrix[0] * lo, r.matrix[4] + r.matrix[0] * hi]
}

const unionRect = (rects: Rect[]): Rect => ({
  x0: Math.min(...rects.map((r) => r.x0)),
  y0: Math.min(...rects.map((r) => r.y0)),
  x1: Math.max(...rects.map((r) => r.x1)),
  y1: Math.max(...rects.map((r) => r.y1))
})

function refusalReason(analysis: PageAnalysis, runs: TextRun[]): string | undefined {
  if (analysis.rotation !== 0) return 'text editing on rotated pages is not supported yet (rotate the page back to 0° first)'
  for (const r of runs) {
    if (!r.upright) return 'the text is rotated, mirrored or skewed'
    if (r.shared) return 'it is part of a shared element (a form drawn more than once), so editing it would change every copy'
    if (!r.font.editable) return r.font.reason
    if (r.glyphs.some((g) => !g.known)) return 'some of its characters have no known Unicode value (the font has no usable character mapping)'
    if (r.marked.some((m) => m.external)) return 'it is tagged with alternative text stored outside the page content'
  }
  return undefined
}

function buildLine(analysis: PageAnalysis, runs: TextRun[]): TextLine {
  const sorted = [...runs].sort((a, b) => extent(a)[0] - extent(b)[0])
  const size = userSize(sorted[0])
  const atoms: Atom[] = []
  let prevRight: number | undefined
  for (const run of sorted) {
    const [x0, x1] = extent(run)
    const first = run.glyphs[0]
    const lastText = atoms.length ? atoms[atoms.length - 1].text : ''
    const gapAtStart = prevRight !== undefined ? x0 - prevRight : 0
    if (atoms.length && gapAtStart > 0.12 * size && !/\s$/.test(lastText) && first && !/^\s/.test(first.text)) atoms.push({ kind: 'virtual', text: ' ' })
    run.glyphs.forEach((g, gi) => {
      // A wide gap inside a TJ (positioning instead of a space glyph) reads as a space too.
      const inside = gi > 0 ? (g.x0 - run.glyphs[gi - 1].x1) * Math.abs(run.matrix[0]) : 0
      const prevText = atoms.length ? atoms[atoms.length - 1].text : ''
      if (gi > 0 && inside > 0.2 * size && !/\s$/.test(prevText) && !/^\s/.test(g.text)) atoms.push({ kind: 'virtual', text: ' ' })
      atoms.push({ kind: 'glyph', run, glyph: gi, text: g.text })
    })
    prevRight = prevRight === undefined ? x1 : Math.max(prevRight, x1)
  }
  const boxes = sorted.map((r) => r.bbox)
  const bbox = unionRect(boxes)
  void analysis
  return {
    runs: sorted,
    baseline: baselineOf(sorted[0]),
    x0: Math.min(...sorted.map((r) => extent(r)[0])),
    x1: Math.max(...sorted.map((r) => extent(r)[1])),
    atoms,
    text: atoms.map((a) => a.text).join(''),
    bbox,
    size
  }
}

/** Splits runs on (roughly) one baseline into groups of runs that read as one line. */
function splitRow(row: TextRun[]): TextRun[][] {
  const sorted = [...row].sort((a, b) => extent(a)[0] - extent(b)[0])
  const groups: TextRun[][] = []
  let cur: TextRun[] = []
  let right = -Infinity
  for (const r of sorted) {
    const [x0, x1] = extent(r)
    const size = userSize(r)
    if (cur.length && (x0 - right > 1.2 * size || x0 < right - 0.5 * size)) {
      groups.push(cur)
      cur = []
      right = -Infinity
    }
    cur.push(r)
    right = Math.max(right, x1)
  }
  if (cur.length) groups.push(cur)
  return groups
}

export function buildBlocks(analysis: PageAnalysis): BlockSet {
  const bySource = new Map<string, TextRun[]>()
  for (const r of analysis.runs) {
    if (!r.visible || r.text === '' || r.glyphs.length === 0) continue
    const l = bySource.get(r.addr.source)
    if (l) l.push(r)
    else bySource.set(r.addr.source, [r])
  }

  const lines: TextBlock[] = []
  const paragraphs: TextBlock[] = []

  for (const [source, runs] of bySource) {
    const upright = runs.filter((r) => r.upright)
    const other = runs.filter((r) => !r.upright)

    // Rows: same baseline and size.
    const rows: { y: number; size: number; runs: TextRun[] }[] = []
    for (const r of [...upright].sort((a, b) => baselineOf(b) - baselineOf(a) || extent(a)[0] - extent(b)[0])) {
      const y = baselineOf(r)
      const size = userSize(r)
      const row = rows.find((x) => Math.abs(x.y - y) <= 0.25 * Math.min(x.size, size) && size / x.size > 0.85 && size / x.size < 1 / 0.85)
      if (row) row.runs.push(r)
      else rows.push({ y, size, runs: [r] })
    }

    const srcLines: TextBlock[] = []
    const mkLineBlock = (lineRuns: TextRun[]): TextBlock | null => {
      const line = buildLine(analysis, lineRuns)
      if (line.text.trim() === '') return null
      const reason = refusalReason(analysis, line.runs)
      const first = line.runs[0]
      return {
        id: `L:${first.id}#${line.runs.length}`,
        level: 'line',
        source,
        lines: [line],
        runs: line.runs,
        atoms: line.atoms,
        text: line.text,
        bbox: line.bbox,
        size: line.size,
        font: first.font,
        color: first.color,
        leading: 0,
        editable: reason === undefined,
        reason
      }
    }
    for (const row of rows) for (const g of splitRow(row.runs)) {
      const b = mkLineBlock(g)
      if (b) srcLines.push(b)
    }
    for (const r of other) {
      const b = mkLineBlock([r])
      if (b) srcLines.push(b)
    }
    lines.push(...srcLines)

    // Paragraphs: chains of lines with consistent leading and alignment.
    const cand = srcLines.filter((b) => b.editable).sort((a, b) => b.lines[0].baseline - a.lines[0].baseline || a.lines[0].x0 - b.lines[0].x0)
    const chains: TextBlock[][] = []
    for (const b of cand) {
      const ln = b.lines[0]
      let best: TextBlock[] | undefined
      for (let i = chains.length - 1; i >= 0; i--) {
        const chain = chains[i]
        const last = chain[chain.length - 1].lines[0]
        const dy = last.baseline - ln.baseline
        if (dy > 3.2 * ln.size) continue
        const ratio = ln.size / last.size
        if (ratio < 0.92 || ratio > 1.08 || dy < 0.85 * ln.size) continue
        if (chain.length >= 2) {
          const lead = chain[0].lines[0].baseline - chain[1].lines[0].baseline
          if (Math.abs(dy - lead) > 0.12 * ln.size) continue
        } else if (dy > 2.2 * ln.size) continue
        const tol = 0.6 * ln.size
        const cLast = (last.x0 + last.x1) / 2
        const cCur = (ln.x0 + ln.x1) / 2
        const aligned = Math.abs(last.x0 - ln.x0) <= tol || Math.abs(last.x1 - ln.x1) <= tol || Math.abs(cLast - cCur) <= tol
        // Indented first line: allow the second line to align with the following ones later.
        const overlap = Math.min(last.x1, ln.x1) - Math.max(last.x0, ln.x0) > 0
        if (!overlap) continue
        if (!aligned && !(chain.length === 1 && ln.x0 < last.x0 + 3 * ln.size && ln.x0 >= last.x0 - tol)) continue
        best = chain
        break
      }
      if (best) best.push(b)
      else chains.push([b])
    }
    for (const chain of chains) {
      if (chain.length < 2) continue
      const ls = chain.flatMap((b) => b.lines)
      const runsAll = chain.flatMap((b) => b.runs)
      const first = chain[0]
      const text = ls.map((l) => l.text).join('\n')
      const atoms: Atom[] = []
      ls.forEach((l, i) => {
        if (i) atoms.push({ kind: 'virtual', text: '\n' })
        atoms.push(...l.atoms)
      })
      paragraphs.push({
        id: `P:${first.id}#${chain.length}`,
        level: 'paragraph',
        source,
        lines: ls,
        runs: runsAll,
        atoms,
        text,
        bbox: unionRect(ls.map((l) => l.bbox)),
        size: first.size,
        font: first.font,
        color: first.color,
        leading: (ls[0].baseline - ls[1].baseline),
        editable: true
      })
    }
  }
  return { lines, paragraphs }
}

export function findBlock(set: BlockSet, id: string): TextBlock | undefined {
  return set.lines.find((b) => b.id === id) ?? set.paragraphs.find((b) => b.id === id)
}
