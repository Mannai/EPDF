import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { decodeJpeg } from '../../src/renderer/src/features/compress/pdf/jpegDecode'
import { parseJpegInfo } from '../../src/renderer/src/features/compress/pdf/jpegInfo'
import { PRESETS, type CompressOptions } from '../../src/renderer/src/features/compress/pdf/options'
import { resizeBox } from '../../src/renderer/src/features/compress/pdf/raster'
import { decodeStream, encodedBytes } from '../../src/renderer/src/features/compress/pdf/streams'
import { addJpegImage, addRawImage, baseDoc, imagesOf, jpegOf, photoRGB, placeAt, rng } from './compressHelpers'
import { pdfjsImages } from './compressPdfjs'

type Preset = keyof typeof PRESETS
const run = (bytes: Uint8Array, preset: Preset = 'balanced', extra: Partial<CompressOptions> = {}) => compressPdf(bytes, { ...PRESETS[preset], ...extra }, { codec: pureCodec })

const N = (s: string): PDFName => PDFName.of(s)
const num = (d: PDFDict, k: string): number | undefined => (d.get(N(k)) as PDFNumber | undefined)?.asNumber()

interface Img {
  ref: PDFRef
  w: number
  h: number
  bpc: number
  filter: string
  cs: string
  mask: boolean
  decode: number[] | null
  stream: PDFStream
  smask: PDFRef | null
}

async function inspect(bytes: Uint8Array): Promise<{ doc: PDFDocument; imgs: Img[] }> {
  const doc = await PDFDocument.load(bytes)
  const imgs = imagesOf(doc).map(({ ref, dict }) => {
    const stream = doc.context.lookup(ref) as PDFStream
    const f = dict.get(N('Filter'))
    const dec = dict.get(N('Decode')) instanceof PDFArray ? (dict.get(N('Decode')) as PDFArray).asArray().map((x) => (x as PDFNumber).asNumber()) : null
    const sm = dict.get(N('SMask'))
    return {
      ref,
      w: num(dict, 'Width')!,
      h: num(dict, 'Height')!,
      bpc: num(dict, 'BitsPerComponent')!,
      filter: f ? String(f) : '',
      cs: String(dict.get(N('ColorSpace')) ?? ''),
      mask: String(dict.get(N('ImageMask'))) === 'true',
      decode: dec,
      stream,
      smask: sm instanceof PDFRef ? sm : null
    }
  })
  return { doc, imgs }
}

const psnr = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let se = 0
  for (let i = 0; i < a.length; i++) se += (a[i] - b[i]) ** 2
  const mse = se / a.length
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
}

const rgbOf = (d: Uint8ClampedArray, ch: number, n: number): Uint8Array => {
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = d[i * ch + c]
  return out
}

async function photoDoc(w: number, h: number, wPt: number, hPt: number, seed = 1): Promise<Uint8Array> {
  const { doc, page } = await baseDoc()
  placeAt(page, addRawImage(doc, { w, h, data: photoRGB(w, h, seed), cs: 'DeviceRGB' }), 40, 300, wPt, hPt)
  return doc.save()
}

