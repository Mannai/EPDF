import { OfficeError, PAGE_A4, throwIfCancelled, type ConvertEnv } from './env'
import type { BorderSpec, Block, Cell, FlowDocument, FloatSpec, HeaderFooterSet, Inline, PageSetup, ParaProps, Paragraph, Row, Section, Table, TabStop, TextStyle } from './flow'
import { DEFAULT_PARA_PROPS } from './flow'
import { formatOdfNumber, parseBorder, parseColor, parseLength, StyleRegistry, type OdfBorder } from './odtStyles'
import type { ImageData } from './ops'
import { imageFormat, openPackage, type Pkg } from './package'
import { attr, child, childrenNamed, textContent, type XNode } from './xml'

/**
 * OpenDocument text (.odt) reader: content.xml + styles.xml -> FlowDocument. Styles are resolved here (parent
 * chains, family defaults, automatic styles); the layout engine only sees final values. Covers paragraphs and
 * headings, character formatting, lists (bullets/numbers, nested), tables (spans, borders, shading, header
 * rows), images and text boxes, hyperlinks, footnotes (moved to the end), master pages with headers/footers
 * (first/left variants), page layout and columns, and sections.
 */

const MAX_DEPTH = 200

const DEFAULT_STYLE: TextStyle = { family: 'Liberation Serif', size: 12, bold: false, italic: false, underline: false, strike: false, color: '#000000' }

interface ListLevelDef {
  kind: 'number' | 'bullet' | 'image'
  format?: string
  prefix: string
  suffix: string
  start: number
  display: number
  bullet: string
  left: number | undefined
  indent: number | undefined
  textProps?: Record<string, string>
}

interface ListState {
  styleName: string | undefined
  counters: (number | undefined)[]
  /** Set when a `text:list-item` has produced its number and later paragraphs must only be indented. */
  level: number
}

interface Sect {
  master: string | undefined
  blocks: Block[]
  columns?: { count: number; gap: number }
  type: 'nextPage' | 'continuous'
}

interface MasterInfo {
  page: PageSetup
  header?: HeaderFooterSet
  footer?: HeaderFooterSet
  titlePg: boolean
  evenAndOdd: boolean
  columns?: { count: number; gap: number }
}

const BULLET_PUA = /[-]/

export async function readOdt(bytes: Uint8Array, env: ConvertEnv): Promise<FlowDocument> {
  const pkg = openPackage(bytes, 'OpenDocument text file')
  const mime = pkg.text('mimetype')?.trim()
  if (mime && !mime.includes('opendocument.text')) {
    throw new OfficeError(`This file is an OpenDocument file of another kind (${mime.replace(/^application\/vnd\.oasis\.opendocument\./, '')}), not a text document.`)
  }
  const contentRoot = pkg.xml('content.xml')?.children.find((c) => c.name === 'document-content')
  if (!contentRoot) throw new OfficeError('This is not a valid OpenDocument text file (content.xml is missing).')
  const stylesRoot = pkg.xml('styles.xml')?.children.find((c) => c.name === 'document-styles')
  const reader = new OdtReader(pkg, env, contentRoot, stylesRoot)
  const doc = reader.run()
  const title = child(pkg.xml('meta.xml')?.children.find((c) => c.name === 'document-meta'), 'meta')
  const t = title ? textContent(child(title, 'title') ?? title).trim() : ''
  if (t && child(title, 'title')) doc.title = t
  return doc
}

class OdtReader {
  private reg: StyleRegistry
  private readonly contentReg: StyleRegistry
  private readonly stylesReg: StyleRegistry
  private sections: Sect[] = []
  private out: Block[] = []
  private lists: ListState[] = []
  private counterMemory = new Map<string, (number | undefined)[]>()
  private footnotes: Block[][] = []
  private noteCounter = 0
  private breakNext = false
  private masters = new Map<string, MasterInfo>()
  private headingCounters: number[] = []
  private contentWidth: number
  private pendingBlocks: Block[] = []
  private warned = new Set<string>()
  private depthWarned = false

  constructor(
    private readonly pkg: Pkg,
    private readonly env: ConvertEnv,
    private readonly contentRoot: XNode,
    stylesRoot: XNode | undefined
  ) {
    this.contentReg = new StyleRegistry([contentRoot, stylesRoot])
    this.stylesReg = new StyleRegistry([stylesRoot, contentRoot])
    this.reg = this.contentReg
    this.contentWidth = 451
  }

  private warn(msg: string): void {
    this.env.warnings.add(msg)
  }
  private warnOnce(msg: string): void {
    if (!this.warned.has(msg)) {
      this.warned.add(msg)
      this.env.warnings.add(msg)
    }
  }

  // ---- driver ----
  run(): FlowDocument {
    const office = child(this.contentRoot, 'body')
    const text = child(office, 'text')
    if (!text) throw new OfficeError('This OpenDocument file has no text content.')
    const firstMaster = this.stylesReg.masters[0]?.attrs['style:name']
    this.sections.push({ master: firstMaster, blocks: this.out, type: 'nextPage' })
    const initial = this.masterInfo(firstMaster)
    this.contentWidth = initial.page.width - initial.page.margins.left - initial.page.margins.right
    this.children(text)
    this.flushPending()
    // footnotes and endnotes
    if (this.footnotes.length) {
      this.warn('Footnotes and endnotes are moved to the end of the document.')
      const base: TextStyle = { ...DEFAULT_STYLE, size: 9 }
      const last = this.sections[this.sections.length - 1]
      last.blocks.push({ k: 'p', props: { ...DEFAULT_PARA_PROPS, spaceBefore: 12, borders: { top: { color: '#000000', width: 0.5, style: 'single' } } }, inlines: [], markStyle: base })
      for (const b of this.footnotes) last.blocks.push(...b)
    }
    const sections: Section[] = []
    const nonEmpty = this.sections.filter((s, i) => s.blocks.length > 0 || (i === 0 && this.sections.length === 1))
    const list = nonEmpty.length ? nonEmpty : [this.sections[0]]
    for (const s of list) {
      const mi = this.masterInfo(s.master)
      const sec: Section = {
        page: mi.page,
        type: s.type,
        blocks: s.blocks.length ? s.blocks : [this.emptyPara()],
        header: mi.header,
        footer: mi.footer,
        titlePg: mi.titlePg || undefined,
        evenAndOdd: mi.evenAndOdd || undefined
      }
      const cols = s.columns ?? mi.columns
      if (cols && cols.count > 1) sec.columns = cols
      sections.push(sec)
    }
    if (sections.length) sections[0].type = 'nextPage'
    return { sections, defaultTabStop: 36 }
  }

  private emptyPara(): Paragraph {
    return { k: 'p', props: { ...DEFAULT_PARA_PROPS }, inlines: [], markStyle: DEFAULT_STYLE }
  }

