/**
 * Pure-TypeScript JPEG decoder (baseline, extended-sequential and progressive Huffman; 8-bit; 1, 3 or 4 components).
 *
 * The browser's decoder is used for ordinary colour JPEGs (faster), but it cannot give raw CMYK samples and it is not
 * available in Node, so this decoder is the fallback for CMYK/gray and the reference used by unit tests. It returns the
 * component values as stored in the file, apart from the standard colour transforms: YCbCr becomes RGB (unless the
 * Adobe marker says "no transform") and YCCK becomes CMYK with the Adobe inversion left in place (the PDF /Decode
 * array, not the codec, is responsible for that).
 */

import { parseJpegInfo } from './jpegInfo'

export interface DecodedJpeg {
  width: number
  height: number
  ncomp: number
  /** Interleaved 8-bit samples. */
  data: Uint8Array
}

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
])

interface HTable {
  maxcode: Int32Array // index 1..17
  valptr: Int32Array
  mincode: Int32Array
  vals: Uint8Array
}

function makeTable(bits: number[], vals: Uint8Array): HTable {
  const maxcode = new Int32Array(18).fill(-1)
  const valptr = new Int32Array(17)
  const mincode = new Int32Array(17)
  let code = 0
  let k = 0
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k
    mincode[l] = code
    code += bits[l]
    k += bits[l]
    maxcode[l] = bits[l] ? code - 1 : -1
    code <<= 1
  }
  maxcode[17] = 0x7fffffff
  return { maxcode, valptr, mincode, vals }
}

interface Frame {
  width: number
  height: number
  progressive: boolean
  comps: {
    id: number
    h: number
    v: number
    tq: number
    blocksPerLine: number
    blocksPerCol: number
    /** Blocks that actually cover the image (non-interleaved scans stop there). */
    bw: number
    bh: number
    coefs: Int16Array
    pred: number
  }[]
  hmax: number
  vmax: number
  mcusX: number
  mcusY: number
}

class Reader {
  pos: number
  private bitBuf = 0
  private bitCnt = 0
  marker = 0
  constructor(readonly d: Uint8Array, start: number) {
    this.pos = start
  }
  reset(): void {
    this.bitBuf = 0
    this.bitCnt = 0
  }
  bit(): number {
    if (this.bitCnt === 0) {
      if (this.marker) {
        this.bitBuf = 0
      } else {
        let b = this.pos < this.d.length ? this.d[this.pos++] : 0
        if (b === 0xff) {
          const n = this.pos < this.d.length ? this.d[this.pos] : 0xd9
          if (n === 0) this.pos++
          else {
            this.marker = n
            this.pos--
            b = 0
          }
        }
        this.bitBuf = b
      }
      this.bitCnt = 8
    }
    this.bitCnt--
    return (this.bitBuf >> this.bitCnt) & 1
  }
  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit()
    return v
  }
  receiveExtend(n: number): number {
    if (n === 0) return 0
    const v = this.bits(n)
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v
  }
  huff(t: HTable): number {
    let code = 0
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | this.bit()
      if (t.maxcode[l] >= 0 && code <= t.maxcode[l]) return t.vals[t.valptr[l] + code - t.mincode[l]]
    }
    throw new Error('Corrupt JPEG (bad Huffman code)')
  }
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)

// Separable inverse DCT using a precomputed cosine matrix.
const COS = new Float32Array(64)
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16)

function idct(coef: Float32Array, out: Float32Array): void {
  const tmp = new Float32Array(64)
  // columns then rows: tmp[y][u] = sum_v coef[v][u] * COS[y][v]
  for (let u = 0; u < 8; u++) {
    for (let y = 0; y < 8; y++) {
      let s = 0
      for (let v = 0; v < 8; v++) {
        const c = coef[v * 8 + u]
        if (c !== 0) s += c * COS[y * 8 + v]
      }
      tmp[y * 8 + u] = s
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0
      for (let u = 0; u < 8; u++) s += tmp[y * 8 + u] * COS[x * 8 + u]
      out[y * 8 + x] = s
    }
  }
}

