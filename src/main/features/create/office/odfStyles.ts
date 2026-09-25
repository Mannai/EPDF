import type { BorderSpec, ParaProps, TextStyle } from './flow'
import { attr, child, type XNode } from './xml'

/**
 * OpenDocument style sheet: collects `style:style`, `style:default-style`, list styles, gradients, dashes and
 * fill images from styles.xml/content.xml and resolves style inheritance. Shared by the ODP converter (and
 * usable by other ODF readers).
 */

export const PT_PER_CM = 72 / 2.54

/** Parses an ODF length ("1.5cm", "12pt", "0.2in", "3mm") into points; percentages return `pctBase` fraction. */
export function odfLength(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback
  const m = /^\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*(cm|mm|in|pt|pc|px|em|ex)?\s*$/i.exec(v)
  if (!m) return fallback
  const n = parseFloat(m[1])
  switch ((m[2] ?? 'pt').toLowerCase()) {
    case 'cm':
      return n * PT_PER_CM
    case 'mm':
      return (n * PT_PER_CM) / 10
    case 'in':
      return n * 72
    case 'pc':
      return n * 12
    case 'px':
      return n * 0.75
    case 'em':
      return n * 12
    case 'ex':
      return n * 6
    default:
      return n
  }
}

export interface PropSets {
  text: Record<string, string>
  para: Record<string, string>
  graphic: Record<string, string>
  cell: Record<string, string>
  col: Record<string, string>
  row: Record<string, string>
  page: Record<string, string>
}

export interface OdfStyle {
  name: string
  family: string
  parent?: string
  listStyleName?: string
  /** A `text:list-style` nested inside the style (presentation styles carry their outline list style this way). */
  nestedList?: XNode
  props: PropSets
}

const emptySets = (): PropSets => ({ text: {}, para: {}, graphic: {}, cell: {}, col: {}, row: {}, page: {} })

const localKey = (k: string): string => {
  const i = k.indexOf(':')
  return i >= 0 ? k.slice(i + 1) : k
}

function readProps(into: PropSets, style: XNode): void {
  for (const p of style.children) {
    let target: Record<string, string> | undefined
    switch (p.name) {
      case 'text-properties':
        target = into.text
        break
      case 'paragraph-properties':
        target = into.para
        break
      case 'graphic-properties':
      case 'drawing-page-properties':
        target = into.graphic
        break
      case 'table-cell-properties':
        target = into.cell
        break
      case 'table-column-properties':
        target = into.col
        break
      case 'table-row-properties':
        target = into.row
        break
      case 'page-layout-properties':
        target = into.page
        break
      default:
        break
    }
    if (!target) continue
    for (const [k, v] of Object.entries(p.attrs)) target[localKey(k)] = v
  }
}

export class OdfStyles {
  private styles = new Map<string, OdfStyle>() // key: family + '|' + name
  private defaults = new Map<string, OdfStyle>()
  private cache = new Map<string, PropSets & { listStyleName?: string; nestedList?: XNode }>()
  readonly listStyles = new Map<string, XNode>()
  readonly gradients = new Map<string, XNode>()
  readonly dashes = new Map<string, XNode>()
  readonly fillImages = new Map<string, XNode>()
  readonly fonts = new Map<string, string>()
  readonly masterPages = new Map<string, XNode>()
  readonly pageLayouts = new Map<string, PropSets>()

