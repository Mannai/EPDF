import { throwIfCancelled, type ConvertEnv } from './env'
import type { Face } from './fonts'
import { generalFit, generalText } from './numfmt'
import type { Hex, ImageData, Op, Page, Stroke } from './ops'
import { firstStrongRtl, glyphOp, shapeLine } from './textline'

/**
 * Format-neutral spreadsheet model plus the layout engine that prints it: column widths/row heights, fills,
 * borders, aligned/wrapped/spilling text, merged cells, print areas, repeated title rows/columns, scaling
 * (fixed or fit-to-page), manual breaks, headers/footers and pictures. xlsx.ts, ods.ts and csv.ts build a
 * `SheetModel`; `layoutSheet` turns it into display-list pages.
 */

export interface CellFont {
  family: string
  size: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color: Hex
}

export interface BorderLine {
  width: number
  color: Hex
  style: 'single' | 'double' | 'dashed' | 'dotted'
}

export interface CellStyle {
  font: CellFont
  fill?: Hex
  borders: { left?: BorderLine; right?: BorderLine; top?: BorderLine; bottom?: BorderLine }
  h: 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify'
  v: 'top' | 'center' | 'bottom'
  wrap: boolean
  /** Indent levels (each about 6.75pt). */
  indent: number
  shrink: boolean
  /** Text direction of the cell (Excel `readingOrder` 1/2, ODF writing mode); unset = from the first strong character. */
  readingOrder?: 'ltr' | 'rtl'
}

export interface RichRun {
  text: string
  font: CellFont
}

export interface SheetCell {
  text: string
  runs?: RichRun[]
  kind: 'text' | 'number' | 'bool' | 'error' | 'empty'
  style: CellStyle
  /** Colour from the number format (`[Red]`), overriding the font colour. */
  color?: Hex
  fill?: { index: number; ch: string }
  link?: string
  /** Raw numeric value (used by conditional formatting). */
  value?: number
  /** Data bar from conditional formatting: fraction of the cell width and its colour. */
  bar?: { frac: number; color: Hex }
}

export interface Range {
  r1: number
  c1: number
  r2: number
  c2: number
}

export interface SheetImage {
  from: { col: number; row: number; dx: number; dy: number }
  /** Second anchor corner (two-cell anchors); otherwise `w`/`h` give the size in points. */
  to?: { col: number; row: number; dx: number; dy: number }
  w?: number
  h?: number
  image?: ImageData
  /** Placeholder label for charts/shapes that cannot be drawn. */
  label?: string
  /** `from.dx`/`from.dy` are absolute sheet coordinates (points from the top-left of cell A1). */
  abs?: boolean
}

export interface HFRun {
  text?: string
  field?: 'page' | 'pages' | 'date' | 'time' | 'sheet' | 'file' | 'path'
  bold?: boolean
  italic?: boolean
  underline?: boolean
  size?: number
  family?: string
}
export interface HFSet {
  left: HFRun[]
  center: HFRun[]
  right: HFRun[]
}
export interface HeaderFooter {
  odd?: HFSet
  even?: HFSet
  first?: HFSet
  differentOddEven: boolean
  differentFirst: boolean
}

export interface PrintSetup {
  paper: { w: number; h: number }
  margins: { left: number; right: number; top: number; bottom: number; header: number; footer: number }
  areas?: Range[]
  titleRows?: [number, number]
  titleCols?: [number, number]
  /** Fixed scale (1 = 100%). */
  scale: number
  /** Fit to N pages wide/tall (0 = automatic). Overrides `scale`. */
  fit?: { w: number; h: number }
  /** Do not shrink below this when fitting (the rest paginates). */
  fitMinScale?: number
  gridLines: boolean
  hCenter: boolean
  vCenter: boolean
  /** Break AFTER these 0-based rows / columns. */
  rowBreaks: number[]
  colBreaks: number[]
  pageOrder: 'down' | 'over'
  header?: HeaderFooter
  footer?: HeaderFooter
  firstPageNumber?: number
  fileName?: string
}

export interface SheetModel {
  name: string
  cells: Map<number, Map<number, SheetCell>>
  colWidths: Map<number, number>
  hiddenCols: Set<number>
  rowHeights: Map<number, number>
  hiddenRows: Set<number>
  defaultColWidth: number
  defaultRowHeight: number
  merges: Range[]
  images: SheetImage[]
  print: PrintSetup
  defaultFont: CellFont
  /** Right-to-left sheet (Excel `sheetView rightToLeft`, ODF table writing mode rl-tb): column A on the right. */
  rtl?: boolean
}

export const DEFAULT_FONT: CellFont = { family: 'Calibri', size: 11, bold: false, italic: false, underline: false, strike: false, color: '#000000' }

export const DEFAULT_CELL_STYLE: CellStyle = { font: DEFAULT_FONT, borders: {}, h: 'general', v: 'bottom', wrap: false, indent: 0, shrink: false }

export function newSheet(name: string, page: { width: number; height: number }): SheetModel {
  return {
    name,
    cells: new Map(),
    colWidths: new Map(),
    hiddenCols: new Set(),
    rowHeights: new Map(),
    hiddenRows: new Set(),
    defaultColWidth: 48,
    defaultRowHeight: 15,
    merges: [],
    images: [],
    defaultFont: DEFAULT_FONT,
    print: {
      paper: { w: page.width, h: page.height },
      margins: { left: 50.4, right: 50.4, top: 54, bottom: 54, header: 21.6, footer: 21.6 },
      scale: 1,
      gridLines: false,
      hCenter: false,
      vCenter: false,
      rowBreaks: [],
      colBreaks: [],
      pageOrder: 'down'
    }
  }
}

