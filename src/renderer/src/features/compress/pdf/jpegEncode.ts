/**
 * A baseline JPEG encoder written for Epdf (no third-party code).
 *
 * Why not the browser's canvas encoder? Canvas can only produce 3-component YCbCr JPEGs, but PDF images are
 * often DeviceGray (one component) or DeviceCMYK (four); it also cannot optimise the Huffman tables, which
 * makes files 5-10 % smaller. This encoder handles 1, 3 (RGB in, YCbCr out) and 4 (raw components, Adobe
 * marker, no colour transform) components, optional 4:2:0 chroma subsampling and always emits optimised
 * Huffman tables.
 */

export interface JpegEncodeOptions {
  /** 1..100 (IJG scale). */
  quality: number
  /** 4:2:0 chroma subsampling for 3-component images (default: on below quality 90). */
  subsample?: boolean
}

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
])

export const STD_LUMA_QT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103,
  77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
]
const STD_CHROMA_QT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99
]

/** IJG quality scaling of a base quantisation table (natural order). */
export function scaledQuantTable(base: readonly number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)))
  const scale = q < 50 ? 5000 / q : 200 - q * 2
  return base.map((t) => Math.min(255, Math.max(1, Math.floor((t * scale + 50) / 100))))
}

const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379]

/** In-place forward DCT of an 8x8 block (AAN algorithm; output still needs the AAN scale folded into the divisor). */
function fdct(b: Float32Array): void {
  for (let pass = 0; pass < 2; pass++) {
    const step = pass === 0 ? 1 : 8
    const stride = pass === 0 ? 8 : 1
    for (let r = 0; r < 8; r++) {
      const o = r * stride
      const t0 = b[o] + b[o + 7 * step]
      const t7 = b[o] - b[o + 7 * step]
      const t1 = b[o + step] + b[o + 6 * step]
      const t6 = b[o + step] - b[o + 6 * step]
      const t2 = b[o + 2 * step] + b[o + 5 * step]
      const t5 = b[o + 2 * step] - b[o + 5 * step]
      const t3 = b[o + 3 * step] + b[o + 4 * step]
      const t4 = b[o + 3 * step] - b[o + 4 * step]
      let t10 = t0 + t3
      const t13 = t0 - t3
      let t11 = t1 + t2
      let t12 = t1 - t2
      b[o] = t10 + t11
      b[o + 4 * step] = t10 - t11
      const z1 = (t12 + t13) * 0.707106781
      b[o + 2 * step] = t13 + z1
      b[o + 6 * step] = t13 - z1
      t10 = t4 + t5
      t11 = t5 + t6
      t12 = t6 + t7
      const z5 = (t10 - t12) * 0.382683433
      const z2 = 0.5411961 * t10 + z5
      const z4 = 1.306562965 * t12 + z5
      const z3 = t11 * 0.707106781
      const z11 = t7 + z3
      const z13 = t7 - z3
      b[o + 5 * step] = z13 + z2
      b[o + 3 * step] = z13 - z2
      b[o + step] = z11 + z4
      b[o + 7 * step] = z11 - z4
    }
  }
}

interface Comp {
  h: number
  v: number
  /** Component plane padded to whole MCUs. */
  plane: Uint8Array
  pw: number
  ph: number
  qt: number[]
  /** Quantised coefficients, 64 per block, in zigzag order. */
  coefs: Int16Array
  blocksPerLine: number
  blocksPerCol: number
  table: number
}

