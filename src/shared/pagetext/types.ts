/**
 * The page text model: the logical-order text of a PDF page with per-character geometry.
 *
 * All geometry is in DISPLAY space: PDF points, origin at the top-left of the page as shown (CropBox, /Rotate applied),
 * y down. Multiply by the zoom to get CSS pixels; this is exactly a PDF.js viewport at scale 1.
 *
 * The model is plain data (strings, numbers, typed arrays) so it can be cached, sent between threads and stored.
 */

export interface PageTextLine {
  /** [start, end) of the line in `PageTextModel.text` (without the line break). */
  start: number
  end: number
  /** Paragraph direction the line was read with. */
  dir: 'ltr' | 'rtl'
  /** Baseline direction on the displayed page in degrees (0 = left to right, 90 = downwards, -90 = upwards). */
  angle: number
  /** Font size (em) in points. */
  size: number
  /** Position of the baseline across the line direction (for horizontal lines: the baseline's y). */
  baseline: number
  /** Dominant font of the line (BaseFont without subset prefix) and its style. */
  font: string
  bold: boolean
  italic: boolean
  /** Axis-aligned bounds. */
  x0: number
  y0: number
  x1: number
  y1: number
  /** Reading-order block (paragraph/column) index. */
  block: number
  /** The visual order was inverted exactly (verified with the bidi algorithm); false = best effort. */
  exact: boolean
  /** Word boundaries: flat [start, end) pairs (absolute offsets in `text`), word-like segments only. */
  words: number[]
}

export interface PageTextStats {
  glyphs: number
  /** Glyphs with advance whose text could not be decoded and that no /ActualText covers. */
  unknown: number
  /** Glyphs in fonts whose encoding could not be decoded reliably (widths/positions may be wrong). */
  unreliable: number
  /** /ActualText spans used. */
  actualText: number
  /** Lines whose logical order is best effort (no exact bidi inversion found). */
  inexactLines: number
  marks: number
  orphanMarks: number
}

export interface PageTextModel {
  pageIndex: number
  width: number
  height: number
  rotation: number
  /** PDF user space -> display space (a, b, c, d, e, f); invert it to write annotations or redaction marks. */
  transform: number[]
  /** Logical text: lines in reading order separated by '\n'. */
  text: string
  lines: PageTextLine[]
  /** For each UTF-16 unit of `text`: index of its quad (in `quads`, 8 floats each), or -1 (line breaks). */
  charQuad: Int32Array
  /** Quads: 4 corners (x, y) in the order start-bottom, end-bottom, end-top, start-top of the text direction. */
  quads: Float32Array
  stats: PageTextStats
  warnings: string[]
  /**
   * Only with `BuildOptions.glyphLines`: for every glyph of the interpretation (`interpretPage(...).glyphs`), the index
   * of the line in `lines` it belongs to (base glyphs and the marks attached to them), or -1.
   */
  glyphLine?: Int32Array
}

/** An axis-aligned rectangle in display space. */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}
