import type { BorderSpec, TabStop, TextStyle } from './flow'
import { DEFAULT_TEXT_STYLE, splitByScript } from './flow'
import type { Pkg } from './package'
import { attr, child, childrenNamed, numAttr, path, type XNode } from './xml'

/** Style parsing and cascade resolution for WordprocessingML (styles.xml, theme, direct formatting). */

export interface RPr {
  font?: string
  size?: number
  bold?: boolean
  italic?: boolean
  /** Complex-script properties (Arabic, Hebrew...): w:rFonts w:cs / w:cstheme, w:szCs, w:bCs, w:iCs. */
  csFont?: string
  sizeCs?: number
  boldCs?: boolean
  italicCs?: boolean
  /** w:rtl: right-to-left run (all its characters use the complex-script properties). w:cs: complex-script run. */
  rtl?: boolean
  cs?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  highlight?: string
  vertAlign?: 'super' | 'sub' | 'baseline'
  caps?: boolean
  smallCaps?: boolean
  spacing?: number
  hidden?: boolean
  rStyle?: string
  shading?: string
}

export interface PBorders {
  top?: BorderSpec | null
  bottom?: BorderSpec | null
  left?: BorderSpec | null
  right?: BorderSpec | null
}

export interface PPr {
  align?: 'left' | 'center' | 'right' | 'justify'
  spaceBefore?: number
  spaceAfter?: number
  line?: { rule: 'auto' | 'exact' | 'atLeast'; value: number }
  indLeft?: number
  indRight?: number
  firstLine?: number
  hanging?: number
  tabs?: { pos: number; kind: TabStop['align'] | 'clear'; leader?: TabStop['leader'] }[]
  keepNext?: boolean
  keepLines?: boolean
  pageBreakBefore?: boolean
  widowControl?: boolean
  shading?: string
  borders?: PBorders
  numId?: number
  ilvl?: number
  outlineLvl?: number
  pStyle?: string
  rtl?: boolean
  contextualSpacing?: boolean
}

export interface TblPrStyle {
  borders?: { top?: BorderSpec | null; bottom?: BorderSpec | null; left?: BorderSpec | null; right?: BorderSpec | null; insideH?: BorderSpec | null; insideV?: BorderSpec | null }
  cellMar?: { top?: number; right?: number; bottom?: number; left?: number }
  indent?: number
  align?: 'left' | 'center' | 'right'
  /** w:bidiVisual: right-to-left table (first column on the right). */
  rtl?: boolean
}

export interface TcPr {
  shading?: string
  borders?: { top?: BorderSpec | null; bottom?: BorderSpec | null; left?: BorderSpec | null; right?: BorderSpec | null }
  margins?: { top?: number; right?: number; bottom?: number; left?: number }
  vAlign?: 'top' | 'center' | 'bottom'
}

export interface StyleDef {
  id: string
  type: 'paragraph' | 'character' | 'table' | 'numbering'
  name: string
  basedOn?: string
  isDefault: boolean
  ppr: PPr
  rpr: RPr
  tblPr?: TblPrStyle
  tcPr?: TcPr
  /** Conditional table formatting keyed by `w:type` (firstRow, band1Horz, ...). */
  cond: Map<string, { ppr: PPr; rpr: RPr; tcPr: TcPr; tblPr: TblPrStyle }>
}

export const twips = (n: number | undefined): number => (n === undefined ? 0 : n / 20)

const HIGHLIGHT: Record<string, string> = {
  yellow: '#FFFF00',
  green: '#00FF00',
  cyan: '#00FFFF',
  magenta: '#FF00FF',
  blue: '#0000FF',
  red: '#FF0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#C0C0C0',
  black: '#000000',
  white: '#FFFFFF'
}

// ---------------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------------

export interface Theme {
  colors: Record<string, string>
  major?: string
  minor?: string
  /** Complex-script theme fonts (majorBidi/minorBidi): `a:cs`, else the `a:font script="Arab"` entry. */
  majorCs?: string
  minorCs?: string
}

