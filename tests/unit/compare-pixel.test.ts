import { describe, expect, it } from 'vitest'
import { DEFAULT_SENSITIVITY, MIN_DIFF_PIXELS, diffPixels, diffRegions, isVisualDifference, padToSize, thresholdFor } from '../../src/renderer/src/features/compare/diff/pixel'

const image = (w: number, h: number, rgb: [number, number, number] = [255, 255, 255]): Uint8ClampedArray => {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) d.set([rgb[0], rgb[1], rgb[2], 255], i * 4)
  return d
}
const fill = (img: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]): void => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.set([rgb[0], rgb[1], rgb[2], 255], (y * w + x) * 4)
}

describe('pixel difference', () => {
  it('identical images have no difference', () => {
    const a = image(50, 40)
    const d = diffPixels(a, image(50, 40), 50, 40, DEFAULT_SENSITIVITY)
    expect(d.count).toBe(0)
    expect(d.ratio).toBe(0)
    expect(d.bbox).toBeNull()
    expect(isVisualDifference(d)).toBe(false)
  })

  it('counts, masks and bounds a changed rectangle exactly', () => {
    const a = image(50, 40)
    const b = image(50, 40)
    fill(b, 50, 10, 5, 20, 15, [0, 0, 0])
    const d = diffPixels(a, b, 50, 40, DEFAULT_SENSITIVITY)
    expect(d.count).toBe(100)
    expect(d.total).toBe(2000)
    expect(d.ratio).toBeCloseTo(0.05, 10)
    expect(d.bbox).toEqual({ x0: 10, y0: 5, x1: 19, y1: 14 })
    expect(d.mask[5 * 50 + 10]).toBe(1)
    expect(d.mask[4 * 50 + 10]).toBe(0)
    expect(d.mask.reduce((s, v) => s + v, 0)).toBe(100)
    expect(isVisualDifference(d)).toBe(true)
  })

  it('sensitivity decides whether a faint change counts', () => {
    const a = image(20, 20)
    const b = image(20, 20)
    fill(b, 20, 0, 0, 20, 20, [235, 235, 235]) // a difference of 20 levels everywhere
    expect(diffPixels(a, b, 20, 20, 100).count).toBe(400)
    expect(diffPixels(a, b, 20, 20, 50).count).toBe(0)
    expect(thresholdFor(100)).toBe(4)
    expect(thresholdFor(0)).toBe(254)
    expect(thresholdFor(-5)).toBe(254)
    expect(thresholdFor(500)).toBe(4)
    expect(thresholdFor(70)).toBeGreaterThan(thresholdFor(80))
  })

  it('the largest channel difference decides (a coloured change is seen)', () => {
    const a = image(4, 4)
    const b = image(4, 4)
    b.set([255, 255, 0, 255], 0) // only blue drops to 0
    expect(diffPixels(a, b, 4, 4, DEFAULT_SENSITIVITY).count).toBe(1)
  })

  it('a few stray pixels are below the visual-difference floor', () => {
    const a = image(30, 30)
    const b = image(30, 30)
    for (let i = 0; i < MIN_DIFF_PIXELS - 1; i++) b.set([0, 0, 0, 255], i * 4)
    expect(isVisualDifference(diffPixels(a, b, 30, 30, DEFAULT_SENSITIVITY))).toBe(false)
  })

  it('rejects buffers that are too small', () => {
    expect(() => diffPixels(image(2, 2), image(2, 2), 10, 10, 50)).toThrow()
  })

  it('pads a smaller page with white so different page sizes can be compared', () => {
    const small = image(2, 2, [0, 0, 0])
    const padded = padToSize(small, 2, 2, 4, 3)
    expect(padded).toHaveLength(4 * 3 * 4)
    expect([...padded.slice(0, 4)]).toEqual([0, 0, 0, 255])
    expect([...padded.slice((0 * 4 + 3) * 4, (0 * 4 + 3) * 4 + 4)]).toEqual([255, 255, 255, 255]) // right of the small image
    expect([...padded.slice((2 * 4) * 4, (2 * 4) * 4 + 4)]).toEqual([255, 255, 255, 255]) // below it
    expect(padToSize(small, 2, 2, 2, 2)).toBe(small)
    // a page that is taller and wider than the target is cropped, not overflowed
    expect(padToSize(image(10, 10), 10, 10, 4, 4)).toHaveLength(64)
  })

  it('groups differences into regions (nearby ones join, far ones stay apart)', () => {
    const w = 200
    const h = 100
    const a = image(w, h)
    const b = image(w, h)
    fill(b, w, 10, 10, 20, 20, [0, 0, 0])
    fill(b, w, 30, 12, 40, 22, [0, 0, 0]) // within a cell or two of the first: joins it
    fill(b, w, 150, 70, 160, 80, [0, 0, 0])
    const regions = diffRegions(diffPixels(a, b, w, h, 80).mask, w, h)
    expect(regions).toHaveLength(2)
    expect(regions[0].x).toBeLessThanOrEqual(10)
    expect(regions[0].x + regions[0].w).toBeGreaterThanOrEqual(40)
    expect(regions[1].x).toBeLessThanOrEqual(150)
    expect(regions[1].y + regions[1].h).toBeLessThanOrEqual(h)
    expect(diffRegions(new Uint8Array(w * h), w, h)).toEqual([])
  })
})
