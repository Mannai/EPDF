import { describe, expect, it } from 'vitest'
import { contentBounds, crop, fitWithin, inkCoverage, removeNearWhite, trimTransparent, type Pixels } from '../../src/renderer/src/features/sign/imageProcessing'
import { inkBounds, renderStrokes, simplifyStroke, widthFor, type Ctx2D, type Stroke } from '../../src/renderer/src/features/sign/strokes'

/** A w x h image filled with one RGBA color. */
function solid(w: number, h: number, rgba: [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4)
  return { data, width: w, height: h }
}
const setPx = (img: Pixels, x: number, y: number, rgba: [number, number, number, number]): void => img.data.set(rgba, (y * img.width + x) * 4)
const alphaAt = (img: Pixels, x: number, y: number): number => img.data[(y * img.width + x) * 4 + 3]

describe('removeNearWhite', () => {
  it('makes white paper transparent and keeps dark ink opaque', () => {
    const img = solid(4, 4, [255, 255, 255, 255])
    setPx(img, 1, 1, [10, 10, 10, 255])
    const out = removeNearWhite(img)
    expect(alphaAt(out, 0, 0)).toBe(0)
    expect(alphaAt(out, 1, 1)).toBe(255)
  })

  it('treats off-white (scanner grey, JPEG noise) as paper', () => {
    const out = removeNearWhite(solid(2, 2, [244, 243, 246, 255]))
    expect(out.data.filter((_, i) => i % 4 === 3).every((a) => a === 0)).toBe(true)
  })

  it('anti-aliases the edge: light greys keep partial alpha instead of a white halo', () => {
    const img = solid(3, 1, [255, 255, 255, 255])
    setPx(img, 0, 0, [0, 0, 0, 255])
    setPx(img, 1, 0, [220, 220, 220, 255])
    const out = removeNearWhite(img, 235)
    expect(alphaAt(out, 0, 0)).toBe(255)
    expect(alphaAt(out, 1, 0)).toBeGreaterThan(0)
    expect(alphaAt(out, 1, 0)).toBeLessThan(255)
    expect(alphaAt(out, 2, 0)).toBe(0)
  })

  it('keeps colored ink (blue pen) because its darkest channel is low', () => {
    const out = removeNearWhite(solid(1, 1, [30, 60, 200, 255]))
    expect(out.data[3]).toBe(255)
  })

  it('a lower threshold removes more; the input is not modified; existing transparency is kept', () => {
    const img = solid(2, 1, [200, 200, 200, 255])
    setPx(img, 1, 0, [0, 0, 0, 0])
    const copy = new Uint8ClampedArray(img.data)
    const strict = removeNearWhite(img, 250)
    const loose = removeNearWhite(img, 190)
    expect(alphaAt(strict, 0, 0)).toBe(255)
    expect(alphaAt(loose, 0, 0)).toBe(0)
    expect(alphaAt(loose, 1, 0)).toBe(0)
    expect(img.data).toEqual(copy)
  })
})

describe('trimming', () => {
  it('finds the bounding box of visible pixels and crops to it with padding', () => {
    const img = solid(10, 10, [0, 0, 0, 0])
    for (const [x, y] of [
      [3, 4],
      [6, 7]
    ])
      setPx(img, x, y, [0, 0, 0, 255])
    expect(contentBounds(img)).toEqual({ x: 3, y: 4, w: 4, h: 4 })
    const t = trimTransparent(img, 1)!
    expect([t.width, t.height]).toEqual([6, 6])
    expect(alphaAt(t, 1, 1)).toBe(255)
    expect(alphaAt(t, 4, 4)).toBe(255)
    expect(alphaAt(t, 0, 0)).toBe(0)
  })

  it('returns null for an empty image and clamps the crop to the image', () => {
    expect(trimTransparent(solid(5, 5, [0, 0, 0, 0]))).toBeNull()
    expect(crop(solid(5, 5, [1, 2, 3, 255]), { x: -3, y: -3, w: 20, h: 20 })).toMatchObject({ width: 5, height: 5 })
  })

  it('ignores near-invisible noise', () => {
    const img = solid(4, 4, [0, 0, 0, 0])
    setPx(img, 0, 0, [0, 0, 0, 4])
    expect(contentBounds(img)).toBeNull()
    expect(inkCoverage(img)).toBe(0)
  })
})

describe('fitWithin', () => {
  it('scales down keeping the aspect ratio and never enlarges', () => {
    expect(fitWithin(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 })
    expect(fitWithin(300, 100, 1000)).toEqual({ width: 300, height: 100 })
    expect(fitWithin(1, 5000, 100)).toEqual({ width: 1, height: 100 })
  })
})

describe('stroke processing', () => {
  const pt = (x: number, y: number, p = 0.5) => ({ x, y, p })

  it('simplifyStroke drops jitter but keeps both ends', () => {
    const s: Stroke = [pt(0, 0), pt(0.2, 0.1), pt(0.3, 0), pt(5, 5), pt(5.1, 5), pt(10, 10)]
    const out = simplifyStroke(s, 1.5)
    expect(out[0]).toEqual(pt(0, 0))
    expect(out[out.length - 1]).toEqual(pt(10, 10))
    expect(out).toHaveLength(3)
    expect(simplifyStroke([pt(1, 1)])).toHaveLength(1)
    expect(simplifyStroke([pt(1, 1), pt(1, 1)])).toHaveLength(2)
  })

  it('pressure only matters when enabled and for real pressure values', () => {
    expect(widthFor(3, 0.5, true)).toBeCloseTo(3)
    expect(widthFor(3, 1, true)).toBeGreaterThan(widthFor(3, 0.2, true))
    expect(widthFor(3, 1, false)).toBe(3)
    expect(widthFor(3, 0, true)).toBe(3) // devices that report no pressure
  })

  it('inkBounds pads by the widest line and is null when empty', () => {
    expect(inkBounds([], 3)).toBeNull()
    const b = inkBounds([[pt(10, 20), pt(30, 40)]], 2)!
    expect(b.x).toBeCloseTo(10 - 3.3)
    expect(b.w).toBeCloseTo(20 + 6.6)
  })

  it('renders smooth curves through the points, a dot for a tap, and honours pressure', () => {
    const calls: string[] = []
    const widths: number[] = []
    const ctx = {
      set lineWidth(v: number) {
        widths.push(v)
      },
      get lineWidth() {
        return 1
      },
      lineCap: '',
      lineJoin: '',
      strokeStyle: '',
      fillStyle: '',
      beginPath: () => calls.push('begin'),
      moveTo: () => calls.push('move'),
      lineTo: () => calls.push('line'),
      quadraticCurveTo: () => calls.push('quad'),
      arc: () => calls.push('arc'),
      stroke: () => calls.push('stroke'),
      fill: () => calls.push('fill')
    } as unknown as Ctx2D
    renderStrokes(ctx, [[pt(0, 0, 0.2), pt(10, 5, 0.4), pt(20, 0, 1)], [pt(50, 50)]], { width: 4, pressure: true, color: '#000' }, 2)
    expect(calls.filter((c) => c === 'quad')).toHaveLength(2)
    expect(calls).toContain('arc') // the single tap
    expect(calls).toContain('fill')
    expect(widths[0]).not.toBe(widths[1]) // pressure changed the width along the stroke
  })
})