export function readTheme(pkg: Pkg, part: string | undefined): Theme {
  const theme: Theme = { colors: {} }
  const root = part ? pkg.xml(part) : pkg.xml('word/theme/theme1.xml')
  const els = path(root?.children.find((c) => c.name === 'theme'), 'themeElements')
  const scheme = child(els, 'clrScheme')
  for (const c of scheme?.children ?? []) {
    const v = c.children[0]
    if (!v) continue
    const hex = v.name === 'sysClr' ? attr(v, 'lastClr') : attr(v, 'val')
    if (hex) theme.colors[c.name] = `#${hex.toUpperCase()}`
  }
  // Map the aliases Word uses in themeColor attributes.
  const c = theme.colors
  c['text1'] = c['dk1']
  c['text2'] = c['dk2']
  c['background1'] = c['lt1']
  c['background2'] = c['lt2']
  c['dark1'] = c['dk1']
  c['dark2'] = c['dk2']
  c['light1'] = c['lt1']
  c['light2'] = c['lt2']
  const fonts = child(els, 'fontScheme')
  theme.major = attr(path(fonts, 'majorFont', 'latin'), 'typeface')
  theme.minor = attr(path(fonts, 'minorFont', 'latin'), 'typeface')
  const csOf = (kind: string): string | undefined => {
    const f = child(fonts, kind)
    const cs = attr(child(f, 'cs'), 'typeface')
    if (cs) return cs
    return f?.children.find((c) => c.name === 'font' && attr(c, 'script') === 'Arab')?.attrs['typeface'] || undefined
  }
  theme.majorCs = csOf('majorFont')
  theme.minorCs = csOf('minorFont')
  return theme
}

function applyTintShade(hex: string, tint?: number, shade?: number): string {
  let r = parseInt(hex.slice(1, 3), 16)
  let g = parseInt(hex.slice(3, 5), 16)
  let b = parseInt(hex.slice(5, 7), 16)
  if (shade !== undefined) {
    const k = shade / 255
    r *= k
    g *= k
    b *= k
  }
  if (tint !== undefined) {
    const k = tint / 255
    r = 255 - (255 - r) * k
    g = 255 - (255 - g) * k
    b = 255 - (255 - b) * k
  }
  const h = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase()
}

/** A colour attribute pair (`w:color`, `w:fill`) with optional theme reference, as #RRGGBB or undefined for auto. */
export function colorOf(n: XNode | undefined, theme: Theme, valAttr = 'val'): string | undefined {
  if (!n) return undefined
  const themeColor = attr(n, 'themeColor') ?? (valAttr === 'fill' ? attr(n, 'themeFill') : undefined)
  const val = attr(n, valAttr)
  if (themeColor && theme.colors[themeColor]) {
    const tint = attr(n, valAttr === 'fill' ? 'themeFillTint' : 'themeTint')
    const shade = attr(n, valAttr === 'fill' ? 'themeFillShade' : 'themeShade')
    return applyTintShade(theme.colors[themeColor], tint ? parseInt(tint, 16) : undefined, shade ? parseInt(shade, 16) : undefined)
  }
  if (!val || val === 'auto') return undefined
  return /^[0-9a-fA-F]{6}$/.test(val) ? `#${val.toUpperCase()}` : undefined
}

// ---------------------------------------------------------------------------------------------------
// Property parsers
// ---------------------------------------------------------------------------------------------------

const on = (n: XNode | undefined): boolean | undefined => {
  if (!n) return undefined
  const v = attr(n, 'val')
  if (v === undefined) return true
  return !(v === '0' || v === 'false' || v === 'off' || v === 'none')
}

