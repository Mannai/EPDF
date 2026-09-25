import type { PageViewport } from 'pdfjs-dist'
import { pageModel } from './doc'
import { shapesForRange } from './logic/extract'
import type { Quad, Rect } from './logic/geom'
import type { UiMark } from './store'

/**
 * The pages currently rendered (registered by the page overlay, the only place that has the PDF.js viewport),
 * and the conversion of a browser text selection into redaction marks that follow the real glyph geometry.
 */

export interface PageEntry {
  docId: string
  pageIndex: number
  scale: number
  viewport: PageViewport
}

const registry = new Map<HTMLElement, PageEntry>()

export function registerPage(el: HTMLElement, entry: PageEntry): () => void {
  registry.set(el, entry)
  return () => {
    if (registry.get(el) === entry) registry.delete(el)
  }
}

export function pageEntryOf(docId: string, pageIndex: number): { el: HTMLElement; entry: PageEntry } | undefined {
  for (const [el, entry] of registry) if (entry.docId === docId && entry.pageIndex === pageIndex && el.isConnected) return { el, entry }
  return undefined
}

/** Client rects of the selected text inside one page's text layer, as PDF user-space rects. */
function selectedPdfRects(el: HTMLElement, entry: PageEntry, range: Range): Rect[] {
  const layer = el.querySelector('.textLayer')
  if (!layer) return []
  const box = el.getBoundingClientRect()
  const out: Rect[] = []
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue
    const len = n.textContent?.length ?? 0
    const start = n === range.startContainer ? range.startOffset : 0
    const end = n === range.endContainer ? range.endOffset : len
    if (end <= start) continue
    const r = document.createRange()
    r.setStart(n, start)
    r.setEnd(n, Math.min(end, len))
    for (const cr of Array.from(r.getClientRects())) {
      if (cr.width <= 0 || cr.height <= 0) continue
      const [ax, ay] = entry.viewport.convertToPdfPoint(cr.left - box.left, cr.top - box.top)
      const [bx, by] = entry.viewport.convertToPdfPoint(cr.right - box.left, cr.bottom - box.top)
      out.push({ x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) })
    }
  }
  return out
}

export interface SelectionGroup {
  docId: string
  pageIndex: number
  rects: Rect[]
}

/** The current text selection as PDF-space rects per page (empty when nothing in a page's text layer is selected). */
export function selectionGroups(): SelectionGroup[] {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return []
  const range = sel.getRangeAt(0)
  const groups: SelectionGroup[] = []
  for (const [el, entry] of registry) {
    if (!el.isConnected || !range.intersectsNode(el)) continue
    const rects = selectedPdfRects(el, entry, range)
    if (rects.length) groups.push({ docId: entry.docId, pageIndex: entry.pageIndex, rects })
  }
  return groups.sort((a, b) => a.pageIndex - b.pageIndex)
}

export const clearSelection = (): void => window.getSelection()?.removeAllRanges()

const inside = (x: number, y: number, r: Rect): boolean => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1

/**
 * Turns selection rects into a mark: the glyphs whose centres lie inside the selection are located in the
 * page's text model (so the mark has their exact boxes, rotated ones included). Where a page has no readable
 * glyphs under the selection (a scan, unreadable fonts) the selection rects themselves become an area mark.
 */
export async function marksFromSelection(groups: readonly SelectionGroup[]): Promise<Omit<UiMark, 'id'>[]> {
  const out: Omit<UiMark, 'id'>[] = []
  for (const g of groups) {
    const model = await pageModel(g.docId, g.pageIndex).catch(() => null)
    const chosen: boolean[] = new Array<boolean>(model?.text.length ?? 0).fill(false)
    if (model) {
      model.rects.forEach((r, i) => {
        if (r && g.rects.some((s) => inside((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, s))) chosen[i] = true
      })
      // a space between two selected characters of a line belongs to the selection
      for (let i = 1; i < chosen.length - 1; i++) if (!chosen[i] && model.text[i] === ' ' && chosen[i - 1] && chosen[i + 1]) chosen[i] = true
    }
    if (!model || !chosen.some(Boolean)) {
      out.push({ kind: 'area', pageIndex: g.pageIndex, rects: mergeLines(g.rects), quads: mergeLines(g.rects).map(() => null) })
      continue
    }
    const rects: Rect[] = []
    const quads: (Quad | null)[] = []
    let text = ''
    for (let i = 0; i < chosen.length; ) {
      if (!chosen[i]) {
        i++
        continue
      }
      let j = i
      while (j < chosen.length && chosen[j]) j++
      const s = shapesForRange(model, i, j)
      rects.push(...s.rects)
      quads.push(...s.quads)
      text += (text ? ' ' : '') + model.text.slice(i, j)
      i = j
    }
    out.push({ kind: 'text', pageIndex: g.pageIndex, rects, quads, text: text.replace(/\s+/g, ' ').trim() })
  }
  return out
}

/** Merges the per-fragment rects of a selection into one rect per line. */
function mergeLines(rects: readonly Rect[]): Rect[] {
  const lines: Rect[] = []
  for (const r of [...rects].sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0)) {
    const l = lines.find((x) => Math.abs((x.y0 + x.y1) / 2 - (r.y0 + r.y1) / 2) < Math.max(1, (x.y1 - x.y0) * 0.5))
    if (l) {
      l.x0 = Math.min(l.x0, r.x0)
      l.x1 = Math.max(l.x1, r.x1)
      l.y0 = Math.min(l.y0, r.y0)
      l.y1 = Math.max(l.y1, r.y1)
    } else lines.push({ ...r })
  }
  return lines
}

/** A rectangle in PDF space -> CSS px box on the page. */
export function toBox(viewport: PageViewport, r: Rect): { left: number; top: number; width: number; height: number } {
  const [ax, ay] = viewport.convertToViewportPoint(r.x0, r.y0)
  const [bx, by] = viewport.convertToViewportPoint(r.x1, r.y1)
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }
}

/** Polygon (CSS clip-path percentages) of a quad inside its bounding box, for rotated text marks. */
export function quadClip(viewport: PageViewport, q: Quad, box: { left: number; top: number; width: number; height: number }): string {
  const pts: string[] = []
  for (let i = 0; i < 8; i += 2) {
    const [x, y] = viewport.convertToViewportPoint(q[i], q[i + 1])
    pts.push(`${(((x - box.left) / (box.width || 1)) * 100).toFixed(2)}% ${(((y - box.top) / (box.height || 1)) * 100).toFixed(2)}%`)
  }
  return `polygon(${pts.join(',')})`
}
