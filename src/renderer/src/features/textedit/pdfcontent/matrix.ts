/** 2D affine matrices in PDF's row-vector convention: [a b c d e f], point (x y 1) × M. */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** `mul(m, n)` = m × n: apply `m` first, then `n` (so `cm` sets CTM' = mul(operand, CTM)). */
export function mul(m: readonly number[], n: readonly number[]): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5]
  ]
}

export const det = (m: readonly number[]): number => m[0] * m[3] - m[1] * m[2]

/** Inverse, or null for a singular matrix. */
export function invert(m: readonly number[]): Matrix | null {
  const d = det(m)
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d
  ]
}

export const apply = (m: readonly number[], x: number, y: number): [number, number] => [
  x * m[0] + y * m[2] + m[4],
  x * m[1] + y * m[3] + m[5]
]

export const translate = (tx: number, ty: number): Matrix => [1, 0, 0, 1, tx, ty]
export const scale = (sx: number, sy: number): Matrix => [sx, 0, 0, sy, 0, 0]

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Axis-aligned bounds of the image of the rectangle [x0,y0]-[x1,y1] under `m`. */
export function transformRect(m: readonly number[], x0: number, y0: number, x1: number, y1: number): Rect {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

export const rectsOverlap = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x0 < b.x1 - pad && b.x0 < a.x1 - pad && a.y0 < b.y1 - pad && b.y0 < a.y1 - pad

export const approx = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps

export const isFiniteMatrix = (m: readonly number[]): boolean => m.length === 6 && m.every((v) => Number.isFinite(v))
