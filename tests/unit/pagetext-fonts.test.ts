import { readFileSync } from 'node:fs'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString, type PDFPage } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildPageText, modelIsUsable, type PageTextModel } from '../../src/shared/pagetext'
import { unicodeForGlyphName } from '../../src/shared/pagetext/glyphnames'
import { readSfnt } from '../../src/shared/pagetext/sfnt'
import { decodePdfString, normalizeGlyphText } from '../../src/shared/pagetext/unicode'
import { linesOf } from './helpers/pagetext'

/**
 * Decoding paths of the page text model on hand-built PDFs: glyph names without /ToUnicode, Type 3 fonts, Unicode
 * CMaps, unsupported CMaps (refused, not guessed), vertical writing, /ActualText (nested, via /Properties, across a
 * form), combining marks attached by geometry, invisible text, duplicated glyphs.
 */

const N = PDFName.of

function makeDoc(): { pdf: Promise<PDFDocument> } {
  return { pdf: PDFDocument.create() }
}

/** Adds a font dictionary (raw entries) to a page under `name` and returns its dict. */
function addFont(pdf: PDFDocument, page: PDFPage, name: string, entries: Record<string, unknown>): PDFDict {
  const d = pdf.context.obj(entries as never) as unknown as PDFDict
  const ref = pdf.context.register(d)
  page.node.setFontDictionary(N(name), ref)
  return d
}

function setContent(pdf: PDFDocument, page: PDFPage, content: string): void {
  const s = PDFRawStream.of(pdf.context.obj({}) as PDFDict, new TextEncoder().encode(content))
  page.node.set(N('Contents'), pdf.context.register(s))
}

function stream(pdf: PDFDocument, dict: Record<string, unknown>, content: string | Uint8Array): PDFRef {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return pdf.context.register(PDFRawStream.of(pdf.context.obj(dict as never) as unknown as PDFDict, bytes))
}

const model = async (pdf: PDFDocument, opts = {}): Promise<PageTextModel> => buildPageText(await PDFDocument.load(await pdf.save()), 0, opts)

describe('glyph names and text strings', () => {
  it('AGL, afii, uniXXXX, uXXXXX, OpenType-style Arabic and Hebrew names, ligatures and suffixes', () => {
    expect(unicodeForGlyphName('A')).toBe('A')
    expect(unicodeForGlyphName('eacute')).toBe('é')
    expect(unicodeForGlyphName('uni0628')).toBe('ب')
    expect(unicodeForGlyphName('uniFEE3')).toBe('ﻣ')
    expect(unicodeForGlyphName('u1F600')).toBe('😀')
    expect(unicodeForGlyphName('afii57415')).toBe('ا')
    expect(unicodeForGlyphName('afii57664')).toBe('א')
    expect(unicodeForGlyphName('afii57690')).toBe('ת')
    expect(unicodeForGlyphName('alefarabic')).toBe('ا')
    expect(unicodeForGlyphName('beh-ar.init')).toBe('ب')
    expect(unicodeForGlyphName('behinitialarabic')).toBe('ب')
    expect(unicodeForGlyphName('lamfinalarabic')).toBe('ل')
    expect(unicodeForGlyphName('lam_alef-ar')).toBe('لا')
    expect(unicodeForGlyphName('lam_alef-ar.fina')).toBe('لا')
    expect(unicodeForGlyphName('shinhebrew')).toBe('ש')
    expect(unicodeForGlyphName('f_i')).toBe('fi')
    expect(unicodeForGlyphName('a.sc')).toBe('a')
    expect(unicodeForGlyphName('.notdef')).toBeUndefined()
    expect(unicodeForGlyphName('glyph123')).toBeUndefined()
    expect(unicodeForGlyphName('dollar')).toBe('$') // not mistaken for a script suffix
  })
  it('presentation forms and ligatures become base letters; control characters mean "no mapping"', () => {
    expect(normalizeGlyphText('ﻣﺮﺣﺒﺎ')).toBe('مرحبا')
    expect(normalizeGlyphText('ﻻ')).toBe('لا')
    expect(normalizeGlyphText('ﷲ')).toBe('الله')
    expect(normalizeGlyphText('ﬁ')).toBe('fi')
    expect(normalizeGlyphText('\u0000')).toBe('')
    expect(normalizeGlyphText('²')).toBe('²') // no general NFKC: superscripts stay
  })
  it('PDF text strings: UTF-16BE (with language escapes), UTF-8, PDFDocEncoding', () => {
    expect(decodePdfString(Uint8Array.from([0xfe, 0xff, 0x06, 0x45, 0x06, 0x31]))).toBe('مر')
    expect(decodePdfString(Uint8Array.from([0xfe, 0xff, 0x00, 0x1b, 0x00, 0x61, 0x00, 0x72, 0x00, 0x1b, 0x06, 0x45]))).toBe('م')
    expect(decodePdfString(Uint8Array.from([0xef, 0xbb, 0xbf, 0xd9, 0x85]))).toBe('م')
    expect(decodePdfString(Uint8Array.from([0x41, 0x84, 0x93]))).toBe('A—ﬁ')
  })
})

