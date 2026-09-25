import type { PDFPage } from 'pdf-lib'

/** [x0, y0, x1, y1]; for PDF-space rects x0<=x1 and y0<=y1 (y up). */
export type Rect = [number, number, number, number]
export type Pt = [number, number]

/**
 * A page's displayed geometry: its visible box (CropBox ∩ MediaBox, PDF user space, y up) and its
 * /Rotate (clockwise degrees). "View" coordinates are points on the *displayed* page: origin top-left,
 * y down, rotation applied, scale 1 (multiply by the zoom scale to get CSS pixels).
 */
export interface PageGeom {
  box: Rect
  rotation: 0 | 90 | 180 | 270
}

export function normRotation(r: number): 0 | 90 | 180 | 270 {
  const n = ((Math.round(r / 90) * 90) % 360 + 360) % 360
  return n as 0 | 90 | 180 | 270
}

export function normalizeRect(r: readonly number[]): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
}

export const rectWidth = (r: Rect): number => r[2] - r[0]
export const rectHeight = (r: Rect): number => r[3] - r[1]
export const translateRect = (r: Rect, dx: number, dy: number): Rect => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]
export const insetRect = (r: Rect, d: number): Rect => [r[0] + d, r[1] + d, r[2] - d, r[3] - d]
export const padRect = (r: Rect, d: number): Rect => insetRect(r, -d)

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let [x0, y0, x1, y1] = rects[0]
  for (const r of rects) {
    x0 = Math.min(x0, r[0])
    y0 = Math.min(y0, r[1])
    x1 = Math.max(x1, r[2])
    y1 = Math.max(y1, r[3])
  }
  return [x0, y0, x1, y1]
}

export const rectContains = (r: Rect, x: number, y: number, tol = 0): boolean =>
  x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol

export function intersectRects(a: Rect, b: Rect): Rect | null {
  const r: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
  return r[0] < r[2] && r[1] < r[3] ? r : null
}

/** Size of the displayed page in points. */
export function viewSize(g: PageGeom): [number, number] {
  const w = g.box[2] - g.box[0]
  const h = g.box[3] - g.box[1]
  return g.rotation === 90 || g.rotation === 270 ? [h, w] : [w, h]
}

/** PDF user space → view points (origin top-left of the displayed page). */
export function pdfToView(g: PageGeom, x: number, y: number): Pt {
  const u = x - g.box[0]
  const v = y - g.box[1]
  const w = g.box[2] - g.box[0]
  const h = g.box[3] - g.box[1]
  switch (g.rotation) {
    case 90:
      return [v, u]
    case 180:
      return [w - u, v]
    case 270:
      return [h - v, w - u]
    default:
      return [u, h - v]
  }
}

/** View points → PDF user space. Exact inverse of `pdfToView`. */
export function viewToPdf(g: PageGeom, vx: number, vy: number): Pt {
  const w = g.box[2] - g.box[0]
  const h = g.box[3] - g.box[1]
  let u: number
  let v: number
  switch (g.rotation) {
    case 90:
      u = vy
      v = vx
      break
    case 180:
      u = w - vx
      v = vy
      break
    case 270:
      u = w - vy
      v = h - vx
      break
    default:
      u = vx
      v = h - vy
  }
  return [u + g.box[0], v + g.box[1]]
}

/** A view-space rect [left, top, right, bottom] → normalized PDF-space rect. */
export function viewRectToPdf(g: PageGeom, r: Rect): Rect {
  const [ax, ay] = viewToPdf(g, r[0], r[1])
  const [bx, by] = viewToPdf(g, r[2], r[3])
  return normalizeRect([ax, ay, bx, by])
}

/** A PDF-space rect → view-space rect [left, top, right, bottom]. */
export function pdfRectToView(g: PageGeom, r: Rect): Rect {
  const [ax, ay] = pdfToView(g, r[0], r[1])
  const [bx, by] = pdfToView(g, r[2], r[3])
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

/** Moves a PDF-space point so a `w × h` (PDF-space) rect centred on it stays inside the page box. */
export function clampCenter(g: PageGeom, cx: number, cy: number, w: number, h: number): Pt {
  const [x0, y0, x1, y1] = g.box
  const x = w >= x1 - x0 ? (x0 + x1) / 2 : Math.min(Math.max(cx, x0 + w / 2), x1 - w / 2)
  const y = h >= y1 - y0 ? (y0 + y1) / 2 : Math.min(Math.max(cy, y0 + h / 2), y1 - h / 2)
  return [x, y]
}

/** The visible box of a pdf-lib page (CropBox ∩ MediaBox) and its rotation. */
export function geomOfPage(page: PDFPage): PageGeom {
  const m = page.getMediaBox()
  const c = page.getCropBox()
  const media: Rect = [m.x, m.y, m.x + m.width, m.y + m.height]
  const crop: Rect = [c.x, c.y, c.x + c.width, c.y + c.height]
  return { box: intersectRects(media, crop) ?? media, rotation: normRotation(page.getRotation().angle) }
}

/** Geometry from a PDF.js viewport (`viewBox` + `rotation`). */
export function geomOfViewport(vp: { viewBox: number[]; rotation: number }): PageGeom {
  return { box: normalizeRect(vp.viewBox), rotation: normRotation(vp.rotation) }
}

/**
 * Matrix of an appearance whose content is authored "upright" (w × h in view orientation): rotates it
 * back so it displays upright on a page with /Rotate `rotation`. The annotation /Rect then is the
 * bounding box of the transformed BBox (dimensions swapped for 90/270).
 */
export function uprightMatrix(rotation: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (normRotation(rotation)) {
    case 90:
      return [0, 1, -1, 0, h, 0]
    case 180:
      return [-1, 0, 0, -1, w, h]
    case 270:
      return [0, -1, 1, 0, 0, w]
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

/** Inverse of the above: the /Rotate an upright matrix was authored for (0 for identity/unknown). */
export function rotationOfMatrix(m: readonly number[] | undefined): 0 | 90 | 180 | 270 {
  if (!m || m.length < 4) return 0
  const [a, b, c, d] = m
  if (Math.abs(a) < 1e-6 && Math.abs(d) < 1e-6) return b > 0 && c < 0 ? 90 : b < 0 && c > 0 ? 270 : 0
  if (a < 0 && d < 0) return 180
  return 0
}

/** Displayed (upright) dimensions of an annotation rect on a page rotated by `rotation`. */
export function uprightSize(rect: Rect, rotation: number): [number, number] {
  const w = rectWidth(rect)
  const h = rectHeight(rect)
  const r = normRotation(rotation)
  return r === 90 || r === 270 ? [h, w] : [w, h]
}

/** PDF-space rect of an upright `w × h` box centred at (cx, cy) on a page rotated by `rotation`. */
export function uprightRectAt(cx: number, cy: number, w: number, h: number, rotation: number): Rect {
  const r = normRotation(rotation)
  const [pw, ph] = r === 90 || r === 270 ? [h, w] : [w, h]
  return [cx - pw / 2, cy - ph / 2, cx + pw / 2, cy + ph / 2]
}
