import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { arr, formatOp, mkOp, num, parseContent, str, type Op } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import { extractPageText, shapesForRange } from '../../src/renderer/src/features/redact/logic/extract'
import { convexOverlapArea, coverage, disjointRects, polygonArea, quadCoverage, rectArea, rectQuad, touches, type Rect } from '../../src/renderer/src/features/redact/logic/geom'
import { DEFAULT_OPTIONS, redactDocument } from '../../src/renderer/src/features/redact/logic/redact'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { rewriteShow, type GlyphSpan } from '../../src/renderer/src/features/redact/logic/textRewrite'
import { buildPdf, helvetica, register, stream, toUnicodeCMap, times, courier } from './helpers/pdfBuilder'

const N = (s: string): PDFName => PDFName.of(s)
const R = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 })

describe('rectangles', () => {
  it('disjointRects covers exactly the same area without overlaps (random property test)', () => {
    let seed = 12345
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (let round = 0; round < 60; round++) {
      const rects: Rect[] = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => {
        const x = Math.floor(rnd() * 20)
        const y = Math.floor(rnd() * 20)
        return R(x, y, x + 1 + Math.floor(rnd() * 8), y + 1 + Math.floor(rnd() * 8))
      })
      const d = disjointRects(rects)
      // pairwise disjoint
      for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) expect(touches(d[i], [d[j]])).toBe(false)
      // same union: check on a 1x1 grid
      for (let x = 0; x < 30; x++) {
        for (let y = 0; y < 30; y++) {
          const cell = R(x + 0.25, y + 0.25, x + 0.75, y + 0.75)
          const inOrig = rects.some((r) => touches(cell, [r]))
          const inDisj = d.some((r) => touches(cell, [r]))
          expect(inDisj, `${x},${y}`).toBe(inOrig)
        }
      }
      expect(d.reduce((a, r) => a + rectArea(r), 0)).toBeLessThanOrEqual(rects.reduce((a, r) => a + rectArea(r), 0) + 1e-9)
    }
  })

  it('touches, coverage and degenerate rects', () => {
    expect(touches(R(0, 0, 10, 10), [R(10, 0, 20, 10)])).toBe(false) // an edge is not an overlap
    expect(touches(R(0, 0, 10.01, 10), [R(10, 0, 20, 10)])).toBe(true)
    expect(coverage(R(0, 0, 10, 10), [R(0, 0, 5, 10)])).toBeCloseTo(0.5)
    expect(coverage(R(0, 0, 10, 10), [R(-5, -5, 50, 50)])).toBe(1)
    expect(coverage(R(5, 5, 5, 9), [R(0, 0, 10, 10)])).toBe(1) // a zero-width glyph counts by position
    expect(coverage(R(50, 5, 50, 9), [R(0, 0, 10, 10)])).toBe(0)
  })
})

describe('quadrilaterals (rotated text)', () => {
  it('overlap area of convex polygons', () => {
    const sq = rectQuad(R(0, 0, 10, 10))
    expect(convexOverlapArea(sq, rectQuad(R(5, 5, 15, 15)))).toBeCloseTo(25)
    expect(convexOverlapArea(sq, rectQuad(R(20, 20, 30, 30)))).toBe(0)
    // a diamond of area 50 inside the square
    const diamond = [5, 0, 10, 5, 5, 10, 0, 5]
    expect(polygonArea(diamond)).toBeCloseTo(50)
    expect(convexOverlapArea(diamond, sq)).toBeCloseTo(50)
    // orientation of either polygon does not matter
    expect(convexOverlapArea([...sq].reverse().reduce<number[]>((a, v, i, all) => (i % 2 === 0 ? [...a, all[i + 1], v] : a), []), sq)).toBeCloseTo(100)
  })

  it('quadCoverage sums the marks, caps at 1 and handles flat glyphs', () => {
    const glyph = rectQuad(R(0, 0, 10, 10))
    expect(quadCoverage(glyph, [rectQuad(R(0, 0, 5, 10)), rectQuad(R(5, 0, 10, 10))])).toBeCloseTo(1)
    expect(quadCoverage(glyph, [rectQuad(R(0, 0, 3, 10))])).toBeCloseTo(0.3)
    expect(quadCoverage([5, 0, 5, 10, 5, 10, 5, 0], [rectQuad(R(0, 0, 10, 10))])).toBe(1)
  })
})

