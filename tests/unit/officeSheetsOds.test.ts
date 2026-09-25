import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { parseLength } from '../../src/main/features/create/office/ods'
import { flattenText, readPdf } from '../support/pdfText'
import { makePng, solid } from '../support/images'
import { buildOds, tcell, trow } from '../support/odsBuilder'

const fontsDir = resolve('resources/fonts')
const conv = (bytes: Uint8Array, opts: Partial<Parameters<typeof convertOffice>[1]> = {}) => convertOffice({ name: 'calc.ods', bytes }, { fontsDir, ...opts })
const COLS = '<table:table-column table:style-name="co1" table:number-columns-repeated="3" table:default-cell-style-name="Default"/>'

describe('ods helpers', () => {
  it('parses ODF lengths', () => {
    expect(parseLength('2.54cm')).toBeCloseTo(72)
    expect(parseLength('1in')).toBe(72)
    expect(parseLength('25.4mm')).toBeCloseTo(72)
    expect(parseLength('12pt')).toBe(12)
    expect(parseLength('96px')).toBeCloseTo(72)
    expect(parseLength('abc')).toBeUndefined()
  })
})

describe('ods conversion', () => {
  it('prints text, numbers as formatted in the file, booleans and keeps the sheet order', async () => {
    const r = await conv(
      buildOds({
        tables: [
          { name: 'First', xml: COLS + trow(tcell('Name', 'ce_bold') + tcell('Amount', 'ce_bold') + tcell('OK')) + trow(tcell('Bolt') + tcell(1234.5, undefined) .replace('<text:p>1234.5</text:p>', '<text:p>$1,234.50</text:p>') + tcell(true)) },
          { name: 'Second', xml: COLS + trow(tcell('on the second sheet')) }
        ]
      })
    )
    expect(r.pages).toBe(2)
    const { pages, embeddedFonts } = await readPdf(r.bytes)
    expect(pages[0].text).toContain('Name')
    expect(flattenText(pages)).toContain('Bolt $1,234.50 TRUE')
    expect(pages[1].text).toContain('on the second sheet')
    expect(embeddedFonts.some((f) => /LiberationSans/.test(f))).toBe(true)
    // A4 portrait from the page layout
    expect([Math.round(pages[0].width), Math.round(pages[0].height)]).toEqual([595, 842])
    const name = pages[0].items.find((i) => i.str === 'Name')!
    expect(name.size).toBeCloseTo(12, 0)
    expect(name.font).toMatch(/Bold/)
  })

  it('handles repeated cells and rows without exploding on huge trailing repeats', async () => {
    const xml =
      COLS +
      trow(tcell('a') + `<table:table-cell table:number-columns-repeated="2" office:value-type="string"><text:p>rep</text:p></table:table-cell>`) +
      trow(tcell('same'), 'ro1', 'table:number-rows-repeated="3"') +
      trow('<table:table-cell table:number-columns-repeated="1000"/>', 'ro1', 'table:number-rows-repeated="1048000"')
    const r = await conv(buildOds({ tables: [{ name: 'S', xml }] }))
    expect(r.pages).toBe(1)
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toBe('a rep rep same same same')
  })

  it('merges cells and skips covered cells; header rows repeat on every page', async () => {
    const rows: string[] = []
    rows.push(`<table:table-header-rows>${trow(tcell('HeaderA', 'ce_bold') + tcell('HeaderB', 'ce_bold') + tcell('HeaderC', 'ce_bold'))}</table:table-header-rows>`)
    rows.push(trow(tcell('wide merged', 'ce_center', 'table:number-columns-spanned="2"') + '<table:covered-table-cell/>' + tcell('tail')))
    for (let i = 0; i < 400; i++) rows.push(trow(tcell(`r${i}`) + tcell(i) + tcell('x')))
    const r = await conv(buildOds({ tables: [{ name: 'S', xml: COLS + rows.join('') }] }))
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(3)
    for (const p of pages) expect(p.text).toContain('HeaderA')
    const flat = flattenText(pages)
    expect(flat).toContain('wide merged')
    expect((flat.match(/\br\d+\b/g) ?? []).length).toBe(400)
  })

  it('skips hidden tables, collapsed rows and columns, and warns about hidden sheets', async () => {
    const cols = '<table:table-column table:style-name="co1"/><table:table-column table:style-name="co1" table:visibility="collapse"/>'
    const xml = cols + trow(tcell('shown') + tcell('hiddencolumn')) + trow(tcell('hiddenrow'), 'ro1', 'table:visibility="collapse"') + trow(tcell('last'))
    const r = await conv(buildOds({ tables: [{ name: 'A', xml }, { name: 'B', xml: trow(tcell('other')), attrs: 'table:display="false"' }] }))
    expect(flattenText((await readPdf(r.bytes)).pages)).toBe('shown last')
    expect(r.warnings.join(' ')).toMatch(/Hidden sheet “B”/)
  })

  it('applies page layout (landscape), headers and footers with page fields', async () => {
    const layout = `<style:page-layout style:name="Mpm1"><style:page-layout-properties fo:page-width="27.94cm" fo:page-height="21.59cm" style:print-orientation="landscape" fo:margin-top="1.5cm" fo:margin-bottom="1.5cm" fo:margin-left="1.5cm" fo:margin-right="1.5cm"/><style:header-style><style:header-footer-properties fo:min-height="0.5cm" fo:margin-bottom="0.2cm"/></style:header-style><style:footer-style><style:header-footer-properties fo:min-height="0.5cm" fo:margin-top="0.2cm"/></style:footer-style></style:page-layout>`
    const master = `<style:master-page style:name="Default" style:page-layout-name="Mpm1"><style:header><style:region-left><text:p><text:sheet-name/></text:p></style:region-left><style:region-right><text:p>Confidential</text:p></style:region-right></style:header><style:footer><style:region-center><text:p>Page <text:page-number/> of <text:page-count/></text:p></style:region-center></style:footer></style:master-page>`
    const rows = Array.from({ length: 120 }, (_, i) => trow(tcell(`line ${i}`))).join('')
    const r = await conv(buildOds({ tables: [{ name: 'Totals', xml: COLS + rows }], pageLayout: layout, masterStyles: master }))
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].width).toBeGreaterThan(pages[0].height)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0].text).toContain('Totals')
    expect(pages[0].text).toContain('Confidential')
    expect(pages[0].text).toContain(`Page 1 of ${pages.length}`)
  })

  it('wraps text in wrapping cells and applies fills and column widths', async () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'
    const xml = '<table:table-column table:style-name="co1"/>' + trow(tcell(long, 'ce_wrap') + tcell('side', 'ce_fill')) + trow(tcell('after'))
    const r = await conv(buildOds({ tables: [{ name: 'S', xml }] }))
    const { pages } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    for (const w of long.split(' ')) expect(flat).toContain(w)
    const first = pages[0].items.find((i) => i.str.startsWith('one'))!
    const after = pages[0].items.find((i) => i.str === 'after')!
    expect(after.y - first.y).toBeGreaterThan(30)
  })

  it('draws pictures from the package and marks shapes with placeholders and warnings', async () => {
    const png = makePng(30, 20, solid(10, 120, 200))
    const frame = `<draw:frame draw:name="Image1" svg:x="1cm" svg:y="1cm" svg:width="3cm" svg:height="2cm"><draw:image xlink:href="Pictures/img1.png" xlink:type="simple"/></draw:frame>`
    const shape = `<draw:custom-shape svg:x="6cm" svg:y="1cm" svg:width="3cm" svg:height="2cm"><text:p>Callout</text:p></draw:custom-shape>`
    const xml = `<table:shapes>${frame}${shape}</table:shapes>` + COLS + trow(tcell('with picture'))
    const r = await conv(buildOds({ tables: [{ name: 'S', xml }], files: { 'Pictures/img1.png': png } }))
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].imageCount).toBe(1)
    expect(flattenText(pages)).toContain('Callout')
    expect(r.warnings.join(' ')).toMatch(/drawing shapes/)
  })

  it('honours print ranges', async () => {
    const rows = ['a', 'b', 'c', 'd'].map((t) => trow(tcell(t))).join('')
    const r = await conv(buildOds({ tables: [{ name: 'S', xml: COLS + rows, attrs: 'table:print-ranges="S.A2:S.A3"' }] }))
    expect(flattenText((await readPdf(r.bytes)).pages)).toBe('b c')
  })

  it('rejects files that are not spreadsheets', async () => {
    await expect(conv(new TextEncoder().encode('nope'))).rejects.toThrow(/damaged|not a valid/)
  })
})
