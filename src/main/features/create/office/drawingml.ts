import { attr, child, numAttr, type XNode } from './xml'

/**
 * DrawingML helpers shared by the PPTX converter: theme colours and fonts, colour transforms, and the
 * layered paragraph/run property model (presentation defaults -> master -> layout -> shape -> paragraph -> run).
 */

export const EMU_PER_PT = 12700
export const emu = (v: number | undefined): number => (v ?? 0) / EMU_PER_PT

export interface Rgba {
  hex: string // '#rrggbb'
  alpha: number // 0..1
}

export interface ThemeInfo {
  colors: Record<string, string>
  major: string
  minor: string
  /** Complex-script (Arabic...) theme fonts, if the theme names them. */
  majorCs?: string
  minorCs?: string
  fillStyles: XNode[]
  lnStyles: XNode[]
  effectStyles: XNode[]
  bgFillStyles: XNode[]
}

export type ClrMap = Record<string, string>

export const DEFAULT_CLR_MAP: ClrMap = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink' }

const PRESET_COLORS: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', cyan: '00ffff', magenta: 'ff00ff',
  gray: '808080', grey: '808080', darkGray: 'a9a9a9', lightGray: 'd3d3d3', orange: 'ffa500', purple: '800080', brown: 'a52a2a', pink: 'ffc0cb',
  darkBlue: '00008b', darkGreen: '006400', darkRed: '8b0000', navy: '000080', teal: '008080', silver: 'c0c0c0', maroon: '800000', lime: '00ff00',
  aqua: '00ffff', fuchsia: 'ff00ff', olive: '808000', dkGray: 'a9a9a9', ltGray: 'd3d3d3', dkBlue: '00008b', dkGreen: '006400', dkRed: '8b0000'
}

const COLOR_ELEMENTS = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr'])

export function parseTheme(root: XNode | undefined): ThemeInfo {
  const t: ThemeInfo = {
    colors: { dk1: '000000', lt1: 'ffffff', dk2: '44546a', lt2: 'e7e6e6', accent1: '4472c4', accent2: 'ed7d31', accent3: 'a5a5a5', accent4: 'ffc000', accent5: '5b9bd5', accent6: '70ad47', hlink: '0563c1', folHlink: '954f72' },
    major: 'Calibri Light',
    minor: 'Calibri',
    fillStyles: [],
    lnStyles: [],
    effectStyles: [],
    bgFillStyles: []
  }
  const theme = root?.children.find((c) => c.name === 'theme')
  const elements = child(theme, 'themeElements')
  const scheme = child(elements, 'clrScheme')
  for (const c of scheme?.children ?? []) {
    const el = c.children[0]
    if (!el) continue
    const v = el.name === 'sysClr' ? (attr(el, 'lastClr') ?? attr(el, 'val') ?? '000000') : (attr(el, 'val') ?? '000000')
    if (el.name === 'sysClr' && !attr(el, 'lastClr')) t.colors[c.name] = attr(el, 'val') === 'window' ? 'ffffff' : '000000'
    else t.colors[c.name] = v.replace('#', '')
  }
  const fonts = child(elements, 'fontScheme')
  t.major = attr(child(child(fonts, 'majorFont'), 'latin'), 'typeface') || t.major
  t.minor = attr(child(child(fonts, 'minorFont'), 'latin'), 'typeface') || t.minor
  // complex-script theme fonts: a:cs, else the script="Arab" entry
  const csOf = (f: XNode | undefined): string | undefined => attr(child(f, 'cs'), 'typeface') || f?.children.find((c) => c.name === 'font' && attr(c, 'script') === 'Arab')?.attrs['typeface'] || undefined
  t.majorCs = csOf(child(fonts, 'majorFont'))
  t.minorCs = csOf(child(fonts, 'minorFont'))
  const fmt = child(elements, 'fmtScheme')
  t.fillStyles = child(fmt, 'fillStyleLst')?.children ?? []
  t.lnStyles = child(fmt, 'lnStyleLst')?.children ?? []
  t.effectStyles = child(fmt, 'effectStyleLst')?.children ?? []
  t.bgFillStyles = child(fmt, 'bgFillStyleLst')?.children ?? []
  return t
}

