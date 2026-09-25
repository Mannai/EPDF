import type { PDFDocument } from 'pdf-lib'
import { analyzePage, type TextRun } from '../../textedit/pdfcontent/analyze'
import { PageFrame, normRotation } from './frame'
import { extractVectors, type VectorContent } from './vector'

/**
 * Everything detection needs to know about one page, in the VISUAL frame (see `frame.ts`): text phrases
 * (with leader strings like `_____` and `.....` split out), horizontal/vertical rules, rectangles and
 * circles. Built from the content-stream engine of the text editor (`textedit/pdfcontent`) plus the vector
 * walker in `vector.ts`. Pure logic (pdf-lib only), unit-tested in Node.
 */

export interface Phrase {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  baseline: number
  size: number
}

export interface Leader {
  char: string
  count: number
  x0: number
  x1: number
  y0: number
  y1: number
  baseline: number
  size: number
}

export interface HLine {
  x0: number
  x1: number
  y: number
  width: number
  dashed: boolean
}
export interface VLine {
  x: number
  y0: number
  y1: number
  width: number
  dashed: boolean
}
export interface ShapeRect {
  x0: number
  y0: number
  x1: number
  y1: number
  stroke: boolean
  fill: boolean
  fillLuma: number
  strokeLuma: number
  width: number
}
export interface ShapeCircle {
  cx: number
  cy: number
  r: number
  stroke: boolean
  fill: boolean
  fillLuma: number
  strokeLuma: number
}

export interface PageContent {
  pageIndex: number
  rotation: number
  width: number
  height: number
  phrases: Phrase[]
  leaders: Leader[]
  hlines: HLine[]
  vlines: VLine[]
  rects: ShapeRect[]
  circles: ShapeCircle[]
  /** Share of the page covered by images (0..1). */
  imageCoverage: number
  /** Text that is invisible (render mode 3: OCR layers). */
  hiddenText: number
  /** Visible text that is not upright on screen (vertical or mirrored). */
  sidewaysText: number
  warnings: string[]
}

interface Atom {
  text: string
  x0: number
  x1: number
  base: number
  size: number
  asc: number
  desc: number
}

const LEADER_RE = /_{3,}|(?:_ ){3,}_?|\.{6,}|(?:\. ?){6,}|-{6,}|…{2,}/g

/** Rows of atoms on one baseline (tolerance relative to the text size), each sorted left to right. */
function toRows(atoms: Atom[]): Atom[][] {
  const sorted = [...atoms].sort((a, b) => b.base - a.base || a.x0 - b.x0)
  const rows: { base: number; size: number; atoms: Atom[] }[] = []
  for (const a of sorted) {
    const row = rows.find((r) => Math.abs(r.base - a.base) <= 0.3 * Math.min(r.size, a.size) && a.size / r.size > 0.7 && a.size / r.size < 1 / 0.7)
    if (row) row.atoms.push(a)
    else rows.push({ base: a.base, size: a.size, atoms: [a] })
  }
  return rows.map((r) => r.atoms.sort((a, b) => a.x0 - b.x0))
}

