import { OfficeError, throwIfCancelled, type ConvertEnv } from './env'
import { imageFormat, openPackage, type Pkg } from './package'
import { generalText } from './numfmt'
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
  type SheetCell
} from './sheet'
import { attr, child, childrenNamed, descendants, numAttr, textContent, type XNode } from './xml'

/**
 * ODS -> PDF with the built-in engine: table:table structure (repeats, spans, header rows), automatic and
 * common styles, the formatted text stored in each cell, page layout and header/footer, pictures.
 */

const MAX_CELLS = 3_000_000
const MAX_REPEAT_CELLS = 512
const MAX_REPEAT_ROWS = 2000
const MAX_COLS = 4096

/** Parses an ODF length (`2.5cm`, `10pt`, `0.5in`, `3mm`) into points. */
export function parseLength(s: string | undefined): number | undefined {
  if (!s) return undefined
  const m = /^\s*(-?[\d.]+)\s*(cm|mm|in|pt|px|pc)?\s*$/.exec(s)
  if (!m) return undefined
  const v = parseFloat(m[1])
  switch (m[2] ?? 'pt') {
    case 'cm':
      return (v / 2.54) * 72
    case 'mm':
      return (v / 25.4) * 72
    case 'in':
      return v * 72
    case 'px':
      return v * 0.75
    case 'pc':
      return v * 12
    default:
      return v
  }
}

type Props = Record<string, Record<string, string>>

interface StyleDef {
  parent?: string
  family: string
  props: Props
  masterPage?: string
}

const local = (k: string): string => {
  const c = k.indexOf(':')
  return c >= 0 ? k.slice(c + 1) : k
}

function readStyleDef(n: XNode): StyleDef {
  const props: Props = {}
  for (const c of n.children) {
    const bag: Record<string, string> = props[c.name] ?? (props[c.name] = {})
    for (const [k, v] of Object.entries(c.attrs)) bag[local(k)] = v
  }
  return { parent: attr(n, 'parent-style-name'), family: attr(n, 'family') ?? '', props, masterPage: attr(n, 'master-page-name') }
}

class StyleBook {
  private map = new Map<string, StyleDef>()
  private defaults = new Map<string, StyleDef>()
  private cache = new Map<string, Props>()
  fonts = new Map<string, string>()

  add(root: XNode | undefined): void {
    if (!root) return
    for (const s of root.children) {
      if (s.name === 'style') this.map.set(`${attr(s, 'family')}:${attr(s, 'name')}`, readStyleDef(s))
      else if (s.name === 'default-style') this.defaults.set(attr(s, 'family') ?? '', readStyleDef(s))
    }
  }

  addFonts(root: XNode | undefined): void {
    for (const f of childrenNamed(child(root, 'font-face-decls'), 'font-face')) {
      const name = attr(f, 'name')
      const fam = attr(f, 'font-family')
      if (name && fam) this.fonts.set(name, fam.replace(/^'|'$/g, '').replace(/^"|"$/g, ''))
    }
  }

  get(family: string, name: string | undefined): StyleDef | undefined {
    return name ? this.map.get(`${family}:${name}`) : undefined
  }

