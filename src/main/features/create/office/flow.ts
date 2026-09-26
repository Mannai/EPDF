import type { Hex, ImageData } from './ops'

/**
 * The format-neutral "flow document" that the docx / odt / rtf / txt readers produce and the layout engine
 * paginates. All lengths are in points. Readers resolve styles themselves: every value here is final.
 */

export interface TextStyle {
  /** Document font name (mapped to a bundled font at layout time). */
  family: string
  size: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color: Hex
  highlight?: Hex
  vertAlign?: 'super' | 'sub'
  caps?: boolean
  smallCaps?: boolean
  /** Extra space added after every character, in points. */
  spacing?: number
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  family: 'Liberation Sans',
  size: 11,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: '#000000'
}

export interface FloatSpec {
  image: ImageData
  w: number
  h: number
  crop?: { l: number; t: number; r: number; b: number }
  hRel: 'page' | 'margin' | 'column' | 'character'
  hAlign?: 'left' | 'center' | 'right'
  hOffset: number
  vRel: 'page' | 'margin' | 'paragraph' | 'line'
  vAlign?: 'top' | 'center' | 'bottom'
  vOffset: number
  behind: boolean
  /** `none`: no layout impact (drawn at its position). Otherwise it occupies its own band above the paragraph. */
  wrap: 'none' | 'topAndBottom'
}

export type Inline =
  | { k: 'text'; text: string; style: TextStyle; link?: string }
  | { k: 'tab'; style: TextStyle }
  | { k: 'br'; type: 'line' | 'page' | 'column'; style: TextStyle }
  | { k: 'image'; image: ImageData; w: number; h: number; crop?: { l: number; t: number; r: number; b: number }; link?: string; style: TextStyle }
  | { k: 'field'; field: 'page' | 'pages'; style: TextStyle }
  | { k: 'float'; spec: FloatSpec }

export interface TabStop {
  pos: number
  align: 'left' | 'center' | 'right' | 'decimal'
  leader?: 'dot' | 'hyphen' | 'underscore' | 'middleDot'
}

export interface BorderSpec {
  color: Hex
  width: number
  style: 'single' | 'double' | 'dashed' | 'dotted'
}

export interface ParaProps {
  align: 'left' | 'center' | 'right' | 'justify'
  spaceBefore: number
  spaceAfter: number
  /** `auto`: value is a multiple of the natural line height. `exact`/`atLeast`: points. */
  line: { rule: 'auto' | 'exact' | 'atLeast'; value: number }
  indentLeft: number
  indentRight: number
  /** First-line indent; negative for a hanging indent. */
  firstLine: number
  tabs: TabStop[]
  keepNext: boolean
  keepLines: boolean
  pageBreakBefore: boolean
  widowControl: boolean
  shading?: Hex
  borders?: { top?: BorderSpec; bottom?: BorderSpec; left?: BorderSpec; right?: BorderSpec }
  /** List marker (bullet or number) drawn at the start of the first line. */
  marker?: { text: string; style: TextStyle }
  /**
   * Right-to-left paragraph: the paragraph direction for the bidi algorithm, and the start edge is the right one.
   * `align` ('left' = start, 'right' = end), `indentLeft` (start), `indentRight` (end), `firstLine`, tab stops and the
   * list marker are all logical and mirrored by the layout.
   */
  rtl?: boolean
}

export const DEFAULT_PARA_PROPS: ParaProps = {
  align: 'left',
  spaceBefore: 0,
  spaceAfter: 0,
  line: { rule: 'auto', value: 1 },
  indentLeft: 0,
  indentRight: 0,
  firstLine: 0,
  tabs: [],
  keepNext: false,
  keepLines: false,
  pageBreakBefore: false,
  widowControl: true
}

export interface Paragraph {
  k: 'p'
  props: ParaProps
  inlines: Inline[]
  /** Style of the paragraph mark: gives an empty paragraph its height. */
  markStyle: TextStyle
}

export interface Cell {
  blocks: Block[]
  colSpan: number
  /** Number of rows this cell covers (1 = normal). Continuation cells (vertical merge) are dropped by readers. */
  rowSpan: number
  shading?: Hex
  borders?: { top?: BorderSpec | null; bottom?: BorderSpec | null; left?: BorderSpec | null; right?: BorderSpec | null }
  padding?: { top: number; right: number; bottom: number; left: number }
  vAlign: 'top' | 'center' | 'bottom'
}

export interface Row {
  cells: Cell[]
  height?: { value: number; rule: 'atLeast' | 'exact' }
  header: boolean
  cantSplit: boolean
}

export interface Table {
  k: 'table'
  /** Column widths in points (sum may exceed the available width; the layout scales them down). */
  colWidths: number[]
  rows: Row[]
  borders: { top?: BorderSpec; bottom?: BorderSpec; left?: BorderSpec; right?: BorderSpec; insideH?: BorderSpec; insideV?: BorderSpec }
  padding: { top: number; right: number; bottom: number; left: number }
  align: 'left' | 'center' | 'right'
  indent: number
  /** Right-to-left table: first column on the right; `align`/`indent`, cell margins and left/right borders are logical (start/end). */
  rtl?: boolean
}

export type Block = Paragraph | Table

export interface PageSetup {
  width: number
  height: number
  margins: { top: number; right: number; bottom: number; left: number; header: number; footer: number }
}

export interface HeaderFooterSet {
  default?: Block[]
  first?: Block[]
  even?: Block[]
}

export interface Section {
  page: PageSetup
  columns?: { count: number; gap: number }
  /** Right-to-left section (Word sectPr/bidi, RTF \rtlsect): text columns are filled from right to left. */
  rtl?: boolean
  /** `continuous` sections start on the current page (when the page setup is unchanged). */
  type: 'nextPage' | 'continuous'
  blocks: Block[]
  header?: HeaderFooterSet
  footer?: HeaderFooterSet
  titlePg?: boolean
  evenAndOdd?: boolean
  pageNumberStart?: number
}

export interface FlowDocument {
  sections: Section[]
  defaultTabStop: number
  title?: string
  /**
   * Drop a paragraph's "space before" when it is the first thing on a page reached by an automatic page break
   * (LibreOffice's behaviour for ODF and RTF; Word keeps it, so DOCX leaves this off).
   */
  suppressSpaceBeforeAtPageTop?: boolean
}

export const paragraph = (text: string, style: TextStyle, props: Partial<ParaProps> = {}): Paragraph => ({
  k: 'p',
  props: { ...DEFAULT_PARA_PROPS, ...props },
  inlines: text ? [{ k: 'text', text, style }] : [],
  markStyle: style
})
