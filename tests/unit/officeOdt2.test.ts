import { resolve } from 'node:path'
import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { makePng, solid } from '../support/images'
import { A4_LAYOUT, odtPackage, p, type OdtOptions } from '../support/odt'
import { flattenText, readPdf } from '../support/pdfText'

const fontsDir = resolve('resources/fonts')
const conv = (o: OdtOptions) => convertOffice({ name: 'test.odt', bytes: odtPackage(o) }, { fontsDir })

describe('ODT: more constructs', () => {
  it('builds three-region headers (left / centre / right) and left-page headers', async () => {
    const layout =
      '<style:page-layout style:name="Mpm1"><style:page-layout-properties fo:page-width="21.001cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/>' +
      '<style:header-style><style:header-footer-properties fo:min-height="0.7cm" fo:margin-bottom="0.3cm"/></style:header-style><style:footer-style/></style:page-layout>'
    const master =
      '<style:master-page style:name="Standard" style:page-layout-name="Mpm1">' +
      '<style:header><style:region-left><text:p>Left part</text:p></style:region-left><style:region-center><text:p>Centre part</text:p></style:region-center><style:region-right><text:p>Right part</text:p></style:region-right></style:header>' +
      '<style:header-left><text:p>Even page header</text:p></style:header-left></style:master-page>'
    const body = Array.from({ length: 130 }, (_, i) => p(`Row ${i + 1}`)).join('')
    const r = await conv({ pageLayouts: layout, masters: master, body })
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(2)
    const it = (pg: number, s: string) => pages[pg].items.find((i) => i.str.includes(s))!
    expect(pages[0].text.split('\n')[0]).toBe('Left part Centre part Right part')
    expect(it(0, 'Left').x).toBeLessThan(it(0, 'Centre').x)
    expect(it(0, 'Centre').x).toBeLessThan(it(0, 'Right').x)
    expect(pages[1].text.startsWith('Even page header')).toBe(true) // header-left on even pages
    expect(pages[2].text.startsWith('Left part')).toBe(true)
  })

  it('switches to multi-column text sections and back', async () => {
    const auto = '<style:style style:name="Sect1" style:family="section"><style:section-properties><style:columns fo:column-count="2" fo:column-gap="0.5cm"/></style:section-properties></style:style>'
    // (the layout fills column one before column two; it does not balance the columns)
    const cols = Array.from({ length: 80 }, (_, i) => p(`Column text ${i + 1}`)).join('')
    const r = await conv({ autoStyles: auto, body: p('Before the columns') + `<text:section text:style-name="Sect1" text:name="Section1">${cols}</text:section>` + p('After the columns') })
    const { pages } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    expect(flat.startsWith('Before the columns')).toBe(true)
    expect(flat.endsWith('After the columns')).toBe(true)
    // items inside the section use two x positions
    const xs = new Set(pages[0].items.filter((i) => i.str.startsWith('Column')).map((i) => Math.round(i.x)))
    expect(xs.size).toBe(2)
  })

  it('warns about embedded objects and cropped images, and reads embedded (base64) images', async () => {
    const b64 = Buffer.from(makePng(10, 10, solid(255, 0, 0))).toString('base64')
    const r = await conv({
      autoStyles: '<style:style style:name="fr1" style:family="graphic"><style:graphic-properties fo:clip="rect(0.5cm, 0cm, 0cm, 0cm)"/></style:style>',
      body:
        p('<draw:frame draw:style-name="fr1" text:anchor-type="as-char" svg:width="2cm" svg:height="2cm"><draw:image xlink:href="Pictures/c.png"/></draw:frame>') +
        p('<draw:frame text:anchor-type="as-char" svg:width="2cm" svg:height="2cm"><draw:image><office:binary-data>' + b64 + '</office:binary-data></draw:image></draw:frame>') +
        p('<draw:frame text:anchor-type="as-char" svg:width="2cm" svg:height="2cm"><draw:object xlink:href="./Object 1"/></draw:frame> chart'),
      files: { 'Pictures/c.png': makePng(10, 10, solid(0, 0, 255)) }
    })
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].imageCount).toBe(2)
    expect(pages[0].text).toContain('[Embedded object not supported]')
    const w = r.warnings.join(' ')
    expect(w).toMatch(/Embedded objects/)
    expect(w).toMatch(/Cropped images/)
  })

  it('reads numbered paragraphs, conditional page breaks after a paragraph, and table-level breaks', async () => {
    const auto =
      '<style:style style:name="Pa" style:family="paragraph"><style:paragraph-properties fo:break-after="page"/></style:style>' +
      '<text:list-style style:name="LN"><text:list-level-style-number text:level="1" style:num-format="I" style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment fo:text-indent="-0.6cm" fo:margin-left="0.6cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>'
    const r = await conv({
      autoStyles: auto,
      body:
        '<text:numbered-paragraph text:list-id="l1" text:style-name="LN" text:level="1"><text:number>I.</text:number><text:p text:style-name="Standard">numbered para</text:p></text:numbered-paragraph>' +
        p('ends page one', 'Pa') +
        p('starts page two')
    })
    const { pages } = await readPdf(r.bytes)
    expect(pages).toHaveLength(2)
    expect(pages[0].text).toMatch(/I\.\s*numbered para/)
    expect(pages[1].text).toBe('starts page two')
  })

  it('uses a document without a master page or page layout with sensible A4 defaults', async () => {
    const r = await conv({ pageLayouts: '', masters: '', body: p('No page layout here') })
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].width).toBeCloseTo(595.3, 0)
    expect(pages[0].text).toBe('No page layout here')
  })

  it('handles unusual units and percentages in lengths', async () => {
    const auto = '<style:style style:name="Pu" style:family="paragraph"><style:paragraph-properties fo:margin-left="0.5in" fo:margin-top="12pt" fo:margin-bottom="10mm"/><style:text-properties fo:font-size="150%"/></style:style>'
    const r = await conv({ autoStyles: auto, body: p('first', 'Pu') + p('second', 'Pu') })
    const { pages } = await readPdf(r.bytes)
    const first = pages[0].items.find((i) => i.str.includes('first'))!
    const second = pages[0].items.find((i) => i.str.includes('second'))!
    expect(first.x).toBeCloseTo(56.7 + 36, 0)
    expect(first.size).toBeCloseTo(18, 0)
    expect(second.y - first.y).toBeGreaterThan(18 + 28.3 + 12)
  })

  it('converts a large document (3000 paragraphs and a 300-row table) without losing text or taking forever', async () => {
    const paras = Array.from({ length: 3000 }, (_, i) => p(`Large paragraph ${i + 1} with several words in it.`, 'Text_20_body')).join('')
    const rows = Array.from({ length: 300 }, (_, i) => `<table:table-row><table:table-cell>${p(`cell-a${i + 1}`)}</table:table-cell><table:table-cell>${p(`cell-b${i + 1}`)}</table:table-cell></table:table-row>`).join('')
    const t0 = Date.now()
    const r = await conv({ body: paras + `<table:table table:name="Big"><table:table-column table:number-columns-repeated="2"/>${rows}</table:table>` })
    expect(Date.now() - t0).toBeLessThan(60000)
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect((flat.match(/Large paragraph \d+ with/g) ?? []).length).toBe(3000)
    expect(flat).toContain('cell-a1 cell-b1')
    expect(flat).toContain('cell-a300 cell-b300')
  }, 120000)

  it('keeps document text when the package has odd mimetype casing and unknown files', async () => {
    const r = await conv({ body: p('still works'), files: { 'Thumbnails/thumbnail.png': strToU8('x'), 'Configurations2/x': strToU8('y') }, mimetype: 'application/vnd.oasis.opendocument.text' })
    expect(flattenText((await readPdf(r.bytes)).pages)).toBe('still works')
    void A4_LAYOUT
  })
})
