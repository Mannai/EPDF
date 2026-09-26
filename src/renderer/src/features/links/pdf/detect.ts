import type { PDFDocument } from 'pdf-lib'
import type { TextLine } from '@shared/features/textlines'
import { pageLines } from '../../bookmarks/pdf/pageLines'
import type { Rect } from '../../markup/pdf/geometry'
import { readLinks } from './read'
import type { LinkInfo } from './model'
import { findLinkables } from './url'

/**
 * Finds web and e-mail addresses in a document's text and where they are on the page, so they can be offered
 * as links. Uses the content-stream engine (exact glyph positions), so the boxes hug the text.
 */

export interface DetectedLink {
  /** Index in the result list (stable for one run). */
  id: number
  pageIndex: number
  /** The text as written ("www.example.com") and the address it becomes ("https://www.example.com/"). */
  text: string
  url: string
  kind: 'web' | 'email'
  rect: Rect
  /** An existing link already covers (most of) this text. */
  covered: boolean
}

/** The box of characters [start, end) of a line, from the per-character extents. */
export function boxOfSpan(line: TextLine, start: number, end: number): Rect | null {
  const boxes = line.chars.slice(start, end)
  if (boxes.length === 0) return null
  const x0 = Math.min(...boxes.map((b) => b.x0))
  const x1 = Math.max(...boxes.map((b) => b.x1))
  if (!(x1 > x0)) return null
  return [x0, line.y0, x1, line.y1]
}

const overlapRatio = (a: Rect, b: Rect): number => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  if (w <= 0 || h <= 0) return 0
  return (w * h) / Math.max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))
}

/** Addresses found on one page's lines (existing links of that page mark matches as `covered`). */
export function detectOnLines(lines: readonly TextLine[], pageIndex: number, existing: readonly LinkInfo[], startId = 0): DetectedLink[] {
  const out: DetectedLink[] = []
  for (const line of lines) {
    for (const f of findLinkables(line.text)) {
      const rect = boxOfSpan(line, f.start, f.end)
      if (!rect) continue
      const covered = existing.some((l) => l.pageIndex === pageIndex && overlapRatio(rect, l.rect) >= 0.5)
      out.push({ id: startId + out.length, pageIndex, text: f.text, url: f.url, kind: f.kind, rect, covered })
    }
  }
  return out
}

export interface DetectProgress {
  page: number
  total: number
}

/**
 * Scans the whole document in small slices, yielding to the UI between them. `shouldStop` is polled between
 * slices (Cancel). Returns what was found so far when stopped.
 */
export async function detectLinks(pdf: PDFDocument, opts: { onProgress?(p: DetectProgress): void; shouldStop?(): boolean } = {}): Promise<{ found: DetectedLink[]; stopped: boolean }> {
  const existing = readLinks(pdf)
  const total = pdf.getPageCount()
  const found: DetectedLink[] = []
  let sliceStart = Date.now()
  for (let i = 0; i < total; i++) {
    if (opts.shouldStop?.()) return { found, stopped: true }
    const page = pageLines(pdf, i, { includeInvisible: true })
    found.push(...detectOnLines(page.lines, i, existing, found.length))
    if (Date.now() - sliceStart > 30) {
      opts.onProgress?.({ page: i + 1, total })
      await new Promise((r) => setTimeout(r, 0))
      sliceStart = Date.now()
    }
  }
  opts.onProgress?.({ page: total, total })
  return { found, stopped: false }
}
