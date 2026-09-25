import type { PageGeom, Rect } from './pdf/geometry'
import { selectionToQuads, type Quad } from './pdf/quads'

/**
 * The pages currently rendered, registered by the page overlay (which is the only place that has the
 * PDF.js viewport). Used to turn a browser text selection into QuadPoints and to place things on
 * "the current page" for keyboard users.
 */
export interface PageEntry {
  docId: string
  pageIndex: number
  scale: number
  geom: PageGeom
}

const registry = new Map<HTMLElement, PageEntry>()

export function registerPage(el: HTMLElement, entry: PageEntry): () => void {
  registry.set(el, entry)
  return () => {
    if (registry.get(el) === entry) registry.delete(el)
  }
}

export interface SelectionGroup {
  docId: string
  pageIndex: number
  quads: Quad[]
}

/** Client rects of the selected text inside one page's text layer, in view points relative to the page. */
function selectedRects(el: HTMLElement, entry: PageEntry, range: Range): Rect[] {
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
      out.push([(cr.left - box.left) / entry.scale, (cr.top - box.top) / entry.scale, (cr.right - box.left) / entry.scale, (cr.bottom - box.top) / entry.scale])
    }
  }
  return out
}

/** The current text selection as QuadPoints per page (empty when nothing in a page's text layer is selected). */
export function selectionQuads(): SelectionGroup[] {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return []
  const range = sel.getRangeAt(0)
  const groups: SelectionGroup[] = []
  for (const [el, entry] of registry) {
    if (!el.isConnected || !range.intersectsNode(el)) continue
    const rects = selectedRects(el, entry, range)
    if (rects.length === 0) continue
    const quads = selectionToQuads(entry.geom, rects)
    if (quads.length) groups.push({ docId: entry.docId, pageIndex: entry.pageIndex, quads })
  }
  return groups.sort((a, b) => a.pageIndex - b.pageIndex)
}

export function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}

/** A sensible spot on `pageIndex` for keyboard-placed annotations: near the top-left of what is visible. */
export function visibleAnchor(docId: string, pageIndex: number): { at: [number, number] } | null {
  for (const [el, entry] of registry) {
    if (entry.docId !== docId || entry.pageIndex !== pageIndex || !el.isConnected) continue
    const box = el.getBoundingClientRect()
    const scroller = el.closest('[data-testid="viewer-scroll"]')?.getBoundingClientRect()
    const top = Math.max(box.top, scroller?.top ?? 0)
    const left = Math.max(box.left, scroller?.left ?? 0)
    // view points inside the page, 40 css px from the visible corner
    return { at: [(left - box.left + 40) / entry.scale, (top - box.top + 40) / entry.scale] }
  }
  return null
}

export function pageEntry(docId: string, pageIndex: number): PageEntry | undefined {
  for (const [el, entry] of registry) if (entry.docId === docId && entry.pageIndex === pageIndex && el.isConnected) return entry
  return undefined
}
