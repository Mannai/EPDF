/**
 * Pixel comparison of two rendered pages (the "visual diff"). Pure array maths, so it runs in a Web Worker and
 * in Node tests. Buffers are RGBA, width * height * 4 bytes.
 */

export interface PixelDiff {
  /** 1 where the pixels differ, else 0 (width * height). */
  mask: Uint8Array
  /** Number of differing pixels. */
  count: number
  total: number
  /** count / total. */
  ratio: number
  /** Bounding box of the differences, or null when there are none. */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null
}

/** Fewer differing pixels than this are treated as rendering noise, not a visual difference. */
export const MIN_DIFF_PIXELS = 12

export const DEFAULT_SENSITIVITY = 70

/**
 * Sensitivity 0..100 (higher = notices smaller colour changes) -> the largest per-channel difference (0..255)
 * that still counts as "the same": 100 notices a change of 4 levels, 0 only a nearly complete inversion.
 */
export function thresholdFor(sensitivity: number): number {
  const s = Math.min(100, Math.max(0, sensitivity))
  return Math.round(4 + (100 - s) * 2.5)
}

export function diffPixels(a: Uint8ClampedArray | Uint8Array, b: Uint8ClampedArray | Uint8Array, w: number, h: number, sensitivity: number): PixelDiff {
  if (a.length < w * h * 4 || b.length < w * h * 4) throw new Error('Pixel buffers are smaller than the stated size.')
  const limit = thresholdFor(sensitivity)
  const mask = new Uint8Array(w * h)
  let count = 0
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      const d = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]))
      if (d > limit) {
        mask[y * w + x] = 1
        count++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  const total = w * h
  return { mask, count, total, ratio: total ? count / total : 0, bbox: count ? { x0, y0, x1, y1 } : null }
}

/** Pads an RGBA image with white to `w` x `h` (top-left aligned), so pages of different sizes can be compared. */
export function padToSize(src: Uint8ClampedArray | Uint8Array, sw: number, sh: number, w: number, h: number): Uint8ClampedArray {
  if (sw === w && sh === h) return src instanceof Uint8ClampedArray ? src : new Uint8ClampedArray(src)
  const out = new Uint8ClampedArray(w * h * 4).fill(255)
  for (let y = 0; y < Math.min(sh, h); y++) out.set(src.subarray(y * sw * 4, y * sw * 4 + Math.min(sw, w) * 4), y * w * 4)
  return out
}

export const isVisualDifference = (d: { count: number }): boolean => d.count >= MIN_DIFF_PIXELS

export interface Region {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Groups the differing pixels into a few boxes (for outlines and for the screen reader): the mask is reduced to
 * a grid of `cell`-pixel squares, touching squares (8-neighbourhood, one square of slack) are joined.
 */
export function diffRegions(mask: Uint8Array, w: number, h: number, cell = 16, maxRegions = 200): Region[] {
  const cols = Math.ceil(w / cell)
  const rows = Math.ceil(h / cell)
  const grid = new Uint8Array(cols * rows)
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / cell) * cols
    for (let x = 0; x < w; x++) if (mask[y * w + x]) grid[row + Math.floor(x / cell)] = 1
  }
  const seen = new Uint8Array(cols * rows)
  const out: Region[] = []
  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || seen[start]) continue
    let minC = cols
    let maxC = -1
    let minR = rows
    let maxR = -1
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const cur = stack.pop()!
      const c = cur % cols
      const r = (cur - c) / cols
      minC = Math.min(minC, c)
      maxC = Math.max(maxC, c)
      minR = Math.min(minR, r)
      maxR = Math.max(maxR, r)
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nc = c + dc
          const nr = r + dr
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
          const ni = nr * cols + nc
          if (grid[ni] && !seen[ni]) {
            seen[ni] = 1
            stack.push(ni)
          }
        }
      }
    }
    out.push({ x: minC * cell, y: minR * cell, w: Math.min(w, (maxC + 1) * cell) - minC * cell, h: Math.min(h, (maxR + 1) * cell) - minR * cell })
    if (out.length >= maxRegions) break
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x)
}
