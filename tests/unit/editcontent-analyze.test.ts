import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { buildPdf, helvetica, pdfLibDoc, sampleTextPdf, subsetSimpleFont, times, type Lit } from './helpers/pdfBuilder'

const load = (b: Uint8Array) => PDFDocument.load(b)
const near = (a: number, b: number, eps = 0.01): void => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('page analysis: text runs from a pdf-lib generated page', () => {
  it('finds each drawText call with font, size, text and geometry', async () => {
    const doc = await load(await sampleTextPdf())
    const a = analyzePage(doc, 0)
    expect(a.runs.map((r) => r.text)).toEqual(['Hello world from Epdf', 'The quick brown fox jumps over the lazy dog.'])
    const r = a.runs[0]
    expect(r.font.displayName).toBe('Helvetica')
    expect(r.size).toBe(24)
    expect(r.op).toBe('Tj')
    near(r.matrix[4], 72)
    near(r.matrix[5], 700)
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica)
    const w = font.widthOfTextAtSize('Hello world from Epdf', 24)
    near(r.bbox.x0, 72)
    near(r.bbox.x1, 72 + w, 0.5) // pdf-lib's measure applies kerning pairs, the raw advance does not
    // Ascent/descent of Helvetica: 718 / -207 per 1000.
    near(r.bbox.y1, 700 + 0.718 * 24, 0.5)
    near(r.bbox.y0, 700 - 0.207 * 24, 0.5)
    expect(r.upright).toBe(true)
    expect(r.visible).toBe(true)
    expect(r.color.css).toBe('#000000')
  })

  it('groups the runs into two line blocks and no paragraph (different sizes)', async () => {
    const a = analyzePage(await load(await sampleTextPdf()), 0)
    const set = buildBlocks(a)
    expect(set.lines.map((b) => b.text)).toEqual(['Hello world from Epdf', 'The quick brown fox jumps over the lazy dog.'])
    expect(set.paragraphs).toHaveLength(0)
    expect(set.lines.every((b) => b.editable)).toBe(true)
    expect(set.lines[0].id).not.toBe(set.lines[1].id)
  })
})

