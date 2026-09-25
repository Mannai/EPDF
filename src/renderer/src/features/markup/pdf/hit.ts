import { distToSegment } from './ink'
import { rectContains, type Pt } from './geometry'
import { isStateRecord } from './threads'
import { isTextMarkup, isVisible, type AnnotInfo } from './model'
import { pointInQuad } from './quads'

/**
 * Hit-testing for the Select tool, in PDF space. Text markup uses its quads, drawings use their
 * strokes, lines their segment; everything else its /Rect. Replies, state records and hidden
 * annotations cannot be clicked on the page. When several annotations are hit, the one drawn last
 * (highest in the /Annots order) wins.
 */
export function hitTest(annots: readonly AnnotInfo[], pageIndex: number, p: Pt, tol = 3): AnnotInfo | undefined {
  const hits = annots.filter((a) => a.pageIndex === pageIndex && isVisible(a) && !a.irt && !isStateRecord(a) && hits1(a, p, tol))
  if (hits.length === 0) return undefined
  return hits.reduce((best, a) => (a.order >= best.order ? a : best))
}

function hits1(a: AnnotInfo, p: Pt, tol: number): boolean {
  const [x, y] = p
  if (isTextMarkup(a.subtype) && a.quads.length) return a.quads.some((q) => pointInQuad(q, x, y, tol))
  if (a.subtype === 'Ink' && a.ink.length) {
    const reach = tol + a.borderWidth / 2
    return a.ink.some((s) => {
      if (s.length === 2) return Math.hypot(x - s[0], y - s[1]) <= reach
      for (let i = 0; i + 3 < s.length; i += 2) {
        if (distToSegment(p, [s[i], s[i + 1]], [s[i + 2], s[i + 3]]) <= reach) return true
      }
      return false
    })
  }
  if (a.subtype === 'Line' && a.line && a.line.length >= 4) {
    return distToSegment(p, [a.line[0], a.line[1]], [a.line[2], a.line[3]]) <= tol + a.borderWidth / 2 + 2
  }
  return rectContains(a.rect, x, y, tol)
}
