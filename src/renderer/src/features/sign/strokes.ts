/**
 * Pure logic for the "draw your signature" pad: point filtering (smoothing), pressure → width, bounds and
 * rendering onto any 2D-context-like object. No DOM, so it is unit-tested in Node.
 */

export interface Pt {
  x: number
  y: number
  /** 0..1. Mouse and trackpad report a constant 0.5 (or 0); only pens vary. */
  p: number
}
export type Stroke = Pt[]

/** The subset of CanvasRenderingContext2D that rendering needs (so tests can pass a recorder). */
export interface Ctx2D {
  lineWidth: number
  lineCap: string
  lineJoin: string
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number): void
  stroke(): void
  fill(): void
}

export interface InkOptions {
  /** Line width in px for a mouse (or a pen at half pressure). */
  width: number
  /** Vary the width with pen pressure. */
  pressure: boolean
  color: string
}

/**
 * Drops points closer than `minDist` to the previous kept one (removes hand jitter and duplicate events)
 * while always keeping the first and last point, so a stroke never loses its ends.
 */
export function simplifyStroke(points: readonly Pt[], minDist = 1.5): Stroke {
  if (points.length <= 2) return [...points]
  const out: Pt[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1]
    if (Math.hypot(points[i].x - last.x, points[i].y - last.y) >= minDist) out.push(points[i])
  }
  out.push(points[points.length - 1])
  return out
}

/** Line width for a point: constant unless the input device is a pen and pressure is enabled. */
export function widthFor(base: number, pressure: number, usePressure: boolean): number {
  if (!usePressure || !(pressure > 0)) return base
  // 0.35x (feather touch) .. 1.65x (hard press); a mouse's fixed 0.5 maps to exactly `base`.
  return base * (0.35 + 1.3 * Math.min(1, Math.max(0, pressure)))
}

/** Bounding box of all ink including half the line width; null when there is nothing drawn. */
export function inkBounds(strokes: readonly Stroke[], width: number): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of strokes) {
    for (const p of s) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  if (!isFinite(minX)) return null
  const pad = width * 1.65
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad }
}

/**
 * Draws strokes as smooth curves: each segment is a quadratic Bézier from one midpoint to the next with
 * the real point as control point (the standard way to smooth freehand input). A single tap is a dot.
 * `scale` maps pad coordinates to canvas pixels.
 */
export function renderStrokes(ctx: Ctx2D, strokes: readonly Stroke[], opts: InkOptions, scale = 1): void {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = opts.color
  ctx.fillStyle = opts.color
  for (const stroke of strokes) {
    if (stroke.length === 0) continue
    if (stroke.length === 1) {
      const p = stroke[0]
      ctx.beginPath()
      ctx.arc(p.x * scale, p.y * scale, (widthFor(opts.width, p.p, opts.pressure) * scale) / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    let prevMid = { x: stroke[0].x, y: stroke[0].y }
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1]
      const b = stroke[i]
      const mid = i === stroke.length - 1 ? { x: b.x, y: b.y } : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      ctx.lineWidth = widthFor(opts.width, (a.p + b.p) / 2, opts.pressure) * scale
      ctx.beginPath()
      ctx.moveTo(prevMid.x * scale, prevMid.y * scale)
      ctx.quadraticCurveTo(a.x * scale, a.y * scale, mid.x * scale, mid.y * scale)
      ctx.stroke()
      prevMid = mid
    }
  }
}
