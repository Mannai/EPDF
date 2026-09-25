import { attr, child, childrenNamed, type XNode } from './xml'

/**
 * OpenDocument style plumbing for the ODT reader: style registry with parent chains and family defaults,
 * font-face lookup, length/border parsing and list-number formatting. (Named odtStyles to keep it apart from
 * the presentation reader's own style sheet, odfStyles.ts.)
 */

export type PropKind = 'paragraph' | 'text' | 'table-cell' | 'table' | 'table-column' | 'table-row' | 'graphic' | 'section' | 'list-level'

export interface OdfStyle {
  name: string
  family: string
  parent?: string
  listStyle?: string
  master?: string
  next?: string
  outlineLevel?: number
  props: Partial<Record<PropKind, Record<string, string>>>
  tabStops?: XNode[]
  columns?: XNode
}

const PROP_NODES: Record<string, PropKind> = {
  'paragraph-properties': 'paragraph',
  'text-properties': 'text',
  'table-cell-properties': 'table-cell',
  'table-properties': 'table',
  'table-column-properties': 'table-column',
  'table-row-properties': 'table-row',
  'graphic-properties': 'graphic',
  'section-properties': 'section'
}

function readStyle(el: XNode): OdfStyle | null {
  const name = el.attrs['style:name'] ?? (el.name === 'default-style' ? '' : undefined)
  const family = el.attrs['style:family']
  if (name === undefined || !family) return null
  const st: OdfStyle = {
    name,
    family,
    parent: el.attrs['style:parent-style-name'],
    listStyle: el.attrs['style:list-style-name'],
    master: el.attrs['style:master-page-name'],
    next: el.attrs['style:next-style-name'],
    outlineLevel: el.attrs['style:default-outline-level'] ? parseInt(el.attrs['style:default-outline-level'], 10) : undefined,
    props: {}
  }
  for (const c of el.children) {
    const kind = PROP_NODES[c.name]
    if (kind) {
      st.props[kind] = { ...(st.props[kind] ?? {}), ...c.attrs }
      const ts = child(c, 'tab-stops')
      if (ts) st.tabStops = childrenNamed(ts, 'tab-stop')
      const cols = child(c, 'columns')
      if (cols) st.columns = cols
    }
  }
  return st
}

export class StyleRegistry {
  /** Style maps in priority order (first match wins). */
  private maps: Map<string, OdfStyle>[] = []
  private defaults = new Map<string, OdfStyle>()
  private listStyles: Map<string, XNode>[] = []
  readonly fontFaces = new Map<string, string>()
  outlineStyle: XNode | undefined
  readonly pageLayouts = new Map<string, XNode>()
  readonly masters: XNode[] = []

