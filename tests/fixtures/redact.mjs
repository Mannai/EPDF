// Fixtures for the redaction tests. Also usable as a script: node tests/fixtures/redact.mjs <outDir>
import fontkit from '@pdf-lib/fontkit'
import jpeg from 'jpeg-js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib'

export const SECRET = 'TOPSECRET-4711'

const N = (s) => PDFName.of(s)
const latin1 = (s) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff))

// ---- a 5x7 bitmap font for the characters of SECRET (so the raster images really "contain" the text) -------------
const GLYPHS = {
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.']
}

export const RASTER = { width: 200, height: 40, bg: [240, 240, 200], ink: [200, 0, 0] }

/** RGB pixels (width*height*3) with SECRET drawn 2x with the bitmap font. */
export function rasterPixels(text = SECRET) {
  const { width, height, bg, ink } = RASTER
  const px = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) px.set(bg, i * 3)
  let x0 = 8
  for (const ch of text) {
    const g = GLYPHS[ch]
    if (g) {
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (g[gy][gx] !== '#') continue
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px.set(ink, ((12 + gy * 2 + dy) * width + x0 + gx * 2 + dx) * 3)
        }
      }
    }
    x0 += 12
  }
  return px
}

export function rasterJpeg(text = SECRET, quality = 90) {
  const { width, height } = RASTER
  const rgbPx = rasterPixels(text)
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba.set(rgbPx.subarray(i * 3, i * 3 + 3), i * 4)
    rgba[i * 4 + 3] = 255
  }
  return new Uint8Array(jpeg.encode({ data: rgba, width, height }, quality).data)
}

// ---- helpers -----------------------------------------------------------------------------------------------------

function toUnicodeCMap(pairs, bytes = 1) {
  const hex = (n) => n.toString(16).padStart(bytes * 2, '0').toUpperCase()
  const u = (s) => Array.from(s).map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase()
  return [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
    '1 begincodespacerange', `<${'00'.repeat(bytes)}> <${'FF'.repeat(bytes)}>`, 'endcodespacerange',
    `${pairs.length} beginbfchar`, ...pairs.map(([c, s]) => `<${hex(c)}> <${u(s)}>`), 'endbfchar', 'endcmap',
    'CMapName currentdict /CMap defineResource pop', 'end', 'end'
  ].join('\n')
}

const reg = (doc, o) => doc.context.register(o)
const flate = (doc, content, dict = {}) => reg(doc, doc.context.flateStream(typeof content === 'string' ? latin1(content) : content, dict))

function ensureSub(doc, res, key) {
  let d = res.lookup(N(key))
  if (!d || !d.entries) {
    d = doc.context.obj({})
    res.set(N(key), d)
  }
  return d
}

/** The characters of SECRET in the order that gives each a small code (as subset fonts do). */
const CODE_CHARS = Array.from(new Set(SECRET + ' :()abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.'))
const codeOf = (ch) => CODE_CHARS.indexOf(ch) + 1
const hexCodes = (s, bytes = 1) => '<' + Array.from(s).map((c) => codeOf(c).toString(16).padStart(bytes * 2, '0')).join('') + '>'

function customSubsetFont(doc) {
  const pairs = CODE_CHARS.map((c, i) => [i + 1, c])
  const first = 1
  const last = CODE_CHARS.length
  const desc = reg(doc, doc.context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Arial', Flags: 4, FontBBox: [-665, -325, 2000, 1006], ItalicAngle: 0, Ascent: 905, Descent: -212, CapHeight: 716, StemV: 80 }))
  return reg(doc, doc.context.obj({
    Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Arial', FirstChar: first, LastChar: last,
    Widths: Array.from({ length: last }, () => 600), FontDescriptor: desc, ToUnicode: flate(doc, toUnicodeCMap(pairs))
  }))
}

function type0Font(doc) {
  const pairs = CODE_CHARS.map((c, i) => [i + 3, c])
  const wArr = pairs.flatMap(([g]) => [g, [600]])
  const desc = reg(doc, doc.context.obj({ Type: 'FontDescriptor', FontName: 'AAAAAA+Roboto-Regular', Flags: 4, FontBBox: [-100, -300, 1200, 1000], ItalicAngle: 0, Ascent: 927, Descent: -244, CapHeight: 711, StemV: 80 }))
  const cid = reg(doc, doc.context.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'AAAAAA+Roboto-Regular', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, FontDescriptor: desc, DW: 1000, W: wArr, CIDToGIDMap: 'Identity' }))
  return reg(doc, doc.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'AAAAAA+Roboto-Regular', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: flate(doc, toUnicodeCMap(pairs, 2)) }))
}
const gidHex = (s) => '<' + Array.from(s).map((c) => (CODE_CHARS.indexOf(c) + 3).toString(16).padStart(4, '0')).join('') + '>'

