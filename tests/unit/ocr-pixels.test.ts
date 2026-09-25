import { describe, expect, it } from 'vitest'
import { MAX_PIXELS, MAX_SIDE, autoContrast, estimateSkew, grayToRgba, otsuThreshold, scaleFor, shouldDeskew, toGrayscale } from '../../src/renderer/src/features/ocr/pixels'
import { PAGE_TEXT, rasterizeText } from '../fixtures/ocr.mjs'

// A small letter-size page at 100 dpi keeps these tests quick.
const W = 850
const H = 1100
const lines = PAGE_TEXT.flat().map((text, i) => ({ text, x: 100, y: 150 + i * 90, size: 26 }))
const page = (angle: number, noise = 0): Uint8Array => rasterizeText(lines, W, H, { angle, noise })
const deg = (rad: number): number => (rad * 180) / Math.PI

describe('skew detection', () => {
  it.each([3, -4, 1.5, -0.75, 7])('finds a %f degree tilt (clockwise positive) within half a degree', (a) => {
    const e = estimateSkew(page(a), W, H)
    expect(Math.abs(deg(e.angle) - a)).toBeLessThan(0.5)
    expect(shouldDeskew(e)).toBe(true)
  })

  it('leaves a straight page alone', () => {
    const e = estimateSkew(page(0), W, H)
    expect(Math.abs(deg(e.angle))).toBeLessThan(0.3)
    expect(shouldDeskew(e)).toBe(false)
  })

  it('is not fooled by scanner noise', () => {
    const e = estimateSkew(page(2, 40), W, H)
    expect(Math.abs(deg(e.angle) - 2)).toBeLessThan(0.6)
  })

  it('finds nothing on a blank or nearly blank page', () => {
    const blank = new Uint8Array(W * H).fill(255)
    expect(estimateSkew(blank, W, H)).toEqual({ angle: 0, confidence: 1 })
    const speck = blank.slice()
    speck[1000] = 0
    expect(shouldDeskew(estimateSkew(speck, W, H))).toBe(false)
  })

  it('only corrects tilts that are large enough and clearly supported', () => {
    expect(shouldDeskew({ angle: (0.1 * Math.PI) / 180, confidence: 2 })).toBe(false)
    expect(shouldDeskew({ angle: (2 * Math.PI) / 180, confidence: 1.01 })).toBe(false)
    expect(shouldDeskew({ angle: (2 * Math.PI) / 180, confidence: 1.5 })).toBe(true)
    expect(shouldDeskew({ angle: (-2 * Math.PI) / 180, confidence: 1.5 })).toBe(true)
  })
})

describe('grayscale and contrast', () => {
  it('converts RGBA to luma and back to opaque gray', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
    const g = toGrayscale(rgba, 4, 1)
    expect([...g]).toEqual([76, 150, 29, 255])
    expect([...grayToRgba(g).slice(0, 8)]).toEqual([76, 76, 76, 255, 150, 150, 150, 255])
  })

  it('stretches a washed-out scan to the full range and keeps the order of gray levels', () => {
    const g = new Uint8Array(1000).fill(200) // pale paper
    for (let i = 0; i < 100; i++) g[i] = 120 + (i % 10) // faint ink
    expect(autoContrast(g)).toBe(true)
    expect(Math.min(...g)).toBeLessThan(15)
    expect(Math.max(...g)).toBe(255)
    expect(g[0]).toBeLessThan(g[9]) // 120 stays darker than 129
  })

  it('leaves a page that already spans black to white, and a flat page, unchanged', () => {
    const good = new Uint8Array(1000).fill(255)
    for (let i = 0; i < 100; i++) good[i] = i % 2 ? 0 : 10
    const copy = good.slice()
    expect(autoContrast(good)).toBe(false)
    expect(good).toEqual(copy)
    const flat = new Uint8Array(500).fill(128)
    expect(autoContrast(flat)).toBe(false)
  })

  it("Otsu's threshold separates ink from paper", () => {
    const g = new Uint8Array(1000).fill(230)
    for (let i = 0; i < 200; i++) g[i] = 30
    const t = otsuThreshold(g)
    expect(t).toBeGreaterThanOrEqual(30)
    expect(t).toBeLessThan(230)
  })
})

describe('render size limits', () => {
  it('uses the requested resolution for normal pages', () => {
    expect(scaleFor(612, 792, 300)).toBeCloseTo(300 / 72, 6)
    expect(scaleFor(612, 792, 150)).toBeCloseTo(150 / 72, 6)
  })

  it('shrinks huge pages so neither the pixel count nor the longest side is exceeded', () => {
    for (const [w, h] of [[2400, 3300], [14400, 200], [5000, 5000], [200, 14400]]) {
      const s = scaleFor(w, h, 400)
      expect(w * s * h * s).toBeLessThanOrEqual(MAX_PIXELS * 1.001)
      expect(Math.max(w, h) * s).toBeLessThanOrEqual(MAX_SIDE * 1.001)
      expect(s).toBeGreaterThan(0)
    }
  })
})