// ---------------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------------

const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v))

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').padEnd(6, '0')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const toHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.round(clamp(v / 255) * 255).toString(16).padStart(2, '0')).join('')

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/** Resolves a colour element (srgbClr, schemeClr, ...) including its transform children. */
export function resolveColor(el: XNode, theme: ThemeInfo, clrMap: ClrMap, phClr?: Rgba): Rgba | null {
  let hex: string
  switch (el.name) {
    case 'srgbClr':
      hex = '#' + (attr(el, 'val') ?? '000000')
      break
    case 'prstClr':
      hex = '#' + (PRESET_COLORS[attr(el, 'val') ?? ''] ?? '000000')
      break
    case 'sysClr':
      hex = '#' + (attr(el, 'lastClr') ?? (attr(el, 'val') === 'window' ? 'ffffff' : '000000'))
      break
    case 'scrgbClr': {
      const c = (n: string): number => Math.round(clamp((numAttr(el, n) ?? 0) / 100000) * 255)
      hex = toHex(c('r'), c('g'), c('b'))
      break
    }
    case 'hslClr': {
      const [r, g, b] = hslToRgb(((numAttr(el, 'hue') ?? 0) / 60000 / 360) % 1, (numAttr(el, 'sat') ?? 0) / 100000, (numAttr(el, 'lum') ?? 0) / 100000)
      hex = toHex(r, g, b)
      break
    }
    case 'schemeClr': {
      const v = attr(el, 'val') ?? 'tx1'
      if (v === 'phClr') {
        if (!phClr) return null
        hex = phClr.hex
        break
      }
      const mapped = clrMap[v] ?? v
      hex = '#' + (theme.colors[mapped] ?? theme.colors[v] ?? '000000')
      break
    }
    default:
      return null
  }
  let alpha = phClr && el.name === 'schemeClr' && attr(el, 'val') === 'phClr' ? phClr.alpha : 1
  let [r, g, b] = hexToRgb(hex)
  for (const m of el.children) {
    const val = (numAttr(m, 'val') ?? 0) / 100000
    switch (m.name) {
      case 'alpha':
        alpha = val
        break
      case 'alphaMod':
        alpha *= val
        break
      case 'lumMod':
      case 'lumOff':
      case 'satMod':
      case 'sat':
      case 'lum': {
        const [h, s, l] = rgbToHsl(r, g, b)
        const out: [number, number, number] =
          m.name === 'lumMod' ? [h, s, clamp(l * val)] : m.name === 'lumOff' ? [h, s, clamp(l + val)] : m.name === 'satMod' ? [h, clamp(s * val), l] : m.name === 'sat' ? [h, clamp(val), l] : [h, s, clamp(val)]
        ;[r, g, b] = hslToRgb(...out)
        break
      }
      case 'tint':
        r = r + (255 - r) * (1 - val)
        g = g + (255 - g) * (1 - val)
        b = b + (255 - b) * (1 - val)
        break
      case 'shade':
        r *= val
        g *= val
        b *= val
        break
      case 'comp':
        ;[r, g, b] = [255 - r, 255 - g, 255 - b]
        break
      case 'inv':
        ;[r, g, b] = [255 - r, 255 - g, 255 - b]
        break
      case 'gray': {
        const y = 0.3 * r + 0.59 * g + 0.11 * b
        ;[r, g, b] = [y, y, y]
        break
      }
      default:
        break
    }
  }
  return { hex: toHex(r, g, b), alpha: clamp(alpha) }
}

/** The colour of the first colour element found among `container`'s children. */
export function findColor(container: XNode | undefined, theme: ThemeInfo, clrMap: ClrMap, phClr?: Rgba): Rgba | null {
  if (!container) return null
  for (const c of container.children) if (COLOR_ELEMENTS.has(c.name)) return resolveColor(c, theme, clrMap, phClr)
  return null
}

