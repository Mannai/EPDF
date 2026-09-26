import type { PDFDocument } from 'pdf-lib'
import { buildPageText, modelIsUsable, needsPageModel, rangeQuads, type PageTextModel as LogicalModel } from '@shared/pagetext'
import { extractPageText, shapesForRange, type PageTextModel } from './extract'
import { quadBox, type Quad, type Rect } from './geom'
import { findPreset, presetById } from './patterns'
import { RegexBudgetError, compileSafeRegex, type SafeRegex } from './safeRegex'

/**
 * Find and mark: literal text (whole word / case options), the built-in patterns, and custom regular expressions
 * (run by the step-limited engine). Matches are located with the glyph geometry of the page content.
 */

export type Matcher =
  | { kind: 'literal'; query: string; caseSensitive: boolean; wholeWord: boolean }
  | { kind: 'preset'; id: string }
  | { kind: 'regex'; source: string; caseSensitive: boolean }

export interface Hit {
  pageIndex: number
  start: number
  end: number
  /** The matched text (line breaks shown as spaces). */
  text: string
  rects: Rect[]
  /** Exact shapes of `rects` for rotated text (null = the rect itself). */
  quads: (Quad | null)[]
  /** Only characters of invisible (OCR) text. */
  hiddenOnly: boolean
}

export type Finder = (text: string) => { start: number; end: number }[]

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Builds the text finder for a matcher. Throws (with a user-presentable message) for invalid patterns. */
export function compileMatcher(m: Matcher): { find: Finder; joinLines: boolean } {
  if (m.kind === 'literal') {
    const q = m.query.trim()
    if (!q) throw new Error('Type the text to look for.')
    const body = q
      .split(/\s+/)
      .map(escapeRe)
      .join('\\s+')
    const re = new RegExp(m.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, m.caseSensitive ? 'gu' : 'giu')
    return {
      joinLines: !/\s/.test(q),
      find: (text) => {
        const out: { start: number; end: number }[] = []
        re.lastIndex = 0
        for (let r = re.exec(text); r; r = re.exec(text)) {
          if (r[0].length === 0) re.lastIndex++
          else out.push({ start: r.index, end: r.index + r[0].length })
        }
        return out
      }
    }
  }
  if (m.kind === 'preset') {
    const p = presetById(m.id)
    if (!p) throw new Error('Unknown pattern.')
    return { find: (text) => findPreset(text, p), joinLines: false }
  }
  let safe: SafeRegex
  try {
    safe = compileSafeRegex(m.source, m.caseSensitive ? 'u' : 'iu')
  } catch (e) {
    // the u flag rejects some legal non-unicode patterns (e.g. an escaped hyphen): retry without it
    try {
      safe = compileSafeRegex(m.source, m.caseSensitive ? '' : 'i')
    } catch {
      throw e instanceof Error ? e : new Error(String(e))
    }
  }
  return { find: (text) => safe.findAll(text), joinLines: false }
}

/** Searches one page's text model. */
export function searchModel(model: PageTextModel, matcher: { find: Finder; joinLines: boolean }): Hit[] {
  const raw = matcher.find(model.text)
  const ranges = [...raw]
  if (matcher.joinLines && model.text.includes('\n')) {
    // a token split by a line break ("TOPSECRET-\n4711"): search the text with the breaks removed
    let joined = ''
    const map: number[] = []
    for (let i = 0; i < model.text.length; i++) {
      if (model.text[i] === '\n') continue
      joined += model.text[i]
      map.push(i)
    }
    for (const r of matcher.find(joined)) {
      const start = map[r.start]
      const end = map[r.end - 1] + 1
      if (!model.text.slice(start, end).includes('\n')) continue
      if (ranges.some((x) => x.start < end && start < x.end)) continue
      ranges.push({ start, end })
    }
  }
  ranges.sort((a, b) => a.start - b.start)
  return ranges
    .map((r) => {
      const shapes = shapesForRange(model, r.start, r.end)
      return {
        pageIndex: model.pageIndex,
        start: r.start,
        end: r.end,
        text: model.text.slice(r.start, r.end).replace(/\s*\n\s*/g, ' '),
        rects: shapes.rects,
        quads: shapes.quads,
        hiddenOnly: model.hidden.slice(r.start, r.end).every(Boolean)
      }
    })
    .filter((h) => h.rects.length > 0)
}

/** Searches a page text model (logical order); shapes are converted to PDF user space like the redaction needs. */
export function searchLogical(model: LogicalModel, matcher: { find: Finder; joinLines: boolean }, pageIndex: number): Hit[] {
  const t = model.transform
  const det = t[0] * t[3] - t[1] * t[2]
  if (!det) return []
  const toUser = (x: number, y: number): [number, number] => {
    const dx = x - t[4]
    const dy = y - t[5]
    return [(dx * t[3] - dy * t[2]) / det, (dy * t[0] - dx * t[1]) / det]
  }
  const ranges = matcher.find(model.text)
  const out: Hit[] = []
  for (const r of ranges) {
    const rects: Rect[] = []
    const quads: (Quad | null)[] = []
    for (const dq of rangeQuads(model, r.start, r.end)) {
      const q: number[] = []
      for (let k = 0; k < 8; k += 2) q.push(...toUser(dq[k], dq[k + 1]))
      const quad = q as Quad
      const box = quadBox(quad)
      rects.push(box)
      const upright = Math.abs(quad[1] - quad[3]) < 1e-3 && Math.abs(quad[0] - quad[6]) < 1e-3
      quads.push(upright ? null : quad)
    }
    if (rects.length) out.push({ pageIndex, start: r.start, end: r.end, text: model.text.slice(r.start, r.end).replace(/\s*\n\s*/g, ' '), rects, quads, hiddenOnly: false })
  }
  return out
}

export interface SearchOptions {
  pages?: number[]
  signal?: { aborted: boolean }
  onPage?(pageIndex: number, hits: Hit[]): void
}

/** Searches the document (all pages, or the given ones). Yields to the event loop between pages. */
export async function searchDocument(pdf: PDFDocument, matcher: Matcher, opts: SearchOptions = {}): Promise<Hit[]> {
  const compiled = compileMatcher(matcher)
  const out: Hit[] = []
  const pages = opts.pages ?? Array.from({ length: pdf.getPageCount() }, (_, i) => i)
  let sliceStart = Date.now()
  for (const pi of pages) {
    if (opts.signal?.aborted) break
    let model: PageTextModel
    try {
      model = extractPageText(pdf, pi)
    } catch {
      continue
    }
    let hits = searchModel(model, compiled)
    // Right-to-left and complex-script pages: the stream-order text above is in visual order, so the page is also
    // searched in logical order (page text model); its hits replace the visual-order ones.
    if (needsPageModel(model.text)) {
      try {
        const logical = buildPageText(pdf, pi)
        if (modelIsUsable(logical, model.text)) hits = searchLogical(logical, compiled, pi)
      } catch {
        /* keep the stream-order hits */
      }
    }
    out.push(...hits)
    opts.onPage?.(pi, hits)
    // let the UI breathe about every 30 ms of work (a timer per page would dominate on large documents)
    if (Date.now() - sliceStart > 30) {
      await new Promise((r) => setTimeout(r, 0))
      sliceStart = Date.now()
    }
  }
  return out
}

export { RegexBudgetError }