function phrasesAndLeaders(atoms: Atom[]): { phrases: Phrase[]; leaders: Leader[] } {
  const phrases: Phrase[] = []
  const leaders: Leader[] = []
  for (const row of toRows(atoms)) {
    const text = row.map((a) => a.text).join('')
    const owner: number[] = []
    row.forEach((a, i) => {
      for (let k = 0; k < a.text.length; k++) owner.push(i)
    })
    const isLeader = new Array<boolean>(row.length).fill(false)
    const breakAfter = new Set<number>()
    for (const m of text.matchAll(LEADER_RE)) {
      const from = owner[m.index]
      const to = owner[m.index + m[0].length - 1]
      if (from === undefined || to === undefined) continue
      const first = row[from]
      const last = row[to]
      const size = Math.max(...row.slice(from, to + 1).map((a) => a.size))
      const asc = Math.max(...row.slice(from, to + 1).map((a) => a.asc))
      const desc = Math.min(...row.slice(from, to + 1).map((a) => a.desc))
      leaders.push({
        char: m[0].trim()[0],
        count: m[0].replace(/\s/g, '').length,
        x0: first.x0,
        x1: last.x1,
        y0: first.base + desc,
        y1: first.base + asc,
        baseline: first.base,
        size
      })
      for (let i = from; i <= to; i++) isLeader[i] = true
      breakAfter.add(to)
    }
    let cur: Atom[] = []
    let pendingSpace = 0
    const flush = (): void => {
      while (cur.length && cur[cur.length - 1].text.trim() === '') cur.pop()
      while (cur.length && cur[0].text.trim() === '') cur.shift()
      if (cur.length) {
        const size = Math.max(...cur.map((a) => a.size))
        const base = cur[0].base
        phrases.push({
          text: cur.map((a) => a.text).join('').replace(/\s+/g, ' ').trim(),
          x0: cur[0].x0,
          x1: cur[cur.length - 1].x1,
          y0: base + Math.min(...cur.map((a) => a.desc)),
          y1: base + Math.max(...cur.map((a) => a.asc)),
          baseline: base,
          size
        })
      }
      cur = []
      pendingSpace = 0
    }
    row.forEach((a, i) => {
      if (isLeader[i]) {
        flush()
        return
      }
      const prev = cur[cur.length - 1]
      if (prev && a.x0 - prev.x1 > 0.9 * Math.max(a.size, prev.size)) flush()
      if (a.text.trim() === '') {
        pendingSpace += a.x1 - a.x0
        if (pendingSpace >= 0.9 * a.size) flush()
      } else pendingSpace = 0
      cur.push(a)
    })
    flush()
  }
  return { phrases, leaders }
}

function runAtoms(run: TextRun, frame: PageFrame): { atoms: Atom[]; upright: boolean } {
  const m = run.matrix
  const dir = frame.dirToVisual(m[0], m[1])
  const up = frame.dirToVisual(m[2], m[3])
  const upright = dir[0] > 0 && Math.abs(dir[1]) <= 0.1 * dir[0] && up[1] > 0 && Math.abs(up[0]) <= 0.1 * up[1]
  if (!upright) return { atoms: [], upright }
  const sy = Math.hypot(m[2], m[3])
  const size = run.size * sy
  const asc = (run.font.ascent > 0 ? run.font.ascent : 0.8) * size
  const desc = (run.font.descent < 0 ? run.font.descent : -0.2) * size
  const atoms: Atom[] = []
  for (const g of run.glyphs) {
    if (g.text === '') continue
    const ux0 = m[4] + m[0] * g.x0 + m[2] * run.rise
    const uy0 = m[5] + m[1] * g.x0 + m[3] * run.rise
    const ux1 = m[4] + m[0] * g.x1 + m[2] * run.rise
    const uy1 = m[5] + m[1] * g.x1 + m[3] * run.rise
    const a = frame.toVisual(ux0, uy0)
    const b = frame.toVisual(ux1, uy1)
    atoms.push({ text: g.text, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), base: a[1], size, asc, desc })
  }
  return { atoms, upright }
}

/** Merges collinear touching segments (and runs of tiny dots) into single rules. */
function mergeSegments<T extends { a0: number; a1: number; at: number; width: number; dashed: boolean }>(segs: T[]): T[] {
  const sorted = [...segs].sort((p, q) => p.at - q.at || p.a0 - q.a0)
  const out: T[] = []
  let tiny = 0
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.at - s.at) <= 0.7) {
      const gap = s.a0 - last.a1
      const small = s.a1 - s.a0 < 4 && last.a1 - last.a0 < 12
      if (gap <= 1.5 || (small && gap <= 6)) {
        if (small) tiny++
        last.a1 = Math.max(last.a1, s.a1)
        last.width = Math.max(last.width, s.width)
        last.dashed = last.dashed || s.dashed || tiny >= 5
        continue
      }
    }
    tiny = 0
    out.push({ ...s })
  }
  return out
}

