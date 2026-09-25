import { resolve } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { makePng, solid } from '../support/images'
import { A4_LAYOUT, odtPackage, p, type OdtOptions } from '../support/odt'
import { flattenText, readPdf } from '../support/pdfText'

const fontsDir = resolve('resources/fonts')
const run = (bytes: Uint8Array, name = 'test.odt') => convertOffice({ name, bytes }, { fontsDir })
const conv = (o: OdtOptions) => run(odtPackage(o))
const item = (page: { items: { str: string; x: number; y: number; w: number; size: number; font: string }[] }, s: string) => page.items.find((i) => i.str.includes(s))!

describe('ODT: text, styles and formatting', () => {
  it('converts headings and paragraphs with resolved style inheritance', async () => {
    const r = await conv({
      body:
        '<text:h text:style-name="Heading_20_1" text:outline-level="1">Main heading</text:h>' +
        p('Body text in the default serif font.', 'Text_20_body') +
        '<text:h text:style-name="Heading_20_2" text:outline-level="2">Sub heading</text:h>',
      title: 'My Document'
    })
    expect(r.warnings).toEqual([])
    const { pages } = await readPdf(r.bytes)
    expect(pages).toHaveLength(1)
    expect(pages[0].width).toBeCloseTo(595.3, 0)
    expect(pages[0].height).toBeCloseTo(841.9, 0)
    expect(pages[0].text).toBe('Main heading\nBody text in the default serif font.\nSub heading')
    const h1 = item(pages[0], 'Main heading')
    const body = item(pages[0], 'Body text')
    const h2 = item(pages[0], 'Sub heading')
    expect(h1.font).toMatch(/LiberationSans-Bold/) // Heading -> Liberation Sans, Heading 1 -> bold 130% of 14pt
    expect(h1.size).toBeCloseTo(18.2, 0)
    expect(h2.size).toBeCloseTo(16.1, 0)
    expect(body.font).toMatch(/LiberationSerif/)
    expect(body.size).toBeCloseTo(12, 0)
    expect(body.x).toBeCloseTo(56.7, 0) // 2 cm margin
  })

  it('applies automatic paragraph/text styles, bold/italic/underline/strike, colours and sub/superscript', async () => {
    const auto =
      '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>' +
      '<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic" fo:color="#ff0000"/></style:style>' +
      '<style:style style:name="T3" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-line-through-style="solid" fo:font-size="20pt"/></style:style>' +
      '<style:style style:name="T4" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>' +
      '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-name="Liberation Mono" fo:font-size="10pt"/></style:style>'
    const r = await conv({
      autoStyles: auto,
      body: p('plain <text:span text:style-name="T1">bold</text:span> <text:span text:style-name="T2">italic red</text:span> <text:span text:style-name="Strong_20_Emphasis">strong</text:span> <text:span text:style-name="T3">big</text:span> x<text:span text:style-name="T4">2</text:span>') + p('centered mono', 'P1')
    })
    const { pages } = await readPdf(r.bytes)
    expect(item(pages[0], 'bold').font).toMatch(/LiberationSerif-Bold/)
    expect(item(pages[0], 'italic red').font).toMatch(/Italic/)
    expect(item(pages[0], 'strong').font).toMatch(/Bold/)
    expect(item(pages[0], 'big').size).toBeCloseTo(20, 0)
    const sup = pages[0].items.find((i) => i.str === '2')!
    expect(sup.size).toBeLessThan(12)
    const mono = item(pages[0], 'centered')
    const monoEnd = item(pages[0], 'mono')
    expect(mono.font).toMatch(/LiberationMono/)
    expect(mono.x).toBeGreaterThan(200)
    expect(monoEnd.x + monoEnd.w).toBeLessThan(400)
    expect(pages[0].text).toContain('plain bold italic red strong big x')
  })

  it('collapses white space, honours text:s / text:tab / text:line-break and keeps entities', async () => {
    const r = await conv({ body: p('  lots   of\n   white     space &amp; &lt;stuff&gt;<text:s text:c="3"/>after<text:tab/>tabbed<text:line-break/>next line') })
    const { pages } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    expect(flat).toBe('lots of white space & <stuff> after tabbed next line')
    const tabbed = item(pages[0], 'tabbed')
    const after = item(pages[0], 'after')
    expect(tabbed.x).toBeGreaterThan(after.x + after.w + 5)
    expect(item(pages[0], 'next line').y).toBeGreaterThan(tabbed.y)
  })

  it('handles alignment, margins, indents, spacing, page breaks and keep-with-next from styles', async () => {
    const auto =
      '<style:style style:name="Pj" style:family="paragraph"><style:paragraph-properties fo:text-align="justify" fo:margin-left="2cm" fo:margin-right="1cm" fo:text-indent="1cm"/></style:style>' +
      '<style:style style:name="Pr" style:family="paragraph"><style:paragraph-properties fo:text-align="end" fo:margin-top="1cm"/></style:style>' +
      '<style:style style:name="Pb" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>' +
      '<style:style style:name="Ps" style:family="paragraph"><style:paragraph-properties fo:line-height="200%"/></style:style>'
    const long = 'word '.repeat(60).trim()
    const r = await conv({ autoStyles: auto, body: p(long, 'Pj') + p('right aligned', 'Pr') + p('new page', 'Pb') + p('double one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three', 'Ps') })
    const { pages } = await readPdf(r.bytes)
    expect(pages).toHaveLength(2)
    const first = pages[0].items.find((i) => i.str.startsWith('word'))!
    expect(first.x).toBeCloseTo(56.7 + 56.7 + 28.35, 0) // margin + 2cm + first-line 1cm
    const right = item(pages[0], 'right aligned')
    expect(right.x + right.w).toBeCloseTo(595.3 - 56.7, 0)
    expect(pages[1].text.startsWith('new page')).toBe(true)
    const ys = pages[1].items.filter((i) => i.str.trim()).map((i) => i.y)
    expect(ys[2] - ys[1]).toBeGreaterThan(20) // 200% line height on 12pt text
  })

  it('draws paragraph borders and shading without losing text', async () => {
    const auto = '<style:style style:name="Pbx" style:family="paragraph"><style:paragraph-properties fo:background-color="#dddddd" fo:border="0.5pt solid #000000" fo:padding="0.1cm"/></style:style>'
    const r = await conv({ autoStyles: auto, body: p('boxed', 'Pbx') })
    expect(flattenText((await readPdf(r.bytes)).pages)).toBe('boxed')
  })

  it('never loses text across many pages', async () => {
    const paras = Array.from({ length: 300 }, (_, i) => `Paragraph number ${i + 1} with some words to fill the line and wrap now and then.`)
    const r = await conv({ body: paras.map((t) => p(t, 'Text_20_body')).join('') })
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(4)
    expect(flattenText(pages)).toBe(paras.join(' '))
  })
})

