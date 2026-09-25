// Fixtures for the form-builder feature: node tests/fixtures/form-builder.mjs <outDir>
// Flat (non-fillable) forms drawn with pdf-lib, plus the fields a person would mark on each of them
// (`expected`, in the page as the reader sees it: origin bottom-left, y up, points).
//   fb-detect.pdf     the mixed form used by the e2e test (names, date, boxes, checkboxes, radio, signature)
//   fb-rotated.pdf    same content on a /Rotate 90 page
//   fb-scan.pdf       a page that is one big picture
//   fb-fields.pdf     a fillable form built with pdf-lib (for property/tab-order tests)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PDFDocument,
  PDFName,
  PDFOperator,
  StandardFonts,
  TextRenderingMode,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setTextRenderingMode
} from 'pdf-lib'

const BLACK = rgb(0, 0, 0)

/** Draws in visual coordinates (y up) on a page that may carry /Rotate; wraps everything in one `cm`. */
class Canvas {
  constructor(doc, font, bold, rotate) {
    this.font = font
    this.bold = bold
    this.rotate = rotate
    const [w, h] = [612, 792]
    this.size = rotate === 90 || rotate === 270 ? [h, w] : [w, h]
    this.page = doc.addPage(this.size)
    if (rotate) this.page.setRotation({ type: 'degrees', angle: rotate })
    const m = { 0: null, 90: [0, 1, -1, 0, this.size[0], 0], 180: [-1, 0, 0, -1, w, h], 270: [0, -1, 1, 0, 0, this.size[1]] }[rotate]
    if (m) this.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m))
  }
  text(x, y, s, size = 11, bold = false) {
    this.page.drawText(s, { x, y, size, font: bold ? this.bold : this.font, color: BLACK })
    return this.font.widthOfTextAtSize(s, size)
  }
  width(s, size = 11) {
    return this.font.widthOfTextAtSize(s, size)
  }
  hline(x0, x1, y, thickness = 0.8) {
    this.page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness, color: BLACK })
  }
  vline(x, y0, y1, thickness = 0.8) {
    this.page.drawLine({ start: { x, y: y0 }, end: { x, y: y1 }, thickness, color: BLACK })
  }
  rect(x0, y0, x1, y1, opts = {}) {
    this.page.drawRectangle({
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
      borderColor: opts.noStroke ? undefined : BLACK,
      borderWidth: opts.noStroke ? 0 : (opts.lw ?? 0.8),
      color: opts.fill === undefined ? undefined : rgb(opts.fill, opts.fill, opts.fill)
    })
  }
  circle(cx, cy, r) {
    this.page.drawCircle({ x: cx, y: cy, size: r, borderColor: BLACK, borderWidth: 0.8 })
  }
  finish() {
    if (this.rotate) this.page.pushOperators(popGraphicsState())
  }
}

async function start() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  return { doc, font, bold }
}

const exp = (kind, x0, y0, x1, y1, extra = {}) => ({ kind, box: [x0, y0, x1, y1], ...extra })

// ---------------------------------------------------------------------------------------------------------
// individual pages (each returns `expected` for its page)

/** Labels with rules after them, captions under rules, two columns; plus underlined headings (negatives). */
function drawUnderlines(c) {
  const expected = []
  const hw = c.text(50, 740, 'Section A: Personal details', 15, true)
  c.hline(50, 50 + hw, 737, 0.8) // underlined heading: NOT a field
  c.hline(50, 562, 716, 0.5) // separator rule: NOT a field
  const line = (label, x, y, x1, kind, extra = {}) => {
    const lw = c.text(x, y, label, 11)
    c.hline(x + lw + 6, x1, y - 2)
    expected.push(exp(kind, x + lw + 6, y - 2, x1, y + 14, extra))
  }
  line('Full name:', 50, 680, 330, 'text', { label: 'Full name' })
  line('Address:', 50, 650, 500, 'text', { label: 'Address' })
  line('Date of birth:', 50, 620, 260, 'date', { label: 'Date of birth' })
  line('Phone number', 50, 590, 300, 'text', { label: 'Phone number' })
  line('City:', 50, 560, 250, 'text', { label: 'City' })
  line('Postcode:', 320, 560, 560, 'text', { label: 'Postcode' })
  c.hline(50, 250, 470)
  c.text(50, 458, 'Signature', 9)
  expected.push(exp('signature', 50, 470, 250, 486, { label: 'Signature' }))
  line('Signed by:', 330, 470, 560, 'signature', { label: 'Signed by' })
  // Underlined words inside a sentence: NOT a field.
  const sentence = 'Please read the terms carefully before signing.'
  c.text(50, 400, sentence, 11)
  const before = c.width('Please read the terms ', 11)
  c.hline(50 + before, 50 + before + c.width('carefully', 11), 398)
  return expected
}

