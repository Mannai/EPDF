import { convexHull, cross, dist, isConvexQuad, orderQuad, polygonArea, quadAngles, type Pt, type Quad } from './geometry'
import { fitLongSide, gaussianBlur, histogram, morph, otsu, toGray, toMinChannel, type RgbaImage } from './image'

/**
 * Page detection for photographed / scanned sheets: find the largest convex quadrilateral that looks like a
 * sheet of paper. In-house, no OpenCV:
 *
 *  1. shrink to ~400 px, build two "paper-ness" maps (luma and min(R,G,B): coloured desks are dark in the latter)
 *  2. for a ladder of thresholds, take the largest bright blob, fill the holes (text), and turn its convex hull
 *     into the enclosing quadrilateral by repeatedly collapsing the hull edge that adds the least area
 *  3. score each candidate by size, how well the quad matches the blob, and how much *edge* (gradient) lies
 *     along the quad's sides, so shadows and busy backgrounds lose against the real paper boundary.
 */

export interface DetectOptions {
  /** Long side of the working copy. Smaller is faster (live camera preview uses ~256). */
  maxSide?: number
  /** Fewer threshold candidates (live preview). */
  fast?: boolean
}

export interface DetectResult {
  /** Corners TL, TR, BR, BL, normalised to 0..1 of the input image. */
  quad: Quad
  /** 0..1; higher is more convincing. */
  score: number
  /** Fraction of the image covered by the quad. */
  areaFraction: number
}

const MIN_AREA = 0.08
const MAX_AREA = 0.985
const MIN_SCORE = 0.28

export function detectPage(img: RgbaImage, opts: DetectOptions = {}): DetectResult | null {
  const small = fitLongSide(img, opts.maxSide ?? 400)
  const W = small.width
  const H = small.height
  if (W < 24 || H < 24) return null
  const g = toGray(small)
  const m = toMinChannel(small)
  const gb = gaussianBlur(g.data, W, H, 1.5)
  const mb = gaussianBlur(m.data, W, H, 1.5)
  const grad = maxGradient(gb, mb, W, H)

  let best: { quad: Quad; score: number; area: number } | null = null
  const deltas = opts.fast ? [-25, 0, 20] : [-45, -30, -15, 0, 12, 25]
  for (const feature of [gb, mb]) {
    const t0 = otsu(histogram(feature))
    const seen = new Set<number>()
    for (const d of deltas) {
      const t = Math.min(240, Math.max(30, t0 + d))
      if (seen.has(t)) continue
      seen.add(t)
      const mask = new Uint8Array(W * H)
      for (let i = 0; i < mask.length; i++) mask[i] = feature[i] > t ? 1 : 0
      const cand = candidateFromMask(mask, W, H, grad)
      if (cand && (!best || cand.score > best.score)) best = cand
    }
  }
  if (!best || best.score < MIN_SCORE) return null
  const q = best.quad.map((p) => ({ x: p.x / W, y: p.y / H })) as Quad
  return { quad: q, score: best.score, areaFraction: best.area }
}

/** Sobel gradient magnitude (in grey levels per pixel) of the stronger of two maps. */
function maxGradient(a: Float32Array, b: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const sob = (s: Float32Array, x: number, y: number): number => {
    const i = y * w + x
    const gx = s[i - w + 1] + 2 * s[i + 1] + s[i + w + 1] - s[i - w - 1] - 2 * s[i - 1] - s[i + w - 1]
    const gy = s[i + w - 1] + 2 * s[i + w] + s[i + w + 1] - s[i - w - 1] - 2 * s[i - w] - s[i - w + 1]
    return Math.hypot(gx, gy) / 4
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) out[y * w + x] = Math.max(sob(a, x, y), sob(b, x, y))
  return out
}

function candidateFromMask(maskIn: Uint8Array, w: number, h: number, grad: Float32Array): { quad: Quad; score: number; area: number } | null {
  // open with a 3x3 square so thin bridges between the paper and bright clutter are cut
  const f = Float32Array.from(maskIn)
  const opened = morph(morph(f, w, h, 1, false), w, h, 1, true)
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) mask[i] = opened[i] > 0.5 ? 1 : 0

  const comp = largestComponent(mask, w, h)
  if (!comp) return null
  fillHoles(comp.mask, w, h)
  let area = 0
  const corners: Pt[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!comp.mask[y * w + x]) continue
      area++
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !comp.mask[y * w + x - 1] || !comp.mask[y * w + x + 1] || !comp.mask[(y - 1) * w + x] || !comp.mask[(y + 1) * w + x]
      if (edge) corners.push({ x, y }, { x: x + 1, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 })
    }
  }
  const areaFraction = area / (w * h)
  if (areaFraction < MIN_AREA * 0.8 || areaFraction > 1) return null
  const hull = convexHull(corners)
  const quad = hullToQuad(hull, w, h)
  if (!quad) return null
  const qArea = polygonArea(quad)
  const qFraction = qArea / (w * h)
  if (qFraction < MIN_AREA || qFraction > MAX_AREA) return null
  const minDim = Math.min(w, h)
  for (let i = 0; i < 4; i++) if (dist(quad[i], quad[(i + 1) % 4]) < 0.1 * minDim) return null
  if (quadAngles(quad).some((a) => a < 40 || a > 140)) return null

  const fit = Math.min(1, area / qArea)
  const support = edgeSupport(quad, grad, w, h)
  const score = Math.sqrt(qFraction) * fit * (0.2 + 0.8 * support)
  return { quad, score, area: qFraction }
}

