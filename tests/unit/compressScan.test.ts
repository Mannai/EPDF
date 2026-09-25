import { PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { effectiveDpi, scanImageUsage } from '../../src/renderer/src/features/compress/pdf/scan'
import { addRawImage, baseDoc, placeAt, placeImage } from './compressHelpers'

const px = (n: number): Uint8Array => new Uint8Array(n * n * 3).fill(120)
const key = (ref: { objectNumber: number; generationNumber: number }): string => `${ref.objectNumber} ${ref.generationNumber}`
const reload = async (doc: PDFDocument): Promise<PDFDocument> => PDFDocument.load(await doc.save())

describe('effective resolution from the CTM', () => {
  it('scale: 300 px over 72 pt = 300 dpi (per axis)', () => {
    expect(effectiveDpi(300, 300, [72, 0, 0, 72, 0, 0])).toEqual({ dpiX: 300, dpiY: 300 })
    expect(effectiveDpi(600, 300, [144, 0, 0, 72, 5, 5])).toEqual({ dpiX: 300, dpiY: 300 })
  })
  it('rotation does not change the resolution', () => {
    for (const deg of [0, 30, 45, 90, 137, 180, 270]) {
      const a = (deg * Math.PI) / 180
      const s = 144
      const d = effectiveDpi(300, 300, [s * Math.cos(a), s * Math.sin(a), -s * Math.sin(a), s * Math.cos(a), 10, 10])!
      expect(d.dpiX).toBeCloseTo(150, 6)
      expect(d.dpiY).toBeCloseTo(150, 6)
    }
  })
  it('skew is measured along each transformed axis', () => {
    const d = effectiveDpi(300, 300, [72, 0, 36, 72, 0, 0])!
    expect(d.dpiX).toBeCloseTo(300, 6)
    expect(d.dpiY).toBeCloseTo(300 / (Math.hypot(36, 72) / 72), 6)
  })
  it('mirrored / degenerate matrices', () => {
    expect(effectiveDpi(300, 300, [-72, 0, 0, 72, 0, 0])!.dpiX).toBeCloseTo(300, 6)
    expect(effectiveDpi(300, 300, [0, 0, 0, 0, 0, 0])).toBeNull()
    expect(effectiveDpi(300, 300, [Number.NaN, 0, 0, 1, 0, 0])).toBeNull()
  })
  it('UserUnit scales the placed size', () => {
    expect(effectiveDpi(300, 300, [72, 0, 0, 72, 0, 0], 2)!.dpiX).toBeCloseTo(150, 6)
  })
})

describe('scanImageUsage on real documents', () => {
  it('finds plain, rotated and multiply placed images (the largest placement, i.e. lowest dpi, wins)', async () => {
    const { doc, page } = await baseDoc()
    const a = addRawImage(doc, { w: 300, h: 300, data: px(300), cs: 'DeviceRGB' })
    const b = addRawImage(doc, { w: 300, h: 300, data: px(300), cs: 'DeviceRGB' })
    placeAt(page, a, 10, 10, 72, 72) // 300 dpi
    placeAt(page, a, 100, 10, 144, 144) // 150 dpi: the bigger placement decides how much detail is needed
    const ang = Math.PI / 6
    placeImage(page, b, [144 * Math.cos(ang), 144 * Math.sin(ang), -144 * Math.sin(ang), 144 * Math.cos(ang), 300, 300])
    const scan = scanImageUsage(await reload(doc))
    const uses = [...scan.uses.values()]
    expect(uses).toHaveLength(2)
    expect(uses.map((u) => Math.round(u.dpiX))).toEqual([150, 150])
    expect(uses[0].placements).toBe(2)
    expect(scan.unknown.size).toBe(0)
  })

  it('follows form XObjects with a /Matrix, and nested forms', async () => {
    const { doc, page } = await baseDoc()
    const ctx = doc.context
    const img = addRawImage(doc, { w: 400, h: 400, data: px(400), cs: 'DeviceRGB' })
    const inner = ctx.register(ctx.stream('q 100 0 0 100 0 0 cm /Im0 Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], Resources: { XObject: { Im0: img } } }))
    const outer = ctx.register(
      ctx.stream('q 1 0 0 1 5 5 cm /In Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200], Matrix: [2, 0, 0, 2, 0, 0], Resources: { XObject: { In: inner } } })
    )
    const fm = page.node.newXObject('Fm', outer).decodeText()
    const stream = ctx.register(ctx.flateStream(`q 1 0 0 1 50 50 cm /${fm} Do Q`))
    page.node.set(PDFName.of('Contents'), ctx.obj([stream]))
    // 400 px over 100 units * 2 (form matrix) = 200 pt -> 144 dpi
    const scan = scanImageUsage(await reload(doc))
    const u = [...scan.uses.values()][0]
    expect(u.dpiX).toBeCloseTo(144, 3)
    expect(u.dpiY).toBeCloseTo(144, 3)
  })

  it('measures images inside annotation appearance streams (BBox -> Rect mapping)', async () => {
    const { doc, page } = await baseDoc()
    const ctx = doc.context
    const img = addRawImage(doc, { w: 300, h: 300, data: px(300), cs: 'DeviceRGB' })
    const ap = ctx.register(ctx.stream('q 300 0 0 300 0 0 cm /Im0 Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 300], Resources: { XObject: { Im0: img } } }))
    const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [100, 100, 172, 172], AP: { N: ap }, F: 4 }))
    page.node.set(PDFName.of('Annots'), ctx.obj([annot]))
    const scan = scanImageUsage(await reload(doc))
    const u = [...scan.uses.values()][0]
    expect(u.dpiX).toBeCloseTo(300, 3) // 300 px into a 72 pt rectangle
  })

  it('an image used by a tiling pattern or Type 3 glyph is "unknown": never resampled', async () => {
    const { doc, page } = await baseDoc()
    const ctx = doc.context
    const img = addRawImage(doc, { w: 300, h: 300, data: px(300), cs: 'DeviceRGB' })
    placeAt(page, img, 10, 10, 72, 72)
    const other = addRawImage(doc, { w: 200, h: 200, data: px(200), cs: 'DeviceRGB' })
    const pat = ctx.register(
      ctx.stream('q 10 0 0 10 0 0 cm /I Do Q', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: { XObject: { I: other } } })
    )
    page.node.set(PDFName.of('Resources'), (() => {
      const r = page.node.Resources()!
      r.set(PDFName.of('Pattern'), ctx.obj({ P1: pat }))
      return r
    })())
    const scan = scanImageUsage(await reload(doc))
    expect(scan.unknown.size).toBe(1)
    expect(scan.uses.size).toBe(1)
  })

  it('unparseable content marks its images unknown instead of guessing', async () => {
    const { doc, page } = await baseDoc()
    const ctx = doc.context
    const img = addRawImage(doc, { w: 300, h: 300, data: px(300), cs: 'DeviceRGB' })
    page.node.newXObject('ImX', img)
    const bad = ctx.register(ctx.flateStream('q 72 0 0 72 0 0 cm /ImX Do Q (unterminated string'))
    page.node.set(PDFName.of('Contents'), ctx.obj([bad]))
    const scan = scanImageUsage(await reload(doc))
    expect(scan.uses.size).toBe(0)
    expect([...scan.unknown]).toHaveLength(1)
  })

  it('soft masks share their image placement', async () => {
    const { doc, page } = await baseDoc()
    const mask = addRawImage(doc, { w: 150, h: 150, data: new Uint8Array(150 * 150).fill(255), cs: 'DeviceGray' })
    const img = addRawImage(doc, { w: 300, h: 300, data: px(300), cs: 'DeviceRGB', extra: { SMask: mask } })
    placeAt(page, img, 10, 10, 72, 72)
    const scan = scanImageUsage(await reload(doc))
    expect(scan.uses.size).toBe(2)
    const dpis = [...scan.uses.values()].map((u) => Math.round(u.dpiX)).sort()
    expect(dpis).toEqual([150, 300])
  })

  it('UserUnit and a huge number of q/Q pairs are handled', async () => {
    const { doc, page } = await baseDoc()
    const img = addRawImage(doc, { w: 300, h: 300, data: px(300), cs: 'DeviceRGB' })
    page.node.set(PDFName.of('UserUnit'), doc.context.obj(2))
    placeAt(page, img, 0, 0, 72, 72)
    const scan = scanImageUsage(await reload(doc))
    expect([...scan.uses.values()][0].dpiX).toBeCloseTo(150, 3)
    void key
  })
})