  /** Adds the styles of an `office:document-styles` / `office:document-content` root (later calls override earlier ones). */
  addRoot(root: XNode | undefined): void {
    const doc = root?.children[0]
    if (!doc) return
    for (const f of child(doc, 'font-face-decls')?.children ?? []) {
      const name = attr(f, 'name')
      const fam = attr(f, 'font-family')
      if (name) this.fonts.set(name, (fam ?? name).replace(/^['"]|['"]$/g, ''))
    }
    for (const container of [child(doc, 'styles'), child(doc, 'automatic-styles'), child(doc, 'master-styles')]) {
      for (const n of container?.children ?? []) this.addNode(n)
    }
  }

  private addNode(n: XNode): void {
    switch (n.name) {
      case 'style': {
        const name = attr(n, 'name')
        const family = attr(n, 'family')
        if (!name || !family) return
        const props = emptySets()
        readProps(props, n)
        const st: OdfStyle = { name, family, parent: attr(n, 'parent-style-name'), listStyleName: attr(n, 'list-style-name'), nestedList: child(n, 'list-style') ?? child(child(n, 'graphic-properties'), 'list-style'), props }
        this.styles.set(`${family}|${name}`, st)
        if (st.nestedList) this.listStyles.set(name, st.nestedList)
        break
      }
      case 'default-style': {
        const family = attr(n, 'family')
        if (!family) return
        const props = emptySets()
        readProps(props, n)
        this.defaults.set(family, { name: '', family, props })
        break
      }
      case 'list-style': {
        const name = attr(n, 'name')
        if (name) this.listStyles.set(name, n)
        break
      }
      case 'gradient': {
        const name = attr(n, 'name')
        if (name) this.gradients.set(name, n)
        break
      }
      case 'stroke-dash': {
        const name = attr(n, 'name')
        if (name) this.dashes.set(name, n)
        break
      }
      case 'fill-image': {
        const name = attr(n, 'name')
        if (name) this.fillImages.set(name, n)
        break
      }
      case 'master-page': {
        const name = attr(n, 'name')
        if (name) this.masterPages.set(name, n)
        break
      }
      case 'page-layout': {
        const name = attr(n, 'name')
        if (name) {
          const props = emptySets()
          readProps(props, n)
          this.pageLayouts.set(name, props)
        }
        break
      }
      default:
        break
    }
  }

  has(family: string, name: string | undefined): boolean {
    return !!name && this.styles.has(`${family}|${name}`)
  }

  /** Merged properties of a style including its parents and the family default. Unknown styles yield the default. */
  resolve(family: string, name: string | undefined): PropSets & { listStyleName?: string; nestedList?: XNode } {
    const key = `${family}|${name ?? ''}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const out: PropSets & { listStyleName?: string; nestedList?: XNode } = emptySets()
    const chain: OdfStyle[] = []
    let cur = name ? this.styles.get(`${family}|${name}`) : undefined
    const seen = new Set<OdfStyle>()
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      chain.unshift(cur)
      cur = cur.parent ? this.styles.get(`${family}|${cur.parent}`) : undefined
    }
    const def = this.defaults.get(family === 'presentation' || family === 'drawing-page' ? 'graphic' : family)
    const all = def ? [def, ...chain] : chain
    for (const s of all) {
      for (const k of ['text', 'para', 'graphic', 'cell', 'col', 'row', 'page'] as (keyof PropSets)[]) Object.assign(out[k], s.props[k])
      if (s.listStyleName) out.listStyleName = s.listStyleName
      if (s.nestedList) out.nestedList = s.nestedList
    }
    this.cache.set(key, out)
    return out
  }
}

// ---------------------------------------------------------------------------------------------------
// Property conversion
// ---------------------------------------------------------------------------------------------------

export interface TextProps {
  size: number
  family?: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color?: string
  highlight?: string
  vertAlign?: 'super' | 'sub'
  caps: boolean
  spacing?: number
}

export const baseTextProps = (): TextProps => ({ size: 18, bold: false, italic: false, underline: false, strike: false, caps: false })

/** Applies ODF `style:text-properties` attributes on top of `t`. */
export function applyTextProps(t: TextProps, p: Record<string, string>, fonts: Map<string, string>): TextProps {
  const out: TextProps = { ...t }
  const fs = p['font-size']
  if (fs) {
    if (fs.endsWith('%')) out.size = t.size * (parseFloat(fs) / 100)
    else out.size = odfLength(fs, t.size)
  }
  const fn = p['font-name']
  const ff = p['font-family']
  if (ff) out.family = ff.replace(/^['"]|['"]$/g, '')
  else if (fn) out.family = fonts.get(fn) ?? fn
  const fw = p['font-weight']
  if (fw) out.bold = fw === 'bold' || (/^\d+$/.test(fw) && parseInt(fw, 10) >= 600)
  const fst = p['font-style']
  if (fst) out.italic = fst === 'italic' || fst === 'oblique'
  const u = p['text-underline-style']
  if (u) out.underline = u !== 'none'
  const ls = p['text-line-through-style']
  if (ls) out.strike = ls !== 'none'
  const c = p['color']
  if (c && /^#[0-9a-f]{6}$/i.test(c)) out.color = c.toLowerCase()
  const bg = p['background-color']
  if (bg) out.highlight = /^#[0-9a-f]{6}$/i.test(bg) ? bg.toLowerCase() : undefined
  const pos = p['text-position']
  if (pos) {
    const first = pos.split(/\s+/)[0]
    if (first.startsWith('super')) out.vertAlign = 'super'
    else if (first.startsWith('sub')) out.vertAlign = 'sub'
    else {
      const v = parseFloat(first)
      out.vertAlign = Number.isFinite(v) ? (v > 0 ? 'super' : v < 0 ? 'sub' : undefined) : undefined
    }
  }
  const tt = p['text-transform']
  if (tt) out.caps = tt === 'uppercase'
  const sp = p['letter-spacing']
  if (sp && sp !== 'normal') out.spacing = odfLength(sp)
  return out
}

export function toTextStyle(t: TextProps, defaultFamily: string): TextStyle {
  return {
    family: t.family ?? defaultFamily,
    size: Math.max(1, t.size),
    bold: t.bold,
    italic: t.italic,
    underline: t.underline,
    strike: t.strike,
    color: t.color ?? '#000000',
    highlight: t.highlight,
    vertAlign: t.vertAlign,
    caps: t.caps || undefined,
    spacing: t.spacing
  }
}

const ALIGN: Record<string, ParaProps['align']> = { start: 'left', left: 'left', end: 'right', right: 'right', center: 'center', justify: 'justify' }

export interface ParaBase {
  align: ParaProps['align']
  marginLeft: number
  marginRight: number
  indent: number
  before: number
  after: number
  line: ParaProps['line']
}

export const baseParaProps = (): ParaBase => ({ align: 'left', marginLeft: 0, marginRight: 0, indent: 0, before: 0, after: 0, line: { rule: 'auto', value: 1 } })

export function applyParaProps(b: ParaBase, p: Record<string, string>): ParaBase {
  const out = { ...b, line: { ...b.line } }
  const ta = p['text-align']
  if (ta && ALIGN[ta]) out.align = ALIGN[ta]
  if (p['margin-left'] !== undefined) out.marginLeft = odfLength(p['margin-left'])
  if (p['margin-right'] !== undefined) out.marginRight = odfLength(p['margin-right'])
  if (p['text-indent'] !== undefined) out.indent = odfLength(p['text-indent'])
  if (p['margin-top'] !== undefined) out.before = odfLength(p['margin-top'])
  if (p['margin-bottom'] !== undefined) out.after = odfLength(p['margin-bottom'])
  const lh = p['line-height']
  if (lh) {
    if (lh.endsWith('%')) out.line = { rule: 'auto', value: parseFloat(lh) / 100 }
    else if (lh !== 'normal') out.line = { rule: 'exact', value: odfLength(lh) }
  }
  const lha = p['line-height-at-least']
  if (lha) out.line = { rule: 'atLeast', value: odfLength(lha) }
  return out
}

/** Parses "0.06pt solid #000000" style border values; null means "no border". */
export function odfBorder(v: string | undefined): BorderSpec | null | undefined {
  if (v === undefined) return undefined
  if (v === 'none' || v === 'hidden') return null
  const m = /^\s*(\S+)\s+(\w+)\s+(#[0-9a-fA-F]{6})\s*$/.exec(v)
  if (!m) return undefined
  const w = odfLength(m[1])
  return { width: Math.max(0.25, w), color: m[3].toLowerCase(), style: m[2] === 'double' ? 'double' : m[2] === 'dashed' ? 'dashed' : m[2] === 'dotted' ? 'dotted' : 'single' }
}
