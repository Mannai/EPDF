import { PDFArray, PDFName, PDFNumber, type PDFPage } from 'pdf-lib'
import type { OverlaySettings, PageSelection } from '../../../../../shared/features/headerfooter'
import { expandRanges, parsePageRanges } from '../../../../../shared/features/pages/ranges'

/**
 * Page geometry for marks. Everything is placed in READER SPACE: the visible page (CropBox clipped to the MediaBox)
 * upright as the reader sees it, with /Rotate applied, origin at its bottom-left, x right, y up, in points. The matrix
 * of `readerMatrix` maps reader space to the page's user space; marks are Form XObjects with that /Matrix, so they sit
 * on the visible page the right way up whatever the page's rotation or box offsets.
 */

export type Matrix = [number, number, number, number, number, number]

export interface PageGeometry {
  /** Visible box in user space [x0, y0, x1, y1] (normalised, x0 < x1, y0 < y1). */
  box: [number, number, number, number]
  /** Page /Rotate normalised to 0, 90, 180 or 270 (clockwise, as in PDF). */
  rotate: 0 | 90 | 180 | 270
  /** Size of the visible page as the reader sees it (width and height swap for 90/270). */
  width: number
  height: number
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** p then q (row-vector convention used by PDF: x' = x * M). */
export function multiply(p: Matrix, q: Matrix): Matrix {
  return [
    p[0] * q[0] + p[1] * q[2],
    p[0] * q[1] + p[1] * q[3],
    p[2] * q[0] + p[3] * q[2],
    p[2] * q[1] + p[3] * q[3],
    p[4] * q[0] + p[5] * q[2] + q[4],
    p[4] * q[1] + p[5] * q[3] + q[5]
  ]
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-12) throw new Error('Matrix is not invertible')
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)]
}

export const apply = (m: Matrix, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]
export const scaling = (s: number): Matrix => [s, 0, 0, s, 0, 0]
/** Counter-clockwise rotation by `deg` degrees. */
export function rotation(deg: number): Matrix {
  const r = (deg * Math.PI) / 180
  const c = Math.abs(Math.cos(r)) < 1e-12 ? 0 : Math.cos(r)
  const s = Math.abs(Math.sin(r)) < 1e-12 ? 0 : Math.sin(r)
  return [c, s, -s, c, 0, 0]
}

export function normalizeRotation(angle: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
  return r as 0 | 90 | 180 | 270
}

function boxOf(page: PDFPage, key: 'MediaBox' | 'CropBox'): [number, number, number, number] | null {
  // Read through inheritance (pdf-lib's getMediaBox/getCropBox do, but return corners un-normalised).
  const leaf = page.node
  const raw = leaf.getInheritableAttribute(PDFName.of(key))
  const arr = raw ? leaf.context.lookupMaybe(raw, PDFArray) : undefined
  if (!arr || arr.size() < 4) return null
  const v: number[] = []
  for (let i = 0; i < 4; i++) {
    const n = arr.lookup(i)
    if (!(n instanceof PDFNumber)) return null
    v.push(n.asNumber())
  }
  return [Math.min(v[0]!, v[2]!), Math.min(v[1]!, v[3]!), Math.max(v[0]!, v[2]!), Math.max(v[1]!, v[3]!)]
}

/** The visible box: CropBox intersected with MediaBox (what PDF.js, Acrobat and pdfium show). */
export function visibleBox(page: PDFPage): [number, number, number, number] {
  const media = boxOf(page, 'MediaBox') ?? [0, 0, 612, 792]
  const crop = boxOf(page, 'CropBox')
  if (!crop) return media
  const x0 = Math.max(media[0], crop[0])
  const y0 = Math.max(media[1], crop[1])
  const x1 = Math.min(media[2], crop[2])
  const y1 = Math.min(media[3], crop[3])
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : media
}

export function geometryOf(page: PDFPage): PageGeometry {
  const box = visibleBox(page)
  let angle = 0
  try {
    angle = page.getRotation().angle
  } catch {
    angle = 0
  }
  return geometryFor(box, normalizeRotation(angle))
}

