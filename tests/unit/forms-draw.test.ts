import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream, degrees, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { dateLabel, drawDateAt, drawStamp, drawTextBlock, wrapText } from '../../src/renderer/src/features/forms/draw'
import { UnsupportedCharactersError, fontForText, unsupportedChars, helvetica } from '../../src/renderer/src/features/forms/fonts'
import { PageGeometry, pageMatrix } from '../../src/renderer/src/features/forms/geometry'

const provider = async (): Promise<Uint8Array> => new Uint8Array(readFileSync(join('resources', 'fonts', 'NotoSans-Regular.ttf')))

async function blank(rotation = 0): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  if (rotation) page.setRotation(degrees(rotation))
  return pdf
}

async function content(pdf: PDFDocument): Promise<string> {
  const re = await PDFDocument.load(await pdf.save())
  const c = re.getPage(0).node.Contents()
  const streams: PDFStream[] = []
  if (c instanceof PDFRawStream) streams.push(c)
  else if (c) for (let i = 0; i < (c as unknown as { size(): number }).size(); i++) streams.push(re.context.lookup((c as unknown as { get(i: number): never }).get(i)) as PDFStream)
  return streams.map((s) => Buffer.from(decodePDFRawStream(s as never).decode()).toString('latin1')).join('\n')
}

const geom = (rot: number): PageGeometry => new PageGeometry(pageMatrix([0, 0, 612, 792], rot, 1), rot as 0)
const hexOf = (s: string): string => Buffer.from(s, 'latin1').toString('hex').toUpperCase()

describe('font choice', () => {
  it('uses Helvetica for WinAnsi text and the embedded Unicode font otherwise', async () => {
    const pdf = await blank()
    expect((await fontForText(pdf, 'Hello café', provider)).name).toBe(StandardFonts.Helvetica)
    const u = await fontForText(pdf, 'Привет', provider)
    expect(u.name).not.toBe(StandardFonts.Helvetica)
  })

  it('refuses text no bundled font can draw', async () => {
    const pdf = await blank()
    await expect(fontForText(pdf, 'hello 世界', provider)).rejects.toBeInstanceOf(UnsupportedCharactersError)
    const err = await fontForText(pdf, 'x 世 界', provider).catch((e: UnsupportedCharactersError) => e)
    expect((err as UnsupportedCharactersError).chars).toEqual(['世', '界'])
  })

  it('reports unsupported characters once and ignores newlines/tabs', async () => {
    const h = await helvetica(await blank())
    expect(unsupportedChars(h, 'a\nb\tc')).toEqual([])
    expect(unsupportedChars(h, 'ΩΩ日')).toEqual(['Ω', '日'])
  })
})

describe('wrapText', () => {
  const font = { widthOfTextAtSize: (s: string, size: number) => s.length * size * 0.5 }
  it('wraps at word boundaries and keeps explicit newlines', () => {
    expect(wrapText('aaa bbb ccc', font, 10, 20)).toEqual(['aaa', 'bbb', 'ccc'])
    expect(wrapText('aaa bbb ccc', font, 10, 50)).toEqual(['aaa bbb', 'ccc'])
    expect(wrapText('one\n\ntwo', font, 10, 200)).toEqual(['one', '', 'two'])
  })
  it('breaks a word wider than the box', () => {
    expect(wrapText('abcdefghij', font, 10, 25)).toEqual(['abcde', 'fghij'])
  })
})

