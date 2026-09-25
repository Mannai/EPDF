import { describe, expect, it } from 'vitest'
import {
  clampCenter,
  geomOfPage,
  normRotation,
  pdfRectToView,
  pdfToView,
  rotationOfMatrix,
  uprightMatrix,
  uprightRectAt,
  uprightSize,
  viewRectToPdf,
  viewSize,
  viewToPdf,
  type PageGeom
} from '../../src/renderer/src/features/markup/pdf/geometry'
import {
  mergeRectsIntoLines,
  pointInQuad,
  quadsBounds,
  selectionToQuads,
  splitQuads,
  viewRectToQuad
} from '../../src/renderer/src/features/markup/pdf/quads'
import { makePdf } from './markupHelpers'

const geom = (rotation: 0 | 90 | 180 | 270, box: [number, number, number, number] = [0, 0, 612, 792]): PageGeom => ({ box, rotation })

describe('page geometry', () => {
  it('maps the four corners of an unrotated page', () => {
    const g = geom(0)
    expect(pdfToView(g, 0, 0)).toEqual([0, 792]) // bottom-left of the page is bottom-left of the view
    expect(pdfToView(g, 0, 792)).toEqual([0, 0])
    expect(pdfToView(g, 612, 792)).toEqual([612, 0])
    expect(viewSize(g)).toEqual([612, 792])
  })

  it('maps corners for /Rotate 90 (clockwise): PDF bottom-left goes to the view top-left', () => {
    const g = geom(90)
    expect(viewSize(g)).toEqual([792, 612])
    expect(pdfToView(g, 0, 0)).toEqual([0, 0])
    expect(pdfToView(g, 612, 0)).toEqual([0, 612]) // bottom-right → bottom-left
    expect(pdfToView(g, 0, 792)).toEqual([792, 0]) // top-left → top-right
  })

  it('maps corners for /Rotate 180 and 270', () => {
    expect(pdfToView(geom(180), 0, 0)).toEqual([612, 0])
    expect(pdfToView(geom(180), 612, 792)).toEqual([0, 792])
    expect(pdfToView(geom(270), 0, 0)).toEqual([792, 612])
    expect(pdfToView(geom(270), 612, 792)).toEqual([0, 0])
  })

  it.each([0, 90, 180, 270] as const)('view↔pdf are exact inverses for rotation %i with a CropBox offset', (r) => {
    const g = geom(r, [36, 54, 500, 700])
    for (const [x, y] of [
      [36, 54],
      [500, 700],
      [123.5, 321.25],
      [400, 60]
    ] as [number, number][]) {
      const [vx, vy] = pdfToView(g, x, y)
      const [bx, by] = viewToPdf(g, vx, vy)
      expect(bx).toBeCloseTo(x, 9)
      expect(by).toBeCloseTo(y, 9)
    }
    // The visible box always maps onto [0, viewW] × [0, viewH].
    const [vw, vh] = viewSize(g)
    const corners = [pdfToView(g, 36, 54), pdfToView(g, 500, 700)]
    for (const [vx, vy] of corners) {
      expect(vx).toBeGreaterThanOrEqual(-1e-9)
      expect(vx).toBeLessThanOrEqual(vw + 1e-9)
      expect(vy).toBeGreaterThanOrEqual(-1e-9)
      expect(vy).toBeLessThanOrEqual(vh + 1e-9)
    }
  })

  it('CropBox offset shifts PDF coordinates (an annotation at the crop origin is at the view origin)', () => {
    const g = geom(0, [100, 200, 400, 600])
    expect(viewToPdf(g, 0, 0)).toEqual([100, 600])
    expect(viewToPdf(g, 300, 400)).toEqual([400, 200])
  })

  it('converts rects in both directions and normalizes them', () => {
    const g = geom(90, [0, 0, 612, 792])
    const view = pdfRectToView(g, [100, 200, 300, 400])
    expect(view).toEqual([200, 100, 400, 300])
    expect(viewRectToPdf(g, view)).toEqual([100, 200, 300, 400])
  })

  it('reads geometry from a real pdf-lib page (CropBox ∩ MediaBox, rotation)', async () => {
    const pdf = await makePdf({ rotation: 270, cropBox: [10, 20, 400, 500] })
    expect(geomOfPage(pdf.getPage(0))).toEqual({ box: [10, 20, 400, 500], rotation: 270 })
  })

  it('normalizes rotations', () => {
    expect(normRotation(-90)).toBe(270)
    expect(normRotation(450)).toBe(90)
    expect(normRotation(0)).toBe(0)
  })

  it('upright matrices round-trip through rotationOfMatrix and map the bbox onto a zero-origin box', () => {
    for (const r of [0, 90, 180, 270] as const) {
      const w = 100
      const h = 40
      const m = uprightMatrix(r, w, h)
      expect(rotationOfMatrix(m)).toBe(r)
      const xs = [0, w].flatMap((x) => [0, h].map((y) => m[0] * x + m[2] * y + m[4]))
      const ys = [0, w].flatMap((x) => [0, h].map((y) => m[1] * x + m[3] * y + m[5]))
      expect(Math.min(...xs)).toBeCloseTo(0)
      expect(Math.min(...ys)).toBeCloseTo(0)
      const bw = Math.max(...xs) - Math.min(...xs)
      const bh = Math.max(...ys) - Math.min(...ys)
      expect([bw, bh]).toEqual(r === 90 || r === 270 ? [h, w] : [w, h])
    }
    expect(rotationOfMatrix(undefined)).toBe(0)
  })

  it('upright size / rect swap dimensions on 90 and 270', () => {
    expect(uprightSize([0, 0, 40, 100], 90)).toEqual([100, 40])
    expect(uprightSize([0, 0, 40, 100], 180)).toEqual([40, 100])
    expect(uprightRectAt(100, 100, 40, 20, 270)).toEqual([90, 80, 110, 120])
  })

  it('keeps a centred box inside the page', () => {
    const g = geom(0)
    expect(clampCenter(g, -50, -50, 24, 24)).toEqual([12, 12])
    expect(clampCenter(g, 9999, 9999, 24, 24)).toEqual([600, 780])
  })
})

