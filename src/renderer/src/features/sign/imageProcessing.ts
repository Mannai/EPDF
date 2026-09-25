/**
 * Pure pixel operations for signature images (imported scans/photos, typed and drawn signatures). They work
 * on `{ data, width, height }` (RGBA, like ImageData) so they run in Node tests without a canvas.
 */

export interface Pixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

export const DEFAULT_WHITE_THRESHOLD = 235
const SOFT_EDGE = 28

/**
 * Makes near-white pixels transparent so a signature photographed on paper can sit on any page.
 * Pixels whose darkest channel is at least `threshold` become fully transparent; between
 * `threshold - 28` and `threshold` alpha ramps up smoothly (anti-aliased edges, no white halo).
 * Existing transparency is respected. Returns a new buffer; the input is not modified.
 */
export function removeNearWhite(img: Pixels, threshold = DEFAULT_WHITE_THRESHOLD): Pixels {
  const t = Math.min(255, Math.max(1, threshold))
  const soft = Math.min(SOFT_EDGE, t)
  const out = new Uint8ClampedArray(img.data)
  for (let i = 0; i < out.length; i += 4) {
    const lightest = Math.min(out[i], out[i + 1], out[i + 2]) // the darkest channel decides: colored ink stays
    if (lightest >= t) out[i + 3] = 0
    else if (lightest > t - soft) out[i + 3] = Math.round((out[i + 3] * (t - lightest)) / soft)
  }
  return { data: out, width: img.width, height: img.height }
}

/** The smallest rectangle containing every pixel with alpha above `alphaMin`, or null if it is all clear. */
export function contentBounds(img: Pixels, alphaMin = 8): Bounds | null {
  let minX = img.width
  let minY = img.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width * 4
    for (let x = 0; x < img.width; x++) {
      if (img.data[row + x * 4 + 3] > alphaMin) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Copies a sub-rectangle (clamped to the image). */
export function crop(img: Pixels, b: Bounds): Pixels {
  const x0 = Math.max(0, Math.floor(b.x))
  const y0 = Math.max(0, Math.floor(b.y))
  const x1 = Math.min(img.width, Math.ceil(b.x + b.w))
  const y1 = Math.min(img.height, Math.ceil(b.y + b.h))
  const w = Math.max(0, x1 - x0)
  const h = Math.max(0, y1 - y0)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * 4
    data.set(img.data.subarray(from, from + w * 4), y * w * 4)
  }
  return { data, width: w, height: h }
}

/** Crops away transparent margins, keeping `padding` px of space. Returns null for an empty image. */
export function trimTransparent(img: Pixels, padding = 0): Pixels | null {
  const b = contentBounds(img)
  if (!b) return null
  return crop(img, { x: b.x - padding, y: b.y - padding, w: b.w + 2 * padding, h: b.h + 2 * padding })
}

/** Size that fits inside `max` x `max` keeping the aspect ratio (never enlarges). */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) }
}

/** Fraction (0..1) of pixels that are visibly opaque: a quick "is anything there?" check. */
export function inkCoverage(img: Pixels, alphaMin = 8): number {
  let n = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > alphaMin) n++
  return n / Math.max(1, img.width * img.height)
}