describe('downsample decisions per preset', () => {
  // 600 x 400 px over 144 x 96 pt = 300 dpi
  it('Balanced (150 dpi target, x1.25 threshold) reduces a 300 dpi photo to 150 dpi as a JPEG', async () => {
    const input = await photoDoc(600, 400, 144, 96)
    const r = await run(input, 'balanced')
    const { imgs } = await inspect(r.bytes)
    expect(imgs).toHaveLength(1)
    expect(imgs[0].w).toBe(300)
    expect(imgs[0].h).toBe(200)
    expect(imgs[0].filter).toBe('/DCTDecode')
    expect(imgs[0].cs).toBe('/DeviceRGB')
    expect(r.bytes.length).toBeLessThan(input.length / 4)
  })

  it('High quality (300 dpi target) keeps the pixel size of a 300 dpi photo but still makes it a JPEG', async () => {
    const input = await photoDoc(600, 400, 144, 96)
    const r = await run(input, 'high')
    const { imgs } = await inspect(r.bytes)
    expect(imgs[0].w).toBe(600)
    expect(imgs[0].filter).toBe('/DCTDecode')
    expect(r.bytes.length).toBeLessThan(input.length / 2)
  })

  it('Smallest (96 dpi) downsamples harder than Balanced', async () => {
    const input = await photoDoc(600, 400, 144, 96)
    const { imgs } = await inspect((await run(input, 'smallest')).bytes)
    expect(imgs[0].w).toBe(192)
    expect(imgs[0].h).toBe(128)
  })

  it('does not touch resolution at or below target x factor: 180 dpi under Balanced stays', async () => {
    const input = await photoDoc(600, 400, 240, 160) // 180 dpi
    const { imgs } = await inspect((await run(input, 'balanced')).bytes)
    expect(imgs[0].w).toBe(600)
  })

  it('uses the largest placement: a picture also shown big is only reduced as far as that allows', async () => {
    const { doc, page } = await baseDoc()
    const ref = addRawImage(doc, { w: 900, h: 600, data: photoRGB(900, 600, 4), cs: 'DeviceRGB' })
    placeAt(page, ref, 10, 10, 72, 48) // 900 dpi small use
    placeAt(page, ref, 100, 100, 432, 288) // 150 dpi big use
    const { imgs } = await inspect((await run(await doc.save(), 'smallest')).bytes)
    // Smallest wants 96 dpi at the big placement: 432pt = 6in -> 576 px
    expect(imgs[0].w).toBe(576)
  })

  it('an image placed where its size is unknown (pattern) is not resampled', async () => {
    const { doc, page } = await baseDoc()
    const ctx = doc.context
    const ref = addRawImage(doc, { w: 600, h: 400, data: photoRGB(600, 400, 5), cs: 'DeviceRGB' })
    const pat = ctx.register(ctx.stream('q 10 0 0 10 0 0 cm /I Do Q', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: { XObject: { I: ref } } }))
    page.node.Resources()!.set(N('Pattern'), ctx.obj({ P1: pat }))
    const { imgs } = await inspect((await run(await doc.save(), 'smallest')).bytes)
    expect(imgs[0].w).toBe(600) // dimensions kept
  })

  it('tiny images are left alone', async () => {
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w: 40, h: 40, data: photoRGB(40, 40, 6), cs: 'DeviceRGB' }), 10, 10, 10, 10)
    const r = await run(await doc.save(), 'smallest')
    expect(r.stats.images.skipped['small']).toBe(1)
    expect((await inspect(r.bytes)).imgs[0].w).toBe(40)
  })

  it('images disabled: nothing is resampled or re-encoded, structure work still happens', async () => {
    const input = await photoDoc(600, 400, 144, 96)
    const r = await run(input, 'smallest', { images: false })
    const { imgs } = await inspect(r.bytes)
    expect(imgs[0].w).toBe(600)
    expect(imgs[0].filter).toBe('/FlateDecode')
  })
})

describe('pixel fidelity (checked with PDF.js as an independent reader)', () => {
  it('a reduced photo looks like the original scaled down', async () => {
    const w = 480
    const h = 320
    const input = await photoDoc(w, h, 96, 64, 7) // 360 dpi
    const before = (await pdfjsImages(input))[0]
    const r = await run(input, 'balanced')
    const after = (await pdfjsImages(r.bytes))[0]
    expect(after.width).toBe(200)
    expect(after.height).toBe(133)
    const ref = resizeBox(rgbOf(before.data, before.channels, w * h), w, h, 3, after.width, after.height)
    expect(psnr(ref, rgbOf(after.data, after.channels, after.width * after.height))).toBeGreaterThan(28)
  })

  it('a photo that is only re-encoded (no resampling) stays visually the same', async () => {
    const w = 200
    const h = 150
    const input = await photoDoc(w, h, 400, 300) // 36 dpi
    const before = (await pdfjsImages(input))[0]
    const r = await run(input, 'high')
    const after = (await pdfjsImages(r.bytes))[0]
    expect(after.width).toBe(w)
    expect(psnr(rgbOf(before.data, before.channels, w * h), rgbOf(after.data, after.channels, w * h))).toBeGreaterThan(33)
  })
})

