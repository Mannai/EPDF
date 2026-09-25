import type { OcrLine, OcrWord } from '@shared/features/ocr'

/**
 * Geometry of the invisible text layer: where a recognized word (pixels of the picture we recognized, origin
 * top-left, y down) belongs on the PDF page (user space, points, origin bottom-left, y up).
 *
 * The picture is what PDF.js drew for the page: the page's visible box (`view` = CropBox clipped to MediaBox,
 * in unrotated user space) turned by the page's /Rotate. So user space is reached from picture pixels by
 * undoing that rotation; text is then written along the (rotated) reading direction with a rotated text
 * matrix, exactly as the page itself is displayed.
 */

export type Rotation = 0 | 90 | 180 | 270

export interface PageGeometry {
  /** [x0, y0, x1, y1] of the visible box in user space (x0 < x1, y0 < y1). */
  view: [number, number, number, number]
  rotate: Rotation
  /** Size of the recognized picture in pixels. */
  width: number
  height: number
}

/** Any angle (e.g. -90, 450) as 0/90/180/270. Non-multiples of 90 snap to the nearest. */
export function normalizeRotation(angle: number): Rotation {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
  return a as Rotation
}

/** Picture pixels per user-space unit. */
export function pixelsPerUnit(g: PageGeometry): number {
  const [x0, y0, x1, y1] = g.view
  const unitsAcross = g.rotate % 180 === 0 ? x1 - x0 : y1 - y0
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
  switch (g.rotate) {
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
  /** Text origin (baseline start) in user space. */
  x: number
  y: number
  /** Unit vector of the writing direction in user space. */
  ux: number
  uy: number
  /** Font size in user-space units. */
  fontSize: number
  /** Width the word should span along the writing direction, in user-space units. */
  width: number
  conf: number
}

export interface LayoutOptions {
  /** Radians the picture was rotated (clockwise) before recognition, to undo for skew correction. Default 0. */
  deskew?: { angle: number; cx: number; cy: number }
}

/** The y of the line's baseline at picture x (falls back to the word box bottom minus a descender allowance). */
export function baselineY(line: OcrLine, word: OcrWord, x: number): number {
  const b = line.baseline
  if (b && b.x1 !== b.x0) return b.y0 + ((b.y1 - b.y0) / (b.x1 - b.x0)) * (x - b.x0)
  return word.y1 - 0.18 * (word.y1 - word.y0)
}

/** Font size in picture pixels: Tesseract's em estimate for the line, kept within sane bounds of the word box. */
export function fontSizePx(line: OcrLine, word: OcrWord): number {
  const h = Math.max(1, word.y1 - word.y0)
  const base = line.rowHeight > 0 ? line.rowHeight : Math.max(1, line.bbox.y1 - line.bbox.y0)
  return Math.min(Math.max(base, h * 0.6), h * 2.2)
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
 * Places one word. Skew is taken from the line's baseline slope (so a crooked scan gets crooked text); if the
 * picture was deskewed before recognition, `opts.deskew` maps the boxes back into the original picture first.
 */
export function placeWord(g: PageGeometry, line: OcrLine, word: OcrWord, opts: LayoutOptions = {}): PlacedWord {
  const d = opts.deskew
  let ox = word.x0
  let oy = baselineY(line, word, word.x0)
  let slope = line.baseline && line.baseline.x1 !== line.baseline.x0 ? (line.baseline.y1 - line.baseline.y0) / (line.baseline.x1 - line.baseline.x0) : 0
  if (!Number.isFinite(slope) || Math.abs(slope) > 1) slope = 0
  let phi = Math.atan(slope) // picture space, y down: positive = text runs down to the right
  if (d) {
    const p = undoDeskew(d, ox, oy)
    ox = p.x
    oy = p.y
    phi += d.angle
  }
  const dirLen = 1000
  const a = pixelToUser(g, ox, oy)
  const b = pixelToUser(g, ox + Math.cos(phi) * dirLen, oy + Math.sin(phi) * dirLen)
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const s = pixelsPerUnit(g)
  const wordWidthPx = (word.x1 - word.x0) / Math.max(0.2, Math.cos(Math.atan(slope)))
  return {
    text: word.text,
    x: a.x,
    y: a.y,
    ux: (b.x - a.x) / len,
    uy: (b.y - a.y) / len,
    fontSize: fontSizePx(line, word) / s,
    width: wordWidthPx / s,
    conf: word.conf
  }
}