/** Boxes with labels left / above / inside; a big comment box; a shaded box; a paragraph in a frame (negative). */
function drawBoxes(c) {
  const expected = []
  c.text(50, 700, 'Company name', 11)
  c.rect(150, 690, 450, 712)
  expected.push(exp('text', 150, 690, 450, 712, { label: 'Company name' }))
  c.text(50, 650, 'Job title', 11)
  c.rect(50, 620, 300, 644)
  expected.push(exp('text', 50, 620, 300, 644, { label: 'Job title' }))
  c.text(50, 590, 'Comments', 11)
  c.rect(50, 500, 500, 582)
  expected.push(exp('text', 50, 500, 500, 582, { label: 'Comments', multiline: true }))
  // A frame with a paragraph inside: NOT a field.
  c.rect(50, 380, 400, 450)
  c.text(58, 435, 'Terms and conditions apply to every order placed', 10)
  c.text(58, 421, 'through this form. Please keep a copy of it for', 10)
  c.text(58, 407, 'your own records.', 10)
  // Label printed inside an otherwise empty box.
  c.rect(50, 300, 300, 340)
  c.text(54, 330, 'Surname', 8)
  expected.push(exp('text', 50, 300, 300, 340, { label: 'Surname' }))
  // Shaded box without an outline.
  c.text(330, 314, 'Reference', 11)
  c.rect(400, 300, 540, 340, { noStroke: true, fill: 0.9 })
  expected.push(exp('text', 400, 300, 540, 340, { label: 'Reference' }))
  return expected
}

/** Checkboxes, radio groups (row, column), Yes/No boxes; bullets and a decorative circle (negatives). */
function drawChoices(c) {
  const expected = []
  const box = (x, y, label) => {
    c.rect(x, y, x + 10, y + 10)
    c.text(x + 16, y + 1.5, label, 11)
  }
  box(50, 700, 'I agree to the terms')
  expected.push(exp('checkbox', 50, 700, 60, 710, { label: 'I agree to the terms' }))
  box(50, 680, 'Send me updates')
  expected.push(exp('checkbox', 50, 680, 60, 690, { label: 'Send me updates' }))
  box(50, 660, 'I am over 18')
  expected.push(exp('checkbox', 50, 660, 60, 670, { label: 'I am over 18' }))
  box(50, 640, 'I hereby confirm that all information given in this form is true and complete')
  expected.push(exp('checkbox', 50, 640, 60, 650))
  // Bullet lists: NOT checkboxes.
  for (let i = 0; i < 3; i++) {
    c.rect(50, 600 - i * 16, 54, 604 - i * 16, { fill: 0, noStroke: true })
    c.text(62, 600 - i * 16, `Bullet point number ${i + 1} in a list`, 11)
  }
  for (let i = 0; i < 2; i++) {
    c.rect(50, 545 - i * 16, 57, 552 - i * 16, { fill: 0.1, noStroke: true })
    c.text(64, 545 - i * 16, `Solid square bullet ${i + 1}`, 11)
  }
  // Radio group in a row.
  c.text(50, 480, 'Gender:', 11)
  ;[['Male', 140], ['Female', 220], ['Other', 310]].forEach(([l, x]) => {
    c.circle(x, 483, 5)
    c.text(x + 10, 480, l, 11)
  })
  expected.push(exp('radio', 135, 478, 315, 488, { label: 'Gender', options: ['Male', 'Female', 'Other'] }))
  // Radio group in a column.
  c.text(50, 440, 'Preferred contact', 11)
  ;[['Email', 420], ['Phone', 404], ['Post', 388]].forEach(([l, cy]) => {
    c.circle(60, cy, 5)
    c.text(70, cy - 4, l, 11)
  })
  expected.push(exp('radio', 55, 383, 65, 425, { label: 'Preferred contact', options: ['Email', 'Phone', 'Post'] }))
  // Yes / No square boxes.
  c.text(50, 300, 'Are you a resident?', 11)
  c.rect(250, 298, 260, 308)
  c.text(266, 299.5, 'Yes', 11)
  c.rect(300, 298, 310, 308)
  c.text(316, 299.5, 'No', 11)
  expected.push(exp('radio', 250, 298, 310, 308, { label: 'Are you a resident?', options: ['Yes', 'No'] }))
  // A decorative circle next to a sentence: NOT a field.
  c.circle(56, 254, 4)
  c.text(66, 250, 'This is an ordinary sentence marked with a small circle.', 11)
  return expected
}