describe('rewriteShow (pure)', () => {
  const glyphs = (n: number, disp = 6, el = -1): GlyphSpan[] => Array.from({ length: n }, (_, i) => ({ el, off: i, n: 1, disp }))
  const tj = (s: string, hex = false): Op => ({ op: 'Tj', args: [str(s, hex)], pre: new Uint8Array(0), raw: null })
  const fmt = (ops: Op[]): string => ops.map(formatOp).join(' ; ')

  it('removes covered characters and adds the advance back as a TJ number', () => {
    // size 12, no horizontal scaling: 6 units of displacement = -6*1000/12 = -500
    expect(fmt(rewriteShow({ op: tj('ABCDE'), strArg: 0, glyphs: glyphs(5), covered: [false, true, true, false, false], size: 12, hScale: 1 }))).toBe('[(A) -1000 (DE)] TJ')
    expect(fmt(rewriteShow({ op: tj('ABCDE'), strArg: 0, glyphs: glyphs(5), covered: [true, false, false, false, false], size: 12, hScale: 1 }))).toBe('[-500 (BCDE)] TJ')
    expect(fmt(rewriteShow({ op: tj('ABCDE'), strArg: 0, glyphs: glyphs(5), covered: [false, false, false, false, true], size: 12, hScale: 1 }))).toBe('[(ABCD) -500] TJ')
    expect(fmt(rewriteShow({ op: tj('ABCDE'), strArg: 0, glyphs: glyphs(5), covered: [true, true, true, true, true], size: 12, hScale: 1 }))).toBe('[-2500] TJ')
    expect(fmt(rewriteShow({ op: tj('ABCDE'), strArg: 0, glyphs: glyphs(5), covered: [false, true, false, true, false], size: 12, hScale: 1 }))).toBe('[(A) -500 (C) -500 (E)] TJ')
  })

  it('keeps the string syntax (hex stays hex) and multi-byte codes together', () => {
    const op: Op = { op: 'Tj', args: [str(Uint8Array.from([0, 65, 0, 66, 0, 67]), true)], pre: new Uint8Array(0), raw: null }
    const g: GlyphSpan[] = [0, 2, 4].map((off) => ({ el: -1, off, n: 2, disp: 7.2 }))
    expect(fmt(rewriteShow({ op, strArg: 0, glyphs: g, covered: [false, true, false], size: 12, hScale: 1 }))).toBe('[<0041> -600 <0043>] TJ')
  })

  it('TJ arrays: existing adjustments are kept, several strings are handled, the total advance is preserved', () => {
    const op: Op = { op: 'TJ', args: [arr(str('AB'), num(-120), str('CD'), num(30), str('EF'))], pre: new Uint8Array(0), raw: null }
    const g: GlyphSpan[] = [
      { el: 0, off: 0, n: 1, disp: 6 },
      { el: 0, off: 1, n: 1, disp: 6 },
      { el: 2, off: 0, n: 1, disp: 6 },
      { el: 2, off: 1, n: 1, disp: 6 },
      { el: 4, off: 0, n: 1, disp: 6 },
      { el: 4, off: 1, n: 1, disp: 6 }
    ]
    const ops = rewriteShow({ op, strArg: 0, glyphs: g, covered: [false, true, true, false, false, false], size: 12, hScale: 1 })
    const a = ops[0].args[0]
    expect(a.t).toBe('arr')
    if (a.t === 'arr') {
      // total of all numbers equals the original numbers plus the two removed glyphs (12 units = 1000 thousandths)
      const total = a.v.filter((x) => x.t === 'num').reduce((s, x) => s + (x as { v: number }).v, 0)
      expect(total).toBeCloseTo(-120 + 30 - 1000)
      expect(a.v.filter((x) => x.t === 'str').map((x) => new TextDecoder().decode((x as { b: Uint8Array }).b))).toEqual(['A', 'D', 'EF'])
    }
  })

  it("expands ' and \" into the operations they stand for", () => {
    const quote: Op = { op: "'", args: [str('ABC')], pre: new Uint8Array([32]), raw: null }
    expect(fmt(rewriteShow({ op: quote, strArg: 0, glyphs: glyphs(3), covered: [false, true, false], size: 12, hScale: 1 }))).toBe('T* ; [(A) -500 (C)] TJ')
    const dq: Op = { op: '"', args: [num(2), num(1), str('ABC')], pre: new Uint8Array(0), raw: null }
    expect(fmt(rewriteShow({ op: dq, strArg: 2, glyphs: glyphs(3), covered: [true, true, true], size: 12, hScale: 1 }))).toBe('2 Tw ; 1 Tc ; T* ; [-1500] TJ')
    // the first replacement keeps the original leading whitespace
    expect(Array.from(rewriteShow({ op: quote, strArg: 0, glyphs: glyphs(1), covered: [true], size: 12, hScale: 1 })[0].pre)).toEqual([32])
  })

  it('whole-run removal keeps only the advance; zero-size text has nothing to keep', () => {
    expect(fmt(rewriteShow({ op: tj('ABC'), strArg: 0, glyphs: glyphs(3), covered: [true, true, true], size: 12, hScale: 0.5, wholeAdvance: 18 }))).toBe('[-3000] TJ')
    expect(rewriteShow({ op: tj('ABC'), strArg: 0, glyphs: glyphs(3), covered: [true, true, true], size: 0, hScale: 1, wholeAdvance: 0 })).toEqual([])
  })

  it('the result serializes to valid operators that parse back', () => {
    const ops = rewriteShow({ op: tj('A(B)C\\D'), strArg: 0, glyphs: glyphs(7), covered: [false, true, true, true, false, false, false], size: 9.5, hScale: 0.8 })
    const bytes = new TextEncoder().encode(ops.map(formatOp).join('\n'))
    const back = parseContent(bytes).ops
    expect(back).toHaveLength(1)
    expect(back[0].op).toBe('TJ')
    void mkOp
  })
})