export function setCell(sheet: SheetModel, r: number, c: number, cell: SheetCell): void {
  let row = sheet.cells.get(r)
  if (!row) sheet.cells.set(r, (row = new Map()))
  row.set(c, cell)
}

export const cellAt = (sheet: SheetModel, r: number, c: number): SheetCell | undefined => sheet.cells.get(r)?.get(c)

// ---------------------------------------------------------------------------------------------------
// Text layout inside a cell
// ---------------------------------------------------------------------------------------------------

interface Piece {
  face: Face
  text: string
  w: number
  size: number
  font: CellFont
  asc: number
  desc: number
}
interface Atom {
  kind: 'word' | 'space' | 'nl'
  pieces: Piece[]
  w: number
}
interface TLine {
  pieces: Piece[]
  w: number
  asc: number
  desc: number
}

function makeAtoms(env: ConvertEnv, runs: RichRun[], wrap: boolean, sizeScale: number): Atom[] {
  const atoms: Atom[] = []
  for (const run of runs) {
    const face = env.catalog.face(run.font.family, run.font.bold, run.font.italic)
    const size = run.font.size * sizeScale
    const m = env.catalog.metrics(face)
    const asc = (m.ascent + m.lineGap) * size
    const desc = m.descent * size
    const text = wrap ? run.text : run.text.replace(/[\r\n]+/g, ' ')
    for (const tok of text.match(/\r\n|\n|\r| +|[^\s]+|\t/g) ?? []) {
      if (tok === '\n' || tok === '\r\n' || tok === '\r') {
        atoms.push({ kind: 'nl', pieces: [], w: 0 })
        continue
      }
      const kind = tok[0] === ' ' || tok === '\t' ? 'space' : 'word'
      const pieces: Piece[] = []
      let w = 0
      for (const seg of env.catalog.segment(face, tok === '\t' ? '    ' : tok)) {
        const pw = env.catalog.measure(seg.face, seg.text) * size
        pieces.push({ face: seg.face, text: seg.text, w: pw, size, font: run.font, asc, desc })
        w += pw
      }
      atoms.push({ kind, pieces, w })
    }
  }
  return atoms
}

function breakWord(env: ConvertEnv, a: Atom, room: number): Atom[] {
  const out: Atom[] = []
  let cur: Piece[] = []
  let w = 0
  const flush = (): void => {
    if (cur.length) out.push({ kind: 'word', pieces: cur, w })
    cur = []
    w = 0
  }
  for (const p of a.pieces) {
    for (const ch of Array.from(p.text)) {
      const cw = env.catalog.measure(p.face, ch) * p.size
      if (w + cw > room && w > 0) flush()
      const last = cur[cur.length - 1]
      if (last && last.face.key === p.face.key && last.font === p.font) {
        last.text += ch
        last.w += cw
      } else cur.push({ ...p, text: ch, w: cw })
      w += cw
    }
  }
  flush()
  return out
}

/** Lays runs out in lines no wider than `maxW` (when `wrap`), splitting over-long words so no text is lost. */
export function layoutRuns(env: ConvertEnv, runs: RichRun[], maxW: number, wrap: boolean, sizeScale = 1): TLine[] {
  let atoms = makeAtoms(env, runs, wrap, sizeScale)
  const lines: TLine[] = []
  let cur: TLine = { pieces: [], w: 0, asc: 0, desc: 0 }
  let pending: Atom[] = []
  let pendingW = 0
  const place = (a: Atom): void => {
    for (const p of a.pieces) {
      cur.pieces.push(p)
      cur.asc = Math.max(cur.asc, p.asc)
      cur.desc = Math.max(cur.desc, p.desc)
    }
    cur.w += a.w
  }
  const fallbackMetrics = runs.length ? runs[runs.length - 1].font : DEFAULT_FONT
  const finish = (): void => {
    if (cur.asc === 0) {
      const face = env.catalog.face(fallbackMetrics.family, fallbackMetrics.bold, fallbackMetrics.italic)
      const m = env.catalog.metrics(face)
      cur.asc = (m.ascent + m.lineGap) * fallbackMetrics.size * sizeScale
      cur.desc = m.descent * fallbackMetrics.size * sizeScale
    }
    lines.push(cur)
    cur = { pieces: [], w: 0, asc: 0, desc: 0 }
    pending = []
    pendingW = 0
  }
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i]
    if (a.kind === 'nl') {
      finish()
      continue
    }
    if (a.kind === 'space') {
      pending.push(a)
      pendingW += a.w
      continue
    }
    if (!wrap || cur.w + pendingW + a.w <= maxW + 0.01) {
      for (const s of pending) place(s)
      pending = []
      pendingW = 0
      place(a)
      continue
    }
    if (cur.pieces.length > 0) {
      finish()
      i-- // retry on a fresh line
      continue
    }
    if (a.w > maxW && maxW > 1) {
      const parts = breakWord(env, a, maxW)
      if (parts.length > 1) {
        atoms = [...atoms.slice(0, i), ...parts, ...atoms.slice(i + 1)]
        i--
        continue
      }
    }
    for (const s of pending) place(s)
    pending = []
    pendingW = 0
    place(a)
  }
  if (cur.pieces.length > 0 || lines.length === 0) {
    for (const s of pending) place(s)
    finish()
  }
  return lines
}

// ---------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------

const INDENT_PT = 6.75
const PAD = 2.2
const EPS = 1e-6

interface Geometry {
  colW(c: number): number
  rowH(r: number): number
  colStart(c: number): number
  rowStart(r: number): number
}

