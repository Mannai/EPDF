import { existsSync, readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pdfjsImages } from './compressPdfjs'
import { decodeJpeg } from '../../src/renderer/src/features/compress/pdf/jpegDecode'
import { encodeJpeg } from '../../src/renderer/src/features/compress/pdf/jpegEncode'
import { estimateJpegQuality, parseJpegInfo } from '../../src/renderer/src/features/compress/pdf/jpegInfo'
import { applyPngPredictor, isPhotographic, packSamples, resizeBox, undoPredictor, unpackSamples } from '../../src/renderer/src/features/compress/pdf/raster'
import { addJpegImage, grayFromRgb, photoRGB, placeAt } from './compressHelpers'

const psnr = (a: Uint8Array, b: Uint8Array): number => {
  let se = 0
  for (let i = 0; i < a.length; i++) se += (a[i] - b[i]) ** 2
  const mse = se / a.length
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
}

describe('JPEG encoder + decoder (in-house)', () => {
  it('round-trips an RGB photo with high fidelity at quality 90', () => {
    const w = 67
    const h = 45 // deliberately not a multiple of 8 or 16
    const px = photoRGB(w, h, 3, 6)
    const jpg = encodeJpeg(w, h, 3, px, { quality: 90 })
    const info = parseJpegInfo(jpg)!
    expect(info).toMatchObject({ width: w, height: h, ncomp: 3, progressive: false, precision: 8 })
    const dec = decodeJpeg(jpg)
    expect(dec).toMatchObject({ width: w, height: h, ncomp: 3 })
    expect(psnr(px, dec.data)).toBeGreaterThan(33)
  })

  it('quality controls size and estimateJpegQuality recovers it', () => {
    const px = photoRGB(96, 80, 5, 8)
    const hi = encodeJpeg(96, 80, 3, px, { quality: 90 })
    const lo = encodeJpeg(96, 80, 3, px, { quality: 40 })
    expect(lo.length).toBeLessThan(hi.length)
    expect(Math.abs(estimateJpegQuality(parseJpegInfo(hi)!.quant0) - 90)).toBeLessThanOrEqual(2)
    expect(Math.abs(estimateJpegQuality(parseJpegInfo(lo)!.quant0) - 40)).toBeLessThanOrEqual(3)
  })

  it('handles single-component (gray) images without chroma', () => {
    const w = 33
    const h = 21
    const g = grayFromRgb(photoRGB(w, h, 9, 4))
    const jpg = encodeJpeg(w, h, 1, g, { quality: 92 })
    expect(parseJpegInfo(jpg)!.ncomp).toBe(1)
    const dec = decodeJpeg(jpg)
    expect(dec.ncomp).toBe(1)
    expect(psnr(g, dec.data)).toBeGreaterThan(34)
  })

  it('handles four-component (CMYK) images with an Adobe marker and no transform', () => {
    const w = 40
    const h = 24
    const rgbPx = photoRGB(w, h, 11, 4)
    const cmyk = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      cmyk[i * 4] = 255 - rgbPx[i * 3]
      cmyk[i * 4 + 1] = 255 - rgbPx[i * 3 + 1]
      cmyk[i * 4 + 2] = 255 - rgbPx[i * 3 + 2]
      cmyk[i * 4 + 3] = 20
    }
    const jpg = encodeJpeg(w, h, 4, cmyk, { quality: 92 })
    const info = parseJpegInfo(jpg)!
    expect(info.ncomp).toBe(4)
    expect(info.adobeTransform).toBe(0)
    const dec = decodeJpeg(jpg)
    expect(dec.ncomp).toBe(4)
    expect(psnr(cmyk, dec.data)).toBeGreaterThan(33)
  })

  it('encodes tiny (1x1, 7x3) and flat images', () => {
    for (const [w, h] of [[1, 1], [7, 3], [16, 16]] as const) {
      const px = new Uint8Array(w * h * 3).fill(200)
      const dec = decodeJpeg(encodeJpeg(w, h, 3, px, { quality: 75 }))
      expect(dec.width).toBe(w)
      expect(psnr(px, dec.data)).toBeGreaterThan(38)
    }
  })

  it('rejects garbage instead of returning junk', () => {
    expect(parseJpegInfo(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    expect(() => decodeJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrow()
    const jpg = encodeJpeg(32, 32, 3, photoRGB(32, 32), { quality: 80 })
    // truncated file: must not hang or return a wrong size
    let out: ReturnType<typeof decodeJpeg> | null = null
    try {
      out = decodeJpeg(jpg.subarray(0, jpg.length >> 1))
    } catch {
      /* throwing is fine */
    }
    if (out) expect(out.width).toBe(32)
  })
})

describe('progressive JPEG (real-world sample)', () => {
  // Windows ships progressive JPEGs (successive approximation, EOB runs); we only use them as an independent sample and
  // never copy them into the repository. Where they do not exist (other machines) the test is skipped.
  const sample = 'C:\\Windows\\Web\\touchkeyboard\\TouchKeyboardThemeDark003.jpg'
  it.skipIf(!existsSync(sample))('decodes to the same picture as PDF.js', async () => {
    const b = new Uint8Array(readFileSync(sample))
    const info = parseJpegInfo(b)!
    expect(info.progressive).toBe(true)
    const mine = decodeJpeg(b)
    const doc = await PDFDocument.create()
    const page = doc.addPage([600, 400])
    placeAt(page, addJpegImage(doc, info.width, info.height, 3, b, 'DeviceRGB'), 0, 0, 600, 400)
    const [ref] = await pdfjsImages(await doc.save())
    let se = 0
    let n = 0
    for (let i = 0; i < mine.width * mine.height; i += 5) for (let c = 0; c < 3; c++, n++) se += (mine.data[i * 3 + c] - ref.data[i * ref.channels + c]) ** 2
    expect(10 * Math.log10((255 * 255) / (se / n))).toBeGreaterThan(45)
  }, 60_000)
})

describe('raster helpers', () => {
  it('resizeBox averages areas and preserves flat colour', () => {
    const flat = new Uint8Array(12 * 12 * 3).fill(77)
    expect(Array.from(resizeBox(flat, 12, 12, 3, 5, 7)).every((v) => v === 77)).toBe(true)
    // 4x1 -> 2x1 averages pairs
    const row = new Uint8Array([0, 100, 200, 100])
    expect(Array.from(resizeBox(row, 4, 1, 1, 2, 1))).toEqual([50, 150])
    // non-integer ratio keeps the mean
    const photo = photoRGB(30, 30, 2)
    const small = resizeBox(photo, 30, 30, 3, 7, 11)
    const mean = (a: Uint8Array): number => a.reduce((s, v) => s + v, 0) / a.length
    expect(Math.abs(mean(photo) - mean(small))).toBeLessThan(2)
  })

  it('pack/unpack are inverses for 1, 2, 4 and 8 bits', () => {
    for (const bpc of [1, 2, 4, 8]) {
      const w = 13
      const h = 3
      const ncomp = bpc === 8 ? 3 : 1
      const vals = new Uint8Array(w * h * ncomp).map((_, i) => (i * 7) % (1 << bpc))
      const packed = packSamples(vals, w, h, ncomp, bpc)
      expect(Array.from(unpackSamples(packed, w, h, ncomp, bpc, false))).toEqual(Array.from(vals))
    }
  })

  it('PNG predictor apply/undo round trip, and TIFF predictor', () => {
    const px = photoRGB(20, 9, 4)
    const filtered = applyPngPredictor(px, 60, 3)
    const back = undoPredictor(filtered, { predictor: 15, colors: 3, bpc: 8, columns: 20 })!
    expect(Array.from(back)).toEqual(Array.from(px))
    const tiff = new Uint8Array([1, 2, 3, 1, 1, 1, 1, 1, 1])
    expect(Array.from(undoPredictor(tiff, { predictor: 2, colors: 3, bpc: 8, columns: 3 })!)).toEqual([1, 2, 3, 2, 3, 4, 3, 4, 5])
  })

  it('tells photographs from graphics', () => {
    const photo = photoRGB(200, 200, 8, 12)
    expect(isPhotographic(photo, 200, 200, 3)).toBe(true)
    expect(isPhotographic(grayFromRgb(photo), 200, 200, 1)).toBe(true)
    const graphic = new Uint8Array(200 * 200 * 3)
    for (let i = 0; i < 200 * 200; i++) graphic[i * 3] = graphic[i * 3 + 1] = graphic[i * 3 + 2] = (i % 200) < 100 ? 255 : 30
    expect(isPhotographic(graphic, 200, 200, 3)).toBe(false)
    // anti-aliased "screenshot": many grey levels, but mostly flat neighbours
    const shot = new Uint8Array(200 * 200)
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) shot[y * 200 + x] = x < 90 ? 255 : x < 110 ? Math.round(255 - (x - 90) * 12.7) : 0
    expect(isPhotographic(shot, 200, 200, 1)).toBe(false)
  })
})