  // ---- master pages ----
  private masterInfo(name: string | undefined): MasterInfo {
    const key = name ?? ''
    const hit = this.masters.get(key)
    if (hit) return hit
    const masters = this.stylesReg.masters
    const el = masters.find((m) => m.attrs['style:name'] === name) ?? masters[0]
    const info = this.buildMaster(el)
    this.masters.set(key, info)
    return info
  }

  private buildMaster(el: XNode | undefined): MasterInfo {
    const reg = this.stylesReg
    const layout = el ? reg.pageLayouts.get(el.attrs['style:page-layout-name'] ?? '') : undefined
    const lp = child(layout, 'page-layout-properties')?.attrs ?? {}
    // paragraphs whose writing mode is "page" (or unset) follow the page layout's direction
    if (lp['style:writing-mode']) this.pageRtl = lp['style:writing-mode'].startsWith('rl')
    const w = parseLength(lp['fo:page-width']) ?? PAGE_A4.width
    const h = parseLength(lp['fo:page-height']) ?? PAGE_A4.height
    const mm = (k: string, dflt: number): number => parseLength(lp[`fo:margin-${k}`]) ?? parseLength(lp['fo:margin']) ?? dflt
    const mTop = mm('top', 56.7)
    const mBottom = mm('bottom', 56.7)
    const mLeft = mm('left', 56.7)
    const mRight = mm('right', 56.7)
    const hdrProps = child(child(layout, 'header-style'), 'header-footer-properties')?.attrs
    const ftrProps = child(child(layout, 'footer-style'), 'header-footer-properties')?.attrs
    const colsEl = child(child(layout, 'page-layout-properties'), 'columns')
    const columns = colsEl && parseInt(colsEl.attrs['fo:column-count'] ?? '1', 10) > 1 ? { count: parseInt(colsEl.attrs['fo:column-count'], 10), gap: parseLength(colsEl.attrs['fo:column-gap']) ?? 36 } : undefined

    const parseHF = (kind: 'header' | 'footer', suffix: '' | '-left' | '-first'): Block[] | undefined => {
      const node = child(el, `${kind}${suffix}`)
      if (!node || node.attrs['style:display'] === 'false') return undefined
      return this.withReg(reg, () => this.headerBlocks(node))
    }
    const hdr = parseHF('header', ''), hdrLeft = parseHF('header', '-left'), hdrFirst = parseHF('header', '-first')
    const ftr = parseHF('footer', ''), ftrLeft = parseHF('footer', '-left'), ftrFirst = parseHF('footer', '-first')

    // A first-page master ("First Page" style) with a different next style: first page uses this master, the rest the next one.
    const nextName = el?.attrs['style:next-style-name']
    const nextEl = nextName && nextName !== el?.attrs['style:name'] ? this.stylesReg.masters.find((m) => m.attrs['style:name'] === nextName) : undefined
    let header: HeaderFooterSet = { default: hdr, even: hdrLeft, first: hdrFirst }
    let footer: HeaderFooterSet = { default: ftr, even: ftrLeft, first: ftrFirst }
    let titlePg = !!(hdrFirst || ftrFirst)
    if (nextEl) {
      const nextInfo = this.masterInfoOf(nextEl)
      header = { default: nextInfo.header?.default, even: nextInfo.header?.even, first: hdr ?? hdrFirst }
      footer = { default: nextInfo.footer?.default, even: nextInfo.footer?.even, first: ftr ?? ftrFirst }
      titlePg = true
    }
    const evenAndOdd = !!(hdrLeft || ftrLeft)
    const hasH = !!(header.default || header.first || header.even)
    const hasF = !!(footer.default || footer.first || footer.even)
    const hMin = parseLength(hdrProps?.['svg:height']) ?? parseLength(hdrProps?.['fo:min-height']) ?? 0
    const hGap = parseLength(hdrProps?.['fo:margin-bottom']) ?? 0
    const fMin = parseLength(ftrProps?.['svg:height']) ?? parseLength(ftrProps?.['fo:min-height']) ?? 0
    const fGap = parseLength(ftrProps?.['fo:margin-top']) ?? 0
    const page: PageSetup = {
      width: w,
      height: h,
      margins: { top: mTop + (hasH ? hMin + hGap : 0), bottom: mBottom + (hasF ? fMin + fGap : 0), left: mLeft, right: mRight, header: mTop, footer: mBottom }
    }
    return {
      page,
      header: hasH ? header : undefined,
      footer: hasF ? footer : undefined,
      titlePg,
      evenAndOdd,
      columns
    }
  }

  private masterInfoOf(el: XNode): MasterInfo {
    const key = el.attrs['style:name'] ?? ''
    const hit = this.masters.get(key)
    if (hit) return hit
    // avoid infinite recursion when styles point at each other
    this.masters.set(key, { page: { width: PAGE_A4.width, height: PAGE_A4.height, margins: { top: 56.7, right: 56.7, bottom: 56.7, left: 56.7, header: 56.7, footer: 56.7 } }, titlePg: false, evenAndOdd: false })
    const next = el.attrs['style:next-style-name']
    const clone: XNode = { ...el, attrs: { ...el.attrs, 'style:next-style-name': next === key ? '' : '' } }
    const info = this.buildMaster(clone)
    this.masters.set(key, info)
    return info
  }

  private withReg<T>(reg: StyleRegistry, fn: () => T): T {
    const saveReg = this.reg
    const saveOut = this.out
    const saveLists = this.lists
    const saveBreak = this.breakNext
    const savePending = this.pendingBlocks
    this.reg = reg
    this.out = []
    this.lists = []
    this.breakNext = false
    this.pendingBlocks = []
    try {
      return fn()
    } finally {
      this.reg = saveReg
      this.out = saveOut
      this.lists = saveLists
      this.breakNext = saveBreak
      this.pendingBlocks = savePending
    }
  }

  private headerBlocks(node: XNode): Block[] {
    const regions = ['region-left', 'region-center', 'region-right'].map((n) => child(node, n))
    if (regions.some(Boolean)) {
      // three-part header: a borderless 3-column table, aligned left / centre / right
      const cells: Cell[] = regions.map((r, i) => {
        const saveOut = this.out
        this.out = []
        if (r) this.children(r)
        const blocks = this.out
        this.out = saveOut
        for (const b of blocks) if (b.k === 'p' && b.props.align === 'left' && i > 0) b.props.align = i === 1 ? 'center' : 'right'
        return { blocks: blocks.length ? blocks : [this.emptyPara()], colSpan: 1, rowSpan: 1, vAlign: 'top' as const }
      })
      const w = this.contentWidth / 3
      const t: Table = { k: 'table', colWidths: [w, w, w], rows: [{ cells, header: false, cantSplit: true }], borders: {}, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: 'left', indent: 0 }
      return [t]
    }
    this.children(node)
    this.flushPending()
    return this.out
  }