describe('state tracking', () => {
  const page = (content: string, fonts: Record<string, Lit> = { F1: helvetica }) => buildPdf([{ content, fonts }]).then((r) => load(r.bytes))

  it('applies cm, q/Q nesting and Tm/Td to text positions', async () => {
    const doc = await page(
      [
        'q 2 0 0 2 10 20 cm',
        'BT /F1 10 Tf 1 0 0 1 5 6 Tm (A) Tj ET',
        'q 1 0 0 1 100 0 cm BT /F1 10 Tf 0 0 Td (B) Tj ET Q',
        'BT /F1 10 Tf 0 0 Td (C) Tj ET',
        'Q',
        'BT /F1 10 Tf 300 400 Td (D) Tj ET'
      ].join('\n')
    )
    const runs = analyzePage(doc, 0).runs
    expect(runs.map((r) => r.text)).toEqual(['A', 'B', 'C', 'D'])
    // A: Tm(5,6) * cm(2,0,0,2,10,20) => (20, 32)
    near(runs[0].matrix[4], 20)
    near(runs[0].matrix[5], 32)
    near(runs[0].matrix[0], 2)
    // B: cm 1,0,0,1,100,0 inside the first cm => origin (10 + 2*100, 20)
    near(runs[1].matrix[4], 210)
    near(runs[1].matrix[5], 20)
    // C: back to the outer cm only
    near(runs[2].matrix[4], 10)
    near(runs[2].matrix[5], 20)
    // D: after Q, identity
    near(runs[3].matrix[4], 300)
    near(runs[3].matrix[5], 400)
    near(runs[0].size * runs[0].matrix[3], 20) // effective size 10 * scale 2
  })

  it('handles Td, TD, T*, TL, quote operators and word/char spacing', async () => {
    const doc = await page(
      ['BT /F1 12 Tf 14 TL 100 700 Td (one) Tj T* (two) Tj 0 -20 TD (three) Tj T* (four) Tj (five) \' 3 2 (six) " ET'].join('\n')
    )
    const runs = analyzePage(doc, 0).runs
    expect(runs.map((r) => r.text)).toEqual(['one', 'two', 'three', 'four', 'five', 'six'])
    const ys = runs.map((r) => r.matrix[5])
    near(ys[0], 700)
    near(ys[1], 686)
    near(ys[2], 666) // TD -20 sets leading 20 as well
    near(ys[3], 646)
    near(ys[4], 626)
    near(ys[5], 606)
    expect(runs[5].wordSpace).toBe(3)
    expect(runs[5].charSpace).toBe(2)
    expect(runs[4].op).toBe("'")
    expect(runs[5].op).toBe('"')
    expect(runs[5].strArg).toBe(2)
  })

  it('advances the text position after each show (consecutive Tj continue on the line)', async () => {
    const doc = await page('BT /F1 10 Tf 50 100 Td (Hello) Tj ( there) Tj ET')
    const [a, b] = analyzePage(doc, 0).runs
    // Helvetica: H=722 e=556 l=222 l=222 o=556 -> 2278/1000*10
    near(a.advance, 22.78, 0.001)
    near(b.matrix[4], 50 + 22.78, 0.001)
  })

  it('applies character spacing, word spacing and horizontal scaling', async () => {
    const doc = await page('BT /F1 10 Tf 1 Tc 5 Tw 50 Tz 0 0 Td (a b) Tj ET')
    const r = analyzePage(doc, 0).runs[0]
    // widths a=556 space=278 b=556; each glyph adds Tc, the space adds Tw as well; all scaled by Tz=0.5
    const expected = ((556 + 278 + 556) / 1000) * 10 * 0.5 + 3 * 1 * 0.5 + 5 * 0.5
    near(r.advance, expected, 0.001)
    expect(r.hScale).toBe(0.5)
  })

  it('reads TJ arrays: kerning adjusts positions and gaps count in the advance', async () => {
    const doc = await page('BT /F1 10 Tf 0 0 Td [(A) -1000 (B) 500 (C)] TJ ET')
    const r = analyzePage(doc, 0).runs[0]
    expect(r.text).toBe('ABC')
    // A=667 B=667 C=722 ; -1000 moves right by 10, +500 moves left by 5
    near(r.advance, ((667 + 667 + 722) / 1000) * 10 + 10 - 5, 0.001)
    expect(r.glyphs.map((g) => g.el)).toEqual([0, 2, 4])
    near(r.glyphs[1].x0, (667 / 1000) * 10 + 10, 0.001)
  })

  it('tracks rise, render mode and rotated matrices', async () => {
    const doc = await page(
      [
        'BT /F1 10 Tf 3 Ts 0 0 Td (up) Tj ET',
        'BT /F1 10 Tf 3 Tr 0 0 Td (hidden) Tj 0 Tr ET',
        'BT /F1 10 Tf 0 1 -1 0 200 200 Tm (rot) Tj ET',
        'BT /F1 10 Tf 1 0 0 -1 50 50 Tm (flip) Tj ET'
      ].join('\n')
    )
    const a = analyzePage(doc, 0)
    const [up, hidden, rot, flip] = a.runs
    expect(up.rise).toBe(3)
    near(up.bbox.y1, 3 + 0.718 * 10, 0.5)
    expect(hidden.visible).toBe(false)
    expect(a.hiddenRuns).toBe(1)
    expect(rot.upright).toBe(false)
    expect(flip.upright).toBe(false)
    expect(up.upright).toBe(true)
    // rotated 90°: the bbox is taller than wide
    expect(rot.bbox.y1 - rot.bbox.y0).toBeGreaterThan(rot.bbox.x1 - rot.bbox.x0)
  })

  it('tracks fill colors: g, rg, k, and scn with a color space', async () => {
    const doc = await page(
      ['BT /F1 10 Tf 0 0 Td 1 0 0 rg (r) Tj 0.5 g (g) Tj 0 0 0 1 k (k) Tj /Cs1 cs 0 0 1 scn (b) Tj ET'].join('\n')
    )
    const runs = analyzePage(doc, 0).runs
    expect(runs.map((r) => r.color.css)).toEqual(['#ff0000', '#808080', '#000000', '#0000ff'])
    expect(runs[3].color.ops.map((o) => o.op)).toEqual(['cs', 'scn'])
  })

  it('unbalanced Q is ignored, unbalanced q is reported at the end', async () => {
    const doc = await page('Q Q q q 1 0 0 1 10 10 cm BT /F1 10 Tf 0 0 Td (x) Tj ET')
    const a = analyzePage(doc, 0)
    expect(a.runs).toHaveLength(1)
    near(a.runs[0].matrix[4], 10)
    expect(a.endDepth).toBe(2)
    near(a.endCtm[4], 10)
  })

  it('reports the ET that closes each text object', async () => {
    const doc = await page('BT /F1 10 Tf 0 0 Td (a) Tj ET q 2 0 0 2 0 0 cm BT /F1 10 Tf 0 0 Td (b) Tj (c) Tj ET Q')
    const runs = analyzePage(doc, 0).runs
    expect(runs[0].et?.addr.index).toBe(4)
    expect(runs[1].et?.addr.index).toBe(runs[2].et?.addr.index)
    near(runs[1].et!.ctm[0], 2)
  })

  it('missing font resources do not crash: the run is not editable', async () => {
    const doc = await page('BT /Nope 10 Tf 0 0 Td (x) Tj ET')
    const set = buildBlocks(analyzePage(doc, 0))
    expect(set.lines[0].editable).toBe(false)
    expect(set.lines[0].reason).toMatch(/font/i)
  })
})