/**
 * The proof document: SECRET appears in every form the redaction has to handle. Layout (page 1, y from the top):
 *   700 plain Helvetica   680 embedded Noto subset (Type0)   660 custom-code subset TrueType   640 Type0 Identity-H
 *   620 TJ pieces   600/586 split over two lines   560 invisible (Tr 3)   540 /ActualText   an image (raw), an image (JPEG)
 *   a shared Form XObject (also drawn on page 2), annotations, a text field, a bookmark, a named destination, metadata.
 * `positions` gives the boxes (user space) the tests mark for the parts that are not searchable text.
 */
export async function createProofPdf(secret = SECRET) {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const ctx = doc.context
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const noto = await doc.embedFont(readFileSync(resolve('src/renderer/src/features/textedit/fonts/NotoSans-Regular.ttf')), { subset: true })
  const page1 = doc.addPage([612, 792])
  const page2 = doc.addPage([612, 792])

  // pdf-lib drawn lines
  page1.drawText('Public heading that stays', { x: 72, y: 750, size: 16, font: helv })
  page1.drawText(`Reference ${secret} plain Helvetica`, { x: 72, y: 700, size: 12, font: helv })
  page1.drawText(`Embedded font ${secret} in Noto Sans`, { x: 72, y: 680, size: 12, font: noto })
  page1.drawText('Footer text that stays', { x: 72, y: 60, size: 12, font: helv })

  const F2 = customSubsetFont(doc)
  const F3 = type0Font(doc)

  // a form XObject used by both pages
  const form = flate(doc, `BT /F1 12 Tf 0 0 Td (Form caption that stays) Tj 0 -16 Td (Form: ${secret} shared) Tj ET`, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, -20, 300, 16], Resources: { Font: { F1: reg(doc, ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })) } }
  })
  // images
  const raw = flate(doc, rasterPixels(secret), { Type: 'XObject', Subtype: 'Image', Width: RASTER.width, Height: RASTER.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 })
  const jpg = reg(doc, ctx.stream(rasterJpeg(secret), { Type: 'XObject', Subtype: 'Image', Width: RASTER.width, Height: RASTER.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }))

  const extra = [
    // plain-string helvetica is drawn above; here: custom code subset, Type0, TJ pieces, split lines, invisible, ActualText
    `BT /F2 12 Tf 72 660 Td ${hexCodes('Custom subset ' + secret)} Tj ET`,
    `BT /F3 12 Tf 72 640 Td ${gidHex('Type0 Identity ' + secret)} Tj ET`,
    `BT /F1 12 Tf 72 620 Td [(TJ pieces ${secret.slice(0, 3)}) -20 (${secret.slice(3, 6)}) 15 (${secret.slice(6, 10)}) -10 (${secret.slice(10)} end)] TJ ET`,
    `BT /F1 12 Tf 72 600 Td (Split across ${secret.slice(0, 10)}) Tj 0 -14 Td (${secret.slice(10)} second line) Tj ET`,
    `BT 3 Tr /F1 12 Tf 72 560 Td (${secret} invisible OCR layer) Tj ET`,
    `/Span << /ActualText (${secret}) /Lang (en) >> BDC BT /F1 12 Tf 72 540 Td (${secret}) Tj ET EMC`,
    `q 1 0 0 1 72 480 cm /Fm1 Do Q`,
    `q 200 0 0 40 72 380 cm /Im1 Do Q`,
    `q 200 0 0 40 320 380 cm /Im2 Do Q`,
    `0.9 0.7 0.2 rg 400 300 60 20 re f 0.2 0.5 0.9 rg 480 300 60 20 re f`
  ].join('\n')
  const extraRef = flate(doc, extra)
  page1.node.addContentStream(extraRef)
  page1.node.normalize()
  const res = page1.node.Resources()
  const fonts = ensureSub(doc, res, 'Font')
  fonts.set(N('F1'), reg(doc, ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })))
  fonts.set(N('F2'), F2)
  fonts.set(N('F3'), F3)
  const xo = ensureSub(doc, res, 'XObject')
  xo.set(N('Fm1'), form)
  xo.set(N('Im1'), raw)
  xo.set(N('Im2'), jpg)

  // page 2
  page2.drawText(`Second page: ${secret} again`, { x: 72, y: 700, size: 12, font: helv })
  page2.drawText('Second page text that stays', { x: 72, y: 100, size: 12, font: helv })
  const c2 = flate(doc, 'q 1 0 0 1 72 500 cm /Fm1 Do Q')
  page2.node.addContentStream(c2)
  const res2 = (page2.node.normalize(), page2.node.Resources())
  ensureSub(doc, res2, 'XObject').set(N('Fm1'), form)

  // annotations
  const annot = (o) => reg(doc, ctx.obj({ Type: 'Annot', ...o }))
  const noteUnder = annot({ Subtype: 'Text', Rect: [200, 696, 216, 712], Contents: PDFString.of(`Note about ${secret}`), T: PDFString.of('Agent'), Name: 'Comment' })
  const noteElsewhere = annot({ Subtype: 'Text', Rect: [500, 40, 516, 56], Contents: PDFString.of(`Remember ${secret} please`), T: PDFString.of('Agent2') })
  const link = annot({ Subtype: 'Link', Rect: [72, 30, 200, 48], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com/keep') } })
  page1.node.set(N('Annots'), ctx.obj([noteUnder, noteElsewhere, link]))

  // a form field with the secret as its value
  const form0 = doc.getForm()
  const field = form0.createTextField('agent.code')
  field.setText(secret)
  field.addToPage(page1, { x: 300, y: 100, width: 200, height: 20 })
  const keepField = form0.createTextField('keep.field')
  keepField.setText('harmless value')
  keepField.addToPage(page1, { x: 300, y: 140, width: 200, height: 20 })

  // bookmarks
  const outlines = ctx.nextRef()
  const i1 = ctx.nextRef()
  const i2 = ctx.nextRef()
  ctx.assign(i1, ctx.obj({ Title: PDFHexString.fromText(`Chapter ${secret}`), Parent: outlines, Next: i2, Dest: [page1.ref, N('Fit')] }))
  ctx.assign(i2, ctx.obj({ Title: PDFHexString.fromText('Public chapter'), Parent: outlines, Prev: i1, Dest: [page2.ref, N('Fit')] }))
  ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: i1, Last: i2, Count: 2 }))
  doc.catalog.set(N('Outlines'), outlines)
  // named destinations
  doc.catalog.set(N('Names'), ctx.obj({ Dests: { Names: [PDFString.of(`${secret}-dest`), [page1.ref, N('Fit')], PDFString.of('public-dest'), [page2.ref, N('Fit')]] } }))
  // metadata
  doc.setTitle(`Report ${secret}`)
  doc.setAuthor('Agent Smith')
  doc.setSubject(`About ${secret}`)
  doc.setKeywords(['agents', secret])
  doc.setCreator(`Creator ${secret}`)
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Report ${secret}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  doc.catalog.set(N('Metadata'), flate(doc, xmp, { Type: 'Metadata', Subtype: 'XML' }))

  const positions = {
    // the left half of the raw and JPEG images (pixels 0..99 of 200; the images are drawn 1 pixel = 1 point)
    rawLeft: { x0: 72, y0: 380, x1: 172, y1: 420 },
    jpegLeft: { x0: 320, y0: 380, x1: 420, y1: 420 },
    // a vector rectangle fully inside, one partly overlapping
    vectorArea: { x0: 395, y0: 295, x1: 505, y1: 325 },
    invisible: { x0: 60, y0: 552, x1: 320, y1: 570 }
  }
  return { bytes: await doc.save(), secret, positions }
}