/** Comb fields: separate adjacent cells, and one box divided by tick marks. */
function drawCombs(c) {
  const expected = []
  c.text(50, 700, 'Account number', 11)
  for (let i = 0; i < 10; i++) c.rect(170 + i * 16, 692, 186 + i * 16, 712)
  expected.push(exp('comb', 170, 692, 330, 712, { label: 'Account number', cells: 10 }))
  c.text(50, 650, 'Postcode', 11)
  c.rect(170, 640, 290, 662)
  for (let i = 1; i < 6; i++) c.vline(170 + i * 20, 640, 648)
  expected.push(exp('comb', 170, 640, 290, 662, { label: 'Postcode', cells: 6 }))
  return expected
}

/** A table with column headers and empty body cells, a label/value table, and a filled table (negative). */
function drawTables(c) {
  const expected = []
  const ys = [720, 700, 676, 652, 628, 604]
  const xs = [50, 250, 330, 430]
  ys.forEach((y) => c.hline(50, 430, y))
  xs.forEach((x) => c.vline(x, 604, 720))
  ;['Item', 'Qty', 'Price'].forEach((t, i) => c.text(xs[i] + 5, 706, t, 11, true))
  for (let r = 1; r < 5; r++) for (let k = 0; k < 3; k++) expected.push(exp('text', xs[k], ys[r + 1], xs[k + 1], ys[r], { header: ['Item', 'Qty', 'Price'][k] }))
  // Label / value table.
  const ly = [560, 536, 512, 488]
  ly.forEach((y) => c.hline(50, 400, y))
  ;[50, 160, 400].forEach((x) => c.vline(x, 488, 560))
  ;['Name', 'Email', 'Phone'].forEach((t, i) => {
    c.text(56, ly[i] - 16, t, 11)
    expected.push(exp('text', 160, ly[i + 1], 400, ly[i], { label: t }))
  })
  // Filled table: NOT fields.
  const fy = [420, 396, 372, 348]
  fy.forEach((y) => c.hline(50, 350, y))
  ;[50, 150, 250, 350].forEach((x) => c.vline(x, 348, 420))
  for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) c.text(56 + k * 100, fy[r] - 16, `Cell ${r}${k}`, 11)
  return expected
}

/** Two-column form: label + box, label + box on the same line. */
function drawColumns(c) {
  const expected = []
  const rows = [
    ['First name', 'Last name', 700],
    ['Email', 'Phone', 660],
    ['City', 'Country', 620]
  ]
  for (const [a, b, y] of rows) {
    c.text(50, y, a, 11)
    c.rect(130, y - 6, 270, y + 16)
    expected.push(exp('text', 130, y - 6, 270, y + 16, { label: a }))
    c.text(320, y, b, 11)
    c.rect(395, y - 6, 560, y + 16)
    expected.push(exp('text', 395, y - 6, 560, y + 16, { label: b }))
  }
  return expected
}