export function decodeJpeg(data: Uint8Array): DecodedJpeg {
  const info = parseJpegInfo(data)
  if (!info) throw new Error('Not a JPEG image')
  if (info.unsupported || info.precision !== 8) throw new Error('Unsupported JPEG variant')
  if (info.ncomp !== 1 && info.ncomp !== 3 && info.ncomp !== 4) throw new Error('Unsupported JPEG component count')

  const qts: Int32Array[] = []
  const dc: HTable[] = []
  const ac: HTable[] = []
  let frame: Frame | null = null
  let restart = 0
  let pos = 2
  let anyScan = false

  const startFrame = (seg: number): void => {
    const height = (data[seg + 1] << 8) | data[seg + 2]
    const width = (data[seg + 3] << 8) | data[seg + 4]
    const n = data[seg + 5]
    const comps = []
    let hmax = 1
    let vmax = 1
    for (let i = 0; i < n; i++) {
      const o = seg + 6 + i * 3
      const h = data[o + 1] >> 4
      const v = data[o + 1] & 15
      if (!h || !v || h > 4 || v > 4) throw new Error('Corrupt JPEG (sampling)')
      hmax = Math.max(hmax, h)
      vmax = Math.max(vmax, v)
      comps.push({ id: data[o], h, v, tq: data[o + 2], blocksPerLine: 0, blocksPerCol: 0, bw: 0, bh: 0, coefs: new Int16Array(0), pred: 0 })
    }
    const mcusX = Math.ceil(width / (8 * hmax))
    const mcusY = Math.ceil(height / (8 * vmax))
    for (const c of comps) {
      c.blocksPerLine = mcusX * c.h
      c.blocksPerCol = mcusY * c.v
      c.bw = Math.ceil((Math.ceil((width * c.h) / hmax)) / 8)
      c.bh = Math.ceil((Math.ceil((height * c.v) / vmax)) / 8)
      c.coefs = new Int16Array(c.blocksPerLine * c.blocksPerCol * 64)
    }
    frame = { width, height, progressive: info.progressive, comps, hmax, vmax, mcusX, mcusY }
  }

  while (pos + 2 <= data.length) {
    if (data[pos] !== 0xff) {
      pos++
      continue
    }
    const m = data[pos + 1]
    if (m === 0xff) {
      pos++
      continue
    }
    if (m === 0xd8 || m === 0x01 || m === 0 || (m >= 0xd0 && m <= 0xd7)) {
      pos += 2
      continue
    }
    if (m === 0xd9) break
    const len = (data[pos + 2] << 8) | data[pos + 3]
    const seg = pos + 4
    const end = pos + 2 + len
    if (m === 0xdb) {
      let p = seg
      while (p < end) {
        const pq = data[p] >> 4
        const tq = data[p] & 15
        p++
        const t = new Int32Array(64)
        for (let i = 0; i < 64; i++) {
          if (pq) {
            t[ZIGZAG[i]] = (data[p] << 8) | data[p + 1]
            p += 2
          } else t[ZIGZAG[i]] = data[p++]
        }
        qts[tq] = t
      }
    } else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      startFrame(seg)
    } else if (m === 0xc4) {
      let p = seg
      while (p < end) {
        const tc = data[p] >> 4
        const th = data[p] & 15
        p++
        const bits = [0]
        let total = 0
        for (let i = 1; i <= 16; i++) {
          bits[i] = data[p++]
          total += bits[i]
        }
        const vals = data.slice(p, p + total)
        p += total
        ;(tc === 0 ? dc : ac)[th] = makeTable(bits, vals)
      }
    } else if (m === 0xdd) {
      restart = (data[seg] << 8) | data[seg + 1]
    } else if (m === 0xda) {
      if (!frame) throw new Error('Corrupt JPEG (scan before frame)')
      const ns = data[seg]
      const sc: { c: Frame['comps'][number]; td: number; ta: number }[] = []
      for (let i = 0; i < ns; i++) {
        const id = data[seg + 1 + i * 2]
        const c = (frame as Frame).comps.find((x) => x.id === id) ?? (frame as Frame).comps[i]
        sc.push({ c, td: data[seg + 2 + i * 2] >> 4, ta: data[seg + 2 + i * 2] & 15 })
      }
      const ss = data[seg + 1 + ns * 2]
      const se = data[seg + 2 + ns * 2]
      const ah = data[seg + 3 + ns * 2] >> 4
      const al = data[seg + 3 + ns * 2] & 15
      pos = decodeScan(data, end, frame, sc, ss, se, ah, al, restart, dc, ac)
      anyScan = true
      continue
    }
    pos = end
  }
  if (!frame || !anyScan) throw new Error('Corrupt JPEG (no image data)')
  const fr = frame as Frame

  // Dequantise + IDCT into component planes.
  const planes = fr.comps.map((c) => {
    const pw = c.blocksPerLine * 8
    const ph = c.blocksPerCol * 8
    const plane = new Uint8Array(pw * ph)
    const q = qts[c.tq]
    if (!q) throw new Error('Corrupt JPEG (missing quantisation table)')
    const coef = new Float32Array(64)
    const out = new Float32Array(64)
    for (let by = 0; by < c.blocksPerCol; by++) {
      for (let bx = 0; bx < c.blocksPerLine; bx++) {
        const o = (by * c.blocksPerLine + bx) * 64
        for (let k = 0; k < 64; k++) coef[ZIGZAG[k]] = c.coefs[o + k] * q[ZIGZAG[k]]
        idct(coef, out)
        const base = by * 8 * pw + bx * 8
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[base + y * pw + x] = clamp(Math.round(out[y * 8 + x] + 128))
      }
    }
    return { plane, pw }
  })

  const { width, height } = fr
  const n = fr.comps.length
  const outData = new Uint8Array(width * height * n)
  for (let c = 0; c < n; c++) {
    const comp = fr.comps[c]
    const { plane, pw } = planes[c]
    const sx = comp.h / fr.hmax
    const sy = comp.v / fr.vmax
    for (let y = 0; y < height; y++) {
      const py = Math.min(Math.floor(y * sy), comp.blocksPerCol * 8 - 1)
      for (let x = 0; x < width; x++) outData[(y * width + x) * n + c] = plane[py * pw + Math.min(Math.floor(x * sx), pw - 1)]
    }
  }

  const ids = fr.comps.map((c) => c.id)
  if (n === 3) {
    const rgbIds = ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42
    const ycc = info.adobeTransform !== null ? info.adobeTransform !== 0 : !rgbIds
    if (ycc) {
      for (let i = 0; i < outData.length; i += 3) {
        const Y = outData[i]
        const cb = outData[i + 1] - 128
        const cr = outData[i + 2] - 128
        outData[i] = clamp(Math.round(Y + 1.402 * cr))
        outData[i + 1] = clamp(Math.round(Y - 0.344136 * cb - 0.714136 * cr))
        outData[i + 2] = clamp(Math.round(Y + 1.772 * cb))
      }
    }
  } else if (n === 4 && info.adobeTransform === 2) {
    for (let i = 0; i < outData.length; i += 4) {
      const Y = outData[i]
      const cb = outData[i + 1] - 128
      const cr = outData[i + 2] - 128
      outData[i] = 255 - clamp(Math.round(Y + 1.402 * cr))
      outData[i + 1] = 255 - clamp(Math.round(Y - 0.344136 * cb - 0.714136 * cr))
      outData[i + 2] = 255 - clamp(Math.round(Y + 1.772 * cb))
    }
  }
  return { width, height, ncomp: n, data: outData }
}

