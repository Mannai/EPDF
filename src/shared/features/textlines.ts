import { visualToLogicalText } from '../pagetext/visual'
import type { PageTextModel } from '../pagetext/types'

/**
 * Text lines with geometry for heading detection (bookmarks) and URL detection (links). Pages are read with the
 * shared page text model (`src/shared/pagetext`, see `linesFromModel`), which resolves right-to-left text, marks and
 * /ActualText for every producer; `buildLines` remains for callers (and tests) that have plain glyph runs.
 *
 * Coordinates are PDF user space (points, y up). A "line" is one visual line of one column: runs that share a
 * baseline are joined, and a wide horizontal gap (a column gutter, a tab leader) starts a new line.
 */

export interface GlyphBox {
  text: string
  x0: number
  x1: number
}

export interface RunLike {
  glyphs: GlyphBox[]
  baseline: number
  /** Vertical extent of the run (descender .. ascender), user space. */
  y0: number
  y1: number
  /** Font size in user space. */
  size: number
  bold: boolean
  italic: boolean
  fontKey: string
}

export interface CharBox {
  x0: number
  x1: number
}

export interface TextLine {
  /** Text as it comes out of the content stream, runs ordered left to right. */
  text: string
  /** Best-effort logical (reading) order: right-to-left content that is stored in visual order is reordered. */
  logical: string
  /** Mostly right-to-left script. */
  rtl: boolean
  x0: number
  x1: number
  y0: number
  y1: number
  baseline: number
  size: number
  bold: boolean
  italic: boolean
  fontKey: string
  /** One box per UTF-16 unit of `text` (multi-unit glyphs share their glyph's extent, split evenly). */
  chars: CharBox[]
}

// ---------------------------------------------------------------- direction

export function isRtlCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0590 && cp <= 0x08ff && !(cp >= 0x0660 && cp <= 0x0669) && !(cp >= 0x06f0 && cp <= 0x06f9) && cp !== 0x066b && cp !== 0x066c) ||
    (cp >= 0xfb1d && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff) ||
    (cp >= 0x10800 && cp <= 0x10fff) ||
    (cp >= 0x1e800 && cp <= 0x1efff)
  )
}

const isLetter = (ch: string): boolean => /\p{L}/u.test(ch)

/** Share of right-to-left letters among all letters (0 when there are none). */
export function rtlRatio(text: string): number {
  let r = 0
  let all = 0
  for (const ch of text) {
    if (!isLetter(ch)) continue
    all++
    if (isRtlCodePoint(ch.codePointAt(0)!)) r++
  }
  return all === 0 ? 0 : r / all
}

/**
 * Converts text stored in visual order (leftmost glyph first) into logical order with the page text model's
 * bidi inversion (verified against the Unicode Bidirectional Algorithm, including numbers, dates and mirrored
 * brackets). A string with no right-to-left letters is returned unchanged.
 */
export function visualToLogical(text: string): string {
  // callers use it for right-to-left lines: any right-to-left letter makes the paragraph right-to-left
  return rtlRatio(text) === 0 ? text : visualToLogicalText(text, 'rtl')
}

/**
 * The lines of a page text model as `TextLine`s in PDF user space: upright lines only (in the unrotated page),
 * `text` in the order the glyphs are drawn (left to right) with one box per character, `logical` the model's
 * reading-order text.
 */
export function linesFromModel(model: PageTextModel): TextLine[] {
  const t = model.transform
  const det = t[0] * t[3] - t[1] * t[2]
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return []
  // display -> user
  const inv = [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det, (t[2] * t[5] - t[3] * t[4]) / det, (t[1] * t[4] - t[0] * t[5]) / det]
  const toUser = (x: number, y: number): [number, number] => [x * inv[0] + y * inv[2] + inv[4], x * inv[1] + y * inv[3] + inv[5]]
  const out: TextLine[] = []
  for (const line of model.lines) {
    const rad = (line.angle * Math.PI) / 180
    const ux = Math.cos(rad) * inv[0] + Math.sin(rad) * inv[2]
    const uy = Math.cos(rad) * inv[1] + Math.sin(rad) * inv[3]
    if (!(ux > 0) || Math.abs(uy) > 1e-3 * Math.abs(ux)) continue
    const boxes: { i: number; x0: number; x1: number; y0: number; y1: number }[] = []
    for (let i = line.start; i < line.end; i++) {
      const q = model.charQuad[i]
      if (q < 0) continue
      let x0 = Infinity
      let x1 = -Infinity
      let y0 = Infinity
      let y1 = -Infinity
      for (let k = 0; k < 8; k += 2) {
        const [x, y] = toUser(model.quads[q * 8 + k], model.quads[q * 8 + k + 1])
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
      boxes.push({ i, x0, x1, y0, y1 })
    }
    if (!boxes.length) continue
    // drawn order: left to right by the centre of each character's box (characters of one glyph keep their order)
    const drawn = [...boxes].sort((a, b) => a.x0 + a.x1 - (b.x0 + b.x1) || a.i - b.i)
    const text = drawn.map((b) => model.text[b.i]).join('')
    const logical = model.text.slice(line.start, line.end)
    // a point on the baseline in display space: `baseline` is the offset along the line normal n = (-sin, cos)
    const [, baseline] = toUser(-Math.sin(rad) * line.baseline, Math.cos(rad) * line.baseline)
    out.push({
      text,
      logical,
      rtl: line.dir === 'rtl',
      x0: Math.min(...boxes.map((b) => b.x0)),
      x1: Math.max(...boxes.map((b) => b.x1)),
      y0: Math.min(...boxes.map((b) => b.y0)),
      y1: Math.max(...boxes.map((b) => b.y1)),
      baseline,
      size: line.size,
      bold: line.bold,
      italic: line.italic,
      fontKey: line.font,
      chars: drawn.map((b) => ({ x0: b.x0, x1: b.x1 }))
    })
  }
  return out.sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0)
}