describe('ODT: lists', () => {
  const styles =
    '<text:list-style style:name="LBullet"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="1.27cm" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties></text:list-level-style-bullet>' +
    '<text:list-level-style-bullet text:level="2" text:bullet-char="◦"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.905cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>' +
    '<text:list-style style:name="LNum"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.27cm"/></style:list-level-properties></text:list-level-style-number>' +
    '<text:list-level-style-number text:level="2" style:num-suffix=")" style:num-format="a"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.635cm" fo:margin-left="1.905cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>'

  it('renders bullets and nested numbered lists with prefixes, suffixes and indents', async () => {
    const r = await conv({
      autoStyles: styles,
      body:
        '<text:list text:style-name="LBullet"><text:list-item>' + p('bullet one') + '</text:list-item><text:list-item>' + p('bullet two') +
        '<text:list><text:list-item>' + p('nested bullet') + '</text:list-item></text:list></text:list-item></text:list>' +
        p('between') +
        '<text:list text:style-name="LNum"><text:list-item>' + p('first') + '<text:list><text:list-item>' + p('sub a') + '</text:list-item><text:list-item>' + p('sub b') + '</text:list-item></text:list></text:list-item>' +
        '<text:list-item>' + p('second') + '</text:list-item><text:list-item text:start-value="7">' + p('seventh') + '</text:list-item></text:list>'
    })
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].text
    expect(t).toMatch(/•\s*bullet one/)
    expect(t).toMatch(/◦\s*nested bullet/)
    expect(t).toMatch(/1\.\s*first/)
    expect(t).toMatch(/a\)\s*sub a/)
    expect(t).toMatch(/b\)\s*sub b/)
    expect(t).toMatch(/2\.\s*second/)
    expect(t).toMatch(/7\.\s*seventh/)
    // text is at the list level's left margin (1.27 cm + page margin); nested one is further in
    expect(item(pages[0], 'bullet one').x).toBeCloseTo(56.7 + 36, 0)
    expect(item(pages[0], 'nested bullet').x).toBeGreaterThan(item(pages[0], 'bullet one').x + 10)
    expect(item(pages[0], 'between').x).toBeCloseTo(56.7, 0)
  })

  it('restarts numbering per list unless continue-numbering is set', async () => {
    const one = (t: string): string => '<text:list-item>' + p(t) + '</text:list-item>'
    const r = await conv({
      autoStyles: styles,
      body: `<text:list text:style-name="LNum">${one('a1')}${one('a2')}</text:list>${p('gap')}<text:list text:style-name="LNum">${one('b1')}</text:list>${p('gap2')}<text:list text:style-name="LNum" text:continue-numbering="true">${one('c1')}</text:list>`
    })
    const t = (await readPdf(r.bytes)).pages[0].text
    expect(t).toMatch(/1\.\s*a1/)
    expect(t).toMatch(/2\.\s*a2/)
    expect(t).toMatch(/1\.\s*b1/)
    expect(t).toMatch(/2\.\s*c1/)
  })
})

