// Generates deterministic PDF fixtures for the tests: node tests/fixtures/generate.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib'

const out = resolve(process.argv[2] ?? 'tests/fixtures/out')
mkdirSync(out, { recursive: true })

async function sample() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = []
  for (let i = 1; i <= 5; i++) {
    const p = doc.addPage([612, 792])
    pages.push(p)
    p.drawText(`Epdf sample page ${i}`, { x: 72, y: 700, size: 28, font, color: rgb(0, 0, 0) })
    p.drawText('The quick brown fox jumps over the lazy dog.', { x: 72, y: 640, size: 14, font })
  }
  // "needle" appears twice on page 3 and once on page 5 (3 hits total).
  pages[2].drawText('First needle here and a second needle there.', { x: 72, y: 580, size: 14, font })
  pages[4].drawText('The last needle is on page five.', { x: 72, y: 580, size: 14, font })
  // A link on page 1 that jumps to page 4.
  pages[0].drawText('Jump to page four', { x: 72, y: 500, size: 14, font, color: rgb(0, 0, 1) })
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [72, 495, 200, 515],
      Border: [0, 0, 0],
      Dest: [pages[3].ref, PDFName.of('Fit')]
    })
  )
  pages[0].node.set(PDFName.of('Annots'), doc.context.obj([link]))
  doc.setTitle('Epdf sample')
  writeFileSync(join(out, 'sample.pdf'), await doc.save())
}

async function large(n) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= n; i++) {
    const p = doc.addPage([612, 792])
    p.drawText(`Large document page ${i}`, { x: 72, y: 700, size: 24, font })
  }
  writeFileSync(join(out, 'large.pdf'), await doc.save())
}

async function mixed() {
  // Portrait, landscape and a small page, to exercise variable page sizes.
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const [w, h] of [[612, 792], [792, 612], [300, 400], [612, 792]]) {
    const p = doc.addPage([w, h])
    p.drawText(`${w}x${h}`, { x: 40, y: h - 60, size: 24, font })
  }
  writeFileSync(join(out, 'mixed.pdf'), await doc.save())
}

await sample()
await large(500)
await mixed()
writeFileSync(join(out, 'not-a-pdf.pdf'), 'this is definitely not a PDF file')
console.log('fixtures written to', out)
