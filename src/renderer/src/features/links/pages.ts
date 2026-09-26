import type { PageGeom, Rect } from '../markup/pdf/geometry'
import { mergeRectsIntoLines } from '../markup/pdf/quads'
import { regionFromViewRects } from './pdf/geometry'
import type { LinkRegion } from './store'

/**
 * The pages currently rendered, registered by the links overlay (the only place with the PDF.js viewport):
 * used to turn the browser's text selection into link regions and to place a link for keyboard users.
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

export function pageEntryOf(docId: string, pageIndex: number): { el: HTMLElement; entry: PageEntry } | undefined {
  for (const [el, entry] of registry) if (entry.docId === docId && entry.pageIndex === pageIndex && el.isConnected) return { el, entry }
  return undefined
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

export interface SelectionRegions {
  docId: string
  text: string
  regions: LinkRegion[]
}

/** The selected text as link regions, one per page it touches (a line of text = a rect; several lines = QuadPoints). */
export function selectionRegions(): SelectionRegions | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const regions: LinkRegion[] = []
  let docId = ''
  for (const [el, entry] of registry) {
    if (!el.isConnected || !range.intersectsNode(el)) continue
    const lines = mergeRectsIntoLines(selectedRects(el, entry, range))
    const region = regionFromViewRects(entry.geom, lines)
    if (!region) continue
    docId = entry.docId
    regions.push({ pageIndex: entry.pageIndex, rect: region.rect, quads: region.quads })
  }
  if (regions.length === 0) return null
  regions.sort((a, b) => a.pageIndex - b.pageIndex)
  return { docId, text: sel.toString().replace(/\s+/g, ' ').trim(), regions }
}

export const clearSelection = (): void => window.getSelection()?.removeAllRanges()

/** A default link box near the top-left of what is visible on `pageIndex` (for keyboard users), in PDF space. */
export function defaultRegion(docId: string, pageIndex: number): LinkRegion | null {
  const found = pageEntryOf(docId, pageIndex)
  if (!found) return null
  const { el, entry } = found
  const box = el.getBoundingClientRect()
  const scroller = el.closest('[data-testid="viewer-scroll"]')?.getBoundingClientRect()
  const top = Math.max(box.top, scroller?.top ?? 0)
  const left = Math.max(box.left, scroller?.left ?? 0)
  const x = (left - box.left) / entry.scale + 40
  const y = (top - box.top) / entry.scale + 40
  const view: Rect = [x, y, x + 160, y + 20]
  const region = regionFromViewRects(entry.geom, [view])
  return region ? { pageIndex, rect: region.rect, quads: [] } : null
}
