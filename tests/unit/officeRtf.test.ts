import { resolve } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { makePng, solid } from '../support/images'
import { flattenText, readPdf } from '../support/pdfText'

const fontsDir = resolve('resources/fonts')

const HEAD =
  '{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}{\\f1\\fswiss\\fcharset0 Arial;}{\\f2\\fmodern\\fcharset0 Courier New;}{\\f3\\fnil\\fcharset2 Symbol;}}' +
  '{\\colortbl;\\red255\\green0\\blue0;\\red0\\green0\\blue255;\\red192\\green192\\blue192;}'
const PAGE = '\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440\\headery720\\footery720'
const doc = (body: string, extra = ''): Buffer => Buffer.from(`${HEAD}${extra}${PAGE}\\sectd ${body}}`, 'latin1')
const run = (bytes: Buffer, name = 'test.rtf') => convertOffice({ name, bytes }, { fontsDir })
const conv = (body: string, extra = '') => run(doc(body, extra))

describe('RTF: text and character formatting', () => {
  it('keeps paragraphs in order and uses the document fonts', async () => {
    const r = await conv('\\pard\\plain\\f0\\fs24 First paragraph in Times.\\par \\pard\\f1\\fs24 Second in Arial.\\par \\pard\\f2\\fs20 Third in Courier.\\par')
    expect(r.warnings).toEqual([])
    const { pages } = await readPdf(r.bytes)
    expect(pages).toHaveLength(1)
    expect(pages[0].width).toBeCloseTo(612)
    expect(pages[0].text).toBe('First paragraph in Times.\nSecond in Arial.\nThird in Courier.')
    const fonts = pages[0].items.filter((i) => i.str.trim()).map((i) => i.font)
    expect(fonts[0]).toMatch(/LiberationSerif/)
    expect(fonts[1]).toMatch(/LiberationSans/)
    expect(fonts[2]).toMatch(/LiberationMono/)
    // 12pt / 10pt sizes come from \fs
    const real = pages[0].items.filter((i) => i.str.trim())
    expect(real[0].size).toBeCloseTo(12, 0)
    expect(real[2].size).toBeCloseTo(10, 0)
  })

  it('applies bold, italic and font size runs inside a paragraph', async () => {
    const r = await conv('\\pard\\plain\\f1\\fs24 plain {\\b bold} {\\i italic} {\\b\\i both} {\\fs48 big}\\par')
    const { pages } = await readPdf(r.bytes)
    const items = pages[0].items.filter((i) => i.str.trim())
    const by = (s: string) => items.find((i) => i.str.includes(s))!
    expect(by('bold').font).toMatch(/Bold/)
    expect(by('bold').font).not.toMatch(/Italic/)
    expect(by('italic').font).toMatch(/Italic/)
    expect(by('both').font).toMatch(/BoldItalic/)
    expect(by('big').size).toBeCloseTo(24, 0)
    expect(pages[0].text).toBe('plain bold italic both big')
  })

  it('decodes \\\'hh escapes, \\uN (with \\uc skipping), special characters and symbols', async () => {
    const r = await conv("\\pard\\plain\\f1 caf\\'e9 \\u8364? \\u1055\\'3f\\u1088\\'3f \\endash \\emdash \\lquote x\\rquote \\bullet \\~nb {\\\\}\\par")
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].text
    expect(t).toContain('café')
    expect(t).toContain('€')
    expect(t).toContain('Пр')
    expect(t).toContain('–—')
    expect(t).toContain('‘x’')
    expect(t).toContain('•')
    expect(t).toContain('\\')
  })

  it('decodes text through the font charset (Cyrillic and Greek code pages)', async () => {
    const bytes = Buffer.from(
      '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset204 Arial;}{\\f1\\fswiss\\fcharset161 Arial;}}\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440\\pard\\f0 \\\'cf\\\'f0\\\'e8\\\'e2\\\'e5\\\'f2\\par\\pard\\f1 \\\'c2\\\'e5\\\'ed\\par}',
      'latin1'
    )
    const r = await run(bytes)
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].text).toBe('Привет\nΒεν')
  })

  it('applies colours, highlight, underline, strike, super/subscript and caps without losing text', async () => {
    const r = await conv('\\pard\\plain\\f1\\fs24 a{\\cf1 red}{\\highlight3 hl}{\\ul under}{\\strike gone}x{\\super 2}H{\\sub 2}O {\\caps small}\\par')
    const { pages } = await readPdf(r.bytes)
    const flat = pages[0].text.replace(/\s/g, '')
    for (const w of ['ared', 'hl', 'under', 'gone', 'x', 'SMALL']) expect(flat).toContain(w)
    expect(flat.match(/2/g)).toHaveLength(2)
    // the superscript is drawn smaller than the body text
    const sup = pages[0].items.find((i) => i.str === '2')!
    expect(sup.size).toBeLessThan(12)
  })

  it('hidden text is not shown, \\line and \\tab work', async () => {
    const r = await conv('\\pard\\plain\\f1 shown{\\v HIDDEN} one\\line two\\tab three\\par')
    const { pages } = await readPdf(r.bytes)
    expect(flattenText(pages)).toBe('shown one two three')
    expect(flattenText(pages)).not.toMatch(/HIDDEN/)
    const two = pages[0].items.find((i) => i.str.includes('two'))!
    const three = pages[0].items.find((i) => i.str.includes('three'))!
    expect(three.x).toBeGreaterThan(two.x + 30)
  })
})

