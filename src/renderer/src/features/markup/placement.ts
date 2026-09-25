import { activeTab } from '../../state/actions'
import { notify } from '../../state/notify'
import { createShape, createStamp, type ShapeKind } from './actions'
import { viewRectToPdf, viewToPdf } from './pdf/geometry'
import { pageEntry, visibleAnchor } from './pages'
import { useMarkup } from './store'

export type PlaceKind = 'note' | 'textbox' | 'stamp' | ShapeKind

/**
 * Keyboard-friendly placement: puts the annotation near the top-left of the visible part of the current
 * page with a default size, so every placement tool works without a pointing device. (With a mouse you
 * click or drag on the page instead.)
 */
export async function placeDefault(kind: PlaceKind): Promise<void> {
  const tab = activeTab()
  if (!tab || tab.status !== 'ready') return
  const pageIndex = tab.view.page - 1
  const entry = pageEntry(tab.docId, pageIndex)
  const anchor = visibleAnchor(tab.docId, pageIndex)
  if (!entry || !anchor) {
    notify('info', 'Scroll to the page first, then try again.')
    return
  }
  const [vx, vy] = anchor.at
  const at = (x: number, y: number): [number, number] => viewToPdf(entry.geom, vx + x, vy + y)
  const { docId } = tab
  if (kind === 'note') {
    useMarkup.getState().setDraft({ kind: 'note', docId, pageIndex, at: at(12, 12) })
  } else if (kind === 'textbox') {
    useMarkup.getState().setDraft({ kind: 'textbox', docId, pageIndex, rect: viewRectToPdf(entry.geom, [vx, vy, vx + 200, vy + 48]) })
  } else if (kind === 'stamp') {
    await createStamp(docId, pageIndex, at(80, 30))
  } else if (kind === 'rect' || kind === 'ellipse') {
    await createShape(docId, pageIndex, kind, at(0, 0), at(140, 90))
  } else {
    await createShape(docId, pageIndex, kind, at(0, 0), at(140, 60))
  }
}
