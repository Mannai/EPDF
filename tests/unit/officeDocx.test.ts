import { resolve } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { anchorImage, buildDocx, inlineImage, p, pageBreak, para, r, tbl, tc, tr, NUMBERING, type DocxParts } from '../support/docxBuilder'
import { makePng } from '../support/images'
import { flattenText, readPdf } from '../support/pdfText'

const fontsDir = resolve('resources/fonts')
const conv = (parts: DocxParts, name = 'test.docx', extra: Partial<Parameters<typeof convertOffice>[1]> = {}) => convertOffice({ name, bytes: buildDocx(parts) }, { fontsDir, ...extra })
const png = (w = 40, h = 30): Uint8Array => makePng(w, h, (x, y) => [x * 6, y * 8, 128, 255])

describe('docx: text, styles and fonts', () => {
  it('resolves docDefaults + styles: Calibri body maps to Carlito, Heading 1 is bold Cambria 16pt in colour', async () => {
    const res = await conv({ body: para('The Title', { style: 'Heading1' }) + para('Body paragraph text.') })
    const { pages } = await readPdf(res.bytes)
    expect(pages.length).toBe(1)
    expect(pages[0].width).toBeCloseTo(612)
    expect(pages[0].text).toBe('The Title\nBody paragraph text.')
    const [h, b] = pages[0].items.filter((i) => i.str)
    expect(h.size).toBeCloseTo(16, 0)
    expect(h.font).toMatch(/Caladea-Bold/)
    expect(b.size).toBeCloseTo(11, 0)
    expect(b.font).toMatch(/Carlito-Regular/)
    // 1 inch margins
    expect(b.x).toBeCloseTo(72, 0)
    expect(res.warnings).toEqual([])
  })

  it('resolves theme fonts and colours the way Word files reference them (asciiTheme / themeColor)', async () => {
    const theme = `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="x"><a:majorFont><a:latin typeface="Courier New"/></a:majorFont><a:minorFont><a:latin typeface="Times New Roman"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="000000" w:themeColor="accent1"/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`
    const res = await conv({ styles, theme, body: para('Body in the minor theme font') + para('Heading in the major theme font', { style: 'Heading1' }) })
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].items.find((i) => i.str.startsWith('Body'))!.font).toMatch(/LiberationSerif/)
    expect(pages[0].items.find((i) => i.str.startsWith('Heading'))!.font).toMatch(/LiberationMono/)
  })

  it('applies character formatting: bold, italic, underline, strike, colour, superscript, caps, highlight', async () => {
    const res = await conv({
      body: p([r('plain '), r('bold ', { b: true }), r('italic ', { i: true }), r('both', { b: true, i: true }), r(' x', {}), r('2', { vert: 'superscript' }), r(' shout', { caps: true }), r(' hi', { highlight: 'yellow' })])
    })
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].text).toContain('plain bold italic both x2 SHOUT hi')
    const fonts = pages[0].items.map((i) => i.font).join(' ')
    expect(fonts).toMatch(/Carlito-Bold/)
    expect(fonts).toMatch(/Carlito-Italic/)
    expect(fonts).toMatch(/Carlito-BoldItalic/)
    const sup = pages[0].items.find((i) => i.str === '2')!
    expect(sup.size).toBeLessThan(8)
  })

  it('aligns paragraphs left, centre, right and justified', async () => {
    const long = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(3)
    const res = await conv({ body: para('LEFT') + para('CENTRE', { jc: 'center' }) + para('RIGHT', { jc: 'right' }) + para(long, { jc: 'both' }) })
    const { pages } = await readPdf(res.bytes)
    const at = (s: string) => pages[0].items.find((i) => i.str === s)!
    const width = 612 - 144
    const w = (s: string) => (pages[0].items.find((i) => i.str === s)!.x)
    expect(w('LEFT')).toBeCloseTo(72, 0)
    expect(at('CENTRE').x).toBeGreaterThan(72 + width / 2 - 60)
    expect(at('CENTRE').x).toBeLessThan(72 + width / 2)
    expect(at('RIGHT').x).toBeGreaterThan(612 - 72 - 60)
    // justified body lines end flush at the right margin: the last word of the first line sits near x=540
    const lines = new Map<number, typeof pages[0]['items']>()
    for (const it of pages[0].items.filter((i) => i.str.trim())) {
      const y = Math.round(it.y)
      lines.set(y, [...(lines.get(y) ?? []), it])
    }
    const firstBody = [...lines.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).find((l) => l.some((i) => i.str.includes('Lorem')))!
    const rightEdge = Math.max(...firstBody.map((i) => i.x + i.w))
    expect(rightEdge).toBeGreaterThan(612 - 72 - 2) // justified: flush with the right margin
    expect(rightEdge).toBeLessThan(612 - 72 + 2)
  })

  it('does not lose any text in a long document and paginates', async () => {
    const paras = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1}: ` + 'the quick brown fox jumps over the lazy dog. '.repeat(1 + (i % 5)))
    const res = await conv({ body: paras.map((t) => para(t)).join('') })
    const { pages } = await readPdf(res.bytes)
    expect(pages.length).toBeGreaterThan(8)
    expect(flattenText(pages)).toBe(paras.join(' ').replace(/\s+/g, ' ').trim())
    // nothing spills below the bottom margin or above the top
    for (const pg of pages) for (const it of pg.items.filter((i) => i.str.trim())) {
      expect(it.y).toBeLessThan(792 - 60)
      expect(it.y).toBeGreaterThan(60)
    }
  })

  it('honours explicit page breaks, page-break-before and section page sizes', async () => {
    const landscape = '<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>'
    const body =
      para('Page one') + p(pageBreak()) + para('Page two') + para('Page three', { pageBreakBefore: true }) +
      p(r('end of portrait section'), { sectPr: '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' }) +
      para('Landscape section')
    const res = await conv({ body, sectPr: landscape })
    const { pages } = await readPdf(res.bytes)
    expect(pages.map((pg) => pg.text.split('\n')[0])).toEqual(['Page one', 'Page two', 'Page three\nend of portrait section'.split('\n')[0], 'Landscape section'].slice(0, 4))
    expect(pages.length).toBe(4)
    expect([pages[2].width, pages[2].height]).toEqual([612, 792].map((n) => expect.closeTo(n, 0)))
    expect(pages[3].width).toBeCloseTo(792)
    expect(pages[3].height).toBeCloseTo(612)
  })

  it('keeps hyperlinks as URI link annotations', async () => {
    const res = await conv({
      body: p([r('See '), '<w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the site</w:t></w:r></w:hyperlink>', r(' now')]),
      rels: { rIdLink: { type: 'hyperlink', target: 'https://example.com/a?b=1&c=2', external: true } }
    })
    const doc = await PDFDocument.load(res.bytes)
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
    const a = annots.lookup(0, PDFDict).lookup(PDFName.of('A'), PDFDict)
    expect((a.lookup(PDFName.of('URI'), PDFString)).decodeText()).toBe('https://example.com/a?b=1&c=2')
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].text).toBe('See the site now')
  })

  it('omits tracked deletions, keeps insertions, and warns', async () => {
    const res = await conv({ body: p([r('keep '), '<w:del w:id="1" w:author="a"><w:r><w:delText>gone</w:delText></w:r></w:del>', '<w:ins w:id="2" w:author="a"><w:r><w:t>added</w:t></w:r></w:ins>']) })
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].text).toBe('keep added')
    expect(res.warnings.join(' ')).toMatch(/Tracked changes/)
  })
})

describe('docx: lists, tabs and footnotes', () => {
  it('numbers lists with their formats and bullets with a real bullet glyph', async () => {
    const res = await conv({
      numbering: NUMBERING,
      body:
        para('Bullet one', { style: 'ListParagraph', numId: 1 }) +
        para('Bullet two', { style: 'ListParagraph', numId: 1 }) +
        para('Sub bullet', { style: 'ListParagraph', numId: 1, ilvl: 1 }) +
        para('First', { numId: 2 }) + para('Second', { numId: 2 }) + para('Nested a', { numId: 2, ilvl: 1 }) + para('Nested b', { numId: 2, ilvl: 1 }) + para('Third', { numId: 2 }) +
        para('Restarted', { numId: 3 })
    })
    const { pages } = await readPdf(res.bytes)
    const t = pages[0].text
    expect(t).toMatch(/•\s*Bullet one/)
    expect(t).toMatch(/•\s*Bullet two/)
    expect(t).toMatch(/[◦○o]\s*Sub bullet/)
    expect(t).toMatch(/1\.\s*First/)
    expect(t).toMatch(/2\.\s*Second/)
    expect(t).toMatch(/a\)\s*Nested a/)
    expect(t).toMatch(/b\)\s*Nested b/)
    expect(t).toMatch(/3\.\s*Third/)
    expect(t).toMatch(/5\.\s*Restarted/)
    // hanging indent: label left of the text
    const label = pages[0].items.find((i) => i.str === '•')!
    const text = pages[0].items.find((i) => i.str.startsWith('Bullet one'))!
    expect(label.x).toBeLessThan(text.x)
    expect(text.x).toBeCloseTo(72 + 36, 0)
  })

  it('supports tab stops with leaders and right alignment', async () => {
    const res = await conv({
      body: p([r('Chapter'), '<w:r><w:tab/></w:r>', r('12')], { tabs: '<w:tab w:val="right" w:leader="dot" w:pos="9360"/>' })
    })
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].text).toContain('Chapter')
    expect(pages[0].text).toMatch(/Chapter\s*\.{5,}\s*12/)
    const tail = pages[0].items.find((i) => i.str.includes('12'))!
    expect(tail.x + tail.w).toBeGreaterThan(72 + 468 - 2) // right-aligned tab: the number ends at the right margin
    expect(tail.x + tail.w).toBeLessThan(72 + 468 + 2)
  })

  it('moves footnotes to the end with numbered markers and a warning', async () => {
    const foot = `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>The footnote text.</w:t></w:r></w:p></w:footnote></w:footnotes>`
    const res = await conv({ body: p([r('Body text'), '<w:r><w:footnoteReference w:id="1"/></w:r>', r(' continues.')]), footnotes: foot })
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].text).toContain('Body text1 continues.')
    expect(pages[0].text).toContain('1 The footnote text.')
    expect(res.warnings.join(' ')).toMatch(/Footnotes are shown at the end/)
  })
})

describe('docx: tables', () => {
  const grid = [3000, 3000, 3360]
  it('lays out cells in columns with borders, shading and spans', async () => {
    const t = tbl(
      [
        tr([tc(para('Name'), { w: 3000 }), tc(para('Qty'), { w: 3000 }), tc(para('Price'), { w: 3360 })]),
        tr([tc(para('Apple'), { w: 3000 }), tc(para('3'), { w: 3000 }), tc(para('$1.50'), { w: 3360, shd: 'FFFF00' })]),
        tr([tc(para('Merged across two columns'), { w: 6000, span: 2 }), tc(para('$9'), { w: 3360 })])
      ],
      grid,
      { style: 'TableGrid' }
    )
    const res = await conv({ body: para('Before') + t + para('After') })
    const { pages } = await readPdf(res.bytes)
    const it = (s: string) => pages[0].items.find((i) => i.str === s)!
    expect(it('Qty').x - it('Name').x).toBeCloseTo(150, 0) // 3000 twips
    expect(it('Price').x - it('Name').x).toBeCloseTo(300, 0)
    expect(it('$9').x).toBeCloseTo(it('Price').x, 0)
    // table style spacing (after=0) makes rows compact; the paragraph after the table follows below
    expect(it('After').y).toBeGreaterThan(it('$9').y)
    expect(it('Apple').y - it('Name').y).toBeLessThan(20)
    expect(pages[0].text).toContain('Merged across two columns')
  })

  it('applies table style conditional formatting (header row shading + bold, banded rows)', async () => {
    const rows = ['H1', 'H2'].length
    void rows
    const t = tbl(
      [tr([tc(para('H1'), { w: 4680 }), tc(para('H2'), { w: 4680 })]), tr([tc(para('a1'), { w: 4680 }), tc(para('a2'), { w: 4680 })]), tr([tc(para('b1'), { w: 4680 }), tc(para('b2'), { w: 4680 })])],
      [4680, 4680],
      { style: 'Banded' }
    )
    const res = await conv({ body: t })
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].items.find((i) => i.str === 'H1')!.font).toMatch(/Carlito-Bold/)
    expect(pages[0].text).toContain('a1')
  })

  it('repeats header rows on every page and never loses a row', async () => {
    const dataRows = Array.from({ length: 120 }, (_, i) => tr([tc(para(`row-${i + 1}`), { w: 3000 }), tc(para(`value ${i + 1}`), { w: 6360 })]))
    const t = tbl([tr([tc(para('HEADER A'), { w: 3000 }), tc(para('HEADER B'), { w: 6360 })], { header: true }), ...dataRows], [3000, 6360], { style: 'TableGrid' })
    const res = await conv({ body: t })
    const { pages } = await readPdf(res.bytes)
    expect(pages.length).toBeGreaterThan(2)
    for (const pg of pages) expect(pg.text).toContain('HEADER A')
    const flat = flattenText(pages)
    for (let i = 1; i <= 120; i++) expect(flat).toContain(`row-${i} value ${i}`)
  })

  it('splits a row taller than a page between its lines (no half-empty pages) and never loses a line', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => para(`Boxed line ${i + 1}`, { spacing: 'w:after="0"' }))
    const t = tbl([tr([tc(lines.join(''), { w: 9360 })])], [9360], { style: 'TableGrid' })
    const res = await conv({ body: para('Before the box') + t + para('After the box') })
    const { pages } = await readPdf(res.bytes)
    expect(pages.length).toBeGreaterThanOrEqual(5)
    const flat = flattenText(pages)
    for (let i = 1; i <= 250; i++) expect(flat).toContain(`Boxed line ${i} `)
    expect(flat).toContain('After the box')
    // the box keeps flowing over pages: every page but the last is filled down to the bottom margin
    for (const pg of pages.slice(0, -1)) {
      const ys = pg.items.filter((it) => it.str.trim()).map((it) => it.y)
      expect(Math.max(...ys)).toBeGreaterThan(792 - 72 - 20)
    }
  })

  it('handles vertical merges and nested tables', async () => {
    const inner = tbl([tr([tc(para('inner1'), { w: 2000 }), tc(para('inner2'), { w: 2000 })])], [2000, 2000], { style: 'TableGrid' })
    const t = tbl(
      [
        tr([tc(para('tall'), { w: 3000, vMerge: 'restart' }), tc(para('r1c2'), { w: 6000 })]),
        tr([tc('', { w: 3000, vMerge: 'continue' }), tc(inner + para(''), { w: 6000 })])
      ],
      [3000, 6000],
      { style: 'TableGrid' }
    )
    const res = await conv({ body: t })
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].text.replace(/\n/g, ' ')).toMatch(/tall.*r1c2|r1c2.*tall/)
    expect(pages[0].text).toContain('inner1')
    expect(pages[0].text).toContain('inner2')
  })
})

describe('docx: headers, footers, images, fields', () => {
  it('draws headers and footers with PAGE / NUMPAGES on every page, first-page variants included', async () => {
    const sect =
      '<w:sectPr><w:headerReference w:type="default" r:id="rId_header1.xml"/><w:footerReference w:type="default" r:id="rId_footer1.xml"/><w:headerReference w:type="first" r:id="rId_header2.xml"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:titlePg/></w:sectPr>'
    const pageField = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
    const numPages = '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
    const res = await conv({
      sectPr: sect,
      headers: { 'header1.xml': p(r('Running header'), { jc: 'right' }), 'header2.xml': p(r('Title page header')) },
      footers: { 'footer1.xml': p([r('Page '), pageField, r(' of '), numPages], { jc: 'center' }) },
      body: Array.from({ length: 150 }, (_, i) => para(`Line number ${i + 1} of the body text`)).join('')
    })
    const { pages } = await readPdf(res.bytes)
    const n = pages.length
    expect(n).toBeGreaterThan(2)
    expect(pages[0].text).toContain('Title page header')
    expect(pages[0].text).not.toContain('Running header')
    expect(pages[0].text).not.toContain('Page 1 of')
    for (let i = 1; i < n; i++) {
      expect(pages[i].text).toContain('Running header')
      expect(pages[i].text.replace(/\s+/g, ' ')).toContain(`Page ${i + 1} of ${n}`)
    }
    // body text still complete
    expect(flattenText(pages)).toContain('Line number 150 of the body text')
  })

  it('embeds inline and floating PNG images and keeps text flowing', async () => {
    const res = await conv({
      media: { 'image1.png': png(60, 40), 'image2.png': png(30, 30) },
      rels: { rIdImg1: { type: 'image', target: 'media/image1.png' }, rIdImg2: { type: 'image', target: 'media/image2.png' } },
      body: p([r('Inline: '), inlineImage('rIdImg1', 120, 80)]) + p([anchorImage('rIdImg2', 50, 50, { behind: true, hFrom: 'page', vFrom: 'page', hOff: 400, vOff: 30 }), r('Text after the floating image.')])
    })
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].imageCount).toBe(2)
    expect(pages[0].text).toContain('Text after the floating image.')
    expect(res.warnings).toEqual([])
  })

  it('shows a placeholder and a warning for unsupported image formats and charts', async () => {
    const emf = new Uint8Array(100)
    emf[0] = 1
    emf[40] = 0x20
    emf[41] = 0x45
    emf[42] = 0x4d
    emf[43] = 0x46
    const res = await conv({
      media: { 'image1.emf': emf },
      rels: { rIdE: { type: 'image', target: 'media/image1.emf' } },
      body: p([r('before '), inlineImage('rIdE', 50, 50, 1, 'logo'), r(' after')])
    })
    const { pages } = await readPdf(res.bytes)
    expect(pages[0].text).toContain('[Image: logo]')
    expect(pages[0].text).toContain('after')
    expect(res.warnings.join(' ')).toMatch(/EMF/)
  })

  it('reports non-docx input clearly', async () => {
    await expect(convertOffice({ name: 'broken.docx', bytes: new TextEncoder().encode('not a zip') }, { fontsDir })).rejects.toThrow(/damaged or is not a valid Office file/)
    const emptyZip = buildDocx({ body: '' })
    await expect(convertOffice({ name: 'x.docx', bytes: emptyZip.slice(0, 20) }, { fontsDir })).rejects.toThrow()
  })
})