/** A small document full of things the built-in patterns look for (and look-alikes they must not match). */
export async function createPatternsPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([612, 792])
  const lines1 = [
    'Contact: jane.doe@example.com or sales@shop.example.org',
    'Call (555) 123-4567 or +44 20 7946 0958',
    'Card 4111 1111 1111 1111 valid, 4111 1111 1111 1112 invalid',
    'SSN 123-45-6789 and ID 000-12-3456',
    'IBAN DE89 3704 0044 0532 0130 00 and DE00 1234',
    'Date 2024-03-15 and 31/02/2024 and March 15, 2024',
    'Site https://example.com/path?q=1 and 192.168.0.1 and 999.1.1.1'
  ]
  lines1.forEach((t, i) => p1.drawText(t, { x: 60, y: 720 - i * 30, size: 12, font }))
  const p2 = doc.addPage([612, 792])
  p2.drawText('Second page: bob@example.net', { x: 60, y: 720, size: 12, font })
  p2.drawText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', { x: 60, y: 690, size: 12, font })
  return doc.save()
}

/** A page whose secret also sits in an attachment, in JavaScript and in page labels (hidden data). */
export async function createHiddenDataPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([612, 792])
  p.drawText('Visible line with ATTACHSECRET inside', { x: 60, y: 700, size: 14, font })
  p.drawText('Another line that stays', { x: 60, y: 660, size: 14, font })
  await doc.attach(new TextEncoder().encode('the code ATTACHSECRET appears in this attachment'), 'notes.txt', { mimeType: 'text/plain', description: 'Notes about ATTACHSECRET' })
  doc.catalog.set(N('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of("app.alert('ATTACHSECRET')") }))
  doc.catalog.set(N('PageLabels'), doc.context.obj({ Nums: [0, { S: 'D', P: PDFString.of('Sec-') }] }))
  doc.setTitle('Plain title')
  return doc.save()
}

/** A page turned by 90 degrees with text on it (marks and the overlay must follow the rotation). */
export async function createRotatedPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([612, 792])
  p.setRotation(degrees(90))
  p.drawText('Rotated page with ROTATEDSECRET in the middle', { x: 72, y: 500, size: 16, font })
  p.drawText('Second rotated line that stays', { x: 72, y: 460, size: 16, font })
  return doc.save()
}