function lineHeightOf(env: ConvertEnv, f: CellFont): number {
  const m = env.catalog.metrics(env.catalog.face(f.family, f.bold, f.italic))
  return (m.ascent + m.descent + m.lineGap) * f.size
}

function runsOf(cell: SheetCell, colorOverride?: Hex): RichRun[] {
  if (cell.runs && cell.runs.length) return colorOverride ? cell.runs.map((r) => ({ ...r, font: { ...r.font, color: colorOverride } })) : cell.runs
  return [{ text: cell.text, font: colorOverride ? { ...cell.style.font, color: colorOverride } : cell.style.font }]
}

function makeGeometry(env: ConvertEnv, sheet: SheetModel, mergeAnchors: Map<string, Range>): Geometry {
  const colW = (c: number): number => (sheet.hiddenCols.has(c) ? 0 : (sheet.colWidths.get(c) ?? sheet.defaultColWidth))
  const rowCache = new Map<number, number>()
  // merged ranges indexed by row so auto row heights stay cheap on sheets with many merges
  const mergesByRow = new Map<number, Range[]>()
  for (const m of sheet.merges) {
    for (let r = m.r1; r <= Math.min(m.r2, m.r1 + 5000); r++) {
      const l = mergesByRow.get(r)
      if (l) l.push(m)
      else mergesByRow.set(r, [m])
    }
  }
  const mergedCovered = (r: number, c: number): boolean => !!mergesByRow.get(r)?.some((m) => c >= m.c1 && c <= m.c2)
  const rowH = (r: number): number => {
    if (sheet.hiddenRows.has(r)) return 0
    const explicit = sheet.rowHeights.get(r)
    if (explicit !== undefined) return explicit
    let h = rowCache.get(r)
    if (h !== undefined) return h
    h = sheet.defaultRowHeight
    const row = sheet.cells.get(r)
    if (row) {
      for (const [c, cell] of row) {
        if (cell.kind === 'empty' && !cell.text) continue
        if (mergedCovered(r, c) && !mergeAnchors.has(`${r}:${c}`)) continue
        if (mergeAnchors.has(`${r}:${c}`)) continue
        const runs = runsOf(cell)
        const maxSize = Math.max(...runs.map((x) => x.font.size))
        const single = Math.max(...runs.map((x) => lineHeightOf(env, x.font))) + 1.5
        if (cell.style.wrap && cell.text) {
          const w = colW(c) - 2 * PAD - cell.style.indent * INDENT_PT
          if (w > 4) {
            const lines = layoutRuns(env, runs, w, true)
            const need = lines.reduce((s, l) => s + l.asc + l.desc, 0) + 1.5
            h = Math.max(h, need)
            continue
          }
        }
        void maxSize
        h = Math.max(h, single)
      }
    }
    rowCache.set(r, h)
    return h
  }
  const colPrefix: number[] = [0]
  const rowPrefix: number[] = [0]
  return {
    colW,
    rowH,
    colStart(c) {
      while (colPrefix.length <= c) colPrefix.push(colPrefix[colPrefix.length - 1] + colW(colPrefix.length - 1))
      return colPrefix[c]
    },
    rowStart(r) {
      while (rowPrefix.length <= r) rowPrefix.push(rowPrefix[rowPrefix.length - 1] + rowH(rowPrefix.length - 1))
      return rowPrefix[r]
    }
  }
}

/** Anchor cell + offsets of an image; absolute positions are mapped onto the column/row grid. */
function anchorOf(geo: Geometry, im: SheetImage): SheetImage['from'] {
  if (!im.abs) return im.from
  const x = im.from.dx
  const y = im.from.dy
  let col = 0
  while (col < 16384 && geo.colStart(col + 1) <= x) col++
  let row = 0
  while (row < 1048576 && geo.rowStart(row + 1) <= y && row < 20000) row++
  return { col, row, dx: x - geo.colStart(col), dy: y - geo.rowStart(row) }
}

function usedRange(sheet: SheetModel, geo: Geometry): Range | null {
  let r1 = Infinity
  let r2 = -1
  let c1 = Infinity
  let c2 = -1
  for (const [r, row] of sheet.cells) {
    for (const [c, cell] of row) {
      const styled = cell.style.fill || cell.style.borders.top || cell.style.borders.bottom || cell.style.borders.left || cell.style.borders.right
      if (cell.kind === 'empty' && !cell.text && !styled) continue
      r1 = Math.min(r1, r)
      r2 = Math.max(r2, r)
      c1 = Math.min(c1, c)
      c2 = Math.max(c2, c)
    }
  }
  for (const m of sheet.merges) {
    if (m.r1 >= r1 && m.r1 <= r2) {
      r2 = Math.max(r2, m.r2)
      c2 = Math.max(c2, m.c2)
    }
  }
  for (const im of sheet.images) {
    const from = anchorOf(geo, im)
    const end = im.to ?? from
    r1 = Math.min(r1, from.row)
    c1 = Math.min(c1, from.col)
    r2 = Math.max(r2, end.row)
    c2 = Math.max(c2, end.col)
  }
  if (r2 < 0 || c2 < 0) return null
  // Excel prints from A1 (the sheet origin), not from the first used cell.
  return { r1: 0, c1: 0, r2, c2 }
}

// ---------------------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------------------

interface Block {
  cols: number[]
  rows: number[]
}