describe('RTF: paragraph formatting', () => {
  it('honours alignment, indents and spacing', async () => {
    const r = await conv(
      '\\pard\\plain\\f1\\fs24\\ql left\\par \\pard\\qc centre\\par \\pard\\qr right\\par \\pard\\li1440\\fi-720 hanging indent line that is long enough to wrap around the page so that the second line starts at the left indent position for sure, yes it does\\par \\pard\\sb1200\\sa600 spaced\\par \\pard after\\par'
    )
    const { pages } = await readPdf(r.bytes)
    const it = (s: string) => pages[0].items.find((i) => i.str.includes(s))!
    const marginLeft = 72
    expect(it('left').x).toBeCloseTo(marginLeft, 0)
    expect(it('centre').x).toBeGreaterThan(200)
    expect(it('centre').x + it('centre').w).toBeLessThan(412)
    expect(it('right').x + it('right').w).toBeCloseTo(540, 0)
    expect(it('hanging').x).toBeCloseTo(marginLeft + 72 - 36, 0)
    const lines = pages[0].text.split('\n')
    expect(lines.length).toBeGreaterThan(6)
    const second = pages[0].items.find((i) => i.str.includes('starts at the') || i.str.startsWith('the second') || i.str.includes('second line'))
    if (second) expect(second.x).toBeGreaterThanOrEqual(marginLeft + 72 - 1)
    const spaced = it('spaced')
    const after = it('after')
    expect(after.y - spaced.y).toBeGreaterThan(30 + 12) // \sa600 (30pt) plus a line
  })

  it('supports line spacing, page-break-before, tab stops with leaders, borders and shading', async () => {
    const r = await conv(
      '\\pard\\plain\\f1\\fs24\\sl480\\slmult1 double spaced one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four\\par ' +
        '\\pard\\pagebb\\tqr\\tldot\\tx8000 Title\\tab 42\\par ' +
        '\\pard\\box\\brdrs\\brdrw15\\brdrcf1\\cbpat3\\li200 boxed paragraph\\par'
    )
    const { pages } = await readPdf(r.bytes)
    expect(pages).toHaveLength(2)
    expect(pages[0].text.startsWith('double spaced')).toBe(true)
    const y = pages[0].items.map((i) => i.y)
    expect(y[1] - y[0]).toBeGreaterThan(20) // double spacing of 12pt text
    expect(pages[1].text).toContain('Title')
    expect(pages[1].text).toContain('42')
    expect(pages[1].text).toContain('.....') // dot leader
    expect(pages[1].text).toContain('boxed paragraph')
  })

  it('uses styles from the stylesheet (\\sN with \\sbasedon)', async () => {
    const styles = '{\\stylesheet{\\s0\\snext0 Normal;}{\\s1\\sbasedon0\\snext0\\qc\\b\\fs36 Heading;}{\\s2\\sbasedon1\\i Sub;}{\\*\\cs10 Emph;}}'
    const r = await conv('\\pard\\plain\\s1 Title text\\par \\pard\\plain\\s2 Sub text\\par \\pard\\plain\\s0 Body\\par', styles)
    const { pages } = await readPdf(r.bytes)
    const it = (s: string) => pages[0].items.find((i) => i.str.includes(s))!
    expect(it('Title').font).toMatch(/Bold/)
    expect(it('Title').size).toBeCloseTo(18, 0)
    expect(it('Sub').font).toMatch(/BoldItalic/)
    expect(it('Body').font).not.toMatch(/Bold/)
  })
})

