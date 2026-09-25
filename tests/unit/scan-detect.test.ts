import { describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
import { detectPage } from '../../src/shared/features/scan/detect'
import { estimateSkew } from '../../src/shared/features/scan/deskew'
import { createRgba, rotateDegrees } from '../../src/shared/features/scan/image'
import { orderQuad, quadInsideUnit, type Quad } from '../../src/shared/features/scan/geometry'
import { photographPage, renderTextPage, type PhotoSpec } from '../support/scanImages'

const page = renderTextPage(620, 877, 11)

/** Largest corner error as a fraction of the photo's larger dimension. */
function cornerError(found: Quad, truth: Quad, w: number, h: number): number {
  const a = orderQuad(found)
  const b = orderQuad(truth)
  let worst = 0
  for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot((a[i].x - b[i].x) * w, (a[i].y - b[i].y) * h) / Math.max(w, h))
  return worst
}

const base: PhotoSpec = { width: 800, height: 700, angle: 0, scale: 0.64 }

const scenes: { name: string; spec: PhotoSpec }[] = [
  { name: 'straight page on a wooden desk', spec: { ...base, background: 'wood', noise: 4 } },
  { name: 'rotated 18 degrees on wood with noise', spec: { ...base, angle: 18, background: 'wood', noise: 6, seed: 4 } },
  { name: 'perspective and rotation on a dark desk', spec: { ...base, scale: 0.5, angle: -9, perspective: { g: 0.0003, h: -0.0002 }, background: 'dark', noise: 5, seed: 5 } },
  { name: 'strong shadow falling across the page (wood)', spec: { ...base, angle: 7, shadow: { strength: 0.45, angle: 30 }, background: 'wood', noise: 5, seed: 6 } },
  { name: 'busy background with bright objects', spec: { ...base, angle: 12, perspective: { g: -0.0003, h: 0.0004 }, background: 'busy', noise: 5, seed: 8 } },
  { name: 'page on a mid-grey table with a shadow and noise', spec: { ...base, angle: -14, shadow: { strength: 0.3, angle: 200 }, background: 'grey', noise: 8, seed: 9 } }
]

describe('page quad detection on generated photos', () => {
  for (const s of scenes) {
    it(`finds the page corners: ${s.name}`, () => {
      const photo = photographPage(page, s.spec)
      expect(quadInsideUnit(photo.corners), 'scene must keep the whole page in frame').toBe(true)
      const r = detectPage(photo.image)
      expect(r, 'a page must be found').not.toBeNull()
      const err = cornerError(r!.quad, photo.corners, s.spec.width, s.spec.height)
      expect(err).toBeLessThan(0.03)
      expect(r!.areaFraction).toBeGreaterThan(0.25)
    })
  }

  it('the fast (live preview) mode agrees on an easy scene', () => {
    const photo = photographPage(page, { ...base, angle: 10, background: 'wood', noise: 4, seed: 12 })
    const r = detectPage(photo.image, { fast: true, maxSide: 256 })!
    expect(cornerError(r.quad, photo.corners, 800, 700)).toBeLessThan(0.04)
  })

  it('says nothing when there is no page (uniform noise, plain gradient)', () => {
    const img = createRgba(400, 300, [90, 80, 70])
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) img.data[(y * 400 + x) * 4] = 80 + ((x * 7 + y * 13) % 17)
    expect(detectPage(img)).toBeNull()
  })

  it('does not crash on tiny images', () => {
    expect(detectPage(createRgba(8, 8))).toBeNull()
  })
})

describe('deskew', () => {
  const text = renderTextPage(620, 877, 21)
  for (const deg of [-7.5, -2, 0, 1.3, 4.75, 11]) {
    it(`recovers a skew of ${deg} degrees to within 0.3`, () => {
      const skewed = rotateDegrees(text, deg)
      const r = estimateSkew(skewed)
      if (deg === 0) expect(Math.abs(r.degrees)).toBeLessThan(0.3)
      else expect(Math.abs(r.degrees - deg)).toBeLessThan(0.3)
      expect(r.confidence).toBeGreaterThan(1.5)
    })
  }

  it('reports no confidence for a page without text lines', () => {
    const blank = createRgba(400, 500, [245, 245, 245])
    const r = estimateSkew(blank)
    expect(r.degrees).toBe(0)
    expect(r.confidence).toBe(0)
  })
})