  // ---- block level ----
  private children(parent: XNode, depth = 0): void {
    if (depth > MAX_DEPTH) {
      this.tooDeep()
      return
    }
    for (const n of parent.children) this.block(n, depth)
  }

  private tooDeep(): void {
    if (!this.depthWarned) {
      this.depthWarned = true
      this.warn('This file nests content unusually deeply; the deepest content was skipped.')
    }
  }

  private flushPending(): void {
    if (this.pendingBlocks.length) {
      this.out.push(...this.pendingBlocks)
      this.pendingBlocks = []
    }
  }

  private checkMaster(family: string, styleName: string | undefined): void {
    if (this.reg !== this.contentReg) return
    const master = this.reg.inherited(family, styleName, 'master') as string | undefined
    if (!master) return
    const cur = this.sections[this.sections.length - 1]
    if (cur.master === master && (cur.blocks.length === 0 || this.sections.length > 0)) {
      if (cur.blocks.length === 0) return
      // same master as before but a page break is requested by the style
      this.breakNext = true
      return
    }
    if (cur.blocks.length === 0 && this.sections.length === 1) {
      cur.master = master
      const mi = this.masterInfo(master)
      this.contentWidth = mi.page.width - mi.page.margins.left - mi.page.margins.right
      return
    }
    this.startSection('nextPage', master)
  }

  private startSection(type: 'nextPage' | 'continuous', master?: string, columns?: { count: number; gap: number }): void {
    this.flushPending()
    const cur = this.sections[this.sections.length - 1]
    const s: Sect = { master: master ?? cur.master, blocks: [], type, columns }
    this.sections.push(s)
    this.out = s.blocks
    const mi = this.masterInfo(s.master)
    this.contentWidth = mi.page.width - mi.page.margins.left - mi.page.margins.right
  }

  private block(n: XNode, depth: number): void {
    switch (n.name) {
      case 'p':
      case 'h':
        this.paragraphBlock(n, depth)
        break
      case 'list':
        this.list(n, depth)
        break
      case 'numbered-paragraph':
        this.numberedParagraph(n, depth)
        break
      case 'table':
        this.tableBlock(n, depth)
        break
      case 'section': {
        const sp = this.reg.columns('section', attr(n, 'style-name'))
        const cols = sp ? parseInt(sp.attrs['fo:column-count'] ?? '1', 10) : 1
        if (cols > 1 && this.reg === this.contentReg) {
          this.startSection('continuous', undefined, { count: cols, gap: parseLength(sp?.attrs['fo:column-gap']) ?? 36 })
          this.children(n, depth + 1)
          this.startSection('continuous')
        } else this.children(n, depth + 1)
        break
      }
      case 'table-of-content':
      case 'illustration-index':
      case 'table-index':
      case 'object-index':
      case 'user-index':
      case 'alphabetical-index':
      case 'bibliography':
        // the cached index (title + entries) is ordinary text
        for (const c of n.children) {
          if (c.name === 'index-body') this.children(c, depth + 1)
          else this.block(c, depth + 1)
        }
        break
      case 'index-body':
      case 'index-title':
      case 'table-header-rows':
        this.children(n, depth + 1)
        break
      case 'frame':
        this.frameBlock(n)
        break
      case 'soft-page-break':
      case 'tracked-changes':
      case 'sequence-decls':
      case 'variable-decls':
      case 'user-field-decls':
      case 'dde-connection-decls':
      case 'alphabetical-index-auto-mark-file':
      case 'forms':
      case 'index-title-template':
      case 'table-of-content-source':
        break
      case 'annotation':
        this.warnOnce('Comments (annotations) are not shown in the PDF.')
        break
      case 'custom-shape':
      case 'rect':
      case 'ellipse':
      case 'line':
      case 'polygon':
      case 'path':
      case 'g':
      case 'connector':
        this.shapeText(n)
        this.flushPending()
        break
      default:
        // unknown container: keep any text blocks inside it
        if (n.children.length) this.children(n, depth + 1)
    }
  }

  private shapeText(n: XNode): void {
    this.warnOnce('Drawing shapes are not supported; text inside them is kept in the text flow.')
    for (const c of n.children) {
      if (c.name === 'p' || c.name === 'h' || c.name === 'list' || c.name === 'table') {
        const saveOut = this.out
        this.out = []
        this.block(c, 0)
        this.pendingBlocks.push(...this.out)
        this.out = saveOut
      } else if (c.name === 'text-box' || c.name === 'g' || c.name === 'frame') this.shapeText(c)
    }
  }

  private paragraphBlock(n: XNode, depth: number, listInfo?: { marker?: ParaProps['marker']; left?: number; indent?: number }): void {
    const styleName = attr(n, 'style-name')
    this.checkMaster('paragraph', styleName)
    const p = this.paragraph(n, depth, listInfo)
    if (this.breakNext) {
      p.props.pageBreakBefore = true
      this.breakNext = false
    }
    this.out.push(p)
    this.flushPending()
    const props = this.reg.props('paragraph', styleName, 'paragraph')
    if (props['fo:break-after'] === 'page') this.breakNext = true
  }

  private paragraph(n: XNode, depth: number, listInfo?: { marker?: ParaProps['marker']; left?: number; indent?: number }): Paragraph {
    const styleName = attr(n, 'style-name')
    const heading = n.name === 'h'
    const level = heading ? Math.max(1, parseInt(attr(n, 'outline-level') ?? '1', 10) || 1) : 0
    const base = this.paraTextStyle(styleName)
    const props = this.paraProps(styleName, base)
    if (listInfo) {
      if (listInfo.left !== undefined) props.indentLeft = listInfo.left
      if (listInfo.indent !== undefined) props.firstLine = listInfo.indent
      if (listInfo.marker) props.marker = listInfo.marker
    } else if (heading) {
      const m = this.headingMarker(level, base)
      if (m) {
        props.marker = m.marker
        if (m.left !== undefined) props.indentLeft = m.left
        if (m.indent !== undefined) props.firstLine = m.indent
      }
    }
    const b = new InlineBuilder()
    this.inlines(n, { style: base, link: undefined }, b, depth + 1)
    if (this.reg.props('paragraph', styleName, 'paragraph')['fo:break-before'] === 'page') props.pageBreakBefore = true
    return { k: 'p', props, inlines: b.finish(), markStyle: base }
  }

