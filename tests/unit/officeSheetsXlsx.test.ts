import { resolve } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { parseCellRef, parseDefinedRefs, parseHeaderFooter } from '../../src/main/features/create/office/xlsx'
import { flattenText, readPdf } from '../support/pdfText'
import { makePng, solid } from '../support/images'
import { XF, buildXlsx, row, simpleRow, worksheet } from '../support/xlsxBuilder'

const fontsDir = resolve('resources/fonts')
const conv = (bytes: Uint8Array, name = 'book.xlsx', opts: Partial<Parameters<typeof convertOffice>[1]> = {}) => convertOffice({ name, bytes }, { fontsDir, ...opts })

/** All decoded content-stream text of a page (for colour/operator assertions). */
async function pageContent(bytes: Uint8Array, index: number): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  const contents = doc.getPage(index).node.Contents()
  const parts: PDFRawStream[] = []
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) parts.push(contents.lookup(i, PDFRawStream))
  else parts.push(contents as unknown as PDFRawStream)
  return parts.map((p) => Buffer.from(decodePDFRawStream(p).decode()).toString('latin1')).join('\n')
}

describe('reference helpers', () => {
  it('parses cell references, defined-name ranges and header/footer codes', () => {
    expect(parseCellRef('A1')).toEqual({ c: 0, r: 0 })
    expect(parseCellRef('$AB$12')).toEqual({ c: 27, r: 11 })
    expect(parseCellRef('nope')).toBeNull()
    expect(parseDefinedRefs("Sheet1!$A$1:$C$5,'My ''Sheet'!$1:$2")).toEqual([
      { sheet: 'Sheet1', range: { r1: 0, c1: 0, r2: 4, c2: 2 } },
      { sheet: "My 'Sheet", rows: [0, 1] }
    ])
    expect(parseDefinedRefs('Data!$A:$B')).toEqual([{ sheet: 'Data', cols: [0, 1] }])
    const hf = parseHeaderFooter('&L&"Arial,Bold"&14Report &&Co&C&P of &N&R&D&T')!
    expect(hf.left).toEqual([{ text: 'Report &Co', bold: true, italic: false, underline: false, size: 14, family: 'Arial' }])
    expect(hf.center.map((r) => r.field ?? r.text)).toEqual(['page', ' of ', 'pages'])
    expect(hf.right.map((r) => r.field)).toEqual(['date', 'time'])
  })
})