/** Largest 4-connected component of `mask` as its own mask. */
function largestComponent(mask: Uint8Array, w: number, h: number): { mask: Uint8Array; area: number } | null {
  const label = new Int32Array(w * h)
  const stack: number[] = []
  let bestLabel = 0
  let bestArea = 0
  let next = 0
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue
    next++
    let area = 0
    stack.push(s)
    label[s] = next
    while (stack.length) {
      const i = stack.pop()!
      area++
      const x = i % w
      const y = (i - x) / w
      if (x > 0 && mask[i - 1] && !label[i - 1]) (label[i - 1] = next), stack.push(i - 1)
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) (label[i + 1] = next), stack.push(i + 1)
      if (y > 0 && mask[i - w] && !label[i - w]) (label[i - w] = next), stack.push(i - w)
      if (y < h - 1 && mask[i + w] && !label[i + w]) (label[i + w] = next), stack.push(i + w)
    }
    if (area > bestArea) {
      bestArea = area
      bestLabel = next
    }
  }
  if (!bestLabel) return null
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = label[i] === bestLabel ? 1 : 0
  return { mask: out, area: bestArea }
}

/** Sets every 0 pixel that cannot reach the image border through 0 pixels to 1 (text inside the paper). */
function fillHoles(mask: Uint8Array, w: number, h: number): void {
  const reach = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (i: number): void => {
    if (!mask[i] && !reach[i]) {
      reach[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) (push(x), push((h - 1) * w + x))
  for (let y = 0; y < h; y++) (push(y * w), push(y * w + w - 1))
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    const y = (i - x) / w
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (y > 0) push(i - w)
    if (y < h - 1) push(i + w)
  }
  for (let i = 0; i < mask.length; i++) if (!mask[i] && !reach[i]) mask[i] = 1
}

/** Drops vertices that are nearly collinear with their neighbours. */
function simplifyPolygon(poly: Pt[], eps: number): Pt[] {
  let p = poly
  let changed = true
  while (changed && p.length > 4) {
    changed = false
    for (let i = 0; i < p.length && p.length > 4; i++) {
      const a = p[(i + p.length - 1) % p.length]
      const b = p[i]
      const c = p[(i + 1) % p.length]
      const len = dist(a, c) || 1
      if (Math.abs(cross(a, c, b)) / len < eps) {
        p = p.filter((_, k) => k !== i)
        changed = true
        i--
      }
    }
  }
  return p
}

/**
 * The convex polygon reduced to four sides by collapsing, one at a time, the edge whose removal (extending the two
 * neighbouring sides until they meet) adds the least area. Result encloses the hull.
 */
export function hullToQuad(hull: Pt[], w: number, h: number): Quad | null {
  let poly = simplifyPolygon(hull, 0.6)
  if (poly.length < 4) return null
  const limit = Math.max(w, h) * 1.3
  while (poly.length > 4) {
    const n = poly.length
    let bestI = -1
    let bestQ: Pt | null = null
    let bestAdd = Infinity
    for (let i = 0; i < n; i++) {
      const a = poly[(i + n - 1) % n]
      const p = poly[i]
      const q = poly[(i + 1) % n]
      const d = poly[(i + 2) % n]
      const d1 = { x: p.x - a.x, y: p.y - a.y }
      const d2 = { x: q.x - d.x, y: q.y - d.y }
      const den = d1.x * d2.y - d1.y * d2.x
      if (Math.abs(den) < 1e-9) continue
      const pq = { x: q.x - p.x, y: q.y - p.y }
      const t = (pq.x * d2.y - pq.y * d2.x) / den
      const s = (pq.x * d1.y - pq.y * d1.x) / den
      if (t <= 0 || s <= 0) continue
      const x = { x: p.x + t * d1.x, y: p.y + t * d1.y }
      if (x.x < -limit || x.y < -limit || x.x > limit * 2 || x.y > limit * 2) continue
      const add = Math.abs(cross(p, x, q)) / 2
      if (add < bestAdd) {
        bestAdd = add
        bestI = i
        bestQ = x
      }
    }
    if (bestI < 0 || !bestQ) {
      // No side can be collapsed outward (nearly parallel neighbours): drop the sharpest-cornered vertex instead.
      let vi = 0
      let va = Infinity
      for (let i = 0; i < n; i++) {
        const t = Math.abs(cross(poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n])) / 2
        if (t < va) (va = t), (vi = i)
      }
      poly = poly.filter((_, k) => k !== vi)
      continue
    }
    const next: Pt[] = []
    for (let k = 0; k < n; k++) {
      if (k === bestI) next.push(bestQ)
      else if (k !== (bestI + 1) % n) next.push(poly[k])
    }
    poly = next
  }
  const q = orderQuad(poly)
  return isConvexQuad(q) ? q : null
}

/** 0..1: how much of the quad's outline runs along real image edges (image-border stretches count half). */
function edgeSupport(q: Quad, grad: Float32Array, w: number, h: number): number {
  const thresh = 10
  let total = 0
  let sum = 0
  for (let e = 0; e < 4; e++) {
    const a = q[e]
    const b = q[(e + 1) % 4]
    const n = Math.max(4, Math.round(dist(a, b) / 2))
    let hit = 0
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      if (x < 2 || y < 2 || x > w - 2 || y > h - 2) {
        hit += 0.5
        continue
      }
      let mx = 0
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mx = Math.max(mx, grad[Math.min(h - 1, Math.max(0, Math.round(y) + dy)) * w + Math.min(w - 1, Math.max(0, Math.round(x) + dx))])
      if (mx > thresh) hit += 1
    }
    sum += hit / n
    total++
  }
  return sum / total
}
