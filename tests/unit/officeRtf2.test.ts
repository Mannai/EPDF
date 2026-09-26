import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { makePng, solid } from '../support/images'
import { flattenText, readPdf } from '../support/pdfText'

const fontsDir = resolve('resources/fonts')
const run = (s: string | Buffer, name = 'test.rtf') => convertOffice({ name, bytes: typeof s === 'string' ? Buffer.from(s, 'latin1') : s }, { fontsDir })

describe('RTF: documents as real programs write them', () => {
  it('reads a WordPad-style document', async () => {
    const r = await run(
      '{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}\r\n' +
        '{\\*\\generator Riched20 10.0.19041}\\viewkind4\\uc1 \r\n' +
        '\\pard\\sa200\\sl276\\slmult1\\f0\\fs22\\lang9 Hello from WordPad, \\b bold\\b0  and \\i italic\\i0 .\\par\r\n' +
        'Second paragraph.\\par\r\n}\r\n'
    )
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].text).toBe('Hello from WordPad, bold and italic.\nSecond paragraph.')
    expect(pages[0].items.find((i) => i.str.includes('Hello'))!.font).toMatch(/Carlito/) // Calibri -> Carlito
    expect(r.warnings).toEqual([])
  })

  it('reads a Word-style document with stylesheet, list table, theme data and a table', async () => {
    const rtf =
      '{\\rtf1\\adeflang1025\\ansi\\ansicpg1252\\uc1\\adeff31507\\deff0\\stshfdbch0\\stshfloch31506\\stshfhich31506\\stshfbi31507\\deflang1033\\deflangfe1033\\themelang1033\\themelangfe0\\themelangcs0' +
      '{\\fonttbl{\\f0\\fbidi \\froman\\fcharset0\\fprq2{\\*\\panose 02020603050405020304}Times New Roman;}{\\f1\\fbidi \\fswiss\\fcharset0\\fprq2{\\*\\panose 020b0604020202020204}Arial;}{\\f34\\fbidi \\fswiss\\fcharset0\\fprq2{\\*\\panose 020f0502020204030204}Calibri;}{\\f37\\fbidi \\fswiss\\fcharset0\\fprq2 Segoe UI;}}' +
      '{\\colortbl;\\red0\\green0\\blue0;\\red0\\green0\\blue255;\\red0\\green255\\blue255;\\red0\\green255\\blue0;\\red255\\green0\\blue255;\\red255\\green0\\blue0;\\red255\\green255\\blue0;\\red255\\green255\\blue255;\\red0\\green0\\blue128;}' +
      '{\\*\\defchp \\fs22 }{\\*\\defpap \\ql \\li0\\ri0\\sa160\\sl259\\slmult1\\widctlpar\\wrapdefault\\aspalpha\\aspnum\\faauto\\adjustright\\rin0\\lin0\\itap0 }' +
      '\\noqfpromote {\\stylesheet{\\ql \\li0\\ri0\\sa160\\sl259\\slmult1\\widctlpar\\wrapdefault\\aspalpha\\aspnum\\faauto\\adjustright\\rin0\\lin0\\itap0 \\rtlch\\fcs1 \\af31507\\afs22\\alang1025 \\ltrch\\fcs0 \\f31506\\fs22\\lang1033\\langfe1033\\cgrid\\langnp1033\\langfenp1033 \\snext0 \\sqformat \\spriority0 Normal;}' +
      '{\\s1\\ql \\li0\\ri0\\sb240\\sa0\\sl259\\slmult1\\keepn\\widctlpar\\outlinelevel0\\adjustright\\rin0\\lin0\\itap0 \\rtlch\\fcs1 \\af31503\\afs32 \\ltrch\\fcs0 \\f31502\\fs32\\cf9 \\sbasedon0 \\snext0 \\slink15 \\sqformat \\spriority9 heading 1;}' +
      '{\\*\\cs10 \\additive \\ssemihidden \\sunhideused \\spriority1 Default Paragraph Font;}' +
      '{\\*\\cs15 \\additive \\rtlch\\fcs1 \\af31503\\afs32 \\ltrch\\fcs0 \\f31502\\fs32\\cf9 \\sbasedon10 \\slink1 \\spriority9 Heading 1 Char;}}' +
      '{\\*\\rsidtbl \\rsid1234567\\rsid7654321}{\\mmathPr\\mmathFont34\\mbrkBin0\\mbrkBinSub0\\msmallFrac0\\mdispDef1\\mlMargin0\\mrMargin0\\mdefJc1\\mwrapIndent1440\\mintLim0\\mnaryLim1}' +
      '{\\info{\\title Test}{\\author Someone}{\\operator Someone}{\\creatim\\yr2024\\mo5\\dy1\\hr10\\min0}{\\version1}{\\edmins0}{\\nofpages1}{\\nofwords5}}' +
      '\\paperw11906\\paperh16838\\margl1417\\margr1417\\margt1417\\margb1417\\gutter0\\ltrsect \\deftab720\\widowctrl\\ftnbj\\aenddoc\\trackmoves0\\trackformatting1\\donotembedsysfont1\\relyonvml0\\donotembedlingdata0\\grfdocevents0\\validatexml1\\showplaceholdtext0\\ignoremixedcontent0\\saveinvalidxml0\\showxmlerrors1\\horzdoc\\dghspace120\\dgvspace120\\dghorigin1701\\dgvorigin1984\\dghshow0\\dgvshow3\\jcompress\\viewkind1\\viewscale100\\rsidroot1234567 \\nouicompat \\fet0{\\*\\wgrffmtfilter 2450}\\nofeaturethrottle1\\ilfomacatclnup0' +
      '{\\*\\latentstyles\\lsdstimax376\\lsdlockeddef0{\\lsdlockedexcept \\lsdqformat1 \\lsdpriority9 heading 1;}}' +
      '{\\*\\themedata 504b0304140006000800000021000dd1909fb60000001b010000130000005b436f6e74656e745f54797065735d2e786d6c}' +
      '{\\*\\colorschememapping 3c3f786d6c2076657273696f6e3d22312e302220656e636f64696e673d225554462d38223f3e}' +
      '\\sectd \\ltrsect\\linex0\\endnhere\\sectlinegrid360\\sectdefaultcl\\sftnbj {\\*\\pnseclvl1\\pnucrm\\pnstart1\\pnindent720\\pnhang {\\pntxta .}}{\\*\\pnseclvl2\\pnucltr\\pnstart1\\pnindent720\\pnhang {\\pntxta .}}' +
      '\\pard\\plain \\ltrpar\\s1\\ql \\li0\\ri0\\sb240\\sl259\\slmult1\\keepn\\widctlpar\\wrapdefault\\faauto\\outlinelevel0\\rin0\\lin0\\itap0\\pararsid1234567 \\rtlch\\fcs1 \\af31503\\afs32\\alang1025 \\ltrch\\fcs0 \\f31502\\fs32\\cf9\\lang1033\\langfe1033\\cgrid\\langnp1033\\langfenp1033 {\\rtlch\\fcs1 \\af31503 \\ltrch\\fcs0 \\insrsid1234567 Quarterly report\\par}' +
      '\\pard\\plain \\ltrpar\\ql \\li0\\ri0\\sa160\\sl259\\slmult1\\widctlpar\\wrapdefault\\aspalpha\\aspnum\\faauto\\adjustright\\rin0\\lin0\\itap0\\pararsid1234567 \\rtlch\\fcs1 \\af31507\\afs22\\alang1025 \\ltrch\\fcs0 \\f31506\\fs22\\lang1033\\langfe1033\\cgrid\\langnp1033\\langfenp1033 {\\rtlch\\fcs1 \\af31507 \\ltrch\\fcs0 \\insrsid1234567 Revenue grew by 12% compared with last year.\\par}' +
      '\\trowd \\irow0\\irowband0\\ltrrow\\ts11\\trgaph108\\trleft-108\\trbrdrt\\brdrs\\brdrw10 \\trbrdrl\\brdrs\\brdrw10 \\trbrdrb\\brdrs\\brdrw10 \\trbrdrr\\brdrs\\brdrw10 \\trbrdrh\\brdrs\\brdrw10 \\trbrdrv\\brdrs\\brdrw10 \\trftsWidth1\\trautofit1\\trpaddl108\\trpaddr108\\trpaddfl3\\trpaddfr3 \\clvertalt\\clbrdrt\\brdrs\\brdrw10 \\clbrdrl\\brdrs\\brdrw10 \\clbrdrb\\brdrs\\brdrw10 \\clbrdrr\\brdrs\\brdrw10 \\cltxlrtb\\clftsWidth3\\clwWidth4680\\clshdrawnil \\cellx4572\\clvertalt\\clbrdrt\\brdrs\\brdrw10 \\clbrdrl\\brdrs\\brdrw10 \\clbrdrb\\brdrs\\brdrw10 \\clbrdrr\\brdrs\\brdrw10 \\cltxlrtb\\clftsWidth3\\clwWidth4680\\clshdrawnil \\cellx9144' +
      '\\pard\\plain \\ltrpar\\ql \\li0\\ri0\\widctlpar\\intbl\\wrapdefault\\aspalpha\\aspnum\\faauto\\adjustright\\rin0\\lin0\\yts11 \\rtlch\\fcs1 \\af31507\\afs22\\alang1025 \\ltrch\\fcs0 \\f31506\\fs22\\lang1033\\langfe1033\\cgrid\\langnp1033\\langfenp1033 {\\rtlch\\fcs1 \\af31507 \\ltrch\\fcs0 \\insrsid1234567 Region\\cell }' +
      '\\pard\\plain \\ltrpar\\ql \\li0\\ri0\\widctlpar\\intbl\\wrapdefault\\aspalpha\\aspnum\\faauto\\adjustright\\rin0\\lin0\\yts11 \\rtlch\\fcs1 \\af31507\\afs22\\alang1025 \\ltrch\\fcs0 \\f31506\\fs22\\lang1033\\langfe1033\\cgrid\\langnp1033\\langfenp1033 {\\rtlch\\fcs1 \\af31507 \\ltrch\\fcs0 \\insrsid1234567 Sales\\cell }' +
      '\\pard\\plain \\ltrpar\\ql \\li0\\ri0\\sa160\\sl259\\slmult1\\widctlpar\\intbl\\wrapdefault\\aspalpha\\aspnum\\faauto\\adjustright\\rin0\\lin0\\yts11 {\\rtlch\\fcs1 \\af31507 \\ltrch\\fcs0 \\insrsid1234567 \\trowd \\irow0\\irowband0\\ltrrow\\ts11\\trgaph108\\trleft-108\\trbrdrt\\brdrs\\brdrw10 \\clvertalt\\cellx4572\\clvertalt\\cellx9144 \\row }' +
      '\\pard\\plain \\ltrpar\\ql \\li0\\ri0\\sa160\\sl259\\slmult1\\widctlpar\\wrapdefault\\aspalpha\\aspnum\\faauto\\adjustright\\rin0\\lin0\\itap0 \\rtlch\\fcs1 \\af31507\\afs22\\alang1025 \\ltrch\\fcs0 \\f31506\\fs22\\lang1033\\langfe1033\\cgrid\\langnp1033\\langfenp1033 {\\rtlch\\fcs1 \\af31507 \\ltrch\\fcs0 \\insrsid1234567 End of report.\\par}}'
    const r = await run(rtf)
    const { pages } = await readPdf(r.bytes)
    expect(pages).toHaveLength(1)
    expect(pages[0].width).toBeCloseTo(595.3, 0) // \paperw11906
    const flat = flattenText(pages)
    expect(flat).toContain('Quarterly report')
    expect(flat).toContain('Revenue grew by 12% compared with last year.')
    expect(flat).toContain('Region Sales')
    expect(flat).toContain('End of report.')
    expect(flat.indexOf('Region')).toBeLessThan(flat.indexOf('End of report.'))
    const head = pages[0].items.find((i) => i.str.includes('Quarterly'))!
    expect(head.size).toBeCloseTo(16, 0) // \s1 -> \fs32 from the stylesheet
    expect(flat).not.toMatch(/504b|Riched|rsid|Test|Someone/)
  })
})

