// Fixtures for the markup (comments) tests: node tests/fixtures/markup.mjs <outDir>
//   markup.pdf          3 pages with real text: portrait, /Rotate 90, plain
//   markup-foreign.pdf  1 page with annotations written the way other software does (own appearance streams)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib'

const out = resolve(process.argv[2] ?? 'tests/fixtures/out')
mkdirSync(out, { recursive: true })

export const LINES = [
  { y: 700, text: 'Epdf markup fixture line one' },
  { y: 660, text: 'Second line for underline' },
  { y: 620, text: 'Third line for strikethrough' },
  { y: 580, text: 'Fourth line squiggly text' },
  { y: 540, text: 'Fifth line for a sticky note' }
]

async function markup() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([612, 792])
  for (const l of LINES) p1.drawText(l.text, { x: 72, y: l.y, size: 20, font, color: rgb(0, 0, 0) })
  const p2 = doc.addPage([612, 792])
  p2.setRotation(degrees(90))
  p2.drawText('Rotated page first line', { x: 72, y: 700, size: 20, font })
  p2.drawText('Rotated page second line', { x: 72, y: 660, size: 20, font })
  const p3 = doc.addPage([612, 792])
  p3.drawText('Third page', { x: 72, y: 700, size: 20, font })
  doc.setTitle('Epdf markup fixture')
  writeFileSync(join(out, 'markup.pdf'), await doc.save())
}

async function foreign() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.drawText('Text under an orange highlight', { x: 72, y: 700, size: 20, font })
  page.drawText('Second line of foreign fixture', { x: 72, y: 660, size: 20, font })
  const ctx = doc.context
  const form = (bbox, ops, res = {}) => ctx.register(ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: bbox, Resources: ctx.obj(res) }))
  const refs = []
  const add = (dict) => {
    const ref = ctx.register(ctx.obj(dict))
    refs.push(ref)
    return ref
  }
  const date = PDFString.of("D:20240102030405+00'00'")
  const common = (author, contents) => ({ Type: 'Annot', F: 4, T: PDFString.of(author), Contents: PDFString.of(contents), M: date, CreationDate: date })

  add({
    ...common('Alice', 'Alice highlight'),
    Subtype: 'Highlight',
    Rect: [72, 696, 340, 720],
    QuadPoints: [72, 720, 340, 720, 72, 696, 340, 696],
    C: [1, 0.6, 0],
    AP: { N: form([72, 696, 340, 720], '/G gs 1 0.6 0 rg 72 696 268 24 re f', { ExtGState: { G: { Type: 'ExtGState', BM: 'Multiply' } } }) }
  })
  add({
    ...common('Alice', 'cloud box'),
    Subtype: 'Square',
    Rect: [72, 400, 200, 480],
    C: [0, 0, 1],
    BE: { S: 'C', I: 1 },
    AP: { N: form([72, 400, 200, 480], '0 0 1 RG 2 w 73 401 126 78 re S') }
  })
  add({
    ...common('Carol', 'Draft stamp'),
    Subtype: 'Stamp',
    Name: 'Draft',
    Rect: [300, 400, 420, 450],
    AP: { N: form([0, 0, 120, 50], '0.8 0 0 rg 0 0 120 50 re f 1 g 10 10 100 30 re f') }
  })
  const note = add({
    ...common('Alice', 'Question from Alice'),
    Subtype: 'Text',
    Name: 'Comment',
    Rect: [450, 650, 474, 674],
    Open: false,
    C: [1, 0.85, 0],
    AP: { N: form([0, 0, 24, 24], '1 0.85 0 rg 0 0 24 24 re f 0 g 2 w 2 2 20 20 re S') }
  })
  add({
    ...common('Bob', 'Bob answers'),
    Subtype: 'Text',
    Name: 'Comment',
    Rect: [450, 650, 474, 674],
    IRT: note,
    RT: PDFName.of('R'),
    F: 28
  })
  add({
    ...common('Alice', 'Note in blue'),
    Subtype: 'FreeText',
    Rect: [72, 300, 250, 340],
    DA: PDFString.of('0 0 1 rg /Helv 12 Tf'),
    C: [0.9, 0.95, 1],
    AP: { N: form([0, 0, 178, 40], '0.9 0.95 1 rg 0 0 178 40 re f 0 0 1 RG 0.5 0.5 177 39 re S') }
  })
  add({ Type: 'Annot', Subtype: 'Link', Rect: [72, 100, 200, 120], Border: [0, 0, 0] })
  page.node.set(PDFName.of('Annots'), ctx.obj(refs))
  doc.setTitle('Epdf markup foreign fixture')
  writeFileSync(join(out, 'markup-foreign.pdf'), await doc.save())
}

await markup()
await foreign()
void PDFArray
console.log('markup fixtures written to', out)
