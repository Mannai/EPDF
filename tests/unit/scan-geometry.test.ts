import { describe, expect, it } from 'vitest'
import { applyHomography, convexHull, isConvexQuad, orderQuad, polygonArea, quadAngles, quadSize, rotateQuadQuarterTurns, solveHomography, warpPerspective, type Pt, type Quad } from '../../src/shared/features/scan/geometry'
import { createRgba, resizeRgba, rotateDegrees, rotateQuarterTurns } from '../../src/shared/features/scan/image'
import { meanAbsDiff, photographPage, renderTextPage } from '../support/scanImages'

const close = (a: Pt, b: Pt, tol: number): void => {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(tol)
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(tol)
}

describe('homography', () => {
  it('maps the four source points exactly onto the four destination points', () => {
    const src: Pt[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 200 },
      { x: 0, y: 200 }
    ]
    const dst: Pt[] = [
      { x: 13, y: 9 },
      { x: 120, y: 30 },
      { x: 95, y: 240 },
      { x: 4, y: 190 }
    ]
    const h = solveHomography(src, dst)!
    for (let i = 0; i < 4; i++) close(applyHomography(h, src[i].x, src[i].y), dst[i], 1e-6)
  })

  it('identity for identical point sets and null for degenerate ones', () => {
    const p: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]
    const h = solveHomography(p, p)!
    close(applyHomography(h, 3, 4), { x: 3, y: 4 }, 1e-9)
    expect(solveHomography(p, [p[0], p[0], p[0], p[0]])).toBeNull()
  })
})

describe('polygon helpers', () => {
  it('area, hull, ordering, convexity and angles', () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }])).toBe(12)
    const hull = convexHull([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 3 }, { x: 0, y: 3 }, { x: 1, y: 1 }])
    expect(hull).toHaveLength(4)
    const q = orderQuad([{ x: 9, y: 9 }, { x: 0, y: 9 }, { x: 0, y: 0 }, { x: 9, y: 0 }])
    expect(q[0]).toEqual({ x: 0, y: 0 })
    expect(q[1]).toEqual({ x: 9, y: 0 })
    expect(q[2]).toEqual({ x: 9, y: 9 })
    expect(q[3]).toEqual({ x: 0, y: 9 })
    expect(isConvexQuad(q)).toBe(true)
    expect(isConvexQuad([q[0], q[2], q[1], q[3]])).toBe(false)
    quadAngles(q).forEach((a) => expect(a).toBeCloseTo(90, 5))
    expect(quadSize(q)).toEqual({ width: 9, height: 9 })
  })

  it('rotating the quad by quarter turns keeps the same physical corners, re-ordered', () => {
    const q: Quad = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.15 },
      { x: 0.85, y: 0.95 },
      { x: 0.05, y: 0.9 }
    ]
    const r = rotateQuadQuarterTurns(q, 1)
    // a 90 degree clockwise turn sends (x, y) to (1 - y, x); the old TL becomes the new TR
    close(r[1], { x: 1 - 0.1, y: 0.1 }, 1e-9)
    close(r[2], { x: 1 - 0.15, y: 0.9 }, 1e-9)
    expect(rotateQuadQuarterTurns(q, 4)).toEqual(orderQuad(q))
  })
})

describe('perspective warp on synthetic photos', () => {
  const page = renderTextPage(310, 438, 3)
  const cases: { name: string; angle: number; g: number; h: number }[] = [
    { name: 'straight', angle: 0, g: 0, h: 0 },
    { name: 'rotated 12 degrees', angle: 12, g: 0, h: 0 },
    { name: 'rotated -25 degrees with perspective', angle: -25, g: 0.0004, h: -0.0002 },
    { name: 'strong keystone', angle: 4, g: -0.0006, h: 0.0005 }
  ]
  for (const c of cases) {
    it(`recovers the flat page from a photo: ${c.name}`, () => {
      const photo = photographPage(page, { width: 640, height: 640, angle: c.angle, scale: 1.05, perspective: { g: c.g, h: c.h }, background: 'grey', seed: 2 })
      const quadPx = photo.corners.map((p) => ({ x: p.x * 640, y: p.y * 640 })) as Quad
      const rect = warpPerspective(photo.image, quadPx, 310, 438)!
      expect(rect.width).toBe(310)
      // ground truth: the original page; small resampling error only
      expect(meanAbsDiff(rect, page)).toBeLessThan(9)
    })
  }

  it('returns null for a degenerate quad', () => {
    const img = createRgba(50, 50)
    const p = { x: 5, y: 5 }
    expect(warpPerspective(img, [p, p, p, p], 20, 20)).toBeNull()
  })
})

describe('raster helpers', () => {
  it('quarter turns are exact and 4 of them are the identity', () => {
    const img = renderTextPage(40, 60, 1)
    const r = rotateQuarterTurns(img, 1)
    expect([r.width, r.height]).toEqual([60, 40])
    // top-left pixel of the source ends up at the top-right
    expect(r.data[((0 * 60) + 59) * 4]).toBe(img.data[0])
    const again = rotateQuarterTurns(rotateQuarterTurns(rotateQuarterTurns(r, 1), 1), 1)
    expect(Array.from(again.data)).toEqual(Array.from(img.data))
  })

  it('rotateDegrees keeps size and fills the corners', () => {
    const img = createRgba(50, 50, [0, 0, 0])
    const r = rotateDegrees(img, 30, [255, 255, 255])
    expect(r.width).toBe(50)
    expect(r.data[0]).toBe(255)
    expect(r.data[(25 * 50 + 25) * 4]).toBe(0)
  })

  it('area-averaging resize does not alias a fine checkerboard', () => {
    const img = createRgba(64, 64)
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) img.data[(y * 64 + x) * 4] = img.data[(y * 64 + x) * 4 + 1] = img.data[(y * 64 + x) * 4 + 2] = (x + y) % 2 ? 255 : 0
    const s = resizeRgba(img, 16, 16)
    for (let i = 0; i < s.data.length; i += 4) expect(Math.abs(s.data[i] - 127.5)).toBeLessThan(3)
  })
})