/** Leader characters inside the text: underscores, dots, spaced dots, slashes. */
function drawLeaders(c) {
  const expected = []
  const put = (y, s, extra) => {
    c.text(50, y, s, 11)
    return extra
  }
  const line1 = 'Name: ' + '_'.repeat(30) + ' Age: ' + '_'.repeat(6)
  put(700, line1)
  const nx = 50 + c.width('Name: ', 11)
  const nw = c.width('_'.repeat(30), 11)
  expected.push(exp('text', nx, 696, nx + nw, 712, { label: 'Name' }))
  const ax = 50 + c.width('Name: ' + '_'.repeat(30) + ' Age: ', 11)
  expected.push(exp('text', ax, 696, ax + c.width('_'.repeat(6), 11), 712, { label: 'Age' }))
  put(660, 'Reference: ' + '.'.repeat(40))
  const rx = 50 + c.width('Reference: ', 11)
  expected.push(exp('text', rx, 656, rx + c.width('.'.repeat(40), 11), 672, { label: 'Reference' }))
  put(620, 'Date: ___/___/______')
  const dx = 50 + c.width('Date: ', 11)
  expected.push(exp('date', dx, 616, dx + c.width('___/___/______', 11), 632, { label: 'Date' }))
  put(580, 'Contact ' + '. '.repeat(20))
  const cx = 50 + c.width('Contact ', 11)
  expected.push(exp('text', cx, 576, cx + c.width('. '.repeat(20), 11), 592, { label: 'Contact' }))
  // Prose with an ellipsis: NOT a field.
  c.text(50, 540, 'Well... this is just a sentence that trails off...', 11)
  return expected
}

/** Everything that must NOT produce a field. */
function drawNegatives(c) {
  c.rect(25, 25, 587, 767, { lw: 1 }) // page border
  c.hline(40, 572, 750, 0.6) // header rule
  c.text(40, 756, 'Company letterhead', 9)
  c.hline(40, 572, 45, 0.6) // footer rule
  const hw = c.text(50, 700, 'Chapter 1: Introduction', 16, true)
  c.hline(50, 50 + hw, 696)
  c.hline(50, 562, 680, 0.5)
  for (let i = 0; i < 4; i++) {
    c.rect(52, 640 - i * 18, 56, 644 - i * 18, { fill: 0, noStroke: true })
    c.text(64, 640 - i * 18, `List item ${i + 1} with some text`, 11)
  }
  const xs = [50, 200, 350, 500]
  const ys = [540, 516, 492, 468]
  ys.forEach((y) => c.hline(50, 500, y))
  xs.forEach((x) => c.vline(x, 468, 540))
  for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) c.text(56 + k * 150, ys[r] - 16, `R${r} C${k}`, 11)
  c.rect(50, 350, 450, 440, { fill: 0.93, noStroke: true })
  c.text(60, 420, 'Note: this shaded panel only contains text and', 11)
  c.text(60, 406, 'is not something anyone should fill in.', 11)
  const uw = c.text(50, 300, 'See the appendix', 11)
  c.hline(50, 50 + uw, 297.5) // underlined link text
  c.text(50, 260, 'Total', 11)
  c.text(120, 260, '1,250.00', 11)
  return []
}

/** The mixed form for the e2e test. */
function drawMixed(c) {
  const expected = []
  c.text(50, 740, 'Membership application', 18, true)
  const line = (label, x, y, x1, kind, extra = {}) => {
    const lw = c.text(x, y, label, 11)
    c.hline(x + lw + 6, x1, y - 2)
    expected.push(exp(kind, x + lw + 6, y - 2, x1, y + 14, extra))
  }
  line('Full name:', 50, 690, 330, 'text', { label: 'Full name' })
  line('Email:', 50, 655, 330, 'text', { label: 'Email' })
  line('Date of birth:', 50, 620, 230, 'date', { label: 'Date of birth' })
  c.text(50, 585, 'City', 11)
  c.rect(90, 578, 250, 600)
  expected.push(exp('text', 90, 578, 250, 600, { label: 'City' }))
  c.text(50, 545, 'Comments', 11)
  c.rect(50, 470, 400, 538)
  expected.push(exp('text', 50, 470, 400, 538, { label: 'Comments', multiline: true }))
  c.rect(50, 430, 60, 440)
  c.text(66, 431.5, 'I agree to the terms', 11)
  expected.push(exp('checkbox', 50, 430, 60, 440, { label: 'I agree to the terms' }))
  c.rect(50, 410, 60, 420)
  c.text(66, 411.5, 'Send me the newsletter', 11)
  expected.push(exp('checkbox', 50, 410, 60, 420, { label: 'Send me the newsletter' }))
  c.text(50, 370, 'Level:', 11)
  ;[['Basic', 110], ['Plus', 180], ['Pro', 250]].forEach(([l, x]) => {
    c.circle(x, 373, 5)
    c.text(x + 10, 370, l, 11)
  })
  expected.push(exp('radio', 105, 368, 250, 378, { label: 'Level', options: ['Basic', 'Plus', 'Pro'] }))
  c.hline(50, 250, 300)
  c.text(50, 288, 'Signature', 9)
  expected.push(exp('signature', 50, 300, 250, 316, { label: 'Signature' }))
  return expected
}

