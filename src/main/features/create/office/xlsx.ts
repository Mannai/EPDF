import { OfficeError, throwIfCancelled, type ConvertEnv } from './env'
import { imageFormat, openPackage, relationshipsOf, type Pkg } from './package'
import { builtinFormatCode, formatNumber, formatText } from './numfmt'
import type { Page } from './ops'
import {
  DEFAULT_FONT,
  layoutSheet,
  newSheet,
  setCell,
  type BorderLine,
  type CellFont,
  type CellStyle,
  type HFRun,
  type HFSet,
  type HeaderFooter,
  type Range,
  type RichRun,
  type SheetCell,
  type SheetImage,
  type SheetModel
} from './sheet'
import { attr, child, childrenNamed, descendants, numAttr, path, textContent, type XNode } from './xml'

/**
 * XLSX -> PDF with the built-in engine. Cell values come from the file (cached formula results, shared
 * strings), are formatted with the number-format engine (numfmt.ts) and printed by the sheet layout engine
 * (sheet.ts) honouring page setup, print areas/titles and fit-to-page.
 */

const txt = (n: XNode | undefined): string => (n ? textContent(n) : '')

const MAX_CELLS = 3_000_000
const MAX_SHEET_XML = 250 * 1024 * 1024

const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333', '000000', 'FFFFFF'
]

const DEFAULT_THEME = ['000000', 'FFFFFF', '44546A', 'E7E6E6', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72']

const PAPER: Record<number, [number, number]> = {
  1: [612, 792], 2: [612, 792], 3: [792, 1224], 4: [1224, 792], 5: [612, 1008], 6: [396, 612], 7: [522, 756], 8: [841.89, 1190.55], 9: [595.28, 841.89], 10: [595.28, 841.89],
  11: [419.53, 595.28], 12: [728.5, 1031.8], 13: [515.9, 728.5], 14: [612, 936], 15: [609.4, 779.5], 16: [720, 1008], 17: [792, 1224], 18: [576, 792], 19: [279, 639], 20: [297, 684],
  25: [1224, 1584], 26: [841.89, 1190.55], 27: [297.64, 649.13], 28: [459.21, 649.13], 29: [649.13, 918.43], 30: [419.53, 595.28], 41: [612, 936], 42: [595.28, 850], 43: [283.46, 419.53], 44: [612, 756]
}

// ---------------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const rgbToHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

function applyTint(hex: string, tint: number): string {
  if (!tint) return hex
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  let l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint
  const hue = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let rr: number, gg: number, bb: number
  if (s === 0) rr = gg = bb = l
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    rr = hue(p, q, h + 1 / 3)
    gg = hue(p, q, h)
    bb = hue(p, q, h - 1 / 3)
  }
  return rgbToHex(rr * 255, gg * 255, bb * 255)
}

interface ColorCtx {
  theme: string[]
  indexed: string[]
}

function colorOf(n: XNode | undefined, ctx: ColorCtx): string | undefined {
  if (!n) return undefined
  const rgb = attr(n, 'rgb')
  const tint = numAttr(n, 'tint') ?? 0
  if (rgb) return applyTint('#' + rgb.slice(-6), tint)
  const th = numAttr(n, 'theme')
  if (th !== undefined) {
    const map = th === 0 ? 1 : th === 1 ? 0 : th === 2 ? 3 : th === 3 ? 2 : th
    return applyTint('#' + (ctx.theme[map] ?? '000000'), tint)
  }
  const ix = numAttr(n, 'indexed')
  if (ix !== undefined) return '#' + (ctx.indexed[ix] ?? '000000')
  return undefined
}

function readTheme(pkg: Pkg): string[] {
  const root = pkg.xml('xl/theme/theme1.xml')
  const scheme = root ? descendants(root, 'clrScheme')[0] : undefined
  if (!scheme) return DEFAULT_THEME
  const out = scheme.children.map((c) => {
    const inner = c.children[0]
    return (attr(inner, 'val') && inner.name === 'srgbClr' ? attr(inner, 'val')! : attr(inner, 'lastClr')) ?? '000000'
  })
  return out.length >= 10 ? out : DEFAULT_THEME
}

// ---------------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------------

interface Xf {
  style: CellStyle
  numFmt: string | undefined
}

const BORDER_W: Record<string, [number, BorderLine['style']]> = {
  thin: [0.75, 'single'],
  medium: [1.5, 'single'],
  thick: [2.25, 'single'],
  hair: [0.3, 'single'],
  dashed: [0.75, 'dashed'],
  dotted: [0.75, 'dotted'],
  double: [1.5, 'double'],
  mediumDashed: [1.5, 'dashed'],
  dashDot: [0.75, 'dashed'],
  dashDotDot: [0.75, 'dashed'],
  slantDashDot: [1.5, 'dashed'],
  mediumDashDot: [1.5, 'dashed'],
  mediumDashDotDot: [1.5, 'dashed']
}

const boolAttr = (n: XNode | undefined): boolean => {
  if (!n) return false
  const v = attr(n, 'val')
  return v === undefined || v === '1' || v === 'true'
}

