/**
 * Pure pixel helpers used before recognition (grayscale, contrast, skew detection). They work on plain typed
 * arrays so they can be tested in Node and run on canvas data in the renderer.
 */

/** RGBA -> 8-bit luma (Rec. 601). */
export function toGrayscale(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114 + 500) / 1000
  return out
}

/** Grayscale -> RGBA (opaque), for putting a processed page back on a canvas. */
export function grayToRgba(gray: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gray.length * 4)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    out[p] = out[p + 1] = out[p + 2] = gray[i]
    out[p + 3] = 255
  }
  return out
}

/**
 * Linear contrast stretch between the 1st and 99.5th percentile of the histogram, in place. A page that already
 * spans black to white is left alone. Returns true when it changed the pixels.
 */
export function autoContrast(gray: Uint8Array): boolean {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const total = gray.length
  let lo = 0
  let acc = 0
  while (lo < 255 && acc + hist[lo] < total * 0.01) acc += hist[lo++]
  let hi = 255
  acc = 0
  while (hi > 0 && acc + hist[hi] < total * 0.005) acc += hist[hi--]
  if (hi - lo < 16) return false // flat page: stretching would only amplify noise
  if (lo <= 8 && hi >= 247) return false
  const scale = 255 / (hi - lo)
  for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, Math.round((gray[i] - lo) * scale)))
  return true
}

/** Otsu's threshold of a grayscale image (pixels <= result are "ink"). */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const total = gray.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let best = 0
  let bestT = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (between > best) {
      best = between
      bestT = t
    }
  }
  return bestT
}

export interface SkewEstimate {
  /** Radians. Positive = text lines run downhill to the right (clockwise tilt on screen). */
  angle: number
  /** Sharpness of the best projection relative to the unrotated one (1 = no evidence). */
  confidence: number
}

/**
 * Finds the tilt of the text lines by projection profiles: for each candidate angle the ink is sheared and its
 * row histogram measured; text lines give tall narrow peaks exactly when the shear cancels the tilt.
 * Searches +-`maxDegrees` (default 8) coarsely, then refines.
 */
export function estimateSkew(gray: Uint8Array, width: number, height: number, maxDegrees = 8): SkewEstimate {
  // Downsample so the search stays cheap on 300 dpi pages.
  const step = Math.max(1, Math.floor(Math.max(width, height) / 900))
  const t = otsuThreshold(gray)
  const xs: number[] = []
  const ys: number[] = []
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (gray[y * width + x] <= t - 10 && gray[y * width + x] < 200) {
        xs.push(x / step)
        ys.push(y / step)
      }
    }
  }
  if (xs.length < 300) return { angle: 0, confidence: 1 }
  // Keep the work bounded on very dense pages.
  const stride = Math.max(1, Math.floor(xs.length / 80000))
  const h = Math.ceil(height / step)
  const w = Math.ceil(width / step)
  const bins = h + w + 8
  const hist = new Float64Array(bins)
  const score = (deg: number): number => {
    const k = Math.tan((deg * Math.PI) / 180)
    hist.fill(0)
    for (let i = 0; i < xs.length; i += stride) {
      const yy = Math.round(ys[i] - xs[i] * k + w + 4)
      if (yy >= 0 && yy < bins) hist[yy]++
    }
    let s = 0
    for (let i = 0; i < bins; i++) s += hist[i] * hist[i]
    return s
  }
  let best = 0
  let bestScore = score(0)
  const zero = bestScore
  for (let d = -maxDegrees; d <= maxDegrees; d += 0.5) {
    const s = score(d)
    if (s > bestScore * 1.0001) {
      bestScore = s
      best = d
    }
  }
  const coarse = best
  for (let d = coarse - 0.5; d <= coarse + 0.5; d += 0.1) {
    const s = score(d)
    if (s > bestScore) {
      bestScore = s
      best = d
    }
  }
  return { angle: (best * Math.PI) / 180, confidence: zero > 0 ? bestScore / zero : 1 }
}

/** Skew worth correcting: at least a quarter degree, with clear evidence. */
export function shouldDeskew(e: SkewEstimate): boolean {
  return Math.abs(e.angle) >= (0.25 * Math.PI) / 180 && e.confidence >= 1.03
}
