import { zlibSync } from 'fflate'

/** Pixel formats PDF.js hands out (`ImageKind`). */
export const KIND_GRAY_1BPP = 1
export const KIND_RGB_24 = 2
export const KIND_RGBA_32 = 3

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Converts PDF.js pixel data of any supported kind to RGBA (8 bits per channel). */
export function toRgba(data: Uint8Array | Uint8ClampedArray, width: number, height: number, kind: number): Uint8Array {
  const n = width * height
  const out = new Uint8Array(n * 4)
  if (kind === KIND_RGBA_32) {
    out.set(data.subarray(0, n * 4))
  } else if (kind === KIND_RGB_24) {
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      out[i * 4] = data[j]
      out[i * 4 + 1] = data[j + 1]
      out[i * 4 + 2] = data[j + 2]
      out[i * 4 + 3] = 255
    }
  } else if (kind === KIND_GRAY_1BPP) {
    const rowBytes = (width + 7) >> 3
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const v = bit ? 255 : 0
        const o = (y * width + x) * 4
        out[o] = out[o + 1] = out[o + 2] = v
        out[o + 3] = 255
      }
    }
  } else {
    throw new Error(`Unsupported image pixel format ${kind}`)
  }
  return out
}

/** Encodes RGBA pixels as a PNG file (RGB colour type when fully opaque, RGBA otherwise). */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  let opaque = true
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false
      break
    }
  }
  const bpp = opaque ? 3 : 4
  const raw = new Uint8Array((width * bpp + 1) * height)
  for (let y = 0; y < height; y++) {
    const ro = y * (width * bpp + 1)
    raw[ro] = 0
    if (opaque) {
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4
        const d = ro + 1 + x * 3
        raw[d] = rgba[s]
        raw[d + 1] = rgba[s + 1]
        raw[d + 2] = rgba[s + 2]
      }
    } else {
      raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), ro + 1)
    }
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = opaque ? 2 : 6
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0))
  ]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
