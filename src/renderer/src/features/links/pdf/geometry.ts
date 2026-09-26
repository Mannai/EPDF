import { rectContains, unionRects, viewRectToPdf, type PageGeom, type Rect } from '../../markup/pdf/geometry'
import { pointInQuad, quadsBounds, viewRectToQuad, type Quad } from '../../markup/pdf/quads'
import type { LinkInfo } from './model'

/** Rect/QuadPoints maths for links. Everything is in PDF user space unless a name says "view". */

/** Smallest links are still clickable/selectable. */
export const MIN_LINK_SIZE = 4

/** The /Rect of a link that covers the given quads (their bounding box). */
export function rectOfQuads(quads: readonly Quad[]): Rect | null {
  return quadsBounds(quads)
}

export function translateQuads(quads: readonly Quad[], dx: number, dy: number): Quad[] {
  return quads.map((q) => q.map((v, i) => v + (i % 2 === 0 ? dx : dy)) as Quad)
}

/** Maps quads that filled `from` onto `to` (used when a multi-line link is resized). */
export function scaleQuads(quads: readonly Quad[], from: Rect, to: Rect): Quad[] {
  const fw = from[2] - from[0] || 1
  const fh = from[3] - from[1] || 1
  const sx = (to[2] - to[0]) / fw
  const sy = (to[3] - to[1]) / fh
  return quads.map((q) => q.map((v, i) => (i % 2 === 0 ? to[0] + (v - from[0]) * sx : to[1] + (v - from[1]) * sy)) as Quad)
}

/** A view-space rectangle drawn on the displayed page → the link's PDF-space rect (rotation and CropBox offset applied). */
export const viewRectToLinkRect = viewRectToPdf

/** View-space line rects of a text selection → one link region: the union rect plus (for several lines) the quads. */
export function regionFromViewRects(g: PageGeom, lines: readonly Rect[]): { rect: Rect; quads: Quad[] } | null {
  if (lines.length === 0) return null
  const quads = lines.map((r) => viewRectToQuad(g, r))
  const rects = quads.map((q) => quadsBounds([q])!)
  const rect = unionRects(rects)!
  return { rect, quads: lines.length > 1 ? quads : [] }
}

/** Whether a point (PDF space) is on a link: inside its rect, or inside one of its quads, with a tolerance in points. */
export function linkContains(l: Pick<LinkInfo, 'rect' | 'quads' | 'border'>, x: number, y: number, tol = 0): boolean {
  const t = tol + (l.border.width > 0 ? l.border.width / 2 : 0)
  if (!rectContains(l.rect, x, y, t)) return false
  if (l.quads.length === 0) return true
  return l.quads.some((q) => pointInQuad(q, x, y, t))
}

/** The link under a point: the smallest one wins so a link inside a larger one stays reachable. */
export function hitLink(links: readonly LinkInfo[], pageIndex: number, x: number, y: number, tol = 0): LinkInfo | undefined {
  let best: LinkInfo | undefined
  let bestArea = Infinity
  for (const l of links) {
    if (l.pageIndex !== pageIndex || !linkContains(l, x, y, tol)) continue
    const area = (l.rect[2] - l.rect[0]) * (l.rect[3] - l.rect[1])
    if (area <= bestArea) {
      best = l
      bestArea = area
    }
  }
  return best
}

/** Ensures a rect is at least MIN_LINK_SIZE in both directions (keeps its centre). */
export function ensureMinSize(r: Rect): Rect {
  const [x0, y0, x1, y1] = r
  const w = Math.max(MIN_LINK_SIZE, x1 - x0)
  const h = Math.max(MIN_LINK_SIZE, y1 - y0)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
}