class BitWriter {
  private buf = new Uint8Array(1 << 16)
  private n = 0
  private acc = 0
  private nacc = 0
  private ensure(k: number): void {
    if (this.n + k <= this.buf.length) return
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.n + k))
    nb.set(this.buf.subarray(0, this.n))
    this.buf = nb
  }
  byte(b: number): void {
    this.ensure(1)
    this.buf[this.n++] = b
  }
  word(w: number): void {
    this.byte(w >> 8)
    this.byte(w & 255)
  }
  bytes(a: ArrayLike<number>): void {
    this.ensure(a.length)
    for (let i = 0; i < a.length; i++) this.buf[this.n++] = a[i]
  }
  bits(code: number, len: number): void {
    if (len === 0) return
    this.acc = (this.acc << len) | (code & ((1 << len) - 1))
    this.nacc += len
    while (this.nacc >= 8) {
      const b = (this.acc >> (this.nacc - 8)) & 255
      this.ensure(2)
      this.buf[this.n++] = b
      if (b === 255) this.buf[this.n++] = 0
      this.nacc -= 8
    }
    this.acc &= (1 << this.nacc) - 1
  }
  flushBits(): void {
    if (this.nacc > 0) this.bits((1 << (8 - this.nacc)) - 1, 8 - this.nacc)
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.n)
  }
}

interface HuffTable {
  /** Number of codes of each length 1..16 (index 0 unused). */
  bits: number[]
  vals: number[]
  code: Int32Array
  size: Uint8Array
}

/** Optimal (length-limited to 16) Huffman table from symbol frequencies: JPEG Annex K.2. */
function buildOptimalTable(freqIn: Uint32Array | number[]): HuffTable {
  const freq = new Array<number>(257).fill(0)
  for (let i = 0; i < 256; i++) freq[i] = freqIn[i] ?? 0
  freq[256] = 1 // reserve the all-ones code
  const codesize = new Array<number>(257).fill(0)
  const others = new Array<number>(257).fill(-1)
  for (;;) {
    let c1 = -1
    let v = 1e18
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) (v = freq[i]), (c1 = i)
    let c2 = -1
    v = 1e18
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) (v = freq[i]), (c2 = i)
    if (c2 < 0) break
    freq[c1] += freq[c2]
    freq[c2] = 0
    codesize[c1]++
    while (others[c1] >= 0) {
      c1 = others[c1]
      codesize[c1]++
    }
    others[c1] = c2
    codesize[c2]++
    while (others[c2] >= 0) {
      c2 = others[c2]
      codesize[c2]++
    }
  }
  const bits = new Array<number>(41).fill(0)
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++
  for (let i = 40; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2
      while (bits[j] === 0) j--
      bits[i] -= 2
      bits[i - 1]++
      bits[j + 1] += 2
      bits[j]--
    }
  }
  let i = 16
  while (bits[i] === 0) i--
  bits[i]-- // drop the reserved symbol
  const vals: number[] = []
  for (let len = 1; len <= 40; len++) for (let s = 0; s < 256; s++) if (codesize[s] === len) vals.push(s)
  const out = { bits: bits.slice(0, 17), vals, code: new Int32Array(256), size: new Uint8Array(256) }
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let n = 0; n < out.bits[len]; n++) {
      out.code[vals[k]] = code
      out.size[vals[k]] = len
      k++
      code++
    }
    code <<= 1
  }
  return out
}

const nbits = (v: number): number => (v === 0 ? 0 : 32 - Math.clz32(v))

function makePlane(w: number, h: number, pw: number, ph: number, fill: (x: number, y: number) => number): Uint8Array {
  const p = new Uint8Array(pw * ph)
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(y, h - 1)
    for (let x = 0; x < pw; x++) p[y * pw + x] = fill(Math.min(x, w - 1), sy)
  }
  return p
}

/**
 * Encodes interleaved 8-bit samples. For 3 components the input is RGB; for 1 it is gray; for 4 the raw components
 * are stored unchanged (Adobe marker with transform 0), so callers must keep the PDF /Decode array as it was.
 */