describe('ODT: tables', () => {
  const tableStyles =
    '<style:style style:name="Table1" style:family="table"><style:table-properties style:width="17cm" table:align="left"/></style:style>' +
    '<style:style style:name="Table1.A" style:family="table-column"><style:table-column-properties style:column-width="4cm"/></style:style>' +
    '<style:style style:name="Table1.B" style:family="table-column"><style:table-column-properties style:column-width="8cm"/></style:style>' +
    '<style:style style:name="Table1.C" style:family="table-column"><style:table-column-properties style:column-width="5cm"/></style:style>' +
    '<style:style style:name="Table1.A1" style:family="table-cell"><style:table-cell-properties fo:padding="0.097cm" fo:border="0.5pt solid #000000" fo:background-color="#cccccc"/></style:style>' +
    '<style:style style:name="Table1.B1" style:family="table-cell"><style:table-cell-properties fo:padding="0.097cm" fo:border="0.5pt solid #000000" style:vertical-align="middle"/></style:style>'
  const cell = (t: string, extra = ''): string => `<table:table-cell table:style-name="Table1.B1" office:value-type="string"${extra}>${p(t)}</table:table-cell>`
  const cols = '<table:table-column table:style-name="Table1.A"/><table:table-column table:style-name="Table1.B"/><table:table-column table:style-name="Table1.C"/>'

  it('builds tables with column widths, spans, header rows and shading', async () => {
    const r = await conv({
      autoStyles: tableStyles,
      body:
        `<table:table table:name="T" table:style-name="Table1">${cols}` +
        `<table:table-header-rows><table:table-row><table:table-cell table:style-name="Table1.A1" office:value-type="string">${p('H1')}</table:table-cell>${cell('H2')}${cell('H3')}</table:table-row></table:table-header-rows>` +
        `<table:table-row>${cell('spanned two', ' table:number-columns-spanned="2"')}<table:covered-table-cell/>${cell('c3')}</table:table-row>` +
        `<table:table-row>${cell('tall', ' table:number-rows-spanned="2"')}${cell('b3')}${cell('c4')}</table:table-row>` +
        `<table:table-row><table:covered-table-cell/>${cell('b4')}${cell('c5')}</table:table-row>` +
        '</table:table>' +
        p('after table')
    })
    expect(r.warnings).toEqual([])
    const { pages } = await readPdf(r.bytes)
    const pg = pages[0]
    // (the row-spanning cell is vertically centred, so it is read between its two rows)
    expect(flattenText(pages)).toBe('H1 H2 H3 spanned two c3 b3 c4 tall b4 c5 after table')
    // column x positions: page margin 56.7 + padding, +4cm, +12cm
    const h1 = item(pg, 'H1')
    const h2 = item(pg, 'H2')
    const h3 = item(pg, 'H3')
    expect(h2.x - h1.x).toBeCloseTo(113.4, 0) // 4 cm
    expect(h3.x - h2.x).toBeCloseTo(226.8, 0) // 8 cm
    expect(item(pg, 'c3').x).toBeCloseTo(h3.x, 0) // third column after a 2-column span
    expect(item(pg, 'b4').x).toBeCloseTo(h2.x, 0) // covered cell keeps the column free
    expect(item(pg, 'after table').y).toBeGreaterThan(item(pg, 'c5').y)
  })

  it('repeats header rows across pages and keeps every row', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => `<table:table-row>${cell(`r${i + 1}`)}${cell(`v${i + 1}`)}${cell('x')}</table:table-row>`).join('')
    const r = await conv({ autoStyles: tableStyles, body: `<table:table table:name="T" table:style-name="Table1">${cols}<table:table-header-rows><table:table-row>${cell('Name')}${cell('Val')}${cell('X')}</table:table-row></table:table-header-rows>${rows}</table:table>` })
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(1)
    for (const pg of pages) expect(pg.text.startsWith('Name Val X')).toBe(true)
    const all = pages.map((x) => x.text).join('\n')
    for (let i = 1; i <= 80; i++) expect(all).toContain(`r${i} v${i}`)
  })

  it('handles repeated columns/cells and nested tables', async () => {
    const inner = `<table:table table:name="In"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell>${p('in1')}</table:table-cell><table:table-cell>${p('in2')}</table:table-cell></table:table-row></table:table>`
    const r = await conv({
      body: `<table:table table:name="T"><table:table-column table:number-columns-repeated="3"/><table:table-row><table:table-cell table:number-columns-repeated="2">${p('same')}</table:table-cell><table:table-cell>${inner}${p('tail')}</table:table-cell></table:table-row></table:table>`
    })
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toBe('same same in1 in2 tail')
  })
})