function readFont(n: XNode, ctx: ColorCtx): CellFont {
  const u = child(n, 'u')
  return {
    family: attr(child(n, 'name'), 'val') ?? 'Calibri',
    size: numAttr(child(n, 'sz'), 'val') ?? 11,
    bold: boolAttr(child(n, 'b')),
    italic: boolAttr(child(n, 'i')),
    underline: !!u && attr(u, 'val') !== 'none',
    strike: boolAttr(child(n, 'strike')),
    color: colorOf(child(n, 'color'), ctx) ?? '#000000'
  }
}

interface Dxf {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  fill?: string
  borders?: CellStyle['borders']
}

interface Styles {
  xfs: Xf[]
  fonts: CellFont[]
  numFmts: Map<number, string>
  colors: ColorCtx
  dxfs: Dxf[]
}

function readStyles(pkg: Pkg, env: ConvertEnv): Styles {
  const colors: ColorCtx = { theme: readTheme(pkg), indexed: [...INDEXED] }
  const root = pkg.xml('xl/styles.xml')?.children.find((c) => c.name === 'styleSheet')
  const numFmts = new Map<number, string>()
  const fonts: CellFont[] = []
  const fills: (string | undefined)[] = []
  const borders: CellStyle['borders'][] = []
  const xfs: Xf[] = []
  if (!root) {
    return { xfs: [{ style: { font: DEFAULT_FONT, borders: {}, h: 'general', v: 'bottom', wrap: false, indent: 0, shrink: false }, numFmt: undefined }], fonts: [DEFAULT_FONT], numFmts, colors, dxfs: [] }
  }
  const custom = path(root, 'colors', 'indexedColors')
  if (custom) custom.children.forEach((c, i) => (colors.indexed[i] = (attr(c, 'rgb') ?? 'FF000000').slice(-6)))
  for (const nf of childrenNamed(child(root, 'numFmts'), 'numFmt')) numFmts.set(numAttr(nf, 'numFmtId')!, attr(nf, 'formatCode') ?? 'General')
  for (const f of childrenNamed(child(root, 'fonts'), 'font')) fonts.push(readFont(f, colors))
  if (!fonts.length) fonts.push(DEFAULT_FONT)
  let warnedPattern = false
  for (const f of childrenNamed(child(root, 'fills'), 'fill')) {
    const pf = child(f, 'patternFill')
    const gf = child(f, 'gradientFill')
    if (pf) {
      const type = attr(pf, 'patternType') ?? 'none'
      const fg = colorOf(child(pf, 'fgColor'), colors)
      const bg = colorOf(child(pf, 'bgColor'), colors) ?? '#ffffff'
      if (type === 'solid') fills.push(fg)
      else if (type === 'none' || type === 'gray125') fills.push(undefined)
      else {
        if (fg && !warnedPattern) {
          warnedPattern = true
          env.warnings.add('Patterned cell fills are approximated with a flat colour.')
        }
        const dens = type === 'darkGray' ? 0.75 : type === 'mediumGray' ? 0.5 : type === 'lightGray' ? 0.25 : 0.4
        if (fg) {
          const a = hexToRgb(fg)
          const b = hexToRgb(bg)
          fills.push(rgbToHex(a[0] * dens + b[0] * (1 - dens), a[1] * dens + b[1] * (1 - dens), a[2] * dens + b[2] * (1 - dens)))
        } else fills.push(undefined)
      }
    } else if (gf) {
      env.warnings.add('Gradient cell fills are approximated with a flat colour.')
      fills.push(colorOf(child(child(gf, 'stop'), 'color'), colors))
    } else fills.push(undefined)
  }
  for (const b of childrenNamed(child(root, 'borders'), 'border')) {
    const out: CellStyle['borders'] = {}
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const s = child(b, side)
      const st = attr(s, 'style')
      if (!s || !st) continue
      const [width, style] = BORDER_W[st] ?? [0.75, 'single']
      out[side] = { width, style, color: colorOf(child(s, 'color'), colors) ?? '#000000' }
    }
    borders.push(out)
  }
  const xfNodes = childrenNamed(child(root, 'cellXfs'), 'xf')
  for (const x of xfNodes.length ? xfNodes : [undefined]) {
    const font = fonts[numAttr(x, 'fontId') ?? 0] ?? fonts[0]
    const al = child(x, 'alignment')
    const h = attr(al, 'horizontal')
    const v = attr(al, 'vertical')
    const id = numAttr(x, 'numFmtId') ?? 0
    xfs.push({
      numFmt: numFmts.get(id) ?? builtinFormatCode(id),
      style: {
        font,
        fill: fills[numAttr(x, 'fillId') ?? 0],
        borders: borders[numAttr(x, 'borderId') ?? 0] ?? {},
        h: h === 'left' || h === 'center' || h === 'right' || h === 'fill' || h === 'justify' ? h : h === 'centerContinuous' ? 'center' : h === 'distributed' ? 'justify' : 'general',
        v: v === 'top' ? 'top' : v === 'center' ? 'center' : 'bottom',
        wrap: attr(al, 'wrapText') === '1' || attr(al, 'wrapText') === 'true',
        indent: numAttr(al, 'indent') ?? 0,
        shrink: attr(al, 'shrinkToFit') === '1' || attr(al, 'shrinkToFit') === 'true'
      }
    })
  }
  const dxfs: Dxf[] = childrenNamed(child(root, 'dxfs'), 'dxf').map((d) => {
    const out: Dxf = {}
    const f = child(d, 'font')
    if (f) {
      if (child(f, 'b')) out.bold = boolAttr(child(f, 'b'))
      if (child(f, 'i')) out.italic = boolAttr(child(f, 'i'))
      if (child(f, 'strike')) out.strike = boolAttr(child(f, 'strike'))
      if (child(f, 'u')) out.underline = attr(child(f, 'u'), 'val') !== 'none'
      out.color = colorOf(child(f, 'color'), colors)
    }
    const pf = child(child(d, 'fill'), 'patternFill')
    if (pf) out.fill = colorOf(child(pf, 'bgColor'), colors) ?? colorOf(child(pf, 'fgColor'), colors)
    const b = child(d, 'border')
    if (b) {
      out.borders = {}
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        const s = child(b, side)
        const st = attr(s, 'style')
        if (!s || !st) continue
        const [width, style] = BORDER_W[st] ?? [0.75, 'single']
        out.borders[side] = { width, style, color: colorOf(child(s, 'color'), colors) ?? '#000000' }
      }
    }
    return out
  })
  return { xfs, fonts, numFmts, colors, dxfs }
}

