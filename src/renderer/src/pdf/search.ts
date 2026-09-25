import type { PDFDocumentProxy } from 'pdfjs-dist'

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

const NBSP = / /g

export function buildPageText(items: { str?: string; hasEOL?: boolean }[]): PageText {
  let text = ''
  const itemStarts: number[] = []
  for (const it of items) {
    // Marked-content markers have no `str`; the text layer skips them too, so indices stay aligned.
    if (typeof it.str !== 'string') continue
    itemStarts.push(text.length)
    text += it.str.replace(NBSP, ' ')
    if (it.hasEOL) text += '\n'
  }
  return { text, itemStarts }
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

const textCache = new WeakMap<PDFDocumentProxy, Map<number, PageText>>()

export async function getPageText(doc: PDFDocumentProxy, pageNo: number): Promise<PageText> {
  let perDoc = textCache.get(doc)
  if (!perDoc) textCache.set(doc, (perDoc = new Map()))
  const hit = perDoc.get(pageNo)
  if (hit) return hit
  const page = await doc.getPage(pageNo)
  const content = await page.getTextContent()
  page.cleanup()
  const pt = buildPageText(content.items as { str?: string; hasEOL?: boolean }[])
  // Bound memory on very large documents: keep the most recent ~300 pages of text.
  if (perDoc.size > 300) perDoc.delete(perDoc.keys().next().value as number)
  perDoc.set(pageNo, pt)
  return pt
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
  const re = buildRegex(query, opts)
  if (!re) return
  for (let p = 1; p <= doc.numPages; p++) {
    if (signal.aborted) return
    const { text } = await getPageText(doc, p)
    if (signal.aborted) return
    onPage({ page: p, matches: findMatches(text, re) }, p)
    if (p % 8 === 0) await new Promise((r) => setTimeout(r, 0))
  }
}