export function geometryFor(box: [number, number, number, number], rotate: 0 | 90 | 180 | 270): PageGeometry {
  const w = box[2] - box[0]
  const h = box[3] - box[1]
  const swap = rotate === 90 || rotate === 270
  return { box, rotate, width: swap ? h : w, height: swap ? w : h }
}

/**
 * Reader space -> user space. The page is shown rotated CLOCKWISE by /Rotate, so reader "up" is user +y for 0,
 * user -x for 90, user -y for 180 and user +x for 270.
 */
export function readerMatrix(g: PageGeometry): Matrix {
  const [x0, y0, x1, y1] = g.box
  switch (g.rotate) {
    case 0:
      return [1, 0, 0, 1, x0, y0]
    case 90:
      return [0, 1, -1, 0, x1, y0]
    case 180:
      return [-1, 0, 0, -1, x1, y1]
    case 270:
      return [0, -1, 1, 0, x0, y1]
  }
}

/** A stable key for pages that share geometry (marks that do not change per page are shared between them). */
export const geometryKey = (g: PageGeometry): string => `${g.box.map((v) => Math.round(v * 1000) / 1000).join(',')}@${g.rotate}`

// ------------------------------------------------------------------------------------------------ overlay placement

export interface Placement {
  /** Maps the source's own upright space (0..w, 0..h) into reader space. */
  matrix: Matrix
  /** The scale that was applied. */
  scale: number
  /** Reader-space bounding box of the placed (rotated) source. */
  bbox: [number, number, number, number]
}

/**
 * Where a watermark/background of natural size `w` x `h` goes on a page of reader size `W` x `H`: scaled (relative to
 * the page or absolute), rotated counter-clockwise about its centre, and anchored by its rotated bounding box at the
 * chosen edge/centre, then offset by dx/dy.
 */
export function placeOverlay(w: number, h: number, W: number, H: number, o: Pick<OverlaySettings, 'rotation' | 'scale' | 'position'>): Placement {
  const r = (o.rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(r))
  const sin = Math.abs(Math.sin(r))
  const bw = w * cos + h * sin
  const bh = w * sin + h * cos
  const pct = o.scale.percent / 100
  const s = o.scale.mode === 'relative' ? (bw > 0 && bh > 0 ? pct * Math.min(W / bw, H / bh) : 1) : pct
  const sbw = bw * s
  const sbh = bh * s
  const cx = (o.position.h === 'left' ? sbw / 2 : o.position.h === 'right' ? W - sbw / 2 : W / 2) + o.position.dx
  const cy = (o.position.v === 'bottom' ? sbh / 2 : o.position.v === 'top' ? H - sbh / 2 : H / 2) + o.position.dy
  const m = multiply(multiply(multiply(translate(-w / 2, -h / 2), scaling(s)), rotation(o.rotation)), translate(cx, cy))
  return { matrix: m, scale: s, bbox: [cx - sbw / 2, cy - sbh / 2, cx + sbw / 2, cy + sbh / 2] }
}

// ------------------------------------------------------------------------------------------------ page selection

export type Selection = { ok: true; pages: number[] } | { ok: false; error: string }

/** 0-based, sorted, unique page indices of a selection (range text + odd/even). */
export function selectPages(numPages: number, sel: PageSelection): Selection {
  let pages: number[]
  if (sel.range.trim() === '') pages = Array.from({ length: numPages }, (_, i) => i)
  else {
    const r = parsePageRanges(sel.range, numPages)
    if (!r.ok) return r
    pages = [...new Set(expandRanges(r.ranges))].sort((a, b) => a - b)
  }
  if (sel.subset === 'odd') pages = pages.filter((i) => (i + 1) % 2 === 1)
  else if (sel.subset === 'even') pages = pages.filter((i) => (i + 1) % 2 === 0)
  if (pages.length === 0) return { ok: false, error: sel.subset === 'all' ? 'No pages are selected.' : `The range has no ${sel.subset} pages.` }
  return { ok: true, pages }
}
