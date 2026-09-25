/** Pixel helpers: sample (un)packing, PNG/TIFF predictors, box-filter downsampling, photo-vs-graphic detection. */

export interface PredictorParams {
  predictor: number
  colors: number
  bpc: number
  columns: number
}

/** Bytes per pixel row for packed samples. */
export const rowBytes = (width: number, ncomp: number, bpc: number): number => Math.ceil((width * ncomp * bpc) / 8)

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Reverses a PNG (10-15) or TIFF (2) predictor. Returns null when the parameters are not supported. */
export function undoPredictor(data: Uint8Array, p: PredictorParams): Uint8Array | null {
  if (p.predictor <= 1) return data
  const rb = rowBytes(p.columns, p.colors, p.bpc)
  const bpp = Math.max(1, Math.ceil((p.colors * p.bpc) / 8))
  if (p.predictor === 2) {
    if (p.bpc !== 8) return null
    const out = data.slice()
    const rows = Math.floor(out.length / rb)
    for (let y = 0; y < rows; y++) {
      const o = y * rb
      for (let i = p.colors; i < rb; i++) out[o + i] = (out[o + i] + out[o + i - p.colors]) & 255
    }
    return out
  }
  if (p.predictor < 10) return null
  const stride = rb + 1
  const rows = Math.ceil(data.length / stride)
  const out = new Uint8Array(rows * rb)
  for (let y = 0; y < rows; y++) {
    const ft = data[y * stride]
    const src = y * stride + 1
    const dst = y * rb
    const prev = dst - rb
    const n = Math.min(rb, data.length - src)
    for (let i = 0; i < n; i++) {
      const x = data[src + i]
      const a = i >= bpp ? out[dst + i - bpp] : 0
      const b = y > 0 ? out[prev + i] : 0
      const c = y > 0 && i >= bpp ? out[prev + i - bpp] : 0
      let v: number
      switch (ft) {
        case 0:
          v = x
          break
        case 1:
          v = x + a
          break
        case 2:
          v = x + b
          break
        case 3:
          v = x + ((a + b) >> 1)
          break
        case 4:
          v = x + paeth(a, b, c)
          break
        default:
          return null
      }
      out[dst + i] = v & 255
    }
  }
  return out
}

/** Applies PNG row filters (choosing the best per row by the usual sum-of-absolute-differences heuristic). */
export function applyPngPredictor(data: Uint8Array, rb: number, bpp: number): Uint8Array {
  const rows = Math.floor(data.length / rb)
  const out = new Uint8Array(rows * (rb + 1))
  const cand: Uint8Array[] = [0, 1, 2, 3, 4].map(() => new Uint8Array(rb))
  for (let y = 0; y < rows; y++) {
    const o = y * rb
    const p = o - rb
    const scores = [0, 0, 0, 0, 0]
    for (let i = 0; i < rb; i++) {
      const x = data[o + i]
      const a = i >= bpp ? data[o + i - bpp] : 0
      const b = y > 0 ? data[p + i] : 0
      const c = y > 0 && i >= bpp ? data[p + i - bpp] : 0
      cand[0][i] = x
      cand[1][i] = (x - a) & 255
      cand[2][i] = (x - b) & 255
      cand[3][i] = (x - ((a + b) >> 1)) & 255
      cand[4][i] = (x - paeth(a, b, c)) & 255
      for (let f = 0; f < 5; f++) {
        const v = cand[f][i]
        scores[f] += v < 128 ? v : 256 - v
      }
    }
    let best = 0
    for (let f = 1; f < 5; f++) if (scores[f] < scores[best]) best = f
    out[y * (rb + 1)] = best
    out.set(cand[best], y * (rb + 1) + 1)
  }
  return out
}

/** Unpacks 1/2/4/8/16-bit samples to one byte each (raw values, or scaled to 0..255 when `scale`). 16-bit keeps the high byte. */
export function unpackSamples(data: Uint8Array, width: number, height: number, ncomp: number, bpc: number, scale: boolean): Uint8Array {
  const rb = rowBytes(width, ncomp, bpc)
  const per = width * ncomp
  const out = new Uint8Array(per * height)
  if (bpc === 8) {
    for (let y = 0; y < height; y++) out.set(data.subarray(y * rb, y * rb + per), y * per)
    return out
  }
  if (bpc === 16) {
    for (let y = 0; y < height; y++) for (let i = 0; i < per; i++) out[y * per + i] = data[y * rb + i * 2]
    return out
  }
  const mask = (1 << bpc) - 1
  const mul = scale ? 255 / mask : 1
  for (let y = 0; y < height; y++) {
    const ro = y * rb
    for (let i = 0; i < per; i++) {
      const bit = i * bpc
      const v = (data[ro + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask
      out[y * per + i] = scale ? Math.round(v * mul) : v
    }
  }
  return out
}

/** Packs bytes (0/1 values for 1 bit; raw values otherwise) into rows of `bpc`-bit samples. */
export function packSamples(samples: Uint8Array, width: number, height: number, ncomp: number, bpc: number): Uint8Array {
  const rb = rowBytes(width, ncomp, bpc)
  const per = width * ncomp
  const out = new Uint8Array(rb * height)
  if (bpc === 8) {
    for (let y = 0; y < height; y++) out.set(samples.subarray(y * per, y * per + per), y * rb)
    return out
  }
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < per; i++) {
      const bit = i * bpc
      out[y * rb + (bit >> 3)] |= (samples[y * per + i] & ((1 << bpc) - 1)) << (8 - bpc - (bit & 7))
    }
  }
  return out
}

