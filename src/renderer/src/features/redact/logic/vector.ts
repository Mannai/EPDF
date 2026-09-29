import type { Rect } from './geom'

/**
 * Geometry used by the redaction interpreter to decide which drawn shapes (subpaths) reach a mark, and to cut a
 * filled rectangle or polygon along the marks. Coordinates are PDF user space (points, y up).
 */

export type Pt = [number, number]

const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

/** Convex hull (counter-clockwise, no repeated or collinear points; one or two points when degenerate). */
export function convexHull(pts: readonly Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const u: Pt[] = []
  for (const q of p) if (!u.length || u[u.length - 1][0] !== q[0] || u[u.length - 1][1] !== q[1]) u.push(q)
  if (u.length <= 2) return u
  const lower: Pt[] = []
  for (const q of u) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (let i = u.length - 1; i >= 0; i--) {
    const q = u[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  lower.pop()
  upper.pop()
  const h = lower.concat(upper)
  return h.length ? h : [u[0], u[u.length - 1]]
}

/**
 * True when the convex hull of `pts` meets the interior of the rect `m` grown by `r` on every side (merely touching
 * its edge does not count). Separating-axis test over the rect's axes and the hull's edge normals. A point that is not
 * a finite number counts as meeting (such a shape cannot be placed, so it is never trusted).
 */
export function hullMeetsRect(pts: readonly Pt[], m: Rect, r: number): boolean {
  const x0 = m.x0 - r
  const y0 = m.y0 - r
  const x1 = m.x1 + r
  const y1 = m.y1 + r
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!pts.length || maxX <= x0 || minX >= x1 || maxY <= y0 || minY >= y1) return false
  const h = convexHull(pts)
  if (h.length < 2) return true
  const corners: Pt[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ]
  const edges = h.length === 2 ? 1 : h.length
  for (let i = 0; i < edges; i++) {
    const a = h[i]
    const b = h[(i + 1) % h.length]
    const nx = a[1] - b[1]
    const ny = b[0] - a[0]
    let hMin = Infinity
    let hMax = -Infinity
    for (const q of h) {
      const v = q[0] * nx + q[1] * ny
      if (v < hMin) hMin = v
      if (v > hMax) hMax = v
    }
    let cMin = Infinity
    let cMax = -Infinity
    for (const q of corners) {
      const v = q[0] * nx + q[1] * ny
      if (v < cMin) cMin = v
      if (v > cMax) cMax = v
    }
    if (hMax <= cMin || cMax <= hMin) return false
  }
  return true
}

/** Largest singular value of the linear part of a matrix: how much it can stretch a length. */
export function maxStretch(m: readonly number[]): number {
  const [a, b, c, d] = m
  const s = a * a + b * b + c * c + d * d
  const det = a * d - b * c
  return Math.sqrt(Math.max(0, (s + Math.sqrt(Math.max(0, s * s - 4 * det * det))) / 2))
}

/**
 * Miter length / line width at a join between an incoming direction `u` and an outgoing direction `v`
 * (1 / sin(phi / 2), phi the angle between the segments); Infinity for a full reversal.
 */
export function miterRatio(u: Pt, v: Pt): number {
  const lu = Math.hypot(u[0], u[1])
  const lv = Math.hypot(v[0], v[1])
  if (!(lu > 0) || !(lv > 0)) return Infinity
  const dot = (u[0] * v[0] + u[1] * v[1]) / (lu * lv)
  const half = Math.sqrt(Math.max(0, (1 + dot) / 2))
  return half > 1e-12 ? 1 / half : Infinity
}

/** Signed area (positive = counter-clockwise). */
export function polyArea(p: readonly Pt[]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i]
    const b = p[(i + 1) % p.length]
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

/** The part of a convex polygon where `k·x + l·y + c >= 0` (Sutherland-Hodgman, one edge). */
function clipHalf(poly: readonly Pt[], k: number, l: number, c: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const sp = k * p[0] + l * p[1] + c
    const sq = k * q[0] + l * q[1] + c
    if (sp >= 0) out.push(p)
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq)
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])])
    }
  }
  return out
}

/**
 * A convex polygon minus the (disjoint) marks, as convex pieces that do not overlap and that keep the polygon's
 * orientation; pieces thinner than `minArea` are dropped. The pieces cover exactly the polygon outside the marks.
 */
export function subtractMarks(poly: readonly Pt[], marks: readonly Rect[], minArea = 1e-9): Pt[][] {
  const ccw = polyArea(poly) >= 0
  let pieces: Pt[][] = [[...poly]]
  for (const m of marks) {
    const next: Pt[][] = []
    for (const p of pieces) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [x, y] of p) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
      if (maxX <= m.x0 || minX >= m.x1 || maxY <= m.y0 || minY >= m.y1) {
        next.push(p)
        continue
      }
      const left = clipHalf(p, -1, 0, m.x0) // x <= x0
      const right = clipHalf(p, 1, 0, -m.x1) // x >= x1
      const band = clipHalf(clipHalf(p, 1, 0, -m.x0), -1, 0, m.x1) // x0 <= x <= x1
      const below = clipHalf(band, 0, -1, m.y0) // y <= y0
      const above = clipHalf(band, 0, 1, -m.y1) // y >= y1
      for (const q of [left, right, below, above]) if (q.length >= 3 && Math.abs(polyArea(q)) > minArea) next.push(q)
    }
    pieces = next
  }
  return pieces.map((p) => ((polyArea(p) >= 0) === ccw ? p : [...p].reverse()))
}