  private headingMarker(level: number, base: TextStyle): { marker: ParaProps['marker']; left?: number; indent?: number } | null {
    const outline = this.reg.outlineStyle
    const lv = outline?.children.find((c) => c.name === 'outline-level-style' && parseInt(c.attrs['text:level'] ?? '0', 10) === level)
    if (!lv || !lv.attrs['style:num-format']) return null
    const fmt = lv.attrs['style:num-format']
    const counters = this.headingCounters
    counters[level - 1] = (counters[level - 1] ?? (parseInt(lv.attrs['text:start-value'] ?? '1', 10) - 1)) + 1
    for (let i = level; i < counters.length; i++) counters[i] = 0
    const display = Math.max(1, parseInt(lv.attrs['text:display-levels'] ?? '1', 10) || 1)
    const parts: string[] = []
    for (let l = Math.max(1, level - display + 1); l <= level; l++) {
      const d = outline?.children.find((c) => c.name === 'outline-level-style' && parseInt(c.attrs['text:level'] ?? '0', 10) === l)
      parts.push(formatOdfNumber(counters[l - 1] || 1, d?.attrs['style:num-format'] ?? fmt))
    }
    const text = `${lv.attrs['style:num-prefix'] ?? ''}${parts.join('.')}${lv.attrs['style:num-suffix'] ?? ''}`
    const lp = child(lv, 'list-level-properties')
    const la = child(lp, 'list-level-label-alignment')
    const left = la ? parseLength(la.attrs['fo:margin-left']) : undefined
    const indent = la ? parseLength(la.attrs['fo:text-indent']) : undefined
    return { marker: { text: text, style: { ...base, underline: false, strike: false } }, left, indent }
  }

  private numberedParagraph(n: XNode, depth: number): void {
    const listStyle = attr(n, 'style-name')
    const level = Math.max(1, parseInt(attr(n, 'level') ?? '1', 10) || 1)
    const state = this.lists[this.lists.length - 1] ?? { styleName: listStyle, counters: [], level }
    const item = this.listItemInfo(listStyle, level, state, attr(n, 'start-value'))
    for (const c of n.children) {
      if (c.name === 'number') continue
      if (c.name === 'p' || c.name === 'h') this.paragraphBlock(c, depth + 1, item)
      else this.block(c, depth + 1)
    }
  }

  // ---- lists ----
  private levelDef(listStyleName: string | undefined, level: number): ListLevelDef | undefined {
    const ls = this.reg.listStyle(listStyleName)
    if (!ls) return undefined
    const lv = ls.children.find((c) => /^list-level-style-(number|bullet|image)$/.test(c.name) && parseInt(c.attrs['text:level'] ?? '0', 10) === level)
    if (!lv) return undefined
    const lp = child(lv, 'list-level-properties')
    const la = child(lp, 'list-level-label-alignment')
    let left: number | undefined
    let indent: number | undefined
    if (la) {
      left = parseLength(la.attrs['fo:margin-left'])
      indent = parseLength(la.attrs['fo:text-indent'])
    } else if (lp) {
      const sb = parseLength(lp.attrs['text:space-before']) ?? 0
      const mw = parseLength(lp.attrs['text:min-label-width']) ?? 0
      left = sb + mw
      indent = -mw
    }
    const tp = child(lv, 'text-properties')?.attrs
    return {
      kind: lv.name.endsWith('number') ? 'number' : lv.name.endsWith('bullet') ? 'bullet' : 'image',
      format: lv.attrs['style:num-format'],
      prefix: lv.attrs['style:num-prefix'] ?? '',
      suffix: lv.attrs['style:num-suffix'] ?? '',
      start: parseInt(lv.attrs['text:start-value'] ?? '1', 10) || 1,
      display: Math.max(1, parseInt(lv.attrs['text:display-levels'] ?? '1', 10) || 1),
      bullet: lv.attrs['text:bullet-char'] ?? '•',
      left,
      indent,
      textProps: tp
    }
  }

  private listItemInfo(styleName: string | undefined, level: number, state: ListState, startValue: string | undefined): { marker?: ParaProps['marker']; left?: number; indent?: number } {
    const def = this.levelDef(styleName, level)
    if (!def) return { marker: { text: '•', style: { ...DEFAULT_STYLE, underline: false } } }
    const counters = state.counters
    if (def.kind === 'number') {
      const start = startValue ? parseInt(startValue, 10) : undefined
      counters[level] = start !== undefined && Number.isFinite(start) ? start : counters[level] === undefined ? def.start : (counters[level] as number) + 1
      for (let l = level + 1; l < counters.length; l++) counters[l] = undefined
    } else {
      counters[level] = (counters[level] ?? 0) + 1
      for (let l = level + 1; l < counters.length; l++) counters[l] = undefined
    }
    let text: string
    if (def.kind === 'number') {
      const parts: string[] = []
      for (let l = Math.max(1, level - def.display + 1); l <= level; l++) {
        const d = l === level ? def : this.levelDef(styleName, l)
        parts.push(formatOdfNumber((counters[l] ?? d?.start ?? 1) as number, d?.format ?? def.format))
      }
      text = `${def.prefix}${parts.join('.')}${def.suffix}`
    } else {
      const ch = def.kind === 'image' ? '•' : def.bullet
      text = BULLET_PUA.test(ch) || !ch ? '•' : ch
    }
    const style: TextStyle = { ...this.currentBase, underline: false, strike: false, highlight: undefined }
    if (def.textProps) Object.assign(style, this.applyText(style, def.textProps))
    return { marker: text ? { text, style } : undefined, left: def.left, indent: def.indent }
  }

  private currentBase: TextStyle = DEFAULT_STYLE
  /** Writing direction of the page layout (for paragraphs with writing mode "page"). */
  private pageRtl = false

  private list(n: XNode, depth: number): void {
    if (depth > MAX_DEPTH) return this.tooDeep()
    const styleName = attr(n, 'style-name') ?? this.lists[this.lists.length - 1]?.styleName
    const level = this.lists.length + 1
    let counters: (number | undefined)[]
    const cont = attr(n, 'continue-numbering') === 'true'
    if (this.lists.length > 0) counters = this.lists[this.lists.length - 1].counters
    else if (cont && styleName && this.counterMemory.has(styleName)) counters = this.counterMemory.get(styleName)!
    else counters = []
    if (this.lists.length === 0 && styleName) this.counterMemory.set(styleName, counters)
    if (this.lists.length > 0) for (let l = level; l < counters.length; l++) counters[l] = undefined
    const state: ListState = { styleName, counters, level }
    this.lists.push(state)
    try {
      for (const item of n.children) {
        if (item.name !== 'list-item' && item.name !== 'list-header') continue
        const first = { done: false }
        const info = item.name === 'list-header' ? undefined : this.listItemInfo(styleName, level, state, attr(item, 'start-value'))
        for (const c of item.children) {
          if (c.name === 'p' || c.name === 'h') {
            // only the first paragraph of an item shows the number; others keep the indent
            const li = first.done ? { left: info?.left, indent: info?.left !== undefined ? 0 : undefined } : (info ?? { left: this.levelDef(styleName, level)?.left })
            first.done = true
            this.paragraphBlock(c, depth + 1, li)
          } else if (c.name === 'list') this.list(c, depth + 1)
          else this.block(c, depth + 1)
        }
      }
    } finally {
      this.lists.pop()
    }
  }