describe('QuadPoints from selection rects', () => {
  it('merges span-sized rects of one visual line into one strip and keeps lines apart', () => {
    const rects: [number, number, number, number][] = [
      [10, 100, 50, 112],
      [52, 100, 90, 112], // same line, next span (small gap)
      [92.5, 101, 130, 113],
      [10, 116, 60, 128] // next line
    ]
    const lines = mergeRectsIntoLines(rects)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual([10, 100, 130, 113])
    expect(lines[1]).toEqual([10, 116, 60, 128])
  })

  it('drops degenerate rects and does not merge distant columns on the same line', () => {
    const lines = mergeRectsIntoLines([
      [10, 10, 10, 20], // zero width
      [10, 10, 40, 20],
      [300, 10, 340, 20]
    ])
    expect(lines).toHaveLength(2)
  })

  it('joins lines bridged by a later rect', () => {
    const lines = mergeRectsIntoLines([
      [0, 0, 10, 10],
      [30, 0, 40, 10],
      [10, 0, 30, 10]
    ])
    expect(lines).toEqual([[0, 0, 40, 10]])
  })

  it('writes quads TL, TR, BL, BR in PDF space (unrotated page)', () => {
    const q = viewRectToQuad(geom(0), [72, 92, 172, 108])
    // view top (92) is PDF y=700, bottom (108) is y=684
    expect(q).toEqual([72, 700, 172, 700, 72, 684, 172, 684])
  })

  it('keeps TL/TR/BL/BR relative to the displayed text on a rotated page', () => {
    const g = geom(90)
    const q = viewRectToQuad(g, [10, 20, 110, 40]) // view: x 10..110, y 20..40
    // view TL (10,20) ↔ pdf (x=20, y=10); TR (110,20) ↔ (20,110); BL (10,40) ↔ (40,10); BR (110,40) ↔ (40,110)
    expect(q).toEqual([20, 10, 20, 110, 40, 10, 40, 110])
    const b = quadsBounds([q])!
    expect(b).toEqual([20, 10, 40, 110])
  })

  it('handles a CropBox offset and 180/270 rotation consistently with pdfToView', () => {
    for (const r of [180, 270] as const) {
      const g = geom(r, [50, 60, 400, 500])
      const view: [number, number, number, number] = [20, 30, 120, 50]
      const q = viewRectToQuad(g, view)
      const tl = pdfToView(g, q[0], q[1])
      const br = pdfToView(g, q[6], q[7])
      expect(tl[0]).toBeCloseTo(20)
      expect(tl[1]).toBeCloseTo(30)
      expect(br[0]).toBeCloseTo(120)
      expect(br[1]).toBeCloseTo(50)
    }
  })

  it('selectionToQuads yields one quad per line', () => {
    const quads = selectionToQuads(geom(0), [
      [10, 100, 50, 112],
      [52, 100, 90, 112],
      [10, 116, 60, 128]
    ])
    expect(quads).toHaveLength(2)
    expect(splitQuads(quads.flat())).toHaveLength(2)
  })

  it('splitQuads ignores a trailing partial quad and undefined', () => {
    expect(splitQuads(undefined)).toEqual([])
    expect(splitQuads([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toHaveLength(1)
  })

  it('point-in-quad works for axis-aligned and rotated quads, with tolerance', () => {
    const q = [0, 10, 10, 10, 0, 0, 10, 0]
    expect(pointInQuad(q, 5, 5)).toBe(true)
    expect(pointInQuad(q, 11, 5)).toBe(false)
    expect(pointInQuad(q, 11, 5, 2)).toBe(true)
    // a diamond: TL(5,10) TR(10,5) BL(0,5) BR(5,0)
    const d = [5, 10, 10, 5, 0, 5, 5, 0]
    expect(pointInQuad(d, 5, 5)).toBe(true)
    expect(pointInQuad(d, 9.5, 9.5)).toBe(false)
  })
})
