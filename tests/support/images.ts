import { deflateSync } from 'node:zlib'

/** Tiny image encoders for tests, so fixtures are generated instead of committed as binaries. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const be32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** `rgba(x, y)` returns [r,g,b,a] for each pixel. */
export type PixelFn = (x: number, y: number) => [number, number, number, number]

export const solid = (r: number, g: number, b: number, a = 255): PixelFn => () => [r, g, b, a]

export function makePng(w: number, h: number, px: PixelFn, opts: { ppm?: number } = {}): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 4 + 1) + 1 + x * 4)
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const t = new Uint8Array([...type].map((c) => c.charCodeAt(0)))
    return concat(be32(data.length), t, data, be32(crc32(concat(t, data))))
  }
  const ihdr = concat(be32(w), be32(h), new Uint8Array([8, 6, 0, 0, 0]))
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]
  if (opts.ppm) parts.push(chunk('pHYs', concat(be32(opts.ppm), be32(opts.ppm), new Uint8Array([1]))))
  parts.push(chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0)))
  return concat(...parts)
}

/**
 * A structurally valid JPEG header set (SOI, optional EXIF orientation / JFIF density, SOF0 with the requested
 * size) followed by minimal tables. It is enough for size/orientation logic and for pdf-lib to embed it; it is
 * NOT decodable by a viewer. Use a real JPEG (e.g. from Electron's nativeImage) when rendering matters.
 */
export function makeFakeJpeg(width: number, height: number, opts: { orientation?: number; dpi?: number } = {}): Uint8Array {
  const parts: number[][] = [[0xff, 0xd8]]
  if (opts.orientation) {
    const t = [
      0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, // big-endian TIFF header, IFD at 8
      0, 1, // one entry
      0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, opts.orientation, 0, 0, // Orientation (SHORT)
      0, 0, 0, 0 // next IFD
    ]
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t]
    parts.push([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body])
  }
  if (opts.dpi) {
    parts.push([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, opts.dpi >> 8, opts.dpi & 255, opts.dpi >> 8, opts.dpi & 255, 0, 0])
  }
  // SOF0: 8-bit, 3 components
  parts.push([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
  parts.push([0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0x00, 0xff, 0xd9])
  return new Uint8Array(parts.flat())
}

/** Inserts an EXIF APP1 segment with the given orientation right after the SOI marker of a real JPEG. */
export function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]
  const seg = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]
  const out = new Uint8Array(jpeg.length + seg.length)
  out.set(jpeg.subarray(0, 2), 0)
  out.set(seg, 2)
  out.set(jpeg.subarray(2), 2 + seg.length)
  return out
}

export interface TiffFrame {
  w: number
  h: number
  px: PixelFn
  orientation?: number
  /** Include an alpha channel (unassociated). */
  alpha?: boolean
}

/** Uncompressed little-endian TIFF with one IFD per frame (RGB or RGBA, 8 bits, single strip). */
export function makeTiff(frames: TiffFrame[]): Uint8Array {
  const out: number[] = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]
  const u16 = (n: number): number[] => [n & 255, (n >> 8) & 255]
  const u32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
  let ifdPos = 8
  frames.forEach((f, idx) => {
    const spp = f.alpha ? 4 : 3
    const pixels: number[] = []
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const p = f.px(x, y)
      pixels.push(p[0], p[1], p[2])
      if (f.alpha) pixels.push(p[3])
    }
    const entries: [number, number, number, number[]][] = []
    const nEntries = 12 + (f.orientation ? 1 : 0) + (f.alpha ? 1 : 0)
    const ifdSize = 2 + nEntries * 12 + 4
    const bpsOff = ifdPos + ifdSize
    const resOff = bpsOff + spp * 2
    const dataOff = resOff + 16
    const add = (tag: number, type: number, count: number, value: number[]): void => void entries.push([tag, type, count, value])
    add(256, 3, 1, u16(f.w).concat([0, 0]))
    add(257, 3, 1, u16(f.h).concat([0, 0]))
    add(258, 3, spp, u32(bpsOff))
    add(259, 3, 1, u16(1).concat([0, 0]))
    add(262, 3, 1, u16(2).concat([0, 0]))
    add(273, 4, 1, u32(dataOff))
    if (f.orientation) add(274, 3, 1, u16(f.orientation).concat([0, 0]))
    add(277, 3, 1, u16(spp).concat([0, 0]))
    add(278, 3, 1, u16(f.h).concat([0, 0]))
    add(279, 4, 1, u32(pixels.length))
    add(282, 5, 1, u32(resOff))
    add(283, 5, 1, u32(resOff + 8))
    add(296, 3, 1, u16(2).concat([0, 0]))
    if (f.alpha) add(338, 3, 1, u16(2).concat([0, 0]))
    entries.sort((a, b) => a[0] - b[0])
    const next = idx === frames.length - 1 ? 0 : dataOff + pixels.length + ((dataOff + pixels.length) & 1)
    out.push(...u16(entries.length))
    for (const [tag, type, count, value] of entries) out.push(...u16(tag), ...u16(type), ...u32(count), ...value)
    out.push(...u32(next))
    for (let i = 0; i < spp; i++) out.push(...u16(8))
    out.push(...u32(72), ...u32(1), ...u32(72), ...u32(1))
    out.push(...pixels)
    if (out.length & 1) out.push(0)
    ifdPos = out.length
  })
  return new Uint8Array(out)
}