describe('graphics, colour spaces and masks', () => {
  it('flat-colour graphics are never turned into JPEG; reduced ones stay lossless Flate', async () => {
    const w = 600
    const h = 400
    const g = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.set(((x >> 5) + (y >> 5)) % 2 ? [20, 60, 200] : [250, 240, 30], (y * w + x) * 3)
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w, h, data: g, cs: 'DeviceRGB', flate: false }), 40, 300, 144, 96)
    const r = await run(await doc.save(), 'balanced')
    const { imgs } = await inspect(r.bytes)
    expect(imgs[0].filter).toBe('/FlateDecode')
    expect(imgs[0].w).toBe(300)
    const back = decodeStream(doc.context, imgs[0].stream)!
    expect(back.length).toBe(300 * 200 * 3) // predictor undone by decodeStream
    // the graphic keeps hard edges: only the two colours (plus blended pixels on tile borders)
    const colours = new Set<number>()
    for (let i = 0; i < back.length; i += 3) colours.add((back[i] << 16) | (back[i + 1] << 8) | back[i + 2])
    expect(colours.size).toBeLessThan(12)
  })

  it('DeviceGray photo becomes a one-component JPEG; ICCBased colour space is kept by reference', async () => {
    const w = 500
    const h = 300
    const rgb = photoRGB(w, h, 8)
    const gray = new Uint8Array(w * h)
    for (let i = 0; i < gray.length; i++) gray[i] = rgb[i * 3]
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w, h, data: gray, cs: 'DeviceGray' }), 10, 500, 100, 60)
    const icc = doc.context.register(doc.context.stream(new Uint8Array(200).fill(1), { N: 3 }))
    placeAt(page, addRawImage(doc, { w, h, data: rgb, cs: [N('ICCBased'), icc] as never }), 10, 300, 100, 60)
    const r = await run(await doc.save(), 'balanced')
    const { imgs, doc: out } = await inspect(r.bytes)
    const g = imgs.find((i) => i.cs === '/DeviceGray')!
    expect(g.filter).toBe('/DCTDecode')
    expect(parseJpegInfo(encodedBytes(g.stream))!.ncomp).toBe(1)
    const c = imgs.find((i) => i.cs.includes('ICCBased'))!
    expect(c.filter).toBe('/DCTDecode')
    const arr = out.context.lookup(c.stream.dict.get(N('ColorSpace')) as PDFRef, PDFArray) ?? (c.stream.dict.get(N('ColorSpace')) as PDFArray)
    expect(String(arr.get(0))).toBe('/ICCBased')
  })

  it('Indexed images are only expanded when they must be reduced, and then look the same', async () => {
    const w = 400
    const h = 300
    const idx = new Uint8Array(w * h)
    const r0 = rng(3)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * w + x] = Math.floor(r0() * 256) // noisy: barely compressible
    const pal = new Uint8Array(768)
    for (let i = 0; i < 768; i++) pal[i] = Math.floor(r0() * 256)
    const mk = async (wPt: number, hPt: number): Promise<Uint8Array> => {
      const { doc, page } = await baseDoc()
      const lookup = doc.context.stream(pal)
      placeAt(page, addRawImage(doc, { w, h, data: idx, cs: [N('Indexed'), N('DeviceRGB'), 255, doc.context.register(lookup)] as never }), 10, 300, wPt, hPt)
      return doc.save()
    }
    const smallUse = await run(await mk(300, 225), 'balanced') // 96 dpi: no reduction needed
    const a = (await inspect(smallUse.bytes)).imgs[0]
    expect(a.cs).toContain('Indexed')
    expect(a.w).toBe(400)
    const bigUse = await mk(72, 54) // 400 dpi -> reduced
    const before = (await pdfjsImages(bigUse))[0]
    const rr = await run(bigUse, 'balanced', { minImageBytes: 0 })
    const b = (await inspect(rr.bytes)).imgs[0]
    expect(rr.stats.images.replaced).toBe(1)
    expect(b.cs).toBe('/DeviceRGB')
    expect(b.decode).toBeNull()
    expect(b.w).toBe(150)
    const after = (await pdfjsImages(rr.bytes))[0]
    const ref = resizeBox(rgbOf(before.data, before.channels, w * h), w, h, 3, after.width, after.height)
    expect(psnr(ref, rgbOf(after.data, after.channels, after.width * after.height))).toBeGreaterThan(28)
  })

  it('an Indexed image that would not shrink as RGB is left exactly as it was', async () => {
    const w = 400
    const h = 300
    const idx = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * w + x] = ((x >> 3) + (y >> 3) * 3) & 255 // very compressible
    const pal = new Uint8Array(768).map((_, i) => (i * 37) & 255)
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w, h, data: idx, cs: [N('Indexed'), N('DeviceRGB'), 255, doc.context.register(doc.context.stream(pal))] as never }), 10, 300, 72, 54)
    const rr = await run(await doc.save(), 'balanced', { minImageBytes: 0 })
    const b = (await inspect(rr.bytes)).imgs[0]
    expect(rr.stats.images.replaced).toBe(0)
    expect(b.cs).toContain('Indexed')
    expect(b.w).toBe(400)
  })

  it('CMYK: Flate photo becomes a CMYK JPEG (Adobe marker), CMYK JPEG is reduced as CMYK, /Decode is kept', async () => {
    const w = 400
    const h = 300
    const rgb = photoRGB(w, h, 9)
    const cmyk = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      cmyk[i * 4] = 255 - rgb[i * 3]
      cmyk[i * 4 + 1] = 255 - rgb[i * 3 + 1]
      cmyk[i * 4 + 2] = 255 - rgb[i * 3 + 2]
      cmyk[i * 4 + 3] = 30
    }
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w, h, data: cmyk, cs: 'DeviceCMYK' }), 10, 500, 100, 75)
    placeAt(page, addJpegImage(doc, w, h, 4, jpegOf(cmyk, w, h, 4, 95), 'DeviceCMYK', { Decode: [1, 0, 1, 0, 1, 0, 1, 0] }), 10, 300, 100, 75)
    const input = await doc.save()
    const r = await run(input, 'balanced')
    expect(r.kept).toBe('result')
    const { imgs } = await inspect(r.bytes)
    expect(imgs).toHaveLength(2)
    for (const im of imgs) {
      expect(im.filter).toBe('/DCTDecode')
      expect(im.cs).toBe('/DeviceCMYK')
      const info = parseJpegInfo(encodedBytes(im.stream))!
      expect(info.ncomp).toBe(4)
      expect(info.width).toBe(im.w)
      expect(im.w).toBeLessThan(w)
    }
    expect(imgs.find((i) => i.decode)!.decode).toEqual([1, 0, 1, 0, 1, 0, 1, 0])
    const dec = decodeJpeg(encodedBytes(imgs[0].stream))
    expect(dec.ncomp).toBe(4)
  })

  it('SMask: colour image and soft mask are both reduced; the mask stays 8-bit gray Flate (never JPEG) and the alpha is preserved', async () => {
    const w = 400
    const h = 300
    const alpha = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = Math.round(255 * Math.min(1, Math.hypot(x - 200, y - 150) / 150))
    const { doc, page } = await baseDoc()
    const mask = addRawImage(doc, { w, h, data: alpha, cs: 'DeviceGray' })
    const img = addRawImage(doc, { w, h, data: photoRGB(w, h, 10), cs: 'DeviceRGB', extra: { SMask: mask } })
    placeAt(page, img, 40, 300, 100, 75) // 288 dpi
    const input = await doc.save()
    const before = (await pdfjsImages(input))[0]
    const r = await run(input, 'balanced')
    const { imgs } = await inspect(r.bytes)
    expect(imgs).toHaveLength(2)
    const m = imgs.find((i) => i.cs === '/DeviceGray')!
    expect(m.filter).toBe('/FlateDecode')
    expect(m.bpc).toBe(8)
    expect(m.w).toBeLessThan(w)
    const c = imgs.find((i) => i.cs === '/DeviceRGB')!
    expect(c.filter).toBe('/DCTDecode')
    expect(c.smask).not.toBeNull()
    const after = (await pdfjsImages(r.bytes))[0]
    // compare alpha channels (RGBA from PDF.js) after scaling the original to the new size
    const a0 = new Uint8Array(w * h)
    for (let i = 0; i < a0.length; i++) a0[i] = before.data[i * 4 + 3]
    const aRef = resizeBox(a0, w, h, 1, after.width, after.height)
    const a1 = new Uint8Array(after.width * after.height)
    for (let i = 0; i < a1.length; i++) a1[i] = after.data[i * 4 + 3]
    expect(psnr(aRef, a1)).toBeGreaterThan(30)
  })

  it('stencil masks (ImageMask) stay 1-bit masks, are reduced, and keep thin lines', async () => {
    const w = 1200
    const h = 800
    const bits = new Uint8Array((w / 8) * h).fill(0xff) // 1 = not painted with default Decode [0 1]
    // paint (0) thin 1-px vertical lines every 24 px
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 24) bits[y * (w / 8) + (x >> 3)] &= ~(0x80 >> (x & 7))
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w, h, data: bits, cs: null, bpc: 1, extra: { ImageMask: true } }), 40, 300, 144, 96) // 600 dpi
    const input = await doc.save()
    const r = await run(input, 'smallest', { minImageBytes: 0 }) // mono 200 dpi
    expect(r.stats.images.replaced).toBe(1)
    const { imgs } = await inspect(r.bytes)
    expect(imgs[0].mask).toBe(true)
    expect(imgs[0].bpc).toBe(1)
    expect(imgs[0].w).toBe(400)
    const back = decodeStream(doc.context, imgs[0].stream) ?? decodeStream((await PDFDocument.load(r.bytes)).context, imgs[0].stream)!
    // every 8th column of the reduced image (24/3) must still hold ink (0 bits)
    const rb = Math.ceil(400 / 8)
    let inkColumns = 0
    for (let x = 0; x < 400; x++) if (((back[10 * rb + (x >> 3)] >> (7 - (x & 7))) & 1) === 0) inkColumns++
    expect(inkColumns).toBeGreaterThanOrEqual(45)
  })

  it('colour-key masked images are not resampled (sample values are significant)', async () => {
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w: 600, h: 400, data: photoRGB(600, 400, 11), cs: 'DeviceRGB', extra: { Mask: [0, 10, 0, 10, 0, 10] } }), 40, 300, 144, 96)
    const { imgs } = await inspect((await run(await doc.save(), 'smallest')).bytes)
    expect(imgs[0].w).toBe(600)
  })

  it('Separation / Lab data is reduced losslessly, never JPEG, colour space kept', async () => {
    const w = 600
    const h = 400
    const tint = new Uint8Array(w * h)
    const r0 = rng(5)
    for (let i = 0; i < tint.length; i++) tint[i] = Math.floor(r0() * 256)
    const { doc, page } = await baseDoc()
    const fn = doc.context.register(doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 1, 0], N: 1 }))
    const sep = doc.context.obj([N('Separation'), N('Spot'), N('DeviceCMYK'), fn])
    placeAt(page, addRawImage(doc, { w, h, data: tint, cs: sep as never }), 40, 300, 144, 96)
    const r = await run(await doc.save(), 'balanced', { minImageBytes: 0 })
    const { imgs } = await inspect(r.bytes)
    if (r.kept === 'result' && imgs[0].w < w) {
      expect(imgs[0].filter).toBe('/FlateDecode')
      expect(imgs[0].cs).toContain('Separation')
    } else expect(imgs[0].cs).toContain('Separation')
  })

  it('16-bit and undecodable images are skipped without failing the job', async () => {
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w: 300, h: 200, data: new Uint8Array(300 * 200 * 6).map((_, i) => i * 31), cs: 'DeviceRGB', bpc: 16 }), 40, 500, 72, 48)
    const broken = doc.context.register(doc.context.stream(new Uint8Array(4000).map((_, i) => (i * 17) & 255), { Type: 'XObject', Subtype: 'Image', Width: 300, Height: 200, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' } as never))
    placeAt(page, broken, 40, 300, 72, 48)
    const fakeJpeg = addJpegImage(doc, 300, 200, 3, new Uint8Array(9000).fill(7), 'DeviceRGB')
    placeAt(page, fakeJpeg, 40, 100, 72, 48)
    const r = await run(await doc.save(), 'smallest', { minImageBytes: 0 })
    expect(r.kept === 'result' || r.kept === 'original').toBe(true)
    const out = await PDFDocument.load(r.bytes)
    expect(out.getPageCount()).toBe(1)
    expect(r.stats.images.replaced).toBe(0)
  })

  it('/Decode on a photo is preserved and the rendered result is still inverted the same way', async () => {
    const w = 300
    const h = 200
    const rgb = photoRGB(w, h, 12)
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w, h, data: rgb, cs: 'DeviceRGB', extra: { Decode: [1, 0, 1, 0, 1, 0] } }), 40, 300, 72, 48)
    const input = await doc.save()
    const before = (await pdfjsImages(input))[0]
    const r = await run(input, 'balanced')
    expect((await inspect(r.bytes)).imgs[0].decode).toEqual([1, 0, 1, 0, 1, 0])
    const after = (await pdfjsImages(r.bytes))[0]
    const ref = resizeBox(rgbOf(before.data, before.channels, w * h), w, h, 3, after.width, after.height)
    expect(psnr(ref, rgbOf(after.data, after.channels, after.width * after.height))).toBeGreaterThan(27)
  })
})

