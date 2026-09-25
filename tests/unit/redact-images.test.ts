import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pixelSpans, decodeImage } from '../../src/renderer/src/features/redact/logic/imageRedact'
import { DEFAULT_OPTIONS, redactDocument, type MarkInput } from '../../src/renderer/src/features/redact/logic/redact'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { rasterJpeg } from '../fixtures/redact.mjs'

const N = (s: string): PDFName => PDFName.of(s)

interface Spec {
  w: number
  h: number
  dict: Record<string, unknown>
  data: Uint8Array
  /** Extra objects (registered before the image). */
  flate?: boolean
}

/** A one-page document drawing the image at (100,100), 1 pixel = 1 point (w x h points). */
async function imageDoc(spec: Spec, opts: { ctm?: string; second?: boolean; inline?: string } = {}): Promise<{ doc: PDFDocument; bytes: Uint8Array }> {
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const dict = { Type: 'XObject', Subtype: 'Image', Width: spec.w, Height: spec.h, ...spec.dict } as never
  const s = spec.flate ? ctx.flateStream(spec.data, dict) : ctx.stream(spec.data, dict)
  const ref = ctx.register(s)
  const p1 = doc.addPage([300, 300])
  const body = opts.inline ?? `q ${opts.ctm ?? `${spec.w} 0 0 ${spec.h} 100 100 cm`} /Im1 Do Q`
  p1.node.set(N('Contents'), ctx.register(ctx.flateStream(body)))
  p1.node.set(N('Resources'), ctx.obj({ XObject: { Im1: ref } }))
  if (opts.second) {
    const p2 = doc.addPage([300, 300])
    p2.node.set(N('Contents'), ctx.register(ctx.flateStream(`q ${spec.w} 0 0 ${spec.h} 100 100 cm /Im1 Do Q`)))
    p2.node.set(N('Resources'), ctx.obj({ XObject: { Im1: ref } }))
  }
  return { doc, bytes: await doc.save() }
}

/** Marks the left half of the image (x 100..100+w/2), full height. */
const leftHalf = (w: number, h: number): MarkInput => ({ id: 'm', pageIndex: 0, rects: [{ x0: 100, y0: 100, x1: 100 + w / 2, y1: 100 + h }] })

async function run(bytes: Uint8Array, marks: MarkInput[]): Promise<{ out: PDFDocument; outBytes: Uint8Array; report: ReturnType<typeof redactDocument>['report']; findings: unknown[] }> {
  const pdf = await PDFDocument.load(bytes)
  const res = redactDocument(pdf, marks, DEFAULT_OPTIONS)
  const outBytes = await pdf.save()
  const findings = await verifyRedaction({ bytes: outBytes, marksByPage: res.marksByPage, secrets: res.secrets })
  return { out: await PDFDocument.load(outBytes), outBytes, report: res.report, findings }
}

/** The images of a page after redaction. */
function imagesOf(pdf: PDFDocument, page = 0): PDFStream[] {
  const xo = pdf.getPage(page).node.Resources()!.lookup(N('XObject')) as PDFDict
  const out: PDFStream[] = []
  for (const [k] of xo.entries()) {
    const s = xo.lookup(k)
    if (s instanceof PDFStream) out.push(s)
  }
  return out
}

const rawData = (s: PDFStream): Uint8Array => decodePDFRawStream(s as PDFRawStream).decode()

function gradient(w: number, h: number, n: number, bits = 8): Uint8Array {
  const rowBytes = Math.ceil((w * n * bits) / 8)
  const d = new Uint8Array(rowBytes * h)
  for (let i = 0; i < d.length; i++) d[i] = 40 + ((i * 37) % 200)
  return d
}

