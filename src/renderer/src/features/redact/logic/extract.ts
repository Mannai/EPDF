import { PDFStream, type PDFDocument } from 'pdf-lib'
import { loadPageSource } from '../../textedit/pdfcontent/analyze'
import { parseContent } from '../../textedit/pdfcontent/content'
import { ddict, streamBytes } from '../../textedit/pdfcontent/pdfutil'
import type { Rect } from './geom'
import { ResEdit, Walker, initialState, newStats, type RunRec } from './interp'

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
  let prev: RunRec | undefined
  let prevLast: Rect | undefined
  const push = (s: string, r: Rect | null, h: boolean): void => {
    for (let i = 0; i < s.length; i++) {
      text += s[i]
      rects.push(r)
      hidden.push(h)
    }
  }
  for (const run of runs) {
    if (run.glyphs.length === 0) continue
    const first = run.glyphs[0].rect
    if (prev && prevLast) {
      const size = Math.max(1, Math.min(Math.abs(prev.fontSize), Math.abs(run.fontSize)) || 1)
      if (!prev.upright || !run.upright || Math.abs(run.y - prev.y) > 0.5 * size) push('\n', null, false)
      else {
        const gap = first.x0 - prevLast.x1
        if (gap > 0.15 * size) push(' ', null, false)
        else if (gap < -0.5 * size) push('\n', null, false)
      }
    }
    for (const g of run.glyphs) push(g.text, g.rect, !run.visible)
    prev = run
    prevLast = run.glyphs[run.glyphs.length - 1].rect
  }
  return { pageIndex, text, rects, hidden }
}

export function extractPageText(pdf: PDFDocument, pageIndex: number): PageTextModel {
  return buildTextModel(pageIndex, extractPageRuns(pdf, pageIndex))
}

/** Boxes (one per line/contiguous segment) covering the characters [start, end) of a page text model. */
export function rectsForRange(model: PageTextModel, start: number, end: number): Rect[] {
  const out: Rect[] = []
  let cur: Rect | null = null
  const flush = (): void => {
    if (cur) out.push(cur)
    cur = null
  }
  for (let i = Math.max(0, start); i < Math.min(end, model.rects.length); i++) {
    const r = model.rects[i]
    if (!r) {
      // a separator: a newline ends the segment, a space keeps it going
      if (model.text[i] === '\n') flush()
      continue
    }
    if (!cur) cur = { ...r }
    else {
      const sameLine = Math.abs((r.y0 + r.y1) / 2 - (cur.y0 + cur.y1) / 2) < Math.max(1, (cur.y1 - cur.y0) * 0.6)
      if (sameLine) {
        cur = { x0: Math.min(cur.x0, r.x0), y0: Math.min(cur.y0, r.y0), x1: Math.max(cur.x1, r.x1), y1: Math.max(cur.y1, r.y1) }
      } else {
        flush()
        cur = { ...r }
      }
    }
  }
  flush()
  return out
}
