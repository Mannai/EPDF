import { describe, expect, it } from 'vitest'
import { PageGeometry, frameToUser, hexToRgb01, normalizeRotation, pageMatrix } from '../../src/renderer/src/features/forms/geometry'

const close = (a: number[], b: number[], eps = 1e-6): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)))

const geo = (rot: number, scale = 1, view = [0, 0, 612, 792]): PageGeometry => new PageGeometry(pageMatrix(view, rot, scale), normalizeRotation(rot))

describe('page geometry', () => {
  it('unrotated: origin bottom-left becomes bottom-left in CSS, y flips', () => {
    const g = geo(0)
    close(g.toCss(0, 0), [0, 792])
    close(g.toCss(612, 792), [612, 0])
    close(g.toCss(72, 700), [72, 92])
  })

  it('scales with zoom', () => {
    const g = geo(0, 2)
    close(g.toCss(72, 700), [144, 184])
    expect(g.scaleX()).toBeCloseTo(2)
  })

  it('rotated 90: bottom-left goes to the top-left, page becomes landscape', () => {
    const g = geo(90)
    close(g.toCss(0, 0), [0, 0])
    close(g.toCss(612, 0), [0, 612])
    close(g.toCss(0, 792), [792, 0])
    close(g.toCss(612, 792), [792, 612])
  })

  it('rotated 180 and 270 map the corners as the reader sees them', () => {
    close(geo(180).toCss(0, 0), [612, 0])
    close(geo(180).toCss(612, 792), [0, 792])
    close(geo(270).toCss(0, 0), [792, 612])
    close(geo(270).toCss(612, 792), [0, 0])
  })

  it('round-trips points for every rotation, zoom and a cropped view box', () => {
    for (const rot of [0, 90, 180, 270]) {
      for (const scale of [0.5, 1, 1.333, 3]) {
        const g = geo(rot, scale, [20, 30, 500, 700])
        for (const [x, y] of [
          [20, 30],
          [123.4, 456.7],
          [500, 700]
        ]) {
          const [cx, cy] = g.toCss(x, y)
          close(g.toPdf(cx, cy), [x, y])
        }
      }
    }
  })

  it('converts a widget rectangle to a CSS box for every rotation', () => {
    const r = { x1: 72, y1: 690, x2: 332, y2: 712 } // 260 x 22 pt
    expect(geo(0).rectToCss(r)).toEqual({ left: 72, top: 80, width: 260, height: 22 })
    const b90 = geo(90).rectToCss(r)
    expect(b90.width).toBeCloseTo(22)
    expect(b90.height).toBeCloseTo(260)
    expect(b90.left).toBeCloseTo(690)
    expect(b90.top).toBeCloseTo(72)
    const b180 = geo(180).rectToCss(r)
    expect(b180.left).toBeCloseTo(612 - 332)
    expect(b180.top).toBeCloseTo(690)
    const b270 = geo(270).rectToCss(r)
    expect(b270.left).toBeCloseTo(792 - 712)
    expect(b270.top).toBeCloseTo(612 - 332)
  })

  it('converts a CSS box back to a normalised PDF rectangle', () => {
    for (const rot of [0, 90, 180, 270]) {
      const g = geo(rot, 1.5)
      const r = { x1: 100, y1: 200, x2: 300, y2: 260 }
      const back = g.boxToPdf(g.rectToCss(r))
      close([back.x1, back.y1, back.x2, back.y2], [100, 200, 300, 260])
    }
  })

  it('builds a frame whose axes are the reader’s right and up on rotated pages', () => {
    for (const rot of [0, 90, 180, 270]) {
      const g = geo(rot)
      const frame = g.frameOfBox({ left: 100, top: 100, width: 200, height: 50 })
      expect(frame.width).toBeCloseTo(200)
      expect(frame.height).toBeCloseTo(50)
      // Moving 10pt to the reader's right must move 10 CSS px right; 10pt up must move 10px up.
      const o = g.toCss(...frame.origin)
      close(o, [100, 150])
      const right = g.toCss(...frameToUser(frame, 10, 0))
      close(right, [110, 150])
      const up = g.toCss(...frameToUser(frame, 0, 10))
      close(up, [100, 140])
    }
  })
})

describe('helpers', () => {
  it('normalises rotations', () => {
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(0)).toBe(0)
  })
  it('parses hex colors and tolerates junk', () => {
    expect(hexToRgb01('#ff8000')).toEqual({ r: 1, g: 128 / 255, b: 0 })
    expect(hexToRgb01('nonsense')).toEqual({ r: 0, g: 0, b: 0 })
  })
})