  /** `roots` are document roots (`document-content` / `document-styles`) in priority order. */
  constructor(roots: (XNode | undefined)[]) {
    for (const root of roots) {
      if (!root) continue
      const map = new Map<string, OdfStyle>()
      const lists = new Map<string, XNode>()
      for (const sec of ['automatic-styles', 'styles'] as const) {
        const s = child(root, sec)
        if (!s) continue
        for (const el of s.children) {
          if (el.name === 'style') {
            const st = readStyle(el)
            if (st) map.set(`${st.family}:${st.name}`, st)
          } else if (el.name === 'default-style') {
            const st = readStyle(el)
            if (st && !this.defaults.has(st.family)) this.defaults.set(st.family, st)
          } else if (el.name === 'list-style') {
            const n = el.attrs['style:name']
            if (n) lists.set(n, el)
          } else if (el.name === 'outline-style' && !this.outlineStyle) this.outlineStyle = el
          else if (el.name === 'page-layout') {
            const n = el.attrs['style:name']
            if (n && !this.pageLayouts.has(n)) this.pageLayouts.set(n, el)
          }
        }
      }
      this.maps.push(map)
      this.listStyles.push(lists)
      const decls = child(root, 'font-face-decls')
      for (const f of childrenNamed(decls, 'font-face')) {
        const n = f.attrs['style:name']
        const fam = f.attrs['svg:font-family']
        if (n && fam && !this.fontFaces.has(n)) this.fontFaces.set(n, fam.replace(/^['"]|['"]$/g, ''))
      }
      const ms = child(root, 'master-styles')
      for (const m of childrenNamed(ms, 'master-page')) this.masters.push(m)
    }
  }

  find(family: string, name: string | undefined): OdfStyle | undefined {
    if (name === undefined) return undefined
    for (const m of this.maps) {
      const s = m.get(`${family}:${name}`)
      if (s) return s
    }
    return undefined
  }

  /** Style chain from the style up to (and including) the family default, leaf first. */
  chain(family: string, name: string | undefined): OdfStyle[] {
    const out: OdfStyle[] = []
    const seen = new Set<string>()
    let cur = this.find(family, name)
    while (cur && !seen.has(cur.name)) {
      seen.add(cur.name)
      out.push(cur)
      cur = cur.parent ? this.find(family, cur.parent) : undefined
    }
    const def = this.defaults.get(family)
    if (def) out.push(def)
    return out
  }

  /** Merged property attributes of one kind (`fo:font-size`, ...): parents first, the style's own values win. */
  props(family: string, name: string | undefined, kind: PropKind): Record<string, string> {
    const merged: Record<string, string> = {}
    const ch = this.chain(family, name)
    for (let i = ch.length - 1; i >= 0; i--) Object.assign(merged, ch[i].props[kind] ?? {})
    return merged
  }

  /** The property sets of one kind along the chain, root (family default) first, the style itself last. */
  propList(family: string, name: string | undefined, kind: PropKind): Record<string, string>[] {
    const ch = this.chain(family, name)
    const out: Record<string, string>[] = []
    for (let i = ch.length - 1; i >= 0; i--) {
      const p = ch[i].props[kind]
      if (p) out.push(p)
    }
    return out
  }

  /** First value of a style-level attribute along the chain (e.g. list style, master page). */
  inherited(family: string, name: string | undefined, key: 'listStyle' | 'master' | 'outlineLevel'): string | number | undefined {
    for (const s of this.chain(family, name)) if (s[key] !== undefined) return s[key]
    return undefined
  }

  tabStops(family: string, name: string | undefined): XNode[] | undefined {
    for (const s of this.chain(family, name)) if (s.tabStops) return s.tabStops
    return undefined
  }

  columns(family: string, name: string | undefined): XNode | undefined {
    for (const s of this.chain(family, name)) if (s.columns) return s.columns
    return undefined
  }

  listStyle(name: string | undefined): XNode | undefined {
    if (!name) return undefined
    for (const m of this.listStyles) {
      const l = m.get(name)
      if (l) return l
    }
    return undefined
  }

  fontFamily(styleFontName: string | undefined, direct: string | undefined): string | undefined {
    if (direct) return direct.replace(/^['"]|['"]$/g, '')
    if (styleFontName) return this.fontFaces.get(styleFontName) ?? styleFontName
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------

/** Parses an ODF length (`2.5cm`, `12pt`, `0.1in`, `10px`, `50%`) into points. Percentages need `base`. */
export function parseLength(v: string | undefined, base?: number): number | undefined {
  if (!v) return undefined
  const m = /^\s*(-?\d*\.?\d+(?:e[+-]?\d+)?)\s*(cm|mm|in|pt|pc|px|em|%)?\s*$/i.exec(v)
  if (!m) return undefined
  const n = parseFloat(m[1])
  switch ((m[2] ?? 'pt').toLowerCase()) {
    case 'cm':
      return (n * 72) / 2.54
    case 'mm':
      return (n * 72) / 25.4
    case 'in':
      return n * 72
    case 'pt':
      return n
    case 'pc':
      return n * 12
    case 'px':
      return n * 0.75
    case 'em':
      return base === undefined ? undefined : n * base
    case '%':
      return base === undefined ? undefined : (n / 100) * base
  }
  return undefined
}

export interface OdfBorder {
  width: number
  style: 'single' | 'double' | 'dashed' | 'dotted'
  color: string
}

/** `0.5pt solid #000000` -> border, `none` -> null, undefined when absent. */
export function parseBorder(v: string | undefined): OdfBorder | null | undefined {
  if (v === undefined) return undefined
  const t = v.trim()
  if (!t || t === 'none' || t === 'hidden') return null
  const parts = t.split(/\s+/)
  const width = parseLength(parts[0]) ?? 0.5
  const kind = parts.find((p) => /^(solid|double|dashed|dotted|dot-dash|dot-dot-dash|groove|ridge|inset|outset)$/.test(p)) ?? 'solid'
  const color = parts.find((p) => /^#[0-9a-fA-F]{3,8}$/.test(p)) ?? '#000000'
  if (width <= 0) return null
  return { width: Math.max(0.25, width), style: kind === 'double' ? 'double' : kind === 'dashed' || kind === 'dot-dash' || kind === 'dot-dot-dash' ? 'dashed' : kind === 'dotted' ? 'dotted' : 'single', color: color.length > 7 ? color.slice(0, 7) : color }
}

export const parseColor = (v: string | undefined): string | undefined => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : v && /^#[0-9a-fA-F]{3}$/.test(v) ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : undefined)

const roman = (n: number): string => {
  const map: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let s = ''
  for (const [v, r] of map) while (n >= v) {
    s += r
    n -= v
  }
  return s
}

const letters = (n: number, upper: boolean): string => {
  let s = ''
  let x = n
  while (x > 0) {
    x--
    s = String.fromCharCode((upper ? 65 : 97) + (x % 26)) + s
    x = Math.floor(x / 26)
  }
  return upper ? s.toUpperCase() : s
}

/** Formats a list counter for an ODF `style:num-format` (1, a, A, i, I; anything else is decimal, empty is none). */
export function formatOdfNumber(n: number, format: string | undefined): string {
  switch (format) {
    case '':
      return ''
    case 'a':
      return letters(n, false)
    case 'A':
      return letters(n, true)
    case 'i':
      return roman(n).toLowerCase()
    case 'I':
      return roman(n)
    default:
      return String(n)
  }
}

export { attr }
