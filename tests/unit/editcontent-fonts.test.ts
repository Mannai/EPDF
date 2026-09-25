import { FontNames } from '@pdf-lib/standard-fonts'
import { PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { cmapCid, cmapEntries, cmapUnicode, parseCMap, splitCodes, utf16beToString } from '../../src/renderer/src/features/textedit/pdfcontent/cmap'
import { ContentParseError, latin1ToBytes } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import { MAC_ROMAN, STANDARD, WIN_ANSI, baseEncoding, glyphNameForChar, glyphNameToUnicode, symbolEncoding } from '../../src/renderer/src/features/textedit/pdfcontent/encodings'
import { cssFontFamily, loadFont, standardFontFor, styleOf, stripSubset } from '../../src/renderer/src/features/textedit/pdfcontent/fonts'
import { imageSizeCases } from './helpers/imageSizeCases'
import { buildPdf, register, stream, subsetSimpleFont, toUnicodeCMap, type Lit } from './helpers/pdfBuilder'
import { detectPicture, pictureSize } from '../../src/renderer/src/features/textedit/pdfcontent/imageSize'

const cmap = (s: string) => parseCMap(latin1ToBytes(s))

describe('CMap reader', () => {
  it('reads codespace ranges, bfchar and bfrange (incrementing and array forms)', () => {
    const cm = cmap(`
      /CIDInit /ProcSet findresource begin 12 dict begin begincmap
      2 begincodespacerange <00> <7F> <8140> <FEFE> endcodespacerange
      2 beginbfchar <01> <0041> <02> <D83DDE00> endbfchar
      2 beginbfrange
      <10> <12> <0061>
      <20> <22> [<0058> <0059> <005A>]
      endbfrange endcmap end end`)
    expect(cm.codespace).toEqual([
      { n: 1, lo: 0, hi: 0x7f },
      { n: 2, lo: 0x8140, hi: 0xfefe }
    ])
    expect(cmapUnicode(cm, 1, 1)).toBe('A')
    expect(cmapUnicode(cm, 2, 1)).toBe('😀') // surrogate pair destination
    expect(cmapUnicode(cm, 0x10, 1)).toBe('a')
    expect(cmapUnicode(cm, 0x12, 1)).toBe('c')
    expect(cmapUnicode(cm, 0x20, 1)).toBe('X')
    expect(cmapUnicode(cm, 0x22, 1)).toBe('Z')
    expect(cmapUnicode(cm, 0x99, 1)).toBeUndefined()
    // the same numeric code with a different byte length is a different code
    expect(cmapUnicode(cm, 1, 2)).toBeUndefined()
  })

  it('maps multi-character destinations (ligatures) and 2-byte codes', () => {
    const cm = cmap(toUnicodeCMap([[0x0102, 'ffi'], [0x0103, 'fi']], 2))
    expect(cmapUnicode(cm, 0x0102, 2)).toBe('ffi')
    expect(cmapUnicode(cm, 0x0103, 2)).toBe('fi')
    expect(cmapEntries(cm).map((e) => `${e.code}:${e.text}`).sort()).toEqual(['258:ffi', '259:fi'])
  })

  it('keeps huge bfranges as ranges instead of expanding them', () => {
    const cm = cmap('1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange')
    expect(cm.bf.size).toBe(0)
    expect(cmapUnicode(cm, 0x0041, 2)).toBe('A')
    expect(cmapUnicode(cm, 0x4e2d, 2)).toBe('中')
  })

  it('reads cidrange/cidchar (embedded Encoding CMaps), usecmap and WMode', () => {
    const cm = cmap('/Adobe-Japan1-UCS2 usecmap /WMode 1 def 1 begincidchar <41> 100 endcidchar 1 begincidrange <8140> <817E> 633 endcidrange')
    expect(cm.useCMap).toBe('Adobe-Japan1-UCS2')
    expect(cm.wmode).toBe(1)
    expect(cmapCid(cm, 0x41, 1)).toBe(100)
    expect(cmapCid(cm, 0x8141, 2)).toBe(634)
    expect(cmapCid(cm, 0x8200, 2)).toBeUndefined()
  })

  it('rejects unreadable CMaps with a ContentParseError', () => {
    expect(() => cmap('1 beginbfchar <41 <0041> endbfchar')).toThrow(ContentParseError)
  })

  it('decodes UTF-16BE, including a single-byte destination', () => {
    expect(utf16beToString(Uint8Array.from([0, 0x41, 0x20, 0xac]))).toBe('A€')
    expect(utf16beToString(Uint8Array.from([0x41]))).toBe('A')
  })

  it('splits strings by code space: fixed 2-byte, mixed 1/2-byte, and no declared space', () => {
    expect(splitCodes(Uint8Array.from([0, 1, 0, 2]), [{ n: 2, lo: 0, hi: 0xffff }], 2)).toEqual([[1, 2], [2, 2]])
    const mixed = [
      { n: 1, lo: 0, hi: 0x7f },
      { n: 2, lo: 0x8140, hi: 0xfefe }
    ]
    expect(splitCodes(Uint8Array.from([0x41, 0x81, 0x40, 0x42]), mixed, 2)).toEqual([[0x41, 1], [0x8140, 2], [0x42, 1]])
    expect(splitCodes(Uint8Array.from([1, 2, 3]), [], 2)).toEqual([[0x0102, 2], [3, 1]])
    // a lone byte that fits no range is consumed so the loop always ends
    expect(splitCodes(Uint8Array.from([0xff, 0xff]), mixed, 2).length).toBeGreaterThan(0)
  })
})

describe('encodings and glyph names', () => {
  it('WinAnsi, MacRoman and Standard tables have the well known differences', () => {
    expect(WIN_ANSI[0x41]).toBe('A')
    expect(WIN_ANSI[0x80]).toBe('€')
    expect(WIN_ANSI[0x92]).toBe('’')
    expect(WIN_ANSI[0xe9]).toBe('é')
    expect(WIN_ANSI[0xa0]).toBe(' ')
    expect(WIN_ANSI[0xad]).toBe('-')
    expect(WIN_ANSI[0x81]).toBe('•') // undefined WinAnsi codes show as bullets
    expect(WIN_ANSI[5]).toBe('')
    expect(MAC_ROMAN[0x80]).toBe('Ä')
    expect(MAC_ROMAN[0x8e]).toBe('é')
    expect(MAC_ROMAN[0xd2]).toBe('“')
    expect(MAC_ROMAN[0xf0]).toBe('')
    expect(STANDARD[0x27]).toBe('’')
    expect(STANDARD[0x60]).toBe('‘')
    expect(STANDARD[0xae]).toBe('ﬁ')
    expect(STANDARD[0xe9]).toBe('Ø')
    expect(STANDARD[0xfb]).toBe('ß')
    expect(STANDARD[0x41]).toBe('A')
    expect(baseEncoding('WinAnsiEncoding')).toBe(WIN_ANSI)
    expect(baseEncoding('MacRomanEncoding')).toBe(MAC_ROMAN)
    expect(baseEncoding('StandardEncoding')).toBe(STANDARD)
    expect(baseEncoding('Nope')).toBeUndefined()
  })

  it('ASCII part is identical across encodings except quotes in Standard', () => {
    for (let c = 0x20; c < 0x7f; c++) {
      expect(WIN_ANSI[c]).toBe(String.fromCharCode(c))
      expect(MAC_ROMAN[c]).toBe(String.fromCharCode(c))
      if (c !== 0x27 && c !== 0x60) expect(STANDARD[c]).toBe(String.fromCharCode(c))
    }
  })

  it('glyph names map to Unicode (Adobe names, uniXXXX, uXXXXX, ligatures, suffixes)', () => {
    const cases: [string, string | undefined][] = [
      ['A', 'A'],
      ['space', ' '],
      ['eacute', 'é'],
      ['Euro', '€'],
      ['bullet', '•'],
      ['quoteright', '’'],
      ['endash', '–'],
      ['fi', 'ﬁ'],
      ['Lslash', 'Ł'],
      ['Amacron', 'Ā'],
      ['zcaron', 'ž'],
      ['Omega', 'Ω'],
      ['alpha', 'α'],
      ['uni20AC', '€'],
      ['uni00410042', 'AB'],
      ['u1F600', '😀'],
      ['f_i', 'fi'],
      ['a.sc', 'a'],
      ['one.oldstyle', '1'],
      ['g123', undefined],
      ['nonsense', undefined],
      ['', undefined]
    ]
    for (const [name, want] of cases) expect(glyphNameToUnicode(name), name).toBe(want)
  })

  it('finds the standard glyph name for a character', () => {
    expect(glyphNameForChar('A')).toBe('A')
    expect(glyphNameForChar('é')).toBe('eacute')
    expect(glyphNameForChar('’')).toBe('quoteright')
    expect(glyphNameForChar('€')).toBe('Euro')
    expect(glyphNameForChar('Ł')).toBe('Lslash')
  })

  it('Symbol and ZapfDingbats built-in encodings', () => {
    const sym = symbolEncoding('Symbol')
    expect(sym[0x61]).toBe('α')
    expect(sym[0x53]).toBe('Σ')
    const zapf = symbolEncoding('ZapfDingbats')
    expect(zapf[0x34]).toBe('✔')
  })
})

describe('font classification', () => {
  it('maps common names to the standard 14', () => {
    const cases: [string, FontNames | undefined][] = [
      ['Helvetica', FontNames.Helvetica],
      ['Helvetica-Bold', FontNames.HelveticaBold],
      ['Helvetica-BoldOblique', FontNames.HelveticaBoldOblique],
      ['Arial', FontNames.Helvetica],
      ['ArialMT', FontNames.Helvetica],
      ['Arial-BoldMT', FontNames.HelveticaBold],
      ['Arial,Italic', FontNames.HelveticaOblique],
      ['ABCDEF+Arial', FontNames.Helvetica],
      ['Times-Roman', FontNames.TimesRoman],
      ['TimesNewRomanPSMT', FontNames.TimesRoman],
      ['TimesNewRoman,Bold', FontNames.TimesRomanBold],
      ['Times-BoldItalic', FontNames.TimesRomanBoldItalic],
      ['Courier', FontNames.Courier],
      ['CourierNewPS-BoldMT', FontNames.CourierBold],
      ['Symbol', FontNames.Symbol],
      ['ZapfDingbats', FontNames.ZapfDingbats],
      ['Calibri', undefined],
      ['ArialNarrow', undefined],
      ['Helvetica-Light', undefined],
      ['Roboto-Regular', undefined]
    ]
    for (const [n, want] of cases) expect(standardFontFor(n), n).toBe(want)
  })

  it('reads bold/italic/serif/mono from names, weights, angles and descriptor flags', () => {
    expect(styleOf('Foo-Bold', 0, 0, undefined).bold).toBe(true)
    expect(styleOf('Foo', 0, 0, 700).bold).toBe(true)
    expect(styleOf('Foo', 0x40000, 0, undefined).bold).toBe(true)
    expect(styleOf('Foo', 0, -12, undefined).italic).toBe(true)
    expect(styleOf('Foo-Oblique', 0, 0, undefined).italic).toBe(true)
    expect(styleOf('Foo', 0x40, 0, undefined).italic).toBe(true)
    expect(styleOf('Foo', 1, 0, undefined).mono).toBe(true)
    expect(styleOf('Consolas', 0, 0, undefined).mono).toBe(true)
    expect(styleOf('Foo', 2, 0, undefined).serif).toBe(true)
    expect(styleOf('Georgia', 0, 0, undefined).serif).toBe(true)
    expect(styleOf('Arial', 0, 0, undefined)).toEqual({ bold: false, italic: false, serif: false, mono: false })
    expect(styleOf('SomeSansSerif', 2, 0, undefined).serif).toBe(false)
  })

  it('strips subset prefixes and builds CSS font stacks', () => {
    expect(stripSubset('ABCDEF+Calibri-Bold')).toBe('Calibri-Bold')
    expect(stripSubset('Calibri')).toBe('Calibri')
    const style = { bold: false, italic: false, serif: false, mono: false }
    expect(cssFontFamily({ displayName: 'Calibri', style })).toMatch(/^'Calibri', Arial/)
    expect(cssFontFamily({ displayName: 'TimesNewRomanPSMT', style: { ...style, serif: true } })).toMatch(/Times/)
    expect(cssFontFamily({ displayName: 'Unknown', style: { ...style, mono: true } })).toMatch(/monospace/)
    expect(cssFontFamily({ displayName: 'Weird', style })).toBe('Arial, Helvetica, sans-serif')
  })
})

describe('loading font dictionaries', () => {
  const fontOf = async (lit: Lit | ((doc: PDFDocument) => Lit)) => {
    const { doc } = await buildPdf([{ content: '', fonts: {} }])
    const l = typeof lit === 'function' ? lit(doc) : lit
    const ref = register(doc, l)
    return loadFont(doc.context.lookup(ref) as never)
  }
  const glyphText = (f: ReturnType<typeof loadFont>, s: string): string => f.glyphs(latin1ToBytes(s)).map((g) => g.text).join('')

  it('standard fonts without /Encoding use StandardEncoding; TrueType names use WinAnsi', async () => {
    const t1 = await fontOf({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })
    expect(glyphText(t1, "It's \xae")).toBe('It’s ﬁ') // StandardEncoding: quoteright and fi
    const tt = await fontOf({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Arial' })
    expect(glyphText(tt, "It's \xe9")).toBe("It's é")
  })

  it('takes widths for the standard 14 from the built-in metrics when /Widths is missing', async () => {
    const f = await fontOf({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })
    const g = f.glyphs(latin1ToBytes('Hi '))
    expect(g.map((x) => x.width)).toEqual([722, 222, 278])
    expect(g[2].space).toBe(true)
    expect(f.standard).toBe(FontNames.Helvetica)
    const courier = await fontOf({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier', Encoding: 'WinAnsiEncoding' })
    expect(courier.glyphs(latin1ToBytes('iW')).map((x) => x.width)).toEqual([600, 600])
  })

  it('/Widths win over the built-in metrics; MissingWidth applies outside the range', async () => {
    const f = await fontOf({
      Type: 'Font',
      Subtype: 'TrueType',
      BaseFont: 'Verdana',
      Encoding: 'WinAnsiEncoding',
      FirstChar: 65,
      LastChar: 66,
      Widths: [700, 800],
      FontDescriptor: { Type: 'FontDescriptor', FontName: 'Verdana', Flags: 32, MissingWidth: 123, Ascent: 900, Descent: -200 }
    })
    expect(f.glyphs(latin1ToBytes('ABC')).map((g) => g.width)).toEqual([700, 800, 123])
    expect(f.ascent).toBeCloseTo(0.9)
    expect(f.descent).toBeCloseTo(-0.2)
  })

  it('/Differences override the base encoding, ToUnicode overrides both', async () => {
    const f = await fontOf((doc) => ({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Foo',
      FirstChar: 1,
      LastChar: 4,
      Widths: [500, 500, 500, 500],
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [1, PDFName.of('Euro'), PDFName.of('uni20AC'), PDFName.of('fi'), 4, PDFName.of('g99')] },
      ToUnicode: stream(doc, toUnicodeCMap([[3, 'Z']]))
    }))
    const g = f.glyphs(Uint8Array.from([1, 2, 3, 4, 0x41]))
    expect(g.map((x) => x.text)).toEqual(['€', '€', 'Z', '�', 'A'])
    expect(g.map((x) => x.known)).toEqual([true, true, true, false, true])
  })

  it('subset simple fonts only offer characters already used (except space) and prefer used codes', async () => {
    const { doc } = await buildPdf([{ content: '', fonts: {} }])
    const ref = subsetSimpleFont(doc, { codes: { 0x41: 'A', 0x42: 'B', 0x20: ' ' } })
    const f = loadFont(doc.context.lookup(ref) as never)
    expect(f.isSubset).toBe(true)
    expect(f.encode('A', new Set())).toBeNull() // known code but unused: might not exist in the font program
    expect(f.encode('A', new Set([0x41]))).toEqual([0x41])
    expect(f.encode(' ', new Set())).toEqual([0x20]) // spaces draw nothing, so they are always fine
    expect(f.encode('Z', new Set())).toBeNull() // in the encoding but never used and the font is a subset
    expect(f.encode('世', new Set([0x41]))).toBeNull() // not in the encoding at all
  })

  it('non-embedded, non-subset fonts can encode anything the encoding and widths cover', async () => {
    const f = await fontOf({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })
    expect(f.encode('é', new Set())).toEqual([0xe9])
    expect(f.encode('€', new Set())).toEqual([0x80])
    expect(f.encode('世', new Set())).toBeNull()
  })

  it('Type0 with an embedded Encoding CMap: mixed code lengths and CID widths', async () => {
    const f = await fontOf((doc) => {
      const enc = stream(
        doc,
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 2 begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange 1 begincidrange <41> <5A> 10 endcidrange 1 begincidrange <8001> <8003> 200 endcidrange endcmap'
      )
      const toUni = stream(doc, toUnicodeCMap([[0x41, 'A'], [0x42, 'B']]).replace('<00> <FF>', '<00> <7F>') )
      const desc = register(doc, { Type: 'FontDescriptor', FontName: 'ABCDEF+X', Flags: 4, Ascent: 800, Descent: -200 })
      const cid = register(doc, { Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'ABCDEF+X', FontDescriptor: desc, DW: 700, W: [10, [300, 400], 200, 202, 900] })
      return { Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+X', Encoding: enc, DescendantFonts: [cid], ToUnicode: toUni }
    })
    const g = f.glyphs(Uint8Array.from([0x41, 0x42, 0x80, 0x01]))
    expect(g.map((x) => [x.code, x.n, x.width])).toEqual([[0x41, 1, 300], [0x42, 1, 400], [0x8001, 2, 900]])
    expect(g.map((x) => x.text)).toEqual(['A', 'B', '�'])
    expect(f.editable).toBe(true)
  })

  it('refuses vertical writing, predefined CJK CMaps, and Type0 without ToUnicode', async () => {
    const t0 = (enc: string, toUni: boolean) => (doc: PDFDocument): Lit => {
      const cid = register(doc, { Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'MS-Mincho', FontDescriptor: register(doc, { Type: 'FontDescriptor', FontName: 'MS-Mincho', Flags: 4 }) })
      return { Type: 'Font', Subtype: 'Type0', BaseFont: 'MS-Mincho', Encoding: enc, DescendantFonts: [cid], ...(toUni ? { ToUnicode: stream(doc, toUnicodeCMap([[0x41, 'A']], 2)) } : {}) }
    }
    const v = await fontOf(t0('Identity-V', true))
    expect(v.editable).toBe(false)
    expect(v.reason).toMatch(/vertical/)
    const cjk = await fontOf(t0('90ms-RKSJ-H', true))
    expect(cjk.editable).toBe(false)
    expect(cjk.reason).toMatch(/predefined character set/)
    const none = await fontOf(t0('Identity-H', false))
    expect(none.editable).toBe(false)
    expect(none.reason).toMatch(/ToUnicode/)
  })

  it('never throws for damaged font dictionaries', async () => {
    const f = await fontOf({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Broken', Encoding: 'Identity-H', DescendantFonts: [] })
    expect(f.editable).toBe(false)
    expect(f.glyphs(Uint8Array.from([0, 65])).length).toBeGreaterThan(0)
    const g = await fontOf({ Type: 'Font' })
    expect(g.baseFont).toBe('Unknown')
  })
})

describe('picture headers', () => {
  it('detects PNG and JPEG and reads their size without decoding', () => {
    for (const c of imageSizeCases()) {
      expect(detectPicture(c.bytes), c.name).toBe(c.kind)
      expect(pictureSize(c.bytes), c.name).toEqual(c.size)
    }
  })
  it('rejects everything else', () => {
    expect(detectPicture(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull()
    expect(detectPicture(new Uint8Array())).toBeNull()
    expect(pictureSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
    expect(pictureSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBeNull()
  })
})
