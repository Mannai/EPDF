import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { drawDateAt, drawStamp, drawTextBlock } from '../../src/renderer/src/features/forms/draw'
import { UnsupportedCharactersError } from '../../src/renderer/src/features/forms/fonts'
import { PageGeometry, pageMatrix } from '../../src/renderer/src/features/forms/geometry'
import { drawText } from '../../src/shared/text'
import { norm, pageModel, type0Fonts } from '../support/retrofit'

/** "Add text", the date stamp and the date next to a signature, in Arabic, Hebrew, mixed and other scripts. */

const provider = async (): Promise<Uint8Array> => new Uint8Array()
const geom = (rot: number): PageGeometry => new PageGeometry(pageMatrix([0, 0, 612, 792], rot, 1), rot as 0)

async function blank(rotation = 0): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  if (rotation) page.setRotation(degrees(rotation))
  return pdf
}

describe('Add text in any script', () => {
  it('Arabic wraps inside the box, right-aligned, and reads back in logical order', async () => {
    const pdf = await blank()
    const frame = geom(0).frameOfBox({ left: 100, top: 100, width: 160, height: 80 })
    const text = 'هذا نص عربي يضاف إلى الصفحة ويلتف داخل المربع بشكل صحيح'
    const n = await drawTextBlock(pdf, 0, frame, text, { size: 12, color: '#000000' }, provider)
    expect(n).toBeGreaterThan(1)
    const bytes = await pdf.save()
    const m = await pageModel(bytes)
    expect(norm(m.text)).toBe(norm(text))
    for (const l of m.lines) {
      expect(l.dir).toBe('rtl')
      expect(l.x1).toBeGreaterThan(255) // right edge of the box (100 + 160)
      expect(l.x1).toBeLessThanOrEqual(260.5)
    }
    // first baseline where the Helvetica path puts it (just under the top of the box)
    expect(m.lines[0].baseline).toBeGreaterThan(100 + 8)
    expect(m.lines[0].baseline).toBeLessThan(100 + 14)
    mkdirSync(resolve('test-results/text-retrofit'), { recursive: true })
    writeFileSync(resolve('test-results/text-retrofit/addtext-arabic.pdf'), bytes)
  })

  it('mixed Arabic/English/numbers, Hebrew, Devanagari, Thai and CJK', async () => {
    for (const text of ['الإجمالي 1,250.00 BHD للفاتورة 42', 'שלום עולם 2026', 'नमस्ते दुनिया', 'สวัสดีครับ', '你好世界 こんにちは']) {
      const pdf = await blank()
      await drawTextBlock(pdf, 0, geom(0).frameOfBox({ left: 72, top: 72, width: 400, height: 30 }), text, { size: 14, color: '#ff0000' }, provider)
      const m = await pageModel(await pdf.save())
      expect(norm(m.text)).toBe(norm(text))
    }
  })

  it('stays upright on rotated pages', async () => {
    for (const rot of [90, 180, 270]) {
      const pdf = await blank(rot)
      await drawTextBlock(pdf, 0, geom(rot).frameOfBox({ left: 100, top: 100, width: 200, height: 30 }), 'مرحبا بالعالم', { size: 14, color: '#000000' }, provider)
      const m = await pageModel(await pdf.save())
      expect(norm(m.text)).toBe('مرحبا بالعالم')
      expect(Math.abs(m.lines[0].angle)).toBeLessThan(1)
    }
  })

  it('refuses characters no bundled font has, before changing the page', async () => {
    const pdf = await blank()
    await expect(drawTextBlock(pdf, 0, geom(0).frameOfBox({ left: 0, top: 0, width: 100, height: 20 }), 'བོད་ཡིག', { size: 12, color: '#000000' }, provider)).rejects.toBeInstanceOf(UnsupportedCharactersError)
    expect(pdf.getPage(0).node.Contents()).toBeUndefined()
  })

  it('Latin keeps Helvetica (no embedded font)', async () => {
    const pdf = await blank()
    await drawTextBlock(pdf, 0, geom(0).frameOfBox({ left: 100, top: 100, width: 200, height: 40 }), 'Hello café', { size: 12, color: '#000000' }, provider)
    expect(type0Fonts(await PDFDocument.load(await pdf.save()))).toHaveLength(0)
  })

  it('a second Add text in a later edit step never takes over the first one’s font name', async () => {
    const pdf = await blank()
    await drawTextBlock(pdf, 0, geom(0).frameOfBox({ left: 72, top: 72, width: 300, height: 30 }), 'مرحبا', { size: 14, color: '#000000' }, provider)
    const step2 = await PDFDocument.load(await pdf.save()) // a new PDFDocument: its engine fonts start at EpdfF1 again
    await drawTextBlock(step2, 0, geom(0).frameOfBox({ left: 72, top: 200, width: 300, height: 30 }), 'שלום', { size: 14, color: '#000000' }, provider)
    const out = await PDFDocument.load(await step2.save())
    const fonts = out.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    expect(fonts.keys().map((k) => k.decodeText()).sort()).toEqual(['EpdfF1', 'EpdfF1_2'])
    const m = await pageModel(await out.save())
    expect(m.text.split('\n').map(norm)).toEqual(['مرحبا', 'שלום'])
  })
})

describe('date stamp and the date next to a signature', () => {
  it('an Arabic date stamp is centred on the click; the signature date starts at its frame', async () => {
    const pdf = await blank()
    const label = new Date(2026, 8, 26).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' })
    await drawStamp(pdf, 0, 'date', [300, 400], 0, { size: 12, color: '#000000' }, provider, label)
    await drawDateAt(pdf, 0, { origin: [100, 200], rotation: 0 }, 0, -11, 10, '#000000', provider, label)
    const m = await pageModel(await pdf.save())
    const lines = m.lines.map((l) => ({ l, t: norm(m.text.slice(l.start, l.end)) }))
    expect(lines.every((x) => x.t === norm(label))).toBe(true)
    const stamp = lines.find((x) => x.l.baseline < 792 - 300)!.l
    expect(Math.abs((stamp.x0 + stamp.x1) / 2 - 300)).toBeLessThan(1.5)
    const sig = lines.find((x) => x.l.baseline > 792 - 300)!.l
    expect(Math.abs(sig.x0 - 100)).toBeLessThan(1.5)
  })
})

describe('engine resource names on a page', () => {
  it('drawText picks a free name when the page already uses EpdfF1 for another font', async () => {
    const pdf = await blank()
    await drawText(pdf.getPage(0), 'مرحبا', { x: 72, y: 700, size: 14 })
    const again = await PDFDocument.load(await pdf.save())
    await drawText(again.getPage(0), 'שלום', { x: 72, y: 600, size: 14 })
    const m = await pageModel(await again.save())
    expect(m.text.split('\n').map(norm)).toEqual(['مرحبا', 'שלום'])
  })
})