function splitIndexes(idx: number[], size: (i: number) => number, avail: number, breaks: Set<number>, repeat: number[], firstAfter: number): number[][] {
  const blocks: number[][] = []
  let cur: number[] = []
  let used = 0
  const repW = repeat.reduce((s, i) => s + size(i), 0)
  for (const i of idx) {
    const s = size(i)
    if (cur.length && used + s > avail + EPS) {
      blocks.push(cur)
      cur = []
      used = i > firstAfter ? repW : 0
    }
    if (cur.length === 0 && blocks.length > 0 && i > firstAfter) used = repW
    cur.push(i)
    used += s
    if (breaks.has(i)) {
      blocks.push(cur)
      cur = []
      used = repW
    }
  }
  if (cur.length) blocks.push(cur)
  return blocks.filter((b) => b.length > 0)
}

function paginateRegion(_env: ConvertEnv, sheet: SheetModel, geo: Geometry, reg: Range, scale: number): { colBlocks: number[][]; rowBlocks: number[][] } {
  const p = sheet.print
  const availW = (p.paper.w - p.margins.left - p.margins.right) / scale
  const availH = (p.paper.h - p.margins.top - p.margins.bottom - (p.header ? 0 : 0)) / scale
  const cols: number[] = []
  for (let c = reg.c1; c <= reg.c2; c++) if (geo.colW(c) > 0) cols.push(c)
  const rows: number[] = []
  for (let r = reg.r1; r <= reg.r2; r++) if (geo.rowH(r) > 0) rows.push(r)
  const tc = p.titleCols
  const tr = p.titleRows
  const titleCols = tc ? cols.filter((c) => c >= tc[0] && c <= tc[1]) : []
  const titleRows = tr ? rows.filter((r) => r >= tr[0] && r <= tr[1]) : []
  const colBlocks = splitIndexes(cols, geo.colW, availW, new Set(p.colBreaks), titleCols, tc ? tc[1] : -1)
  const rowBlocks = splitIndexes(rows, geo.rowH, availH, new Set(p.rowBreaks), titleRows, tr ? tr[1] : -1)
  // prepend repeated titles to later blocks
  const withTitles = (blocks: number[][], titles: number[], lastTitle: number): number[][] =>
    blocks.map((b) => (titles.length && b[0] > lastTitle ? [...titles, ...b] : b))
  return { colBlocks: withTitles(colBlocks, titleCols, tc ? tc[1] : -1), rowBlocks: withTitles(rowBlocks, titleRows, tr ? tr[1] : -1) }
}

function chooseScale(env: ConvertEnv, sheet: SheetModel, geo: Geometry, reg: Range): number {
  const p = sheet.print
  if (!p.fit) return p.scale > 0 ? p.scale : 1
  const { w: fw, h: fh } = p.fit
  const min = p.fitMinScale ?? 0.1
  let width = 0
  for (let c = reg.c1; c <= reg.c2; c++) width += geo.colW(c)
  let scale = 1
  const availW = p.paper.w - p.margins.left - p.margins.right
  if (fw > 0 && width > 0) scale = Math.min(scale, (availW * fw) / width)
  if (fh > 0) {
    let height = 0
    for (let r = reg.r1; r <= reg.r2; r++) height += geo.rowH(r)
    const availH = p.paper.h - p.margins.top - p.margins.bottom
    if (height > 0) scale = Math.min(scale, (availH * fh) / height)
  }
  scale = Math.max(min, Math.min(1, scale))
  // pagination granularity can need a little more shrinking to honour the page limits
  for (let i = 0; i < 40; i++) {
    const { colBlocks, rowBlocks } = paginateRegion(env, sheet, geo, reg, scale)
    const okW = fw === 0 || colBlocks.length <= fw
    const okH = fh === 0 || rowBlocks.length <= fh
    if ((okW && okH) || scale <= min + 1e-9) break
    scale = Math.max(min, scale * 0.96)
  }
  return scale
}

// ---------------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------------

const LINE_DASH = (b: BorderLine, s: number): Stroke => ({ color: b.color, width: Math.max(0.25, b.width * s), dash: b.style === 'dashed' ? [3 * b.width * s, 2 * b.width * s] : b.style === 'dotted' ? [b.width * s, b.width * s] : undefined })

function hfText(runs: HFRun[], vars: { page: number; pages: number; sheet: string; file: string; date: string; time: string }): { text: string; run: HFRun }[] {
  return runs.map((r) => {
    let text = r.text ?? ''
    if (r.field === 'page') text = String(vars.page)
    else if (r.field === 'pages') text = String(vars.pages)
    else if (r.field === 'sheet') text = vars.sheet
    else if (r.field === 'file') text = vars.file
    else if (r.field === 'date') text = vars.date
    else if (r.field === 'time') text = vars.time
    else if (r.field === 'path') text = ''
    return { text, run: r }
  })
}

export function layoutSheet(sheet: SheetModel, env: ConvertEnv): Page[] {
  const mergeAnchors = new Map<string, Range>()
  for (const m of sheet.merges) mergeAnchors.set(`${m.r1}:${m.c1}`, m)
  const geo = makeGeometry(env, sheet, mergeAnchors)
  const used = usedRange(sheet, geo)
  const p = sheet.print
  const regions: Range[] = p.areas && p.areas.length ? p.areas : used ? [used] : []
  if (regions.length === 0) return []

  const pages: Page[] = []
  for (const reg of regions) {
    throwIfCancelled(env)
    const scale = chooseScale(env, sheet, geo, reg)
    const { colBlocks, rowBlocks } = paginateRegion(env, sheet, geo, reg, scale)
    const order: Block[] = []
    if (p.pageOrder === 'down') for (const cb of colBlocks) for (const rb of rowBlocks) order.push({ cols: cb, rows: rb })
    else for (const rb of rowBlocks) for (const cb of colBlocks) order.push({ cols: cb, rows: rb })
    for (const b of order) {
      throwIfCancelled(env)
      pages.push(drawBlock(env, sheet, geo, b, scale))
    }
  }
  drawHeadersFooters(env, sheet, pages)
  return pages
}

