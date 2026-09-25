import { boxBlur, histogram, morph, otsu, percentile, toGray, upsampleMap, type RgbaImage } from './image'

/**
 * Contrast enhancement for document pages: illumination ("shadow") removal by dividing by a large-scale paper
 * background estimate, then per-preset tone handling. Pure functions over pixel arrays.
 */

export type ScanPreset = 'original' | 'color' | 'gray' | 'bw'

export interface EnhanceOptions {
  /** Black & white only: positive keeps more (lighter) marks, negative removes faint marks. -40..40, default 0. */
  bwBias?: number
}

/** Area-average downsample of a single channel. */
function downsampleMean(src: ArrayLike<number>, w: number, h: number, sw: number, sh: number): Float32Array {
  const sum = new Float32Array(sw * sh)
  const cnt = new Float32Array(sw * sh)
  for (let y = 0; y < h; y++) {
    const dy = Math.min(sh - 1, Math.floor((y * sh) / h))
    for (let x = 0; x < w; x++) {
      const dx = Math.min(sw - 1, Math.floor((x * sw) / w))
      sum[dy * sw + dx] += src[y * w + x]
      cnt[dy * sw + dx]++
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : 255
  return sum
}

/**
 * Smooth map of the local paper brightness: grey closing (removes text/ink smaller than the window) on a small
 * copy, then blurred and scaled back up to `w x h`.
 */
export function estimateBackground(src: ArrayLike<number>, w: number, h: number, windowFrac: number): Float32Array {
  const long = Math.max(w, h)
  const s = Math.min(1, 240 / long)
  const sw = Math.max(4, Math.round(w * s))
  const sh = Math.max(4, Math.round(h * s))
  const small = downsampleMean(src, w, h, sw, sh)
  const r = Math.max(1, Math.round(windowFrac * Math.max(sw, sh)))
  const closed = morph(morph(small, sw, sh, r, true), sw, sh, r, false)
  const smooth = boxBlur(boxBlur(closed, sw, sh, Math.max(1, Math.round(r / 2))), sw, sh, Math.max(1, Math.round(r / 3)))
  return upsampleMap(smooth, sw, sh, w, h)
}

/**
 * Divides a grey channel by its background estimate: paper becomes ~255, ink stays dark. minBackground caps the
 * gain, so large dark areas (photos, logos) are not washed out when that matters.
 */
export function flattenGray(gray: ArrayLike<number>, w: number, h: number, windowFrac = 0.05, minBackground = 24): Float32Array {
  const bg = estimateBackground(gray, w, h, windowFrac)
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, (gray[i] * 255) / Math.max(minBackground, bg[i]))
  return out
}

export function enhance(img: RgbaImage, preset: ScanPreset, opts: EnhanceOptions = {}): RgbaImage {
  if (preset === 'original') return img
  const { width: w, height: h } = img
  const out = new Uint8ClampedArray(w * h * 4)
  if (preset === 'color') {
    // per-channel flatten = white balance + shadow removal; hue is kept
    const n = w * h
    const chan = new Uint8Array(n)
    const flat: Float32Array[] = []
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) chan[i] = img.data[i * 4 + c]
      flat.push(flattenGray(chan, w, h, 0.08, 100))
    }
    const luma = new Float32Array(n)
    for (let i = 0; i < n; i++) luma[i] = (flat[0][i] * 77 + flat[1][i] * 151 + flat[2][i] * 28) / 256
    const bp = Math.min(70, percentile(histogram(luma), 0.005))
    const wp = 236
    const scale = 255 / Math.max(1, wp - bp)
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) out[i * 4 + c] = (flat[c][i] - bp) * scale
      out[i * 4 + 3] = 255
    }
    return { width: w, height: h, data: out }
  }
  const gray = toGray(img)
  const flat = flattenGray(gray.data, w, h, 0.05)
  if (preset === 'gray') {
    const bp = Math.min(80, percentile(histogram(flat), 0.005))
    const wp = 236
    const scale = 255 / Math.max(1, wp - bp)
    for (let i = 0; i < w * h; i++) {
      const v = (flat[i] - bp) * scale
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
      out[i * 4 + 3] = 255
    }
    return { width: w, height: h, data: out }
  }
  // bw
  const t = bwThreshold(flat, opts.bwBias ?? 0)
  for (let i = 0; i < w * h; i++) {
    const v = flat[i] > t ? 255 : 0
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
    out[i * 4 + 3] = 255
  }
  return { width: w, height: h, data: out }
}

/** Otsu on the flattened page, kept in a sane band so a nearly blank page does not turn into noise. */
export function bwThreshold(flat: ArrayLike<number>, bias = 0): number {
  const t = otsu(histogram(flat))
  return Math.min(200, Math.max(110, t)) + bias
}

/** Packs a black/white image (R channel, >127 = white) into 1 bit per pixel rows (MSB first, 1 = white, rows padded to whole bytes). */
export function packBilevel(img: RgbaImage): { packed: Uint8Array; rowBytes: number } {
  const rowBytes = (img.width + 7) >> 3
  const packed = new Uint8Array(rowBytes * img.height)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4] > 127) packed[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return { packed, rowBytes }
}

/**
 * Adds a PNG filter byte to each row: type 2 (Up) for every row but the first (type 0). Deflating the result gives
 * the data of a PDF /FlateDecode stream with /DecodeParms << /Predictor 15 >>, which compresses text pages far better.
 */
export function applyPngUp(packed: Uint8Array, rowBytes: number, rows: number): Uint8Array {
  const out = new Uint8Array((rowBytes + 1) * rows)
  for (let y = 0; y < rows; y++) {
    const o = y * (rowBytes + 1)
    out[o] = y === 0 ? 0 : 2
    for (let x = 0; x < rowBytes; x++) out[o + 1 + x] = y === 0 ? packed[x] : (packed[y * rowBytes + x] - packed[(y - 1) * rowBytes + x]) & 255
  }
  return out
}
