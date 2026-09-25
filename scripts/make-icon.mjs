// Generates the placeholder app icon (build/icon.png, 1024x1024): a plain page glyph on a blue tile.
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
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0)
ihdr.writeUInt32BE(N, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc((N * 4 + 1) * N)
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0 // filter: none
  px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4)
}
mkdirSync('build', { recursive: true })
writeFileSync(
  'build/icon.png',
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
)
console.log('wrote build/icon.png')
