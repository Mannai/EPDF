/**
 * Image comparison for the text rendering harness: "does the PDF text look like Chromium's own rendering of the same
 * text in the same font?". Works on grayscale ink images (0 = paper, 255 = full ink) and is deliberately tolerant of
 * anti-aliasing and sub-pixel position differences while being extremely sensitive to what matters here: wrong glyph
 * forms, wrong order, missing or displaced marks, wrong advances.
 */

export interface Ink {
  width: number
  height: number
  /** 0..255, row-major. */
  data: Float32Array
}

/** Convert RGBA (or BGRA: gray is symmetric enough) pixels on a light background to an ink image. */
export function toInk(rgba: ArrayLike<number>, width: number, height: number): Ink {
  const data = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4]!
    const g = rgba[i * 4 + 1]!
    const b = rgba[i * 4 + 2]!
    const a = rgba[i * 4 + 3]! / 255
    // composite on white, then invert
    const gray = (0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a)
    data[i] = 255 - gray
  }
  return { width, height, data }
}

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function inkBox(img: Ink, threshold = 40): Box | null {
  let x0 = img.width
  let y0 = img.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[y * img.width + x]! > threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

function crop(img: Ink, b: Box, pad: number): Ink {
  const w = b.x1 - b.x0 + 2 * pad
  const h = b.y1 - b.y0 + 2 * pad
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = b.x0 - pad + x
      const sy = b.y0 - pad + y
      if (sx >= 0 && sy >= 0 && sx < img.width && sy < img.height) out[y * w + x] = img.data[sy * img.width + sx]!
    }
  }
  return { width: w, height: h, data: out }
}

function blur(img: Ink, passes = 2): Ink {
  let src = img.data
  const { width: w, height: h } = img
  for (let p = 0; p < passes; p++) {
    const dst = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            const yy = y + dy
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) {
              s += src[yy * w + xx]!
              n++
            }
          }
        }
        dst[y * w + x] = s / n
      }
    }
    src = dst
  }
  return { width: w, height: h, data: src }
}

/** Normalised cross-correlation of two images placed at offset (dx, dy), over the union canvas. */
function ncc(a: Ink, b: Ink, dx: number, dy: number, W: number, H: number): number {
  let sa = 0
  let sb = 0
  let saa = 0
  let sbb = 0
  let sab = 0
  const n = W * H
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const va = x < a.width && y < a.height ? a.data[y * a.width + x]! : 0
      const bx = x - dx
      const by = y - dy
      const vb = bx >= 0 && by >= 0 && bx < b.width && by < b.height ? b.data[by * b.width + bx]! : 0
      sa += va
      sb += vb
      saa += va * va
      sbb += vb * vb
      sab += va * vb
    }
  }
  const cov = sab - (sa * sb) / n
  const va = saa - (sa * sa) / n
  const vb = sbb - (sb * sb) / n
  if (va <= 1e-6 || vb <= 1e-6) return 0
  return cov / Math.sqrt(va * vb)
}

export interface Similarity {
  /** Best normalised cross-correlation over small shifts (1 = identical). */
  ncc: number
  /** Ink box size of the first / second image. */
  a: { width: number; height: number }
  b: { width: number; height: number }
  /** width(a) / width(b) */
  widthRatio: number
  heightRatio: number
}

/** Compare two ink images by their ink content only (position of the text on the page does not matter). */
export function similarity(a: Ink, b: Ink, maxShift = 3): Similarity {
  const ba = inkBox(a)
  const bb = inkBox(b)
  if (!ba || !bb) return { ncc: 0, a: { width: 0, height: 0 }, b: { width: 0, height: 0 }, widthRatio: 0, heightRatio: 0 }
  const pad = maxShift + 1
  const ca = blur(crop(a, ba, pad))
  const cb = blur(crop(b, bb, pad))
  const W = Math.max(ca.width, cb.width)
  const H = Math.max(ca.height, cb.height)
  let best = -1
  for (let dy = -maxShift; dy <= maxShift; dy++) for (let dx = -maxShift; dx <= maxShift; dx++) best = Math.max(best, ncc(ca, cb, dx, dy, W, H))
  const wa = ba.x1 - ba.x0
  const wb = bb.x1 - bb.x0
  const ha = ba.y1 - ba.y0
  const hb = bb.y1 - bb.y0
  return { ncc: best, a: { width: wa, height: ha }, b: { width: wb, height: hb }, widthRatio: wa / wb, heightRatio: ha / hb }
}