export function parseRPr(n: XNode | undefined, theme: Theme): RPr {
  const r: RPr = {}
  if (!n) return r
  for (const c of n.children) {
    switch (c.name) {
      case 'rFonts': {
        const themeFont = attr(c, 'asciiTheme') ?? attr(c, 'hAnsiTheme')
        const f = attr(c, 'ascii') ?? attr(c, 'hAnsi') ?? attr(c, 'eastAsia')
        if (themeFont) r.font = /major/i.test(themeFont) ? theme.major : theme.minor
        else if (f) r.font = f
        if (!r.font && f) r.font = f
        const csTheme = attr(c, 'cstheme')
        const cs = attr(c, 'cs')
        if (csTheme) r.csFont = (/major/i.test(csTheme) ? theme.majorCs : theme.minorCs) ?? cs
        else if (cs) r.csFont = cs
        break
      }
      case 'sz':
        if (numAttr(c, 'val') !== undefined) r.size = numAttr(c, 'val')! / 2
        break
      case 'szCs':
        if (numAttr(c, 'val') !== undefined) r.sizeCs = numAttr(c, 'val')! / 2
        break
      case 'b':
        r.bold = on(c)
        break
      case 'bCs':
        r.boldCs = on(c)
        break
      case 'i':
        r.italic = on(c)
        break
      case 'iCs':
        r.italicCs = on(c)
        break
      case 'rtl':
        r.rtl = on(c)
        break
      case 'cs':
        r.cs = on(c)
        break
      case 'u': {
        const v = attr(c, 'val')
        r.underline = v !== undefined && v !== 'none'
        break
      }
      case 'strike':
      case 'dstrike':
        r.strike = on(c)
        break
      case 'color':
        r.color = colorOf(c, theme) ?? 'auto'
        break
      case 'highlight': {
        const v = attr(c, 'val')
        if (v && HIGHLIGHT[v]) r.highlight = HIGHLIGHT[v]
        break
      }
      case 'shd': {
        const f = colorOf(c, theme, 'fill')
        if (f && attr(c, 'val') !== 'nil') r.shading = f
        break
      }
      case 'vertAlign': {
        const v = attr(c, 'val')
        r.vertAlign = v === 'superscript' ? 'super' : v === 'subscript' ? 'sub' : 'baseline'
        break
      }
      case 'caps':
        r.caps = on(c)
        break
      case 'smallCaps':
        r.smallCaps = on(c)
        break
      case 'spacing':
        if (numAttr(c, 'val') !== undefined) r.spacing = numAttr(c, 'val')! / 20
        break
      case 'vanish':
        r.hidden = on(c)
        break
      case 'rStyle':
        r.rStyle = attr(c, 'val')
        break
    }
  }
  return r
}

const BORDER_STYLE: Record<string, BorderSpec['style'] | null> = {
  nil: null,
  none: null,
  single: 'single',
  thick: 'single',
  double: 'double',
  dashed: 'dashed',
  dashSmallGap: 'dashed',
  dotted: 'dotted',
  dotDash: 'dashed',
  dotDotDash: 'dashed',
  triple: 'double',
  thinThickSmallGap: 'double',
  thickThinSmallGap: 'double',
  wave: 'single',
  inset: 'single',
  outset: 'single',
  threeDEmboss: 'single',
  threeDEngrave: 'single'
}

export function parseBorder(n: XNode | undefined, theme: Theme): BorderSpec | null | undefined {
  if (!n) return undefined
  const val = attr(n, 'val') ?? 'single'
  const style = BORDER_STYLE[val]
  if (style === null) return null
  const sz = numAttr(n, 'sz') ?? 4
  const thick = val === 'thick' ? 2 : 1
  return { color: colorOf(n, theme, 'color') ?? '#000000', width: Math.max(0.25, (sz / 8) * thick), style: style ?? 'single' }
}

function parseBordersOf(n: XNode | undefined, theme: Theme, names: string[]): Record<string, BorderSpec | null | undefined> {
  const out: Record<string, BorderSpec | null | undefined> = {}
  if (!n) return out
  for (const nm of names) {
    const c = child(n, nm) ?? (nm === 'left' ? child(n, 'start') : nm === 'right' ? child(n, 'end') : undefined)
    const b = parseBorder(c, theme)
    if (b !== undefined) out[nm] = b
  }
  return out
}