function convertVectors(v: VectorContent, frame: PageFrame): Pick<PageContent, 'hlines' | 'vlines' | 'rects' | 'circles' | 'imageCoverage'> {
  const hs: { a0: number; a1: number; at: number; width: number; dashed: boolean }[] = []
  const vs: { a0: number; a1: number; at: number; width: number; dashed: boolean }[] = []
  for (const l of v.lines) {
    const p = frame.toVisual(l.x0, l.y0)
    const q = frame.toVisual(l.x1, l.y1)
    const dx = Math.abs(q[0] - p[0])
    const dy = Math.abs(q[1] - p[1])
    if (dy <= 0.6 && dx >= 1) hs.push({ a0: Math.min(p[0], q[0]), a1: Math.max(p[0], q[0]), at: (p[1] + q[1]) / 2, width: l.width, dashed: l.dashed })
    else if (dx <= 0.6 && dy >= 1) vs.push({ a0: Math.min(p[1], q[1]), a1: Math.max(p[1], q[1]), at: (p[0] + q[0]) / 2, width: l.width, dashed: l.dashed })
  }
  const rects: ShapeRect[] = v.rects.map((r) => {
    const b = frame.boxToVisual(r)
    return { ...b, stroke: r.stroke, fill: r.fill, fillLuma: r.fillLuma, strokeLuma: r.strokeLuma, width: r.width }
  })
  const circles: ShapeCircle[] = v.circles.map((c) => {
    const [cx, cy] = frame.toVisual(c.cx, c.cy)
    return { cx, cy, r: c.r, stroke: c.stroke, fill: c.fill, fillLuma: c.fillLuma, strokeLuma: c.strokeLuma }
  })
  let covered = 0
  let biggest = 0
  for (const im of v.images) {
    const b = frame.boxToVisual(im)
    const w = Math.max(0, Math.min(b.x1, frame.width) - Math.max(b.x0, 0))
    const h = Math.max(0, Math.min(b.y1, frame.height) - Math.max(b.y0, 0))
    covered += w * h
    biggest = Math.max(biggest, w * h)
  }
  const area = frame.width * frame.height || 1
  return {
    hlines: mergeSegments(hs).map((s) => ({ x0: s.a0, x1: s.a1, y: s.at, width: s.width, dashed: s.dashed })),
    vlines: mergeSegments(vs).map((s) => ({ x: s.at, y0: s.a0, y1: s.a1, width: s.width, dashed: s.dashed })),
    rects,
    circles,
    imageCoverage: Math.min(1, Math.max(biggest, Math.min(covered, area)) / area)
  }
}

/** Gathers the text and vector geometry of one page. Never throws (problems become `warnings`). */
export function readPageContent(pdf: PDFDocument, pageIndex: number): PageContent {
  const page = pdf.getPage(pageIndex)
  const cb = page.getCropBox()
  const rotation = normRotation(page.getRotation().angle)
  const frame = new PageFrame([cb.x, cb.y, cb.x + cb.width, cb.y + cb.height], rotation)
  const warnings: string[] = []

  let atoms: Atom[] = []
  let hiddenText = 0
  let sidewaysText = 0
  try {
    const analysis = analyzePage(pdf, pageIndex)
    hiddenText = analysis.hiddenRuns
    warnings.push(...analysis.warnings)
    for (const run of analysis.runs) {
      if (!run.visible || run.glyphs.length === 0 || run.text.trim() === '') continue
      const r = runAtoms(run, frame)
      if (!r.upright) sidewaysText++
      atoms = atoms.concat(r.atoms)
    }
  } catch (err) {
    warnings.push(`The text of this page could not be read (${err instanceof Error ? err.message : String(err)})`)
  }
  const { phrases, leaders } = phrasesAndLeaders(atoms)

  const vectors = extractVectors(pdf, pageIndex)
  warnings.push(...vectors.warnings)
  return {
    pageIndex,
    rotation,
    width: frame.width,
    height: frame.height,
    phrases,
    leaders,
    ...convertVectors(vectors, frame),
    hiddenText,
    sidewaysText,
    warnings
  }
}

export { PageFrame }