// ---------------------------------------------------------------- lines

interface Piece {
  x0: number
  x1: number
  run: RunLike
  text: string
  boxes: CharBox[]
}

const runPiece = (run: RunLike): Piece | null => {
  const boxes: CharBox[] = []
  let text = ''
  for (const g of run.glyphs) {
    const t = g.text === '�' ? '' : g.text
    if (!t) continue
    text += t
    const w = (g.x1 - g.x0) / t.length
    for (let k = 0; k < t.length; k++) boxes.push({ x0: g.x0 + w * k, x1: g.x0 + w * (k + 1) })
  }
  if (!text.trim() || boxes.length === 0) return null
  return { x0: Math.min(...boxes.map((b) => b.x0)), x1: Math.max(...boxes.map((b) => b.x1)), run, text, boxes }
}

export interface LineOptions {
  /** A horizontal gap wider than this many font sizes ends the line (column gutters, tab leaders). Default 1.6. */
  splitGap?: number
}

/** Groups runs into lines. Runs must already be filtered to upright, visible text. */
export function buildLines(runs: readonly RunLike[], opts: LineOptions = {}): TextLine[] {
  const splitGap = opts.splitGap ?? 1.6
  const pieces = runs.map(runPiece).filter((p): p is Piece => p !== null)
  pieces.sort((a, b) => b.run.baseline - a.run.baseline || a.x0 - b.x0)

  const clusters: Piece[][] = []
  for (const p of pieces) {
    const last = clusters[clusters.length - 1]
    if (last) {
      const ref = last[0]
      const tol = 0.3 * Math.min(ref.run.size, p.run.size)
      if (Math.abs(ref.run.baseline - p.run.baseline) <= Math.max(tol, 0.5)) {
        last.push(p)
        continue
      }
    }
    clusters.push([p])
  }

  const lines: TextLine[] = []
  for (const cluster of clusters) {
    cluster.sort((a, b) => a.x0 - b.x0)
    let seg: Piece[] = []
    const flush = (): void => {
      if (seg.length) lines.push(lineOf(seg))
      seg = []
    }
    for (const p of cluster) {
      const prev = seg[seg.length - 1]
      if (prev) {
        const gap = p.x0 - prev.x1
        const size = Math.max(prev.run.size, p.run.size)
        if (gap > Math.max(splitGap * size, 14)) flush()
      }
      seg.push(p)
    }
    flush()
  }
  return lines.sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0)
}

function lineOf(seg: Piece[]): TextLine {
  let text = ''
  const chars: CharBox[] = []
  for (let i = 0; i < seg.length; i++) {
    const p = seg[i]
    if (i > 0) {
      const prev = seg[i - 1]
      const gap = p.x0 - prev.x1
      const size = Math.max(prev.run.size, p.run.size)
      if (gap > 0.18 * size && !text.endsWith(' ') && !p.text.startsWith(' ')) {
        text += ' '
        chars.push({ x0: prev.x1, x1: p.x0 })
      }
    }
    text += p.text
    chars.push(...p.boxes)
  }
  // Dominant style = the run with the most characters.
  const weight = new Map<RunLike, number>()
  for (const p of seg) weight.set(p.run, (weight.get(p.run) ?? 0) + p.text.length)
  let dom = seg[0].run
  let best = -1
  for (const [r, w] of weight) {
    if (w > best) {
      best = w
      dom = r
    }
  }
  const total = seg.reduce((s, p) => s + p.text.length, 0)
  const boldChars = seg.reduce((s, p) => s + (p.run.bold ? p.text.length : 0), 0)
  const italicChars = seg.reduce((s, p) => s + (p.run.italic ? p.text.length : 0), 0)
  const ratio = rtlRatio(text)
  return {
    text,
    logical: ratio > 0.5 ? visualToLogical(text) : text,
    rtl: ratio > 0.5,
    x0: Math.min(...seg.map((p) => p.x0)),
    x1: Math.max(...seg.map((p) => p.x1)),
    y0: Math.min(...seg.map((p) => p.run.y0)),
    y1: Math.max(...seg.map((p) => p.run.y1)),
    baseline: dom.baseline,
    size: dom.size,
    bold: boldChars > total / 2,
    italic: italicChars > total / 2,
    fontKey: dom.fontKey,
    chars
  }
}