function drawBlock(env: ConvertEnv, sheet: SheetModel, geo: Geometry, block: Block, S: number): Page {
  const p = sheet.print
  const ops: Op[] = []
  const colX = new Map<number, number>()
  const rowY = new Map<number, number>()
  let x = 0
  for (const c of block.cols) {
    colX.set(c, x)
    x += geo.colW(c)
  }
  const totalW = x
  let y = 0
  for (const r of block.rows) {
    rowY.set(r, y)
    y += geo.rowH(r)
  }
  const totalH = y
  const availW = p.paper.w - p.margins.left - p.margins.right
  const availH = p.paper.h - p.margins.top - p.margins.bottom
  const ox = p.margins.left + (p.hCenter ? Math.max(0, (availW - totalW * S) / 2) : 0)
  const oy = p.margins.top + (p.vCenter ? Math.max(0, (availH - totalH * S) / 2) : 0)
  const X = (v: number): number => ox + v * S
  const Y = (v: number): number => oy + v * S
  const colSet = new Set(block.cols)
  const rowSet = new Set(block.rows)

  // Merged regions that touch this block (anchor may be outside it).
  interface MRect {
    m: Range
    x: number
    y: number
    w: number
    h: number
  }
  const merged = new Map<string, MRect>() // key of every covered cell -> rect
  const mergedRects: MRect[] = []
  for (const m of sheet.merges) {
    const cs = block.cols.filter((c) => c >= m.c1 && c <= m.c2)
    const rs = block.rows.filter((r) => r >= m.r1 && r <= m.r2)
    if (!cs.length || !rs.length) continue
    const rect: MRect = { m, x: colX.get(cs[0])!, y: rowY.get(rs[0])!, w: cs.reduce((s, c) => s + geo.colW(c), 0), h: rs.reduce((s, r) => s + geo.rowH(r), 0) }
    mergedRects.push(rect)
    for (const r of rs) for (const c of cs) merged.set(`${r}:${c}`, rect)
  }

  // 1. fills
  for (const r of block.rows) {
    const row = sheet.cells.get(r)
    if (!row) continue
    for (const c of block.cols) {
      const cell = row.get(c)
      if (!cell) continue
      const mr = merged.get(`${r}:${c}`)
      if (mr) continue
      if (cell.style.fill) ops.push({ t: 'rect', x: X(colX.get(c)!), y: Y(rowY.get(r)!), w: geo.colW(c) * S, h: geo.rowH(r) * S, fill: cell.style.fill })
      if (cell.bar && cell.bar.frac > 0) {
        const bw = Math.max(0, (geo.colW(c) - 4) * cell.bar.frac)
        ops.push({ t: 'rect', x: X(colX.get(c)!) + 2 * S, y: Y(rowY.get(r)!) + 1.5 * S, w: bw * S, h: Math.max(1, geo.rowH(r) - 3) * S, fill: cell.bar.color })
      }
    }
  }
  for (const mr of mergedRects) {
    const anchor = cellAt(sheet, mr.m.r1, mr.m.c1)
    if (anchor?.style.fill) ops.push({ t: 'rect', x: X(mr.x), y: Y(mr.y), w: mr.w * S, h: mr.h * S, fill: anchor.style.fill })
  }

  // 2. gridlines
  if (p.gridLines) {
    const grid: Stroke = { color: '#c8c8c8', width: Math.max(0.25, 0.5 * S) }
    for (const r of block.rows) ops.push({ t: 'line', x1: X(0), x2: X(totalW), y1: Y(rowY.get(r)!), y2: Y(rowY.get(r)!), stroke: grid })
    ops.push({ t: 'line', x1: X(0), x2: X(totalW), y1: Y(totalH), y2: Y(totalH), stroke: grid })
    for (const c of block.cols) ops.push({ t: 'line', y1: Y(0), y2: Y(totalH), x1: X(colX.get(c)!), x2: X(colX.get(c)!), stroke: grid })
    ops.push({ t: 'line', y1: Y(0), y2: Y(totalH), x1: X(totalW), x2: X(totalW), stroke: grid })
  }

  // 3. borders: one edge map, thicker wins
  const hEdges = new Map<string, BorderLine>() // `${row}:${col}` top edge of row (row+1 => bottom edge)
  const vEdges = new Map<string, BorderLine>() // `${row}:${col}` left edge of col
  const put = (map: Map<string, BorderLine>, key: string, b: BorderLine | undefined): void => {
    if (!b) return
    const cur = map.get(key)
    if (!cur || b.width >= cur.width) map.set(key, b)
  }
  const rowNext = new Map<number, number>()
  block.rows.forEach((r, i) => rowNext.set(r, block.rows[i + 1] ?? -1))
  const colNext = new Map<number, number>()
  block.cols.forEach((c, i) => colNext.set(c, block.cols[i + 1] ?? -1))
  for (const r of block.rows) {
    const row = sheet.cells.get(r)
    if (!row) continue
    for (const c of block.cols) {
      const cell = row.get(c)
      if (!cell) continue
      const b = cell.style.borders
      put(hEdges, `${r}:${c}`, b.top)
      put(vEdges, `${r}:${c}`, b.left)
      const rn = rowNext.get(r)!
      const cn = colNext.get(c)!
      // bottom/right edges become the top/left edge of the next visible row/column (or an end edge)
      put(hEdges, `${rn >= 0 ? rn : 'end'}:${c}`, b.bottom)
      put(vEdges, `${r}:${cn >= 0 ? cn : 'end'}`, b.right)
    }
  }
  for (const [key, b] of hEdges) {
    const [rs, cs] = key.split(':')
    const c = Number(cs)
    const yy = rs === 'end' ? totalH : rowY.get(Number(rs))!
    if (!colX.has(c)) continue
    const x1 = colX.get(c)!
    // merge runs of equal neighbours later; single segments are fine for correctness
    pushEdge(ops, b, X(x1), Y(yy), X(x1 + geo.colW(c)), Y(yy), S)
  }
  for (const [key, b] of vEdges) {
    const [rs, cs] = key.split(':')
    const r = Number(rs)
    const xx = cs === 'end' ? totalW : colX.get(Number(cs))!
    if (!rowY.has(r)) continue
    const y1 = rowY.get(r)!
    pushEdge(ops, b, X(xx), Y(y1), X(xx), Y(y1 + geo.rowH(r)), S)
  }

  // 4. text
  const isEmptyCell = (r: number, c: number): boolean => {
    const cell = cellAt(sheet, r, c)
    return !cell || (cell.kind === 'empty' && !cell.text)
  }
  const drawCell = (r: number, c: number, cell0: SheetCell, rect: { x: number; y: number; w: number; h: number }): void => {
    let cell = cell0
    if (!cell.text && !cell.runs?.length) return
    const st = cell.style
    if (cell.kind === 'number' && cell.value !== undefined && !st.wrap && !st.shrink && cell.text === generalText(cell.value)) {
      // "General" numbers show as many digits as the column allows (like Excel/LibreOffice), or an exponent form
      const room = rect.w - 2 * PAD - st.indent * INDENT_PT
      const font = runsOf(cell, cell.color)[0].font
      const fitted = generalFit(cell.value, (t) => layoutRuns(env, [{ text: t, font }], 1e9, false)[0].w <= room + 0.01)
      if (fitted !== null && fitted !== cell.text) cell = { ...cell, text: fitted, runs: undefined }
    }
    const runs = runsOf(cell, cell.color)
    let inner = rect.w - 2 * PAD - st.indent * INDENT_PT
    let sizeScale = 1
    let lines: TLine[]
    // Text direction of the cell, and "General" alignment: text goes to the start side of its own direction (Arabic
    // right, English left, also in a right-to-left sheet), numbers to the right (LibreOffice does the same in
    // right-to-left sheets). Alignments are physical; in a right-to-left sheet the block is drawn mirrored (see
    // mirrorOps), so they are swapped here to come out on the intended side.
    const cellRtl = st.readingOrder ? st.readingOrder === 'rtl' : cell.kind === 'text' ? firstStrongRtl(cell.text) ?? !!sheet.rtl : !!sheet.rtl
    const physical = st.h === 'general' ? (cell.kind === 'number' ? 'right' : cell.kind === 'bool' || cell.kind === 'error' ? 'center' : cellRtl ? 'right' : 'left') : st.h
    const align = sheet.rtl ? (physical === 'left' ? 'right' : physical === 'right' ? 'left' : physical) : physical
    if (st.wrap) lines = layoutRuns(env, runs, Math.max(4, inner), true)
    else {
      lines = layoutRuns(env, runs, 1e9, false)
      const tw = lines[0].w
      if (st.shrink && tw > inner && inner > 4) {
        sizeScale = Math.max(0.3, inner / tw)
        lines = layoutRuns(env, runs, 1e9, false, sizeScale)
      } else if (cell.kind === 'number' && tw > inner + 0.01) {
        // numbers that do not fit show as ####
        const f0 = runs[0].font
        const face = env.catalog.face(f0.family, f0.bold, f0.italic)
        const hw = env.catalog.measure(env.catalog.segment(face, '#')[0].face, '#') * f0.size
        const n = Math.max(1, Math.floor(inner / hw))
        lines = layoutRuns(env, [{ text: '#'.repeat(n), font: f0 }], 1e9, false)
      }
    }
    // fill character (`*x` in the number format or "fill" alignment)
    if (!st.wrap && lines.length === 1 && (cell.fill || align === 'fill')) {
      const fillCh = cell.fill?.ch ?? cell.text
      if (fillCh) {
        const f0 = runs[0].font
        const face = env.catalog.face(f0.family, f0.bold, f0.italic)
        const seg = env.catalog.segment(face, fillCh)[0]
        if (seg) {
          const cw = env.catalog.measure(seg.face, seg.text) * f0.size * sizeScale
          const room = inner - (cell.fill ? lines[0].w : 0)
          const n = cw > 0 ? Math.floor(room / cw) : 0
          if (n > 0) {
            const padded = cell.fill ? cell.text.slice(0, cell.fill.index) + fillCh.repeat(n) + cell.text.slice(cell.fill.index) : fillCh.repeat(Math.max(1, Math.floor(inner / cw)))
            lines = layoutRuns(env, [{ text: padded, font: f0 }], 1e9, false, sizeScale)
          }
        }
      }
    }
    // spill into empty neighbours for non-wrapped overflowing text
    let sx = rect.x
    let sw = rect.w
    const textW = Math.max(...lines.map((l) => l.w))
    if (!st.wrap && cell.kind !== 'number' && textW > inner && align !== 'fill') {
      const mr = merged.get(`${r}:${c}`)
      const cLast = mr ? mr.m.c2 : c
      const cFirst = mr ? mr.m.c1 : c
      let right = 0
      let left = 0
      const need = textW - inner
      if (align === 'left' || align === 'center' || align === 'justify') {
        let k = block.cols.indexOf(cLast)
        while (right < need + (align === 'center' ? 0 : 0) && k + 1 < block.cols.length && isEmptyCell(r, block.cols[k + 1]) && !merged.has(`${r}:${block.cols[k + 1]}`)) {
          right += geo.colW(block.cols[k + 1])
          k++
        }
      }
      if (align === 'right' || align === 'center') {
        let k = block.cols.indexOf(cFirst)
        while (left < need && k - 1 >= 0 && isEmptyCell(r, block.cols[k - 1]) && !merged.has(`${r}:${block.cols[k - 1]}`)) {
          left += geo.colW(block.cols[k - 1])
          k--
        }
      }
      if (align === 'center') {
        const each = need / 2
        right = Math.min(right, each)
        left = Math.min(left, each)
        // give unused share to the other side when only one side has room
        if (right < each) left = Math.min(left + (each - right), need - right)
        if (left < each) right = Math.min(right + (each - left), need - left)
      }
      sx = rect.x - left
      sw = rect.w + left + right
      inner = sw - 2 * PAD - st.indent * INDENT_PT
    }
    const H = lines.reduce((s, l) => s + l.asc + l.desc, 0)
    let top: number
    if (st.v === 'top') top = rect.y + 1
    else if (st.v === 'center') top = rect.y + (rect.h - H) / 2
    else top = rect.y + rect.h - H - 0.8
    const overflowY = H > rect.h + 0.5
    const overflowX = Math.max(...lines.map((l) => l.w)) > inner + 0.5
    const needClip = overflowY || overflowX
    if (needClip) ops.push({ t: 'push', clip: { x: X(sx), y: Y(rect.y), w: sw * S, h: rect.h * S } })
    let ly = top
    for (const ln of lines) {
      const shaped = shapeLine(env.catalog, ln.pieces.map((pc) => ({ text: pc.text, style: { face: pc.face, size: Math.max(1, pc.size * S), color: pc.font.color } })), cellRtl ? 'rtl' : 'ltr')
      const lw = S > 0 ? shaped.width / S : ln.w
      let lx: number
      if (align === 'right') lx = sx + sw - PAD - lw - (st.indent ? st.indent * INDENT_PT : 0)
      else if (align === 'center') lx = sx + (sw - lw) / 2
      else lx = sx + PAD + st.indent * INDENT_PT
      const baseline = ly + ln.asc
      ops.push(glyphOp(shaped, X(lx), Y(baseline)))
      ln.pieces.forEach((pc, k) => {
        for (const seg of shaped.items[k]!.pieces) {
          const x1 = X(lx) + seg.x
          if (pc.font.underline) ops.push({ t: 'line', x1, x2: x1 + seg.w, y1: Y(baseline + pc.size * 0.12), y2: Y(baseline + pc.size * 0.12), stroke: { color: pc.font.color, width: Math.max(0.3, (pc.size * S) / 18) } })
          if (pc.font.strike) ops.push({ t: 'line', x1, x2: x1 + seg.w, y1: Y(baseline - pc.size * 0.28), y2: Y(baseline - pc.size * 0.28), stroke: { color: pc.font.color, width: Math.max(0.3, (pc.size * S) / 20) } })
        }
      })
      ly += ln.asc + ln.desc
    }
    if (needClip) ops.push({ t: 'pop' })
    if (cell.link) ops.push({ t: 'link', x: X(rect.x), y: Y(rect.y), w: rect.w * S, h: rect.h * S, url: cell.link })
  }
  for (const r of block.rows) {
    const row = sheet.cells.get(r)
    if (!row) continue
    for (const c of block.cols) {
      const cell = row.get(c)
      if (!cell) continue
      const mr = merged.get(`${r}:${c}`)
      if (mr) continue
      drawCell(r, c, cell, { x: colX.get(c)!, y: rowY.get(r)!, w: geo.colW(c), h: geo.rowH(r) })
    }
  }
  for (const mr of mergedRects) {
    const anchor = cellAt(sheet, mr.m.r1, mr.m.c1)
    if (anchor) drawCell(mr.m.r1, mr.m.c1, anchor, mr)
  }

  // 5. pictures / placeholders anchored in this block
  for (const im of sheet.images) {
    const from = anchorOf(geo, im)
    const x0 = geo.colStart(from.col) + from.dx
    const y0 = geo.rowStart(from.row) + from.dy
    let w = im.w ?? 0
    let h = im.h ?? 0
    if (im.to) {
      w = geo.colStart(im.to.col) + im.to.dx - x0
      h = geo.rowStart(im.to.row) + im.to.dy - y0
    }
    if (w <= 0 || h <= 0) continue
    if (!colSet.has(from.col) || !rowSet.has(from.row)) continue
    const bx = colX.get(from.col)! + from.dx
    const by = rowY.get(from.row)! + from.dy
    ops.push({ t: 'push', clip: { x: X(0), y: Y(0), w: Math.max(totalW * S, 1), h: Math.max(totalH * S, 1) } })
    if (im.image) ops.push({ t: 'image', x: X(bx), y: Y(by), w: w * S, h: h * S, image: im.image })
    else {
      ops.push({ t: 'rect', x: X(bx), y: Y(by), w: w * S, h: h * S, stroke: { color: '#808080', width: 0.75, dash: [3, 2] }, fill: '#f2f2f2' })
      if (im.label) {
        const face = env.catalog.face('Liberation Sans', false, false)
        const seg = env.catalog.segment(face, im.label)
        let cx = X(bx) + 4
        for (const s of seg) {
          ops.push({ t: 'text', x: cx, y: Y(by) + 12 * Math.max(S, 0.5), text: s.text, face: s.face, size: 9 * Math.max(S, 0.5), color: '#404040' })
          cx += env.catalog.measure(s.face, s.text) * 9 * Math.max(S, 0.5)
        }
      }
    }
    ops.push({ t: 'pop' })
  }
  // Right-to-left sheet: the block was drawn left to right; mirror it inside the printable width (column A on the right)
  if (sheet.rtl) mirrorOps(ops, p.margins.left + p.paper.w - p.margins.right, (o) => env.catalog.measure(o.face, o.text) * o.size)
  return { width: p.paper.w, height: p.paper.h, ops }
}

