/**
 * Small, dependency-free raster helpers for the scanning pipeline. Everything here is plain TypeScript over typed
 * arrays so it runs unchanged in a Web Worker (the app) and in Node (the unit tests).
 */

export interface RgbaImage {
  width: number
  height: number
  /** width * height * 4 bytes, straight (non-premultiplied) alpha; scanned pages are always opaque. */
  data: Uint8ClampedArray
}

export interface GrayImage {
  width: number
  height: number
  data: Uint8Array
}

export const createRgba = (width: number, height: number, fill: [number, number, number] = [255, 255, 255]): RgbaImage => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]
    data[i + 1] = fill[1]
    data[i + 2] = fill[2]
    data[i + 3] = 255
  }
  return { width, height, data }
}

export const cloneRgba = (img: RgbaImage): RgbaImage => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) })

/** Rec. 601 luma. */
export function toGray(img: RgbaImage): GrayImage {
  const { width, height, data } = img
  const out = new Uint8Array(width * height)
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (data[i] * 77 + data[i + 1] * 151 + data[i + 2] * 28) >> 8
  return { width, height, data: out }
}

/** min(R, G, B): bright for white paper, dark for anything coloured or dark. */
export function toMinChannel(img: RgbaImage): GrayImage {
  const { width, height, data } = img
  const out = new Uint8Array(width * height)
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = Math.min(data[i], data[i + 1], data[i + 2])
  return { width, height, data: out }
}

export function grayToRgba(g: GrayImage): RgbaImage {
  const out = new Uint8ClampedArray(g.width * g.height * 4)
  for (let i = 0, j = 0; j < g.data.length; j++, i += 4) {
    out[i] = out[i + 1] = out[i + 2] = g.data[j]
    out[i + 3] = 255
  }
  return { width: g.width, height: g.height, data: out }
}

/** Bilinear sample of one channel of an RGBA image at continuous pixel-centre coordinates (clamped at the edges). */
export function sampleBilinear(data: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: number): number {
  const fx = x - 0.5
  const fy = y - 0.5
  let x0 = Math.floor(fx)
  let y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  let x1 = x0 + 1
  let y1 = y0 + 1
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 < 0) x1 = 0
  if (y1 < 0) y1 = 0
  if (x0 >= w) x0 = w - 1
  if (y0 >= h) y0 = h - 1
  if (x1 >= w) x1 = w - 1
  if (y1 >= h) y1 = h - 1
  const a = data[(y0 * w + x0) * 4 + c]
  const b = data[(y0 * w + x1) * 4 + c]
  const cc = data[(y1 * w + x0) * 4 + c]
  const d = data[(y1 * w + x1) * 4 + c]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty
}

/**
 * Resizes with an integer box pre-filter (so shrinking a 12 MP photo does not alias) followed by a bilinear
 * resample to the exact target size.
 */
export function resizeRgba(src: RgbaImage, width: number, height: number): RgbaImage {
  width = Math.max(1, Math.round(width))
  height = Math.max(1, Math.round(height))
  if (width === src.width && height === src.height) return src
  let cur = src
  const kx = Math.floor(src.width / width)
  const ky = Math.floor(src.height / height)
  const k = Math.min(kx, ky)
  if (k >= 2) cur = boxReduce(src, k)
  if (cur.width === width && cur.height === height) return cur
  const out = new Uint8ClampedArray(width * height * 4)
  const sx = cur.width / width
  const sy = cur.height / height
  for (let y = 0; y < height; y++) {
    const py = (y + 0.5) * sy
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) * sx
      const o = (y * width + x) * 4
      out[o] = sampleBilinear(cur.data, cur.width, cur.height, px, py, 0)
      out[o + 1] = sampleBilinear(cur.data, cur.width, cur.height, px, py, 1)
      out[o + 2] = sampleBilinear(cur.data, cur.width, cur.height, px, py, 2)
      out[o + 3] = 255
    }
  }
  return { width, height, data: out }
}

function boxReduce(src: RgbaImage, k: number): RgbaImage {
  const w = Math.floor(src.width / k)
  const h = Math.floor(src.height / k)
  const out = new Uint8ClampedArray(w * h * 4)
  const area = k * k
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let dy = 0; dy < k; dy++) {
        let i = ((y * k + dy) * src.width + x * k) * 4
        for (let dx = 0; dx < k; dx++, i += 4) {
          r += src.data[i]
          g += src.data[i + 1]
          b += src.data[i + 2]
        }
      }
      const o = (y * w + x) * 4
      out[o] = r / area
      out[o + 1] = g / area
      out[o + 2] = b / area
      out[o + 3] = 255
    }
  }
  return { width: w, height: h, data: out }
}

/** Scales so the long side is at most `maxLong` (never enlarges). */
export function fitLongSide(src: RgbaImage, maxLong: number): RgbaImage {
  const long = Math.max(src.width, src.height)
  if (long <= maxLong) return src
  const f = maxLong / long
  return resizeRgba(src, src.width * f, src.height * f)
}

/** Rotates by whole quarter turns clockwise (0..3). */
export function rotateQuarterTurns(src: RgbaImage, turns: number): RgbaImage {
  const t = ((turns % 4) + 4) % 4
  if (t === 0) return src
  const { width: w, height: h } = src
  const ow = t === 2 ? w : h
  const oh = t === 2 ? h : w
  const out = new Uint8ClampedArray(ow * oh * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number
      let ny: number
      if (t === 1) {
        nx = h - 1 - y
        ny = x
      } else if (t === 2) {
        nx = w - 1 - x
        ny = h - 1 - y
      } else {
        nx = y
        ny = w - 1 - x
      }
      const s = (y * w + x) * 4
      const d = (ny * ow + nx) * 4
      out[d] = src.data[s]
      out[d + 1] = src.data[s + 1]
      out[d + 2] = src.data[s + 2]
      out[d + 3] = src.data[s + 3]
    }
  }
  return { width: ow, height: oh, data: out }
}

