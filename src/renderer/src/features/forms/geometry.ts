/**
 * Page geometry: converting between PDF user space (points, origin bottom-left, y up, page /Rotate NOT
 * applied) and CSS pixels on the rendered page (origin top-left, y down, /Rotate applied).
 *
 * At run time the matrix comes straight from the PDF.js viewport (`viewport.transform`), so it is exact
 * by construction. `pageMatrix` mirrors PDF.js' `PageViewport` maths for tests and for code that has no
 * viewport. Pure TypeScript: no DOM, no PDF.js, so it runs in Node.
 */

export type Matrix = [number, number, number, number, number, number]

export interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface CssBox {
  left: number
  top: number
  width: number
  height: number
}

export const normalizeRotation = (deg: number): 0 | 90 | 180 | 270 => (((Math.round(deg / 90) * 90) % 360) + 360) % 360 as 0 | 90 | 180 | 270

/**
 * The PDF.js `PageViewport.transform` for a page: `viewBox` = [x1, y1, x2, y2] of the visible page area
 * (crop box) in user space, `rotation` = the page's /Rotate (+ any extra rotation), `scale` = CSS px per point.
 */
export function pageMatrix(viewBox: readonly number[], rotation: number, scale: number): Matrix {
  const [x1, y1, x2, y2] = viewBox
  const cx = (x2 + x1) / 2
  const cy = (y2 + y1) / 2
  let a: number, b: number, c: number, d: number
  switch (normalizeRotation(rotation)) {
    case 90:
      ;[a, b, c, d] = [0, 1, 1, 0]
      break
    case 180:
      ;[a, b, c, d] = [-1, 0, 0, 1]
      break
    case 270:
      ;[a, b, c, d] = [0, -1, -1, 0]
      break
    default:
      ;[a, b, c, d] = [1, 0, 0, -1]
  }
  let offX: number, offY: number
  if (a === 0) {
    offX = Math.abs(cy - y1) * scale
    offY = Math.abs(cx - x1) * scale
  } else {
    offX = Math.abs(cx - x1) * scale
    offY = Math.abs(cy - y1) * scale
  }
  return [a * scale, b * scale, c * scale, d * scale, offX - a * scale * cx - c * scale * cy, offY - b * scale * cx - d * scale * cy]
}

export class PageGeometry {
  private readonly inv: Matrix

  /** `rotation`: the page's rotation in degrees clockwise (0, 90, 180, 270). */
  constructor(
    readonly matrix: Matrix,
    readonly rotation: 0 | 90 | 180 | 270
  ) {
    const [a, b, c, d, e, f] = matrix
    const det = a * d - b * c
    if (!det) throw new Error('Degenerate page transform')
    this.inv = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
  }

  /** PDF user space → CSS px on the page. */
  toCss(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.matrix
    return [a * x + c * y + e, b * x + d * y + f]
  }

  /** CSS px on the page → PDF user space. */
  toPdf(cx: number, cy: number): [number, number] {
    const [a, b, c, d, e, f] = this.inv
    return [a * cx + c * cy + e, b * cx + d * cy + f]
  }

  /** Bounding box, in CSS px, of a rectangle given in PDF user space (works for any of the 4 rotations). */
  rectToCss(r: Rect): CssBox {
    const p = [this.toCss(r.x1, r.y1), this.toCss(r.x2, r.y2)]
    const left = Math.min(p[0][0], p[1][0])
    const top = Math.min(p[0][1], p[1][1])
    return { left, top, width: Math.abs(p[1][0] - p[0][0]), height: Math.abs(p[1][1] - p[0][1]) }
  }

  /** The PDF user-space rectangle (normalized so x1<x2, y1<y2) covered by a CSS box. */
  boxToPdf(b: CssBox): Rect {
    const p = this.toPdf(b.left, b.top)
    const q = this.toPdf(b.left + b.width, b.top + b.height)
    return { x1: Math.min(p[0], q[0]), y1: Math.min(p[1], q[1]), x2: Math.max(p[0], q[0]), y2: Math.max(p[1], q[1]) }
  }

  /**
   * A frame for drawing something that must look upright on the rotated page: `origin` is the user-space
   * point of the box's visual bottom-left corner, and `rotation` the angle (degrees, counter-clockwise, as
   * pdf-lib wants it) to give text/images so they read left-to-right on screen.
   */
  frameOfBox(b: CssBox): Frame {
    return { origin: this.toPdf(b.left, b.top + b.height), rotation: this.rotation, width: b.width / this.scaleX(), height: b.height / this.scaleX() }
  }

  /** CSS px per PDF point. */
  scaleX(): number {
    return Math.hypot(this.matrix[0], this.matrix[1])
  }
}

/** The geometry of a rendered page, straight from its PDF.js viewport (`transform` and `rotation`). */
export function geometryOf(viewport: { transform: number[]; rotation: number }): PageGeometry {
  return new PageGeometry(viewport.transform as Matrix, normalizeRotation(viewport.rotation))
}

/** A drawing frame in user space: local (dx right, dy up) offsets are what the reader sees on screen. */
export interface Frame {
  origin: [number, number]
  /** Degrees counter-clockwise. Equal to the page's /Rotate. */
  rotation: number
  /** Extent in points (visual width/height). */
  width: number
  height: number
}

/** Maps a visual offset inside a frame (dx to the right, dy upwards, in points) to user space. */
export function frameToUser(f: Pick<Frame, 'origin' | 'rotation'>, dx: number, dy: number): [number, number] {
  const r = (f.rotation * Math.PI) / 180
  const c = Math.round(Math.cos(r) * 1e12) / 1e12
  const s = Math.round(Math.sin(r) * 1e12) / 1e12
  return [f.origin[0] + dx * c - dy * s, f.origin[1] + dx * s + dy * c]
}

/** "#rrggbb" → 0..1 components (falls back to black). */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 0, g: 0, b: 0 }
  const n = parseInt(m[1], 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}