// ---------------------------------------------------------------------------------------------------------

async function single(draw, rotate = 0) {
  const { doc, font, bold } = await start()
  const c = new Canvas(doc, font, bold, rotate)
  const expected = draw(c)
  c.finish()
  return { bytes: await doc.save(), expected }
}

export const createUnderlines = (rotate = 0) => single(drawUnderlines, rotate)
export const createBoxes = (rotate = 0) => single(drawBoxes, rotate)
export const createChoices = (rotate = 0) => single(drawChoices, rotate)
export const createCombs = (rotate = 0) => single(drawCombs, rotate)
export const createTables = (rotate = 0) => single(drawTables, rotate)
export const createColumns = (rotate = 0) => single(drawColumns, rotate)
export const createLeaders = (rotate = 0) => single(drawLeaders, rotate)
export const createNegatives = (rotate = 0) => single(drawNegatives, rotate)
export const createMixed = (rotate = 0) => single(drawMixed, rotate)

/** Puts one full-page picture on a page (what a scanner produces). */
function paintFullPageImage(doc, page) {
  const pixels = new Uint8Array(16 * 16).map((_, i) => ((i * 37) % 200) + 40)
  const img = doc.context.flateStream(pixels, { Type: 'XObject', Subtype: 'Image', Width: 16, Height: 16, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })
  page.node.setXObject(PDFName.of('Im1'), doc.context.register(img))
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(612, 0, 0, 792, 0, 0), PDFOperator.of('Do', [PDFName.of('Im1')]), popGraphicsState())
}

/** One page that is a single picture (a "scan"): no text, no vectors. */
export async function createScan() {
  const { doc } = await start()
  paintFullPageImage(doc, doc.addPage([612, 792]))
  return { bytes: await doc.save() }
}

/** A scanned page that carries an invisible recognised-text layer (render mode 3). */
export async function createScanWithOcrLayer() {
  const { doc, font } = await start()
  const page = doc.addPage([612, 792])
  paintFullPageImage(doc, page)
  page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible))
  page.drawText('Name: ____________', { x: 60, y: 700, size: 12, font })
  page.pushOperators(popGraphicsState())
  return { bytes: await doc.save() }
}

/** A fillable form with a few fields, for property / tab-order tests. */
export async function createFieldsForm() {
  const { doc, font } = await start()
  const page = doc.addPage([612, 792])
  page.drawText('Existing form', { x: 50, y: 740, size: 16, font })
  const form = doc.getForm()
  const style = { borderWidth: 1, borderColor: rgb(0.2, 0.2, 0.2), font }
  const a = form.createTextField('first')
  a.addToPage(page, { x: 50, y: 690, width: 200, height: 22, ...style })
  const b = form.createTextField('second')
  b.addToPage(page, { x: 50, y: 640, width: 200, height: 22, ...style })
  const c = form.createTextField('third')
  c.addToPage(page, { x: 50, y: 590, width: 200, height: 22, ...style })
  const d = form.createCheckBox('agree')
  d.addToPage(page, { x: 50, y: 550, width: 14, height: 14, ...style })
  return { bytes: await doc.save() }
}

// ---------------------------------------------------------------------------------------------------------

export const ALL = { createUnderlines, createBoxes, createChoices, createCombs, createTables, createColumns, createLeaders, createNegatives, createMixed }

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  const out = resolve(process.argv[2] ?? 'test-results/fixtures')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'fb-detect.pdf'), (await createMixed()).bytes)
  writeFileSync(join(out, 'fb-rotated.pdf'), (await createMixed(90)).bytes)
  writeFileSync(join(out, 'fb-scan.pdf'), (await createScan()).bytes)
  writeFileSync(join(out, 'fb-fields.pdf'), (await createFieldsForm()).bytes)
  console.log('form-builder fixtures written to', out)
}