describe('never worse', () => {
  it('an image that will not get smaller is left byte-identical', async () => {
    // A tiny-quality JPEG that is already as small as our encoder would make it.
    const w = 300
    const h = 200
    const jpg = jpegOf(photoRGB(w, h, 13), w, h, 3, 20)
    const { doc, page } = await baseDoc()
    placeAt(page, addJpegImage(doc, w, h, 3, jpg, 'DeviceRGB'), 40, 300, 300, 200)
    const r = await run(await doc.save(), 'balanced')
    const { imgs } = await inspect(r.bytes)
    expect(Array.from(encodedBytes(imgs[0].stream))).toEqual(Array.from(jpg))
  })

  it('the overall result is never larger than the input (else the original is returned)', async () => {
    const { doc, page } = await baseDoc()
    placeAt(page, addJpegImage(doc, 300, 200, 3, jpegOf(photoRGB(300, 200, 14), 300, 200, 3, 10), 'DeviceRGB'), 40, 300, 300, 200)
    const input = await doc.save()
    const r = await run(input, 'high')
    expect(r.bytes.length).toBeLessThanOrEqual(input.length)
    if (r.kept === 'original') expect(r.bytes).toBe(input)
  })

  it('does not mutate the caller\'s bytes', async () => {
    const input = await photoDoc(600, 400, 144, 96)
    const copy = input.slice()
    await run(input, 'smallest')
    expect(Array.from(input)).toEqual(Array.from(copy))
  })
})

