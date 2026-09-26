// Fixtures for tests/e2e/headerfooter.spec.ts: node tests/fixtures/headerfooter.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'

const out = resolve(process.argv[2] ?? 'test-results/fixtures')
mkdirSync(out, { recursive: true })

async function basic() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([612, 792])
    p.drawText(`Body of page ${i}`, { x: 72, y: 400, size: 16, font })
  }
  writeFileSync(join(out, 'hf-basic.pdf'), await doc.save())
}

async function geometry() {
  // page 1: plain; page 2: /Rotate 90; page 3: MediaBox and CropBox offsets (the visible page starts at 100,100).
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([612, 792])
  p1.drawText('Upright page', { x: 72, y: 400, size: 16, font })
  const p2 = doc.addPage([612, 792])
  // (placed so that, turned by /Rotate, it stays in the middle of the page and out of the header/footer bands)
  p2.drawText('Rotated page', { x: 300, y: 300, size: 16, font })
  p2.setRotation(degrees(90))
  const p3 = doc.addPage([700, 900])
  p3.setMediaBox(-50, -50, 700, 900)
  p3.setCropBox(100, 100, 400, 500)
  p3.drawText('Cropped page', { x: 150, y: 300, size: 16, font })
  writeFileSync(join(out, 'hf-geometry.pdf'), await doc.save())
}

async function overlap() {
  // An opaque gray block in the middle of the page: a watermark behind the content is hidden by it, one in front is not.
  const doc = await PDFDocument.create()
  const p = doc.addPage([612, 792])
  p.drawRectangle({ x: 106, y: 246, width: 400, height: 300, color: rgb(0.5, 0.5, 0.5) })
  writeFileSync(join(out, 'hf-overlap.pdf'), await doc.save())
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc(b) {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
/** A solid blue 200 x 100 RGBA PNG. */
function logo() {
  const w = 200
  const h = 100
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 4
      raw[o] = 0
      raw[o + 1] = 60
      raw[o + 2] = 230
      raw[o + 3] = 255
    }
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  writeFileSync(join(out, 'hf-logo.png'), png)
  writeFileSync(join(out, 'hf-not-a-picture.png'), 'this is not a picture')
}

await basic()
await geometry()
await overlap()
logo()
console.log('headerfooter fixtures written to', out)
