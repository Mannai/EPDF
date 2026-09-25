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

describe('predictors (pdf-lib does not undo them, so we do)', () => {
  const dictOf = async (o: Record<string, number>): Promise<PDFDict> => (await PDFDocument.create()).context.obj(o as never) as PDFDict

  /** PNG-filters `rows` with the given filter type per row (0-4) exactly as an encoder would. */
  function pngEncode(rows: Uint8Array[], types: number[], bpp: number): Uint8Array {
    const out: number[] = []
    rows.forEach((row, y) => {
      const t = types[y % types.length]
      out.push(t)
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0
        const b = y > 0 ? rows[y - 1][i] : 0
        const c = y > 0 && i >= bpp ? rows[y - 1][i - bpp] : 0
        let pred = 0
        if (t === 1) pred = a
        else if (t === 2) pred = b
        else if (t === 3) pred = (a + b) >> 1
        else if (t === 4) {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        out.push((row[i] - pred) & 255)
      }
    })
    return Uint8Array.from(out)
  }

  it('undoes every PNG filter type for 8-bit RGB, 16-bit gray and 1-bit gray', async () => {
    const { undoPredictor } = await import('../../src/renderer/src/features/redact/logic/imageRedact')
    const rows = (w: number, bytesPerPixel: number): Uint8Array[] => Array.from({ length: 7 }, (_, y) => Uint8Array.from({ length: w * bytesPerPixel }, (_, i) => (y * 37 + i * 11 + (i % 5) * 3) & 255))
    for (const [colors, bpc, w] of [[3, 8, 9], [1, 16, 6], [1, 1, 20], [4, 8, 5]] as const) {
      const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
      const rowBytes = Math.ceil((colors * w * bpc) / 8)
      const r = rows(1, rowBytes)
      const enc = pngEncode(r, [0, 1, 2, 3, 4], bpp)
      const dec = undoPredictor(enc, await dictOf({ Predictor: 15, Colors: colors, BitsPerComponent: bpc, Columns: w }))
      expect(Array.from(dec), `${colors}x${bpc}`).toEqual(r.flatMap((x) => Array.from(x)))
    }
  })

  it('undoes the TIFF predictor (8 and 16 bit) and leaves predictor 1 alone; refuses what it cannot', async () => {
    const { undoPredictor } = await import('../../src/renderer/src/features/redact/logic/imageRedact')
    const data = Uint8Array.from([10, 20, 30, 1, 2, 3, 1, 2, 3])
    expect(Array.from(undoPredictor(data, await dictOf({ Predictor: 2, Colors: 3, BitsPerComponent: 8, Columns: 3 })))).toEqual([10, 20, 30, 11, 22, 33, 12, 24, 36])
    expect(undoPredictor(data, await dictOf({ Predictor: 1 }))).toBe(data)
    expect(undoPredictor(data, undefined)).toBe(data)
    const sixteen = Uint8Array.from([0x01, 0x00, 0x00, 0xff, 0x00, 0x02])
    expect(Array.from(undoPredictor(sixteen, await dictOf({ Predictor: 2, Colors: 1, BitsPerComponent: 16, Columns: 3 })))).toEqual([0x01, 0x00, 0x01, 0xff, 0x02, 0x01])
    const tiff4 = await dictOf({ Predictor: 2, Colors: 1, BitsPerComponent: 4, Columns: 3 })
    const unknown = await dictOf({ Predictor: 7 })
    const png = await dictOf({ Predictor: 15, Colors: 1, Columns: 3 })
    expect(() => undoPredictor(data, tiff4)).toThrow()
    expect(() => undoPredictor(data, unknown)).toThrow()
    expect(() => undoPredictor(Uint8Array.from([9, 1, 2, 3]), png)).toThrow(/PNG filter/)
  })

  it('an image whose predictor cannot be undone is removed rather than corrupted (fail closed)', async () => {
    const { bytes } = await imageDoc({ w: 24, h: 12, dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 4, DecodeParms: { Predictor: 2, Colors: 1, Columns: 24, BitsPerComponent: 4 } }, data: new Uint8Array(12 * 12), flate: true })
    const r = await run(bytes, [leftHalf(24, 12)])
    expect(r.report.imagesRemoved).toBe(1)
    expect(r.findings).toEqual([])
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

  describe('every source filter is decoded and re-encoded losslessly', () => {
    const W = 24
    const H = 12
    const rgb = gradient(W, H, 3)
    const checkRgb = async (spec: Spec, note: string): Promise<void> => {
      const { bytes } = await imageDoc(spec)
      const r = await run(bytes, [leftHalf(W, H)])
      expect(r.findings, note).toEqual([])
      expect(r.report.images, note).toBe(1)
      const img = decodeImage(r.out, imagesOf(r.out)[0])!
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const px = Array.from({ length: 3 }, (_, c) => img.data[(y * W + x) * 3 + c])
          if (x < W / 2 - 1) expect(px, `${note} ${x},${y}`).toEqual([0, 0, 0])
          else if (x > W / 2 + 1) expect(px, `${note} ${x},${y}`).toEqual(Array.from({ length: 3 }, (_, c) => rgb[(y * W + x) * 3 + c]))
        }
      }
      expect(imagesOf(r.out)[0].dict.lookup(N('DecodeParms')), note).toBeUndefined() // predictors are gone after re-encoding
    }
    const base = { ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }

    it('ASCIIHexDecode', () => checkRgb({ w: W, h: H, dict: { ...base, Filter: 'ASCIIHexDecode' }, data: new TextEncoder().encode(Array.from(rgb, (b) => b.toString(16).padStart(2, '0')).join('') + '>') }, 'AHx'))

    it('ASCII85Decode', () => {
      const enc = (d: Uint8Array): string => {
        let s = ''
        for (let i = 0; i < d.length; i += 4) {
          const chunk = d.subarray(i, i + 4)
          let v = 0
          for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0)
          if (v === 0 && chunk.length === 4) {
            s += 'z'
            continue
          }
          const digits: string[] = []
          for (let k = 0; k < 5; k++) {
            digits.unshift(String.fromCharCode((v % 85) + 33))
            v = Math.floor(v / 85)
          }
          s += digits.slice(0, chunk.length + 1).join('')
        }
        return s + '~>'
      }
      return checkRgb({ w: W, h: H, dict: { ...base, Filter: 'ASCII85Decode' }, data: new TextEncoder().encode(enc(rgb)) }, 'A85')
    })

    it('RunLengthDecode', () => {
      const out: number[] = []
      for (let i = 0; i < rgb.length; i += 100) {
        const chunk = rgb.subarray(i, Math.min(rgb.length, i + 100))
        out.push(chunk.length - 1, ...chunk)
      }
      out.push(128)
      return checkRgb({ w: W, h: H, dict: { ...base, Filter: 'RunLengthDecode' }, data: Uint8Array.from(out) }, 'RL')
    })

    it('LZWDecode', () => {
      // a plain LZW encoder (9-12 bit codes, EarlyChange 1)
      const codes: number[] = []
      const widths: number[] = []
      let dict = new Map<string, number>()
      let next = 258
      let width = 9
      const reset = (): void => {
        dict = new Map()
        next = 258
        width = 9
      }
      const emit = (c: number): void => {
        codes.push(c)
        widths.push(width)
      }
      emit(256)
      let w = ''
      for (const b of rgb) {
        const wc = w + String.fromCharCode(b)
        if (wc.length === 1 || dict.has(wc)) w = wc
        else {
          emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!)
          dict.set(wc, next++)
          if (next + 1 > 1 << width && width < 12) width++
          if (next >= 4093) {
            emit(256)
            reset()
          }
          w = String.fromCharCode(b)
        }
      }
      if (w) emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!)
      emit(257)
      let bits = ''
      codes.forEach((c, i) => (bits += c.toString(2).padStart(widths[i], '0')))
      bits += '0'.repeat((8 - (bits.length % 8)) % 8)
      const bytes = Uint8Array.from(bits.match(/.{8}/g)!.map((x) => parseInt(x, 2)))
      return checkRgb({ w: W, h: H, dict: { ...base, Filter: 'LZWDecode' }, data: bytes }, 'LZW')
    })

    it('Flate with a PNG "Up" predictor and with a TIFF predictor', async () => {
      const rows = Array.from({ length: H }, (_, y) => rgb.subarray(y * W * 3, (y + 1) * W * 3))
      const up = new Uint8Array((W * 3 + 1) * H)
      rows.forEach((row, y) => {
        up[y * (W * 3 + 1)] = 2
        for (let i = 0; i < row.length; i++) up[y * (W * 3 + 1) + 1 + i] = (row[i] - (y ? rows[y - 1][i] : 0)) & 255
      })
      await checkRgb({ w: W, h: H, dict: { ...base, DecodeParms: { Predictor: 12, Colors: 3, Columns: W, BitsPerComponent: 8 } }, data: up, flate: true }, 'PNG up')
      const tiff = new Uint8Array(W * 3 * H)
      rows.forEach((row, y) => {
        for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) tiff[y * W * 3 + x * 3 + c] = (row[x * 3 + c] - (x ? row[(x - 1) * 3 + c] : 0)) & 255
      })
      await checkRgb({ w: W, h: H, dict: { ...base, DecodeParms: { Predictor: 2, Colors: 3, Columns: W, BitsPerComponent: 8 } }, data: tiff, flate: true }, 'TIFF')
    })

    it('a filter chain (ASCII85 over Flate)', async () => {
      const { deflateSync } = await import('node:zlib')
      const z = new Uint8Array(deflateSync(Buffer.from(rgb)))
      const enc = (d: Uint8Array): string => {
        let s = ''
        for (let i = 0; i < d.length; i += 4) {
          const chunk = d.subarray(i, i + 4)
          let v = 0
          for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0)
          const digits: string[] = []
          for (let k = 0; k < 5; k++) {
            digits.unshift(String.fromCharCode((v % 85) + 33))
            v = Math.floor(v / 85)
          }
          s += digits.slice(0, chunk.length + 1).join('')
        }
        return s + '~>'
      }
      await checkRgb({ w: W, h: H, dict: { ...base, Filter: [N('ASCII85Decode'), N('FlateDecode')] }, data: new TextEncoder().encode(enc(z)) }, 'A85+Fl')
    })
  })

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