describe('RTF: more constructs', () => {
  const HEAD = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Arial;}}\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440'

  it('uses left/right headers on facing pages', async () => {
    const body = Array.from({ length: 200 }, (_, i) => `\\pard Body ${i + 1}\\par`).join('')
    const r = await run(`${HEAD}\\facingp\\sectd{\\headerl\\pard EVEN header\\par}{\\headerr\\pard ODD header\\par}{\\footerl\\pard EVEN footer\\par}{\\footerr\\pard ODD footer\\par}${body}}`)
    const { pages } = await readPdf(r.bytes)
    expect(pages.length).toBeGreaterThan(3)
    pages.forEach((pg, i) => {
      const even = (i + 1) % 2 === 0
      expect(pg.text.startsWith(even ? 'EVEN header' : 'ODD header')).toBe(true)
      expect(pg.text.endsWith(even ? 'EVEN footer' : 'ODD footer')).toBe(true)
    })
  })

  it('keeps continuous sections on the same page and starts real ones on a new page', async () => {
    const r = await run(`${HEAD}\\sectd One\\par\\sect\\sectd\\sbknone Two continues on the same page\\par\\sect\\sectd\\sbkpage Three\\par}`)
    const { pages } = await readPdf(r.bytes)
    expect(pages).toHaveLength(2)
    expect(pages[0].text).toBe('One\nTwo continues on the same page')
    expect(pages[1].text).toBe('Three')
  })

  it('embeds a binary (\\bin) PNG picture', async () => {
    const png = Buffer.from(makePng(8, 8, solid(0, 200, 0)))
    const head = Buffer.from(`${HEAD}\\pard Picture: {\\pict\\pngblip\\picwgoal1440\\pichgoal1440\\bin${png.length} `, 'latin1')
    const tail = Buffer.from('} done\\par}', 'latin1')
    const r = await run(Buffer.concat([head, png, tail]))
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].imageCount).toBe(1)
    expect(flattenText(pages)).toBe('Picture: done')
  })

  it('decodes Mac Roman and honours \\uc0', async () => {
    const r = await run('{\\rtf1\\mac\\deff0{\\fonttbl{\\f0\\fswiss Arial;}}\\pard caf\\\'8e \\uc0\\u8364 x\\par}')
    const flat = flattenText((await readPdf(r.bytes)).pages)
    expect(flat).toBe('café €x')
  })

  it('keeps double-byte (Shift-JIS) text as characters and draws them with the bundled CJK font', async () => {
    const r = await run('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fnil\\fcharset128 MS Mincho;}}\\pard\\f0 A\\\'93\\\'fa\\\'96\\\'7b\\\'8c\\\'ea B\\par}')
    const { pages } = await readPdf(r.bytes)
    // (before the text engine, CJK had no bundled font and became "???" with a warning)
    expect(pages[0].text.replace(/\s+/g, ' ')).toBe('A日本語 B')
    expect(r.warnings.join(' ')).not.toMatch(/not available in Epdf’s built-in fonts/)
  })

  it('flattens nested tables into their cell with a warning', async () => {
    const r = await run(
      `${HEAD}\\trowd\\trgaph108\\cellx5000\\cellx9000\\pard\\intbl Outer left\\cell \\pard\\intbl\\itap2 inner a\\nestcell inner b\\nestcell{\\*\\nesttableprops\\trowd\\cellx1000\\nestrow}\\pard\\intbl\\itap1 outer right\\cell\\row\\pard after\\par}`
    )
    const flat = flattenText((await readPdf(r.bytes)).pages)
    for (const w of ['Outer left', 'inner a', 'inner b', 'outer right', 'after']) expect(flat).toContain(w)
    expect(r.warnings.join(' ')).toMatch(/Nested tables/)
  })

  it('handles right-to-left paragraphs and \\page inside paragraphs', async () => {
    const r = await run(`${HEAD}\\pard\\rtlpar\\qr right to left para\\par\\pard first\\page second\\par}`)
    const { pages } = await readPdf(r.bytes)
    expect(pages).toHaveLength(2)
    expect(pages[0].text).toContain('first')
    expect(pages[1].text).toContain('second')
    const rtl = pages[0].items.find((i) => i.str.includes('right to left'))!
    expect(rtl.x + rtl.w).toBeCloseTo(540, 0)
  })

  it('keeps text of very large documents (tokenizer stays linear)', async () => {
    const paras = Array.from({ length: 4000 }, (_, i) => `\\pard\\plain\\f0\\fs20 Line ${i + 1} of a large RTF file with several words.\\par`)
    const t0 = Date.now()
    const r = await run(`${HEAD}${paras.join('\n')}}`)
    expect(Date.now() - t0).toBeLessThan(60000)
    const { pages } = await readPdf(r.bytes)
    const flat = flattenText(pages)
    expect(flat.startsWith('Line 1 of a large')).toBe(true)
    expect(flat.endsWith('Line 4000 of a large RTF file with several words.')).toBe(true)
    expect((flat.match(/Line \d+ of a large/g) ?? []).length).toBe(4000)
  }, 120000)
})