  // ---- paragraph formatting ----
  private paraTextStyle(styleName: string | undefined): TextStyle {
    // apply the chain step by step: relative sizes (130%) refer to the parent style's size
    let st = DEFAULT_STYLE
    for (const props of this.reg.propList('paragraph', styleName, 'text')) st = this.applyText(st, props)
    this.currentBase = st
    return st
  }

  /** A character (text-family) style applied over the surrounding text style. */
  private charStyle(base: TextStyle, styleName: string | undefined): TextStyle {
    if (!styleName) return base
    let st = base
    for (const props of this.reg.propList('text', styleName, 'text')) st = this.applyText(st, props)
    return st
  }

  private applyText(base: TextStyle, p: Record<string, string>): TextStyle {
    const s: TextStyle = { ...base }
    const fam = this.reg.fontFamily(p['style:font-name'], p['fo:font-family'])
    if (fam) s.family = fam
    const fs = p['fo:font-size']
    if (fs) {
      const v = parseLength(fs, base.size)
      if (v && v > 0) s.size = v
    }
    const fw = p['fo:font-weight']
    if (fw) s.bold = fw === 'bold' || (/^\d+$/.test(fw) && parseInt(fw, 10) >= 600)
    const fst = p['fo:font-style']
    if (fst) s.italic = fst === 'italic' || fst === 'oblique'
    const ul = p['style:text-underline-style']
    if (ul !== undefined) s.underline = ul !== 'none'
    const st = p['style:text-line-through-style']
    if (st !== undefined) s.strike = st !== 'none'
    const col = parseColor(p['fo:color'])
    if (col) s.color = col
    const bg = p['fo:background-color']
    if (bg !== undefined) s.highlight = bg === 'transparent' ? undefined : parseColor(bg)
    const pos = p['style:text-position']
    if (pos !== undefined) {
      const first = pos.trim().split(/\s+/)[0]
      s.vertAlign = first === 'super' ? 'super' : first === 'sub' ? 'sub' : parseFloat(first) > 0 ? 'super' : parseFloat(first) < 0 ? 'sub' : undefined
    }
    const tt = p['fo:text-transform']
    if (tt !== undefined) s.caps = tt === 'uppercase' || undefined
    const fv = p['fo:font-variant']
    if (fv !== undefined) s.smallCaps = fv === 'small-caps' || undefined
    const ls = parseLength(p['fo:letter-spacing'])
    if (ls) s.spacing = ls
    // complex-script (Arabic, Hebrew...) font, size, weight and posture
    const cfam = this.reg.fontFamily(p['style:font-name-complex'], p['style:font-family-complex'])
    const cfs = p['style:font-size-complex']
    const cfw = p['style:font-weight-complex']
    const cst = p['style:font-style-complex']
    if (cfam || cfs || cfw || cst) {
      const cs = { ...(base.cs ?? {}) }
      if (cfam) cs.family = cfam
      if (cfs) {
        const v = parseLength(cfs, base.cs?.size ?? base.size)
        if (v && v > 0) cs.size = v
      }
      if (cfw) cs.bold = cfw === 'bold' || (/^\d+$/.test(cfw) && parseInt(cfw, 10) >= 600)
      if (cst) cs.italic = cst === 'italic' || cst === 'oblique'
      s.cs = cs
    }
    return s
  }

  private paraProps(styleName: string | undefined, base: TextStyle): ParaProps {
    const p = this.reg.props('paragraph', styleName, 'paragraph')
    const W = this.contentWidth
    const wm = p['style:writing-mode'] ?? 'page'
    const rtl = wm === 'page' || wm === 'inherit' ? this.pageRtl : wm.startsWith('rl')
    // ParaProps alignment is logical ('left' = start). ODF start/end are logical; left/right are physical.
    const ta = p['fo:text-align']
    const align: ParaProps['align'] =
      ta === 'center' ? 'center' : ta === 'justify' ? 'justify' : ta === 'end' ? 'right' : ta === 'right' ? (rtl ? 'left' : 'right') : ta === 'left' ? (rtl ? 'right' : 'left') : 'left'
    const sh = p['fo:margin']
    const side = (k: string): number => parseLength(p[`fo:margin-${k}`], W) ?? parseLength(sh, W) ?? 0
    const props: ParaProps = {
      ...DEFAULT_PARA_PROPS,
      align,
      spaceBefore: Math.max(0, side('top')),
      spaceAfter: Math.max(0, side('bottom')),
      // LibreOffice reads fo:margin-left/right as the start/end indents of a right-to-left paragraph (checked:
      // margin-right does not indent an rl-tb paragraph on the right), so they are used as they are
      indentLeft: side('left'),
      indentRight: side('right'),
      firstLine: parseLength(p['fo:text-indent'], W) ?? 0,
      keepNext: p['fo:keep-with-next'] === 'always',
      keepLines: p['fo:keep-together'] === 'always',
      pageBreakBefore: p['fo:break-before'] === 'page',
      widowControl: !(p['fo:orphans'] === '0' && p['fo:widows'] === '0'),
      rtl: rtl || undefined
    }
    const lh = p['fo:line-height']
    const atLeast = parseLength(p['style:line-height-at-least'])
    if (lh && lh.endsWith('%')) props.line = { rule: 'auto', value: Math.max(0.1, parseFloat(lh) / 100) }
    else if (lh && parseLength(lh) !== undefined && parseLength(lh)! > 0) props.line = { rule: 'exact', value: parseLength(lh)! }
    else if (atLeast) props.line = { rule: 'atLeast', value: atLeast }
    const bgc = p['fo:background-color']
    if (bgc && bgc !== 'transparent') props.shading = parseColor(bgc)
    const bd = (k: string): BorderSpec | undefined => {
      const b = parseBorder(p[`fo:border-${k}`] ?? p['fo:border'])
      return b ? borderSpec(b) : undefined
    }
    const borders = { top: bd('top'), bottom: bd('bottom'), left: bd('left'), right: bd('right') }
    if (borders.top || borders.bottom || borders.left || borders.right) props.borders = borders
    const stops = this.reg.tabStops('paragraph', styleName)
    if (stops?.length) {
      props.tabs = stops
        .map((t): TabStop | null => {
          const pos = parseLength(t.attrs['style:position'], W)
          if (pos === undefined) return null
          const type = t.attrs['style:type']
          const lt = t.attrs['style:leader-text'] ?? ((t.attrs['style:leader-style'] ?? 'none') !== 'none' ? '.' : '')
          return { pos, align: type === 'center' ? 'center' : type === 'right' ? 'right' : type === 'char' ? 'decimal' : 'left', leader: lt === '.' ? 'dot' : lt === '-' ? 'hyphen' : lt === '_' ? 'underscore' : lt === '·' ? 'middleDot' : undefined }
        })
        .filter((t): t is TabStop => !!t)
    }
    void base
    return props
  }