describe('multiple content streams and form XObjects', () => {
  it('carries state across an array of content streams', async () => {
    const { bytes } = await buildPdf([
      { content: ['q 1 0 0 1 100 100 cm BT /F1 10 Tf 0 0 Td (a) Tj ET', 'BT /F1 10 Tf 5 0 Td (b) Tj ET Q'], fonts: { F1: helvetica } }
    ])
    const a = analyzePage(await load(bytes), 0)
    expect(a.runs.map((r) => r.text)).toEqual(['a', 'b'])
    near(a.runs[1].matrix[4], 105)
    expect(a.runs[1].addr.slot).toBe(1)
    expect(a.sources.get('page')!.slots).toHaveLength(2)
  })

  it('walks into Form XObjects with their own resources and Matrix', async () => {
    const { doc } = await buildPdf([{ content: 'q 1 0 0 1 200 300 cm /Fm1 Do Q', fonts: {} }], () => undefined)
    const formFont = doc.context.register(doc.context.obj(times))
    const form = doc.context.register(
      doc.context.flateStream('BT /T1 12 Tf 0 0 Td (in form) Tj ET', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 100],
        Matrix: [1, 0, 0, 1, 10, 10],
        Resources: { Font: { T1: formFont } }
      } as never)
    )
    const page = doc.getPage(0)
    const res = page.node.Resources()!
    res.set(doc.context.obj('XObject') as never, doc.context.obj({ Fm1: form }))
    const reloaded = await load(await doc.save())
    const a = analyzePage(reloaded, 0)
    expect(a.runs).toHaveLength(1)
    const r = a.runs[0]
    expect(r.text).toBe('in form')
    expect(r.font.displayName).toBe('Times-Roman')
    near(r.matrix[4], 210)
    near(r.matrix[5], 310)
    expect(r.addr.source).toMatch(/^form:/)
    expect(r.shared).toBe(false)
    expect(a.sources.size).toBe(2)
  })

  it('marks a form drawn twice as shared (editing would change both)', async () => {
    const { doc } = await buildPdf([{ content: '/Fm1 Do 1 0 0 1 0 100 cm /Fm1 Do', fonts: {} }])
    const f = doc.context.register(doc.context.obj(helvetica))
    const form = doc.context.register(
      doc.context.flateStream('BT /F 10 Tf 0 0 Td (twice) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], Resources: { Font: { F: f } } } as never)
    )
    doc.getPage(0).node.Resources()!.set(doc.context.obj('XObject') as never, doc.context.obj({ Fm1: form }))
    const a = analyzePage(await load(await doc.save()), 0)
    expect(a.runs.length).toBeGreaterThan(0)
    expect(a.runs.every((r) => r.shared)).toBe(true)
    const set = buildBlocks(a)
    expect(set.lines[0].editable).toBe(false)
    expect(set.lines[0].reason).toMatch(/shared/)
  })

  it('survives a form that draws itself', async () => {
    const { doc } = await buildPdf([{ content: '/Fm1 Do', fonts: {} }])
    const f = doc.context.register(doc.context.obj(helvetica))
    const ref = doc.context.nextRef()
    const form = doc.context.flateStream('BT /F 10 Tf 0 0 Td (loop) Tj ET /Fm1 Do', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 100],
      Resources: { Font: { F: f }, XObject: { Fm1: ref } }
    } as never)
    doc.context.assign(ref, form)
    doc.getPage(0).node.Resources()!.set(doc.context.obj('XObject') as never, doc.context.obj({ Fm1: ref }))
    const a = analyzePage(await load(await doc.save()), 0)
    expect(a.runs.map((r) => r.text)).toEqual(['loop'])
    expect(a.warnings.join(' ')).toMatch(/itself/)
  })
})