/** Mirrors display-list ops horizontally: x -> axis - x. Text keeps its reading direction (only its box moves). */
export function mirrorOps(ops: Op[], axis: number, textWidth: (o: Extract<Op, { t: 'text' }>) => number): void {
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]!
    switch (o.t) {
      case 'text':
        ops[i] = { ...o, x: axis - o.x - textWidth(o) }
        break
      case 'glyphs':
        ops[i] = { ...o, x: axis - o.x - o.w }
        break
      case 'rect':
      case 'image':
      case 'link':
        ops[i] = { ...o, x: axis - o.x - o.w }
        break
      case 'line':
        ops[i] = { ...o, x1: axis - o.x1, x2: axis - o.x2 }
        break
      case 'path':
        ops[i] = { ...o, d: o.d.map((s) => (s[0] === 'M' || s[0] === 'L' ? [s[0], axis - s[1], s[2]] : s[0] === 'C' ? ['C', axis - s[1], s[2], axis - s[3], s[4], axis - s[5], s[6]] : s) as typeof s) }
        break
      case 'push':
        if (o.clip) ops[i] = { ...o, clip: { ...o.clip, x: axis - o.clip.x - o.clip.w } }
        break
      default:
        break
    }
  }
}

function pushEdge(ops: Op[], b: BorderLine, x1: number, y1: number, x2: number, y2: number, S: number): void {
  if (b.style === 'double') {
    const g = Math.max(1.2, b.width * S)
    const s: Stroke = { color: b.color, width: Math.max(0.25, b.width * S * 0.5) }
    if (Math.abs(y1 - y2) < 1e-6) ops.push({ t: 'line', x1, x2, y1: y1 - g / 2, y2: y2 - g / 2, stroke: s }, { t: 'line', x1, x2, y1: y1 + g / 2, y2: y2 + g / 2, stroke: s })
    else ops.push({ t: 'line', x1: x1 - g / 2, x2: x2 - g / 2, y1, y2, stroke: s }, { t: 'line', x1: x1 + g / 2, x2: x2 + g / 2, y1, y2, stroke: s })
    return
  }
  ops.push({ t: 'line', x1, y1, x2, y2, stroke: LINE_DASH(b, S) })
}