/**
 * Area-averaging (box filter) resize of interleaved 8-bit samples. Streaming: memory is one output image plus a few rows,
 * so multi-hundred-megapixel scans do not need a second full-size buffer.
 */
export function resizeBox(src: Uint8Array, w: number, h: number, ncomp: number, nw: number, nh: number): Uint8Array {
  if (nw === w && nh === h) return src
  const out = new Uint8Array(nw * nh * ncomp)
  // Horizontal weights: destination x covers source [x*rx, (x+1)*rx).
  const rx = w / nw
  const ry = h / nh
  const xs = new Int32Array(nw)
  const xn = new Int32Array(nw)
  const xw: number[] = []
  const xo = new Int32Array(nw)
  for (let x = 0; x < nw; x++) {
    const a = x * rx
    const b = Math.min(w, (x + 1) * rx)
    const i0 = Math.floor(a)
    const i1 = Math.min(w - 1, Math.ceil(b) - 1)
    xs[x] = i0
    xn[x] = i1 - i0 + 1
    xo[x] = xw.length
    for (let i = i0; i <= i1; i++) xw.push((Math.min(b, i + 1) - Math.max(a, i)) / (b - a))
  }
  const xwt = Float32Array.from(xw)
  const rowBuf = new Float32Array(nw * ncomp)
  const acc = new Float32Array(nw * ncomp)
  let oy = 0
  let filled = 0 // how much of destination row `oy` (in source rows) has been accumulated
  for (let sy = 0; sy < h && oy < nh; sy++) {
    // horizontal resample of source row
    const so = sy * w * ncomp
    for (let x = 0; x < nw; x++) {
      const n = xn[x]
      const o = xo[x]
      const s0 = xs[x]
      for (let c = 0; c < ncomp; c++) {
        let s = 0
        for (let k = 0; k < n; k++) s += src[so + (s0 + k) * ncomp + c] * xwt[o + k]
        rowBuf[x * ncomp + c] = s
      }
    }
    // distribute this source row over the destination rows it overlaps
    let remain = 1
    while (remain > 1e-9 && oy < nh) {
      const need = ry - filled
      const take = Math.min(remain, need)
      const wgt = take / ry
      for (let i = 0; i < acc.length; i++) acc[i] += rowBuf[i] * wgt
      filled += take
      remain -= take
      if (filled >= ry - 1e-9) {
        const oo = oy * nw * ncomp
        for (let i = 0; i < acc.length; i++) out[oo + i] = Math.min(255, Math.max(0, Math.round(acc[i])))
        acc.fill(0)
        filled = 0
        oy++
      }
    }
  }
  // Rounding leftovers: flush any partially filled last row.
  if (oy < nh && filled > 0) {
    const oo = oy * nw * ncomp
    const f = ry / filled
    for (let i = 0; i < acc.length; i++) out[oo + i] = Math.min(255, Math.max(0, Math.round(acc[i] * f)))
    oy++
  }
  for (; oy < nh; oy++) out.copyWithin(oy * nw * ncomp, (oy - 1) * nw * ncomp, oy * nw * ncomp)
  return out
}

/** Distinct-colour estimate over a pixel sample: photographs have thousands, screenshots and line art a few hundred. */
export function countColors(px: Uint8Array, npix: number, ncomp: number, cap = 4096): number {
  const seen = new Set<number>()
  const step = Math.max(1, Math.floor(npix / 65536))
  for (let i = 0; i < npix; i += step) {
    let key = 0
    for (let c = 0; c < ncomp; c++) key = (key * 257 + px[i * ncomp + c]) | 0
    seen.add(key)
    if (seen.size >= cap) break
  }
  return seen.size
}

/** A raster is "photographic" when it uses many distinct colours: worth JPEG. Otherwise it stays lossless. */
export const isPhotographic = (px: Uint8Array, npix: number, ncomp: number): boolean => countColors(px, npix, ncomp, 1500) >= 1024