export function parsePPr(n: XNode | undefined, theme: Theme): PPr {
  const p: PPr = {}
  if (!n) return p
  for (const c of n.children) {
    switch (c.name) {
      case 'jc': {
        const v = attr(c, 'val')
        // Logical values: in a bidi paragraph Word reads left/start as the right edge (the layout mirrors them).
        p.align = v === 'center' ? 'center' : v === 'right' || v === 'end' ? 'right' : v === 'both' || v === 'distribute' || v === 'justify' || v === 'lowKashida' || v === 'mediumKashida' || v === 'highKashida' || v === 'thaiDistribute' ? 'justify' : 'left'
        break
      }
      case 'spacing': {
        if (numAttr(c, 'before') !== undefined) p.spaceBefore = twips(numAttr(c, 'before'))
        if (numAttr(c, 'after') !== undefined) p.spaceAfter = twips(numAttr(c, 'after'))
        if (attr(c, 'beforeAutospacing') === '1' || attr(c, 'beforeAutospacing') === 'true') p.spaceBefore = 14
        if (attr(c, 'afterAutospacing') === '1' || attr(c, 'afterAutospacing') === 'true') p.spaceAfter = 14
        const line = numAttr(c, 'line')
        if (line !== undefined) {
          const rule = attr(c, 'lineRule') ?? 'auto'
          p.line = rule === 'exact' ? { rule: 'exact', value: twips(line) } : rule === 'atLeast' ? { rule: 'atLeast', value: twips(line) } : { rule: 'auto', value: line / 240 }
        }
        break
      }
      case 'ind': {
        const left = numAttr(c, 'left') ?? numAttr(c, 'start')
        const right = numAttr(c, 'right') ?? numAttr(c, 'end')
        if (left !== undefined) p.indLeft = twips(left)
        if (right !== undefined) p.indRight = twips(right)
        if (numAttr(c, 'hanging') !== undefined) p.hanging = twips(numAttr(c, 'hanging'))
        if (numAttr(c, 'firstLine') !== undefined) p.firstLine = twips(numAttr(c, 'firstLine'))
        break
      }
      case 'tabs': {
        p.tabs = []
        for (const t of childrenNamed(c, 'tab')) {
          const val = attr(t, 'val') ?? 'left'
          const pos = numAttr(t, 'pos')
          if (pos === undefined) continue
          const leader = attr(t, 'leader')
          const kind: NonNullable<PPr['tabs']>[number]['kind'] = val === 'clear' ? 'clear' : val === 'center' ? 'center' : val === 'right' || val === 'end' ? 'right' : val === 'decimal' ? 'decimal' : 'left'
          p.tabs.push({ pos: twips(pos), kind, leader: leader === 'dot' ? 'dot' : leader === 'hyphen' ? 'hyphen' : leader === 'underscore' ? 'underscore' : leader === 'middleDot' ? 'middleDot' : undefined })
        }
        break
      }
      case 'keepNext':
        p.keepNext = on(c)
        break
      case 'keepLines':
        p.keepLines = on(c)
        break
      case 'pageBreakBefore':
        p.pageBreakBefore = on(c)
        break
      case 'widowControl':
        p.widowControl = on(c)
        break
      case 'shd': {
        const f = colorOf(c, theme, 'fill')
        if (f && attr(c, 'val') !== 'nil') p.shading = f
        break
      }
      case 'pBdr':
        p.borders = parseBordersOf(c, theme, ['top', 'bottom', 'left', 'right']) as PBorders
        break
      case 'numPr': {
        const id = numAttr(child(c, 'numId'), 'val')
        if (id !== undefined) p.numId = id
        const lvl = numAttr(child(c, 'ilvl'), 'val')
        if (lvl !== undefined) p.ilvl = lvl
        break
      }
      case 'outlineLvl':
        p.outlineLvl = numAttr(c, 'val')
        break
      case 'pStyle':
        p.pStyle = attr(c, 'val')
        break
      case 'bidi':
        p.rtl = on(c)
        break
      case 'contextualSpacing':
        p.contextualSpacing = on(c)
        break
    }
  }
  return p
}

