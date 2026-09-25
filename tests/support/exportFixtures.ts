import { resolve } from 'node:path'
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { makePng } from './images'

/** PDFs and a PDF.js (legacy build) loader for the export tests. */

export async function openWithPdfjs(bytes: Uint8Array): Promise<{ doc: never; OPS: Record<string, number> }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const standardFontDataUrl = resolve('node_modules/pdfjs-dist/standard_fonts') + '/'
  const doc = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl, useSystemFonts: false }).promise
  return { doc: doc as never, OPS: pdfjs.OPS as unknown as Record<string, number> }
}

interface Fonts {
  regular: PDFFont
  bold: PDFFont
  italic: PDFFont
  mono: PDFFont
}

function drawTable(page: PDFPage, f: Fonts, x: number, top: number, colX: number[], rows: string[][], rulings: boolean): void {
  const rowH = 20
  rows.forEach((r, ri) => {
    r.forEach((t, ci) => page.drawText(t, { x: colX[ci] + 6, y: top - ri * rowH - 14, size: 11, font: ri === 0 ? f.bold : f.regular }))
  })
  if (!rulings) return
  const right = colX[colX.length - 1]
  for (let i = 0; i <= rows.length; i++) page.drawLine({ start: { x, y: top - i * rowH }, end: { x: right, y: top - i * rowH }, thickness: 1, color: rgb(0, 0, 0) })
  for (const cx of colX) page.drawLine({ start: { x: cx, y: top }, end: { x: cx, y: top - rows.length * rowH }, thickness: 1, color: rgb(0, 0, 0) })
}

export const TABLE_ROWS = [
  ['Item', 'Qty', 'Price'],
  ['Apples', '10', '$1.50'],
  ['Pears', '20', '$2.25'],
  ['Plums', '1,200', '$0.75']
]

/** Two pages: a rich portrait page and a landscape page with a borderless table. */
export async function makeRichPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const f: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    mono: await doc.embedFont(StandardFonts.Courier)
  }
  const p1 = doc.addPage([612, 792])
  p1.drawText('Quarterly Report', { x: 72, y: 720, size: 24, font: f.bold, color: rgb(1, 0, 0) })
  const para1 = ['This is the first paragraph of the report and it', 'continues onto a second line with more words to', 'finish the paragraph here.']
  para1.forEach((t, i) => p1.drawText(t, { x: 72, y: 690 - i * 14, size: 11, font: f.regular }))
  const para2 = ['Second paragraph starts after a clear gap in', 'vertical spacing.']
  para2.forEach((t, i) => p1.drawText(t, { x: 72, y: 630 - i * 14, size: 11, font: f.italic, color: rgb(0, 0.5, 0) }))
  p1.drawText('code_sample = 42', { x: 72, y: 585, size: 10, font: f.mono })
  p1.drawText('Visit Epdf', { x: 72, y: 555, size: 11, font: f.regular, color: rgb(0, 0, 1) })
  const link = doc.context.register(
    doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [70, 550, 130, 568], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com/epdf') } })
  )
  p1.node.set(PDFName.of('Annots'), doc.context.obj([link]))
  drawTable(p1, f, 72, 520, [72, 172, 272, 372], TABLE_ROWS, true)
  const png = await doc.embedPng(makePng(20, 10, (x, y) => [x * 12, y * 20, 128, 255]))
  p1.drawImage(png, { x: 72, y: 250, width: 100, height: 50 })

  const p2 = doc.addPage([792, 612])
  p2.drawText('Regional Sales', { x: 72, y: 540, size: 20, font: f.bold })
  p2.drawText('Numbers below are in thousands of units.', { x: 72, y: 505, size: 11, font: f.regular })
  const rows = [
    ['Region', 'Q1', 'Q2'],
    ['North', '1,200', '1,350'],
    ['South', '900', '950'],
    ['East', '1,100', '1,050']
  ]
  rows.forEach((r, ri) => r.forEach((t, ci) => p2.drawText(t, { x: [72, 250, 400][ci], y: 470 - ri * 18, size: 11, font: ri === 0 ? f.bold : f.regular })))
  doc.setTitle('Rich fixture')
  return doc.save()
}