describe('images', () => {
  it('reports XObject images and inline images with boxes from the CTM', async () => {
    const { doc } = await buildPdf([
      { content: 'q 100 0 0 50 72 600 cm /Im1 Do Q q 30 0 0 30 10 10 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\x40\x80\xff\nEI Q q 0 40 -40 0 300 300 cm /Im1 Do Q' }
    ])
    const img = doc.context.register(
      doc.context.stream(new Uint8Array(4 * 3), { Type: 'XObject', Subtype: 'Image', Width: 4, Height: 3, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 } as never)
    )
    doc.getPage(0).node.Resources()!.set(doc.context.obj('XObject') as never, doc.context.obj({ Im1: img }))
    const a = analyzePage(await load(await doc.save()), 0)
    expect(a.images).toHaveLength(3)
    const [x, inl, rot] = a.images
    expect(x.kind).toBe('xobject')
    expect(x.name).toBe('Im1')
    expect([x.width, x.height]).toEqual([4, 3])
    expect(x.bbox).toEqual({ x0: 72, y0: 600, x1: 172, y1: 650 })
    expect(inl.kind).toBe('inline')
    expect([inl.width, inl.height]).toEqual([2, 2])
    expect(inl.bbox).toEqual({ x0: 10, y0: 10, x1: 40, y1: 40 })
    // 90° rotation: unit square maps to x in [300-40, 300], y in [300, 340]
    expect(rot.bbox).toEqual({ x0: 260, y0: 300, x1: 300, y1: 340 })
  })
})

describe('encodings and fonts', () => {
  const codes = async (fontLit: Lit | ((doc: PDFDocument) => Lit), content: string) => {
    let lit!: Lit
    const { bytes } = await buildPdf([{ content, fonts: {} }])
    void lit
    void fontLit
    return bytes
  }
  void codes

  it('decodes WinAnsi, /Differences and ToUnicode for simple fonts', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 10 Tf 0 0 Td (caf\\351 \\200 \\001\\002) Tj /F2 10 Tf (AB) Tj ET', fonts: {} }])
    const f1 = subsetSimpleFont(doc, { codes: { 0x63: 'c', 0x61: 'a', 0x66: 'f', 0xe9: 'é', 0x20: ' ', 0x80: '€', 1: 'ﬁ', 2: 'Ω' } })
    const f2 = doc.context.register(
      doc.context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [65, doc.context.obj('Euro'), doc.context.obj('Omega')] }
      } as never)
    )
    doc.getPage(0).node.Resources()!.set(doc.context.obj('Font') as never, doc.context.obj({ F1: f1, F2: f2 }))
    const a = analyzePage(await load(await doc.save()), 0)
    expect(a.runs[0].text).toBe('café € ﬁΩ')
    expect(a.runs[1].text).toBe('€Ω')
  })

  it('decodes Type0 Identity-H fonts through ToUnicode (2-byte codes) and measures with /W', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 10 Tf 0 0 Td <000100020003> Tj ET', fonts: {} }])
    const { type0Font } = await import('./helpers/pdfBuilder')
    const f = type0Font(doc, { glyphs: { 1: 'H', 2: 'i', 3: '!' }, width: 500 })
    doc.getPage(0).node.Resources()!.set(doc.context.obj('Font') as never, doc.context.obj({ F1: f }))
    const a = analyzePage(await load(await doc.save()), 0)
    const r = a.runs[0]
    expect(r.text).toBe('Hi!')
    near(r.advance, 15)
    expect(r.glyphs.map((g) => g.n)).toEqual([2, 2, 2])
    expect(r.font.subtype).toBe('Type0')
  })
})

describe('real generators: pdf-lib with an embedded Unicode font', () => {
  it('reads text set in an embedded subset CID font', async () => {
    const { notoBytes } = await import('./helpers/pdfBuilder')
    const bytes = await pdfLibDoc(async (doc, page) => {
      const font = await doc.embedFont(notoBytes(), { subset: true })
      page.drawText('Привет мир — Ünïcödé', { x: 50, y: 500, size: 18, font })
    })
    const a = analyzePage(await load(bytes), 0)
    expect(a.runs).toHaveLength(1)
    expect(a.runs[0].text).toBe('Привет мир — Ünïcödé')
    expect(a.runs[0].font.subtype).toBe('Type0')
    const set = buildBlocks(a)
    expect(set.lines[0].editable).toBe(true)
  })
})