  // ---- inline content ----
  private inlines(node: XNode, ctx: { style: TextStyle; link: string | undefined }, b: InlineBuilder, depth: number): void {
    if (depth > MAX_DEPTH) {
      this.tooDeep()
      b.text(textContent(node), ctx.style, ctx.link)
      return
    }
    for (const n of node.nodes) {
      if (typeof n === 'string') {
        b.text(n, ctx.style, ctx.link)
        continue
      }
      switch (n.name) {
        case 'span': {
          const name = attr(n, 'style-name')
          if (this.reg.props('text', name, 'text')['text:display'] === 'none') break
          this.inlines(n, { style: this.charStyle(ctx.style, name), link: ctx.link }, b, depth + 1)
          break
        }
        case 'a': {
          const href = attr(n, 'href')
          const link = href && /^(https?:\/\/|mailto:)/i.test(href) ? href : ctx.link
          this.inlines(n, { style: this.charStyle(ctx.style, attr(n, 'style-name')), link }, b, depth + 1)
          break
        }
        case 's': {
          const c = Math.min(1000, Math.max(1, parseInt(attr(n, 'c') ?? '1', 10) || 1))
          b.exact(' '.repeat(c), ctx.style, ctx.link)
          break
        }
        case 'tab':
          b.push({ k: 'tab', style: ctx.style })
          b.lastSpace = true
          break
        case 'line-break':
          b.push({ k: 'br', type: 'line', style: ctx.style })
          b.lastSpace = true
          break
        case 'page-number':
          b.push({ k: 'field', field: 'page', style: ctx.style })
          break
        case 'page-count':
          b.push({ k: 'field', field: 'pages', style: ctx.style })
          break
        case 'soft-page-break':
        case 'bookmark':
        case 'bookmark-start':
        case 'bookmark-end':
        case 'reference-mark':
        case 'reference-mark-start':
        case 'reference-mark-end':
        case 'toc-mark':
        case 'toc-mark-start':
        case 'toc-mark-end':
        case 'alphabetical-index-mark':
        case 'alphabetical-index-mark-start':
        case 'alphabetical-index-mark-end':
        case 'user-index-mark':
        case 'change':
        case 'change-start':
        case 'change-end':
        case 'annotation-end':
        case 'note-citation':
          break
        case 'annotation':
          this.warnOnce('Comments (annotations) are not shown in the PDF.')
          break
        case 'note':
          this.note(n, ctx, b, depth)
          break
        case 'frame':
          this.frameInline(n, ctx, b)
          break
        case 'custom-shape':
        case 'rect':
        case 'ellipse':
        case 'line':
        case 'polygon':
        case 'path':
        case 'g':
        case 'connector':
          this.shapeText(n)
          break
        case 'ruby':
          for (const c of n.children) if (c.name === 'ruby-base') this.inlines(c, ctx, b, depth + 1)
          break
        case 'list':
        case 'table':
          break
        default:
          this.inlines(n, ctx, b, depth + 1) // cached field results, meta wrappers, ...
      }
    }
  }

  private note(n: XNode, ctx: { style: TextStyle; link: string | undefined }, b: InlineBuilder, depth: number): void {
    const cite = child(n, 'note-citation')
    const num = ++this.noteCounter
    const label = (cite ? textContent(cite).trim() : '') || String(num)
    b.exact(label, { ...ctx.style, vertAlign: 'super' }, ctx.link)
    const body = child(n, 'note-body')
    if (!body) return
    const saveOut = this.out
    const saveLists = this.lists
    this.out = []
    this.lists = []
    for (const c of body.children) this.block(c, depth + 1)
    const blocks = this.out
    this.out = saveOut
    this.lists = saveLists
    const first = blocks.find((x): x is Paragraph => x.k === 'p')
    const style: TextStyle = { ...(first?.markStyle ?? DEFAULT_STYLE), size: 9, vertAlign: 'super' }
    if (first) first.inlines.unshift({ k: 'text', text: `${label} `, style })
    else blocks.push({ k: 'p', props: { ...DEFAULT_PARA_PROPS }, inlines: [{ k: 'text', text: `${label} `, style }], markStyle: style })
    this.footnotes.push(blocks)
  }

