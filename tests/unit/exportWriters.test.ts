import { describe, expect, it } from 'vitest'
import { buildDocx } from '../../src/renderer/src/features/export/docx'
import { buildPptx } from '../../src/renderer/src/features/export/pptx'
import { buildSheets, buildXlsx, cellFromText, sheetName, type SheetData } from '../../src/renderer/src/features/export/xlsx'
import { colLetters, esc, escAttr, stripInvalid } from '../../src/renderer/src/features/export/ooxml'
import { cell, checkPackage, image, NS, page, para, run, table, textsOf } from '../support/exportOoxml'


describe('XML helpers', () => {
  it('escapes markup and strips characters that are illegal in XML 1.0', () => {
    expect(esc('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
    expect(escAttr('say "hi"\n')).toBe('say &quot;hi&quot;&#10;')
    expect(stripInvalid('a\u0000b\u0008c\u000Bd\u000Ce\u001Ff￾g\uD800h')).toBe('abcdefgh')
    expect(stripInvalid('tab\tnl\ncr\r\u{1F600}')).toBe('tab\tnl\ncr\r\u{1F600}')
  })
  it('names spreadsheet columns beyond Z', () => {
    expect([1, 26, 27, 52, 53, 702, 703, 16384].map(colLetters)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD'])
  })
})

describe('docx writer', () => {
  const HOSTILE = '<script>alert("x")</script> & \'quotes\' ]]> \u0001\u0008ctl'
  const HOSTILE_CLEAN = '<script>alert("x")</script> & \'quotes\' ]]> ctl'

  it('produces a well-formed package with resolvable relationships and the required parts', () => {
    const bytes = buildDocx([page(1, [para('Hello world')])], { title: 'T & <t>' })
    const { files, docs, rels } = checkPackage(bytes)
    for (const p of ['word/document.xml', 'word/styles.xml', 'docProps/core.xml', 'docProps/app.xml', 'word/_rels/document.xml.rels']) expect(files[p], p).toBeTruthy()
    expect(rels['']!.map((r) => r.target).sort()).toEqual(['docProps/app.xml', 'docProps/core.xml', 'word/document.xml'])
    const body = docs['word/document.xml'].getElementsByTagNameNS(NS.w, 'body')[0]
    expect(body).toBeTruthy()
    // sectPr is the last child of the body
    const last = body.lastChild as Element
    expect(last.localName).toBe('sectPr')
    expect(textsOf(docs['docProps/core.xml'], 'http://purl.org/dc/elements/1.1/', 'title')).toEqual(['T & <t>'])
  })

  it('round-trips text, preserves spaces, escapes hostile input and turns tabs into w:tab', () => {
    const bytes = buildDocx([page(1, [para(HOSTILE), para('  lead and trail  '), para([run('a'), run('\t', {}), run('b')]), para('日本語 – ünïcödé ✓ 😀')])])
    const { docs } = checkPackage(bytes)
    const doc = docs['word/document.xml']
    const t = textsOf(doc, NS.w, 't')
    expect(t).toContain(HOSTILE_CLEAN)
    expect(t).toContain('  lead and trail  ')
    expect(t).toContain('日本語 – ünïcödé ✓ 😀')
    for (const el of Array.from(doc.getElementsByTagNameNS(NS.w, 't'))) expect(el.getAttribute('xml:space')).toBe('preserve')
    expect(doc.getElementsByTagNameNS(NS.w, 'tab').length).toBe(1)
  })

  it('writes run and paragraph properties in schema order', () => {
    const bytes = buildDocx([
      page(1, [
        para([run('Bold red', { bold: true, italic: true, color: 'FF0000', size: 14, family: 'Times New Roman' })], { align: 'center', indentLeft: 36, firstLine: -18, spaceBefore: 10, heading: 2 })
      ])
    ])
    const doc = checkPackage(bytes).docs['word/document.xml']
    const p = doc.getElementsByTagNameNS(NS.w, 'p')[0]
    expect((p.firstChild as Element).localName).toBe('pPr')
    const ppr = Array.from((p.firstChild as Element).childNodes).map((n) => (n as Element).localName)
    expect(ppr).toEqual(['pStyle', 'spacing', 'ind', 'jc'])
    const rpr = Array.from(doc.getElementsByTagNameNS(NS.w, 'rPr')[0].childNodes).map((n) => (n as Element).localName)
    expect(rpr).toEqual(['rFonts', 'b', 'bCs', 'i', 'iCs', 'color', 'sz', 'szCs'])
    const ind = doc.getElementsByTagNameNS(NS.w, 'ind')[0]
    expect(ind.getAttributeNS(NS.w, 'left')).toBe('720')
    expect(ind.getAttributeNS(NS.w, 'hanging')).toBe('360')
    expect(doc.getElementsByTagNameNS(NS.w, 'sz')[0].getAttributeNS(NS.w, 'val')).toBe('28')
  })

  it('uses heading styles that exist in styles.xml', () => {
    const { docs } = checkPackage(buildDocx([page(1, [para('Title', { heading: 1 }), para('Sub', { heading: 3 })])]))
    const used = Array.from(docs['word/document.xml'].getElementsByTagNameNS(NS.w, 'pStyle')).map((e) => e.getAttributeNS(NS.w, 'val'))
    expect(used).toEqual(['Heading1', 'Heading3'])
    const defined = Array.from(docs['word/styles.xml'].getElementsByTagNameNS(NS.w, 'style')).map((e) => e.getAttributeNS(NS.w, 'styleId'))
    for (const u of used) expect(defined).toContain(u)
    for (const s of ['Normal', 'Hyperlink', 'TableGrid']) expect(defined).toContain(s)
  })

  it('embeds hyperlinks as external relationships', () => {
    const { docs, rels } = checkPackage(buildDocx([page(1, [para([run('see '), run('the site', { url: 'https://example.com/a?b=1&c=2' })])])]))
    const link = docs['word/document.xml'].getElementsByTagNameNS(NS.w, 'hyperlink')[0]
    const id = link.getAttributeNS(NS.r, 'id')
    const rel = rels['word/document.xml']!.find((r) => r.id === id)!
    expect(rel.external).toBe(true)
    expect(rel.target).toBe('https://example.com/a?b=1&c=2')
    expect(rel.type).toMatch(/hyperlink$/)
    expect(textsOf(docs['word/document.xml'], NS.w, 't')).toEqual(['see ', 'the site'])
  })

  it('writes tables with a grid, a cell in every row position and a paragraph in every cell', () => {
    const t = table([['A', 'B', 'C'], ['1', '', '3']])
    const { docs } = checkPackage(buildDocx([page(1, [para('before'), t, para('after')])]))
    const doc = docs['word/document.xml']
    const tbl = doc.getElementsByTagNameNS(NS.w, 'tbl')[0]
    expect(tbl.getElementsByTagNameNS(NS.w, 'gridCol').length).toBe(3)
    const trs = Array.from(tbl.getElementsByTagNameNS(NS.w, 'tr'))
    expect(trs.length).toBe(2)
    for (const tr of trs) {
      const tcs = Array.from(tr.childNodes).filter((n) => (n as Element).localName === 'tc') as Element[]
      expect(tcs.length).toBe(3)
      for (const tc of tcs) expect(Array.from(tc.childNodes).some((n) => (n as Element).localName === 'p')).toBe(true)
    }
    expect(Array.from(tbl.getElementsByTagNameNS(NS.w, 'tblStyle'))[0].getAttributeNS(NS.w, 'val')).toBe('TableGrid')
    // a table is always followed by a paragraph, and table text comes out in order
    expect((tbl.nextSibling as Element).localName).toBe('p')
    expect(textsOf(doc, NS.w, 't')).toEqual(['before', 'A', 'B', 'C', '1', '3', 'after'])
  })

  it('does not draw borders for tables inferred from alignment', () => {
    const { docs } = checkPackage(buildDocx([page(1, [table([['a', 'b'], ['c', 'd']], { bordered: false })])]))
    expect(docs['word/document.xml'].getElementsByTagNameNS(NS.w, 'tblStyle').length).toBe(0)
  })

  it('embeds images once per distinct picture: blips = relationships = media parts', () => {
    const a = image({}, 1)
    const b = image({ y: 400 }, 2)
    const bytes = buildDocx([page(1, [{ type: 'image', image: a, spaceBefore: 0 }, para('x'), { type: 'image', image: b, spaceBefore: 5 }]), page(2, [{ type: 'image', image: a, spaceBefore: 0 }])])
    const { files, docs, rels } = checkPackage(bytes)
    const media = Object.keys(files).filter((n) => n.startsWith('word/media/'))
    expect(media.length).toBe(2)
    const blips = Array.from(docs['word/document.xml'].getElementsByTagNameNS(NS.a, 'blip'))
    expect(blips.length).toBe(3)
    const targets = new Set(blips.map((bl) => rels['word/document.xml']!.find((r) => r.id === bl.getAttributeNS(NS.r, 'embed'))!.target))
    expect([...targets].sort()).toEqual(media.sort())
    // unique drawing object ids
    const ids = Array.from(docs['word/document.xml'].getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'docPr')).map((e) => e.getAttribute('id'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(Array.from(files['word/media/image1.png'].slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('scales images that are wider than the text area', () => {
    const { docs } = checkPackage(buildDocx([page(1, [{ type: 'image', image: image({ width: 1000, height: 500 }), spaceBefore: 0 }])]))
    const ext = docs['word/document.xml'].getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent')[0]
    expect(Number(ext.getAttribute('cx'))).toBe(Math.round(468 * 12700))
    expect(Number(ext.getAttribute('cy'))).toBe(Math.round(234 * 12700))
  })

  it('separates PDF pages with page breaks, and starts a section when the page size changes', () => {
    const same = checkPackage(buildDocx([page(1, [para('one')]), page(2, [para('two')]), page(3, [para('three')])])).docs['word/document.xml']
    const breaks = Array.from(same.getElementsByTagNameNS(NS.w, 'br')).filter((b) => b.getAttributeNS(NS.w, 'type') === 'page')
    expect(breaks.length).toBe(2)
    expect(same.getElementsByTagNameNS(NS.w, 'sectPr').length).toBe(1)

    const mixed = checkPackage(buildDocx([page(1, [para('portrait')]), page(2, [para('landscape')], { width: 792, height: 612 }), page(3, [para('landscape 2')], { width: 792, height: 612 })])).docs['word/document.xml']
    const sects = Array.from(mixed.getElementsByTagNameNS(NS.w, 'sectPr'))
    expect(sects.length).toBe(2)
    const sizes = sects.map((s) => {
      const sz = s.getElementsByTagNameNS(NS.w, 'pgSz')[0]
      return [sz.getAttributeNS(NS.w, 'w'), sz.getAttributeNS(NS.w, 'h'), sz.getAttributeNS(NS.w, 'orient')]
    })
    expect(sizes).toEqual([['12240', '15840', null], ['15840', '12240', 'landscape']])
    // the first section's sectPr lives in a paragraph, the last one directly in the body
    expect((sects[0].parentNode as Element).localName).toBe('pPr')
    expect((sects[1].parentNode as Element).localName).toBe('body')
    // only one page break: between the two landscape pages
    expect(Array.from(mixed.getElementsByTagNameNS(NS.w, 'br')).length).toBe(1)
  })

  it('handles an empty document and blank pages', () => {
    checkPackage(buildDocx([]))
    const { docs } = checkPackage(buildDocx([page(1, []), page(2, [])]))
    expect(docs['word/document.xml'].getElementsByTagNameNS(NS.w, 'p').length).toBeGreaterThanOrEqual(2)
  })
})

describe('xlsx writer', () => {
  const sheets = (): SheetData[] => [
    {
      name: 'Data',
      rows: [
        [cellFromText('Item', { bold: true }), cellFromText('Qty', { bold: true }), cellFromText('Share', { bold: true }), cellFromText('Price')],
        [cellFromText('Apples <&>'), cellFromText('1,200'), cellFromText('12.5%'), cellFromText('$1,234.50')],
        [cellFromText('007'), cellFromText('-3'), null, cellFromText('  spaced  ')]
      ]
    },
    { name: 'Second', rows: [[null, null, cellFromText('far right')]] }
  ]

  it('produces a well-formed workbook with one worksheet part per sheet', () => {
    const { files, docs, rels } = checkPackage(buildXlsx(sheets()))
    for (const p of ['xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'docProps/core.xml']) expect(files[p], p).toBeTruthy()
    const sheetEls = Array.from(docs['xl/workbook.xml'].getElementsByTagNameNS(NS.x, 'sheet'))
    expect(sheetEls.map((s) => s.getAttribute('name'))).toEqual(['Data', 'Second'])
    for (const s of sheetEls) {
      const rel = rels['xl/workbook.xml']!.find((r) => r.id === s.getAttributeNS(NS.r, 'id'))!
      expect(rel.type).toMatch(/worksheet$/)
      expect(files[rel.target]).toBeTruthy()
    }
  })

  it('stores numbers as numbers with number formats, and text (incl. leading zeros) as shared strings', () => {
    const { docs } = checkPackage(buildXlsx(sheets()))
    const sheet = docs['xl/worksheets/sheet1.xml']
    const cells = new Map(Array.from(sheet.getElementsByTagNameNS(NS.x, 'c')).map((c) => [c.getAttribute('r')!, c]))
    const sst = textsOf(docs['xl/sharedStrings.xml'], NS.x, 't')
    const str = (ref: string): string => sst[Number(cells.get(ref)!.getElementsByTagNameNS(NS.x, 'v')[0].textContent)]
    const num = (ref: string): number => Number(cells.get(ref)!.getElementsByTagNameNS(NS.x, 'v')[0].textContent)
    expect(cells.get('B2')!.getAttribute('t')).toBeNull()
    expect(num('B2')).toBe(1200)
    expect(num('C2')).toBeCloseTo(0.125)
    expect(num('D2')).toBe(1234.5)
    expect(num('B3')).toBe(-3)
    expect(str('A2')).toBe('Apples <&>')
    expect(str('A3')).toBe('007') // identifiers with leading zeros stay text
    expect(str('D3')).toBe('spaced')
    expect(cells.has('C3')).toBe(false)
    // number formats: thousands -> id 3, percent -> custom or 10, currency -> custom with the symbol
    const xfs = Array.from(docs['xl/styles.xml'].getElementsByTagNameNS(NS.x, 'cellXfs')[0].getElementsByTagNameNS(NS.x, 'xf'))
    const fmtOf = (ref: string): string => xfs[Number(cells.get(ref)!.getAttribute('s') ?? 0)].getAttribute('numFmtId')!
    expect(fmtOf('B2')).toBe('3')
    const custom = Object.fromEntries(Array.from(docs['xl/styles.xml'].getElementsByTagNameNS(NS.x, 'numFmt')).map((n) => [n.getAttribute('numFmtId'), n.getAttribute('formatCode')]))
    expect(custom[fmtOf('C2')]).toBe('0.0%')
    expect(custom[fmtOf('D2')]).toBe('"$"#,##0.00')
    // header cells are bold
    const fontOf = (ref: string): string => xfs[Number(cells.get(ref)!.getAttribute('s') ?? 0)].getAttribute('fontId')!
    expect(fontOf('A1')).toBe('1')
    expect(fontOf('A2')).toBe('0')
  })

  it('counts shared strings correctly and keeps cell references in ascending order (incl. columns beyond Z)', () => {
    const wide: SheetData = { name: 'W', rows: [Array.from({ length: 30 }, (_, i) => cellFromText(`c${i}`)), [cellFromText('c0')]] }
    const { docs } = checkPackage(buildXlsx([wide]))
    const sst = docs['xl/sharedStrings.xml'].documentElement
    expect(sst.getAttribute('uniqueCount')).toBe('30')
    expect(sst.getAttribute('count')).toBe('31')
    const refs = Array.from(docs['xl/worksheets/sheet1.xml'].getElementsByTagNameNS(NS.x, 'c')).map((c) => c.getAttribute('r'))
    expect(refs.slice(24, 30)).toEqual(['Y1', 'Z1', 'AA1', 'AB1', 'AC1', 'AD1'])
    expect(docs['xl/worksheets/sheet1.xml'].getElementsByTagNameNS(NS.x, 'dimension')[0].getAttribute('ref')).toBe('A1:AD2')
  })

  it('makes valid, unique sheet names', () => {
    const used = new Set<string>()
    expect(sheetName('Q1: Sales/Costs [draft]?', used)).toBe('Q1- Sales-Costs -draft--')
    expect(sheetName("'quoted'", used)).toBe('quoted')
    expect(sheetName('x'.repeat(40), used)).toHaveLength(31)
    expect(sheetName('x'.repeat(40), used)).toHaveLength(31)
    expect(sheetName('', used)).toBe('Sheet')
    expect(sheetName('SHEET', used)).toBe('SHEET (2)') // names are unique case-insensitively
    expect(new Set([...used]).size).toBe(used.size)
    const { docs } = checkPackage(buildXlsx([{ name: 'a', rows: [] }, { name: 'b', rows: [] }]))
    expect(docs['xl/workbook.xml'].getElementsByTagNameNS(NS.x, 'sheet').length).toBe(2)
    checkPackage(buildXlsx([]))
  })

  it('sheet selection: one sheet per table (falling back to per page) or one per page', () => {
    const layouts = [
      page(1, [para('Intro line', { srcLines: [['Intro line']] }), table([['H1', 'H2'], ['1', '2']])]),
      page(2, [para('Second page', { srcLines: [['Second', 'page']] }), table([['A', 'B'], ['3', '4']])])
    ]
    const perTable = buildSheets(layouts, { xlsxMode: 'tables' })
    expect(perTable.map((s) => s.name)).toEqual(['Table 1', 'Table 2'])
    expect(perTable[0].rows.map((r) => r.map((c) => c?.value))).toEqual([['H1', 'H2'], [1, 2]])
    const perPage = buildSheets(layouts, { xlsxMode: 'pages' })
    expect(perPage.map((s) => s.name)).toEqual(['Page 1', 'Page 2'])
    expect(perPage[1].rows.map((r) => r.map((c) => c?.value))).toEqual([['Second', 'page'], ['A', 'B'], [3, 4]])
    const noTables = buildSheets([page(1, [para('only text')])], { xlsxMode: 'tables' })
    expect(noTables.map((s) => s.name)).toEqual(['Page 1'])
  })

  it('marks an all-bold first row as a header', () => {
    const t = table([['a', 'b'], ['1', '2']])
    t.rows[0] = [cell('Name', { bold: true }), cell('Total', { bold: true, align: 'right' })]
    const s = buildSheets([page(1, [t])], { xlsxMode: 'tables' })[0]
    expect(s.rows[0].map((c) => c?.bold)).toEqual([true, true])
    expect(s.rows[1].map((c) => c?.bold)).toEqual([undefined, undefined])
    expect(s.rows[0][1]?.align).toBe('right')
  })
})

describe('pptx writer', () => {
  it('produces a complete, well-formed presentation (master, layout, theme, slides)', () => {
    const bytes = buildPptx([page(1, [para('Slide one', { y: 100 })]), page(2, [para('Slide two')])], { title: 'Deck' })
    const { files, docs, rels } = checkPackage(bytes)
    for (const p of [
      'ppt/presentation.xml',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml',
      'ppt/presProps.xml',
      'ppt/viewProps.xml',
      'ppt/tableStyles.xml',
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml'
    ]) {
      expect(files[p], p).toBeTruthy()
    }
    const pres = docs['ppt/presentation.xml']
    const sldIds = Array.from(pres.getElementsByTagNameNS(NS.p, 'sldId'))
    expect(sldIds.length).toBe(2)
    for (const s of sldIds) {
      const rel = rels['ppt/presentation.xml']!.find((r) => r.id === s.getAttributeNS(NS.r, 'id'))!
      expect(rel.type).toMatch(/slide$/)
    }
    // required child order of p:presentation
    expect(Array.from(pres.documentElement.childNodes).map((n) => (n as Element).localName)).toEqual(['sldMasterIdLst', 'sldIdLst', 'sldSz', 'notesSz'])
    const sz = pres.getElementsByTagNameNS(NS.p, 'sldSz')[0]
    expect([sz.getAttribute('cx'), sz.getAttribute('cy')]).toEqual([String(612 * 12700), String(792 * 12700)])
    // the master lists its layout; the layout points back to the master
    expect(rels['ppt/slideMasters/slideMaster1.xml']!.map((r) => r.target).sort()).toEqual(['ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml'])
    expect(rels['ppt/slideLayouts/slideLayout1.xml']![0].target).toBe('ppt/slideMasters/slideMaster1.xml')
  })

  it('round-trips text with hostile characters and every txBody has bodyPr, lstStyle and a paragraph', () => {
    const text = '<b>&</b> "quoted" \u0002 done'
    const { docs } = checkPackage(buildPptx([page(1, [para(text), para([run('x', { bold: true, italic: true, color: 'FF8800', size: 20, family: 'Courier New' })])])]))
    const slide = docs['ppt/slides/slide1.xml']
    expect(textsOf(slide, NS.a, 't')).toEqual(['<b>&</b> "quoted"  done', 'x'])
    for (const tx of Array.from(slide.getElementsByTagNameNS(NS.p, 'txBody'))) {
      expect(Array.from(tx.childNodes).map((n) => (n as Element).localName).slice(0, 3)).toEqual(['bodyPr', 'lstStyle', 'p'])
    }
    const rPr = slide.getElementsByTagNameNS(NS.a, 'rPr')[1]
    expect(rPr.getAttribute('sz')).toBe('2000')
    expect(rPr.getAttribute('b')).toBe('1')
    expect(rPr.getElementsByTagNameNS(NS.a, 'latin')[0].getAttribute('typeface')).toBe('Courier New')
  })

  it('places pictures and text at their positions in EMU', () => {
    const { docs, files, rels } = checkPackage(buildPptx([page(1, [para('T', { x: 100, y: 50, width: 200, height: 20 }), { type: 'image', image: image({ x: 10, y: 20, width: 30, height: 40 }), spaceBefore: 0 }])]))
    const pic = docs['ppt/slides/slide1.xml'].getElementsByTagNameNS(NS.p, 'pic')
    expect(pic.length).toBe(1)
    const off = pic[0].getElementsByTagNameNS(NS.a, 'off')[0]
    const ext = pic[0].getElementsByTagNameNS(NS.a, 'ext')[0]
    expect([off.getAttribute('x'), off.getAttribute('y'), ext.getAttribute('cx'), ext.getAttribute('cy')]).toEqual(['127000', '254000', '381000', '508000'])
    const rid = pic[0].getElementsByTagNameNS(NS.a, 'blip')[0].getAttributeNS(NS.r, 'embed')
    const target = rels['ppt/slides/slide1.xml']!.find((r) => r.id === rid)!.target
    expect(target).toBe('ppt/media/image1.png')
    expect(files[target]).toBeTruthy()
    const sp = docs['ppt/slides/slide1.xml'].getElementsByTagNameNS(NS.p, 'sp')[0].getElementsByTagNameNS(NS.a, 'off')[0]
    expect([sp.getAttribute('x'), sp.getAttribute('y')]).toEqual(['1270000', '635000'])
  })

  it('fits pages of another size onto the slide size (scaled, centred)', () => {
    const { docs } = checkPackage(buildPptx([page(1, [para('a')]), page(2, [para('b', { x: 0, y: 0 })], { width: 306, height: 396 })]))
    const sz = docs['ppt/presentation.xml'].getElementsByTagNameNS(NS.p, 'sldSz')[0]
    expect(sz.getAttribute('cx')).toBe(String(612 * 12700))
    const off = docs['ppt/slides/slide2.xml'].getElementsByTagNameNS(NS.a, 'off')[1]
    expect(off.getAttribute('x')).toBe('0') // 306x396 scaled by 2 fills the slide exactly
    expect(Array.from(docs['ppt/slides/slide2.xml'].getElementsByTagNameNS(NS.a, 'rPr'))[0].getAttribute('sz')).toBe('2200')
  })

  it('draws table cells as shapes, bordered only for ruled tables, and links as relationships', () => {
    const { docs, rels } = checkPackage(
      buildPptx([page(1, [table([['a', 'b'], ['c', 'd']]), para([run('go', { url: 'https://example.com' })], { y: 400 })])])
    )
    const slide = docs['ppt/slides/slide1.xml']
    expect(textsOf(slide, NS.a, 't')).toEqual(['a', 'b', 'c', 'd', 'go'])
    expect(slide.getElementsByTagNameNS(NS.a, 'ln').length).toBe(5)
    const hl = slide.getElementsByTagNameNS(NS.a, 'hlinkClick')[0]
    const rel = rels['ppt/slides/slide1.xml']!.find((r) => r.id === hl.getAttributeNS(NS.r, 'id'))!
    expect(rel.external).toBe(true)
    expect(rel.target).toBe('https://example.com')
  })

  it('writes a valid package for an empty document', () => {
    const { docs } = checkPackage(buildPptx([]))
    expect(docs['ppt/presentation.xml'].getElementsByTagNameNS(NS.p, 'sldId').length).toBe(1)
  })
})