export function parseTcPr(n: XNode | undefined, theme: Theme): TcPr {
  const t: TcPr = {}
  if (!n) return t
  const shd = child(n, 'shd')
  const fill = colorOf(shd, theme, 'fill')
  if (fill && attr(shd, 'val') !== 'nil') t.shading = fill
  const b = child(n, 'tcBorders')
  if (b) t.borders = parseBordersOf(b, theme, ['top', 'bottom', 'left', 'right'])
  const mar = child(n, 'tcMar')
  if (mar) t.margins = parseMar(mar)
  const va = attr(child(n, 'vAlign'), 'val')
  if (va) t.vAlign = va === 'center' ? 'center' : va === 'bottom' ? 'bottom' : 'top'
  return t
}

function parseMar(n: XNode): { top?: number; right?: number; bottom?: number; left?: number } {
  const g = (a: string, b?: string): number | undefined => {
    const c = child(n, a) ?? (b ? child(n, b) : undefined)
    const w = numAttr(c, 'w')
    return w === undefined ? undefined : twips(w)
  }
  return { top: g('top'), right: g('right', 'end'), bottom: g('bottom'), left: g('left', 'start') }
}

export function parseTblPr(n: XNode | undefined, theme: Theme): TblPrStyle {
  const t: TblPrStyle = {}
  if (!n) return t
  const b = child(n, 'tblBorders')
  if (b) t.borders = parseBordersOf(b, theme, ['top', 'bottom', 'left', 'right', 'insideH', 'insideV'])
  const mar = child(n, 'tblCellMar')
  if (mar) t.cellMar = parseMar(mar)
  const ind = numAttr(child(n, 'tblInd'), 'w')
  if (ind !== undefined) t.indent = twips(ind)
  const jc = attr(child(n, 'jc'), 'val')
  if (jc) t.align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left'
  const bv = child(n, 'bidiVisual')
  if (bv) t.rtl = on(bv)
  return t
}

// ---------------------------------------------------------------------------------------------------
// Styles part
// ---------------------------------------------------------------------------------------------------

export interface Styles {
  byId: Map<string, StyleDef>
  defaultPara?: string
  defaultChar?: string
  defaultTable?: string
  docRPr: RPr
  docPPr: PPr
  theme: Theme
}

export function readStyles(pkg: Pkg, theme: Theme): Styles {
  const st: Styles = { byId: new Map(), docRPr: {}, docPPr: {}, theme }
  const root = pkg.xml('word/styles.xml')?.children.find((c) => c.name === 'styles')
  if (!root) return st
  const dd = child(root, 'docDefaults')
  st.docRPr = parseRPr(path(dd, 'rPrDefault', 'rPr'), theme)
  st.docPPr = parsePPr(path(dd, 'pPrDefault', 'pPr'), theme)
  for (const s of childrenNamed(root, 'style')) {
    const id = attr(s, 'styleId')
    if (!id) continue
    const type = (attr(s, 'type') ?? 'paragraph') as StyleDef['type']
    const def: StyleDef = {
      id,
      type,
      name: attr(child(s, 'name'), 'val') ?? id,
      basedOn: attr(child(s, 'basedOn'), 'val'),
      isDefault: attr(s, 'default') === '1' || attr(s, 'default') === 'true',
      ppr: parsePPr(child(s, 'pPr'), theme),
      rpr: parseRPr(child(s, 'rPr'), theme),
      tblPr: type === 'table' ? parseTblPr(child(s, 'tblPr'), theme) : undefined,
      tcPr: type === 'table' ? parseTcPr(child(s, 'tcPr'), theme) : undefined,
      cond: new Map()
    }
    for (const sp of childrenNamed(s, 'tblStylePr')) {
      const t = attr(sp, 'type')
      if (t) def.cond.set(t, { ppr: parsePPr(child(sp, 'pPr'), theme), rpr: parseRPr(child(sp, 'rPr'), theme), tcPr: parseTcPr(child(sp, 'tcPr'), theme), tblPr: parseTblPr(child(sp, 'tblPr'), theme) })
    }
    st.byId.set(id, def)
    if (def.isDefault) {
      if (type === 'paragraph') st.defaultPara = id
      else if (type === 'character') st.defaultChar = id
      else if (type === 'table') st.defaultTable = id
    }
  }
  return st
}