  // ---- frames and images ----
  private frameImage(frame: XNode): { image: ImageData; w: number; h: number; name: string } | { placeholder: string } | null {
    const img = child(frame, 'image')
    const obj = child(frame, 'object') ?? child(frame, 'object-ole')
    if (obj && !img) {
      this.warnOnce('Embedded objects (charts, formulas, OLE) are not supported and were left out.')
      return { placeholder: '[Embedded object not supported]' }
    }
    if (!img) return null
    let data: Uint8Array | undefined
    const href = attr(img, 'href')
    const name = href ? href.replace(/^.*\//, '') : 'image'
    if (href && !/^[a-z]+:/i.test(href)) data = this.pkg.bytes(href.replace(/^\.\//, ''))
    const bin = child(img, 'binary-data')
    if (!data && bin) data = Uint8Array.from(Buffer.from(textContent(bin).replace(/\s+/g, ''), 'base64'))
    if (!data) {
      this.warnOnce('An image could not be found in the file and was left out.')
      return { placeholder: `[Image: ${name} missing]` }
    }
    const fmt = imageFormat(data)
    if (fmt !== 'png' && fmt !== 'jpeg') {
      this.warnOnce(`Images in ${fmt === 'unknown' ? 'an unknown' : fmt.toUpperCase()} format are not supported and were replaced by a placeholder.`)
      return { placeholder: `[Image: ${name} not supported]` }
    }
    const clip = this.reg.props('graphic', attr(frame, 'style-name'), 'graphic')['fo:clip']
    if (clip && /rect\(/.test(clip) && /[1-9]/.test(clip.replace(/0*\.0*|0(cm|mm|in|pt)/g, ''))) this.warnOnce('Cropped images are shown uncropped.')
    const W = this.contentWidth
    let w = parseLength(attr(frame, 'width'), W)
    let h = parseLength(attr(frame, 'height'), W)
    if (!w || !h) {
      const px = imagePixels(data)
      const nw = px ? px.w * 0.75 : 100
      const nh = px ? px.h * 0.75 : 100
      if (!w && !h) {
        w = nw
        h = nh
      } else if (!w) w = ((h as number) * nw) / nh
      else h = (w * nh) / nw
    }
    const k = (w as number) > W ? W / (w as number) : 1
    return { image: { bytes: data, format: fmt }, w: (w as number) * k, h: (h as number) * k, name }
  }

  private frameInline(frame: XNode, ctx: { style: TextStyle; link: string | undefined }, b: InlineBuilder): void {
    const tb = child(frame, 'text-box')
    if (tb) {
      this.warnOnce('Text boxes are placed inline in the text flow.')
      const saveOut = this.out
      const saveLists = this.lists
      this.out = []
      this.lists = []
      for (const c of tb.children) this.block(c, 0)
      this.pendingBlocks.push(...this.out)
      this.out = saveOut
      this.lists = saveLists
      return
    }
    const fi = this.frameImage(frame)
    if (!fi) return
    if ('placeholder' in fi) {
      b.exact(fi.placeholder, { ...ctx.style, italic: true }, ctx.link)
      return
    }
    const anchor = attr(frame, 'anchor-type')
    if (anchor === 'as-char' || anchor === undefined) {
      b.push({ k: 'image', image: fi.image, w: fi.w, h: fi.h, style: ctx.style, link: ctx.link })
      return
    }
    b.push({ k: 'float', spec: this.floatSpec(frame, fi) })
  }

  private floatSpec(frame: XNode, fi: { image: ImageData; w: number; h: number }): FloatSpec {
    const g = this.reg.props('graphic', attr(frame, 'style-name'), 'graphic')
    const W = this.contentWidth
    const hp = g['style:horizontal-pos']
    const hr = g['style:horizontal-rel'] ?? ''
    const vp = g['style:vertical-pos']
    const vr = g['style:vertical-rel'] ?? ''
    const wrap = g['style:wrap']
    const runThrough = wrap === 'run-through'
    if (!runThrough) this.warnOnce('Text wrapping around images is approximated: such images take their own band in the text.')
    return {
      image: fi.image,
      w: fi.w,
      h: fi.h,
      hRel: hr.startsWith('page-content') ? 'margin' : hr === 'page' ? 'page' : hr.startsWith('char') ? 'character' : 'column',
      hAlign: hp === 'center' ? 'center' : hp === 'right' || hp === 'outside' ? 'right' : hp === 'left' || hp === 'inside' ? 'left' : undefined,
      hOffset: parseLength(attr(frame, 'x'), W) ?? 0,
      vRel: vr === 'page' ? 'page' : vr === 'page-content' ? 'margin' : vr === 'line' ? 'line' : 'paragraph',
      vAlign: vp === 'middle' ? 'center' : vp === 'bottom' ? 'bottom' : vp === 'top' ? 'top' : undefined,
      vOffset: parseLength(attr(frame, 'y'), W) ?? 0,
      behind: g['style:run-through'] === 'background',
      wrap: runThrough ? 'none' : 'topAndBottom'
    }
  }

  private frameBlock(frame: XNode): void {
    const b = new InlineBuilder()
    this.frameInline(frame, { style: DEFAULT_STYLE, link: undefined }, b)
    const inl = b.finish()
    if (inl.length) this.out.push({ k: 'p', props: { ...DEFAULT_PARA_PROPS }, inlines: inl, markStyle: DEFAULT_STYLE })
    this.flushPending()
  }

  // ---- tables ----
  private tableBlock(n: XNode, depth: number): void {
    const styleName = attr(n, 'style-name')
    this.checkMaster('table', styleName)
    const t = this.table(n, depth)
    if (!t) return
    if (this.breakNext) {
      this.out.push({ k: 'p', props: { ...DEFAULT_PARA_PROPS, pageBreakBefore: true }, inlines: [], markStyle: { ...DEFAULT_STYLE, size: 1 } })
      this.breakNext = false
    }
    this.out.push(t)
    this.flushPending()
  }

  private table(n: XNode, depth: number): Table | null {
    if (depth > MAX_DEPTH) {
      this.tooDeep()
      return null
    }
    const styleName = attr(n, 'style-name')
    const tp = this.reg.props('table', styleName, 'table')
    const W = this.contentWidth
    // columns
    const widths: number[] = []
    const rel: (number | undefined)[] = []
    const collectCols = (parent: XNode): void => {
      for (const c of parent.children) {
        if (c.name === 'table-column') {
          const rep = Math.min(1000, Math.max(1, parseInt(attr(c, 'number-columns-repeated') ?? '1', 10) || 1))
          const cp = this.reg.props('table-column', attr(c, 'style-name'), 'table-column')
          const w = parseLength(cp['style:column-width'])
          const r = cp['style:rel-column-width'] ? parseFloat(cp['style:rel-column-width']) : undefined
          for (let i = 0; i < rep; i++) {
            widths.push(w ?? 0)
            rel.push(r)
          }
        } else if (c.name === 'table-columns' || c.name === 'table-header-columns' || c.name === 'table-column-group') collectCols(c)
      }
    }
    collectCols(n)
    const rows: Row[] = []
    const collectRows = (parent: XNode, header: boolean): void => {
      for (const r of parent.children) {
        if (r.name === 'table-row') rows.push(this.row(r, header, depth))
        else if (r.name === 'table-header-rows') collectRows(r, true)
        else if (r.name === 'table-rows' || r.name === 'table-row-group') collectRows(r, header)
      }
    }
    collectRows(n, false)
    const nCols = Math.max(widths.length, ...rows.map((r) => r.cells.reduce((s, c) => s + c.colSpan, 0)))
    while (widths.length < nCols) widths.push(0)
    // table width
    const tw = parseLength(tp['style:width'], W) ?? (tp['style:rel-width'] ? (parseFloat(tp['style:rel-width']) / 100) * W : undefined)
    const known = widths.reduce((s, w) => s + w, 0)
    if (rel.some((x) => x !== undefined) && known === 0) {
      const total = rel.reduce<number>((s, x) => s + (x ?? 1), 0)
      const target = tw ?? W
      widths.forEach((_, i) => (widths[i] = ((rel[i] ?? 1) / total) * target))
    } else {
      const zero = widths.filter((w) => w === 0).length
      if (zero > 0) {
        const rest = Math.max(20 * zero, (tw ?? W) - known)
        widths.forEach((w, i) => {
          if (w === 0) widths[i] = rest / zero
        })
      }
    }
    if (rows.length === 0) return null
    const al = tp['table:align']
    const ml = parseLength(tp['fo:margin-left'], W) ?? 0
    const cellPad = { top: 2.8, bottom: 2.8, left: 2.8, right: 2.8 }
    if (tp['fo:break-before'] === 'page') this.breakNext = true
    // A right-to-left table (writing mode rl-tb, or "page" on a right-to-left page) has its first column on the right.
    // table:align and the margins are physical in ODF; Table.align/indent are logical for right-to-left tables.
    const twm = tp['style:writing-mode'] ?? 'page'
    const rtl = twm === 'page' || twm === 'inherit' ? this.pageRtl : twm.startsWith('rl')
    const phys: Table['align'] = al === 'center' ? 'center' : al === 'right' ? 'right' : 'left'
    const align: Table['align'] = rtl && phys !== 'center' ? (phys === 'right' ? 'left' : 'right') : phys
    const mr = parseLength(tp['fo:margin-right'], W) ?? 0
    const indent = rtl ? (al === 'margins' || al === 'right' || !al ? mr : 0) : al === 'margins' || al === 'left' || !al ? ml : 0
    return { k: 'table', colWidths: widths, rows, borders: {}, padding: cellPad, align: rtl && (al === 'margins' || !al) ? 'left' : align, indent, rtl: rtl || undefined }
  }

  private row(r: XNode, header: boolean, depth: number): Row {
    const rp = this.reg.props('table-row', attr(r, 'style-name'), 'table-row')
    const cells: Cell[] = []
    for (const c of r.children) {
      if (c.name !== 'table-cell') continue // covered cells are dropped: the spanning cell already covers them
      const rep = Math.min(200, Math.max(1, parseInt(attr(c, 'number-columns-repeated') ?? '1', 10) || 1))
      const cell = this.cell(c, depth)
      cells.push(cell)
      for (let i = 1; i < rep; i++) cells.push({ ...cell, blocks: cell.blocks.map(cloneBlock) })
    }
    const minH = parseLength(rp['style:min-row-height']) ?? parseLength(rp['style:row-height'])
    return { cells, header, cantSplit: rp['style:keep-together'] === 'always' || undefined, height: minH ? { value: minH, rule: 'atLeast' } : undefined } as Row
  }

  private cell(c: XNode, depth: number): Cell {
    const cp = this.reg.props('table-cell', attr(c, 'style-name'), 'table-cell')
    const saveOut = this.out
    const saveLists = this.lists
    const savePending = this.pendingBlocks
    const saveBreak = this.breakNext
    this.out = []
    this.lists = []
    this.pendingBlocks = []
    for (const b of c.children) this.block(b, depth + 1)
    this.flushPending()
    const blocks = this.out.length ? this.out : [this.emptyPara()]
    this.out = saveOut
    this.lists = saveLists
    this.pendingBlocks = savePending
    this.breakNext = saveBreak
    const bd = (k: string): BorderSpec | null | undefined => {
      const b = parseBorder(cp[`fo:border-${k}`] ?? cp['fo:border'])
      return b === undefined ? undefined : b === null ? null : borderSpec(b)
    }
    const cell: Cell = {
      blocks,
      colSpan: Math.max(1, parseInt(attr(c, 'number-columns-spanned') ?? '1', 10) || 1),
      rowSpan: Math.max(1, parseInt(attr(c, 'number-rows-spanned') ?? '1', 10) || 1),
      vAlign: cp['style:vertical-align'] === 'middle' ? 'center' : cp['style:vertical-align'] === 'bottom' ? 'bottom' : 'top'
    }
    const bg = cp['fo:background-color']
    if (bg && bg !== 'transparent') cell.shading = parseColor(bg)
    const borders = { top: bd('top'), bottom: bd('bottom'), left: bd('left'), right: bd('right') }
    if (borders.top !== undefined || borders.bottom !== undefined || borders.left !== undefined || borders.right !== undefined) cell.borders = borders
    const pad = parseLength(cp['fo:padding'])
    const pl = parseLength(cp['fo:padding-left']) ?? pad
    const pr = parseLength(cp['fo:padding-right']) ?? pad
    const pt = parseLength(cp['fo:padding-top']) ?? pad
    const pb = parseLength(cp['fo:padding-bottom']) ?? pad
    if (pl !== undefined || pr !== undefined || pt !== undefined || pb !== undefined) cell.padding = { left: pl ?? 2.8, right: pr ?? 2.8, top: pt ?? 2.8, bottom: pb ?? 2.8 }
    return cell
  }
}

function cloneBlock(b: Block): Block {
  return structuredClone(b)
}

const borderSpec = (b: OdfBorder): BorderSpec => ({ color: b.color, width: b.width, style: b.style })

/** Collects inline content with ODF whitespace rules (runs of white space collapse; leading space is dropped). */
class InlineBuilder {
  private items: Inline[] = []
  lastSpace = true

  text(raw: string, style: TextStyle, link: string | undefined): void {
    let t = raw.replace(/[ \t\r\n]+/g, ' ')
    if (this.lastSpace && t.startsWith(' ')) t = t.slice(1)
    if (!t) return
    this.lastSpace = t.endsWith(' ')
    this.add(t, style, link)
  }

  /** Text that must be kept as written (text:s spaces, labels). */
  exact(t: string, style: TextStyle, link: string | undefined): void {
    if (!t) return
    this.lastSpace = false
    this.add(t, style, link)
  }

  private add(t: string, style: TextStyle, link: string | undefined): void {
    const last = this.items[this.items.length - 1]
    if (last && last.k === 'text' && last.link === link && sameStyle(last.style, style)) last.text += t
    else this.items.push({ k: 'text', text: t, style, link })
  }

  push(i: Inline): void {
    this.items.push(i)
    this.lastSpace = false
  }

  finish(): Inline[] {
    // trailing collapsed space at the end of a paragraph is not significant
    const last = this.items[this.items.length - 1]
    if (last && last.k === 'text' && /\s$/.test(last.text) && this.lastSpace) last.text = last.text.replace(/ +$/, '')
    if (last && last.k === 'text' && last.text === '') this.items.pop()
    return this.items
  }
}

const sameStyle = (a: TextStyle, b: TextStyle): boolean =>
  a === b ||
  (a.family === b.family && a.size === b.size && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.color === b.color && a.highlight === b.highlight && a.vertAlign === b.vertAlign && a.caps === b.caps && a.smallCaps === b.smallCaps && a.spacing === b.spacing)

/** Pixel size of a PNG or JPEG, read from its header. */
function imagePixels(b: Uint8Array): { w: number; h: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: dv.getUint32(16), h: dv.getUint32(20) }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let pos = 2
    while (pos + 9 < b.length) {
      if (b[pos] !== 0xff) {
        pos++
        continue
      }
      const m = b[pos + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: dv.getUint16(pos + 5), w: dv.getUint16(pos + 7) }
      pos += 2 + dv.getUint16(pos + 2)
    }
  }
  return null
}

void throwIfCancelled
void childrenNamed