describe('ODT: master pages, headers/footers and page setup', () => {
  const layout =
    '<style:page-layout style:name="Mpm1"><style:page-layout-properties fo:page-width="29.7cm" fo:page-height="21cm" style:print-orientation="landscape" fo:margin-top="1cm" fo:margin-bottom="1cm" fo:margin-left="1.5cm" fo:margin-right="1.5cm"/>' +
    '<style:header-style><style:header-footer-properties fo:min-height="0.6cm" fo:margin-bottom="0.3cm"/></style:header-style><style:footer-style><style:header-footer-properties fo:min-height="0.6cm" fo:margin-top="0.3cm"/></style:footer-style></style:page-layout>'

  it('reads landscape page size and margins, and draws headers and footers with page fields', async () => {
    const master =
      '<style:master-page style:name="Standard" style:page-layout-name="Mpm1"><style:header><text:p text:style-name="Standard">Running header</text:p></style:header>' +
      '<style:footer><text:p text:style-name="Standard">Page <text:page-number text:select-page="current">1</text:page-number> of <text:page-count>1</text:page-count></text:p></style:footer></style:master-page>'
    const body = Array.from({ length: 90 }, (_, i) => p(`Body paragraph ${i + 1}`, 'Text_20_body')).join('')
    const r = await conv({ pageLayouts: layout, masters: master, body })
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].width).toBeCloseTo(842, 0)
    expect(pages[0].height).toBeCloseTo(595.3, 0)
    expect(pages.length).toBeGreaterThan(2)
    for (let i = 0; i < pages.length; i++) {
      expect(pages[i].text.startsWith('Running header')).toBe(true)
      expect(pages[i].text).toContain(`Page ${i + 1} of ${pages.length}`)
    }
    const hdr = item(pages[0], 'Running header')
    expect(hdr.x).toBeCloseTo(42.5, 0) // 1.5 cm
    expect(hdr.y).toBeLessThan(45)
    const body1 = item(pages[0], 'Body paragraph 1')
    expect(body1.y).toBeGreaterThan(hdr.y + 10)
  })

  it('uses a different first page (First Page master with its own header) and switches back', async () => {
    const layouts =
      A4_LAYOUT +
      '<style:page-layout style:name="Mpm2"><style:page-layout-properties fo:page-width="21.001cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/><style:header-style><style:header-footer-properties fo:min-height="0.6cm"/></style:header-style><style:footer-style/></style:page-layout>'
    const masters =
      '<style:master-page style:name="Standard" style:page-layout-name="Mpm1"><style:header><text:p>Standard header</text:p></style:header></style:master-page>' +
      '<style:master-page style:name="First_20_Page" style:page-layout-name="Mpm2" style:next-style-name="Standard"><style:header><text:p>Cover header</text:p></style:header></style:master-page>'
    const auto = '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="First_20_Page"/>'
    const long = Array.from({ length: 100 }, (_, i) => p(`Filler ${i + 1}`)).join('')
    const r = await conv({ pageLayouts: layouts, masters, autoStyles: auto, body: p('Title page', 'P1') + long })
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0].text.startsWith('Cover header')).toBe(true)
    expect(pages[0].text).toContain('Title page')
    expect(pages[1].text.startsWith('Standard header')).toBe(true)
  })

  it('reads page columns', async () => {
    const twoCols = A4_LAYOUT.replace('<style:header-style/>', '<style:header-style/>').replace('fo:margin-right="2cm"/>', 'fo:margin-right="2cm"><style:columns fo:column-count="2" fo:column-gap="1cm"/></style:page-layout-properties>').replace('</style:page-layout-properties>', '')
    void twoCols
    const layoutCols =
      '<style:page-layout style:name="Mpm1"><style:page-layout-properties fo:page-width="21.001cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"><style:columns fo:column-count="2" fo:column-gap="1cm"/></style:page-layout-properties><style:header-style/><style:footer-style/></style:page-layout>'
    const body = Array.from({ length: 120 }, (_, i) => p(`Col line ${i + 1}`)).join('')
    const r = await conv({ pageLayouts: layoutCols, body })
    const { pages } = await readPdf(r.bytes)
    // the second column starts right of the middle of the page
    const xs = new Set(pages[0].items.filter((i) => i.str.trim()).map((i) => Math.round(i.x)))
    expect(xs.size).toBe(2)
    expect(Math.max(...xs)).toBeGreaterThan(280)
    expect(flattenText(pages)).toContain('Col line 120')
  })
})