describe('RTF: page setup, sections, headers and footers', () => {
  it('reads page size, orientation, margins and columns', async () => {
    const bytes = Buffer.from('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\paperw15840\\paperh12240\\landscape\\margl720\\margr720\\margt720\\margb720\\pard\\sectd\\cols2\\colsx360 Landscape text\\par}', 'latin1')
    const r = await run(bytes)
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].width).toBeCloseTo(792)
    expect(pages[0].height).toBeCloseTo(612)
    expect(pages[0].items[0].x).toBeCloseTo(36, 0)
  })

  it('handles multiple sections with different page sizes', async () => {
    const r = await conv('\\pard One\\par \\sect\\sectd\\paperw8000\\paperh10000\\margl720\\margr720\\margt720\\margb720 Two\\par')
    const { pages } = await readPdf(r.bytes)
    expect(pages).toHaveLength(2)
    expect(pages[1].width).toBeCloseTo(400)
    expect(pages[1].height).toBeCloseTo(500)
    expect(pages[0].text).toBe('One')
    expect(pages[1].text).toBe('Two')
  })

  it('draws headers and footers with page numbers on every page, and a different first page', async () => {
    const body = Array.from({ length: 120 }, (_, i) => `\\pard\\plain\\f1\\fs24 Body paragraph ${i + 1}\\par`).join('')
    const r = await conv(
      `\\titlepg{\\header \\pard\\plain\\f1 Running header\\par}{\\headerf \\pard\\plain\\f1 First page header\\par}{\\footer \\pard\\plain\\qc\\f1 Page {\\field{\\*\\fldinst PAGE}{\\fldrslt 1}} of {\\field{\\*\\fldinst NUMPAGES}{\\fldrslt 1}}\\par}${body}`
    )
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(2)
    expect(pages[0].text).toMatch(/^First page header/)
    for (let i = 1; i < pages.length; i++) expect(pages[i].text).toMatch(/^Running header/)
    // the first page has no footer (no \footerf), the others show "Page n of N"
    expect(pages[0].text).not.toMatch(/Page 1 of/)
    for (let i = 1; i < pages.length; i++) expect(pages[i].text).toContain(`Page ${i + 1} of ${pages.length}`)
  })

  it('never loses text across many pages', async () => {
    const paras = Array.from({ length: 300 }, (_, i) => `Paragraph number ${i + 1} with some words to fill the line and wrap now and then.`)
    const r = await conv(paras.map((p) => `\\pard\\plain\\f0\\fs22\\sa120 ${p}\\par`).join('\n'))
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(4)
    expect(flattenText(pages)).toBe(paras.join(' '))
  })
})

describe('RTF: tables', () => {
  const cell = (t: string, extra = ''): string => `\\pard\\intbl\\f1\\fs22 ${t}${extra}\\cell`

  it('builds a table with the right column positions and keeps the text in cell order', async () => {
    const def = '\\trowd\\trgaph108\\trleft-108\\cellx3000\\cellx6000\\cellx9000'
    const rows = ['A1', 'B1', 'C1'].join(',')
    void rows
    const r = await conv(
      `${def}${cell('A1')}${cell('B1')}${cell('C1')}\\row\n${def}${cell('A2')}${cell('B2')}${cell('C2')}\\row\n\\pard\\plain\\f1 After the table\\par`
    )
    const { pages } = await readPdf(r.bytes)
    const it = (s: string) => pages[0].items.find((i) => i.str.includes(s))!
    expect(pages[0].text).toBe('A1 B1 C1\nA2 B2 C2\nAfter the table')
    // columns start at 72pt (margin) + 0, 150, 300 (3000 twips = 150pt) minus the -108 twip start shift
    // (the first column also spans the -108 twip start offset, i.e. 5.4pt more)
    expect(it('B1').x - it('A1').x).toBeCloseTo(155.4, 0)
    expect(it('C1').x - it('B1').x).toBeCloseTo(150, 0)
    expect(it('B2').x).toBeCloseTo(it('B1').x, 0)
    expect(it('A2').y).toBeGreaterThan(it('A1').y)
  })

  it('handles horizontal and vertical merges, cell shading, borders and header rows', async () => {
    const r = await conv(
      '\\trowd\\trhdr\\clcbpat1\\cellx3000\\clcbpat2\\cellx6000' + cell('H1') + cell('H2') + '\\row\n' +
        '\\trowd\\clmgf\\clbrdrt\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\cellx3000\\clmrg\\cellx6000' + cell('merged') + cell('') + '\\row\n' +
        '\\trowd\\clvmgf\\cellx3000\\cellx6000' + cell('tall') + cell('r') + '\\row\n' +
        '\\trowd\\clvmrg\\cellx3000\\cellx6000' + cell('') + cell('s') + '\\row\n' +
        '\\pard\\plain done\\par'
    )
    expect(r.warnings).toEqual([])
    const { pages } = await readPdf(r.bytes)
    expect(flattenText(pages)).toBe('H1 H2 merged tall r s done')
    const it = (s: string) => pages[0].items.find((i) => i.str.includes(s))!
    expect(it('s').y).toBeGreaterThan(it('r').y)
    expect(it('tall').y).toBeLessThan(it('s').y + 20)
  })

  it('repeats header rows when a table spans pages and never drops a row', async () => {
    const def = (hdr: boolean): string => `\\trowd${hdr ? '\\trhdr' : ''}\\trgaph108\\cellx4000\\cellx8000`
    const rows = Array.from({ length: 90 }, (_, i) => `${def(false)}${cell(`row${i + 1}`)}${cell(`v${i + 1}`)}\\row\n`).join('')
    const r = await conv(`${def(true)}${cell('Name')}${cell('Value')}\\row\n${rows}`)
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(1)
    for (const p of pages) expect(p.text.startsWith('Name Value')).toBe(true)
    const all = pages.map((p) => p.text).join('\n')
    for (let i = 1; i <= 90; i++) expect(all).toContain(`row${i} v${i}`)
  })

  it('handles rows without a definition (evenly split) and multi-paragraph cells', async () => {
    const r = await conv('\\pard\\intbl one\\par\\pard\\intbl two\\cell\\pard\\intbl three\\cell\\row\\pard after\\par')
    const { pages } = await readPdf(r.bytes)
    const f = flattenText(pages)
    for (const w of ['one', 'two', 'three', 'after']) expect(f).toContain(w)
    const at = (s: string) => pages[0].items.find((i) => i.str.includes(s))!
    expect(at('three').x).toBeGreaterThan(at('one').x + 100)
    expect(at('two').y).toBeGreaterThan(at('one').y)
  })
})

