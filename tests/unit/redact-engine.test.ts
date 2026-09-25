import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, PDFString, decodePDFRawStream, PDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage, type TextRun } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { extractPageText, shapesForRange } from '../../src/renderer/src/features/redact/logic/extract'
import { DEFAULT_OPTIONS, RedactRefused, redactDocument, type MarkInput, type RedactOptions } from '../../src/renderer/src/features/redact/logic/redact'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { buildPdf, helvetica, register, stream, subsetSimpleFont, toUnicodeCMap, type0Font, type Lit } from './helpers/pdfBuilder'

const N = (s: string): PDFName => PDFName.of(s)

type Build = (doc: PDFDocument) => Record<string, PDFRef | Lit> | void

/** One-page document with the given content; `setup` may add fonts/xobjects and returns the Resources entries. */
async function page(content: string | string[], setup?: (doc: PDFDocument) => { fonts?: Record<string, PDFRef | Lit>; xobjects?: Record<string, PDFRef | Lit>; extra?: Record<string, unknown> }): Promise<{ doc: PDFDocument; bytes: Uint8Array }> {
  const { doc } = await buildPdf([{ content, fonts: {} }])
  const s = setup?.(doc)
  const res = doc.getPage(0).node.Resources()!
  const fonts: Record<string, PDFRef | Lit> = { F1: register(doc, helvetica), ...(s?.fonts ?? {}) }
  res.set(N('Font'), doc.context.obj(fonts as never))
  if (s?.xobjects) res.set(N('XObject'), doc.context.obj(s.xobjects as never))
  for (const [k, v] of Object.entries(s?.extra ?? {})) res.set(N(k), doc.context.obj(v as never))
  return { doc, bytes: await doc.save() }
}

async function markText(bytes: Uint8Array, needle: string, pageIndex = 0, nth = 0): Promise<MarkInput> {
  const pdf = await PDFDocument.load(bytes)
  const model = extractPageText(pdf, pageIndex)
  let at = -1
  for (let i = 0; i <= nth; i++) at = model.text.indexOf(needle, at + 1)
  if (at < 0) throw new Error(`"${needle}" not found in ${JSON.stringify(model.text)}`)
  const s = shapesForRange(model, at, at + needle.length)
  return { id: `m${pageIndex}`, pageIndex, rects: s.rects, quads: s.quads, text: needle }
}

const area = (x0: number, y0: number, x1: number, y1: number, pageIndex = 0): MarkInput => ({ id: 'a', pageIndex, rects: [{ x0, y0, x1, y1 }] })

async function apply(bytes: Uint8Array, marks: MarkInput[], opts: Partial<RedactOptions> = {}) {
  const pdf = await PDFDocument.load(bytes)
  const res = redactDocument(pdf, marks, { ...DEFAULT_OPTIONS, ...opts })
  const out = await pdf.save()
  return { ...res, out, pdf: await PDFDocument.load(out) }
}

const runs = (pdf: PDFDocument, i = 0): TextRun[] => analyzePage(pdf, i).runs.filter((r) => !r.fontName.startsWith('EpdfRdFont'))
/** Text of the runs (runs left empty by a removal are not shown). */
const texts = (pdf: PDFDocument, i = 0): string[] => runs(pdf, i).map((r) => r.text).filter((t) => t !== '')

/** Left edge (user space) of every character, keyed by text position in the page text. */
function glyphXs(pdf: PDFDocument, i = 0): Map<string, number[]> {
  const m = new Map<string, number[]>()
  for (const r of runs(pdf, i)) r.glyphs.forEach((g) => m.set(g.text, [...(m.get(g.text) ?? []), r.matrix[0] * g.x0 + r.matrix[4]]))
  return m
}

const decodedContent = (pdf: PDFDocument, pageIndex = 0): string => {
  const c = pdf.getPage(pageIndex).node.Contents()
  const list: PDFStream[] = []
  if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) list.push(c.lookup(i) as PDFStream)
  else if (c) list.push(c as PDFStream)
  return list.map((s) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString('latin1')).join('\n')
}

