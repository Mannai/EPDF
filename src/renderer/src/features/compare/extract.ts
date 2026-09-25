import type { PDFDocumentProxy } from 'pdfjs-dist'
import { DEFAULT_OPTIONS, type CompareOptions, type PageModel, type RawItem } from './diff/types'
import { buildPageModel } from './diff/words'

/**
 * Text extraction with PDF.js: turns a page's text content into positioned runs (in displayed page coordinates,
 * origin top-left, y down, /Rotate applied) and then into a PageModel. Only type imports from pdfjs-dist, so the
 * conversion can be tested in Node against the legacy PDF.js build.
 */

/** The parts of a PDF.js text item we use. Marked-content markers have no `str`. */
export interface TextItemLike {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

/** Glyph boxes span this far above and below the baseline, as fractions of the font size. */
export const ASCENT = 0.85
export const DESCENT = 0.22

const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** Converts PDF.js items to page-space runs; `viewportTransform` is `viewport.transform` at scale 1. */
export function itemsToRuns(items: TextItemLike[], viewportTransform: number[]): RawItem[] {
  const out: RawItem[] = []
  for (const it of items) {
    if (typeof it.str !== 'string' || it.str === '' || !it.transform || it.transform.length < 6) continue
    const [a, b, c, d, e, f] = it.transform
    const size = Math.hypot(c, d) || it.height || 0
    if (!(size > 0)) continue
    const along = Math.hypot(a, b) || 1
    const w = it.width ?? 0
    const ux = (a / along) * w
    const uy = (b / along) * w
    // Corners of the glyph box in PDF user space: the baseline run, extended up by ASCENT and down by DESCENT.
    const up = [c * ASCENT, d * ASCENT]
    const down = [-c * DESCENT, -d * DESCENT]
    const corners = [
      [e + up[0], f + up[1]],
      [e + ux + up[0], f + uy + up[1]],
      [e + down[0], f + down[1]],
      [e + ux + down[0], f + uy + down[1]]
    ].map(([x, y]) => apply(viewportTransform, x, y))
    const xs = corners.map((p) => p[0])
    const ys = corners.map((p) => p[1])
    // Direction of the baseline as displayed (the viewport turns rotated pages), rounded to a quarter turn.
    const dx = viewportTransform[0] * a + viewportTransform[2] * b
    const dy = viewportTransform[1] * a + viewportTransform[3] * b
    const quarter = Math.round(-Math.atan2(dy, dx) / (Math.PI / 2))
    const dir = ((((quarter % 4) + 4) % 4) || 0) as 0 | 1 | 2 | 3
    out.push({ str: it.str, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), size, ...(dir ? { dir } : {}) })
  }
  return out
}

/** Extracts one page's text runs and its displayed size. */
export async function extractRuns(doc: PDFDocumentProxy, pageNo: number): Promise<{ runs: RawItem[]; width: number; height: number }> {
  const page = await doc.getPage(pageNo)
  try {
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    return { runs: itemsToRuns(content.items as TextItemLike[], viewport.transform), width: viewport.width, height: viewport.height }
  } finally {
    page.cleanup()
  }
}

/** Extracts one page as a PageModel (reading order, words, geometry). */
export async function extractPage(doc: PDFDocumentProxy, pageNo: number, opts: CompareOptions = DEFAULT_OPTIONS): Promise<PageModel> {
  const { runs, width, height } = await extractRuns(doc, pageNo)
  return buildPageModel(runs, width, height, opts)
}

/**
 * Extracts every page in order, reporting progress and yielding to the event loop regularly so the UI stays
 * responsive. Stops (rejecting with an AbortError) when `signal` aborts. A page that PDF.js cannot read becomes an
 * empty page (and is counted in `failed`) rather than failing the whole comparison.
 */
export async function extractDocument(
  doc: PDFDocumentProxy,
  opts: CompareOptions,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void
): Promise<{ pages: PageModel[]; failed: number[] }> {
  const pages: PageModel[] = []
  const failed: number[] = []
  let lastYield = Date.now()
  for (let p = 1; p <= doc.numPages; p++) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    try {
      pages.push(await extractPage(doc, p, opts))
    } catch (err) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      console.warn(`Compare: could not read the text of page ${p}`, err)
      failed.push(p)
      pages.push(buildPageModel([], 612, 792, opts))
    }
    onProgress(p, doc.numPages)
    if (Date.now() - lastYield > 25) {
      await new Promise((r) => setTimeout(r, 0))
      lastYield = Date.now()
    }
  }
  return { pages, failed }
}
