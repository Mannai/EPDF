import { describe, expect, it } from 'vitest'
import { addJpegImage, baseDoc, jpegOf, photoRGB, placeAt, grayFromRgb } from './compressHelpers'
import { pdfjsImages, pdfjsText } from './compressPdfjs'

const psnrRgb = (src: Uint8Array, dst: Uint8ClampedArray, ch: number): number => {
  let se = 0
  const n = src.length / 3
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) se += (src[i * 3 + c] - dst[i * ch + c]) ** 2
  const mse = se / (n * 3)
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
}

describe('PDF.js reads our JPEGs (independent decoder)', () => {
  it('RGB and gray JPEG from the in-house encoder decode to the same picture', async () => {
    const w = 64
    const h = 48
    const px = photoRGB(w, h, 21, 5)
    const { doc, page } = await baseDoc()
    placeAt(page, addJpegImage(doc, w, h, 3, jpegOf(px, w, h, 3, 90), 'DeviceRGB'), 20, 400, 128, 96)
    placeAt(page, addJpegImage(doc, w, h, 1, jpegOf(grayFromRgb(px), w, h, 1, 90), 'DeviceGray'), 200, 400, 128, 96)
    const bytes = await doc.save()
    expect(await pdfjsText(bytes)).toContain('Compression sample text')
    const imgs = await pdfjsImages(bytes)
    expect(imgs).toHaveLength(2)
    expect(imgs[0].width).toBe(w)
    expect(psnrRgb(px, imgs[0].data, imgs[0].channels)).toBeGreaterThan(32)
    const g = grayFromRgb(px)
    let se = 0
    for (let i = 0; i < g.length; i++) se += (g[i] - imgs[1].data[i * imgs[1].channels]) ** 2
    expect(10 * Math.log10((255 * 255) / (se / g.length))).toBeGreaterThan(32)
  })
})
