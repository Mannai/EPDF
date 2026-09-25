import { PDFStream, type PDFDocument } from 'pdf-lib'
import { loadPageSource } from '../../textedit/pdfcontent/analyze'
import { parseContent } from '../../textedit/pdfcontent/content'
import { ddict, streamBytes } from '../../textedit/pdfcontent/pdfutil'
import { quadBox, type Quad, type Rect } from './geom'
import { ResEdit, Walker, initialState, newStats, runQuad, type RunRec } from './interp'

/**
 * Text of a page with the geometry of every character, read with the redaction interpreter (so text inside forms
 * is found once per place it is drawn, and hidden/OCR text is included).
 */

export interface PageTextModel {
  pageIndex: number
  /** The page text: runs joined with spaces/newlines by position. */
  text: string
  /** For each UTF-16 unit of `text`: the box of the glyph it came from, or null for inserted separators. */
  rects: (Rect | null)[]
  /** True for units that belong to invisible text (render mode 3: OCR layers). */
  hidden: boolean[]
  /** For each unit: index of its run in `runs` (-1 for separators). */
  runOf: number[]
  /** For each unit: index of its glyph inside the run. */
  glyphOf: number[]
  runs: RunRec[]
}

export function extractPageRuns(pdf: PDFDocument, pageIndex: number): RunRec[] {
  const src = loadPageSource(pdf, pageIndex)
  const w = new Walker(pdf, { marks: [], edit: false, fill: [0, 0, 0] }, newStats())
  w.process({ slots: src.slots.map((s) => ({ ops: s.ops, tail: s.tail })), res: new ResEdit(pdf.context, src.resources) }, initialState(), 0)
  return w.runs
}

/** Concatenated text of a form/appearance stream (used to find replacement text inside annotation appearances). */
export function extractStreamText(pdf: PDFDocument, stream: PDFStream): string {
  let parsed: ReturnType<typeof parseContent>
  try {
    parsed = parseContent(streamBytes(stream))
  } catch {
    return ''
  }
  const w = new Walker(pdf, { marks: [], edit: false, fill: [0, 0, 0] }, newStats())
  try {
    w.process({ slots: [{ ops: parsed.ops, tail: parsed.tail }], res: new ResEdit(pdf.context, ddict(stream.dict, 'Resources')) }, initialState(), 1, 'stream')
  } catch {
    return ''
  }
  return w.runs.map((r) => r.glyphs.map((g) => g.text).join('')).join('\n')
}

export function buildTextModel(pageIndex: number, runs: readonly RunRec[]): PageTextModel {
  let text = ''
  const rects: (Rect | null)[] = []
  const hidden: boolean[] = []
  const runOf: number[] = []
  const glyphOf: number[] = []
  let prev: RunRec | undefined
  let prevLast: Rect | undefined
  const push = (s: string, r: Rect | null, h: boolean, run: number, glyph: number): void => {
    for (let i = 0; i < s.length; i++) {
      text += s[i]
      rects.push(r)
      hidden.push(h)
      runOf.push(run)
      glyphOf.push(glyph)
    }
  }
  runs.forEach((run, ri) => {
    if (run.glyphs.length === 0) return
    const first = run.glyphs[0].rect
    if (prev && prevLast) {
      const size = Math.max(1, Math.min(Math.abs(prev.fontSize), Math.abs(run.fontSize)) || 1)
      if (!prev.upright || !run.upright || Math.abs(run.y - prev.y) > 0.5 * size) push('\n', null, false, -1, -1)
      else {
        const gap = first.x0 - prevLast.x1
        if (gap > 0.15 * size) push(' ', null, false, -1, -1)
        else if (gap < -0.5 * size) push('\n', null, false, -1, -1)
      }
    }
    run.glyphs.forEach((g, gi) => push(g.text, g.rect, !run.visible, ri, gi))
    prev = run
    prevLast = run.glyphs[run.glyphs.length - 1].rect
  })
  return { pageIndex, text, rects, hidden, runOf, glyphOf, runs: [...runs] }
}

export function extractPageText(pdf: PDFDocument, pageIndex: number): PageTextModel {
  return buildTextModel(pageIndex, extractPageRuns(pdf, pageIndex))
}

export interface RangeShapes {
  /** Boxes (bounding boxes for rotated text), one per stretch of text on a line. */
  rects: Rect[]
  /** The exact shape of each box: a rotated quad for rotated text, null for upright text (the box is exact). */
  quads: (Quad | null)[]
}

/** Shapes (one per line/run) covering the characters [start, end) of a page text model. */
export function shapesForRange(model: PageTextModel, start: number, end: number): RangeShapes {
  const groups: { run: number; x0: number; x1: number }[] = []
  let cur: { run: number; x0: number; x1: number } | null = null
  for (let i = Math.max(0, start); i < Math.min(end, model.text.length); i++) {
    const ri = model.runOf[i]
    if (ri < 0) {
      if (model.text[i] === '\n') cur = null
      continue
    }
    const g = model.runs[ri].glyphs[model.glyphOf[i]]
    if (cur && cur.run === ri) {
      cur.x0 = Math.min(cur.x0, g.x0)
      cur.x1 = Math.max(cur.x1, g.x1)
    } else {
      cur = { run: ri, x0: g.x0, x1: g.x1 }
      groups.push(cur)
    }
  }
  const rects: Rect[] = []
  const quads: (Quad | null)[] = []
  for (const gr of groups) {
    const run = model.runs[gr.run]
    const quad = runQuad(run, gr.x0, gr.x1)
    const box = quadBox(quad)
    const last = rects.length - 1
    if (run.upright && last >= 0 && quads[last] === null) {
      // adjacent stretches on one line become one box
      const p = rects[last]
      const sameLine = Math.abs((box.y0 + box.y1) / 2 - (p.y0 + p.y1) / 2) < Math.max(1, (p.y1 - p.y0) * 0.6)
      if (sameLine) {
        rects[last] = { x0: Math.min(p.x0, box.x0), y0: Math.min(p.y0, box.y0), x1: Math.max(p.x1, box.x1), y1: Math.max(p.y1, box.y1) }
        continue
      }
    }
    rects.push(box)
    quads.push(run.upright ? null : quad)
  }
  return { rects, quads }
}

/** Boxes covering the characters [start, end) of a page text model. */
export const rectsForRange = (model: PageTextModel, start: number, end: number): Rect[] => shapesForRange(model, start, end).rects
