import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { detectLinks, detectOnLines } from '../../src/renderer/src/features/links/pdf/detect'
import { INVISIBLE_BORDER } from '../../src/renderer/src/features/links/pdf/model'
import { addLink } from '../../src/renderer/src/features/links/pdf/ops'
import { readLinks } from '../../src/renderer/src/features/links/pdf/read'
import { pageLines } from '../../src/renderer/src/features/bookmarks/pdf/pageLines'
import { linksDoc } from '../fixtures/lbFixtures'
import { UniFont } from './helpers/lbDocs'

describe('finding web and e-mail addresses in a document', () => {
  it('finds each address with a box that hugs its text, in reading order', async () => {
    const pdf = await PDFDocument.load(await linksDoc())
    const { found, stopped } = await detectLinks(pdf)
    expect(stopped).toBe(false)
    expect(found.map((f) => [f.pageIndex, f.text, f.url, f.kind, f.covered])).toEqual([
      [0, 'https://example.com/docs', 'https://example.com/docs', 'web', false],
      [0, 'support@example.com', 'mailto:support@example.com', 'email', false],
      [0, 'www.example.org/about', 'https://www.example.org/about', 'web', false]
    ])
    // Line 1 is "Visit https://example.com/docs for the documentation." at 12 pt Helvetica from x = 72, baseline 700.
    const [web] = found
    expect(web.rect[0]).toBeGreaterThan(72 + 25) // after "Visit " (about 30 pt)
    expect(web.rect[0]).toBeLessThan(72 + 40)
    expect(web.rect[2]).toBeGreaterThan(web.rect[0] + 100)
    expect(web.rect[2]).toBeLessThan(72 + 190)
    expect(web.rect[1]).toBeLessThan(700)
    expect(web.rect[3]).toBeGreaterThan(700)
    expect(web.rect[3] - web.rect[1]).toBeLessThan(20)
  })

  it('marks addresses that already have a link, and leaves the rest', async () => {
    const pdf = await PDFDocument.load(await linksDoc())
    const first = (await detectLinks(pdf)).found
    addLink(pdf, 0, { rect: first[0].rect, target: { kind: 'uri', uri: first[0].url }, border: INVISIBLE_BORDER })
    const again = (await detectLinks(await PDFDocument.load(await pdf.save()))).found
    expect(again.map((f) => f.covered)).toEqual([true, false, false])
  })

  it('reports progress and can be stopped', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < 40; i++) doc.addPage([612, 792]).drawText(`see https://example.org/page${i} now`, { x: 72, y: 700, size: 12, font })
    const pdf = await PDFDocument.load(await doc.save())
    let stops = 0
    const res = await detectLinks(pdf, { shouldStop: () => ++stops > 5 })
    expect(res.stopped).toBe(true)
    expect(res.found.length).toBeLessThan(40)
    const all = await detectLinks(pdf)
    expect(all.found).toHaveLength(40)
    expect(all.found[39].url).toBe('https://example.org/page39')
  })

  it('works on rotated pages (positions stay in unrotated PDF space)', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const p = doc.addPage([612, 792])
    p.drawText('Go to https://rotated.example/x please', { x: 100, y: 300, size: 14, font })
    p.setRotation(degrees(90))
    const { found } = await detectLinks(await PDFDocument.load(await doc.save()))
    expect(found).toHaveLength(1)
    expect(found[0].rect[0]).toBeGreaterThan(100)
    expect(found[0].rect[1]).toBeLessThan(300)
    expect(found[0].rect[3]).toBeGreaterThan(300)
  })

  it('finds addresses inside Arabic and Hebrew sentences (text stored in a Unicode font)', async () => {
    const doc = await PDFDocument.create()
    const font = new UniFont(doc, 'U1', 'ABCDEF+NotoNaskhArabic-Regular')
    const page = doc.addPage([612, 792])
    // Draw two runs of a right-to-left line: Arabic words, then an address, using the synthetic font.
    const { PDFHexString, PDFName, PDFOperator, PDFOperatorNames, beginText, endText, setFontAndSize, setTextMatrix } = await import('pdf-lib')
    const draw = (text: string, x: number): void => {
      page.node.setFontDictionary(PDFName.of(font.key), font.ref)
      page.pushOperators(beginText(), setFontAndSize(font.key, 12), setTextMatrix(1, 0, 0, 1, x, 700), PDFOperator.of(PDFOperatorNames.ShowText, [PDFHexString.of(font.hex(text))]), endText())
    }
    draw('راسلونا على info@example.com للمزيد', 72)
    font.finalize()
    const pdf = await PDFDocument.load(await doc.save())
    const lines = pageLines(pdf, 0).lines
    const found = detectOnLines(lines, 0, [])
    expect(found.map((f) => f.text)).toEqual(['info@example.com'])
    expect(readLinks(pdf)).toHaveLength(0)
  })
})
