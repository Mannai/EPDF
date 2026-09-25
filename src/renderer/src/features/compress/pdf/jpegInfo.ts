import { STD_LUMA_QT } from './jpegEncode'

/** Facts about a JPEG stream read from its headers (no pixel decoding). */
export interface JpegInfo {
  width: number
  height: number
  /** Number of colour components (1 gray, 3 colour, 4 CMYK/YCCK). */
  ncomp: number
  precision: number
  progressive: boolean
  /** True for arithmetic-coded or lossless/hierarchical variants we do not handle. */
  unsupported: boolean
  /** Adobe APP14 colour transform (0 none, 1 YCbCr, 2 YCCK) or null when the marker is absent. */
  adobeTransform: number | null
  jfif: boolean
  /** Component ids as written in the frame header. */
  componentIds: number[]
  /** First quantisation table in natural order (luminance), if present. */
  quant0: number[] | null
}

const ZIGZAG_INV = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
])

/** Reads the frame header, Adobe marker and first quantisation table. Returns null for anything that is not a JPEG. */
export function parseJpegInfo(b: Uint8Array): JpegInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  const info: JpegInfo = {
    width: 0,
    height: 0,
    ncomp: 0,
    precision: 8,
    progressive: false,
    unsupported: false,
    adobeTransform: null,
    jfif: false,
    componentIds: [],
    quant0: null
  }
  let pos = 2
  let sawFrame = false
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) {
      pos++
      continue
    }
    const m = b[pos + 1]
    if (m === 0xff) {
      pos++
      continue
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0) {
      pos += 2
      continue
    }
    if (m === 0xd9) break
    const len = (b[pos + 2] << 8) | b[pos + 3]
    if (len < 2) return null
    const seg = pos + 4
    const end = pos + 2 + len
    if (end > b.length) break
    if (m === 0xe0 && len >= 7 && b[seg] === 0x4a && b[seg + 1] === 0x46) info.jfif = true
    else if (m === 0xee && len >= 14 && b[seg] === 0x41 && b[seg + 1] === 0x64 && b[seg + 2] === 0x6f && b[seg + 3] === 0x62 && b[seg + 4] === 0x65) {
      info.adobeTransform = b[seg + 11]
    } else if (m === 0xdb) {
      let p = seg
      while (p < end) {
        const pq = b[p] >> 4
        const tq = b[p] & 15
        p++
        const q = new Array<number>(64)
        for (let i = 0; i < 64; i++) {
          if (pq) {
            q[ZIGZAG_INV[i]] = (b[p] << 8) | b[p + 1]
            p += 2
          } else q[ZIGZAG_INV[i]] = b[p++]
        }
        if (tq === 0 && !info.quant0) info.quant0 = q
      }
    } else if ((m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) && !sawFrame) {
      sawFrame = true
      info.precision = b[seg]
      info.height = (b[seg + 1] << 8) | b[seg + 2]
      info.width = (b[seg + 3] << 8) | b[seg + 4]
      info.ncomp = b[seg + 5]
      for (let i = 0; i < info.ncomp; i++) info.componentIds.push(b[seg + 6 + i * 3])
      info.progressive = m === 0xc2
      if (m !== 0xc0 && m !== 0xc1 && m !== 0xc2) info.unsupported = true
    } else if (m === 0xcc || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) info.unsupported = true
    else if (m === 0xda) {
      break // entropy-coded data follows; everything we need precedes it
    }
    pos = end
  }
  return sawFrame && info.width > 0 && info.height > 0 ? info : null
}

/**
 * Estimated IJG quality (1..100) that produced a quantisation table (natural order); ~100 for near-lossless tables.
 * Used to avoid re-encoding a JPEG that is already at or below the target quality.
 */
export function estimateJpegQuality(qt: readonly number[] | null): number {
  if (!qt || qt.length < 64) return 100
  let sum = 0
  for (let i = 0; i < 64; i++) sum += qt[i] / STD_LUMA_QT[i]
  const scale = (sum / 64) * 100
  const q = scale <= 100 ? (200 - scale) / 2 : 5000 / scale
  return Math.min(100, Math.max(1, Math.round(q)))
}
