import { describe, expect, it } from 'vitest'
import { analyzePdf, estimateSize, jpegBitsPerPixel } from '../../src/renderer/src/features/compress/pdf/analyze'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { PRESETS, PRESET_LABELS, presetOf, sanitizeOptions, type CompressOptions } from '../../src/renderer/src/features/compress/pdf/options'
import { fmtSize, savedPercent, summary } from '../../src/renderer/src/features/compress/format'
import { addJpegImage, addRawImage, baseDoc, jpegOf, photoRGB, placeAt } from './compressHelpers'

async function sampleDoc(): Promise<Uint8Array> {
  const { doc, page } = await baseDoc()
  const w = 900
  const h = 600
  const photo = photoRGB(w, h, 21)
  placeAt(page, addRawImage(doc, { w, h, data: photo, cs: 'DeviceRGB' }), 20, 500, 216, 144) // 300 dpi Flate photo
  placeAt(page, addJpegImage(doc, w, h, 3, jpegOf(photo, w, h, 3, 92), 'DeviceRGB'), 20, 300, 216, 144) // 300 dpi q92 JPEG
  placeAt(page, addJpegImage(doc, w, h, 3, jpegOf(photo, w, h, 3, 92), 'DeviceRGB'), 260, 300, 216, 144) // same again (duplicate)
  doc.setAuthor('X'.repeat(200))
  return doc.save()
}

describe('analysis and estimate', () => {
  it('describes the images and where the bytes are', async () => {
    const a = await analyzePdf(await sampleDoc())
    expect(a.pages).toBe(1)
    expect(a.images).toHaveLength(3)
    expect(a.images.map((i) => i.coding).sort()).toEqual(['flate', 'jpeg', 'jpeg'])
    expect(a.images.every((i) => Math.round(i.dpiX ?? 0) === 300)).toBe(true)
    expect(a.imageBytes).toBeGreaterThan(a.fileBytes * 0.8)
    expect(a.duplicates.objects).toBeGreaterThanOrEqual(1)
    expect(a.signed).toBe(false)
    expect(a.hasJavaScript).toBe(false)
  })

  it('estimates fall in the right ballpark of the real result for every preset, and are ordered', async () => {
    const input = await sampleDoc()
    const a = await analyzePdf(input)
    const est: number[] = []
    for (const id of ['high', 'balanced', 'smallest'] as const) {
      const e = estimateSize(a, PRESETS[id])
      const real = await compressPdf(input, PRESETS[id], { codec: pureCodec })
      est.push(e.bytes)
      expect(e.bytes).toBeLessThan(input.length)
      // Only a heads-up (the dialog shows the exact size afterwards). This synthetic photo is far smoother than a real one
      // once reduced, so real files are closer; assert a loose band and, below, the ordering.
      expect(e.bytes / real.stats.newSize).toBeGreaterThan(0.4)
      expect(e.bytes / real.stats.newSize).toBeLessThan(4)
    }
    expect(est[0]).toBeGreaterThan(est[1])
    expect(est[1]).toBeGreaterThan(est[2])
  })

  it('an estimate never exceeds the current size, and turning images off saves far less', async () => {
    const a = await analyzePdf(await sampleDoc())
    const off = estimateSize(a, { ...PRESETS.balanced, images: false })
    const on = estimateSize(a, PRESETS.balanced)
    expect(on.bytes).toBeLessThan(off.bytes)
    expect(off.bytes).toBeLessThanOrEqual(a.fileBytes)
  })

  it('jpeg bits-per-pixel grows with quality and shrinks for gray', () => {
    expect(jpegBitsPerPixel(90, 3)).toBeGreaterThan(jpegBitsPerPixel(50, 3))
    expect(jpegBitsPerPixel(70, 1)).toBeLessThan(jpegBitsPerPixel(70, 3))
  })
})

describe('progress reporting and options', () => {
  it('progress is monotonic, labelled and ends at 1', async () => {
    const seen: [number, string][] = []
    await compressPdf(await sampleDoc(), PRESETS.balanced, { codec: pureCodec, onProgress: (f, l) => seen.push([f, l]) })
    expect(seen.length).toBeGreaterThan(4)
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0] - 1e-9)
    expect(seen[seen.length - 1][0]).toBe(1)
    expect(seen.some(([, l]) => /image/i.test(l))).toBe(true)
  })

  it('a caller can abort between steps (yieldNow may throw)', async () => {
    let n = 0
    await expect(
      compressPdf(await sampleDoc(), PRESETS.balanced, {
        codec: pureCodec,
        yieldNow: async () => {
          if (++n > 2) throw new Error('aborted')
        }
      })
    ).rejects.toThrow('aborted')
  })

  it('sanitizeOptions fills gaps and clamps hostile numbers', () => {
    const o = sanitizeOptions({ colorDpi: -5, jpegQuality: 1e9, monoDpi: Number.NaN, images: 'yes' as never } as Partial<CompressOptions>)
    expect(o.colorDpi).toBe(36)
    expect(o.jpegQuality).toBe(100)
    expect(o.monoDpi).toBe(300)
    expect(o.images).toBe(true)
    expect(sanitizeOptions(undefined)).toEqual(PRESETS.balanced)
  })

  it('presets are recognised, anything else is custom, and every preset has a label', () => {
    for (const id of ['high', 'balanced', 'smallest'] as const) expect(presetOf(PRESETS[id])).toBe(id)
    expect(presetOf({ ...PRESETS.balanced, jpegQuality: 71 })).toBe('custom')
    for (const id of ['high', 'balanced', 'smallest', 'custom'] as const) expect(PRESET_LABELS[id].label.length).toBeGreaterThan(3)
  })

  it('size formatting for the dialog and toast', () => {
    expect(fmtSize(0)).toBe('0 B')
    expect(fmtSize(1536)).toBe('1.5 KB')
    expect(fmtSize(12.4 * 1024 * 1024)).toBe('12.4 MB')
    expect(savedPercent(1000, 250)).toBe(75)
    expect(savedPercent(1000, 1200)).toBe(0)
    expect(summary(12.4 * 1024 * 1024, 3.1 * 1024 * 1024)).toBe('12.4 MB → 3.1 MB, saved 75%')
  })
})
