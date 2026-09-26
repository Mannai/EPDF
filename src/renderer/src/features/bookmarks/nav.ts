import type { PDFPage } from 'pdf-lib'
import type { DestTail } from '@shared/features/destinations'
import { destTop } from '@shared/features/destinations'
import { getLoaded } from '../../pdf/docCache'
import { useTabs } from '../../state/tabs'
import { geomOfPage, viewSize, viewToPdf } from '../markup/pdf/geometry'

/**
 * Navigation and "where am I" helpers for bookmarks and link destinations, built on what the viewer exposes:
 * the tab's page number, the scroll container and the `.epdf-page` elements.
 */

/** A point on a page as fractions (0..1) of the DISPLAYED page from its top-left corner (rotation-independent). */
export interface ViewTarget {
  pageIndex: number
  fx: number
  fy: number
}

const scrollerOf = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="viewer-scroll"]')
const pageEl = (pageNumber: number): HTMLElement | null => document.querySelector<HTMLElement>(`.epdf-page[data-page="${pageNumber}"]`)

/** The top-left of what is visible on the current page, e.g. for "Add bookmark here". */
export function currentViewTarget(docId: string): ViewTarget | null {
  const tab = useTabs.getState().tabs.find((t) => t.docId === docId)
  if (!tab || tab.status !== 'ready') return null
  const pageIndex = tab.view.page - 1
  const el = pageEl(tab.view.page)
  const scroller = scrollerOf()
  if (!el || !scroller) return { pageIndex, fx: 0, fy: 0 }
  const box = el.getBoundingClientRect()
  const sbox = scroller.getBoundingClientRect()
  const top = Math.max(0, Math.min(box.height, sbox.top - box.top))
  return { pageIndex, fx: 0, fy: box.height > 0 ? top / box.height : 0 }
}

/** The page and top of the text currently selected in a page's text layer, with the selected text. */
export function selectionTarget(): { text: string; target: ViewTarget } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const node = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const page = node?.closest<HTMLElement>('.epdf-page')
  if (!page || !page.querySelector('.textLayer')?.contains(node)) return null
  const text = sel.toString().replace(/\s+/g, ' ').trim()
  if (!text) return null
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
  const box = page.getBoundingClientRect()
  const top = rects.length ? Math.min(...rects.map((r) => r.top)) : box.top
  const pageNumber = Number(page.dataset.page)
  if (!Number.isFinite(pageNumber)) return null
  return { text, target: { pageIndex: pageNumber - 1, fx: 0, fy: box.height > 0 ? Math.max(0, Math.min(1, (top - box.top) / box.height)) : 0 } }
}

/** The PDF-space point a ViewTarget stands for on `page` (rotation and CropBox applied). */
export function targetToPdfPoint(page: PDFPage, t: Pick<ViewTarget, 'fx' | 'fy'>): [number, number] {
  const g = geomOfPage(page)
  const [w, h] = viewSize(g)
  return viewToPdf(g, t.fx * w, t.fy * h)
}

/** `XYZ left top null`: opens the page with that point at the top-left of the window, at the reader's current zoom. */
export function xyzTail(page: PDFPage, t: Pick<ViewTarget, 'fx' | 'fy'>): DestTail {
  const [x, y] = targetToPdfPoint(page, t)
  return ['XYZ', x, y, null]
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

/**
 * Scrolls the viewer to a destination inside the document: the page always, and the destination's vertical
 * position when it has one (XYZ, FitH, FitR, ...). Best effort for the position; never throws.
 */
export async function goToDestination(docId: string, pageIndex: number, tail: DestTail = ['Fit']): Promise<void> {
  const tabs = useTabs.getState()
  tabs.goToPage(docId, pageIndex + 1)
  const top = destTop(tail)
  if (top === null) return
  try {
    const loaded = getLoaded(docId)
    if (!loaded) return
    const page = await loaded.doc.getPage(pageIndex + 1)
    const vp = page.getViewport({ scale: 1 })
    const left = typeof tail[1] === 'number' && tail[0] === 'XYZ' ? tail[1] : vp.viewBox[0]
    const [, vy] = vp.convertToViewportPoint(left, top)
    // Wait for the viewer's own "go to page" scroll (it aligns the page top just below the scroller's top edge) to
    // land, then move within the page. Give up waiting after a while (short last pages cannot scroll that far).
    for (let i = 0; i < 45; i++) {
      await nextFrame()
      const el = pageEl(pageIndex + 1)
      const scroller = scrollerOf()
      if (!el || !scroller || el.offsetHeight === 0) continue
      const pageTopInScroller = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      if (Math.abs(pageTopInScroller - 12) > 3 && i < 44) continue
      const scale = el.offsetHeight / vp.height
      const delta = pageTopInScroller + vy * scale - 12
      if (Math.abs(delta) > 1) scroller.scrollTop += delta
      return
    }
  } catch {
    /* the page is enough */
  }
}