function drawHeadersFooters(env: ConvertEnv, sheet: SheetModel, pages: Page[]): void {
  const p = sheet.print
  if (!p.header && !p.footer) return
  const total = pages.length
  const now = new Date()
  const date = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`
  const time = `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() < 12 ? 'AM' : 'PM'}`
  const start = p.firstPageNumber ?? 1
  pages.forEach((page, i) => {
    const no = start + i
    const vars = { page: no, pages: total + start - 1, sheet: sheet.name, file: p.fileName ?? '', date, time }
    for (const which of ['header', 'footer'] as const) {
      const hf = p[which]
      if (!hf) continue
      let set: HFSet | undefined
      if (hf.differentFirst && i === 0 && hf.first) set = hf.first
      else if (hf.differentOddEven && no % 2 === 0 && hf.even) set = hf.even
      else set = hf.odd
      if (!set) continue
      for (const pos of ['left', 'center', 'right'] as const) {
        const runs = hfText(set[pos], vars).filter((x) => x.text)
        if (!runs.length) continue
        // split into lines on \n
        const lines: { text: string; run: HFRun }[][] = [[]]
        for (const r of runs) {
          const parts = r.text.split(/\r?\n/)
          parts.forEach((t, k) => {
            if (k > 0) lines.push([])
            if (t) lines[lines.length - 1].push({ text: t, run: r.run })
          })
        }
        const metricsOfLine = lines.map((ln) => {
          const rr: RichRun[] = ln.map((x) => ({ text: x.text, font: { ...DEFAULT_FONT, size: x.run.size ?? 11, family: x.run.family ?? 'Calibri', bold: !!x.run.bold, italic: !!x.run.italic, underline: !!x.run.underline } }))
          return layoutRuns(env, rr.length ? rr : [{ text: ' ', font: DEFAULT_FONT }], 1e9, false)[0]
        })
        const availW = p.paper.w - p.margins.left - p.margins.right
        const totalH = metricsOfLine.reduce((s, l) => s + l.asc + l.desc, 0)
        let y = which === 'header' ? p.margins.header : p.paper.h - p.margins.footer - totalH
        for (const ln of metricsOfLine) {
          const shaped = shapeLine(env.catalog, ln.pieces.map((pc) => ({ text: pc.text, style: { face: pc.face, size: pc.size, color: '#000000' } })), 'auto')
          const x = pos === 'left' ? p.margins.left : pos === 'right' ? p.margins.left + availW - shaped.width : p.margins.left + (availW - shaped.width) / 2
          page.ops.push(glyphOp(shaped, x, y + ln.asc))
          ln.pieces.forEach((pc, k) => {
            if (!pc.font.underline) return
            for (const seg of shaped.items[k]!.pieces) page.ops.push({ t: 'line', x1: x + seg.x, x2: x + seg.x + seg.w, y1: y + ln.asc + pc.size * 0.12, y2: y + ln.asc + pc.size * 0.12, stroke: { color: '#000000', width: Math.max(0.3, pc.size / 18) } })
          })
          y += ln.asc + ln.desc
        }
      }
    }
  })
}
