import { PageFrame, normRotation } from './frame'
import { type URect, normRect } from './spec'

/**
 * Arranging several selected fields: align, distribute, same size. Rectangles are in user space; the maths
 * runs in the page as the reader sees it, so "left" is the reader's left even on rotated pages.
 */

export interface Item {
  id: string
  rect: URect
  /** Page /Rotate. */
  rotation: number
}

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter'

interface V {
  id: string
  x0: number
  y0: number
  x1: number
  y1: number
}

const FRAME_SIZE = 100000

const frameOf = (rotation: number): PageFrame => new PageFrame([0, 0, FRAME_SIZE, FRAME_SIZE], normRotation(rotation))

const toV = (i: Item): V => {
  const r = normRect(i.rect)
  const b = frameOf(i.rotation).boxToVisual({ x0: r.x1, y0: r.y1, x1: r.x2, y1: r.y2 })
  return { id: i.id, ...b }
}

const fromV = (v: V, rotation: number): URect => {
  const b = frameOf(rotation).boxToUser(v)
  return { x1: b.x0, y1: b.y0, x2: b.x1, y2: b.y1 }
}

function run(items: Item[], fn: (vs: V[]) => V[]): Map<string, URect> {
  const rot = new Map(items.map((i) => [i.id, i.rotation]))
  const out = new Map<string, URect>()
  for (const v of fn(items.map(toV))) out.set(v.id, fromV(v, rot.get(v.id) ?? 0))
  return out
}

/** New rectangles (by id) after aligning to the edge or centre line of the whole selection. */
export function align(items: Item[], mode: AlignMode): Map<string, URect> {
  if (items.length < 2) return new Map()
  return run(items, (vs) => {
    const left = Math.min(...vs.map((v) => v.x0))
    const right = Math.max(...vs.map((v) => v.x1))
    const bottom = Math.min(...vs.map((v) => v.y0))
    const top = Math.max(...vs.map((v) => v.y1))
    return vs.map((v) => {
      const w = v.x1 - v.x0
      const h = v.y1 - v.y0
      switch (mode) {
        case 'left':
          return { ...v, x0: left, x1: left + w }
        case 'right':
          return { ...v, x0: right - w, x1: right }
        case 'hcenter':
          return { ...v, x0: (left + right) / 2 - w / 2, x1: (left + right) / 2 + w / 2 }
        case 'top':
          return { ...v, y0: top - h, y1: top }
        case 'bottom':
          return { ...v, y0: bottom, y1: bottom + h }
        case 'vcenter':
          return { ...v, y0: (bottom + top) / 2 - h / 2, y1: (bottom + top) / 2 + h / 2 }
      }
    })
  })
}

/** Spreads three or more items so the gaps between them are equal (the outermost two stay put). */
export function distribute(items: Item[], axis: 'horizontal' | 'vertical'): Map<string, URect> {
  if (items.length < 3) return new Map()
  return run(items, (vs) => {
    const horizontal = axis === 'horizontal'
    const lo = (v: V): number => (horizontal ? v.x0 : v.y0)
    const hi = (v: V): number => (horizontal ? v.x1 : v.y1)
    const sorted = [...vs].sort((a, b) => lo(a) - lo(b))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const total = hi(last) - lo(first)
    const sizes = sorted.reduce((s, v) => s + (hi(v) - lo(v)), 0)
    const gap = (total - sizes) / (sorted.length - 1)
    let pos = lo(first)
    return sorted.map((v) => {
      const size = hi(v) - lo(v)
      const moved = horizontal ? { ...v, x0: pos, x1: pos + size } : { ...v, y0: pos, y1: pos + size }
      pos += size + gap
      return moved
    })
  })
}

/** Gives every item the width and/or height of the first one. */
export function sameSize(items: Item[], dim: 'width' | 'height' | 'both'): Map<string, URect> {
  if (items.length < 2) return new Map()
  return run(items, (vs) => {
    const ref = vs[0]
    return vs.map((v, i) => {
      if (i === 0) return v
      const out = { ...v }
      if (dim !== 'height') out.x1 = out.x0 + (ref.x1 - ref.x0)
      if (dim !== 'width') out.y0 = out.y1 - (ref.y1 - ref.y0)
      return out
    })
  })
}

/** Moves items by a visual offset (right/up positive, in points). */
export function nudge(items: Item[], dx: number, dy: number): Map<string, URect> {
  return run(items, (vs) => vs.map((v) => ({ ...v, x0: v.x0 + dx, x1: v.x1 + dx, y0: v.y0 + dy, y1: v.y1 + dy })))
}

/** Resizes items by moving their visual right/bottom edge (dx to the right, dy upwards), keeping a minimum size. */
export function resizeBy(items: Item[], dx: number, dy: number, min = 4): Map<string, URect> {
  return run(items, (vs) =>
    vs.map((v) => {
      const w = Math.max(min, v.x1 - v.x0 + dx)
      const h = Math.max(min, v.y1 - v.y0 - dy)
      return { ...v, x1: v.x0 + w, y0: v.y1 - h }
    })
  )
}