describe('RTF: lists, fields, footnotes, pictures', () => {
  it('generates bullets and numbers from the list table', async () => {
    const lists =
      '{\\*\\listtable{\\list\\listtemplateid1\\listsimple{\\listlevel\\levelnfc23\\levelstartat1{\\leveltext\\\'01\\u-3913 ?;}{\\levelnumbers;}\\f3\\fi-360\\li720}\\listid101}' +
      '{\\list\\listtemplateid2\\listsimple{\\listlevel\\levelnfc0\\levelstartat1{\\leveltext\\\'02\\\'00.;}{\\levelnumbers\\\'01;}\\fi-360\\li720}{\\listlevel\\levelnfc4\\levelstartat1{\\leveltext\\\'02\\\'01);}{\\levelnumbers\\\'01;}\\fi-360\\li1440}\\listid102}}' +
      '{\\*\\listoverridetable{\\listoverride\\listid101\\listoverridecount0\\ls1}{\\listoverride\\listid102\\listoverridecount0\\ls2}}'
    const r = await conv(
      '\\pard\\plain\\ls1\\ilvl0\\f1 bullet one\\par \\pard\\ls1 bullet two\\par ' +
        '\\pard\\ls2\\ilvl0 first\\par \\pard\\ls2\\ilvl1 sub a\\par \\pard\\ls2\\ilvl1 sub b\\par \\pard\\ls2\\ilvl0 second\\par \\pard\\plain end\\par',
      lists
    )
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].text
    expect(t).toContain('•')
    expect(t).toMatch(/1\.\s*first/)
    expect(t).toMatch(/a\)\s*sub a/)
    expect(t).toMatch(/b\)\s*sub b/)
    expect(t).toMatch(/2\.\s*second/)
    // text sits at the left indent
    const it = pages[0].items.find((i) => i.str.includes('bullet one'))!
    expect(it.x).toBeCloseTo(72 + 36, 0)
  })

  it('uses \\pntext / \\listtext fallback markers when there is no list definition', async () => {
    const r = await conv('{\\pntext\\pard\\plain\\f3 \\\'b7\\tab}\\pard\\li720\\fi-360 legacy bullet\\par {\\listtext\\pard 1.\\tab}\\pard\\li720\\fi-360 listtext one\\par')
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].text).toContain('•')
    expect(pages[0].text).toMatch(/1\.\s*listtext one/)
    expect(pages[0].text.match(/1\./g)).toHaveLength(1)
  })

  it('turns HYPERLINK fields into link annotations and keeps other field results', async () => {
    const r = await conv('\\pard\\plain\\f1 Visit {\\field{\\*\\fldinst HYPERLINK "https://example.com/x"}{\\fldrslt {\\ul\\cf2 example site}}} on {\\field{\\*\\fldinst DATE}{\\fldrslt 1 May 2024}}.\\par')
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].text).toBe('Visit example site on 1 May 2024.')
    const pdf = await PDFDocument.load(r.bytes)
    const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
    expect(annots.size()).toBe(1)
    const a = annots.lookup(0, PDFDict).lookup(PDFName.of('A'), PDFDict)
    expect(a.get(PDFName.of('URI'))?.toString()).toContain('https://example.com/x')
  })

  it('moves footnotes to the end with a warning', async () => {
    const r = await conv('\\pard\\plain\\f1 Body text{\\super \\chftn}{\\footnote \\pard\\plain\\f1\\fs18 {\\super \\chftn} The note text.} continues.\\par')
    const { pages } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    expect(flat).toContain('Body text')
    expect(flat).toContain('continues.')
    expect(flat).toContain('The note text.')
    expect(flat.indexOf('The note text.')).toBeGreaterThan(flat.indexOf('continues.'))
    expect(r.warnings.join(' ')).toMatch(/Footnotes/)
  })

  it('embeds PNG/JPEG pictures (hex) at their goal size and replaces metafiles with a placeholder', async () => {
    const png = Buffer.from(makePng(20, 10, solid(200, 0, 0))).toString('hex')
    const r = await conv(
      `\\pard\\plain\\f1 Before {\\pict\\pngblip\\picw20\\pich10\\picwgoal2400\\pichgoal1200 ${png}} after\\par ` +
        '{\\pict\\wmetafile8\\picw100\\pich100\\picwgoal1000\\pichgoal1000 0100090000034a00}\\par'
    )
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].imageCount).toBe(1)
    expect(pages[0].text).toContain('Before')
    expect(pages[0].text).toContain('after')
    expect(pages[0].text).toContain('[Image:')
    expect(r.warnings.join(' ')).toMatch(/picture/)
  })

  it('keeps text inside shapes/text boxes and warns', async () => {
    const r = await conv('\\pard Before\\par {\\shp{\\*\\shpinst{\\sp{\\sn shapeType}{\\sv 202}}{\\shptxt \\pard boxed text\\par}}}{\\shprslt fallback}\\pard After\\par')
    const { pages } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    expect(flat).toContain('boxed text')
    expect(flat).not.toContain('fallback')
    expect(r.warnings.join(' ')).toMatch(/shapes/)
  })
})

