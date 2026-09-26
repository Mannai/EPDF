/**
 * The plain data model between PDF extraction (needs PDF.js) and the layout heuristics + OOXML writers
 * (pure TypeScript). All coordinates are PDF points with the origin at the TOP-LEFT of the page (y grows
 * downwards), i.e. already converted through the page viewport (so page /Rotate is applied).
 */

export interface TextItem {
  text: string
  /** Left edge. */
  x: number
  /** Baseline y. */
  y: number
  width: number
  /** Font size in points. */
  size: number
  /** Raw PDF font name (subset prefix removed). */
  fontName: string
  /** Display family for Office, e.g. "Arial". */
  family: string
  bold: boolean
  italic: boolean
  mono: boolean
  serif: boolean
  /** RRGGBB, upper-case, no '#'. */
  color: string
  /** External hyperlink target, when a Link annotation covers this text. */
  url?: string
  /** The text is a right-to-left line in logical order (from the page text model). */
  rtl?: boolean
}

export interface ImageItem {
  x: number
  y: number
  width: number
  height: number
  /** PNG file bytes. */
  png: Uint8Array
  pxWidth: number
  pxHeight: number
}

export interface RectItem {
  x: number
  y: number
  width: number
  height: number
  /** RRGGBB fill, or null when the rectangle is only stroked. */
  fill: string | null
  stroke: boolean
}

/** An axis-aligned line (ruling). For horizontal lines y1 === y2; for vertical lines x1 === x2. */
export interface LineItem {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface LinkItem {
  x: number
  y: number
  width: number
  height: number
  url: string
}

export interface PageModel {
  /** 1-based. */
  number: number
  width: number
  height: number
  items: TextItem[]
  images: ImageItem[]
  rects: RectItem[]
  lines: LineItem[]
  links: LinkItem[]
}

export interface PdfModel {
  title?: string
  pages: PageModel[]
  warnings: string[]
}

// ---------------------------------------------------------------------------------------------------
// Layout output (what the writers consume)
// ---------------------------------------------------------------------------------------------------

export interface Run {
  text: string
  size: number
  family: string
  bold: boolean
  italic: boolean
  color: string
  url?: string
  /** Right-to-left text (logical order): written with bidi run/paragraph properties. */
  rtl?: boolean
}

export type Align = 'left' | 'center' | 'right' | 'both'

export interface ParagraphBlock {
  type: 'paragraph'
  runs: Run[]
  align: Align
  /** Points from the page's left margin. */
  indentLeft: number
  /** Extra indent of the first line (negative = hanging), points. */
  firstLine: number
  /** Points of space before this paragraph (from the gap to the previous block). */
  spaceBefore: number
  /** Line pitch (baseline to baseline) in points, 0 when unknown. */
  pitch: number
  /** 1..3 for headings, 0 for body text. */
  heading: number
  /** Geometry on the page, for positioned output (pptx). */
  x: number
  y: number
  width: number
  height: number
  /** Number of source lines. */
  lineCount: number
  /** The source lines as cell-like segments (text before/after wide gaps), for spreadsheet export. */
  srcLines: string[][]
}

export interface TableCell {
  /** Runs of the cell, lines joined with spaces. */
  runs: Run[]
  text: string
  align: Align
  /** Every run of the cell is bold (a header-ish cell). */
  bold: boolean
}

export interface TableBlock {
  type: 'table'
  /** Column edges (points, page coordinates), ascending; length = columns + 1. */
  colEdges: number[]
  /** Row edges (points, page coordinates), ascending; length = rows + 1. */
  rowEdges: number[]
  rows: TableCell[][]
  /** True when the grid came from drawn ruling lines (so borders are drawn), false when inferred from alignment. */
  bordered: boolean
  x: number
  y: number
  width: number
  height: number
  spaceBefore: number
}

export interface ImageBlock {
  type: 'image'
  image: ImageItem
  spaceBefore: number
}

export type Block = ParagraphBlock | TableBlock | ImageBlock

export interface PageLayout {
  number: number
  width: number
  height: number
  blocks: Block[]
  /** Text area edges in points (from the page's text bounding box). */
  margins: { top: number; right: number; bottom: number; left: number }
  /** Rectangles, kept for positioned output. */
  rects: RectItem[]
}

export interface ExportOptions {
  /** xlsx: one sheet per detected table (fallback: per page when none) or one sheet per page. */
  xlsxMode: 'tables' | 'pages'
  includeImages: boolean
}

export const DEFAULT_OPTIONS: ExportOptions = { xlsxMode: 'tables', includeImages: true }
