import { createRgba, sampleBilinear, type RgbaImage } from '../../src/shared/features/scan/image'
import type { Pt, Quad } from '../../src/shared/features/scan/geometry'

/**
 * Synthetic "photo of a page" generator for the scanning tests. The projection is built from an explicit 3x3
 * matrix (rotation, scale, translation, perspective terms) and inverted analytically, so it is independent of the
 * homography solver under test. The known page corners in the photo are returned with the image.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A white page with justified "text": rows of dark word blocks, a heading and a paragraph gap. Deterministic. */
export function renderTextPage(width = 620, height = 877, seed = 7): RgbaImage {
  const img = createRgba(width, height, [246, 245, 240])
  const rnd = mulberry32(seed)
  const rect = (x0: number, y0: number, w: number, h: number, v: number): void => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const o = (y * width + x) * 4
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v
      }
  }
  const margin = 56
  // heading
  rect(margin, 60, 300, 26, 25)
  let y = 120
  while (y < height - margin - 12) {
    if (Math.floor((y - 120) / 22) % 9 === 8) {
      y += 22
      continue
    }
    let x = margin
    while (x < width - margin - 30) {
      const w = 18 + Math.floor(rnd() * 46)
      if (x + w > width - margin) break
      rect(x, y, w, 9, 30 + Math.floor(rnd() * 30))
      x += w + 8
    }
    y += 22
  }
  return img
}

export interface PhotoSpec {
  width: number
  height: number
  /** Page rotation in the photo, degrees clockwise. */
  angle: number
  /** Scale of the page (photo px per page px). */
  scale: number
  /** Photo-space position of the page's top-left before rotation is applied: centre of the page. */
  centre?: Pt
  /** Perspective terms (small, e.g. 0.0004). */
  perspective?: { g: number; h: number }
  /** 0..0.7 darkening ramp across the photo (a shadow falling over one side). */
  shadow?: { strength: number; angle: number }
  noise?: number
  background?: 'wood' | 'dark' | 'busy' | 'grey'
  seed?: number
}

export interface Photo {
  image: RgbaImage
  /** True page corners in the photo, normalised 0..1: TL, TR, BR, BL of the *page*. */
  corners: Quad
  /** The 3x3 matrix (page px -> photo px), row-major. */
  matrix: number[]
}

const inv3 = (m: number[]): number[] => {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}

const apply3 = (m: number[], x: number, y: number): Pt => {
  const w = m[6] * x + m[7] * y + m[8]
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w }
}

export function photographPage(page: RgbaImage, spec: PhotoSpec): Photo {
  const { width: W, height: H } = spec
  const rnd = mulberry32(spec.seed ?? 1)
  const a = (spec.angle * Math.PI) / 180
  const s = spec.scale
  const cx = spec.centre?.x ?? W / 2
  const cy = spec.centre?.y ?? H / 2
  const g = spec.perspective?.g ?? 0
  const h = spec.perspective?.h ?? 0
  // page px (centred) -> photo px
  const pcx = page.width / 2
  const pcy = page.height / 2
  const R = [s * Math.cos(a), -s * Math.sin(a), 0, s * Math.sin(a), s * Math.cos(a), 0, g, h, 1]
  // H = T(cx,cy) * R * T(-pcx,-pcy), as one row-major matrix
  const t1 = [1, 0, -pcx, 0, 1, -pcy, 0, 0, 1]
  const mul = (p: number[], q: number[]): number[] => {
    const o = new Array<number>(9).fill(0)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += p[r * 3 + k] * q[k * 3 + c]
    return o
  }
  const M = mul([1, 0, cx, 0, 1, cy, 0, 0, 1], mul(R, t1))
  const Minv = inv3(M)
  const out = createRgba(W, H)
  const bg = spec.background ?? 'wood'
  const bgNoise = new Float32Array(W * H)
  for (let i = 0; i < bgNoise.length; i++) bgNoise[i] = rnd()
  const blobs: { x: number; y: number; r: number; v: number }[] = []
  if (bg === 'busy') for (let i = 0; i < 14; i++) blobs.push({ x: rnd() * W, y: rnd() * H, r: 15 + rnd() * 50, v: 40 + rnd() * 190 })
  const sh = spec.shadow
  const shx = sh ? Math.cos((sh.angle * Math.PI) / 180) : 0
  const shy = sh ? Math.sin((sh.angle * Math.PI) / 180) : 0
  const SS = 2
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0
      let gg = 0
      let b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          const u = apply3(Minv, px, py)
          let cr: number
          let cg: number
          let cb: number
          if (u.x >= 0 && u.y >= 0 && u.x < page.width && u.y < page.height) {
            cr = sampleBilinear(page.data, page.width, page.height, u.x, u.y, 0)
            cg = sampleBilinear(page.data, page.width, page.height, u.x, u.y, 1)
            cb = sampleBilinear(page.data, page.width, page.height, u.x, u.y, 2)
          } else if (bg === 'wood') {
            const stripe = 0.5 + 0.5 * Math.sin(px * 0.05 + Math.sin(py * 0.013) * 4)
            const n = bgNoise[y * W + x]
            cr = 104 + 34 * stripe + 18 * n
            cg = 70 + 24 * stripe + 12 * n
            cb = 44 + 14 * stripe + 8 * n
          } else if (bg === 'dark') {
            const n = bgNoise[y * W + x]
            cr = cg = cb = 38 + 22 * n
          } else if (bg === 'grey') {
            const n = bgNoise[y * W + x]
            cr = cg = cb = 120 + 20 * n
          } else {
            const n = bgNoise[y * W + x]
            let v = 70 + 40 * n + 25 * Math.sin(px * 0.021) * Math.cos(py * 0.017)
            for (const bl of blobs) if (Math.hypot(px - bl.x, py - bl.y) < bl.r) v = bl.v
            cr = v * 1.1
            cg = v * 0.9
            cb = v * 0.75
          }
          r += cr
          gg += cg
          b += cb
        }
      }
      const inv = 1 / (SS * SS)
      let f = 1
      if (sh) {
        // linear ramp from 1 down to (1 - strength) across the diagonal, along the shadow direction
        const t = ((x - W / 2) * shx + (y - H / 2) * shy) / (Math.hypot(W, H) / 2)
        f = 1 - sh.strength * Math.min(1, Math.max(0, (t + 1) / 2))
      }
      const o = (y * W + x) * 4
      const nz = spec.noise ? (rnd() + rnd() + rnd() - 1.5) * spec.noise : 0
      out.data[o] = r * inv * f + nz
      out.data[o + 1] = gg * inv * f + nz
      out.data[o + 2] = b * inv * f + nz
    }
  }
  const corners = [
    apply3(M, 0, 0),
    apply3(M, page.width, 0),
    apply3(M, page.width, page.height),
    apply3(M, 0, page.height)
  ].map((p) => ({ x: p.x / W, y: p.y / H })) as Quad
  return { image: out, corners, matrix: M }
}

/** Mean absolute difference between two same-sized images (all channels), 0..255. */
export function meanAbsDiff(a: RgbaImage, b: RgbaImage): number {
  let s = 0
  for (let i = 0; i < a.data.length; i += 4) s += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3
  return s / (a.data.length / 4)
}