describe('drawTextBlock', () => {
  it('draws the text into the page content at the box position', async () => {
    const pdf = await blank()
    const frame = geom(0).frameOfBox({ left: 100, top: 100, width: 200, height: 40 })
    const lines = await drawTextBlock(pdf, 0, frame, 'Hello stamp', { size: 12, color: '#000000' }, provider)
    expect(lines).toBe(1)
    const c = await content(pdf)
    expect(c).toContain(hexOf('Hello stamp'))
    // Baseline is below the top of the box (y = 792 - 100 - ~0.95 * 12) and starts at x = 100.
    const m = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(c)!
    expect(Number(m[1])).toBeCloseTo(100, 1)
    expect(Number(m[2])).toBeGreaterThan(792 - 100 - 14)
    expect(Number(m[2])).toBeLessThan(792 - 100 - 8)
  })

  it('wraps long text inside the box and stacks lines downward', async () => {
    const pdf = await blank()
    const frame = geom(0).frameOfBox({ left: 50, top: 50, width: 60, height: 80 })
    const lines = await drawTextBlock(pdf, 0, frame, 'alpha beta gamma delta epsilon', { size: 12, color: '#ff0000' }, provider)
    expect(lines).toBeGreaterThan(2)
    const ys = [...(await content(pdf)).matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map((m) => Number(m[1]))
    expect([...ys].sort((a, b) => b - a)).toEqual(ys) // each line lower than the previous
  })

  it('writes non-WinAnsi text with an embedded font and stays valid after a reload', async () => {
    const pdf = await blank()
    const frame = geom(0).frameOfBox({ left: 50, top: 50, width: 200, height: 30 })
    await drawTextBlock(pdf, 0, frame, 'Привіт світе', { size: 14, color: '#000000' }, provider)
    const re = await PDFDocument.load(await pdf.save())
    const fonts = [...re.context.enumerateIndirectObjects()].filter(([, o]) => (o as unknown as { get?(n: PDFName): unknown }).get?.(PDFName.of('Subtype'))?.toString() === '/Type0')
    expect(fonts.length).toBe(1)
  })

  it('rotates the text with the page so it reads upright on screen', async () => {
    for (const rot of [90, 180, 270]) {
      const pdf = await blank(rot)
      const frame = geom(rot).frameOfBox({ left: 100, top: 100, width: 100, height: 20 })
      await drawTextBlock(pdf, 0, frame, 'Upright', { size: 12, color: '#000000' }, provider)
      const c = await content(pdf)
      const m = /([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) Tm/.exec(c)!
      const [a, b] = [Number(m[1]), Number(m[2])]
      const angle = (Math.round((Math.atan2(b, a) * 180) / Math.PI) + 360) % 360
      expect(angle).toBe(rot)
    }
  })

  it('rejects blank text and a missing page', async () => {
    const pdf = await blank()
    const frame = geom(0).frameOfBox({ left: 0, top: 0, width: 10, height: 10 })
    await expect(drawTextBlock(pdf, 0, frame, '   ', { size: 12, color: '#000000' }, provider)).rejects.toThrow(/no text/)
    await expect(drawTextBlock(pdf, 3, frame, 'x', { size: 12, color: '#000000' }, provider)).rejects.toThrow(/no longer exists/)
  })
})

describe('stamps', () => {
  it('draws a check mark, cross and dot as vector paths', async () => {
    const pdf = await blank()
    await drawStamp(pdf, 0, 'check', [200, 400], 0, { size: 12, color: '#00aa00' }, provider)
    await drawStamp(pdf, 0, 'cross', [250, 400], 0, { size: 12, color: '#ff0000' }, provider)
    await drawStamp(pdf, 0, 'dot', [300, 400], 0, { size: 12, color: '#000000' }, provider)
    const c = await content(pdf)
    expect((c.match(/ l\b/g) ?? []).length).toBe(4) // two segments per mark
    expect(c).toMatch(/0 0.6\d* 0 RG/) // check mark color
    expect(c).toContain(' c') // circle = Bézier curves
  })

  it('draws today’s date as text', async () => {
    const pdf = await blank()
    const label = dateLabel(new Date(2026, 8, 25), 'en-US')
    expect(label).toBe('Sep 25, 2026')
    await drawStamp(pdf, 0, 'date', [300, 400], 0, { size: 12, color: '#000000' }, provider, label)
    expect(await content(pdf)).toContain(hexOf('Sep 25, 2026'))
  })

  it('stamps stay upright on rotated pages', async () => {
    const pdf = await blank(90)
    await drawStamp(pdf, 0, 'date', [300, 400], 90, { size: 12, color: '#000000' }, provider, '2026')
    const m = /([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) Tm/.exec(await content(pdf))!
    expect(Math.round((Math.atan2(Number(m[2]), Number(m[1])) * 180) / Math.PI)).toBe(90)
  })
})

describe('drawDateAt', () => {
  it('places the label relative to a frame', async () => {
    const pdf = await blank()
    await drawDateAt(pdf, 0, { origin: [100, 200], rotation: 0 }, 5, -11, 10, '#000000', provider, 'Jan 1, 2026')
    const m = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(await content(pdf))!
    expect(Number(m[1])).toBeCloseTo(105, 1)
    expect(Number(m[2])).toBeCloseTo(189, 1)
  })
})
