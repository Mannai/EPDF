// Fixtures for the edit-content e2e tests: node tests/fixtures/edit-content.mjs <outDir>
import fontkit from '@pdf-lib/fontkit'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const out = resolve(process.argv[2] ?? 'tests/fixtures/out')
mkdirSync(out, { recursive: true })

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A valid solid-colour RGB PNG built by hand (also exported to the specs through files). */
export function makePng(w, h, color) {
  const chunk = (type, data) => {
    const o = new Uint8Array(12 + data.length)
    const dv = new DataView(o.buffer)
    dv.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i)
    o.set(data, 8)
    dv.setUint32(8 + data.length, crc32(o.subarray(4, 8 + data.length)))
    return o
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = new Uint8Array((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(color, y * (w * 3 + 1) + 1 + x * 3)
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const res = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    res.set(p, o)
    o += p.length
  }
  return res
}

async function text() {
  const doc = await PDFDocument.create()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const times = await doc.embedFont(StandardFonts.TimesRomanItalic)
  const p1 = doc.addPage([612, 792])
  p1.drawText('Quarterly Report', { x: 72, y: 700, size: 28, font: bold })
  p1.drawText('The revenue grew by twelve percent this quarter.', { x: 72, y: 650, size: 12, font: helv })
  p1.drawText('Costs stayed flat compared with the last quarter.', { x: 72, y: 634, size: 12, font: helv })
  p1.drawText('Outlook for the next quarter remains positive.', { x: 72, y: 618, size: 12, font: helv })
  p1.drawText('Total: 1234', { x: 72, y: 560, size: 14, font: helv, color: rgb(0.8, 0, 0) })
  p1.drawText('Signed by Alice', { x: 72, y: 500, size: 16, font: times })
  const p2 = doc.addPage([612, 792])
  p2.drawText('Second page stays untouched', { x: 72, y: 700, size: 18, font: helv })
  doc.setTitle('Edit content sample')
  writeFileSync(join(out, 'ec-text.pdf'), await doc.save())
}

async function embedded() {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(readFileSync(resolve('src/renderer/src/features/textedit/fonts/NotoSans-Regular.ttf')), { subset: true })
  const p = doc.addPage([612, 792])
  p.drawText('Embedded font sample', { x: 72, y: 700, size: 24, font })
  p.drawText('Another embedded line', { x: 72, y: 650, size: 16, font })
  writeFileSync(join(out, 'ec-embedded.pdf'), await doc.save())
}

async function scan() {
  const doc = await PDFDocument.create()
  const img = await doc.embedPng(makePng(60, 80, [225, 225, 210]))
  const p = doc.addPage([612, 792])
  p.drawImage(img, { x: 0, y: 0, width: 612, height: 792 })
  writeFileSync(join(out, 'ec-scan.pdf'), await doc.save())
}

async function images() {
  const doc = await PDFDocument.create()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const red = await doc.embedPng(makePng(40, 20, [220, 30, 30]))
  const green = await doc.embedPng(makePng(30, 30, [30, 160, 60]))
  const p1 = doc.addPage([612, 792])
  p1.drawText('Image page', { x: 72, y: 740, size: 18, font: helv })
  p1.drawImage(red, { x: 72, y: 600, width: 200, height: 100 })
  p1.drawImage(green, { x: 320, y: 300, width: 100, height: 100 })
  const p2 = doc.addPage([612, 792])
  p2.drawText('Page two', { x: 72, y: 740, size: 18, font: helv })
  writeFileSync(join(out, 'ec-images.pdf'), await doc.save())
  writeFileSync(join(out, 'ec-picture.png'), makePng(50, 25, [20, 60, 220]))
  writeFileSync(join(out, 'ec-not-an-image.png'), 'this is not a png')
}

await text()
await embedded()
await scan()
await images()
console.log('edit-content fixtures written to', out)
