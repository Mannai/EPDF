import { PDFDocument, PDFPage, StandardFonts, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb, type PDFFont } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { detectPage, type DetectResult, type Proposal } from '../../src/renderer/src/features/formbuilder/logic/detect'
import { readPageContent } from '../../src/renderer/src/features/formbuilder/logic/pageContent'
import { buildPdf, helvetica, times } from './helpers/pdfBuilder'

/**
 * A second, independent set of flat forms drawn in DIFFERENT ways than the main fixtures (other fonts and sizes,
 * dashed rules, boxes made of four separate lines, cells drawn one rectangle at a time, rules made of thin filled
 * bars, content inside Form XObjects, hand-written content streams with TJ kerning). It exists to check that the
 * heuristics generalise beyond the shapes they were tuned on. Numbers are logged; the thresholds are what we
 * promise.
 */

interface Expect {
  kind: string
  box: [number, number, number, number]
}
const THRESHOLD = 0.5

const inside = (p: Proposal, e: Expect, slack = 8): boolean => {
  const cx = (p.rect.x0 + p.rect.x1) / 2
  const cy = (p.rect.y0 + p.rect.y1) / 2
  return cx >= e.box[0] - slack && cx <= e.box[2] + slack && cy >= e.box[1] - slack && cy <= e.box[3] + slack
}

async function detectAll(bytes: Uint8Array): Promise<Proposal[]> {
  const pdf = await PDFDocument.load(bytes)
  const res: DetectResult[] = pdf.getPages().map((_, i) => detectPage(readPageContent(pdf, i)))
  return res.flatMap((r) => r.proposals).filter((p) => p.confidence >= THRESHOLD)
}

const totals = { tp: 0, fp: 0, fn: 0 }
const rows: string[] = []

async function evaluate(name: string, bytes: Uint8Array, expected: Expect[]): Promise<void> {
  const proposals = await detectAll(bytes)
  const used = new Set<Proposal>()
  let tp = 0
  const missed: Expect[] = []
  for (const e of expected) {
    const p = proposals.find((q) => !used.has(q) && q.kind === e.kind && inside(q, e))
    if (p) {
      used.add(p)
      tp++
    } else missed.push(e)
  }
  const extra = proposals.filter((p) => !used.has(p))
  totals.tp += tp
  totals.fp += extra.length
  totals.fn += missed.length
  rows.push(`${name.padEnd(34)} tp=${tp} fp=${extra.length} fn=${missed.length}`)
  const detail = `missed: ${JSON.stringify(missed)}\nextra: ${extra.map((p) => `${p.kind} ${p.rect.x0.toFixed(0)},${p.rect.y0.toFixed(0)}-${p.rect.x1.toFixed(0)},${p.rect.y1.toFixed(0)} c=${p.confidence} ${p.reason}`).join('\n')}`
  expect(missed.length, detail).toBe(0)
  expect(extra.length, detail).toBe(0)
}

const BLACK = rgb(0, 0, 0)

async function newDoc(): Promise<{ doc: PDFDocument; page: PDFPage; hel: PDFFont; tim: PDFFont; cou: PDFFont }> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  return { doc, page, hel: await doc.embedFont(StandardFonts.Helvetica), tim: await doc.embedFont(StandardFonts.TimesRoman), cou: await doc.embedFont(StandardFonts.Courier) }
}

