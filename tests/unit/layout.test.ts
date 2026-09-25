import { describe, expect, it } from 'vitest'
import {
  PAGE_GAP,
  PAGE_PAD_Y,
  buildLayout,
  currentPageAt,
  fitPageScale,
  fitWidthScale,
  groupPages,
  nextZoomStep,
  outputScaleFor,
  rowAt,
  visibleRows
} from '../../src/renderer/src/viewer/layout'

const letter = { w: 612, h: 792 }
const build = (n: number, mode: 'continuous' | 'single' | 'two' = 'continuous', scale = 1, cur = 0) =>
  buildLayout(n, groupPages(n, mode, cur), () => letter, scale)

describe('groupPages', () => {
  it('groups by view mode', () => {
    expect(groupPages(5, 'continuous', 0)).toEqual([[0], [1], [2], [3], [4]])
    expect(groupPages(5, 'two', 0)).toEqual([[0, 1], [2, 3], [4]])
    expect(groupPages(5, 'single', 3)).toEqual([[3]])
  })
  it('clamps the single-page index and handles empty docs', () => {
    expect(groupPages(3, 'single', 99)).toEqual([[2]])
    expect(groupPages(0, 'continuous', 0)).toEqual([])
  })
})

describe('buildLayout', () => {
  it('stacks rows with gaps and padding', () => {
    const l = build(3)
    expect(l.rows.map((r) => r.top)).toEqual([
      PAGE_PAD_Y,
      PAGE_PAD_Y + 792 + PAGE_GAP,
      PAGE_PAD_Y + 2 * (792 + PAGE_GAP)
    ])
    expect(l.totalHeight).toBe(PAGE_PAD_Y * 2 + 3 * 792 + 2 * PAGE_GAP)
  })
  it('places two pages side by side', () => {
    const l = build(4, 'two')
    expect(l.rows).toHaveLength(2)
    expect(l.rows[0].width).toBe(612 * 2 + PAGE_GAP)
    expect(l.pageRow[3]).toBe(1)
  })
  it('scales sizes and uses the tallest page for row height', () => {
    const l = buildLayout(2, [[0, 1]], (i) => (i === 0 ? { w: 100, h: 100 } : { w: 100, h: 300 }), 2)
    expect(l.rows[0].height).toBe(600)
  })
  it('marks pages outside single mode as absent', () => {
    const l = build(5, 'single', 1, 2)
    expect(l.pageRow[2]).toBe(0)
    expect(l.pageRow[0]).toBe(-1)
  })
})

describe('virtualization', () => {
  const l = build(1000)
  it('finds the row at a scroll offset', () => {
    expect(rowAt(l.rows, 0)).toBe(0)
    expect(rowAt(l.rows, l.rows[500].top + 1)).toBe(500)
    expect(rowAt(l.rows, 1e12)).toBe(999)
  })
  it('renders only a small window of a 1000-page document', () => {
    const [a, b] = visibleRows(l.rows, l.rows[400].top, 900, 800)
    expect(b - a).toBeLessThan(6)
    expect(a).toBeLessThanOrEqual(400)
    expect(b).toBeGreaterThanOrEqual(400)
  })
  it('reports the current page from scroll position', () => {
    expect(currentPageAt(l, 0, 800)).toBe(0)
    expect(currentPageAt(l, l.rows[10].top, 800)).toBe(10)
  })
  it('handles an empty layout', () => {
    expect(visibleRows([], 0, 800, 100)).toEqual([0, -1])
    expect(rowAt([], 5)).toBe(-1)
  })
})

describe('zoom', () => {
  it('steps through presets in both directions', () => {
    expect(nextZoomStep(1, 1)).toBe(1.1)
    expect(nextZoomStep(1, -1)).toBe(0.9)
    expect(nextZoomStep(1.05, 1)).toBe(1.1)
    expect(nextZoomStep(8, 1)).toBe(8)
    expect(nextZoomStep(0.1, -1)).toBe(0.1)
  })
  it('fits width and page', () => {
    const input = { containerW: 1000, containerH: 600, ref: letter, columns: 1 }
    const w = fitWidthScale(input)
    expect(w * letter.w).toBeCloseTo(1000 - 32)
    expect(fitPageScale(input)).toBeLessThan(w)
    expect(fitWidthScale({ ...input, columns: 2 }) * letter.w * 2).toBeCloseTo(1000 - 32 - PAGE_GAP)
  })
  it('caps canvas memory at high zoom', () => {
    expect(outputScaleFor(800, 1000, 2)).toBe(2)
    const s = outputScaleFor(8000, 10000, 2)
    expect(8000 * s * (10000 * s)).toBeLessThanOrEqual(16_777_216 + 1)
  })
})