// ---------------------------------------------------------------------------------------------------
// Conditional formatting (cellIs, colorScale, dataBar); other rule types are reported, not applied
// ---------------------------------------------------------------------------------------------------

function lerpColor(a: string, b: string, t: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return rgbToHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t)
}

function applyConditionalFormatting(sheet: SheetModel, ws: XNode, styles: Styles, env: ConvertEnv): void {
  interface Rule {
    ranges: Range[]
    node: XNode
    priority: number
  }
  const rules: Rule[] = []
  for (const cf of childrenNamed(ws, 'conditionalFormatting')) {
    const ranges = (attr(cf, 'sqref') ?? '').split(/\s+/).map(parseRange).filter((x): x is Range => !!x)
    for (const r of childrenNamed(cf, 'cfRule')) rules.push({ ranges, node: r, priority: numAttr(r, 'priority') ?? 1e9 })
  }
  if (!rules.length) return
  rules.sort((a, b) => a.priority - b.priority)
  const unsupported = new Set<string>()
  const numericCells = (ranges: Range[]): { cell: SheetCell; v: number }[] => {
    const out: { cell: SheetCell; v: number }[] = []
    for (const g of ranges) {
      for (let r = g.r1; r <= g.r2; r++) {
        const row = sheet.cells.get(r)
        if (!row) continue
        for (const [c, cell] of row) if (c >= g.c1 && c <= g.c2 && cell.value !== undefined) out.push({ cell, v: cell.value })
      }
    }
    return out
  }
  const threshold = (cfvo: XNode, vals: number[]): number => {
    const type = attr(cfvo, 'type')
    const val = parseFloat(attr(cfvo, 'val') ?? '')
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    if (type === 'num') return val
    if (type === 'percent') return min + ((max - min) * val) / 100
    if (type === 'percentile') {
      const s = [...vals].sort((a, b) => a - b)
      const idx = (val / 100) * (s.length - 1)
      const lo = Math.floor(idx)
      return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (idx - lo)
    }
    return type === 'max' ? max : min
  }
  for (const { ranges, node, priority } of rules) {
    void priority
    const type = attr(node, 'type') ?? ''
    if (type === 'cellIs') {
      const op = attr(node, 'operator') ?? ''
      const fs = childrenNamed(node, 'formula').map((f) => Number(textContent(f)))
      if (fs.some((x) => !Number.isFinite(x))) {
        unsupported.add('cellIs with a formula or cell reference')
        continue
      }
      const dxf = styles.dxfs[numAttr(node, 'dxfId') ?? -1]
      if (!dxf) continue
      for (const { cell, v } of numericCells(ranges)) {
        const [a, b] = fs
        const hit =
          op === 'greaterThan' ? v > a : op === 'greaterThanOrEqual' ? v >= a : op === 'lessThan' ? v < a : op === 'lessThanOrEqual' ? v <= a : op === 'equal' ? v === a : op === 'notEqual' ? v !== a : op === 'between' ? v >= Math.min(a, b) && v <= Math.max(a, b) : op === 'notBetween' ? v < Math.min(a, b) || v > Math.max(a, b) : false
        if (!hit) continue
        cell.style = {
          ...cell.style,
          font: { ...cell.style.font, ...(dxf.bold !== undefined ? { bold: dxf.bold } : {}), ...(dxf.italic !== undefined ? { italic: dxf.italic } : {}), ...(dxf.underline !== undefined ? { underline: dxf.underline } : {}), ...(dxf.strike !== undefined ? { strike: dxf.strike } : {}), ...(dxf.color ? { color: dxf.color } : {}) },
          fill: dxf.fill ?? cell.style.fill,
          borders: { ...cell.style.borders, ...(dxf.borders ?? {}) }
        }
      }
    } else if (type === 'colorScale') {
      const cs = child(node, 'colorScale')
      const cfvos = childrenNamed(cs, 'cfvo')
      const cols = childrenNamed(cs, 'color').map((c) => colorOf(c, styles.colors) ?? '#ffffff')
      const cells = numericCells(ranges)
      if (!cells.length || cfvos.length < 2 || cols.length < cfvos.length) continue
      const vals = cells.map((c) => c.v)
      const th = cfvos.map((c) => threshold(c, vals))
      for (const { cell, v } of cells) {
        let i = 0
        while (i < th.length - 2 && v > th[i + 1]) i++
        const span = th[i + 1] - th[i]
        const t = span === 0 ? 0 : Math.max(0, Math.min(1, (v - th[i]) / span))
        cell.style = { ...cell.style, fill: lerpColor(cols[i], cols[i + 1], t) }
      }
    } else if (type === 'dataBar') {
      const db = child(node, 'dataBar')
      const cfvos = childrenNamed(db, 'cfvo')
      const color = colorOf(child(db, 'color'), styles.colors) ?? '#638ec6'
      const cells = numericCells(ranges)
      if (!cells.length) continue
      const vals = cells.map((c) => c.v)
      const lo = cfvos[0] ? threshold(cfvos[0], vals) : Math.min(...vals)
      const hi = cfvos[1] ? threshold(cfvos[1], vals) : Math.max(...vals)
      for (const { cell, v } of cells) cell.bar = { frac: hi === lo ? 1 : Math.max(0.02, Math.min(1, (v - lo) / (hi - lo))), color: lerpColor(color, '#ffffff', 0.35) }
    } else unsupported.add(type || 'unknown')
  }
  if (unsupported.size) env.warnings.add(`Conditional formatting rules of type ${[...unsupported].join(', ')} are not applied (cell colour scales, data bars and simple “cell value” rules are).`)
}

