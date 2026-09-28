import type { OcrLine, OcrWord } from '@shared/features/ocr'

/**
 * Geometry of the invisible text layer: where a recognized line and its words (pixels of the picture we
 * recognized, origin top-left, y down) belong on the PDF page (user space, points, origin bottom-left, y up).
 *
 * The picture is what PDF.js drew for the page: the page's visible box (`view` = CropBox clipped to MediaBox,
 * in unrotated user space) turned by the page's /Rotate. So user space is reached from picture pixels by
 * undoing that rotation; text is then written along the (rotated) reading direction with a rotated text
 * matrix, exactly as the page itself is displayed.
 *
 * Each line gets ONE text matrix and its words are then moved along the line: readers such as PDF.js treat a
 * change of matrix as a new line, so per-word matrices would break phrases apart in extracted text.
 */

export type Rotation = 0 | 90 | 180 | 270

export interface PageGeometry {
  /** [x0, y0, x1, y1] of the visible box in user space (x0 < x1, y0 < y1). */
  view: [number, number, number, number]
  rotate: Rotation
  /**
   * The picture was drawn turned a further `turn` degrees clockwise (the page was scanned turned or upside down and
   * orientation detection straightened it). The page itself is not changed.
   */
  turn?: Rotation
  /** Size of the recognized picture in pixels. */
  width: number
  height: number
}

/** Rotation of the recognized picture relative to the page's user space. */
const pictureRotation = (g: PageGeometry): Rotation => normalizeRotation(g.rotate + (g.turn ?? 0))

/** Any angle (e.g. -90, 450) as 0/90/180/270. Non-multiples of 90 snap to the nearest. */
export function normalizeRotation(angle: number): Rotation {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
  return a as Rotation
}

/** Picture pixels per user-space unit. */
export function pixelsPerUnit(g: PageGeometry): number {
  const [x0, y0, x1, y1] = g.view
  const unitsAcross = pictureRotation(g) % 180 === 0 ? x1 - x0 : y1 - y0
  return g.width / unitsAcross
}

export interface Point {
  x: number
  y: number
}

/** A picture pixel position -> user-space point. */
export function pixelToUser(g: PageGeometry, px: number, py: number): Point {
  const [x0, y0, x1, y1] = g.view
  const s = pixelsPerUnit(g)
  switch (pictureRotation(g)) {
    case 0:
      return { x: x0 + px / s, y: y1 - py / s }
    case 90:
      return { x: x0 + py / s, y: y0 + px / s }
    case 180:
      return { x: x1 - px / s, y: y0 + py / s }
    case 270:
      return { x: x1 - py / s, y: y1 - px / s }
  }
}

export interface PlacedWord {
  text: string
  /** Distance of the word's start from the line origin, along the writing direction (user units). May be negative. */
  offset: number
  /** Width the word should span along the writing direction, in user-space units. */
  width: number
  conf: number
}

export interface PlacedLine {
  /** Text origin (start of the first word on the baseline) in user space. */
  x: number
  y: number
  /** Unit vector of the writing direction in user space. */
  ux: number
  uy: number
  /** Font size in user-space units (one per line). */
  fontSize: number
  /** The writing direction is not one of the four axes (a crooked scan). */
  tilted: boolean
  /** Right-to-left paragraph direction (set once the words are in visual order, see `collectChars`). */
  rtl?: boolean
  /** In reading order as recognized; `collectChars` puts them in visual order (left to right). */
  words: PlacedWord[]
}

export interface LayoutOptions {
  /** The picture was rotated clockwise by `angle` radians (around cx, cy) before recognition; undo that. */
  deskew?: { angle: number; cx: number; cy: number }
  /** Baseline slope to use instead of the line's own (see `pageSlopes`). */
  slope?: number
}

/** Lines whose baseline slope differs from the page's by less than this (about 0.5 degrees) share the page's slope. */
export const SAME_SLOPE = 0.009

const rawSlope = (line: OcrLine): number | null => {
  const b = line.baseline
  if (!b || b.x1 === b.x0) return null
  const s = (b.y1 - b.y0) / (b.x1 - b.x0)
  return Number.isFinite(s) && Math.abs(s) <= 1 ? s : null
}

/**
 * One slope for the lines of a page. The lines of a scanned page are parallel, but Tesseract measures each baseline on
 * its own, so on a slightly tilted page some come out just above the noise threshold (written tilted) and some just
 * below (written straight). Readers keep lines of different directions apart, so such a page would read in a scrambled
 * order. Every line within SAME_SLOPE of the median slope of the page's longer lines gets that median; the others keep
 * their own. `words[i]` are the words kept for `lines[i]`.
 */
