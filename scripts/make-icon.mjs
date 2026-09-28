// Generates the placeholder app icon (build/icon.png, 1024x1024): a plain page glyph on a blue tile, plus the
// Windows (build/icon.ico) and macOS (build/icon.icns) icon files made from it.
// Dependency-free PNG encoder. Replace build/icon.png with real artwork when branding exists.
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const N = 1024
const px = Buffer.alloc(N * N * 4)

const set = (x, y, [r, g, b, a]) => {
  const i = (y * N + x) * 4
  // "Over" compositing so shapes can be layered with anti-aliased coverage.
  const fa = a / 255
  const ba = px[i + 3] / 255
  const oa = fa + ba * (1 - fa)
  if (oa === 0) return
  px[i] = Math.round((r * fa + px[i] * ba * (1 - fa)) / oa)
  px[i + 1] = Math.round((g * fa + px[i + 1] * ba * (1 - fa)) / oa)
  px[i + 2] = Math.round((b * fa + px[i + 2] * ba * (1 - fa)) / oa)
  px[i + 3] = Math.round(oa * 255)
}

/** Fills pixels where `inside(x, y)` returns coverage 0..1. */
const fill = (color, inside) => {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = inside(x + 0.5, y + 0.5)
    if (c > 0) set(x, y, [color[0], color[1], color[2], Math.round(color[3] * c)])
  }
}
const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r))
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r))
  if (x < x0 || x > x1 || y < y0 || y > y1) return 0
  return Math.min(1, Math.max(0, r - Math.hypot(dx, dy) + 0.5))
}

fill([36, 87, 214, 255], roundRect(0, 0, N, N, 200)) // tile
// Page with a folded top-right corner.
const fold = 170
fill([255, 255, 255, 255], (x, y) => {
  const inPage = roundRect(268, 170, 756, 854, 36)(x, y)
  const cut = x > 756 - fold && y < 170 + fold && x - (756 - fold) > y - 170 ? 1 : 0
  return cut ? 0 : inPage
})
fill([190, 205, 240, 255], (x, y) => (x > 756 - fold && y < 170 + fold && x - (756 - fold) <= y - 170 && x <= 756 && y >= 170 ? 1 : 0))
// Text lines.
for (const [y, w] of [[420, 360], [500, 360], [580, 360], [660, 240]]) fill([36, 87, 214, 255], roundRect(332, y, 332 + w, y + 36, 18))

// PNG encode.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** Encodes `size`x`size` RGBA pixels as a PNG. */
const encodePng = (pixels, size) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Box-filter downscale by an integer factor (N is a power of two, so every ICO size divides it). */
const downscale = (size) => {
  const f = N / size
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const i = ((y * f + dy) * N + x * f + dx) * 4
      const w = px[i + 3] // weight colour by alpha so transparent corners do not darken the edge
      r += px[i] * w; g += px[i + 1] * w; b += px[i + 2] * w; a += w
    }
    const o = (y * size + x) * 4
    if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a) }
    out[o + 3] = Math.round(a / (f * f))
  }
  return out
}

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', encodePng(px, N))
console.log('wrote build/icon.png')

// Windows icon: PNG-compressed entries (supported since Vista) at the sizes Explorer, the taskbar and the installer use.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map((s) => encodePng(downscale(s), s))
const header = Buffer.alloc(6)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(sizes.length, 4)
let offset = 6 + 16 * sizes.length
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16)
  e[0] = s === 256 ? 0 : s // 0 means 256
  e[1] = s === 256 ? 0 : s
  e.writeUInt16LE(1, 4) // colour planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(images[i].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += images[i].length
  return e
})
writeFileSync('build/icon.ico', Buffer.concat([header, ...dir, ...images]))
console.log('wrote build/icon.ico')

// macOS icon (app, Dock, Finder and the PDF document icon): PNG entries in the types iconutil writes for a full
// iconset, 16 to 512 pt at 1x and 2x.
const icnsTypes = [['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]]
const pngOf = new Map()
const entries = icnsTypes.map(([type, size]) => {
  if (!pngOf.has(size)) pngOf.set(size, size === N ? encodePng(px, N) : encodePng(downscale(size), size))
  const data = pngOf.get(size)
  const head = Buffer.alloc(8)
  head.write(type, 0, 'latin1')
  head.writeUInt32BE(8 + data.length, 4)
  return Buffer.concat([head, data])
})
const icnsHead = Buffer.alloc(8)
icnsHead.write('icns', 0, 'latin1')
icnsHead.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4)
writeFileSync('build/icon.icns', Buffer.concat([icnsHead, ...entries]))
console.log('wrote build/icon.icns')