// ---------------------------------------------------------------------------------------------------
// Shared strings
// ---------------------------------------------------------------------------------------------------

interface SstEntry {
  text: string
  runs?: { text: string; rPr?: XNode }[]
}

function readSharedStrings(pkg: Pkg): SstEntry[] {
  const root = pkg.xml('xl/sharedStrings.xml')?.children.find((c) => c.name === 'sst')
  if (!root) return []
  return childrenNamed(root, 'si').map((si) => siEntry(si))
}

function siEntry(si: XNode): SstEntry {
  const rs = childrenNamed(si, 'r')
  if (rs.length) {
    const runs = rs.map((r) => ({ text: textContent(child(r, 't') ?? r), rPr: child(r, 'rPr') }))
    return { text: runs.map((r) => r.text).join(''), runs }
  }
  return { text: childrenNamed(si, 't').map((t) => textContent(t)).join('') }
}

function runFont(base: CellFont, rPr: XNode | undefined, ctx: ColorCtx): CellFont {
  if (!rPr) return base
  const f = { ...base }
  const name = attr(child(rPr, 'rFont'), 'val')
  if (name) f.family = name
  const sz = numAttr(child(rPr, 'sz'), 'val')
  if (sz) f.size = sz
  if (child(rPr, 'b')) f.bold = boolAttr(child(rPr, 'b'))
  if (child(rPr, 'i')) f.italic = boolAttr(child(rPr, 'i'))
  if (child(rPr, 'strike')) f.strike = boolAttr(child(rPr, 'strike'))
  const u = child(rPr, 'u')
  if (u) f.underline = attr(u, 'val') !== 'none'
  const col = colorOf(child(rPr, 'color'), ctx)
  if (col) f.color = col
  return f
}

// ---------------------------------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------------------------------

export function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export function parseCellRef(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim())
  return m ? { c: colIndex(m[1]), r: parseInt(m[2], 10) - 1 } : null
}

function parseRange(ref: string): Range | null {
  const [a, b] = ref.split(':')
  const s = parseCellRef(a)
  const e = b ? parseCellRef(b) : s
  if (!s || !e) return null
  return { r1: Math.min(s.r, e.r), c1: Math.min(s.c, e.c), r2: Math.max(s.r, e.r), c2: Math.max(s.c, e.c) }
}

interface DefinedRef {
  sheet: string
  range?: Range
  rows?: [number, number]
  cols?: [number, number]
}