describe('code space handling', () => {
  it('a Type0 font with a mixed 1- and 2-byte code space is cut on code boundaries', async () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '/CMapName /Mixed def /CMapType 1 def',
      '2 begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange',
      '1 begincidrange <00> <7F> 0 endcidrange',
      '1 begincidrange <8000> <8FFF> 200 endcidrange',
      'endcmap end end'
    ].join('\n')
    const { doc } = await buildPdf([{ content: 'BT /F2 12 Tf 72 700 Td <41428001800242> Tj ET', fonts: {} }])
    const enc = stream(doc, cmap, { Type: 'CMap', CMapName: N('Mixed'), CIDSystemInfo: { Registry: 'Adobe' as unknown, Ordering: 'Identity', Supplement: 0 } })
    const pairs: [number, string][] = [[0x41, 'A'], [0x42, 'B']]
    const tu = toUnicodeCMap(pairs, 1).replace('<00> <FF>', '<00> <7F>')
    const tuFull = tu.replace('endcodespacerange', '<8000> <FFFF>\nendcodespacerange').replace('1 begincodespacerange', '2 begincodespacerange').replace(`${pairs.length} beginbfchar`, `${pairs.length + 2} beginbfchar\n<8001> <00E9>\n<8002> <00FC>`)
    const cid = register(doc, { Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'ABCDEF+Mixed', CIDSystemInfo: { Registry: 'Adobe' as unknown, Ordering: 'Identity', Supplement: 0 }, DW: 500, FontDescriptor: register(doc, { Type: 'FontDescriptor', FontName: 'ABCDEF+Mixed', Flags: 4, FontBBox: [0, 0, 1000, 1000], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80 }) })
    const font = register(doc, { Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+Mixed', Encoding: enc, DescendantFonts: [cid], ToUnicode: stream(doc, tuFull) })
    doc.getPage(0).node.Resources()!.set(N('Font'), doc.context.obj({ F2: font }))
    const bytes = await doc.save()
    const pdf = await PDFDocument.load(bytes)
    const before = analyzePage(pdf, 0).runs[0]
    expect(before.text).toBe('ABéüB')
    const model = extractPageText(pdf, 0)
    const at = model.text.indexOf('é')
    const s = shapesForRange(model, at, at + 2) // "é" and "ü": the two 2-byte codes
    const res = redactDocument(pdf, [{ id: 'm', pageIndex: 0, rects: s.rects, quads: s.quads, text: 'éü' }], DEFAULT_OPTIONS)
    const out = await PDFDocument.load(await pdf.save())
    const after = analyzePage(out, 0).runs.filter((r) => !r.fontName.startsWith('EpdfRdFont'))
    expect(after.map((r) => r.text).join('')).toBe('ABB')
    expect(res.report.wholeRuns).toBe(0)
  })

  it('the standard fonts (Times, Courier, Helvetica-Bold via pdf-lib) are cut with their own widths', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const f1 = await doc.embedFont(StandardFonts.TimesRoman)
    const f2 = await doc.embedFont(StandardFonts.Courier)
    const f3 = await doc.embedFont(StandardFonts.HelveticaBold)
    page.drawText('Times CUT_HERE tail', { x: 72, y: 700, size: 14, font: f1 })
    page.drawText('Courier CUT_HERE tail', { x: 72, y: 650, size: 14, font: f2 })
    page.drawText('Bold CUT_HERE tail', { x: 72, y: 600, size: 14, font: f3 })
    const pdf = await PDFDocument.load(await doc.save())
    const before = analyzePage(pdf, 0).runs
    const marks = ['CUT_HERE', 'CUT_HERE', 'CUT_HERE'].map((needle, i) => {
      const model = extractPageText(pdf, 0)
      let at = -1
      for (let k = 0; k <= i; k++) at = model.text.indexOf(needle, at + 1)
      const s = shapesForRange(model, at, at + needle.length)
      return { id: `m${i}`, pageIndex: 0, rects: s.rects, quads: s.quads, text: needle }
    })
    const res = redactDocument(pdf, marks, DEFAULT_OPTIONS)
    const out = await PDFDocument.load(await pdf.save())
    const after = analyzePage(out, 0).runs.filter((r) => !r.fontName.startsWith('EpdfRdFont'))
    expect(after.map((r) => r.text.replace(/\s+/g, ' ').trim())).toEqual(['Times tail', 'Courier tail', 'Bold tail'])
    // "tail" sits exactly where it did
    for (let i = 0; i < 3; i++) {
      const b = before[i]
      const a = after[i]
      const bx = b.matrix[4] + b.glyphs[b.text.indexOf('tail')].x0
      const ax = a.matrix[4] + a.glyphs[a.text.indexOf('tail')].x0
      expect(ax).toBeCloseTo(bx, 3)
    }
    const f = await verifyRedaction({ bytes: await pdf.save(), marksByPage: res.marksByPage, shapesByPage: res.shapesByPage, secrets: res.secrets })
    expect(f).toEqual([])
    void helvetica
    void times
    void courier
  })
})