describe('ODT: images, links, notes, shapes', () => {
  const png = makePng(20, 10, solid(0, 128, 255))

  it('embeds PNG images inline (as-char) and anchored, and replaces unsupported formats', async () => {
    const frame = (href: string, w: string, h: string, anchor = 'as-char', extra = ''): string =>
      `<draw:frame draw:style-name="fr1" draw:name="img" text:anchor-type="${anchor}" svg:width="${w}" svg:height="${h}"${extra}><draw:image xlink:href="${href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`
    const r = await conv({
      autoStyles: '<style:style style:name="fr1" style:family="graphic"><style:graphic-properties style:wrap="run-through" style:run-through="foreground" style:horizontal-pos="right" style:horizontal-rel="paragraph"/></style:style>',
      body:
        p(`Before ${frame('Pictures/a.png', '4cm', '2cm')} after`) +
        p(`Anchored${frame('Pictures/a.png', '3cm', '1.5cm', 'paragraph')} paragraph`) +
        p(`Vector ${frame('Pictures/v.svg', '3cm', '1cm')} end`),
      files: { 'Pictures/a.png': png, 'Pictures/v.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>') }
    })
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].imageCount).toBe(2)
    expect(pages[0].text).toContain('Before')
    expect(pages[0].text).toContain('after')
    expect(pages[0].text).toContain('[Image: v.svg not supported]')
    expect(r.warnings.join(' ')).toMatch(/SVG/i)
  })

  it('creates link annotations for external hyperlinks only', async () => {
    const r = await conv({ body: p('See <text:a xlink:href="https://example.com/page" xlink:type="simple">the site</text:a> and <text:a xlink:href="#bookmark" xlink:type="simple">an anchor</text:a>.') })
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].text).toBe('See the site and an anchor.')
    const pdf = await PDFDocument.load(r.bytes)
    const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
    expect(annots.size()).toBe(1)
    expect(annots.lookup(0, PDFDict).lookup(PDFName.of('A'), PDFDict).get(PDFName.of('URI'))?.toString()).toContain('https://example.com/page')
  })

  it('moves footnotes to the end and warns', async () => {
    const r = await conv({ body: p('Text<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p text:style-name="Standard">The note.</text:p></text:note-body></text:note> continues.') })
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toContain('Text1 continues.')
    expect(flat.indexOf('The note.')).toBeGreaterThan(flat.indexOf('continues.'))
    expect(r.warnings.join(' ')).toMatch(/Footnotes/)
  })

  it('keeps text inside text boxes and shapes, and renders cached table-of-contents text', async () => {
    const r = await conv({
      body:
        p('Intro <draw:frame text:anchor-type="paragraph" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>inside box</text:p></draw:text-box></draw:frame>') +
        '<text:table-of-content text:name="TOC"><text:index-body><text:index-title><text:p>Contents</text:p></text:index-title><text:p>Chapter one<text:tab/>3</text:p></text:index-body></text:table-of-content>' +
        '<draw:custom-shape><text:p>shape text</text:p></draw:custom-shape>'
    })
    const flat = flattenText((await readPdf(r.bytes)).pages)
    for (const s of ['Intro', 'inside box', 'Contents', 'Chapter one', 'shape text']) expect(flat).toContain(s)
    expect(r.warnings.join(' ')).toMatch(/Text boxes/)
    expect(r.warnings.join(' ')).toMatch(/shapes/)
  })

  it('numbers headings from the outline style and handles sections', async () => {
    const outline =
      '<text:outline-style style:name="Outline"><text:outline-level-style text:level="1" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.5cm" fo:margin-left="0.5cm"/></style:list-level-properties></text:outline-level-style>' +
      '<text:outline-level-style text:level="2" style:num-suffix="" style:num-format="1" text:display-levels="2"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.8cm" fo:margin-left="0.8cm"/></style:list-level-properties></text:outline-level-style></text:outline-style>'
    const r = await conv({
      styles: outline,
      body:
        '<text:h text:style-name="Heading_20_1" text:outline-level="1">First</text:h><text:h text:style-name="Heading_20_2" text:outline-level="2">Sub</text:h><text:h text:style-name="Heading_20_2" text:outline-level="2">Sub two</text:h><text:h text:style-name="Heading_20_1" text:outline-level="1">Second</text:h>' +
        '<text:section text:style-name="Sect1" text:name="S"><text:p text:style-name="Standard">in section</text:p></text:section>'
    })
    const t = (await readPdf(r.bytes)).pages[0].text
    expect(t).toMatch(/1\.\s*First/)
    expect(t).toMatch(/1\.1\s*Sub\b/)
    expect(t).toMatch(/1\.2\s*Sub two/)
    expect(t).toMatch(/2\.\s*Second/)
    expect(t).toContain('in section')
  })
})

