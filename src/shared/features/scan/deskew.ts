import { bwThreshold, flattenGray } from './enhance'
import { fitLongSide, toGray, type RgbaImage } from './image'

/**
 * Text-line skew estimation with a projection profile: for each candidate angle the ink pixels are projected
 * onto the vertical axis; lines of text produce a sharply peaked histogram exactly when the angle matches.
 *
 * The result is the angle of the text lines in degrees, positive when they descend to the right (clockwise on
 * screen). Undo it with `rotateDegrees(img, -degrees)`.
 */
export interface SkewResult {
  degrees: number
  /** 0 = no evidence of text lines; > ~1.5 is a convincing peak. */
  confidence: number
}

export function estimateSkew(img: RgbaImage, maxAngle = 15): SkewResult {
  const small = fitLongSide(img, 900)
  const { width: w, height: h } = small
  const flat = flattenGray(toGray(small).data, w, h, 0.05)
  const t = bwThreshold(flat, -10)
  const xs: number[] = []
  const ys: number[] = []
  const total = w * h
  let inkCount = 0
  for (let i = 0; i < total; i++) if (flat[i] < t) inkCount++
  if (inkCount < 300 || inkCount > total * 0.6) return { degrees: 0, confidence: 0 }
  const stride = Math.max(1, Math.floor(inkCount / 60000))
  let seen = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (flat[y * w + x] < t && seen++ % stride === 0) {
        xs.push(x)
        ys.push(y)
      }
    }
  }
  const n = xs.length
  const maxSin = Math.sin((Math.min(maxAngle, 30) * Math.PI) / 180) + 0.02
  const bins = new Float32Array(Math.ceil(h + w * maxSin * 2) + 4)
  const offset = w * maxSin + 1
  const score = (deg: number): number => {
    const a = (deg * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    bins.fill(0)
    for (let i = 0; i < n; i++) bins[(ys[i] * c - xs[i] * s + offset) | 0]++
    let sum = 0
    for (let i = 0; i < bins.length; i++) sum += bins[i] * bins[i]
    return sum
  }
  let best = 0
  let bestScore = -1
  const coarse: number[] = []
  for (let d = -maxAngle; d <= maxAngle + 1e-9; d += 0.5) {
    const sc = score(d)
    coarse.push(sc)
    if (sc > bestScore) {
      bestScore = sc
      best = d
    }
  }
  const mean = [...coarse].sort((a, b) => a - b)[Math.floor(coarse.length / 2)]
  let fine = best
  let fineScore = bestScore
  for (let d = best - 0.5; d <= best + 0.5 + 1e-9; d += 0.05) {
    const sc = score(d)
    if (sc > fineScore) {
      fineScore = sc
      fine = d
    }
  }
  const confidence = mean > 0 ? fineScore / mean - 1 : 0
  return { degrees: Math.round(fine * 100) / 100, confidence }
}