describe('pixelSpans', () => {
  it('maps a mark to the covered pixel columns for upright, flipped and rotated placements', () => {
    // 100x50 px drawn 100x50 pt at (10,20); mark covers x 10..60
    const s = pixelSpans(100, 50, [100, 0, 0, 50, 10, 20], [{ x0: 10, y0: 20, x1: 60, y1: 70 }])!
    expect(s).toHaveLength(50)
    expect(s.every((x) => x.x0 === 0 && x.x1 === 50)).toBe(true)
    // a mark over the top-left quarter in user space is the top rows of the image (image row 0 is the top)
    const t = pixelSpans(100, 50, [100, 0, 0, 50, 10, 20], [{ x0: 10, y0: 45, x1: 60, y1: 70 }])!
    expect(t.map((x) => x.y)).toEqual(Array.from({ length: 25 }, (_, i) => i))
    // upside-down placement (negative d): the image's top row is at the bottom, so the upper part is the last rows
    const f = pixelSpans(100, 50, [100, 0, 0, -50, 10, 70], [{ x0: 10, y0: 45, x1: 60, y1: 70 }])!
    expect(f.map((x) => x.y)).toEqual(Array.from({ length: 25 }, (_, i) => 25 + i))
    // rotated 90 degrees: the image's left half is at the bottom
    const r = pixelSpans(100, 50, [0, 100, -50, 0, 60, 20], [{ x0: 10, y0: 20, x1: 60, y1: 70 }])!
    expect(r.length).toBeGreaterThan(0)
    expect(pixelSpans(10, 10, [0, 0, 0, 0, 0, 0], [{ x0: 0, y0: 0, x1: 1, y1: 1 }])).toBeNull()
  })
})

