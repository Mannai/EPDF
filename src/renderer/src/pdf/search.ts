import type { PDFDocumentProxy } from 'pdfjs-dist'
import { normalizeForSearch } from '@shared/text/search'
import { itemsText, pageText as unifiedPageText, pdfjsText, type PageText as UnifiedPageText } from './pagetext'

/**
 * In-document search. Page text comes from `pdf/pagetext`: PDF.js's text for ordinary pages, the page text model
 * (logical order) for right-to-left and complex-script pages. Matching is done on text normalised with the text
 * engine's `normalizeForSearch` ("find what the user means": Arabic tashkeel and tatweel ignored, alef/yeh variants
 * and Arabic-Indic/Persian digits unified, presentation forms and ligatures expanded, Hebrew points ignored, case
 * folded unless Match case is on), and mapped back to the original text so highlights cover the right characters.
 */

export interface SearchOptions {
  matchCase: boolean
  wholeWord: boolean
}

export interface Match {
  start: number
  end: number
}

export interface PageText {
  text: string
  /** Start offset of each text item within `text`; parallel to the text layer's item list. */
  itemStarts: number[]
}

/** PDF.js text items -> page text (kept for callers that work with PDF.js items). */
export function buildPageText(items: { str?: string; hasEOL?: boolean }[]): PageText {
  return itemsText(items)
}

/** Builds a global regex from a plain query: literal characters, any whitespace run matches any whitespace run. */
export function buildRegex(query: string, opts: SearchOptions): RegExp | null {
  const q = query.trim()
  if (!q) return null
  const escaped = q
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  const body = opts.wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped
  return new RegExp(body, opts.matchCase ? 'gu' : 'giu')
}

export function findMatches(text: string, re: RegExp): Match[] {
  const out: Match[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    out.push({ start: m.index, end: m.index + m[0].length })
  }
  return out
}

// eslint-disable-next-line no-control-regex
const ASCII = /^[\u0000-\u007f]*$/

interface Normalized {
  text: string
  toOriginal(a: number, b: number): [number, number]
}

function normalize(text: string, foldCase: boolean): Normalized {
  // ASCII text normalises to itself (lower-cased when folding): no mapping needed
  if (ASCII.test(text)) return { text: foldCase ? text.toLowerCase() : text, toOriginal: (a, b) => [a, b] }
  return normalizeForSearch(text, { foldCase })
}

/**
 * All matches of `query` in `text` after search normalisation, as ranges of the ORIGINAL text. Whitespace in the
 * query matches any whitespace run (line breaks too); `wholeWord` requires no letter, digit or mark on either side.
 */
export function findInText(text: string, query: string, opts: SearchOptions): Match[] {
  const q = query.trim()
  if (!q || !text) return []
  const fold = !opts.matchCase
  const words = q
    .split(/\s+/)
    .map((w) => normalize(w, fold).text)
    .filter(Boolean)
  if (!words.length) return []
  const body = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  const re = new RegExp(opts.wholeWord ? `(?<![\\p{L}\\p{N}\\p{M}_])${body}(?![\\p{L}\\p{N}\\p{M}_])` : body, 'gu')
  const nt = normalize(text, fold)
  const out: Match[] = []
  for (const m of findMatches(nt.text, re)) {
    const [start, end] = nt.toOriginal(m.start, m.end)
    if (end > start) out.push({ start, end })
  }
  return out
}

/** Maps a character offset to the index of the text item that contains it. */
export function itemIndexAt(itemStarts: number[], offset: number): number {
  let lo = 0
  let hi = itemStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (itemStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** PDF.js's own text of a page with item offsets (the viewer's PDF.js text layer is built from the same items). */
export function getPageText(doc: PDFDocumentProxy, pageNo: number): Promise<PageText> {
  return pdfjsText(doc, pageNo)
}

/** The text search uses for a page (logical order; see `pdf/pagetext`). */
export function getSearchText(doc: PDFDocumentProxy, pageNo: number): Promise<UnifiedPageText> {
  return unifiedPageText(doc, pageNo)
}

export interface SearchProgress {
  page: number
  matches: Match[]
}

/** Searches pages in order, reporting each page's matches. Stops promptly when `signal` aborts. */
export async function searchDocument(
  doc: PDFDocumentProxy,
  query: string,
  opts: SearchOptions,
  onPage: (p: SearchProgress, done: number) => void,
  signal: AbortSignal
): Promise<void> {
  if (!query.trim()) return
  for (let p = 1; p <= doc.numPages; p++) {
    if (signal.aborted) return
    const { text } = await unifiedPageText(doc, p)
    if (signal.aborted) return
    onPage({ page: p, matches: findInText(text, query, opts) }, p)
    if (p % 8 === 0) await new Promise((r) => setTimeout(r, 0))
  }
}