describe('xlsx cells, styles and number formats', () => {
  const basic = () =>
    buildXlsx({
      sharedStrings: ['Item', 'Widget', { runs: [{ text: 'Bold ', rPr: '<b/>' }, { text: 'plain' }] }],
      sheets: [
        {
          name: 'Sales',
          xml: worksheet({
            cols: '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="4" width="14" customWidth="1"/></cols>',
            rows: [
              row(1, [{ ref: 'A1', sst: 0, s: XF.header }, { ref: 'B1', v: 'Price', s: XF.header }, { ref: 'C1', v: 'Share', s: XF.header }, { ref: 'D1', v: 'Date', s: XF.header }]),
              row(2, [{ ref: 'A2', sst: 1 }, { ref: 'B2', v: 1234.5, s: XF.usd }, { ref: 'C2', v: 0.256, s: XF.pct }, { ref: 'D2', v: 45000, s: XF.isoDate }]),
              row(3, [{ ref: 'A3', sst: 2 }, { ref: 'B3', v: 1234567.891, s: XF.thousands }, { ref: 'C3', v: true }, { ref: 'D3', v: '#DIV/0!', t: 'e' }]),
              row(4, [{ ref: 'A4', v: 'Total', s: XF.bold }, { ref: 'B4', f: 'SUM(B2:B3)', v: 1235802.391, s: XF.dec2 }, { ref: 'C4', v: 45000.75, s: XF.date }])
            ].join('')
          })
        }
      ]
    })

  it('prints values with their number formats, rich text and every cell in order', async () => {
    const r = await conv(basic())
    expect(r.pages).toBe(1)
    const { pages, embeddedFonts } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    expect(flat).toContain('Item Price Share Date')
    expect(flat).toContain('Widget $1,234.50 25.6%'.replace('25.6%', '26%'))
    expect(flat).toContain('2023-03-15')
    expect(flat).toContain('Bold plain')
    expect(flat).toContain('1,234,568')
    expect(flat).toContain('TRUE')
    expect(flat).toContain('#DIV/0!')
    expect(flat).toContain('1235802.39')
    expect(flat).toContain('3/15/2023')
    expect(embeddedFonts.some((f) => /Carlito/.test(f))).toBe(true)
    expect(embeddedFonts.some((f) => /Carlito-Bold/.test(f))).toBe(true) // header + rich bold run
    expect(r.warnings).toEqual([])
  })

  it('right-aligns numbers, centres booleans and applies fills, borders and colours', async () => {
    const r = await conv(basic())
    const { pages } = await readPdf(r.bytes)
    const price = pages[0].items.find((i) => i.str === '$1,234.50')!
    const big = pages[0].items.find((i) => i.str === '1,234,568')!
    const widget = pages[0].items.find((i) => i.str === 'Widget')!
    expect(price.x + price.w).toBeCloseTo(big.x + big.w, 0) // both flush right in column B
    expect(widget.x).toBeLessThan(price.x)
    const content = await pageContent(r.bytes, 0)
    expect(content).toMatch(/0\.12\d* 0\.30\d* 0\.47\d* rg/) // header fill #1F4E79 as rgb
    expect(content).toContain('S') // strokes for the boxed header cells
  })

  it('applies fonts (size, italic, colour, underline) from the style sheet', async () => {
    const xml = worksheet({ rows: row(1, [{ ref: 'A1', v: 'Fancy', s: XF.fancyFont }]) })
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml }] }))
    const { pages } = await readPdf(r.bytes)
    const it = pages[0].items.find((i) => i.str === 'Fancy')!
    expect(it.size).toBeCloseTo(14, 0)
    expect(it.font).toMatch(/Liberation.*Italic|Italic/)
    const content = await pageContent(r.bytes, 0)
    expect(content).toContain('1 0 0 rg') // red text
  })

  it('shows #### for numbers that do not fit and shrinks text when asked', async () => {
    const xml = worksheet({
      cols: '<cols><col min="1" max="1" width="4" customWidth="1"/></cols>',
      rows: row(1, [{ ref: 'A1', v: 123456789.123, s: XF.dec2 }])
    })
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml }] }))
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toMatch(/^#+$/)
  })

  it('warns once when a formula has no stored result', async () => {
    const xml = worksheet({ rows: row(1, [{ ref: 'A1', f: 'SUM(1,2)' }, { ref: 'B1', f: 'A1*2' }, { ref: 'C1', v: 'x' }]) })
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml }] }))
    expect(r.warnings.filter((w) => /no stored result/.test(w))).toHaveLength(1)
    expect(flattenText((await readPdf(r.bytes)).pages)).toBe('x')
  })

  it('wraps text, grows the row and keeps all words', async () => {
    const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau'
    const xml = worksheet({
      cols: '<cols><col min="1" max="1" width="12" customWidth="1"/></cols>',
      rows: row(1, [{ ref: 'A1', v: long, s: XF.wrap }, { ref: 'B1', v: 'side' }]) + row(2, [{ ref: 'A2', v: 'below' }])
    })
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml }] }))
    const { pages } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    for (const w of long.split(' ')) expect(flat).toContain(w)
    const first = pages[0].items.find((i) => i.str.startsWith('alpha'))!
    const below = pages[0].items.find((i) => i.str === 'below')!
    expect(below.y - first.y).toBeGreaterThan(40) // the row grew to hold several lines
  })

  it('handles merged cells: the value is printed once, centred across the merge', async () => {
    const xml = worksheet({
      cols: '<cols><col min="1" max="3" width="10" customWidth="1"/></cols>',
      rows: row(1, [{ ref: 'A1', v: 'Merged title', s: XF.center }]) + row(2, [{ ref: 'A2', v: 'a' }, { ref: 'B2', v: 'b' }, { ref: 'C2', v: 'c' }]),
      after: '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>'
    })
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml }] }))
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].items.find((i) => i.str === 'Merged title')!
    const a = pages[0].items.find((i) => i.str === 'a')!
    const c = pages[0].items.find((i) => i.str === 'c')!
    expect(t.x + t.w / 2).toBeCloseTo(50.4 + (3 * 52.5) / 2, 0) // centre of columns A..C
    expect(a.x).toBeLessThan(t.x)
    expect(c.x).toBeGreaterThan(t.x)
    expect(flattenText(pages).match(/Merged title/g)).toHaveLength(1)
  })

  it('lets non-wrapped text spill over empty neighbours and keeps it complete', async () => {
    const xml = worksheet({
      cols: '<cols><col min="1" max="3" width="9" customWidth="1"/></cols>',
      rows: row(1, [{ ref: 'A1', v: 'A very long heading that spills to the right' }]) + row(2, [{ ref: 'A2', v: 'Another long piece of text that is cut off' }, { ref: 'B2', v: 'X' }])
    })
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml }] }))
    const content = await pageContent(r.bytes, 0)
    expect(content).toMatch(/W\s+n/) // clip path used for the cut-off cell
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toContain('A very long heading that spills to the right')
  })
})