describe('image pixel destruction for every colour space and filter', () => {
  const cases: { name: string; spec: Spec; black: number[] }[] = [
    { name: 'DeviceGray 8-bit', spec: { w: 40, h: 20, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 8 }, data: gradient(40, 20, 1) }, black: [0] },
    { name: 'DeviceGray 1-bit', spec: { w: 40, h: 20, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 1 }, data: new Uint8Array(5 * 20).fill(0xff) }, black: [0] },
    { name: 'DeviceGray 2-bit', spec: { w: 40, h: 20, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 2 }, data: gradient(40, 20, 1, 2) }, black: [0] },
    { name: 'DeviceGray 4-bit', spec: { w: 41, h: 20, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 4 }, data: gradient(41, 20, 1, 4) }, black: [0] },
    { name: 'DeviceGray 16-bit', spec: { w: 40, h: 20, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 16 }, data: gradient(40, 20, 1, 16) }, black: [0] },
    { name: 'DeviceRGB 8-bit (Flate)', spec: { w: 40, h: 20, dict: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }, data: gradient(40, 20, 3), flate: true }, black: [0, 0, 0] },
    { name: 'DeviceRGB 4-bit', spec: { w: 40, h: 20, dict: { ColorSpace: 'DeviceRGB', BitsPerComponent: 4 }, data: gradient(40, 20, 3, 4) }, black: [0, 0, 0] },
    { name: 'DeviceCMYK 8-bit', spec: { w: 40, h: 20, dict: { ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 }, data: gradient(40, 20, 4) }, black: [0, 0, 0, 255] },
    { name: 'CalRGB', spec: { w: 40, h: 20, dict: { ColorSpace: [N('CalRGB'), { WhitePoint: [0.95, 1, 1.09] }], BitsPerComponent: 8 }, data: gradient(40, 20, 3) }, black: [0, 0, 0] }
  ]
  for (const c of cases) {
    it(c.name, async () => {
      const { bytes } = await imageDoc(c.spec)
      const r = await run(bytes, [leftHalf(c.spec.w, c.spec.h)])
      expect(r.findings).toEqual([])
      expect(r.report.images).toBe(1)
      expect(r.report.imagesRemoved).toBe(0)
      const img = decodeImage(r.out, imagesOf(r.out)[0])!
      const n = img.components
      const orig = decodeImage(await PDFDocument.load(bytes), imagesOf(await PDFDocument.load(bytes))[0])!
      for (let y = 0; y < c.spec.h; y++) {
        for (let x = 0; x < c.spec.w; x++) {
          const got = Array.from({ length: n }, (_, k) => img.data[(y * c.spec.w + x) * n + k])
          if (x < c.spec.w / 2 - 1) expect(got, `pixel ${x},${y}`).toEqual(c.black)
          else if (x > c.spec.w / 2 + 1) expect(got, `pixel ${x},${y}`).toEqual(Array.from({ length: n }, (_, k) => orig.data[(y * c.spec.w + x) * n + k]))
        }
      }
    })
  }

  it('honours a Decode array (inverted gray: black is the maximum sample)', async () => {
    const spec: Spec = { w: 40, h: 20, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 8, Decode: [1, 0] }, data: gradient(40, 20, 1) }
    const { bytes } = await imageDoc(spec)
    const r = await run(bytes, [leftHalf(40, 20)])
    const d = rawData(imagesOf(r.out)[0])
    expect(d[5]).toBe(255)
    expect(d[35]).not.toBe(255)
  })

  it('indexed: uses the palette entry that is black, adds one when missing, or expands when the palette is full', async () => {
    const pal = (colors: number[][]): PDFHexString => PDFHexString.of(colors.flat().map((b) => b.toString(16).padStart(2, '0')).join(''))
    // 1. palette with black
    let spec: Spec = { w: 40, h: 20, dict: { ColorSpace: [N('Indexed'), N('DeviceRGB'), 2, pal([[255, 0, 0], [0, 0, 0], [0, 255, 0]])], BitsPerComponent: 8 }, data: new Uint8Array(40 * 20).map((_, i) => i % 3) }
    let r = await run((await imageDoc(spec)).bytes, [leftHalf(40, 20)])
    expect(r.findings).toEqual([])
    expect(rawData(imagesOf(r.out)[0])[0]).toBe(1)
    // 2. no black entry: one is appended
    spec = { w: 40, h: 20, dict: { ColorSpace: [N('Indexed'), N('DeviceRGB'), 1, pal([[255, 0, 0], [0, 255, 0]])], BitsPerComponent: 8 }, data: new Uint8Array(40 * 20).map((_, i) => i % 2) }
    r = await run((await imageDoc(spec)).bytes, [leftHalf(40, 20)])
    expect(r.findings).toEqual([])
    const img = decodeImage(r.out, imagesOf(r.out)[0])!
    expect(Array.from(img.data.subarray(0, 3))).toEqual([0, 0, 0])
    expect(Array.from(img.data.subarray(30 * 3, 30 * 3 + 3))).not.toEqual([0, 0, 0])
    // 3. full 256-entry palette without black: expanded to RGB
    const full = Array.from({ length: 256 }, (_, i) => [i, 255 - i, 128].map((v) => Math.max(1, v)))
    spec = { w: 40, h: 20, dict: { ColorSpace: [N('Indexed'), N('DeviceRGB'), 255, pal(full)], BitsPerComponent: 8 }, data: new Uint8Array(40 * 20).map((_, i) => i % 256) }
    r = await run((await imageDoc(spec)).bytes, [leftHalf(40, 20)])
    expect(r.findings).toEqual([])
    const ex = decodeImage(r.out, imagesOf(r.out)[0])!
    expect(ex.components).toBe(3)
    expect(Array.from(ex.data.subarray(0, 3))).toEqual([0, 0, 0])
    expect(Array.from(ex.data.subarray(30 * 3, 30 * 3 + 3))).toEqual([30, 225, 128])
  })

  it('clears soft masks and stencil masks in the same region', async () => {
    const doc = await PDFDocument.create()
    const ctx = doc.context
    const smask = ctx.register(ctx.stream(new Uint8Array(40 * 20).fill(17), { Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 8 } as never))
    const mask = ctx.register(ctx.stream(new Uint8Array(5 * 20).fill(0xff), { Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ImageMask: true, BitsPerComponent: 1 } as never))
    const img = ctx.register(ctx.stream(gradient(40, 20, 3), { Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: smask } as never))
    const img2 = ctx.register(ctx.stream(gradient(40, 20, 3), { Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Mask: mask } as never))
    const p = doc.addPage([300, 300])
    p.node.set(N('Contents'), ctx.register(ctx.flateStream('q 40 0 0 20 100 100 cm /Im1 Do Q q 40 0 0 20 100 200 cm /Im2 Do Q')))
    p.node.set(N('Resources'), ctx.obj({ XObject: { Im1: img, Im2: img2 } }))
    const bytes = await doc.save()
    const r = await run(bytes, [{ id: 'm', pageIndex: 0, rects: [{ x0: 100, y0: 100, x1: 120, y1: 220 }] }])
    expect(r.findings).toEqual([])
    const [a, b] = imagesOf(r.out)
    const sm = (a.dict.lookup(N('SMask')) as PDFStream)
    expect(rawData(sm)[0]).toBe(255) // fully opaque where cleared
    expect(rawData(sm)[30]).toBe(17)
    expect(rawData(a)[0]).toBe(0)
    const mk = b.dict.lookup(N('Mask')) as PDFStream
    expect(rawData(mk)[0]).toBe(0) // 0 = painted in a stencil mask (default Decode)
    expect(rawData(mk)[4]).toBe(0xff)
  })

  it('an ImageMask (stencil) is set to painted under the mark', async () => {
    const spec: Spec = { w: 40, h: 20, dict: { ImageMask: true, BitsPerComponent: 1 }, data: new Uint8Array(5 * 20).fill(0xff) }
    const r = await run((await imageDoc(spec)).bytes, [leftHalf(40, 20)])
    const d = rawData(imagesOf(r.out)[0])
    expect(d[0]).toBe(0)
    expect(d[4]).toBe(0xff)
  })

  it('a JPEG: decoded, blacked out, re-encoded as JPEG; the rest stays close to the original', async () => {
    const jpg = rasterJpeg()
    const spec: Spec = { w: 200, h: 40, dict: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }, data: jpg }
    const { bytes } = await imageDoc(spec)
    const r = await run(bytes, [leftHalf(200, 40)])
    expect(r.findings).toEqual([])
    const s = imagesOf(r.out)[0]
    expect(String(s.dict.lookup(N('Filter')))).toBe('/DCTDecode')
    const img = decodeImage(r.out, s)!
    const orig = decodeImage(await PDFDocument.load(bytes), imagesOf(await PDFDocument.load(bytes))[0])!
    let maxIn = 0
    let maxDiff = 0
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 200; x++) {
        for (let c = 0; c < 3; c++) {
          const v = img.data[(y * 200 + x) * 3 + c]
          if (x < 96) maxIn = Math.max(maxIn, v)
          if (x > 108) maxDiff = Math.max(maxDiff, Math.abs(v - orig.data[(y * 200 + x) * 3 + c]))
        }
      }
    }
    expect(maxIn).toBeLessThanOrEqual(6)
    expect(maxDiff).toBeLessThanOrEqual(12)
  })

  it('a placement rotated by 90 degrees hits the right pixels', async () => {
    const spec: Spec = { w: 40, h: 20, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 8 }, data: gradient(40, 20, 1) }
    // rotated: the image's x axis points up; it occupies x 100..120 (20 wide), y 100..140 (40 tall)
    const { bytes } = await imageDoc(spec, { ctm: '0 40 -20 0 120 100 cm' })
    const marks: MarkInput[] = [{ id: 'm', pageIndex: 0, rects: [{ x0: 100, y0: 100, x1: 120, y1: 120 }] }]
    const r = await run(bytes, marks)
    expect(r.findings).toEqual([])
    const d = rawData(imagesOf(r.out)[0])
    // image x 0..19 (bottom half in user space) is black in every row; x >= 21 untouched
    for (let y = 0; y < 20; y++) {
      expect(d[y * 40 + 5]).toBe(0)
      expect(d[y * 40 + 30]).not.toBe(0)
    }
  })

  it('copies before modifying: another page using the same image keeps its pixels', async () => {
    const spec: Spec = { w: 40, h: 20, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 8 }, data: gradient(40, 20, 1) }
    const { bytes } = await imageDoc(spec, { second: true })
    const r = await run(bytes, [leftHalf(40, 20)])
    expect(r.findings).toEqual([])
    const p1 = rawData(imagesOf(r.out, 0)[0])
    const p2 = rawData(imagesOf(r.out, 1)[0])
    expect(p1[3]).toBe(0)
    expect(p2[3]).toBe(gradient(40, 20, 1)[3])
    expect(Array.from(p2)).toEqual(Array.from(gradient(40, 20, 1)))
  })
})

