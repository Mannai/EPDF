import { sampleBilinear, type RgbaImage } from './image'

/** Planar geometry + homography used to rectify a photographed page. */

export interface Pt {
  x: number
  y: number
}

/** Four corners in the order top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt]

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

export const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

/** Shoelace area (absolute). */
export function polygonArea(p: readonly Pt[]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i]
    const b = p[(i + 1) % p.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

/** Andrew's monotone chain. Returns the hull counter-clockwise in a y-up view (clockwise on screen). */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const uniq: Pt[] = []
  for (const p of pts) if (!uniq.length || uniq[uniq.length - 1].x !== p.x || uniq[uniq.length - 1].y !== p.y) uniq.push(p)
  if (uniq.length < 3) return uniq
  const lower: Pt[] = []
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** Orders four points as TL, TR, BR, BL (image coordinates, y down), whatever order they came in. */
export function orderQuad(points: readonly Pt[]): Quad {
  if (points.length !== 4) throw new Error('A quadrilateral needs four corners')
  const cx = points.reduce((s, p) => s + p.x, 0) / 4
  const cy = points.reduce((s, p) => s + p.y, 0) / 4
  // clockwise on screen starting from the corner closest to the top-left
  const byAngle = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  // atan2 sorted ascending is clockwise on screen (y down). Start at the smallest x+y.
  let start = 0
  for (let i = 1; i < 4; i++) if (byAngle[i].x + byAngle[i].y < byAngle[start].x + byAngle[start].y) start = i
  return [byAngle[start], byAngle[(start + 1) % 4], byAngle[(start + 2) % 4], byAngle[(start + 3) % 4]]
}

export function isConvexQuad(q: Quad): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4])
    if (Math.abs(c) < 1e-9) return false
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** Interior angles in degrees. */
export function quadAngles(q: Quad): number[] {
  return q.map((p, i) => {
    const a = q[(i + 3) % 4]
    const b = q[(i + 1) % 4]
    const v1 = { x: a.x - p.x, y: a.y - p.y }
    const v2 = { x: b.x - p.x, y: b.y - p.y }
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1)
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  })
}

export const scaleQuad = (q: Quad, sx: number, sy: number): Quad => q.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad

/** Average lengths of the top/bottom and left/right edges: the size of the rectified page in source pixels. */
export function quadSize(q: Quad): { width: number; height: number } {
  return { width: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, height: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2 }
}

/** Solves an n x n linear system in place with partial pivoting. Returns null if singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r
    if (Math.abs(a[p][c]) < 1e-12) return null
    ;[a[c], a[p]] = [a[p], a[c]]
    ;[b[c], b[p]] = [b[p], b[c]]
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c]
      for (let k = c; k < n; k++) a[r][k] -= f * a[c][k]
      b[r] -= f * b[c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let k = r + 1; k < n; k++) s -= a[r][k] * x[k]
    x[r] = s / a[r][r]
  }
  return x
}

/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

/** The homography H (h33 = 1) with H * src[i] ~ dst[i] for four point pairs. Null for degenerate input. */
export function solveHomography(src: readonly Pt[], dst: readonly Pt[]): Mat3 | null {
  const a: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  const h = solveLinear(a, b)
  return h ? ([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] as Mat3) : null
}

export function applyHomography(h: Mat3, x: number, y: number): Pt {
  const w = h[6] * x + h[7] * y + h[8]
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w }
}

/**
 * Warps the quadrilateral `quad` (source pixel coordinates, TL/TR/BR/BL) of `src` onto an upright
 * `outW x outH` rectangle with bilinear sampling. Returns null if the quad is degenerate.
 */
export function warpPerspective(src: RgbaImage, quad: Quad, outW: number, outH: number): RgbaImage | null {
  outW = Math.max(1, Math.round(outW))
  outH = Math.max(1, Math.round(outH))
  // map destination rectangle corners -> source quad (inverse mapping for sampling)
  const rect: Quad = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH }
  ]
  const h = solveHomography(rect, quad)
  if (!h) return null
  const out = new Uint8ClampedArray(outW * outH * 4)
  const { width: sw, height: sh, data } = src
  for (let y = 0; y < outH; y++) {
    const py = y + 0.5
    for (let x = 0; x < outW; x++) {
      const px = x + 0.5
      const w = h[6] * px + h[7] * py + 1
      const sx = (h[0] * px + h[1] * py + h[2]) / w
      const sy = (h[3] * px + h[4] * py + h[5]) / w
      const o = (y * outW + x) * 4
      out[o] = sampleBilinear(data, sw, sh, sx, sy, 0)
      out[o + 1] = sampleBilinear(data, sw, sh, sx, sy, 1)
      out[o + 2] = sampleBilinear(data, sw, sh, sx, sy, 2)
      out[o + 3] = 255
    }
  }
  return { width: outW, height: outH, data: out }
}

/** A quad covering the whole image, optionally inset by a fraction of each side. */
export function fullQuad(inset = 0): Quad {
  return [
    { x: inset, y: inset },
    { x: 1 - inset, y: inset },
    { x: 1 - inset, y: 1 - inset },
    { x: inset, y: 1 - inset }
  ]
}

/** Rotates normalised coordinates (0..1) by whole quarter turns clockwise and re-orders the corners. */
export function rotateQuadQuarterTurns(q: Quad, turns: number): Quad {
  const t = ((turns % 4) + 4) % 4
  let pts = q.map((p) => ({ ...p }))
  for (let i = 0; i < t; i++) pts = pts.map((p) => ({ x: 1 - p.y, y: p.x }))
  return orderQuad(pts)
}

/** True if every corner is within [0,1] (with a little slack). */
export const quadInsideUnit = (q: Quad, slack = 0.001): boolean => q.every((p) => p.x >= -slack && p.x <= 1 + slack && p.y >= -slack && p.y <= 1 + slack)

export const clampQuad = (q: Quad): Quad => q.map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) })) as Quad
