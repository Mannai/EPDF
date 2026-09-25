import type { PDFDocument } from 'pdf-lib'
import { extractPageText, rectsForRange, type PageTextModel } from './extract'
import type { Rect } from './geom'
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
  return ranges.map((r) => ({
    pageIndex: model.pageIndex,
    start: r.start,
    end: r.end,
    text: model.text.slice(r.start, r.end).replace(/\s*\n\s*/g, ' '),
    rects: rectsForRange(model, r.start, r.end),
    hiddenOnly: model.hidden.slice(r.start, r.end).every(Boolean)
  })).filter((h) => h.rects.length > 0)
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
  for (const pi of pages) {
    if (opts.signal?.aborted) break
    let model: PageTextModel
    try {
      model = extractPageText(pdf, pi)
    } catch {
      continue
    }
    const hits = searchModel(model, compiled)
    out.push(...hits)
    opts.onPage?.(pi, hits)
    await new Promise((r) => setTimeout(r, 0))
  }
  return out
}

export { RegexBudgetError }