  /** Merged properties: default style < parent chain < the style itself. */
  props(family: string, name: string | undefined): Props {
    const key = `${family}:${name ?? ''}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const chain: StyleDef[] = []
    let cur = this.get(family, name)
    let guard = 0
    while (cur && guard++ < 20) {
      chain.unshift(cur)
      cur = cur.parent ? this.get(family, cur.parent) : undefined
    }
    const d = this.defaults.get(family)
    if (d) chain.unshift(d)
    const out: Props = {}
    for (const s of chain) for (const [el, bag] of Object.entries(s.props)) out[el] = { ...(out[el] ?? {}), ...bag }
    this.cache.set(key, out)
    return out
  }
}

function border(v: string | undefined): BorderLine | undefined {
  if (!v || v === 'none' || v === 'hidden') return undefined
  const parts = v.split(/\s+/)
  const width = parseLength(parts[0]) ?? 0.75
  const color = parts.find((p) => p.startsWith('#')) ?? '#000000'
  const st = parts.find((p) => ['solid', 'dashed', 'dotted', 'double', 'dot-dash', 'dash-dot'].includes(p)) ?? 'solid'
  return { width: Math.max(0.3, width), color, style: st === 'double' ? 'double' : st === 'solid' ? 'single' : st === 'dotted' ? 'dotted' : 'dashed' }
}

function familyOf(book: StyleBook, tp: Record<string, string> | undefined): string {
  const fn = tp?.['font-name']
  const raw = tp?.['font-family'] ?? (fn ? book.fonts.get(fn) ?? fn : undefined)
  return (raw ?? 'Liberation Sans').replace(/^'|'$/g, '').replace(/^"|"$/g, '')
}

function cellStyleOf(book: StyleBook, name: string | undefined): CellStyle {
  const p = book.props('table-cell', name)
  const cp = p['table-cell-properties'] ?? {}
  const tp = p['text-properties'] ?? {}
  const pp = p['paragraph-properties'] ?? {}
  const size = parseLength(tp['font-size']) ?? 10
  const bg = cp['background-color']
  const font: CellFont = {
    family: familyOf(book, tp),
    size,
    bold: tp['font-weight'] === 'bold' || parseInt(tp['font-weight'] ?? '400', 10) >= 600,
    italic: tp['font-style'] === 'italic' || tp['font-style'] === 'oblique',
    underline: !!tp['text-underline-style'] && tp['text-underline-style'] !== 'none',
    strike: !!tp['text-line-through-style'] && tp['text-line-through-style'] !== 'none',
    color: tp['color'] && tp['color'] !== 'transparent' ? tp['color'] : '#000000'
  }
  const all = border(cp['border'])
  const ta = pp['text-align']
  const va = cp['vertical-align']
  return {
    font,
    fill: bg && bg !== 'transparent' ? bg : undefined,
    borders: { left: border(cp['border-left']) ?? all, right: border(cp['border-right']) ?? all, top: border(cp['border-top']) ?? all, bottom: border(cp['border-bottom']) ?? all },
    h: ta === 'center' ? 'center' : ta === 'end' || ta === 'right' ? 'right' : ta === 'justify' ? 'justify' : ta === 'left' || ta === 'start' ? 'left' : 'general',
    v: va === 'top' ? 'top' : va === 'middle' ? 'center' : 'bottom',
    wrap: cp['wrap-option'] === 'wrap',
    indent: Math.round((parseLength(pp['margin-left']) ?? 0) / 6.75),
    shrink: cp['shrink-to-fit'] === 'true',
    readingOrder: pp['writing-mode']?.startsWith('rl') ? 'rtl' : pp['writing-mode']?.startsWith('lr') ? 'ltr' : undefined
  }
}

// ---------------------------------------------------------------------------------------------------
// Text of a cell
// ---------------------------------------------------------------------------------------------------

function paraText(n: XNode, out: { s: string; link?: string }): void {
  for (const x of n.nodes) {
    if (typeof x === 'string') {
      out.s += x.replace(/[\r\n\t]+/g, ' ')
      continue
    }
    switch (x.name) {
      case 's':
        out.s += ' '.repeat(numAttr(x, 'c') ?? 1)
        break
      case 'tab':
        out.s += '\t'
        break
      case 'line-break':
        out.s += '\n'
        break
      case 'a': {
        const href = attr(x, 'href')
        if (href && /^(https?:|mailto:)/i.test(href)) out.link = href
        paraText(x, out)
        break
      }
      case 'annotation':
      case 'annotation-end':
        break
      default:
        paraText(x, out)
    }
  }
}

function cellText(cell: XNode): { text: string; link?: string } {
  const out = { s: '', link: undefined as string | undefined }
  const ps = childrenNamed(cell, 'p')
  ps.forEach((p, i) => {
    if (i > 0) out.s += '\n'
    paraText(p, out)
  })
  return { text: out.s, link: out.link }
}

// ---------------------------------------------------------------------------------------------------
// Page layout
// ---------------------------------------------------------------------------------------------------

function hfRuns(n: XNode, fonts: (name: string | undefined) => string | undefined): HFRun[] {
  const runs: HFRun[] = []
  const walk = (x: XNode, style: { bold: boolean; italic: boolean; family?: string }): void => {
    for (const c of x.nodes) {
      if (typeof c === 'string') {
        const t = c.replace(/\s+/g, ' ')
        if (t.trim() || (t === ' ' && runs.length)) runs.push({ text: t, bold: style.bold, italic: style.italic, family: style.family, size: 10 })
        continue
      }
      const field: Record<string, HFRun['field']> = { 'page-number': 'page', 'page-count': 'pages', 'sheet-name': 'sheet', date: 'date', time: 'time', 'file-name': 'file', title: 'sheet' }
      if (field[c.name]) runs.push({ field: field[c.name], bold: style.bold, italic: style.italic, family: style.family, size: 10 })
      else if (c.name === 'span') walk(c, { ...style, family: fonts(attr(c, 'style-name')) ?? style.family })
      else if (c.name === 'p') {
        if (runs.length) runs.push({ text: ' ', size: 10 })
        walk(c, style)
      } else walk(c, style)
    }
  }
  walk(n, { bold: false, italic: false })
  return runs
}

function odfHeaderFooter(node: XNode | undefined, node2: XNode | undefined): HeaderFooter | undefined {
  const main = node
  if (!main) return undefined
  const mk = (n: XNode): HFSet => {
    const set: HFSet = { left: [], center: [], right: [] }
    const regions = ['region-left', 'region-center', 'region-right'].map((r) => child(n, r))
    if (regions.some(Boolean)) {
      set.left = regions[0] ? hfRuns(regions[0], () => undefined) : []
      set.center = regions[1] ? hfRuns(regions[1], () => undefined) : []
      set.right = regions[2] ? hfRuns(regions[2], () => undefined) : []
    } else set.left = hfRuns(n, () => undefined)
    return set
  }
  const odd = mk(main)
  const even = node2 ? mk(node2) : undefined
  const empty = (s: HFSet | undefined): boolean => !s || (!s.left.length && !s.center.length && !s.right.length)
  if (empty(odd) && empty(even)) return undefined
  return { odd, even, first: undefined, differentOddEven: !!even, differentFirst: false }
}

// ---------------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------------

function addressToRange(s: string): Range | null {
  // `Sheet1.A1:Sheet1.C5`, `$Sheet1.$A$1:.C5`, `A1:C5`
  const parts = s.split(':').map((p) => p.replace(/^.*\./, '').replace(/\$/g, ''))
  const cell = (t: string): { r: number; c: number } | null => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(t)
    if (!m) return null
    let c = 0
    for (const ch of m[1].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64
    return { c: c - 1, r: parseInt(m[2], 10) - 1 }
  }
  const a = cell(parts[0])
  const b = cell(parts[1] ?? parts[0])
  if (!a || !b) return null
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) }
}

export async function convertOds(bytes: Uint8Array, env: ConvertEnv): Promise<Page[]> {
  const pkg = openPackage(bytes, 'spreadsheet')
  const content = pkg.xml('content.xml')?.children.find((c) => c.name === 'document-content')
  if (!content) throw new OfficeError('This file does not look like an OpenDocument spreadsheet (content.xml is missing).')
  const stylesRoot = pkg.xml('styles.xml')?.children.find((c) => c.name === 'document-styles')
  const book = new StyleBook()
  book.addFonts(stylesRoot)
  book.addFonts(content)
  book.add(child(stylesRoot, 'styles'))
  book.add(child(stylesRoot, 'automatic-styles'))
  book.add(child(content, 'automatic-styles'))
  const spreadsheet = child(child(content, 'body'), 'spreadsheet')
  if (!spreadsheet) throw new OfficeError('This OpenDocument file is not a spreadsheet.')

  // page layouts and master pages
  const layouts = new Map<string, XNode>()
  for (const root of [child(stylesRoot, 'automatic-styles'), child(content, 'automatic-styles')]) for (const l of childrenNamed(root, 'page-layout')) layouts.set(attr(l, 'name') ?? '', l)
  const masters = new Map<string, XNode>()
  for (const m of childrenNamed(child(stylesRoot, 'master-styles'), 'master-page')) masters.set(attr(m, 'name') ?? '', m)
  const firstMaster = [...masters.values()][0]

  const tables = childrenNamed(spreadsheet, 'table')
  const pages: Page[] = []
  let warnedCf = false
  for (let ti = 0; ti < tables.length; ti++) {
    throwIfCancelled(env)
    const table = tables[ti]
    const name = attr(table, 'name') ?? `Sheet${ti + 1}`
    env.progress(ti / tables.length, `Converting sheet ${name}`)
    if (attr(table, 'display') === 'false') {
      env.warnings.add(`Hidden sheet “${name}” was not printed.`)
      continue
    }
    if (attr(table, 'print') === 'false') continue
    const sheet = newSheet(name, env.page)
    sheet.defaultRowHeight = 12.8
    sheet.defaultColWidth = 64
    sheet.defaultFont = { ...DEFAULT_FONT, family: 'Liberation Sans', size: 10 }
    // right-to-left sheet: the table style's writing mode (LibreOffice writes style:writing-mode="rl-tb")
    const wm = book.props('table', attr(table, 'style-name'))['table-properties']?.['writing-mode']
    sheet.rtl = !!wm && wm.startsWith('rl')

    // columns
    const colStyles: (string | undefined)[] = []
    let ci = 0
    const walkCols = (n: XNode, header: boolean): void => {
      for (const c of n.children) {
        if (c.name === 'table-column') {
          const rep = Math.min(numAttr(c, 'number-columns-repeated') ?? 1, MAX_COLS - ci)
          const st = attr(c, 'style-name')
          const w = parseLength(book.props('table-column', st)['table-column-properties']?.['column-width'])
          const vis = attr(c, 'visibility')
          for (let k = 0; k < rep; k++) {
            if (w !== undefined) sheet.colWidths.set(ci, w)
            if (vis === 'collapse' || vis === 'filter') sheet.hiddenCols.add(ci)
            colStyles[ci] = attr(c, 'default-cell-style-name')
            ci++
          }
        } else if (['table-columns', 'table-header-columns', 'table-column-group'].includes(c.name)) walkCols(c, header || c.name === 'table-header-columns')
      }
    }
    walkCols(table, false)

    // rows
    let r = 0
    let count = 0
    let stopped = false
    let titleFirst = -1
    let titleLast = -1
    const styleCache = new Map<string, CellStyle>()
    const styleFor = (n: string | undefined): CellStyle => {
      const k = n ?? ''
      let s = styleCache.get(k)
      if (!s) styleCache.set(k, (s = cellStyleOf(book, n)))
      return s
    }
    const visual = (s: CellStyle): boolean => !!(s.fill || s.borders.left || s.borders.right || s.borders.top || s.borders.bottom)
    const cellsToGrid: { r: number; c: number; cell: SheetCell }[] = []

    const processRow = (row: XNode, header: boolean): void => {
      const rep = numAttr(row, 'number-rows-repeated') ?? 1
      const rprops = book.props('table-row', attr(row, 'style-name'))['table-row-properties'] ?? {}
      const rowDefault = attr(row, 'default-cell-style-name')
      const built: { c: number; cell: SheetCell }[] = []
      let c = 0
      const mergesHere: Range[] = []
      for (const cn of row.children) {
        if (cn.name !== 'table-cell' && cn.name !== 'covered-table-cell') continue
        const crep = numAttr(cn, 'number-columns-repeated') ?? 1
        if (cn.name === 'covered-table-cell') {
          c += crep
          continue
        }
        const sname = attr(cn, 'style-name') ?? rowDefault ?? colStyles[c]
        const style = styleFor(sname)
        const vt = attr(cn, 'value-type')
        const tx = cellText(cn)
        let text = tx.text
        let kind: SheetCell['kind'] = 'empty'
        if (vt === 'float' || vt === 'percentage' || vt === 'currency') {
          kind = 'number'
          if (!text) text = generalText(numAttr(cn, 'value') ?? 0)
        } else if (vt === 'date' || vt === 'time') {
          kind = 'number'
          if (!text) text = attr(cn, 'date-value') ?? attr(cn, 'time-value') ?? ''
        } else if (vt === 'boolean') {
          kind = 'bool'
          if (!text) text = attr(cn, 'boolean-value') === 'true' ? 'TRUE' : 'FALSE'
        } else if (vt === 'string' || text) {
          kind = text ? 'text' : 'empty'
          if (!text) text = attr(cn, 'string-value') ?? ''
          if (text) kind = 'text'
        }
        const cspan = numAttr(cn, 'number-columns-spanned') ?? 1
        const rspan = numAttr(cn, 'number-rows-spanned') ?? 1
        if (cspan > 1 || rspan > 1) mergesHere.push({ r1: r, c1: c, r2: r + rspan - 1, c2: c + cspan - 1 })
        const hasContent = kind !== 'empty' || !!text
        if (hasContent || visual(style)) {
          const cell: SheetCell = { text, kind, style, link: tx.link }
          const copies = hasContent ? Math.min(crep, MAX_REPEAT_CELLS) : Math.min(crep, 1024)
          for (let k = 0; k < copies && c + k < MAX_COLS * 4; k++) built.push({ c: c + k, cell })
        }
        c += crep
      }
      if (built.length || mergesHere.length) {
        const copies = Math.min(rep, MAX_REPEAT_ROWS)
        for (let k = 0; k < copies; k++) {
          for (const b of built) {
            cellsToGrid.push({ r: r + k, c: b.c, cell: b.cell })
            if (++count > MAX_CELLS) {
              stopped = true
              return
            }
          }
        }
        for (const m of mergesHere) sheet.merges.push(m)
      }
      const h = parseLength(rprops['row-height'])
      const vis = attr(row, 'visibility')
      for (let k = 0; k < Math.min(rep, MAX_REPEAT_ROWS); k++) {
        if (h !== undefined && rprops['use-optimal-row-height'] !== 'true') sheet.rowHeights.set(r + k, h)
        if (vis === 'collapse' || vis === 'filter') sheet.hiddenRows.add(r + k)
      }
      if (header) {
        if (titleFirst < 0) titleFirst = r
        titleLast = r + rep - 1
      }
      r += rep
    }
    const walkRows = (n: XNode, header: boolean): void => {
      for (const c of n.children) {
        if (stopped) return
        if (c.name === 'table-row') processRow(c, header)
        else if (['table-rows', 'table-header-rows', 'table-row-group'].includes(c.name)) walkRows(c, header || c.name === 'table-header-rows')
      }
    }
    walkRows(table, false)
    for (const g of cellsToGrid) setCell(sheet, g.r, g.c, g.cell)
    if (stopped) env.warnings.add(`Sheet “${name}” has more than ${MAX_CELLS.toLocaleString('en-US')} cells; only the first ${r.toLocaleString('en-US')} rows were rendered.`)
    if (titleFirst >= 0) sheet.print.titleRows = [titleFirst, titleLast]

    // hyperlinks in cells are handled through cellText; pictures:
    readFrames(pkg, table, sheet, env)
    if (descendants(table, 'conditional-formats').length && !warnedCf) {
      warnedCf = true
      env.warnings.add('Conditional formatting rules are not applied.')
    }
    if (descendants(table, 'annotation').length) env.warnings.add('Cell comments are not printed.')

    // print ranges
    const pr = attr(table, 'print-ranges')
    if (pr) {
      const rs = pr.split(/\s+/).map(addressToRange).filter((x): x is Range => !!x)
      if (rs.length) sheet.print.areas = rs
    }

    // page setup from the master page named by the table style
    const tstyle = book.get('table', attr(table, 'style-name'))
    const master = (tstyle?.masterPage ? masters.get(tstyle.masterPage) : undefined) ?? firstMaster
    const layout = master ? layouts.get(attr(master, 'page-layout-name') ?? '') : undefined
    const lp = layout ? Object.fromEntries(Object.entries(layout.children.find((c) => c.name === 'page-layout-properties')?.attrs ?? {}).map(([k, v]) => [local(k), v])) : {}
    const pw = parseLength(lp['page-width'])
    const ph = parseLength(lp['page-height'])
    const p = sheet.print
    if (pw && ph) p.paper = lp['print-orientation'] === 'landscape' ? { w: Math.max(pw, ph), h: Math.min(pw, ph) } : { w: pw, h: ph }
    const m = (k: string, d: number): number => parseLength(lp[k]) ?? d
    const hdr = master ? odfHeaderFooter(child(master, 'header'), child(master, 'header-left')) : undefined
    const ftr = master ? odfHeaderFooter(child(master, 'footer'), child(master, 'footer-left')) : undefined
    const hfProps = (which: 'header-style' | 'footer-style'): { height: number; gap: number } => {
      const hp = child(child(layout, which), 'header-footer-properties')
      return { height: parseLength(attr(hp, 'min-height')) ?? parseLength(attr(hp, 'height')) ?? 14, gap: parseLength(attr(hp, 'margin-bottom')) ?? parseLength(attr(hp, 'margin-top')) ?? 5 }
    }
    const top = m('margin-top', 54)
    const bottom = m('margin-bottom', 54)
    p.margins = {
      left: m('margin-left', 50),
      right: m('margin-right', 50),
      top: hdr ? top + hfProps('header-style').height + hfProps('header-style').gap : top,
      bottom: ftr ? bottom + hfProps('footer-style').height + hfProps('footer-style').gap : bottom,
      header: top,
      footer: bottom
    }
    p.header = hdr
    p.footer = ftr
    p.gridLines = (lp['print'] ?? '').split(/\s+/).includes('grid')
    const tc = lp['table-centering']
    p.hCenter = tc === 'horizontal' || tc === 'both'
    p.vCenter = tc === 'vertical' || tc === 'both'
    if (lp['print-page-order'] === 'ltr') p.pageOrder = 'over'
    const scaleTo = parseFloat(lp['scale-to'] ?? '')
    if (scaleTo > 0) p.scale = scaleTo / 100
    const sx = parseInt(lp['scale-to-x'] ?? lp['scale-to-pages'] ?? '', 10)
    const sy = parseInt(lp['scale-to-y'] ?? lp['scale-to-pages'] ?? '', 10)
    if (sx > 0 || sy > 0) p.fit = { w: sx > 0 ? sx : 0, h: sy > 0 ? sy : lp['scale-to-pages'] ? sx : 0 }

    pages.push(...layoutSheet(sheet, env))
    env.progress((ti + 1) / tables.length)
  }
  if (pages.length === 0) env.warnings.add('The spreadsheet has no printable content.')
  return pages
}

/** Pictures anchored on a sheet (`table:shapes` or inside cells). Charts and shapes get a placeholder. */
function readFrames(pkg: Pkg, table: XNode, sheet: ReturnType<typeof newSheet>, env: ConvertEnv): void {
  for (const frame of descendants(table, 'frame')) {
    const x = parseLength(attr(frame, 'x')) ?? 0
    const y = parseLength(attr(frame, 'y')) ?? 0
    const w = parseLength(attr(frame, 'width')) ?? 0
    const h = parseLength(attr(frame, 'height')) ?? 0
    if (w <= 0 || h <= 0) continue
    const img = child(frame, 'image')
    const item: import('./sheet').SheetImage = { from: { col: 0, row: 0, dx: x, dy: y }, w, h, abs: true }
    if (img) {
      const href = attr(img, 'href')
      const data = href ? pkg.bytes(href.replace(/^\.\//, '')) : undefined
      const fmt = data ? imageFormat(data) : 'unknown'
      if (data && (fmt === 'png' || fmt === 'jpeg')) item.image = { bytes: data, format: fmt }
      else {
        item.label = `Picture (${fmt === 'unknown' ? 'unsupported format' : fmt.toUpperCase()})`
        env.warnings.add('A picture format is not supported by the built-in engine; a placeholder box is drawn instead.')
      }
    } else if (child(frame, 'object') || child(frame, 'object-ole')) {
      item.label = 'Chart / embedded object'
      env.warnings.add('Charts and embedded objects are not rendered by the built-in engine; a placeholder box marks their position.')
    } else {
      item.label = textContent(frame).trim().slice(0, 60) || 'Object'
      env.warnings.add('Text boxes and drawing shapes are not rendered by the built-in engine; a placeholder box marks their position.')
    }
    sheet.images.push(item)
  }
  for (const shape of [...descendants(table, 'custom-shape'), ...descendants(table, 'rect'), ...descendants(table, 'ellipse'), ...descendants(table, 'line')]) {
    const w = parseLength(attr(shape, 'width')) ?? 0
    const h = parseLength(attr(shape, 'height')) ?? 0
    if (w <= 0 || h <= 0) continue
    sheet.images.push({ from: { col: 0, row: 0, dx: parseLength(attr(shape, 'x')) ?? 0, dy: parseLength(attr(shape, 'y')) ?? 0 }, w, h, abs: true, label: textContent(shape).trim().slice(0, 60) || 'Shape' })
    env.warnings.add('Text boxes and drawing shapes are not rendered by the built-in engine; a placeholder box marks their position.')
  }
}