describe('xlsx visibility, print setup and pagination', () => {
  const sheetWith = (rows: string, after = '', cols = '', sheetPr = '') => worksheet({ rows, after, cols, sheetPr })

  it('skips hidden sheets, rows and columns and says so', async () => {
    const s1 = sheetWith(row(1, [{ ref: 'A1', v: 'keep' }, { ref: 'B1', v: 'hiddencol' }]) + row(2, [{ ref: 'A2', v: 'hiddenrow' }], 'hidden="1"') + row(3, [{ ref: 'A3', v: 'end' }]), '', '<cols><col min="2" max="2" width="9" hidden="1"/></cols>')
    const s2 = sheetWith(row(1, [{ ref: 'A1', v: 'secret sheet' }]))
    const r = await conv(buildXlsx({ sheets: [{ name: 'One', xml: s1 }, { name: 'Two', xml: s2, state: 'hidden' }] }))
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toBe('keep end')
    expect(r.warnings.join(' ')).toMatch(/Hidden sheet “Two”/)
  })

  it('uses the paper size and orientation from the page setup', async () => {
    const mk = (setup: string) => conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(row(1, [{ ref: 'A1', v: 'x' }]), setup) }] }))
    const letter = await readPdf((await mk('<pageSetup paperSize="1" orientation="portrait"/>')).bytes)
    expect([Math.round(letter.pages[0].width), Math.round(letter.pages[0].height)]).toEqual([612, 792])
    const a4l = await readPdf((await mk('<pageSetup paperSize="9" orientation="landscape"/>')).bytes)
    expect([Math.round(a4l.pages[0].width), Math.round(a4l.pages[0].height)]).toEqual([842, 595])
    const legal = await readPdf((await mk('<pageSetup paperSize="5"/>')).bytes)
    expect(Math.round(legal.pages[0].height)).toBe(1008)
  })

  it('paginates long sheets without losing a cell and repeats print-title rows', async () => {
    const rows: string[] = [row(1, [0, 1, 2, 3, 4, 5, 6, 7].map((c) => ({ ref: `${String.fromCharCode(65 + c)}1`, v: `Hdr${c}`, s: XF.bold })))]
    for (let r = 2; r <= 2001; r++) rows.push(row(r, [0, 1, 2, 3, 4, 5, 6, 7].map((c) => ({ ref: `${String.fromCharCode(65 + c)}${r}`, v: c === 0 ? `r${r}` : r * 10 + c }))))
    const bytes = buildXlsx({
      sheets: [{ name: 'Big', xml: sheetWith(rows.join('')) }],
      definedNames: '<definedName name="_xlnm.Print_Titles" localSheetId="0">Big!$1:$1</definedName>'
    })
    const r = await conv(bytes, 'big.xlsx', { page: { width: 612, height: 792 } })
    expect(r.pages).toBeGreaterThan(30)
    const { pages } = await readPdf(r.bytes)
    for (const p of pages) expect(p.text).toContain('Hdr0')
    const flat = flattenText(pages)
    const seen = new Set(flat.match(/\br\d+\b/g))
    expect(seen.size).toBe(2000)
    for (const [rr, c] of [[2, 1], [999, 7], [2001, 4]]) expect(flat).toContain(String(rr * 10 + c))
  }, 90000)

  it('honours manual page breaks and print areas', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => simpleRow(i + 1, [`row${i + 1}`, `c${i + 1}`])).join('')
    const withBreak = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows, '<rowBreaks count="1" manualBreakCount="1"><brk id="3" max="16383" man="1"/></rowBreaks>') }] }))
    const { pages } = await readPdf(withBreak.bytes)
    expect(pages).toHaveLength(2)
    expect(pages[0].text).toContain('row3')
    expect(pages[0].text).not.toContain('row4')
    expect(pages[1].text).toContain('row4')
    const area = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows) }], definedNames: '<definedName name="_xlnm.Print_Area" localSheetId="0">S!$A$2:$A$3</definedName>' }))
    expect(flattenText((await readPdf(area.bytes)).pages)).toBe('row2 row3')
  })

  it('fit-to-page shrinks a wide sheet onto one page instead of many', async () => {
    const cells = Array.from({ length: 30 }, (_, c) => ({ ref: `${c < 26 ? String.fromCharCode(65 + c) : 'A' + String.fromCharCode(65 + c - 26)}1`, v: `Column number ${c + 1}` }))
    const rows = row(1, cells)
    const plain = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows) }] }))
    const fit = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows, '<pageSetup fitToHeight="0"/>', '', '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>') }] }))
    expect(plain.pages).toBeGreaterThanOrEqual(3)
    expect(fit.pages).toBe(1)
    const flat = flattenText((await readPdf(fit.bytes)).pages)
    for (let c = 1; c <= 30; c++) expect(flat).toContain(`Column number ${c}`)
    const scaled = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows, '<pageSetup scale="50"/>') }] }))
    expect(scaled.pages).toBeLessThan(plain.pages)
  })

  it('pages down then over by default, or over then down when asked, repeating title columns', async () => {
    const colLetter = (c: number): string => String.fromCharCode(65 + c)
    const rows = Array.from({ length: 100 }, (_, r) => row(r + 1, Array.from({ length: 12 }, (_, c) => ({ ref: `${colLetter(c)}${r + 1}`, v: `R${r}C${c}` })))).join('')
    const cols = '<cols><col min="1" max="12" width="18" customWidth="1"/></cols>'
    const titles = '<definedName name="_xlnm.Print_Titles" localSheetId="0">S!$A:$A</definedName>'
    const down = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows, '', cols) }], definedNames: titles }))
    const over = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows, '<pageSetup pageOrder="overThenDown"/>', cols) }], definedNames: titles }))
    const d = (await readPdf(down.bytes)).pages
    const o = (await readPdf(over.bytes)).pages
    expect(d.length).toBe(o.length)
    expect(d.length).toBeGreaterThan(4)
    expect(d[1].text).toContain('R55C0') // second page: same columns, next rows
    expect(o[1].text).toContain('R0C5') // second page: first rows, next columns (column A repeats as title column)
    // title column A repeats on later column blocks
    expect(o[1].text).toContain('R0C0')
    expect(o[1].text).toContain('R1C0')
    const flat = flattenText([...d])
    for (const [r, c] of [[0, 0], [99, 11], [50, 7], [10, 3]]) expect(flat).toContain(`R${r}C${c}`)
  })

  it('converts a 100,000-cell sheet in reasonable time without losing rows', async () => {
    const rows: string[] = []
    for (let r = 1; r <= 5000; r++) rows.push(row(r, Array.from({ length: 20 }, (_, c) => ({ ref: `${String.fromCharCode(65 + c)}${r}`, v: c === 0 ? `id${r}` : r + c }))))
    const t0 = Date.now()
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows.join('')) }] }), 'big.xlsx', { page: { width: 612, height: 792 } })
    expect(Date.now() - t0).toBeLessThan(60000)
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(new Set(flat.match(/\bid\d+\b/g)).size).toBe(5000)
  }, 120000)

  it('prints headers and footers with page numbers, sheet name and formatting codes', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => simpleRow(i + 1, [`line${i + 1}`])).join('')
    const after = '<headerFooter><oddHeader>&amp;L&amp;"Arial,Bold"Quarterly Report&amp;R&amp;A</oddHeader><oddFooter>&amp;CPage &amp;P of &amp;N</oddFooter></headerFooter>'
    const r = await conv(buildXlsx({ sheets: [{ name: 'Results', xml: sheetWith(rows, after) }] }))
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0].text).toContain('Quarterly Report')
    expect(pages[0].text).toContain('Results')
    expect(pages[0].text).toContain(`Page 1 of ${pages.length}`)
    expect(pages[pages.length - 1].text).toContain(`Page ${pages.length} of ${pages.length}`)
    expect(pages[0].items.find((i) => i.str === 'Quarterly Report')?.font).toMatch(/Bold/)
  })

  it('shows different first/even headers when requested', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => simpleRow(i + 1, [`n${i + 1}`])).join('')
    const after = '<headerFooter differentOddEven="1" differentFirst="1"><oddHeader>&amp;CODD</oddHeader><evenHeader>&amp;CEVEN</evenHeader><firstHeader>&amp;CFIRST</firstHeader></headerFooter>'
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows, after) }] }))
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].text).toContain('FIRST')
    expect(pages[1].text).toContain('EVEN')
    expect(pages[2].text).toContain('ODD')
  })

  it('draws gridlines when printOptions asks for them', async () => {
    const xml = (grid: boolean) => sheetWith(row(1, [{ ref: 'A1', v: 'x' }]), grid ? '<printOptions gridLines="1"/>' : '')
    const a = await pageContent((await conv(buildXlsx({ sheets: [{ name: 'S', xml: xml(false) }] }))).bytes, 0)
    const b = await pageContent((await conv(buildXlsx({ sheets: [{ name: 'S', xml: xml(true) }] }))).bytes, 0)
    expect((b.match(/ l\n/g) ?? []).length).toBeGreaterThan((a.match(/ l\n/g) ?? []).length)
  })

  it('reports unsupported features instead of silently dropping them', async () => {
    const after = '<conditionalFormatting sqref="A1"><cfRule type="iconSet" priority="1"><iconSet iconSet="3Arrows"/></cfRule></conditionalFormatting>'
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(row(1, [{ ref: 'A1', v: 1 }]), after) }] }))
    expect(r.warnings.join(' ')).toMatch(/Conditional formatting rules of type iconSet/)
  })

  it('applies cell-value, colour-scale and data-bar conditional formats', async () => {
    const rows = [1, 5, 10].map((v, i) => row(i + 1, [{ ref: `A${i + 1}`, v }, { ref: `B${i + 1}`, v }, { ref: `C${i + 1}`, v }])).join('')
    const after =
      '<conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>4</formula></cfRule></conditionalFormatting>' +
      '<conditionalFormatting sqref="B1:B3"><cfRule type="colorScale" priority="2"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FF00FF00"/><color rgb="FF0000FF"/></colorScale></cfRule></conditionalFormatting>' +
      '<conditionalFormatting sqref="C1:C3"><cfRule type="dataBar" priority="3"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting>'
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(rows, after) }] }))
    expect(r.warnings).toEqual([])
    const content = await pageContent(r.bytes, 0)
    expect(content).toMatch(/1 0\.78\d* 0\.80\d* rg/) // #FFC7CE fill on the cells above 4
    expect(content).toMatch(/0 1 0 rg/) // colour scale minimum (green)
    expect(content).toMatch(/0 0 1 rg/) // colour scale maximum (blue)
    expect(content).toMatch(/0\.6\d* 0\.7\d* 0\.8\d* rg/) // data bar colour (lightened #638EC6)
  })

  it('supports the 1904 date system', async () => {
    const xml = worksheet({ cols: '<cols><col min="1" max="1" width="14" customWidth="1"/></cols>', rows: row(1, [{ ref: 'A1', v: 0, s: XF.isoDate }]) })
    const r = await conv(buildXlsx({ sheets: [{ name: 'S', xml }], date1904: true }))
    expect(flattenText((await readPdf(r.bytes)).pages)).toBe('1904-01-01')
  })

  it('handles a workbook with no styles part and rejects broken packages', async () => {
    const r = await conv(buildXlsx({ styles: null, sheets: [{ name: 'S', xml: sheetWith(row(1, [{ ref: 'A1', v: 'plain' }, { ref: 'B1', v: 3.5 }])) }] }))
    expect(flattenText((await readPdf(r.bytes)).pages)).toBe('plain 3.5')
    await expect(conv(new TextEncoder().encode('not a zip'))).rejects.toThrow(/damaged|not a valid/)
  })

  it('stops when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(conv(buildXlsx({ sheets: [{ name: 'S', xml: sheetWith(row(1, [{ ref: 'A1', v: 1 }])) }] }), 'a.xlsx', { signal: ac.signal })).rejects.toThrow('Cancelled')
  })
})