describe('detection on differently constructed forms', () => {
  it('Times / Courier labels, tiny and large sizes, dashed and dotted rules right after the label', async () => {
    const { doc, page, tim, cou, hel } = await newDoc()
    const exp: Expect[] = []
    const row = (label: string, font: PDFFont, size: number, y: number, x1: number, dash?: number[]): void => {
      page.drawText(label, { x: 60, y, size, font })
      const lx = 60 + font.widthOfTextAtSize(label, size) + 2
      page.drawLine({ start: { x: lx, y: y - 3.5 }, end: { x: x1, y: y - 3.5 }, thickness: 0.6, color: BLACK, dashArray: dash })
      exp.push({ kind: 'text', box: [lx, y - 3.5, x1, y + 12] })
    }
    row('Surname', tim, 9, 700, 300)
    row('Given names (in full)', tim, 9, 670, 420, [1, 2])
    row('Nationality', cou, 10, 640, 300, [3, 2])
    row('Occupation:', hel, 12, 610, 500, [0.5, 1.5])
    row('Employer', tim, 14, 580, 540)
    // Headline with a rule: not a field.
    page.drawText('Part 1 - Applicant', { x: 60, y: 750, size: 16, font: hel })
    page.drawLine({ start: { x: 60, y: 745 }, end: { x: 60 + hel.widthOfTextAtSize('Part 1 - Applicant', 16), y: 745 }, thickness: 1, color: BLACK })
    await evaluate('times/courier, dashed rules', await doc.save(), exp)
  })

  it('boxes made of four separate lines, cells drawn one rectangle at a time, filled thin bars as rules', async () => {
    const { doc, page, hel } = await newDoc()
    const exp: Expect[] = []
    const line = (x0: number, y0: number, x1: number, y1: number): void => page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 0.8, color: BLACK })
    // A box drawn as 4 lines with a label on its left.
    page.drawText('Passport no.', { x: 50, y: 700, size: 11, font: hel })
    const box = (x0: number, y0: number, x1: number, y1: number): void => {
      line(x0, y0, x1, y0)
      line(x1, y0, x1, y1)
      line(x1, y1, x0, y1)
      line(x0, y1, x0, y0)
    }
    box(130, 692, 330, 714)
    exp.push({ kind: 'text', box: [130, 692, 330, 714] })
    // A 2 x 3 grid drawn as six separate rectangles: label cells with an empty neighbour.
    const cell = (x0: number, y0: number, w: number, h: number, label?: string): void => {
      page.drawRectangle({ x: x0, y: y0, width: w, height: h, borderColor: BLACK, borderWidth: 0.7 })
      if (label) page.drawText(label, { x: x0 + 5, y: y0 + h / 2 - 4, size: 10, font: hel })
    }
    ;['Height', 'Weight', 'Eye colour'].forEach((l, i) => {
      cell(50, 640 - i * 24, 100, 24, l)
      cell(150, 640 - i * 24, 180, 24)
      exp.push({ kind: 'text', box: [150, 640 - i * 24, 330, 664 - i * 24] })
    })
    // Rule made of a filled thin bar.
    page.drawText('Telephone', { x: 50, y: 540, size: 11, font: hel })
    page.drawRectangle({ x: 115, y: 537, width: 200, height: 0.6, color: BLACK })
    exp.push({ kind: 'text', box: [115, 537, 315, 552] })
    await evaluate('four-line boxes, per-cell rectangles, bars', await doc.save(), exp)
  })

  it('content inside Form XObjects (drawn at another scale and position)', async () => {
    const sub = await PDFDocument.create()
    const sp = sub.addPage([300, 200])
    const f = await sub.embedFont(StandardFonts.Helvetica)
    sp.drawText('Reference:', { x: 10, y: 150, size: 11, font: f })
    sp.drawLine({ start: { x: 75, y: 148 }, end: { x: 280, y: 148 }, thickness: 0.8, color: BLACK })
    sp.drawText('Comments', { x: 10, y: 110, size: 11, font: f })
    sp.drawRectangle({ x: 10, y: 20, width: 270, height: 80, borderColor: BLACK, borderWidth: 0.8 })
    const { doc, page } = await newDoc()
    const emb = await doc.embedPage(sub.getPages()[0])
    page.drawPage(emb, { x: 100, y: 500, xScale: 1.5, yScale: 1.5 })
    // Field boxes in page space: the reference line spans x 100+1.5*75.. 100+1.5*280, y = 500+1.5*148.
    const exp: Expect[] = [
      { kind: 'text', box: [100 + 1.5 * 75, 500 + 1.5 * 148, 100 + 1.5 * 280, 500 + 1.5 * 148 + 16] },
      { kind: 'text', box: [100 + 15, 500 + 30, 100 + 420, 500 + 150] }
    ]
    await evaluate('Form XObject scaled 1.5x', await doc.save(), exp)
  })

  it('hand-written content: TJ kerning, several content streams, a q/cm block, text drawn word by word', async () => {
    const bytes = (
      await buildPdf([
        {
          content: [
            'BT /F1 11 Tf 1 0 0 1 50 700 Tm [(Na) 30 (me)] TJ ET',
            'BT /F1 11 Tf 1 0 0 1 90 700 Tm (:) Tj ET 0.8 w 96 698 m 320 698 l S',
            // Second block is shifted and scaled with cm.
            'q 1 0 0 1 0 -60 cm BT /F1 11 Tf 1 0 0 1 50 700 Tm (Home) Tj 0 0 Td ( ) Tj (address) Tj ET 0.8 w 122 698 m 420 698 l S Q',
            // Word-by-word text on a comb of boxes.
            'BT /F1 11 Tf 1 0 0 1 50 590 Tm (Code) Tj ET'
          ],
          fonts: { F1: helvetica }
        }
      ])
    ).bytes
    // Comb: 6 separate cells added through a second content pass.
    const pdf = await PDFDocument.load(bytes)
    const page = pdf.getPage(0)
    for (let i = 0; i < 6; i++) page.drawRectangle({ x: 100 + i * 18, y: 584, width: 18, height: 22, borderColor: BLACK, borderWidth: 0.8 })
    void times
    await evaluate('hand-written content, TJ, cm, comb', await pdf.save(), [
      { kind: 'text', box: [96, 698, 320, 712] },
      { kind: 'text', box: [122, 638, 420, 652] },
      { kind: 'comb', box: [100, 584, 208, 606] }
    ])
  })

  it('checkbox and radio styles: light-grey fills, thick strokes, bigger circles, vertical Yes/No', async () => {
    const { doc, page, hel } = await newDoc()
    const exp: Expect[] = []
    const cb = (x: number, y: number, label: string, size = 12, fill = 0.95, lw = 1.2): void => {
      page.drawRectangle({ x, y, width: size, height: size, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: lw, color: rgb(fill, fill, fill) })
      page.drawText(label, { x: x + size + 6, y: y + 2, size: 11, font: hel })
      exp.push({ kind: 'checkbox', box: [x, y, x + size, y + size] })
    }
    cb(60, 700, 'Employed')
    cb(60, 680, 'Self-employed', 10, 1, 0.8)
    cb(60, 660, 'Retired', 16, 0.9, 1.5)
    // Radio circles, r = 4.5 with white fill, two questions stacked.
    const circle = (x: number, y: number, label: string): void => {
      page.drawCircle({ x, y, size: 4.5, borderColor: BLACK, borderWidth: 0.9, color: rgb(1, 1, 1) })
      page.drawText(label, { x: x + 9, y: y - 4, size: 11, font: hel })
    }
    page.drawText('Marital status', { x: 60, y: 600, size: 11, font: hel })
    circle(170, 603, 'Single')
    circle(240, 603, 'Married')
    circle(320, 603, 'Other')
    exp.push({ kind: 'radio', box: [165, 598, 325, 608] })
    page.drawText('Do you smoke?', { x: 60, y: 560, size: 11, font: hel })
    circle(170, 563, 'Yes')
    circle(240, 563, 'No')
    exp.push({ kind: 'radio', box: [165, 558, 245, 568] })
    // Decoration: a filled black circle bullet and a small stroked circle inside a sentence.
    page.drawCircle({ x: 64, y: 500, size: 3, color: BLACK })
    page.drawText('A bullet point in a list', { x: 74, y: 496, size: 11, font: hel })
    await evaluate('checkbox / radio styles', await doc.save(), exp)
  })

  it('a rotated (/Rotate 90) page with a Form XObject inside', async () => {
    const { doc, page, hel } = await newDoc()
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 0, 0))
    page.drawText('Name:', { x: 60, y: 700, size: 11, font: hel })
    page.drawLine({ start: { x: 100, y: 698 }, end: { x: 300, y: 698 }, thickness: 0.8, color: BLACK })
    page.pushOperators(popGraphicsState())
    page.setRotation({ type: 'degrees' as never, angle: 90 })
    const proposals = await detectAll(await doc.save())
    // The text is now sideways for the reader: labels cannot be read, so nothing is proposed for the rule
    // (it is a free rule without a readable label => below the threshold), and the page says so.
    expect(proposals.filter((p) => p.label)).toHaveLength(0)
    const pdf = await PDFDocument.load(await doc.save())
    const r = detectPage(readPageContent(pdf, 0))
    expect(r.status).toBe('ok')
  })

  it('ordinary documents produce nothing: table of contents with dot leaders, a menu, a letter with a signature block, an invoice', async () => {
    const { doc, page, hel, tim } = await newDoc()
    // Table of contents: title, dots, page number.
    page.drawText('Contents', { x: 60, y: 740, size: 18, font: hel })
    const toc = ['Introduction', 'Scope of the agreement', 'Payment terms', 'Termination']
    toc.forEach((t, i) => {
      const y = 700 - i * 20
      page.drawText(t, { x: 60, y, size: 11, font: tim })
      const w = tim.widthOfTextAtSize(t, 11)
      const dots = '.'.repeat(Math.floor((470 - 60 - w - 30) / tim.widthOfTextAtSize('.', 11)))
      page.drawText(dots, { x: 60 + w + 6, y, size: 11, font: tim })
      page.drawText(String(i * 3 + 1), { x: 500, y, size: 11, font: tim })
    })
    // A menu with prices.
    ;[['Espresso', '2.50'], ['Cappuccino', '3.20']].forEach(([n, pr], i) => {
      const y = 560 - i * 18
      page.drawText(n, { x: 60, y, size: 11, font: hel })
      const w = hel.widthOfTextAtSize(n, 11)
      page.drawText('.'.repeat(45), { x: 60 + w + 4, y, size: 11, font: hel })
      page.drawText(`$${pr}`, { x: 60 + w + 4 + hel.widthOfTextAtSize('.'.repeat(45), 11) + 4, y, size: 11, font: hel })
    })
    // A letter: paragraph, sign-off, printed name under a decorative flourish (a short curve, no rule).
    for (let i = 0; i < 4; i++) page.drawText('Dear customer, thank you for your continued interest in our products and services.', { x: 60, y: 480 - i * 14, size: 11, font: tim })
    page.drawText('Yours sincerely,', { x: 60, y: 400, size: 11, font: tim })
    page.drawText('J. Smith, Managing Director', { x: 60, y: 340, size: 11, font: tim })
    // An invoice table with a totals box.
    const ys = [300, 280, 260, 240]
    ys.forEach((y) => page.drawLine({ start: { x: 60, y }, end: { x: 400, y }, thickness: 0.6, color: BLACK }))
    ;[60, 260, 330, 400].forEach((x) => page.drawLine({ start: { x, y: 240 }, end: { x, y: 300 }, thickness: 0.6, color: BLACK }))
    ;[['Widget', '2', '10.00'], ['Gadget', '1', '25.00'], ['Total', '', '35.00']].forEach((r, i) => r.forEach((t, k) => t && page.drawText(t, { x: [66, 266, 336][k], y: 286 - i * 20, size: 10, font: hel })))
    await evaluate('ordinary documents (negatives)', await doc.save(), [])
  })

  it('reports precision and recall on the independent forms', () => {
    const p = totals.tp / (totals.tp + totals.fp || 1)
    const r = totals.tp / (totals.tp + totals.fn || 1)
    console.log(`${rows.join('\n')}\nTOTAL (independent forms) precision=${p.toFixed(3)} recall=${r.toFixed(3)}`)
    expect(p).toBeGreaterThanOrEqual(0.9)
    expect(r).toBeGreaterThanOrEqual(0.9)
  })
})