export function averageColors(cols: Rgba[]): Rgba {
  if (cols.length === 0) return { hex: '#808080', alpha: 1 }
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  for (const c of cols) {
    const [cr, cg, cb] = hexToRgb(c.hex)
    r += cr
    g += cg
    b += cb
    a += c.alpha
  }
  const n = cols.length
  return { hex: toHex(r / n, g / n, b / n), alpha: a / n }
}

// ---------------------------------------------------------------------------------------------------
// Fills and lines
// ---------------------------------------------------------------------------------------------------

export type FillSpec =
  | { kind: 'none' }
  | { kind: 'solid'; color: Rgba }
  | { kind: 'grad'; color: Rgba }
  | { kind: 'blip'; rid: string; crop?: { l: number; t: number; r: number; b: number } }

export interface LineSpec {
  none: boolean
  width?: number // pt
  color?: Rgba
  dash?: string
  head?: string
  tail?: string
  headSize?: string
  tailSize?: string
}

export interface ColorCtx {
  theme: ThemeInfo
  clrMap: ClrMap
}

/** Reads a fill from a shape-properties-like node. Returns undefined when the node states no fill at all. */
export function readFill(node: XNode | undefined, cc: ColorCtx, phClr?: Rgba): FillSpec | undefined {
  if (!node) return undefined
  for (const c of node.children) {
    switch (c.name) {
      case 'noFill':
        return { kind: 'none' }
      case 'solidFill': {
        const col = findColor(c, cc.theme, cc.clrMap, phClr)
        return col ? { kind: 'solid', color: col } : { kind: 'none' }
      }
      case 'gradFill': {
        const stops = child(c, 'gsLst')?.children.filter((g) => g.name === 'gs') ?? []
        const cols = stops.map((g) => findColor(g, cc.theme, cc.clrMap, phClr)).filter((x): x is Rgba => !!x)
        return { kind: 'grad', color: averageColors(cols) }
      }
      case 'pattFill': {
        const col = findColor(child(c, 'fgClr'), cc.theme, cc.clrMap, phClr)
        return col ? { kind: 'solid', color: col } : { kind: 'none' }
      }
      case 'blipFill': {
        const blip = child(c, 'blip')
        const rid = attr(blip, 'embed')
        const sr = child(c, 'srcRect')
        const crop = sr ? { l: (numAttr(sr, 'l') ?? 0) / 100000, t: (numAttr(sr, 't') ?? 0) / 100000, r: (numAttr(sr, 'r') ?? 0) / 100000, b: (numAttr(sr, 'b') ?? 0) / 100000 } : undefined
        return rid ? { kind: 'blip', rid, crop } : { kind: 'none' }
      }
      default:
        break
    }
  }
  return undefined
}

export function readLine(ln: XNode | undefined, cc: ColorCtx, phClr?: Rgba): LineSpec | undefined {
  if (!ln) return undefined
  const spec: LineSpec = { none: false }
  const w = numAttr(ln, 'w')
  if (w !== undefined) spec.width = w / EMU_PER_PT
  for (const c of ln.children) {
    if (c.name === 'noFill') spec.none = true
    else if (c.name === 'solidFill' || c.name === 'gradFill' || c.name === 'pattFill') {
      const f = readFill(ln, cc, phClr)
      if (f && (f.kind === 'solid' || f.kind === 'grad')) spec.color = f.color
    } else if (c.name === 'prstDash') spec.dash = attr(c, 'val')
    else if (c.name === 'headEnd') {
      spec.head = attr(c, 'type')
      spec.headSize = attr(c, 'w')
    } else if (c.name === 'tailEnd') {
      spec.tail = attr(c, 'type')
      spec.tailSize = attr(c, 'w')
    }
  }
  return spec
}