/** A tiny two-page document whose second page reuses the first page's form (copy-on-write tests). */
export async function createSharedFormPdf() {
  const doc = await PDFDocument.create()
  const font = reg(doc, doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }))
  const form = flate(doc, 'BT /F1 12 Tf 0 0 Td (Alpha) Tj 100 0 Td (SECRETFORM) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, -4, 300, 14], Resources: { Font: { F1: font } } })
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([612, 792])
    p.node.addContentStream(flate(doc, `q 1 0 0 1 72 ${700 - i * 100} cm /Fm1 Do Q`))
    const r = (p.node.normalize(), p.node.Resources())
    ensureSub(doc, r, 'XObject').set(N('Fm1'), form)
  }
  return doc.save()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? 'tests/fixtures/out')
  mkdirSync(out, { recursive: true })
  const proof = await createProofPdf()
  writeFileSync(join(out, 'redact-proof.pdf'), proof.bytes)
  writeFileSync(join(out, 'redact-proof.json'), JSON.stringify({ secret: proof.secret, positions: proof.positions, raster: RASTER }))
  writeFileSync(join(out, 'redact-proof.raster'), rasterPixels(proof.secret))
  writeFileSync(join(out, 'redact-shared.pdf'), await createSharedFormPdf())
  writeFileSync(join(out, 'redact-patterns.pdf'), await createPatternsPdf())
  writeFileSync(join(out, 'redact-hidden.pdf'), await createHiddenDataPdf())
  writeFileSync(join(out, 'redact-rotated.pdf'), await createRotatedPdf())
}