/** Parses `Sheet1!$A$1:$C$5,'My Sheet'!$1:$2` style references. */
export function parseDefinedRefs(text: string): DefinedRef[] {
  const out: DefinedRef[] = []
  const re = /(?:'((?:[^']|'')+)'|([^!,'\s]+))!([^,]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const sheet = (m[1] ?? m[2]).replace(/''/g, "'")
    const ref = m[3].trim()
    const rows = /^\$?(\d+):\$?(\d+)$/.exec(ref)
    const cols = /^\$?([A-Za-z]+):\$?([A-Za-z]+)$/.exec(ref)
    if (rows) out.push({ sheet, rows: [parseInt(rows[1], 10) - 1, parseInt(rows[2], 10) - 1] })
    else if (cols) out.push({ sheet, cols: [colIndex(cols[1]), colIndex(cols[2])] })
    else {
      const r = parseRange(ref)
      if (r) out.push({ sheet, range: r })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Header / footer codes
// ---------------------------------------------------------------------------------------------------

export function parseHeaderFooter(src: string | undefined): HFSet | undefined {
  if (!src) return undefined
  const set: HFSet = { left: [], center: [], right: [] }
  let cur: keyof HFSet = 'center'
  let bold = false
  let italic = false
  let underline = false
  let size: number | undefined
  let family: string | undefined
  let text = ''
  const flush = (): void => {
    if (text) set[cur].push({ text, bold, italic, underline, size, family })
    text = ''
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch !== '&') {
      text += ch
      continue
    }
    const nx = src[i + 1]
    if (nx === undefined) break
    if (nx === '&') {
      text += '&'
      i++
      continue
    }
    if (nx === 'L' || nx === 'C' || nx === 'R') {
      flush()
      cur = nx === 'L' ? 'left' : nx === 'C' ? 'center' : 'right'
      i++
      continue
    }
    const fieldMap: Record<string, HFRun['field']> = { P: 'page', N: 'pages', D: 'date', T: 'time', A: 'sheet', F: 'file', Z: 'path' }
    if (fieldMap[nx]) {
      flush()
      set[cur].push({ field: fieldMap[nx], bold, italic, underline, size, family })
      i++
      continue
    }
    if (nx === 'B') bold = !bold
    else if (nx === 'I') italic = !italic
    else if (nx === 'U') underline = !underline
    else if (nx === '"') {
      const end = src.indexOf('"', i + 2)
      const spec = src.slice(i + 2, end < 0 ? src.length : end)
      flush()
      const [fam, style] = spec.split(',')
      if (fam && fam !== '-') family = fam
      if (style) {
        bold = /bold/i.test(style)
        italic = /italic|oblique/i.test(style)
      }
      i = end < 0 ? src.length : end
      continue
    } else if (/\d/.test(nx)) {
      let j = i + 1
      while (j < src.length && /\d/.test(src[j]) && j - i <= 3) j++
      flush()
      size = parseInt(src.slice(i + 1, j), 10)
      i = j - 1
      continue
    } else if (nx === 'K') {
      i += 7 // colour code ignored
      continue
    }
    flush()
    i++
  }
  flush()
  return set
}

// ---------------------------------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------------------------------

interface SheetRef {
  name: string
  part: string
  hidden: boolean
  chart: boolean
}

function rootRelsTarget(pkg: Pkg): string {
  const rels = pkg.xml('_rels/.rels')
  const rs = rels?.children.find((c) => c.name === 'Relationships')
  for (const r of rs?.children ?? []) {
    if ((r.attrs['Type'] ?? '').endsWith('/officeDocument')) return (r.attrs['Target'] ?? '').replace(/^\//, '')
  }
  return 'xl/workbook.xml'
}

const excelSerialFromIso = (iso: string): number | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(iso)
  if (!m) return undefined
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
  return ms / 86400000 + 25569
}

export async function convertXlsx(bytes: Uint8Array, env: ConvertEnv): Promise<Page[]> {
  const pkg = openPackage(bytes, 'workbook')
  const wbPart = pkg.has('xl/workbook.xml') ? 'xl/workbook.xml' : rootRelsTarget(pkg)
  const wbRoot = pkg.xml(wbPart)?.children.find((c) => c.name === 'workbook')
  if (!wbRoot) throw new OfficeError('This file does not look like an Excel workbook (xl/workbook.xml is missing).')
  if (pkg.has('xl/vbaProject.bin')) env.warnings.add('Macros in the workbook are ignored.')
  const rels = relationshipsOf(pkg, wbPart)
  const date1904 = attr(child(wbRoot, 'workbookPr'), 'date1904') === '1' || attr(child(wbRoot, 'workbookPr'), 'date1904') === 'true'
  const sheetRefs: SheetRef[] = []
  for (const s of childrenNamed(child(wbRoot, 'sheets'), 'sheet')) {
    const rel = rels.get(attr(s, 'id') ?? '')
    if (!rel) continue
    sheetRefs.push({ name: attr(s, 'name') ?? 'Sheet', part: rel.target, hidden: !!attr(s, 'state') && attr(s, 'state') !== 'visible', chart: rel.type === 'chartsheet' })
  }
  if (!sheetRefs.length) throw new OfficeError('This workbook contains no sheets.')
  const styles = readStyles(pkg, env)
  const sst = readSharedStrings(pkg)
  // digit width of the default font decides column pixel widths
  const dfont = styles.fonts[0] ?? DEFAULT_FONT
  const dface = env.catalog.face(dfont.family, dfont.bold, dfont.italic)
  const mdw = Math.max(5, Math.round(env.catalog.measure(env.catalog.segment(dface, '0')[0].face, '0') * dfont.size * (96 / 72)))
  const colPts = (chars: number): number => Math.round(chars * mdw) * 0.75

  // defined names: print areas and titles
  const areas = new Map<number, Range[]>()
  const titles = new Map<number, { rows?: [number, number]; cols?: [number, number] }>()
  for (const dn of childrenNamed(child(wbRoot, 'definedNames'), 'definedName')) {
    const name = attr(dn, 'name')
    if (name !== '_xlnm.Print_Area' && name !== '_xlnm.Print_Titles') continue
    const idx = numAttr(dn, 'localSheetId')
    const refs = parseDefinedRefs(textContent(dn))
    for (const ref of refs) {
      const si = idx ?? sheetRefs.findIndex((s) => s.name === ref.sheet)
      if (si < 0) continue
      if (name === '_xlnm.Print_Area' && ref.range) areas.set(si, [...(areas.get(si) ?? []), ref.range])
      if (name === '_xlnm.Print_Titles') titles.set(si, { ...(titles.get(si) ?? {}), ...(ref.rows ? { rows: ref.rows } : {}), ...(ref.cols ? { cols: ref.cols } : {}) })
    }
  }

  const pages: Page[] = []
  let warnedNoValue = false
  let warnedTable = false
  const warnOnce = { noValue: () => { if (!warnedNoValue) { warnedNoValue = true; env.warnings.add('Some formulas have no stored result (the file was not last saved by a spreadsheet program), so those cells are blank.') } } }

  for (let si = 0; si < sheetRefs.length; si++) {
    throwIfCancelled(env)
    const sref = sheetRefs[si]
    env.progress(si / sheetRefs.length, `Converting sheet ${sref.name}`)
    if (sref.hidden) {
      env.warnings.add(`Hidden sheet “${sref.name}” was not printed.`)
      continue
    }
    if (sref.chart) {
      env.warnings.add(`Chart sheet “${sref.name}” is not rendered by the built-in engine.`)
      continue
    }
    const raw = pkg.bytes(sref.part)
    if (!raw) continue
    if (raw.length > MAX_SHEET_XML) {
      env.warnings.add(`Sheet “${sref.name}” is too large for the built-in engine and was skipped.`)
      continue
    }
    const wsRoot = pkg.xml(sref.part)?.children.find((c) => c.name === 'worksheet')
    if (!wsRoot) continue
    const srels = relationshipsOf(pkg, sref.part)
    const sheet = newSheet(sref.name, env.page)
    sheet.print.fileName = ''
    sheet.defaultFont = dfont

    // format defaults
    const fmt = child(wsRoot, 'sheetFormatPr')
    const baseCols = numAttr(fmt, 'baseColWidth') ?? 8
    sheet.defaultRowHeight = numAttr(fmt, 'defaultRowHeight') ?? 15
    const dcw = numAttr(fmt, 'defaultColWidth')
    sheet.defaultColWidth = dcw !== undefined ? colPts(dcw) : Math.ceil((baseCols * mdw + 5) / 8) * 8 * 0.75
    for (const col of childrenNamed(child(wsRoot, 'cols'), 'col')) {
      const min = (numAttr(col, 'min') ?? 1) - 1
      const max = Math.min((numAttr(col, 'max') ?? min + 1) - 1, 16383)
      const w = numAttr(col, 'width')
      const hidden = attr(col, 'hidden') === '1' || attr(col, 'hidden') === 'true'
      for (let c = min; c <= max; c++) {
        if (w !== undefined) sheet.colWidths.set(c, colPts(w))
        if (hidden) sheet.hiddenCols.add(c)
      }
    }

    // cells
    let count = 0
    let stopped = false
    let lastRow = 0
    for (const row of childrenNamed(child(wsRoot, 'sheetData'), 'row')) {
      const r = (numAttr(row, 'r') ?? lastRow + 1) - 1
      lastRow = r + 1
      const ht = numAttr(row, 'ht')
      if (ht !== undefined && (attr(row, 'customHeight') === '1' || attr(row, 'customHeight') === 'true' || ht > 0)) sheet.rowHeights.set(r, ht)
      if (attr(row, 'hidden') === '1' || attr(row, 'hidden') === 'true') sheet.hiddenRows.add(r)
      let cIdx = 0
      for (const c of row.children) {
        if (c.name !== 'c') continue
        const ref = attr(c, 'r')
        const pos = ref ? parseCellRef(ref) : null
        const col = pos ? pos.c : cIdx
        cIdx = col + 1
        const cell = buildCell(c, styles, sst, date1904, warnOnce.noValue)
        if (!cell) continue
        if (++count > MAX_CELLS) {
          stopped = true
          break
        }
        setCell(sheet, r, col, cell)
        if (cell.kind !== 'empty') {
          const hl = null
          void hl
        }
      }
      if (stopped) break
      if (r % 4000 === 3999) throwIfCancelled(env)
    }
    if (stopped) env.warnings.add(`Sheet “${sref.name}” has more than ${MAX_CELLS.toLocaleString('en-US')} cells; only the first ${lastRow.toLocaleString('en-US')} rows were rendered.`)

    for (const mc of childrenNamed(child(wsRoot, 'mergeCells'), 'mergeCell')) {
      const rg = parseRange(attr(mc, 'ref') ?? '')
      if (rg && (rg.r1 !== rg.r2 || rg.c1 !== rg.c2)) sheet.merges.push(rg)
    }

    // hyperlinks (external)
    for (const hl of childrenNamed(child(wsRoot, 'hyperlinks'), 'hyperlink')) {
      const rel = srels.get(attr(hl, 'id') ?? '')
      const rg = parseRange(attr(hl, 'ref') ?? '')
      if (!rel || !rel.external || !rg) continue
      for (let r = rg.r1; r <= Math.min(rg.r2, rg.r1 + 500); r++) {
        for (let c = rg.c1; c <= Math.min(rg.c2, rg.c1 + 50); c++) {
          const cell = sheet.cells.get(r)?.get(c)
          if (cell) cell.link = rel.target
        }
      }
    }

    // page setup
    const p = sheet.print
    const ps = child(wsRoot, 'pageSetup')
    const ps2 = numAttr(ps, 'paperSize')
    if (ps2 && PAPER[ps2]) p.paper = { w: PAPER[ps2][0], h: PAPER[ps2][1] }
    else if (ps2) env.warnings.add(`Paper size code ${ps2} is not known; the default paper size was used.`)
    if (attr(ps, 'orientation') === 'landscape') p.paper = { w: Math.max(p.paper.w, p.paper.h), h: Math.min(p.paper.w, p.paper.h) }
    else if (attr(ps, 'orientation') === 'portrait') p.paper = { w: Math.min(p.paper.w, p.paper.h), h: Math.max(p.paper.w, p.paper.h) }
    const scalePct = numAttr(ps, 'scale')
    if (scalePct) p.scale = scalePct / 100
    const fitToPage = attr(child(child(wsRoot, 'sheetPr'), 'pageSetUpPr'), 'fitToPage')
    if (fitToPage === '1' || fitToPage === 'true') p.fit = { w: numAttr(ps, 'fitToWidth') ?? 1, h: numAttr(ps, 'fitToHeight') ?? 1 }
    if (attr(ps, 'pageOrder') === 'overThenDown') p.pageOrder = 'over'
    if (attr(ps, 'useFirstPageNumber') === '1' || attr(ps, 'useFirstPageNumber') === 'true') p.firstPageNumber = numAttr(ps, 'firstPageNumber') ?? 1
    const pm = child(wsRoot, 'pageMargins')
    if (pm) {
      p.margins = {
        left: (numAttr(pm, 'left') ?? 0.7) * 72,
        right: (numAttr(pm, 'right') ?? 0.7) * 72,
        top: (numAttr(pm, 'top') ?? 0.75) * 72,
        bottom: (numAttr(pm, 'bottom') ?? 0.75) * 72,
        header: (numAttr(pm, 'header') ?? 0.3) * 72,
        footer: (numAttr(pm, 'footer') ?? 0.3) * 72
      }
    }
    const po = child(wsRoot, 'printOptions')
    const on = (v: string | undefined): boolean => v === '1' || v === 'true'
    p.gridLines = on(attr(po, 'gridLines'))
    p.hCenter = on(attr(po, 'horizontalCentered'))
    p.vCenter = on(attr(po, 'verticalCentered'))
    p.rowBreaks = childrenNamed(child(wsRoot, 'rowBreaks'), 'brk').map((b) => (numAttr(b, 'id') ?? 1) - 1)
    p.colBreaks = childrenNamed(child(wsRoot, 'colBreaks'), 'brk').map((b) => (numAttr(b, 'id') ?? 1) - 1)
    const a = areas.get(si)
    if (a?.length) p.areas = a
    const t = titles.get(si)
    if (t?.rows) p.titleRows = t.rows
    if (t?.cols) p.titleCols = t.cols
    const hf = child(wsRoot, 'headerFooter')
    if (hf) {
      const mk = (which: 'Header' | 'Footer'): HeaderFooter | undefined => {
        const odd = parseHeaderFooter(txt(child(hf, `odd${which}`)))
        const even = parseHeaderFooter(txt(child(hf, `even${which}`)))
        const first = parseHeaderFooter(txt(child(hf, `first${which}`)))
        if (!odd && !even && !first) return undefined
        return { odd, even, first, differentOddEven: on(attr(hf, 'differentOddEven')), differentFirst: on(attr(hf, 'differentFirst')) }
      }
      p.header = mk('Header')
      p.footer = mk('Footer')
    }

    applyConditionalFormatting(sheet, wsRoot, styles, env)
    if (child(wsRoot, 'tableParts') && !warnedTable) {
      warnedTable = true
      env.warnings.add('Excel table styles (banded rows, header formatting from the table style) are not applied; explicit cell formatting is.')
    }
    if ([...srels.values()].some((r) => r.type === 'comments')) env.warnings.add('Cell comments are not printed.')

    // drawings
    const drawingId = attr(child(wsRoot, 'drawing'), 'id')
    const drel = drawingId ? srels.get(drawingId) : undefined
    if (drel) readDrawing(pkg, drel.target, sheet.images, env)

    pages.push(...layoutSheet(sheet, env))
    env.progress((si + 1) / sheetRefs.length)
  }
  if (pages.length === 0) env.warnings.add('The workbook has no printable content.')
  return pages
}

function buildCell(c: XNode, styles: Styles, sst: SstEntry[], date1904: boolean, noValue: () => void): SheetCell | null {
  const s = numAttr(c, 's') ?? 0
  const xf = styles.xfs[s] ?? styles.xfs[0]
  const t = attr(c, 't') ?? 'n'
  const vNode = child(c, 'v')
  const v = vNode ? textContent(vNode) : undefined
  const hasFormula = !!child(c, 'f')
  const base = xf.style
  const mk = (text: string, kind: SheetCell['kind'], extra: Partial<SheetCell> = {}): SheetCell => ({ text, kind, style: base, ...extra })
  const fromText = (text: string, runs?: SstEntry['runs']): SheetCell => {
    const code = xf.numFmt
    const ft = code && code !== 'General' ? formatText(text, code) : { text }
    const cell = mk(ft.text, text === '' ? 'empty' : 'text', { color: ft.color, fill: ft.fill })
    if (runs && ft.text === text) cell.runs = runs.map((r): RichRun => ({ text: r.text, font: runFont(base.font, r.rPr, styles.colors) }))
    return cell
  }
  switch (t) {
    case 's': {
      const e = sst[parseInt(v ?? '-1', 10)]
      if (!e) return mk('', 'empty')
      return fromText(e.text, e.runs)
    }
    case 'str':
      return fromText(v ?? '')
    case 'inlineStr': {
      const is = child(c, 'is')
      const e = is ? siEntry(is) : { text: '' }
      return fromText(e.text, e.runs)
    }
    case 'b':
      return mk(v === '1' || v === 'true' ? 'TRUE' : 'FALSE', 'bool')
    case 'e':
      return mk(v ?? '#VALUE!', 'error')
    case 'd': {
      const serial = v ? excelSerialFromIso(v) : undefined
      return serial === undefined ? mk(v ?? '', 'text') : numberCell(serial, xf, base, date1904)
    }
    default: {
      if (v === undefined || v === '') {
        if (hasFormula) noValue()
        return mk('', 'empty')
      }
      const n = Number(v)
      if (!Number.isFinite(n)) return mk(v, 'text')
      return numberCell(n, xf, base, date1904)
    }
  }
}

function numberCell(n: number, xf: Xf, style: CellStyle, date1904: boolean): SheetCell {
  const r = formatNumber(n, xf.numFmt, { date1904 })
  return { text: r.text, kind: 'number', style, color: r.color, fill: r.fill, value: n }
}

// ---------------------------------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------------------------------

const EMU = 12700

function anchorPoint(n: XNode | undefined): { col: number; row: number; dx: number; dy: number } | undefined {
  if (!n) return undefined
  const num = (name: string): number => Number(txt(child(n, name))) || 0
  return { col: num('col'), row: num('row'), dx: num('colOff') / EMU, dy: num('rowOff') / EMU }
}

function readDrawing(pkg: Pkg, part: string, out: SheetImage[], env: ConvertEnv): void {
  const root = pkg.xml(part)?.children.find((c) => c.name === 'wsDr')
  if (!root) return
  const rels = relationshipsOf(pkg, part)
  for (const a of root.children) {
    if (a.name !== 'twoCellAnchor' && a.name !== 'oneCellAnchor' && a.name !== 'absoluteAnchor') continue
    const from = a.name === 'absoluteAnchor' ? { col: 0, row: 0, dx: (numAttr(child(a, 'pos'), 'x') ?? 0) / EMU, dy: (numAttr(child(a, 'pos'), 'y') ?? 0) / EMU } : anchorPoint(child(a, 'from'))
    if (!from) continue
    const img: SheetImage = { from }
    if (a.name === 'twoCellAnchor') img.to = anchorPoint(child(a, 'to'))
    else {
      const ext = child(a, 'ext')
      img.w = (numAttr(ext, 'cx') ?? 0) / EMU
      img.h = (numAttr(ext, 'cy') ?? 0) / EMU
    }
    const pic = child(a, 'pic')
    const gf = child(a, 'graphicFrame')
    if (pic) {
      const blip = descendants(pic, 'blip')[0]
      const rel = rels.get(attr(blip, 'embed') ?? '')
      const data = rel ? pkg.bytes(rel.target) : undefined
      const fmt = data ? imageFormat(data) : 'unknown'
      if (data && (fmt === 'png' || fmt === 'jpeg')) img.image = { bytes: data, format: fmt }
      else {
        img.label = `Picture (${fmt === 'unknown' ? 'unsupported format' : fmt.toUpperCase()})`
        env.warnings.add(`A ${fmt === 'unknown' ? '' : fmt.toUpperCase() + ' '}picture format is not supported by the built-in engine; a placeholder box is drawn instead.`)
      }
    } else if (gf) {
      const chartRel = rels.get(attr(descendants(gf, 'chart')[0], 'id') ?? '')
      const chartRoot = chartRel ? pkg.xml(chartRel.target) : undefined
      const title = chartRoot ? descendants(chartRoot, 'title')[0] : undefined
      const label = title ? descendants(title, 't').map((t) => textContent(t)).join('') : ''
      img.label = label ? `Chart: ${label}` : 'Chart'
      env.warnings.add('Charts are not rendered by the built-in engine; a placeholder box marks their position.')
    } else {
      const text = descendants(a, 't').map((t) => textContent(t)).join(' ').trim()
      img.label = text || 'Shape'
      env.warnings.add('Drawing shapes and text boxes are not rendered by the built-in engine; a placeholder box marks their position.')
    }
    out.push(img)
  }
}