export function pageSlopes(lines: OcrLine[], words: OcrWord[][]): number[] {
  const raws = lines.map(rawSlope)
  const sample = raws.filter((s, i): s is number => s !== null && words[i].length >= 2).sort((a, b) => a - b)
  if (!sample.length) return lines.map(baselineSlope)
  const median = sample[sample.length >> 1]
  const page = Math.abs(median) >= MIN_SLOPE ? median : 0
  return lines.map((l, i) => {
    const r = raws[i]
    return r === null || Math.abs(r - median) <= SAME_SLOPE ? page : baselineSlope(l)
  })
}

/** Baseline slopes below this (about 0.4 degrees) are recognition noise, not skew: the line is written straight. */
export const MIN_SLOPE = 0.007

/** The y of the line's baseline at picture x (falls back to the word box bottom minus a descender allowance). */
export function baselineY(line: OcrLine, word: OcrWord, x: number): number {
  const b = line.baseline
  if (b && b.x1 !== b.x0) return b.y0 + ((b.y1 - b.y0) / (b.x1 - b.x0)) * (x - b.x0)
  return word.y1 - 0.18 * (word.y1 - word.y0)
}

/** Slope (dy/dx, y down) of the line's baseline, 0 when unknown or negligible. */
export function baselineSlope(line: OcrLine): number {
  const b = line.baseline
  if (!b || b.x1 === b.x0) return 0
  const s = (b.y1 - b.y0) / (b.x1 - b.x0)
  return Number.isFinite(s) && Math.abs(s) >= MIN_SLOPE && Math.abs(s) <= 1 ? s : 0
}

/** Font size in picture pixels for a line: Tesseract's em estimate, kept within sane bounds of the word boxes. */
export function lineFontSizePx(line: OcrLine, words: OcrWord[]): number {
  const heights = words.map((w) => Math.max(1, w.y1 - w.y0)).sort((a, b) => a - b)
  const med = heights[Math.floor(heights.length / 2)] ?? 1
  const base = line.rowHeight > 0 ? line.rowHeight : Math.max(1, line.bbox.y1 - line.bbox.y0)
  return Math.min(Math.max(base, med * 0.6), med * 2.2)
}

/** Maps a point recognized in a deskewed picture back to the original picture. */
export function undoDeskew(d: NonNullable<LayoutOptions['deskew']>, x: number, y: number): { x: number; y: number } {
  // The deskewed picture is the original rotated by `-angle`; rotate back by `+angle` around the same centre.
  const dx = x - d.cx
  const dy = y - d.cy
  const c = Math.cos(d.angle)
  const s = Math.sin(d.angle)
  return { x: d.cx + dx * c - dy * s, y: d.cy + dx * s + dy * c }
}

/**
 * Places one recognized line. Skew comes from the line's baseline slope (a crooked scan gets crooked text); if
 * the picture was deskewed before recognition, `opts.deskew` maps the boxes back into the original picture.
 * `words` are the words of `line` to keep (already filtered), in reading order.
 */
export function placeLine(g: PageGeometry, line: OcrLine, words: OcrWord[], opts: LayoutOptions = {}): PlacedLine | null {
  if (words.length === 0) return null
  const d = opts.deskew
  const slope = opts.slope ?? baselineSlope(line)
  const phiLine = Math.atan(slope) // picture space, y down: positive = text runs down to the right
  const phi = phiLine + (d ? d.angle : 0)
  const ux = Math.cos(phi)
  const uy = Math.sin(phi)

  const origin = (w: OcrWord): { x: number; y: number } => {
    const p = { x: w.x0, y: baselineY(line, w, w.x0) }
    return d ? undoDeskew(d, p.x, p.y) : p
  }
  const o0 = origin(words[0])
  const a = pixelToUser(g, o0.x, o0.y)
  const b = pixelToUser(g, o0.x + ux * 1000, o0.y + uy * 1000)
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const s = pixelsPerUnit(g)
  const wordScale = 1 / Math.max(0.2, Math.cos(phiLine))

  return {
    x: a.x,
    y: a.y,
    ux: (b.x - a.x) / len,
    uy: (b.y - a.y) / len,
    fontSize: lineFontSizePx(line, words) / s,
    tilted: Math.abs(phi) > 1e-9,
    words: words.map((w, i) => {
      const o = i === 0 ? o0 : origin(w)
      return {
        text: w.text,
        offset: ((o.x - o0.x) * ux + (o.y - o0.y) * uy) / s,
        width: ((w.x1 - w.x0) * wordScale) / s,
        conf: w.conf
      }
    })
  }
}