export function encodeJpeg(width: number, height: number, ncomp: 1 | 3 | 4, data: Uint8Array, opts: JpegEncodeOptions): Uint8Array {
  if (!(width > 0 && height > 0 && width <= 65535 && height <= 65535)) throw new Error('JPEG size out of range')
  if (data.length < width * height * ncomp) throw new Error('JPEG input too short')
  const quality = Math.min(100, Math.max(1, Math.round(opts.quality)))
  const subsample = ncomp === 3 && (opts.subsample ?? quality < 90)
  const qtY = scaledQuantTable(STD_LUMA_QT, quality)
  const qtC = scaledQuantTable(STD_CHROMA_QT, quality)
  const hmax = subsample ? 2 : 1
  const mcusX = Math.ceil(width / (8 * hmax))
  const mcusY = Math.ceil(height / (8 * hmax))
  const comps: Comp[] = []
  const mk = (h: number, v: number, plane: Uint8Array, pw: number, ph: number, qt: number[], table: number): void => {
    const blocksPerLine = mcusX * h
    const blocksPerCol = mcusY * v
    comps.push({ h, v, plane, pw, ph, qt, table, coefs: new Int16Array(blocksPerLine * blocksPerCol * 64), blocksPerLine, blocksPerCol })
  }
  const fullW = mcusX * 8 * hmax
  const fullH = mcusY * 8 * hmax
  if (ncomp === 1) {
    mk(1, 1, makePlane(width, height, fullW, fullH, (x, y) => data[y * width + x]), fullW, fullH, qtY, 0)
  } else if (ncomp === 4) {
    for (let c = 0; c < 4; c++) mk(1, 1, makePlane(width, height, fullW, fullH, (x, y) => data[(y * width + x) * 4 + c]), fullW, fullH, qtY, 0)
  } else {
    const Y = new Uint8Array(fullW * fullH)
    const cbF = new Float32Array(width * height)
    const crF = new Float32Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const r = data[i * 3]
        const g = data[i * 3 + 1]
        const b = data[i * 3 + 2]
        Y[y * fullW + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
        cbF[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128
        crF[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128
      }
      for (let x = width; x < fullW; x++) Y[y * fullW + x] = Y[y * fullW + width - 1]
    }
    for (let y = height; y < fullH; y++) Y.copyWithin(y * fullW, (height - 1) * fullW, height * fullW)
    mk(hmax, hmax, Y, fullW, fullH, qtY, 0)
    const cw = fullW / hmax
    const ch = fullH / hmax
    const chroma = (src: Float32Array): Uint8Array =>
      makePlane(subsample ? Math.ceil(width / 2) : width, subsample ? Math.ceil(height / 2) : height, cw, ch, (x, y) => {
        if (!subsample) return Math.min(255, Math.max(0, Math.round(src[y * width + x])))
        const x0 = x * 2
        const y0 = y * 2
        const x1 = Math.min(x0 + 1, width - 1)
        const y1 = Math.min(y0 + 1, height - 1)
        const s = src[y0 * width + x0] + src[y0 * width + x1] + src[y1 * width + x0] + src[y1 * width + x1]
        return Math.min(255, Math.max(0, Math.round(s / 4)))
      })
    mk(1, 1, chroma(cbF), cw, ch, qtC, 1)
    mk(1, 1, chroma(crF), cw, ch, qtC, 1)
  }

  // Forward DCT + quantisation of every block.
  const blk = new Float32Array(64)
  for (const c of comps) {
    const div = new Float32Array(64)
    for (let i = 0; i < 64; i++) div[i] = 1 / (c.qt[i] * AAN[i >> 3] * AAN[i & 7] * 8)
    for (let by = 0; by < c.blocksPerCol; by++) {
      for (let bx = 0; bx < c.blocksPerLine; bx++) {
        const base = by * 8 * c.pw + bx * 8
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = c.plane[base + y * c.pw + x] - 128
        fdct(blk)
        const o = (by * c.blocksPerLine + bx) * 64
        for (let k = 0; k < 64; k++) {
          const v = blk[ZIGZAG[k]] * div[ZIGZAG[k]]
          c.coefs[o + k] = Math.round(v)
        }
      }
    }
    c.plane = new Uint8Array(0) // release
  }

  // MCU order of blocks: [comp, blockIndex]
  const order: number[] = []
  const single = comps.length === 1
  if (single) {
    const c = comps[0]
    // Non-interleaved: only the blocks that cover the image (ceil(w/8) x ceil(h/8)).
    const bw = Math.ceil(width / 8)
    const bh = Math.ceil(height / 8)
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) order.push(0, by * c.blocksPerLine + bx)
  } else {
    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++) {
        comps.forEach((c, ci) => {
          for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) order.push(ci, (my * c.v + v) * c.blocksPerLine + mx * c.h + h)
        })
      }
    }
  }

  // Pass 1: symbol statistics.
  const nTables = ncomp === 3 ? 2 : 1
  const dcFreq = Array.from({ length: nTables }, () => new Uint32Array(256))
  const acFreq = Array.from({ length: nTables }, () => new Uint32Array(256))
  const walk = (emit: (comp: Comp, kind: 'dc' | 'ac', symbol: number, extra: number, extraLen: number) => void): void => {
    const pred = new Int32Array(comps.length)
    for (let i = 0; i < order.length; i += 2) {
      const ci = order[i]
      const c = comps[ci]
      const o = order[i + 1] * 64
      const co = c.coefs
      const diff = co[o] - pred[ci]
      pred[ci] = co[o]
      let s = nbits(Math.abs(diff))
      emit(c, 'dc', s, diff < 0 ? diff - 1 : diff, s)
      let run = 0
      for (let k = 1; k < 64; k++) {
        const v = co[o + k]
        if (v === 0) {
          run++
          continue
        }
        while (run > 15) {
          emit(c, 'ac', 0xf0, 0, 0)
          run -= 16
        }
        s = nbits(Math.abs(v))
        emit(c, 'ac', (run << 4) | s, v < 0 ? v - 1 : v, s)
        run = 0
      }
      if (run > 0) emit(c, 'ac', 0, 0, 0)
    }
  }
  walk((c, kind, sym) => {
    if (kind === 'dc') dcFreq[c.table][sym]++
    else acFreq[c.table][sym]++
  })
  const dcT = dcFreq.map(buildOptimalTable)
  const acT = acFreq.map(buildOptimalTable)

  const w = new BitWriter()
  w.word(0xffd8)
  if (ncomp === 4) {
    // Adobe APP14: transform 0 (components are stored as they are).
    w.word(0xffee)
    w.word(14)
    w.bytes([0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0])
  } else {
    w.word(0xffe0)
    w.word(16)
    w.bytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  }
  const tables = ncomp === 3 ? [qtY, qtC] : [qtY]
  tables.forEach((qt, id) => {
    w.word(0xffdb)
    w.word(67)
    w.byte(id)
    for (let k = 0; k < 64; k++) w.byte(qt[ZIGZAG[k]])
  })
  w.word(0xffc0)
  w.word(8 + 3 * comps.length)
  w.byte(8)
  w.word(height)
  w.word(width)
  w.byte(comps.length)
  comps.forEach((c, i) => {
    w.byte(i + 1)
    w.byte((c.h << 4) | c.v)
    w.byte(ncomp === 3 && i > 0 ? 1 : 0)
  })
  const writeDht = (cls: number, id: number, t: HuffTable): void => {
    w.word(0xffc4)
    w.word(19 + t.vals.length)
    w.byte((cls << 4) | id)
    for (let i = 1; i <= 16; i++) w.byte(t.bits[i])
    w.bytes(t.vals)
  }
  for (let t = 0; t < nTables; t++) {
    writeDht(0, t, dcT[t])
    writeDht(1, t, acT[t])
  }
  w.word(0xffda)
  w.word(6 + 2 * comps.length)
  w.byte(comps.length)
  comps.forEach((c, i) => {
    w.byte(i + 1)
    w.byte((c.table << 4) | c.table)
  })
  w.bytes([0, 63, 0])
  walk((c, kind, sym, extra, extraLen) => {
    const t = kind === 'dc' ? dcT[c.table] : acT[c.table]
    w.bits(t.code[sym], t.size[sym])
    if (extraLen) w.bits(extra, extraLen)
  })
  w.flushBits()
  w.word(0xffd9)
  return w.result()
}
