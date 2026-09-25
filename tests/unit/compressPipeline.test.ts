import { PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { PRESETS } from '../../src/renderer/src/features/compress/pdf/options'
import { addJpegImage, addRawImage, baseDoc, grayFromRgb, imagesOf, jpegOf, photoRGB, placeAt } from './compressHelpers'

const run = (bytes: Uint8Array, preset: keyof typeof PRESETS = 'balanced', extra = {}) => compressPdf(bytes, { ...PRESETS[preset], ...extra }, { codec: pureCodec })

describe('compressPdf pipeline', () => {
  it('shrinks a big Flate photo placed small, keeping the page intact', async () => {
    const { doc, page } = await baseDoc()
    const w = 600
    const h = 400
    const ref = addRawImage(doc, { w, h, data: photoRGB(w, h, 1), cs: 'DeviceRGB' })
    placeAt(page, ref, 50, 300, 200, 133) // 216 dpi
    const input = await doc.save()
    const res = await run(input, 'smallest')
    expect(res.kept).toBe('result')
    expect(res.bytes.length).toBeLessThan(input.length / 3)
    const out = await PDFDocument.load(res.bytes)
    expect(out.getPageCount()).toBe(1)
    const [img] = imagesOf(out)
    expect(img).toBeTruthy()
    const outW = (img.dict.get(PDFName.of('Width')) as unknown as { asNumber(): number }).asNumber()
    expect(outW).toBeLessThan(w)
    expect(res.stats.images.replaced).toBe(1)
    expect(res.stats.images.downsampled).toBe(1)
  })
})