describe('xlsx pictures, charts and links', () => {
  const drawing = (anchors: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">${anchors}</xdr:wsDr>`
  const rels = (items: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

  it('draws PNG pictures at their anchor and marks charts with a placeholder and a warning', async () => {
    const png = makePng(40, 20, solid(200, 30, 30))
    const pic = `<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Pic"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`
    const chart = `<xdr:oneCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="2540000" cy="1270000"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="c"><c:chart r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`
    const xml = worksheet({ rows: row(1, [{ ref: 'A1', v: 'with pictures' }]), after: '<drawing r:id="rId1"/>' })
    const bytes = buildXlsx({
      sheets: [{ name: 'S', xml, rels: rels(`<Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/>`) }],
      files: {
        'xl/drawings/drawing1.xml': drawing(pic + chart),
        'xl/drawings/_rels/drawing1.xml.rels': rels(`<Relationship Id="rId1" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rId2" Type="${REL}/chart" Target="../charts/chart1.xml"/>`),
        'xl/media/image1.png': png,
        'xl/charts/chart1.xml': '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue by region</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>'
      }
    })
    const r = await conv(bytes)
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].imageCount).toBe(1)
    expect(flattenText(pages)).toContain('Chart: Revenue by region')
    expect(r.warnings.join(' ')).toMatch(/Charts are not rendered/)
  })

  it('turns external hyperlinks into link annotations', async () => {
    const xml = worksheet({ rows: row(1, [{ ref: 'A1', v: 'Click me' }]), after: '<hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>' })
    const bytes = buildXlsx({ sheets: [{ name: 'S', xml, rels: rels(`<Relationship Id="rId1" Type="${REL}/hyperlink" Target="https://example.com/x" TargetMode="External"/>`) }] })
    const r = await conv(bytes)
    const doc = await PDFDocument.load(r.bytes)
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
    const a = annots.lookup(0, PDFDict).lookup(PDFName.of('A'), PDFDict)
    expect(a.get(PDFName.of('S'))?.toString()).toBe('/URI')
    expect(a.lookup(PDFName.of('URI'))?.toString()).toContain('https://example.com/x')
  })
})