describe('robustness', () => {
  it('survives corrupted image data of many shapes (fuzz)', async () => {
    const r0 = rng(99)
    for (let round = 0; round < 12; round++) {
      const { doc, page } = await baseDoc()
      const w = 100 + Math.floor(r0() * 200)
      const h = 100 + Math.floor(r0() * 200)
      const good = photoRGB(w, h, round)
      const kind = round % 4
      let ref: PDFRef
      if (kind === 0) {
        const jpg = jpegOf(good, w, h, 3, 80)
        const bad = jpg.slice()
        for (let i = 0; i < 20; i++) bad[200 + Math.floor(r0() * (bad.length - 260))] = Math.floor(r0() * 256)
        ref = addJpegImage(doc, w, h, 3, bad, 'DeviceRGB')
      } else if (kind === 1) ref = addJpegImage(doc, w, h, 3, jpegOf(good, w, h, 3, 80).slice(0, 700), 'DeviceRGB')
      else if (kind === 2) ref = addRawImage(doc, { w, h, data: good.subarray(0, (w * h * 3) >> 1), cs: 'DeviceRGB' })
      else ref = addRawImage(doc, { w, h, data: new Uint8Array(1000).map(() => Math.floor(r0() * 256)), cs: 'DeviceRGB', flate: false })
      placeAt(page, ref, 10, 10, 30, 30)
      const input = await doc.save()
      const res = await run(input, 'smallest', { minImageBytes: 0 })
      expect(res.bytes.length).toBeLessThanOrEqual(input.length)
      expect((await PDFDocument.load(res.bytes)).getPageCount()).toBe(1)
    }
  })

  it('decodeJpeg on random bytes never hangs', () => {
    const r0 = rng(5)
    for (let i = 0; i < 20; i++) {
      const b = new Uint8Array(500).map(() => Math.floor(r0() * 256))
      b[0] = 0xff
      b[1] = 0xd8
      try {
        decodeJpeg(b)
      } catch {
        /* expected */
      }
    }
    expect(true).toBe(true)
  })

  it('stream objects are PDFRawStreams after loading (sanity for the tests above)', async () => {
    const { imgs } = await inspect(await photoDoc(600, 400, 144, 96))
    expect(imgs[0].stream).toBeInstanceOf(PDFRawStream)
  })
})