describe('inline images', () => {
  it('an inline image under a mark becomes a redacted image object', async () => {
    const w = 8
    const h = 8
    const data = Array.from(gradient(w, h, 3)).map((b) => b.toString(16).padStart(2, '0')).join('')
    const body = `q ${w * 5} 0 0 ${h * 5} 100 100 cm BI /W ${w} /H ${h} /CS /RGB /BPC 8 /F /AHx ID ${data}> EI Q`
    const { doc } = await imageDoc({ w, h, dict: {}, data: new Uint8Array(1) }, { inline: body })
    doc.getPage(0).node.set(N('Resources'), doc.context.obj({}))
    const bytes = await doc.save()
    const r = await run(bytes, [{ id: 'm', pageIndex: 0, rects: [{ x0: 100, y0: 100, x1: 120, y1: 140 }] }])
    expect(r.findings).toEqual([])
    expect(r.report.images).toBe(1)
    const s = imagesOf(r.out)[0]
    const d = decodeImage(r.out, s)!
    // 40 pt over 8 px = 5 pt per pixel: the mark covers pixels 0..3
    expect(Array.from(d.data.subarray(0, 3))).toEqual([0, 0, 0])
    expect(d.data[5 * 3]).not.toBe(0)
  })
})

describe('images that cannot be edited are removed and replaced by a box (fail closed)', () => {
  const unsupported: [string, Record<string, unknown>][] = [
    ['JBIG2Decode', { ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'JBIG2Decode' }],
    ['JPXDecode', { Filter: 'JPXDecode' }],
    ['CCITTFaxDecode', { ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'CCITTFaxDecode' }],
    ['Lab colour space', { ColorSpace: [N('Lab'), { WhitePoint: [0.95, 1, 1.09] }], BitsPerComponent: 8 }],
    ['Separation colour space', { ColorSpace: [N('Separation'), N('Spot'), N('DeviceGray'), { FunctionType: 2, Domain: [0, 1], N: 1 }], BitsPerComponent: 8 }]
  ]
  for (const [name, dict] of unsupported) {
    it(name, async () => {
      const { bytes } = await imageDoc({ w: 40, h: 20, dict, data: gradient(40, 20, 1) })
      const r = await run(bytes, [leftHalf(40, 20)])
      expect(r.findings).toEqual([])
      expect(r.report.imagesRemoved).toBe(1)
      expect(r.report.warnings[0]).toMatch(/removed entirely/)
      // no image is left on the page and the file holds no trace of its data
      const res = r.out.getPage(0).node.Resources()!
      const xo = res.lookup(N('XObject'))
      const images = xo instanceof PDFDict ? [...xo.entries()].filter(([k]) => xo.lookup(k) instanceof PDFStream && (xo.lookup(k) as PDFStream).dict.lookup(N('Subtype')) === N('Image')) : []
      expect(images).toHaveLength(0)
    })
  }

  it('a JPEG with a colour space we cannot re-encode (RGB data declared as CMYK)', async () => {
    const { bytes } = await imageDoc({ w: 200, h: 40, dict: { ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'DCTDecode' }, data: rasterJpeg() })
    const r = await run(bytes, [leftHalf(200, 40)])
    expect(r.report.imagesRemoved).toBe(1)
  })

  it('an image that does not touch any mark is left alone', async () => {
    const { bytes } = await imageDoc({ w: 40, h: 20, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 8 }, data: gradient(40, 20, 1) })
    const r = await run(bytes, [{ id: 'm', pageIndex: 0, rects: [{ x0: 10, y0: 10, x1: 50, y1: 50 }] }])
    expect(r.report.images).toBe(0)
    expect(Array.from(rawData(imagesOf(r.out)[0]))).toEqual(Array.from(gradient(40, 20, 1)))
  })
})