describe('RTF: robustness', () => {
  it('shows non-RTF content as plain text with a warning', async () => {
    const r = await run(Buffer.from('just some plain text\nin a file called .rtf'), 'weird.rtf')
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].text).toContain('just some plain text')
    expect(r.warnings.join(' ')).toMatch(/does not look like RTF/)
  })

  it('survives truncated input and random garbage without hanging', async () => {
    const full = doc('\\pard\\plain\\f1 hello {\\b bold {\\i deep} text\\par')
    const cut = full.subarray(0, full.length - 15)
    const r1 = await run(cut)
    expect(flattenText((await readPdf(r1.bytes)).pages)).toContain('hello')
    const junk = Buffer.alloc(5000)
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37 + 11) % 256
    const r2 = await run(Buffer.concat([Buffer.from('{\\rtf1\\ansi'), junk, Buffer.from('}')]))
    expect(r2.pages).toBeGreaterThanOrEqual(1)
  })

  it('does not overflow the stack on very deep nesting (and warns)', async () => {
    const depth = 20000
    const r = await run(Buffer.from(`{\\rtf1\\ansi ${'{'.repeat(depth)}deep${'}'.repeat(depth)} \\par visible\\par}`))
    expect(r.pages).toBeGreaterThanOrEqual(1)
    expect(r.warnings.join(' ')).toMatch(/nests groups/)
    expect(flattenText((await readPdf(r.bytes)).pages)).toContain('visible')
  })

  it('skips \\bin data and ignorable destinations', async () => {
    const bytes = Buffer.concat([Buffer.from('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}{\\*\\unknownthing secret text}{\\info{\\title Hidden Title}}before \\bin5 {}\\\\ after\\par}', 'latin1')])
    const r = await run(bytes)
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toBe('before after')
  })

  it('handles an empty document and a document with only formatting', async () => {
    const r = await run(Buffer.from('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}}'))
    expect(r.pages).toBe(1)
  })
})