describe('font program fallback (sfnt reader)', () => {
  it('reads cmap, post names and glyph boxes of the bundled fonts', () => {
    const s = readSfnt(new Uint8Array(readFileSync('resources/textfonts/NotoNaskhArabic-Regular.ttf')))!
    const beh = s.lookup(3, 1, 0x0628)!
    expect(beh).toBeGreaterThan(0)
    expect(s.unicodeOf(beh)).toBe('ب')
    // meem initial is one glyph for U+0645 in initial position and U+FEE3: its name maps back to meem either way
    expect(normalizeGlyphText(unicodeForGlyphName(s.nameOf(s.lookup(3, 1, 0xfee3)!)!)!)).toBe('م')
    const fatha = s.lookup(3, 1, 0x064e)!
    const bb = s.bbox(fatha)!
    expect(bb[2]).toBeGreaterThan(bb[0])
    expect(readSfnt(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })
})

describe('simple fonts without /ToUnicode', () => {
  it('/Differences with Arabic glyph names (legacy producer), glyphs in visual order', async () => {
    const pdf = await makeDoc().pdf
    const page = pdf.addPage([300, 200])
    // codes 65.. = alef-final, lam-medial? keep it simple: visual "ﺎﺒﺣﺮﻣ" (مرحبا reversed) with afii/uni names
    addFont(pdf, page, 'F1', {
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'LegacyArabic',
      FirstChar: 65,
      LastChar: 69,
      Widths: [300, 400, 500, 350, 450],
      Encoding: { Type: 'Encoding', Differences: [65, 'afii57415', 'uniFE92', 'hahmedialarabic', 'reh-ar.fina', 'uniFEE3'] }
    })
    setContent(pdf, page, 'BT /F1 20 Tf 50 100 Td (ABCDE) Tj ET')
    const m = await model(pdf)
    expect(m.text).toBe('مرحبا')
    expect(m.lines[0].dir).toBe('rtl')
  })
  it('Type 3 font: widths through the FontMatrix, text from /Differences', async () => {
    const pdf = await makeDoc().pdf
    const page = pdf.addPage([300, 200])
    const proc = stream(pdf, {}, '0 0 m 500 0 l 500 700 l f')
    addFont(pdf, page, 'T3', {
      Type: 'Font',
      Subtype: 'Type3',
      FontBBox: [0, 0, 1000, 800],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { H: proc, i: proc },
      Encoding: { Type: 'Encoding', Differences: [1, 'H', 'i'] },
      FirstChar: 1,
      LastChar: 2,
      Widths: [600, 300],
      Resources: {}
    })
    setContent(pdf, page, 'BT /T3 10 Tf 50 100 Td <0102> Tj ( ) Tj <0102> Tj ET')
    const m = await model(pdf)
    expect(m.text).toBe('Hi Hi')
    // H is 600 units x 0.001 x 10pt = 6pt wide
    const q = m.quads
    expect(q[2] - q[0]).toBeCloseTo(6, 3)
  })
})

describe('CID fonts', () => {
  const cidFont = (pdf: PDFDocument, encoding: string, toUnicode?: PDFRef): Record<string, unknown> => ({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: 'Test-CID',
    Encoding: encoding,
    ...(toUnicode ? { ToUnicode: toUnicode } : {}),
    DescendantFonts: [pdf.context.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Test-CID', CIDSystemInfo: { Registry: 'Adobe', Ordering: 'Identity', Supplement: 0 }, DW: 1000 })]
  })
  it('a Unicode CMap (UniGB-UCS2-H) without /ToUnicode: the codes are the text', async () => {
    const pdf = await makeDoc().pdf
    const page = pdf.addPage([300, 200])
    addFont(pdf, page, 'C1', cidFont(pdf, 'UniGB-UCS2-H'))
    setContent(pdf, page, 'BT /C1 12 Tf 20 100 Td <4F60597D4E16754C> Tj ET')
    expect((await model(pdf)).text).toBe('你好世界')
  })
  it('a predefined non-Unicode CMap without /ToUnicode is reported as unreliable (the page keeps PDF.js text)', async () => {
    const pdf = await makeDoc().pdf
    const page = pdf.addPage([300, 200])
    addFont(pdf, page, 'C1', cidFont(pdf, '90ms-RKSJ-H'))
    setContent(pdf, page, 'BT /C1 12 Tf 20 100 Td <82A082A2> Tj ET')
    const m = await model(pdf)
    expect(m.stats.unreliable).toBeGreaterThan(0)
    expect(modelIsUsable(m, 'あい')).toBe(false)
  })
  it('vertical writing (Identity-V): glyphs advance downwards and form one line', async () => {
    const pdf = await makeDoc().pdf
    const page = pdf.addPage([300, 300])
    const tu = stream(pdf, {}, '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <65E5> <0002> <672C> <0003> <8A9E> endbfchar endcmap end end')
    addFont(pdf, page, 'V1', cidFont(pdf, 'Identity-V', tu))
    setContent(pdf, page, 'BT /V1 20 Tf 1 0 0 1 150 250 Tm <000100020003> Tj ET')
    const m = await model(pdf)
    expect(m.text).toBe('日本語')
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0].angle).toBe(90) // reading downwards on the displayed page
  })
})

describe('/ActualText', () => {
  const toUni = (pdf: PDFDocument, pairs: [number, string][]): PDFRef => {
    const hex = (s: string): string => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')
    const body = pairs.map(([c, t]) => `<${c.toString(16).padStart(2, '0')}> <${hex(t)}>`).join(' ')
    return stream(pdf, {}, `/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange ${pairs.length} beginbfchar ${body} endbfchar endcmap end end`)
  }
  const simple = (pdf: PDFDocument, page: PDFPage, pairs: [number, string][]): void => {
    addFont(pdf, page, 'F1', { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', FirstChar: 1, LastChar: 9, Widths: [500, 500, 500, 500, 500, 500, 500, 500, 500], ToUnicode: toUni(pdf, pairs) })
  }
  it('replaces the glyph text; the outermost of nested spans wins; /Properties resources are read', async () => {
    const pdf = await makeDoc().pdf
    const page = pdf.addPage([300, 200])
    simple(pdf, page, [[1, 'x'], [2, 'y'], [3, 'z']])
    const props = pdf.context.obj({}) as PDFDict
    props.set(N('ActualText'), PDFString.of('from properties'))
    page.node.set(N('Resources'), pdf.context.obj({ Font: page.node.Resources()!.get(N('Font')), Properties: { P1: props } } as never))
    // "outer" wraps "inner"; the second span comes from the /Properties resource
    setContent(pdf, page, 'BT /F1 10 Tf 20 100 Td /Span <</ActualText (outer)>> BDC <01> Tj /Span <</ActualText (inner)>> BDC <02> Tj EMC EMC ( ) Tj /Span /P1 BDC <03> Tj EMC ET')
    const m = await model(pdf)
    expect(m.text).toBe('outer from properties')
  })
  it('a span around a form XObject covers the text drawn by the form', async () => {
    const pdf = await makeDoc().pdf
    const page = pdf.addPage([300, 200])
    simple(pdf, page, [[1, 'a'], [2, 'b']])
    const fonts = page.node.Resources()!.get(N('Font'))
    const form = stream(pdf, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 200], Resources: { Font: fonts } }, 'BT /F1 10 Tf 20 100 Td <0102> Tj ET')
    page.node.set(N('Resources'), pdf.context.obj({ Font: fonts, XObject: { Fm1: form } } as never))
    setContent(pdf, page, '/Span <</ActualText <FEFF0645063106460627>>> BDC /Fm1 Do EMC')
    expect((await model(pdf)).text).toBe('مرنا')
  })
})

describe('marks, spaces, invisible and duplicated text', () => {
  const arabicFont = async (pdf: PDFDocument, page: PDFPage): Promise<void> => {
    const hex = (s: string): string => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')
    const pairs: [number, string][] = [[1, 'ب'], [2, 'َ'], [3, 'ك'], [4, 'ت'], [5, 'ِ']]
    const tu = stream(pdf, {}, `/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange ${pairs.length} beginbfchar ${pairs.map(([c, t]) => `<0${c}> <${hex(t)}>`).join(' ')} endbfchar endcmap end end`)
    addFont(pdf, page, 'A1', { Type: 'Font', Subtype: 'TrueType', BaseFont: 'Arabic', FirstChar: 1, LastChar: 5, Widths: [500, 0, 600, 400, 0], ToUnicode: tu })
  }
  it('combining marks attach to the base they sit on, whatever the stream order (fatha drawn first, kasra last)', async () => {
    const pdf = await makeDoc().pdf
    const page = pdf.addPage([300, 200])
    await arabicFont(pdf, page)
    // visual (left to right): ت ك ب = logical "بكت"; fatha over ب drawn before everything, kasra over ت drawn last
    setContent(pdf, page, 'BT /A1 20 Tf 1 0 0 1 131 104 Tm <02> Tj 1 0 0 1 100 100 Tm <040301> Tj 1 0 0 1 103 94 Tm <05> Tj ET')
    const m = await model(pdf)
    expect(m.text).toBe('بَكتِ')
    expect(m.stats.marks).toBe(2)
    expect(m.stats.orphanMarks).toBe(0)
  })
  it('spaces come from gaps; invisible text (Tr 3, OCR layers) is included unless excluded; duplicated glyphs (fake bold) count once', async () => {
    const pdf = await makeDoc().pdf
    const page = pdf.addPage([300, 200])
    addFont(pdf, page, 'F1', { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })
    // no space glyph between the words, only a 0.3 em TJ gap; "Hello" drawn a second time 0.3 pt to the right
    setContent(pdf, page, 'BT /F1 10 Tf 20 100 Td [(Hello) -300 (world)] TJ ET BT /F1 10 Tf 20.3 100 Td (Hello) Tj ET BT 3 Tr /F1 10 Tf 20 60 Td (hidden) Tj ET')
    const all = await model(pdf)
    expect(linesOf(all)).toEqual(['Hello world', 'hidden'])
    const visible = await model(pdf, { includeHidden: false })
    expect(linesOf(visible)).toEqual(['Hello world'])
  })
})