/** Style chain from the root ancestor down to `id` (cycle-safe). */
export function chainOf(st: Styles, id: string | undefined): StyleDef[] {
  const out: StyleDef[] = []
  const seen = new Set<string>()
  let cur = id ? st.byId.get(id) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.unshift(cur)
    cur = cur.basedOn ? st.byId.get(cur.basedOn) : undefined
  }
  return out
}

const defined = <T extends object>(o: T): Partial<T> => {
  const out: Partial<T> = {}
  for (const k in o) if (o[k] !== undefined) out[k] = o[k]
  return out
}

/** Later layers override earlier ones (tabs accumulate; `clear` stops remove earlier ones). */
export function mergeRPr(...layers: (RPr | undefined)[]): RPr {
  const out: RPr = {}
  for (const l of layers) if (l) Object.assign(out, defined(l))
  return out
}

export function mergePPr(...layers: (PPr | undefined)[]): PPr {
  const out: PPr = {}
  for (const l of layers) {
    if (!l) continue
    const { tabs, borders, ...rest } = l
    Object.assign(out, defined(rest))
    if (tabs) {
      const cur = [...(out.tabs ?? [])]
      for (const t of tabs) {
        const i = cur.findIndex((x) => Math.abs(x.pos - t.pos) < 0.5)
        if (t.kind === 'clear') {
          if (i >= 0) cur.splice(i, 1)
        } else if (i >= 0) cur[i] = t
        else cur.push(t)
      }
      out.tabs = cur
    }
    if (borders) out.borders = { ...(out.borders ?? {}), ...defined(borders) }
  }
  return out
}

/** Base complex-script properties of a document (docDefaults, else the theme's minorBidi font, else Times New Roman). */
export interface ComplexBase {
  family: string
  size: number
  bold: boolean
  italic: boolean
}

/** The style for the complex-script characters (Arabic, Hebrew, Thai...) of a run: cs font, szCs, bCs, iCs. */
export function toComplexStyle(r: RPr, base: TextStyle, cs: ComplexBase): TextStyle {
  return { ...toTextStyle(r, base), family: r.csFont ?? cs.family, size: r.sizeCs ?? cs.size, bold: r.boldCs ?? cs.bold, italic: r.italicCs ?? cs.italic }
}

/**
 * Splits run text between the Latin and the complex-script style, as Word does: a run marked w:rtl or w:cs is
 * entirely complex script; otherwise Arabic/Hebrew/Thai letters use the complex properties and neutral characters
 * (spaces, digits, punctuation) go with the letters before them (see flow.splitByScript).
 */
export function splitComplex(text: string, r: RPr, latin: TextStyle, complex: TextStyle): { text: string; style: TextStyle }[] {
  if (r.rtl || r.cs) return [{ text, style: complex }]
  return splitByScript(text, latin, complex)
}

/** Applies resolved character properties on top of the document's base text style. */
export function toTextStyle(r: RPr, base: TextStyle = DEFAULT_TEXT_STYLE): TextStyle {
  return {
    family: r.font ?? base.family,
    size: r.size ?? base.size,
    bold: r.bold ?? base.bold,
    italic: r.italic ?? base.italic,
    underline: r.underline ?? base.underline,
    strike: r.strike ?? base.strike,
    color: r.color && r.color !== 'auto' ? r.color : base.color,
    highlight: r.highlight ?? r.shading ?? base.highlight,
    vertAlign: r.vertAlign === 'baseline' ? undefined : (r.vertAlign ?? base.vertAlign),
    caps: r.caps ?? base.caps,
    smallCaps: r.smallCaps ?? base.smallCaps,
    spacing: r.spacing ?? base.spacing
  }
}