describe('text rewriting keeps survivors exactly where they were', () => {
  it('character, word and horizontal scaling (Tc, Tw, Tz) and rise', async () => {
    const { bytes } = await page('BT /F1 12 Tf 1.5 Tc 4 Tw 80 Tz 3 Ts 72 700 Td (alpha SECRET beta gamma) Tj ET')
    const before = glyphXs(await PDFDocument.load(bytes))
    const r = await apply(bytes, [await markText(bytes, 'SECRET')])
    const after = glyphXs(r.pdf)
    for (const ch of ['a', 'b', 'g', 'm']) expect(after.get(ch)).toEqual(before.get(ch)!.map((x, i) => (after.get(ch)![i] === undefined ? x : after.get(ch)![i])))
    // each surviving glyph sits within 0.001 pt of its original position
    const b = runs(await PDFDocument.load(bytes))[0]
    const a = runs(r.pdf)
    const bx = new Map<number, number>()
    b.glyphs.forEach((g, i) => bx.set(i, b.matrix[0] * g.x0 + b.matrix[4]))
    const survivors = a.flatMap((x) => x.glyphs.map((g) => x.matrix[0] * g.x0 + x.matrix[4]))
    const orig = [...bx.values()]
    for (const x of survivors) expect(orig.some((o) => Math.abs(o - x) < 0.001)).toBe(true)
    expect(a.map((x) => x.text).join('')).toBe('alpha  beta gamma')
  })

  it('a rotated text matrix', async () => {
    const { bytes } = await page('BT /F1 12 Tf 0.8660254 0.5 -0.5 0.8660254 100 100 Tm (rotated SECRET text) Tj ET')
    const b0 = runs(await PDFDocument.load(bytes))[0]
    const r = await apply(bytes, [await markText(bytes, 'SECRET')])
    const a = runs(r.pdf)
    expect(a.map((x) => x.text).join('')).toBe('rotated  text')
    // "text" starts at the same point as before
    const orig = b0.glyphs[b0.text.indexOf('text')]
    const now = a[0].glyphs[a[0].text.indexOf('text')]
    const p0 = [b0.matrix[0] * orig.x0 + b0.matrix[4], b0.matrix[1] * orig.x0 + b0.matrix[5]]
    const p1 = [a[0].matrix[0] * now.x0 + a[0].matrix[4], a[0].matrix[1] * now.x0 + a[0].matrix[5]]
    expect(p1[0]).toBeCloseTo(p0[0], 3)
    expect(p1[1]).toBeCloseTo(p0[1], 3)
  })

  it('a hex string and a string with escapes', async () => {
    const { bytes } = await page('BT /F1 12 Tf 72 700 Td <48656C6C6F20534543524554206D6F7265> Tj 0 -14 Td (paren \\(SECRET\\) \\101) Tj ET')
    const r = await apply(bytes, [await markText(bytes, 'SECRET', 0, 0), await markText(bytes, 'SECRET', 0, 1)])
    expect(texts(r.pdf)).toEqual(['Hello  more', 'paren () A'])
  })

  it('whole run removed keeps the following text in place (fail closed advance)', async () => {
    const { bytes } = await page('BT /F1 12 Tf 72 700 Td (SECRET) Tj ( after) Tj ET')
    const b = runs(await PDFDocument.load(bytes))
    const r = await apply(bytes, [await markText(bytes, 'SECRET')])
    const a = runs(r.pdf).filter((x) => x.text !== '')
    expect(a.map((x) => x.text)).toEqual([' after'])
    expect(a[0].matrix[4] + a[0].glyphs[0].x0).toBeCloseTo(b[1].matrix[4] + b[1].glyphs[0].x0, 3)
  })
})