function decodeScan(
  data: Uint8Array,
  start: number,
  fr: Frame,
  sc: { c: Frame['comps'][number]; td: number; ta: number }[],
  ss: number,
  se: number,
  ah: number,
  al: number,
  restart: number,
  dcT: HTable[],
  acT: HTable[]
): number {
  const r = new Reader(data, start)
  const progressive = fr.progressive
  let eobrun = 0
  for (const s of sc) s.c.pred = 0

  const decodeBlock = (s: (typeof sc)[number], blockIdx: number): void => {
    const co = s.c.coefs
    const o = blockIdx * 64
    if (!progressive) {
      const dct = dcT[s.td]
      const act = acT[s.ta]
      if (!dct || !act) throw new Error('Corrupt JPEG (missing Huffman table)')
      const t = r.huff(dct)
      s.c.pred += r.receiveExtend(t)
      co[o] = s.c.pred
      for (let k = 1; k < 64; ) {
        const rs = r.huff(act)
        const sz = rs & 15
        const run = rs >> 4
        if (sz === 0) {
          if (run < 15) break
          k += 16
          continue
        }
        k += run
        if (k > 63) break
        co[o + k] = r.receiveExtend(sz)
        k++
      }
      return
    }
    if (ss === 0) {
      // DC scan
      if (ah === 0) {
        const dct = dcT[s.td]
        if (!dct) throw new Error('Corrupt JPEG (missing Huffman table)')
        s.c.pred += r.receiveExtend(r.huff(dct))
        co[o] = s.c.pred * (1 << al)
      } else if (r.bit()) co[o] |= 1 << al
      return
    }
    const act = acT[s.ta]
    if (!act) throw new Error('Corrupt JPEG (missing Huffman table)')
    if (ah === 0) {
      if (eobrun > 0) {
        eobrun--
        return
      }
      for (let k = ss; k <= se; k++) {
        const rs = r.huff(act)
        const sz = rs & 15
        const run = rs >> 4
        if (sz) {
          k += run
          if (k > 63) break
          co[o + k] = r.receiveExtend(sz) * (1 << al)
        } else if (run === 15) k += 15
        else {
          eobrun = (1 << run) - 1
          if (run) eobrun += r.bits(run)
          break
        }
      }
      return
    }
    // AC refinement
    const p1 = 1 << al
    const m1 = -1 << al
    let k = ss
    if (eobrun <= 0) {
      for (; k <= se; k++) {
        const rs = r.huff(act)
        let sz = rs & 15
        let run = rs >> 4
        if (sz) sz = r.bit() ? p1 : m1
        else if (run !== 15) {
          eobrun = 1 << run
          if (run) eobrun += r.bits(run)
          break
        }
        do {
          const idx = o + k
          const cur = co[idx]
          if (cur !== 0) {
            if (r.bit() && (cur & p1) === 0) co[idx] = cur >= 0 ? cur + p1 : cur + m1
          } else if (--run < 0) break
          k++
        } while (k <= se)
        if (sz && k <= se) co[o + k] = sz
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) {
        const idx = o + k
        const cur = co[idx]
        if (cur !== 0 && r.bit() && (cur & p1) === 0) co[idx] = cur >= 0 ? cur + p1 : cur + m1
      }
      eobrun--
    }
  }

  // ss/se are zigzag indices; coefficient storage is zigzag ordered already.
  const single = sc.length === 1
  let total: number
  if (single) total = sc[0].c.bw * sc[0].c.bh
  else total = fr.mcusX * fr.mcusY
  let count = 0
  for (let m = 0; m < total; m++) {
    if (restart && count === restart) {
      // consume the restart marker
      r.reset()
      if (r.marker === 0) {
        // find next marker
        while (r.pos + 1 < data.length && !(data[r.pos] === 0xff && data[r.pos + 1] >= 0xd0 && data[r.pos + 1] <= 0xd7)) r.pos++
        r.pos += 2
      } else {
        r.pos += 2
        r.marker = 0
      }
      for (const s of sc) s.c.pred = 0
      eobrun = 0
      count = 0
    }
    if (single) {
      const c = sc[0].c
      const bx = m % c.bw
      const by = Math.floor(m / c.bw)
      decodeBlock(sc[0], by * c.blocksPerLine + bx)
    } else {
      const mx = m % fr.mcusX
      const my = Math.floor(m / fr.mcusX)
      for (const s of sc) {
        for (let v = 0; v < s.c.v; v++) for (let h = 0; h < s.c.h; h++) decodeBlock(s, (my * s.c.v + v) * s.c.blocksPerLine + mx * s.c.h + h)
      }
    }
    count++
    if (r.marker && r.marker !== 0 && !(r.marker >= 0xd0 && r.marker <= 0xd7) && m < total - 1) {
      // Premature end of data: keep what we have.
      break
    }
  }
  // Move to the next marker after the entropy-coded segment.
  let p = r.pos
  while (p + 1 < data.length && !(data[p] === 0xff && data[p + 1] !== 0 && !(data[p + 1] >= 0xd0 && data[p + 1] <= 0xd7))) p++
  return p
}