describe('rotated text keeps its neighbours', () => {
  for (const angle of [30, 90, 180, 270, -45]) {
    it(`text at ${angle} degrees: only the marked word goes and the rest stays in place`, async () => {
      const th = (angle * Math.PI) / 180
      const c = Math.cos(th).toFixed(6)
      const s = Math.sin(th).toFixed(6)
      const { bytes } = await buildPdf([{ content: `BT /F1 12 Tf ${c} ${s} ${-Number(s)} ${c} 300 300 Tm (alpha SECRET omega) Tj ET`, fonts: { F1: helvetica } }])
      const pdf = await PDFDocument.load(bytes)
      const b = analyzePage(pdf, 0).runs[0]
      const model = extractPageText(pdf, 0)
      const at = model.text.indexOf('SECRET')
      const sh = shapesForRange(model, at, at + 6)
      expect(sh.quads[0]).not.toBeNull() // a rotated box, not the bounding rect
      const res = redactDocument(pdf, [{ id: 'm', pageIndex: 0, rects: sh.rects, quads: sh.quads, text: 'SECRET' }], DEFAULT_OPTIONS)
      const outBytes = await pdf.save()
      const out = await PDFDocument.load(outBytes)
      const a = analyzePage(out, 0).runs.filter((r) => !r.fontName.startsWith('EpdfRdFont'))
      expect(a.map((r) => r.text).join('')).toBe('alpha  omega')
      const pos = (r: (typeof b), ch: number): [number, number] => [r.matrix[0] * r.glyphs[ch].x0 + r.matrix[4], r.matrix[1] * r.glyphs[ch].x0 + r.matrix[5]]
      const o0 = pos(b, b.text.indexOf('omega'))
      const n0 = pos(a[0], a[0].text.indexOf('omega'))
      expect(n0[0]).toBeCloseTo(o0[0], 3)
      expect(n0[1]).toBeCloseTo(o0[1], 3)
      expect(await verifyRedaction({ bytes: outBytes, marksByPage: res.marksByPage, shapesByPage: res.shapesByPage, secrets: res.secrets })).toEqual([])
    })
  }
})