/**
 * Rotates about the centre by `degrees` clockwise (image y points down), keeping the canvas size; uncovered
 * corners are filled with `fill`.
 */
export function rotateDegrees(src: RgbaImage, degrees: number, fill: [number, number, number] = [255, 255, 255]): RgbaImage {
  if (Math.abs(degrees) < 1e-6) return src
  const { width: w, height: h } = src
  const out = new Uint8ClampedArray(w * h * 4)
  const a = (degrees * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const cx = w / 2
  const cy = h / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // inverse map: rotate the destination point back by -a
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const sx = cos * dx + sin * dy + cx
      const sy = -sin * dx + cos * dy + cy
      const o = (y * w + x) * 4
      if (sx < 0 || sy < 0 || sx > w || sy > h) {
        out[o] = fill[0]
        out[o + 1] = fill[1]
        out[o + 2] = fill[2]
      } else {
        out[o] = sampleBilinear(src.data, w, h, sx, sy, 0)
        out[o + 1] = sampleBilinear(src.data, w, h, sx, sy, 1)
        out[o + 2] = sampleBilinear(src.data, w, h, sx, sy, 2)
      }
      out[o + 3] = 255
    }
  }
  return { width: w, height: h, data: out }
}

/** Separable box blur (running sums, clamped edges). Works on any numeric array; returns Float32Array. */
export function boxBlur(src: ArrayLike<number>, w: number, h: number, radius: number): Float32Array {
  if (radius < 1) return Float32Array.from(src)
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const n = radius * 2 + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let i = -radius; i <= radius; i++) sum += src[row + Math.min(w - 1, Math.max(0, i))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / n
      sum += src[row + Math.min(w - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let i = -radius; i <= radius; i++) sum += tmp[Math.min(h - 1, Math.max(0, i)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n
      sum += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x]
    }
  }
  return out
}

/** Approximate Gaussian blur: three box passes. */
export function gaussianBlur(src: ArrayLike<number>, w: number, h: number, sigma: number): Float32Array {
  // three boxes of radius r approximate sigma^2 = 3 * (r*(r+1)/3) -> r ~ sqrt(sigma^2 + 0.25) - 0.5
  const r = Math.max(1, Math.round(Math.sqrt(sigma * sigma + 0.25) - 0.5))
  let cur = boxBlur(src, w, h, r)
  cur = boxBlur(cur, w, h, r)
  return boxBlur(cur, w, h, r)
}

/** Grey morphology with a (2r+1) square window; `dilate` takes the max, otherwise the min. Separable. */
export function morph(src: ArrayLike<number>, w: number, h: number, radius: number, dilate: boolean): Float32Array {
  const pick = dilate ? Math.max : Math.min
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = src[y * w + x]
      const a = Math.max(0, x - radius)
      const b = Math.min(w - 1, x + radius)
      for (let i = a; i <= b; i++) v = pick(v, src[y * w + i])
      tmp[y * w + x] = v
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x]
      const a = Math.max(0, y - radius)
      const b = Math.min(h - 1, y + radius)
      for (let i = a; i <= b; i++) v = pick(v, tmp[i * w + x])
      out[y * w + x] = v
    }
  }
  return out
}

/** Bilinear upsample of a single-channel float map to the given size. */
export function upsampleMap(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const fx = sw / w
  const fy = sh / h
  for (let y = 0; y < h; y++) {
    const py = (y + 0.5) * fy - 0.5
    let y0 = Math.floor(py)
    const ty = py - y0
    let y1 = y0 + 1
    if (y0 < 0) y0 = 0
    if (y1 < 0) y1 = 0
    if (y0 >= sh) y0 = sh - 1
    if (y1 >= sh) y1 = sh - 1
    for (let x = 0; x < w; x++) {
      const px = (x + 0.5) * fx - 0.5
      let x0 = Math.floor(px)
      const tx = px - x0
      let x1 = x0 + 1
      if (x0 < 0) x0 = 0
      if (x1 < 0) x1 = 0
      if (x0 >= sw) x0 = sw - 1
      if (x1 >= sw) x1 = sw - 1
      const a = src[y0 * sw + x0]
      const b = src[y0 * sw + x1]
      const c = src[y1 * sw + x0]
      const d = src[y1 * sw + x1]
      out[y * w + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    }
  }
  return out
}

/** Otsu's threshold for a 256-bin histogram: the level that best separates dark from bright. */
export function otsu(hist: ArrayLike<number>): number {
  let total = 0
  let sumAll = 0
  for (let i = 0; i < 256; i++) {
    total += hist[i]
    sumAll += i * hist[i]
  }
  if (total === 0) return 128
  let wB = 0
  let sumB = 0
  let best = 0
  let bestT = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      bestT = t
    }
  }
  return bestT
}

export function histogram(g: ArrayLike<number>): Uint32Array {
  const h = new Uint32Array(256)
  for (let i = 0; i < g.length; i++) h[Math.max(0, Math.min(255, Math.round(g[i])))]++
  return h
}

/** The value below which `fraction` (0..1) of the pixels fall. */
export function percentile(hist: ArrayLike<number>, fraction: number): number {
  let total = 0
  for (let i = 0; i < 256; i++) total += hist[i]
  const target = total * fraction
  let acc = 0
  for (let i = 0; i < 256; i++) {
    acc += hist[i]
    if (acc >= target) return i
  }
  return 255
}
