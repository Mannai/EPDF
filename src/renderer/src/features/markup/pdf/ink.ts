import type { Pt } from './geometry'

/** Freehand stroke processing: Douglas-Peucker simplification + Catmull-Rom smoothing. Pure. */

/** Removes points that deviate less than `epsilon` from the straight line between kept neighbours. */
export function simplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length <= 2) return points.slice()
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = keep[points.length - 1] = true
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let maxD = 0
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(points[i], points[a], points[b])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (idx >= 0 && maxD > epsilon) {
      keep[idx] = true
      stack.push([a, idx], [idx, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Samples a Catmull-Rom spline through `points` (endpoints preserved exactly). */
export function catmullRom(points: Pt[], samplesPerSegment: number): Pt[] {
  if (points.length < 3 || samplesPerSegment < 2) return points.slice()
  const out: Pt[] = [points[0]]
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    for (let s = 1; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push(s === samplesPerSegment ? p2 : [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  return out
}

/**
 * Turns raw pointer samples into a smooth stroke. `smoothing` 0..1: 0 keeps the samples untouched, 1
 * simplifies aggressively and interpolates a spline. A single click becomes a short dot so round caps
 * draw it. Coordinates are in whatever unit the caller uses (PDF points).
 */
export function smoothStroke(raw: Pt[], smoothing = 0.5): Pt[] {
  const pts = dedupe(raw)
  if (pts.length === 0) return []
  if (pts.length === 1) return [pts[0], [pts[0][0] + 0.01, pts[0][1]]]
  const s = Math.min(1, Math.max(0, Number.isFinite(smoothing) ? smoothing : 0))
  if (s === 0) return pts
  const simplified = simplify(pts, 0.15 + s * 1.2)
  if (simplified.length === 2) return simplified
  return catmullRom(simplified, Math.max(2, Math.round(2 + s * 6)))
}

function dedupe(points: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue
    const last = out[out.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p)
  }
  return out
}