describe('ODT: robustness', () => {
  it('rejects non-zip data and other ODF kinds with clear messages', async () => {
    await expect(run(strToU8('this is not a zip'))).rejects.toThrow(/damaged or is not a valid Office file/)
    await expect(run(odtPackage({ body: '', mimetype: 'application/vnd.oasis.opendocument.spreadsheet' }))).rejects.toThrow(/not a text document/)
    await expect(run(odtPackage({ body: '', omitContent: true }))).rejects.toThrow(/content\.xml is missing/)
    await expect(run(zipSync({ 'content.xml': strToU8('<office:document-content xmlns:office="x"><office:body/></office:document-content>') }))).rejects.toThrow(/no text content/)
  })

  it('survives a package without styles.xml and unknown elements', async () => {
    const content = `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><weird:thing xmlns:weird="w"><text:p>inside unknown</text:p></weird:thing><text:p>plain <text:unknown-inline>cached</text:unknown-inline> text</text:p></office:text></office:body></office:document-content>`
    const r = await run(zipSync({ 'content.xml': strToU8(content) }))
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toBe('inside unknown plain cached text')
    expect((await readPdf(r.bytes)).pages[0].width).toBeCloseTo(595.3, 0) // A4 default
  })

  it('copes with deeply nested spans and lists (warns, keeps the visible text)', async () => {
    const depth = 3000
    const deep = `${'<text:span>'.repeat(depth)}deep${'</text:span>'.repeat(depth)}`
    const r = await conv({ body: p(`start ${deep} end`) })
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toContain('start')
    expect(flat).toContain('end')
    expect(r.warnings.join(' ')).toMatch(/nests content/)
  })

  it('ignores hidden text and reports comments as not shown', async () => {
    const r = await conv({
      autoStyles: '<style:style style:name="H" style:family="text"><style:text-properties text:display="none"/></style:style>',
      body: p('visible <text:span text:style-name="H">HIDDEN</text:span><office:annotation><dc:creator>me</dc:creator><text:p>a comment</text:p></office:annotation>text')
    })
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toBe('visible text')
    expect(r.warnings.join(' ')).toMatch(/Comments/)
  })
})
