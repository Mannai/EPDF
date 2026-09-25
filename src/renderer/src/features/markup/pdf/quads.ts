import { unionRects, viewToPdf, type PageGeom, type Pt, type Rect } from './geometry'

/**
 * QuadPoints for text markup. A quad is 8 numbers in PDF space in the order every mainstream reader
 * writes: top-left, top-right, bottom-left, bottom-right ("top" = towards the top of the text as
 * displayed, so it stays right on rotated pages).
 */
export type Quad = [number, number, number, number, number, number, number, number]

/**
 * Merges the client rects of a text selection (view space: [left, top, right, bottom]) into one rect per
 * visual line. Rects that overlap vertically by at least half the smaller height and are horizontally
 * close (gap up to `gapFactor` × height) are joined, so words split over many text-layer spans become a
 * single strip. Degenerate rects are dropped.
 */
export function mergeRectsIntoLines(rects: readonly Rect[], gapFactor = 0.8): Rect[] {
  const lines: Rect[] = []
  const usable = rects.filter((r) => r[2] - r[0] > 0.1 && r[3] - r[1] > 0.1)
  for (const r of usable) {
    const target = lines.find((l) => sameLine(l, r, gapFactor))
    if (target) {
      target[0] = Math.min(target[0], r[0])
      target[1] = Math.min(target[1], r[1])
      target[2] = Math.max(target[2], r[2])
      target[3] = Math.max(target[3], r[3])
    } else lines.push([...r] as Rect)
  }
  // A late rect can bridge two lines that were created separately; join until stable.
  let changed = true
  while (changed && lines.length > 1) {
    changed = false
    outer: for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        if (sameLine(lines[i], lines[j], gapFactor)) {
          const u = unionRects([lines[i], lines[j]])!
          lines.splice(j, 1)
          lines[i] = u
          changed = true
          break outer
        }
      }
    }
  }
  return lines.sort((a, b) => a[1] - b[1] || a[0] - b[0])
}

function sameLine(a: Rect, b: Rect, gapFactor: number): boolean {
  const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  const minH = Math.min(a[3] - a[1], b[3] - b[1])
  if (overlap < minH * 0.5) return false
  const gap = Math.max(a[0], b[0]) - Math.min(a[2], b[2])
  return gap <= Math.max(a[3] - a[1], b[3] - b[1]) * gapFactor
}

/** A view-space rect [left, top, right, bottom] → quad in PDF space (TL, TR, BL, BR). */
export function viewRectToQuad(g: PageGeom, r: Rect): Quad {
  const tl = viewToPdf(g, r[0], r[1])
  const tr = viewToPdf(g, r[2], r[1])
  const bl = viewToPdf(g, r[0], r[3])
  const br = viewToPdf(g, r[2], r[3])
  return [tl[0], tl[1], tr[0], tr[1], bl[0], bl[1], br[0], br[1]]
}

/** Selection rects (view space) → quads in PDF space, one per line. */
export function selectionToQuads(g: PageGeom, viewRects: readonly Rect[]): Quad[] {
  return mergeRectsIntoLines(viewRects).map((r) => viewRectToQuad(g, r))
}

/** Axis-aligned bounds of quads. */
export function quadsBounds(quads: readonly (readonly number[])[]): Rect | null {
  const xs: number[] = []
  const ys: number[] = []
  for (const q of quads) {
    for (let i = 0; i + 1 < q.length; i += 2) {
      xs.push(q[i])
      ys.push(q[i + 1])
    }
  }
  if (xs.length === 0) return null
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

export interface QuadCorners {
  tl: Pt
  tr: Pt
  bl: Pt
  br: Pt
}

export function quadCorners(q: readonly number[]): QuadCorners {
  return { tl: [q[0], q[1]], tr: [q[2], q[3]], bl: [q[4], q[5]], br: [q[6], q[7]] }
}

/** Flat QuadPoints array → list of 8-number quads (a trailing partial quad is ignored). */
export function splitQuads(flat: readonly number[] | undefined): Quad[] {
  const out: Quad[] = []
  if (!flat) return out
  for (let i = 0; i + 7 < flat.length; i += 8) out.push(flat.slice(i, i + 8) as Quad)
  return out
}

/** Point in the (convex) quad polygon TL → TR → BR → BL, with a tolerance in points. */
export function pointInQuad(q: readonly number[], x: number, y: number, tol = 0): boolean {
  const { tl, tr, bl, br } = quadCorners(q)
  const poly: Pt[] = [tl, tr, br, bl]
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % 4]
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    // Signed distance to the edge; inside is consistently on one side. `tol` grows the polygon.
    const dist = cross / len
    const s = Math.sign(dist)
    if (Math.abs(dist) <= tol) continue
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}