export function dashArray(dash: string | undefined, width: number): number[] | undefined {
  const w = Math.max(width, 0.75)
  switch (dash) {
    case 'dash':
    case 'sysDash':
      return [w * 4, w * 3]
    case 'dot':
    case 'sysDot':
      return [w, w * 2]
    case 'dashDot':
    case 'sysDashDot':
      return [w * 4, w * 2, w, w * 2]
    case 'lgDash':
      return [w * 8, w * 3]
    case 'lgDashDot':
      return [w * 8, w * 3, w, w * 3]
    case 'sysDashDotDot':
    case 'lgDashDotDot':
      return [w * 4, w * 2, w, w * 2, w, w * 2]
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------------------------------
// Text properties (layered)
// ---------------------------------------------------------------------------------------------------

export interface RPr {
  sz?: number // points
  b?: boolean
  i?: boolean
  u?: boolean
  strike?: boolean
  baseline?: number // percent
  caps?: boolean
  color?: Rgba
  family?: string
  /** a:cs: the font of complex-script (Arabic, Hebrew...) characters. */
  csFamily?: string
  spc?: number // points
  link?: string // relationship id of hyperlink
  highlight?: Rgba
}

export interface PPr {
  algn?: string
  marL?: number
  indent?: number
  lvl?: number
  spcBef?: { pts?: number; pct?: number }
  spcAft?: { pts?: number; pct?: number }
  lnSpc?: { pts?: number; pct?: number }
  buNone?: boolean
  buChar?: string
  buFont?: string
  buAutoNum?: { type: string; startAt: number }
  buClr?: Rgba
  buSzPct?: number
  rtl?: boolean
  tabs?: { pos: number; algn: string }[]
  defRPr: RPr
}

export const newPPr = (): PPr => ({ defRPr: {} })

export function resolveTypeface(face: string | undefined, theme: ThemeInfo): string | undefined {
  if (!face) return undefined
  if (face.startsWith('+mj')) return theme.major
  if (face.startsWith('+mn')) return theme.minor
  return face
}

export function applyRPr(t: RPr, n: XNode | undefined, cc: ColorCtx): void {
  if (!n) return
  const sz = numAttr(n, 'sz')
  if (sz !== undefined) t.sz = sz / 100
  const b = attr(n, 'b')
  if (b !== undefined) t.b = b === '1' || b === 'true'
  const i = attr(n, 'i')
  if (i !== undefined) t.i = i === '1' || i === 'true'
  const u = attr(n, 'u')
  if (u !== undefined) t.u = u !== 'none'
  const s = attr(n, 'strike')
  if (s !== undefined) t.strike = s !== 'noStrike'
  const bl = numAttr(n, 'baseline')
  if (bl !== undefined) t.baseline = bl / 1000
  const cap = attr(n, 'cap')
  if (cap !== undefined) t.caps = cap === 'all'
  const spc = numAttr(n, 'spc')
  if (spc !== undefined) t.spc = spc / 100
  for (const c of n.children) {
    if (c.name === 'solidFill') {
      const col = findColor(c, cc.theme, cc.clrMap)
      if (col) t.color = col
    } else if (c.name === 'latin') {
      const f = resolveTypeface(attr(c, 'typeface'), cc.theme)
      if (f) t.family = f
    } else if (c.name === 'cs') {
      const face = attr(c, 'typeface')
      const f = face === '+mn-cs' ? cc.theme.minorCs : face === '+mj-cs' ? cc.theme.majorCs : resolveTypeface(face, cc.theme)
      if (f) t.csFamily = f
    } else if (c.name === 'hlinkClick') {
      const id = attr(c, 'id')
      if (id) t.link = id
    } else if (c.name === 'highlight') {
      const col = findColor(c, cc.theme, cc.clrMap)
      if (col) t.highlight = col
    }
  }
}

const spacing = (n: XNode | undefined): { pts?: number; pct?: number } | undefined => {
  const p = child(n, 'spcPts')
  if (p) return { pts: (numAttr(p, 'val') ?? 0) / 100 }
  const q = child(n, 'spcPct')
  if (q) return { pct: (numAttr(q, 'val') ?? 0) / 100000 }
  return undefined
}

export function applyPPr(t: PPr, n: XNode | undefined, cc: ColorCtx): void {
  if (!n) return
  const algn = attr(n, 'algn')
  if (algn) t.algn = algn
  const marL = numAttr(n, 'marL')
  if (marL !== undefined) t.marL = marL / EMU_PER_PT
  const ind = numAttr(n, 'indent')
  if (ind !== undefined) t.indent = ind / EMU_PER_PT
  if (attr(n, 'rtl') === '1') t.rtl = true
  for (const c of n.children) {
    switch (c.name) {
      case 'spcBef':
        t.spcBef = spacing(c)
        break
      case 'spcAft':
        t.spcAft = spacing(c)
        break
      case 'lnSpc':
        t.lnSpc = spacing(c)
        break
      case 'buNone':
        t.buNone = true
        t.buChar = undefined
        t.buAutoNum = undefined
        break
      case 'buChar':
        t.buChar = attr(c, 'char') ?? '•'
        t.buNone = false
        t.buAutoNum = undefined
        break
      case 'buAutoNum':
        t.buAutoNum = { type: attr(c, 'type') ?? 'arabicPeriod', startAt: numAttr(c, 'startAt') ?? 1 }
        t.buNone = false
        t.buChar = undefined
        break
      case 'buFont':
        t.buFont = attr(c, 'typeface')
        break
      case 'buClr': {
        const col = findColor(c, cc.theme, cc.clrMap)
        if (col) t.buClr = col
        break
      }
      case 'buClrTx':
        t.buClr = undefined
        break
      case 'buSzPct':
        t.buSzPct = (numAttr(c, 'val') ?? 100000) / 100000
        break
      case 'tabLst':
        t.tabs = c.children.filter((x) => x.name === 'tab').map((x) => ({ pos: (numAttr(x, 'pos') ?? 0) / EMU_PER_PT, algn: attr(x, 'algn') ?? 'l' }))
        break
      case 'defRPr':
        applyRPr(t.defRPr, c, cc)
        break
      default:
        break
    }
  }
}

/** Converts a bullet number to its text for the common `buAutoNum` types. */
export function autoNumText(type: string, n: number): string {
  const alpha = (k: number, upper: boolean): string => {
    let s = ''
    let v = k
    while (v > 0) {
      s = String.fromCharCode(97 + ((v - 1) % 26)) + s
      v = Math.floor((v - 1) / 26)
    }
    return upper ? s.toUpperCase() : s
  }
  const roman = (k: number, upper: boolean): string => {
    const map: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
    let s = ''
    let v = k
    for (const [val, sym] of map) while (v >= val) ((s += sym), (v -= val))
    return upper ? s.toUpperCase() : s
  }
  const base = /^arabic/.test(type) ? String(n) : /^alphaLc/.test(type) ? alpha(n, false) : /^alphaUc/.test(type) ? alpha(n, true) : /^romanLc/.test(type) ? roman(n, false) : /^romanUc/.test(type) ? roman(n, true) : String(n)
  if (/ParenBoth$/.test(type)) return `(${base})`
  if (/ParenR$/.test(type)) return `${base})`
  if (/Period$/.test(type)) return `${base}.`
  return base
}

const SYMBOL_BULLETS: Record<string, string> = {
  '§': '▪', // Wingdings small square
  'Ø': '➢', // arrow
  'ü': '✓', // check
  l: '●',
  n: '■',
  q: '❏',
  u: '◆',
  v: '❖',
  '¨': '◻',
  '·': '•'
}

/** Bullet character to draw: private-use / symbol-font characters are mapped to real Unicode bullets. */
export function bulletText(ch: string, font: string | undefined): string {
  if (!ch) return '•'
  const cp = ch.codePointAt(0) ?? 0
  const symbolic = font && /wingdings|symbol|webdings/i.test(font)
  if (cp >= 0xf000 && cp <= 0xf0ff) return SYMBOL_BULLETS[String.fromCharCode(cp - 0xf000)] ?? '•'
  if (symbolic) return SYMBOL_BULLETS[ch] ?? '•'
  return ch
}