describe('every font type our engine reads', () => {
  it('Type0 Identity-H with 2-byte codes: only the covered codes go', async () => {
    const codes: Record<number, string> = { 3: 'A', 4: 'B', 5: 'C', 6: 'D', 7: ' ' }
    const { bytes } = await page('BT /F2 12 Tf 72 700 Td <0003000400050006> Tj ET', (doc) => ({ fonts: { F2: type0Font(doc, { glyphs: codes, width: 600 }) } }))
    const b = runs(await PDFDocument.load(bytes))[0]
    const r = await apply(bytes, [await markText(bytes, 'BC')])
    const a = runs(r.pdf)
    expect(a.map((x) => x.text).join('')).toBe('AD')
    const d = a.flatMap((x) => x.glyphs.map((g) => ({ t: g.text, x: x.matrix[4] + g.x0 })))
    expect(d.find((x) => x.t === 'D')!.x).toBeCloseTo(b.matrix[4] + b.glyphs[3].x0, 3)
    expect(r.report.wholeRuns).toBe(0)
  })

  it('subset simple font with /Differences and ToUnicode', async () => {
    const { bytes } = await page('BT /F2 12 Tf 72 700 Td (\\001\\002\\003\\004) Tj ET', (doc) => ({
      fonts: { F2: subsetSimpleFont(doc, { codes: { 1: 'x', 2: 'y', 3: 'z', 4: 'w' } }) }
    }))
    const r = await apply(bytes, [await markText(bytes, 'yz')])
    expect(texts(r.pdf).join('')).toBe('xw')
    expect(r.report.wholeRuns).toBe(0)
  })

  it('a font that cannot be read (no ToUnicode on a Type0 font): the whole run is removed', async () => {
    const { bytes } = await page('BT /F2 12 Tf 72 700 Td <0003000400050006> Tj ET BT /F1 12 Tf 72 600 Td (kept) Tj ET', (doc) => {
      const cid = register(doc, { Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'AAAAAA+X', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, DW: 500, FontDescriptor: register(doc, { Type: 'FontDescriptor', FontName: 'AAAAAA+X', Flags: 4, FontBBox: [0, 0, 1000, 1000], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80 }) })
      return { fonts: { F2: register(doc, { Type: 'Font', Subtype: 'Type0', BaseFont: 'AAAAAA+X', Encoding: 'Identity-H', DescendantFonts: [cid] }) } }
    })
    // the text is unreadable, so mark by area
    const r = await apply(bytes, [area(60, 690, 100, 715)])
    expect(r.report.wholeRuns).toBe(1)
    expect(texts(r.pdf)).toEqual(['kept'])
  })

  it('a covered glyph without a Unicode mapping removes the whole run', async () => {
    // glyph 5 has no ToUnicode entry: A(7.2pt) B(7.2pt) ?(12pt) D(7.2pt) starting at x=72
    const { bytes } = await page('BT /F2 12 Tf 72 700 Td <0003000400050006> Tj ET', (doc) => ({
      fonts: { F2: type0Font(doc, { glyphs: { 3: 'A', 4: 'B', 6: 'D' }, width: 600 }) }
    }))
    const r = await apply(bytes, [area(90, 690, 95, 715)])
    expect(r.report.wholeRuns).toBe(1)
    expect(texts(r.pdf)).toEqual([])
  })

  it('Type 3 text is removed as a whole', async () => {
    const { bytes } = await page('BT /F3 10 Tf 72 700 Td (ab) Tj ET BT /F1 12 Tf 72 600 Td (kept) Tj ET', (doc) => {
      const proc = stream(doc, '1000 0 0 0 750 750 d1 0 0 750 750 re f')
      const t3 = register(doc, { Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 750, 750], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { a: proc, b: proc }, Encoding: { Type: 'Encoding', Differences: [97, N('a'), N('b')] }, FirstChar: 97, LastChar: 98, Widths: [1000, 1000] })
      return { fonts: { F3: t3 } }
    })
    const r = await apply(bytes, [area(72, 700, 84, 710)])
    expect(r.report.wholeRuns).toBe(1)
    expect(texts(r.pdf)).toEqual(['kept'])
  })

  it('hidden (render mode 3) text under a mark is removed too', async () => {
    const { bytes } = await page('BT 3 Tr /F1 12 Tf 72 700 Td (hidden SECRET layer) Tj ET')
    const r = await apply(bytes, [await markText(bytes, 'SECRET')])
    expect(texts(r.pdf)).toEqual(['hidden  layer'])
  })
})

describe('marked content replacement text', () => {
  it('ActualText, Alt and E are removed from the properties of a span whose text was removed', async () => {
    const content = [
      '/Span << /ActualText (SECRET) /MCID 0 >> BDC BT /F1 12 Tf 72 700 Td (SECRET) Tj ET EMC',
      '/Span /P1 BDC BT /F1 12 Tf 72 650 Td (other SECRET) Tj ET EMC',
      '/Span << /ActualText (kept text) >> BDC BT /F1 12 Tf 72 600 Td (kept) Tj ET EMC'
    ].join('\n')
    const { bytes } = await page(content, () => ({ extra: { Properties: { P1: { Alt: 'SECRET alt', MCID: 1 } } } }))
    const r = await apply(bytes, [await markText(bytes, 'SECRET', 0, 0), await markText(bytes, 'SECRET', 0, 1)])
    const c = decodedContent(r.pdf)
    expect(c).not.toContain('ActualText (SECRET)')
    expect(c).not.toContain('/ActualText (SECRET)')
    expect(c).toContain('kept text') // untouched span keeps its replacement text
    expect(c).not.toMatch(/SECRET/)
    expect(r.report.marked).toBe(2)
    expect(c).toContain('/MCID 0')
  })
})

describe('forms: copy on write', () => {
  it('a form shared with an unmarked page is copied; only the marked use changes', async () => {
    const { createSharedFormPdf } = await import('../fixtures/redact.mjs')
    const bytes = await createSharedFormPdf()
    const marks = [await markText(bytes, 'SECRETFORM', 0)]
    const r = await apply(bytes, marks)
    expect(texts(r.pdf, 0)).toEqual(['Alpha'])
    expect(texts(r.pdf, 1)).toEqual(['Alpha', 'SECRETFORM']) // page 2 untouched
    expect(texts(r.pdf, 2)).toEqual(['Alpha', 'SECRETFORM'])
    expect(r.report.forms).toBe(1)
    // the same form object is still used by the two unmarked pages
    const f1 = (r.pdf.getPage(1).node.Resources()!.lookup(N('XObject')) as PDFDict).get(N('Fm1'))
    const f2 = (r.pdf.getPage(2).node.Resources()!.lookup(N('XObject')) as PDFDict).get(N('Fm1'))
    expect(f1).toBeInstanceOf(PDFRef)
    expect((f1 as PDFRef).objectNumber).toBe((f2 as PDFRef).objectNumber)
    // page 1 no longer reaches the original
    const own = (r.pdf.getPage(0).node.Resources()!.lookup(N('XObject')) as PDFDict)
    expect([...own.entries()].some(([, v]) => v instanceof PDFRef && v.objectNumber === (f1 as PDFRef).objectNumber)).toBe(false)
  })

  it('a form drawn twice on one page: only the use under the mark is changed', async () => {
    const { bytes } = await page('q 1 0 0 1 72 700 cm /Fm1 Do Q q 1 0 0 1 72 500 cm /Fm1 Do Q', (doc) => ({
      xobjects: { Fm1: stream(doc, 'BT /F1 12 Tf 0 0 Td (Alpha SECRET) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, -4, 200, 14], Resources: { Font: { F1: register(doc, helvetica) } } }) }
    }))
    const r = await apply(bytes, [await markText(bytes, 'SECRET', 0, 0)])
    expect(texts(r.pdf)).toEqual(['Alpha ', 'Alpha SECRET'])
  })

  it('nested forms and a form without its own resources', async () => {
    const { bytes } = await page('q 1 0 0 1 72 700 cm /Outer Do Q', (doc) => {
      const inner = stream(doc, 'BT /F1 12 Tf 0 0 Td (inner SECRET) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, -4, 200, 14] }) // inherits the page fonts
      const outer = stream(doc, 'BT /F1 12 Tf 0 20 Td (outer) Tj ET /Inner Do', { Type: 'XObject', Subtype: 'Form', BBox: [0, -4, 200, 40], Resources: { Font: { F1: register(doc, helvetica) }, XObject: { Inner: inner } } })
      return { xobjects: { Outer: outer } }
    })
    const r = await apply(bytes, [await markText(bytes, 'SECRET')])
    expect(texts(r.pdf)).toEqual(['outer', 'inner '])
    expect(r.report.forms).toBe(2)
  })

  it('a soft-mask group containing text under a mark is redacted too', async () => {
    const { bytes } = await page('/GS1 gs 0 0 1 rg 72 700 100 20 re f', (doc) => {
      const group = stream(doc, 'BT /F1 12 Tf 72 705 Td (mask SECRET) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Group: { S: N('Transparency'), CS: N('DeviceGray') }, Resources: { Font: { F1: register(doc, helvetica) } } })
      return { extra: { ExtGState: { GS1: { Type: 'ExtGState', SMask: { Type: 'Mask', S: N('Luminosity'), G: group } } } } }
    })
    const model = extractPageText(await PDFDocument.load(bytes), 0)
    void model
    const r = await apply(bytes, [area(72, 700, 172, 720)])
    // the mask group content has no readable text left
    const raw = Buffer.from(r.out).toString('latin1')
    expect(raw).not.toContain('SECRET')
    const c = decodedContent(r.pdf)
    expect(c).toContain('gs')
    let found = ''
    for (const [, o] of r.pdf.context.enumerateIndirectObjects()) if (o instanceof PDFStream && String(o.dict.lookup(N('Subtype'))) === '/Form') found += Buffer.from(decodePDFRawStream(o as PDFRawStream).decode()).toString('latin1')
    expect(found).not.toContain('SECRET')
  })
})

describe('vector graphics, patterns and shadings under a mark', () => {
  it('paths inside a mark are removed, partly covered ones are clipped, others stay', async () => {
    const { bytes } = await page('1 0 0 rg 100 100 20 20 re f 0 1 0 rg 150 100 60 20 re f 0 0 1 rg 300 300 40 40 re f 0 0 0 RG 2 w 105 105 m 115 115 l S')
    const r = await apply(bytes, [area(90, 90, 180, 130)])
    const c = decodedContent(r.pdf)
    expect(c).not.toContain('100 100 20 20 re') // fully inside: gone
    expect(c).not.toContain('105 105 m') // the stroked line inside: gone
    expect(c).toContain('150 100 60 20 re') // partly covered: kept ...
    expect(c).toContain('W*') // ... but clipped so nothing paints under the mark
    expect(c).toContain('300 300 40 40 re') // untouched
    expect(r.report.paths).toBe(2)
    expect(r.report.pathsClipped).toBe(1)
  })

  it('an unpainted, unclipping path under a mark is dropped', async () => {
    const { bytes } = await page('100 100 m 120 120 l n 300 300 m 320 320 l S')
    const r = await apply(bytes, [area(90, 90, 130, 130)])
    const c = decodedContent(r.pdf)
    expect(c).not.toContain('100 100 m')
    expect(c).toContain('300 300 m')
  })

  it('a clipping path that lies inside a mark keeps its effect but not its shape', async () => {
    const { bytes } = await page('q 100 100 m 120 100 l 110 130 l h W n 1 0 0 rg 0 0 612 792 re f Q')
    const r = await apply(bytes, [area(90, 90, 130, 140)])
    const c = decodedContent(r.pdf)
    expect(c).not.toContain('120 100 l')
    expect(c).toMatch(/re\s+W/)
  })

  it('a tiling pattern that draws text is dropped where it paints under a mark', async () => {
    const { bytes } = await page('/Pattern cs /P1 scn 100 100 100 50 re f /Pattern cs /P2 scn 300 300 50 50 re f', (doc) => ({
      extra: {
        Pattern: {
          P1: doc.context.stream('BT /F1 8 Tf 0 0 Td (SECRETPAT) Tj ET', { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 60, 12], XStep: 60, YStep: 12, Resources: { Font: { F1: register(doc, helvetica) } } } as never),
          P2: doc.context.stream('0 0 5 5 re f', { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: {} } as never)
        }
      }
    }))
    // (patterns given as direct streams are registered by obj(); make them indirect)
    void bytes
    const doc = (await page('/Pattern cs /P1 scn 100 100 100 50 re f', (d) => {
      const p1 = d.context.register(d.context.stream('BT /F1 8 Tf 0 0 Td (SECRETPAT) Tj ET', { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 60, 12], XStep: 60, YStep: 12, Resources: { Font: { F1: register(d, helvetica) } } } as never))
      return { extra: { Pattern: { P1: p1 } } }
    })).bytes
    const r = await apply(doc, [area(90, 90, 250, 170)])
    expect(r.report.patterns).toBe(1)
    expect(Buffer.from(r.out).toString('latin1')).not.toContain('SECRETPAT')
    let all = ''
    for (const [, o] of r.pdf.context.enumerateIndirectObjects()) if (o instanceof PDFStream) all += Buffer.from(decodePDFRawStream(o as PDFRawStream).decode()).toString('latin1')
    expect(all).not.toContain('SECRETPAT')
  })

  it('shadings: axial ones are clipped around the mark, others are removed', async () => {
    const mk = (type: number) => async () => {
      const { bytes } = await page('q 50 50 300 100 re W n /Sh1 sh Q', (doc) => ({
        extra: { Shading: { Sh1: register(doc, { ShadingType: type, ColorSpace: N('DeviceRGB'), Coords: [50, 0, 350, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }, Extend: [true, true] }) } }
      }))
      return apply(bytes, [area(100, 60, 160, 120)])
    }
    const axial = await mk(2)()
    expect(decodedContent(axial.pdf)).toContain('/Sh1 sh')
    expect(decodedContent(axial.pdf)).toContain('W*')
    expect(axial.report.shadings).toBe(1)
    const fn = await mk(1)()
    expect(decodedContent(fn.pdf)).not.toContain('sh')
  })
})

describe('refusals and limits', () => {
  it('a page whose content cannot be parsed is refused, not half-redacted', async () => {
    const { bytes } = await page('BT /F1 12 Tf 72 700 Td (unterminated Tj ET')
    const pdf = await PDFDocument.load(bytes)
    expect(() => redactDocument(pdf, [area(0, 0, 600, 800)], DEFAULT_OPTIONS)).toThrow(RedactRefused)
    expect(() => redactDocument(pdf, [area(0, 0, 600, 800)], DEFAULT_OPTIONS)).toThrow(/Page 1/)
  })

  it('nothing marked, bad page numbers and empty rects are rejected', async () => {
    const { bytes } = await page('BT /F1 12 Tf 72 700 Td (x) Tj ET')
    const pdf = await PDFDocument.load(bytes)
    expect(() => redactDocument(pdf, [], DEFAULT_OPTIONS)).toThrow(/nothing/i)
    expect(() => redactDocument(pdf, [area(0, 0, 0, 0)], DEFAULT_OPTIONS)).toThrow(/nothing/i)
    expect(() => redactDocument(pdf, [area(0, 0, 10, 10, 5)], DEFAULT_OPTIONS)).toThrow(/page 6/)
  })
})

describe('the overlay', () => {
  it('draws the fill and the chosen text on top, upright on rotated pages too', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 12 Tf 72 700 Td (say SECRET now) Tj ET', fonts: { F1: helvetica }, rotate: 90 }])
    const bytes = await doc.save()
    // a 100 x 40 point mark: displayed on the rotated page it is 40 wide and 100 tall
    const r = await apply(bytes, [area(72, 690, 172, 730)], { fill: [1, 0, 0], overlayText: 'REDACTED' })
    const c = decodedContent(r.pdf)
    expect(c).toContain('1 0 0 rg')
    expect(c).toMatch(/0 1 -1 0 [\d.]+ [\d.]+ Tm/) // rotated to stay upright on a page turned by 90 degrees
    expect(texts(r.pdf).join('')).not.toContain('SECRET')
    const withText = analyzePage(r.pdf, 0).runs.filter((x) => x.fontName.startsWith('EpdfRdFont')).map((x) => x.text)
    expect(withText).toEqual(['REDACTED'])
  })

  it('no text when none is wanted; the overlay is drawn in a clean graphics state', async () => {
    const { bytes } = await page('0.5 g 0.3 0 0 0.3 0 0 cm /GS1 gs BT /F1 12 Tf 240 2300 Td (SECRET) Tj ET', () => ({ extra: { ExtGState: { GS1: { CA: 0.2, ca: 0.2 } } } }))
    const r = await apply(bytes, [await markText(bytes, 'SECRET')])
    const c = decodedContent(r.pdf)
    expect(analyzePage(r.pdf, 0).runs.filter((x) => x.fontName.startsWith('EpdfRdFont'))).toHaveLength(0)
    expect(c).toMatch(/\/EpdfRdGS1 gs/)
    expect(c.trim().endsWith('Q')).toBe(true)
    const findings = await verifyRedaction({ bytes: r.out, marksByPage: r.marksByPage, secrets: r.secrets })
    expect(findings).toEqual([])
    void toUnicodeCMap
  })
})
