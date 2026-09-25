import { bulletCandidates, Numbering } from './docxNumbering'
import {
  chainOf,
  colorOf,
  mergePPr,
  mergeRPr,
  parseBorder,
  parsePPr,
  parseRPr,
  parseTcPr,
  parseTblPr,
  readStyles,
  readTheme,
  toTextStyle,
  twips,
  type PPr,
  type RPr,
  type StyleDef,
  type Styles,
  type TblPrStyle,
  type TcPr
} from './docxStyles'
import { OfficeError, throwIfCancelled, type ConvertEnv } from './env'
import type { Block, BorderSpec, Cell, FlowDocument, HeaderFooterSet, Inline, ParaProps, Paragraph, Row, Section, Table, TabStop, TextStyle } from './flow'
import { DEFAULT_PARA_PROPS, DEFAULT_TEXT_STYLE } from './flow'
import { imageFormat, openPackage, relationshipsOf, resolveTarget, type Pkg, type Relationship } from './package'
import { attr, child, childrenNamed, descendants, numAttr, path, textContent, type XNode } from './xml'

/**
 * Reads a .docx (WordprocessingML) into a FlowDocument: styles (docDefaults, basedOn chains, table styles with
 * conditional formatting), numbering, sections with headers/footers, tables (spans, borders, shading, repeated
 * header rows), inline and floating PNG/JPEG images, hyperlinks, fields, footnotes. Anything it cannot reproduce
 * is reported through env.warnings instead of being dropped silently.
 */

interface PartCtx {
  part: string
  rels: Map<string, Relationship>
}

interface FieldState {
  instr: string
  phase: 'instr' | 'result'
  suppress: boolean
  link?: string
}

interface TableCtx {
  style?: StyleDef
  /** merged table-style layers that apply to the current cell, lowest priority first */
  ppr: PPr
  rpr: RPr
}

const EMU_PER_PT = 12700
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/

export async function readDocx(bytes: Uint8Array, env: ConvertEnv): Promise<FlowDocument> {
  const pkg = openPackage(bytes, 'Word document')
  const main = pkg.has('word/document.xml') ? 'word/document.xml' : findMainPart(pkg)
  if (!main) throw new OfficeError('This is not a Word document (word/document.xml is missing). If it is an older .doc file saved with the .docx extension, open it in Word and save it again.')
  return new DocxReader(pkg, env, main).read()
}

function findMainPart(pkg: Pkg): string | undefined {
  const rels = pkg.xml('_rels/.rels')
  const rel = rels?.children.find((c) => c.name === 'Relationships')?.children.find((r) => /officeDocument$/.test(r.attrs['Type'] ?? ''))
  const target = rel?.attrs['Target']
  return target ? resolveTarget('', target) : undefined
}

class DocxReader {
  private styles: Styles
  private numbering: Numbering
  private footnoteBodies = new Map<string, Block[]>()
  private endnoteBodies = new Map<string, Block[]>()
  private usedFootnotes: { label: string; blocks: Block[] }[] = []
  private usedEndnotes: { label: string; blocks: Block[] }[] = []
  private fields: FieldState[] = []
  private base: TextStyle
  private defaultTab = 36
  private evenAndOdd = false
  private hasRtl = false
  private mainRels: Map<string, Relationship>

  constructor(
    private pkg: Pkg,
    private env: ConvertEnv,
    private main: string
  ) {
    const mainRels = relationshipsOf(pkg, main)
    this.mainRels = mainRels
    const themePart = [...mainRels.values()].find((r) => r.type === 'theme')?.target
    const theme = readTheme(pkg, themePart)
    this.styles = readStyles(pkg, theme)
    this.numbering = new Numbering(pkg, theme)
    this.base = toTextStyle(mergeRPr(this.styles.docRPr), { ...DEFAULT_TEXT_STYLE, family: 'Times New Roman', size: 10 })
    if (!this.styles.docRPr.font) this.base.family = theme.minor ?? 'Times New Roman'
    const settings = pkg.xml('word/settings.xml')?.children.find((c) => c.name === 'settings')
    const dts = numAttr(child(settings, 'defaultTabStop'), 'val')
    if (dts) this.defaultTab = twips(dts)
    this.evenAndOdd = child(settings, 'evenAndOddHeaders') !== undefined
  }

  private warn(msg: string): void {
    this.env.warnings.add(msg)
  }

  read(): FlowDocument {
    const doc = this.pkg.xml(this.main)?.children.find((c) => c.name === 'document')
    const body = child(doc, 'body')
    if (!body) throw new OfficeError('The Word document has no body.')
    this.loadNotes()
    if (this.pkg.has('word/comments.xml')) this.warn('Comments in the document are not included in the PDF.')

    const sections: Section[] = []
    let blocks: Block[] = []
    const inherit: { header: HeaderFooterSet; footer: HeaderFooterSet } = { header: {}, footer: {} }
    const pushSection = (sect: XNode | undefined): void => {
      const s = this.buildSection(sect, blocks, inherit)
      sections.push(s)
      blocks = []
    }

    let count = 0
    for (const el of body.children) {
      if (++count % 200 === 0) throwIfCancelled(this.env)
      this.readBodyElement(el, blocks, (sect) => pushSection(sect))
    }
    const finalSect = child(body, 'sectPr')
    pushSection(finalSect)

    // Notes go after the last section's content.
    const last = sections[sections.length - 1]
    if (this.usedFootnotes.length) {
      this.warn('Footnotes are shown at the end of the document, not at the bottom of each page.')
      last.blocks.push(this.noteRule(), ...this.noteBlocks(this.usedFootnotes))
    }
    if (this.usedEndnotes.length) last.blocks.push(this.noteRule(), ...this.noteBlocks(this.usedEndnotes))
    if (this.hasRtl) this.warn('Right-to-left or complex-script text may not be shaped or ordered correctly by the built-in engine.')
    return { sections, defaultTabStop: this.defaultTab }
  }

  // -------------------------------------------------------------------------------------------------
  // Body, sections
  // -------------------------------------------------------------------------------------------------

  private readBodyElement(el: XNode, out: Block[], endSection: (sect: XNode | undefined) => void): void {
    switch (el.name) {
      case 'p': {
        const r = this.readParagraph(el, this.mainCtx(), undefined)
        out.push(r.block, ...r.extra)
        const sect = path(el, 'pPr', 'sectPr')
        if (sect) endSection(sect)
        break
      }
      case 'tbl':
        out.push(...this.readTable(el, this.mainCtx(), undefined))
        break
      case 'sdt': {
        const content = child(el, 'sdtContent')
        if (content) for (const c of content.children) this.readBodyElement(c, out, endSection)
        break
      }
      case 'customXml':
      case 'ins':
      case 'moveTo':
        for (const c of el.children) this.readBodyElement(c, out, endSection)
        break
      case 'altChunk':
        this.warn('An embedded document (altChunk) was not included.')
        break
      default:
        break
    }
  }

  private mainCtx(): PartCtx {
    return { part: this.main, rels: this.mainRels }
  }

  private buildSection(sect: XNode | undefined, blocks: Block[], inherit: { header: HeaderFooterSet; footer: HeaderFooterSet }): Section {
    const pg = child(sect, 'pgSz')
    const mar = child(sect, 'pgMar')
    let w = twips(numAttr(pg, 'w')) || this.env.page.width
    let h = twips(numAttr(pg, 'h')) || this.env.page.height
    if (attr(pg, 'orient') === 'landscape' && w < h) [w, h] = [h, w]
    const m = (a: string, d: number): number => {
      const v = numAttr(mar, a)
      return v === undefined ? d : twips(v)
    }
    const cols = child(sect, 'cols')
    const colCount = numAttr(cols, 'num') ?? 1
    const type = attr(child(sect, 'type'), 'val')
    const titlePg = child(sect, 'titlePg') !== undefined
    const startAttr = numAttr(child(sect, 'pgNumType'), 'start')
    if (child(sect, 'pgBorders')) this.warn('Page borders are not drawn.')

    for (const kind of ['header', 'footer'] as const) {
      for (const ref of childrenNamed(sect, `${kind}Reference`)) {
        const t = attr(ref, 'type') ?? 'default'
        const rid = attr(ref, 'id')
        const rel = rid ? this.mainRels.get(rid) : undefined
        if (!rel || rel.external) continue
        const set = inherit[kind]
        set[t === 'first' ? 'first' : t === 'even' ? 'even' : 'default'] = this.readHeaderFooter(rel.target)
      }
    }
    applyContextualSpacing(blocks)
    const copy = (s: HeaderFooterSet): HeaderFooterSet => ({ ...s })
    const marginLeft = m('left', 72)
    const marginRight = m('right', 72)
    void marginLeft
    void marginRight
    return {
      page: {
        width: w,
        height: h,
        margins: { top: m('top', 72), right: m('right', 72), bottom: m('bottom', 72), left: m('left', 72), header: m('header', 36), footer: m('footer', 36) }
      },
      columns: colCount > 1 ? { count: colCount, gap: twips(numAttr(cols, 'space') ?? 720) } : undefined,
      type: type === 'continuous' ? 'continuous' : 'nextPage',
      blocks: blocks.length ? blocks : [this.emptyParagraph()],
      header: copy(inherit.header),
      footer: copy(inherit.footer),
      titlePg,
      evenAndOdd: this.evenAndOdd,
      pageNumberStart: startAttr
    }
  }

  private emptyParagraph(): Paragraph {
    return { k: 'p', props: { ...DEFAULT_PARA_PROPS }, inlines: [], markStyle: this.base }
  }

  private readHeaderFooter(part: string): Block[] {
    const root = this.pkg.xml(part)?.children.find((c) => c.name === 'hdr' || c.name === 'ftr')
    if (!root) return []
    if (descendants(root, 'textpath').length) this.warn('A watermark in the header is not drawn.')
    const ctx: PartCtx = { part, rels: relationshipsOf(this.pkg, part) }
    const out: Block[] = []
    for (const el of root.children) this.readBodyElement2(el, out, ctx)
    applyContextualSpacing(out)
    return out
  }

  /** Like readBodyElement but for parts without sections (headers, footnotes, table cells). */
  private readBodyElement2(el: XNode, out: Block[], ctx: PartCtx, tctx?: TableCtx): void {
    switch (el.name) {
      case 'p': {
        const r = this.readParagraph(el, ctx, tctx)
        out.push(r.block, ...r.extra)
        break
      }
      case 'tbl':
        out.push(...this.readTable(el, ctx, tctx))
        break
      case 'sdt': {
        const content = child(el, 'sdtContent')
        if (content) for (const c of content.children) this.readBodyElement2(c, out, ctx, tctx)
        break
      }
      case 'customXml':
      case 'ins':
        for (const c of el.children) this.readBodyElement2(c, out, ctx, tctx)
        break
      default:
        break
    }
  }

  private loadNotes(): void {
    const load = (part: string, tag: string, into: Map<string, Block[]>): void => {
      const root = this.pkg.xml(part)?.children[0]
      if (!root) return
      const ctx: PartCtx = { part, rels: relationshipsOf(this.pkg, part) }
      for (const n of childrenNamed(root, tag)) {
        const id = attr(n, 'id')
        const type = attr(n, 'type')
        if (id === undefined || type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice') continue
        const blocks: Block[] = []
        for (const el of n.children) this.readBodyElement2(el, blocks, ctx)
        into.set(id, blocks)
      }
    }
    load('word/footnotes.xml', 'footnote', this.footnoteBodies)
    load('word/endnotes.xml', 'endnote', this.endnoteBodies)
  }

  private noteRule(): Paragraph {
    return {
      k: 'p',
      props: { ...DEFAULT_PARA_PROPS, spaceBefore: 12, spaceAfter: 4, borders: { top: { color: '#000000', width: 0.5, style: 'single' } }, indentRight: 300 },
      inlines: [],
      markStyle: { ...this.base, size: 4 }
    }
  }

  private noteBlocks(notes: { label: string; blocks: Block[] }[]): Block[] {
    const out: Block[] = []
    for (const n of notes) {
      const blocks = n.blocks.map((b) => b)
      const first = blocks.find((b): b is Paragraph => b.k === 'p')
      if (first) first.inlines = [{ k: 'text', text: `${n.label} `, style: { ...first.markStyle, vertAlign: 'super' } }, ...first.inlines]
      out.push(...blocks)
    }
    return out
  }

  // -------------------------------------------------------------------------------------------------
  // Paragraphs
  // -------------------------------------------------------------------------------------------------

  private paragraphStyleId(direct: PPr): string | undefined {
    return direct.pStyle ?? this.styles.defaultPara
  }

  private readParagraph(p: XNode, ctx: PartCtx, tctx: TableCtx | undefined): { block: Paragraph; extra: Block[] } {
    const pPrEl = child(p, 'pPr')
    const direct = parsePPr(pPrEl, this.styles.theme)
    const styleId = this.paragraphStyleId(direct)
    let chain = chainOf(this.styles, styleId)
    if (tctx?.style && chain.length && chain[0].isDefault) chain = chain.slice(1) // table style beats the default "Normal"
    const tableLayers = tctx ? [tctx.ppr] : []
    let merged = mergePPr(this.styles.docPPr, ...tableLayers, ...chain.map((s) => s.ppr))
    // numbering: style-linked or direct
    const numId = direct.numId !== undefined ? direct.numId : merged.numId
    const ilvl = direct.ilvl ?? merged.ilvl ?? 0
    const marker = numId && numId > 0 ? this.numbering.next(numId, ilvl) : null
    if (marker) merged = mergePPr(merged, marker.ppr)
    merged = mergePPr(merged, direct)

    const baseR = mergeRPr(this.styles.docRPr, tctx?.rpr, ...chain.map((s) => s.rpr))
    const markR = mergeRPr(baseR, parseRPr(path(pPrEl, 'rPr'), this.styles.theme))
    const markStyle = toTextStyle(markR, this.base)

    const extra: Block[] = []
    const inlines: Inline[] = []
    this.collectInlines(p, ctx, baseR, inlines, extra, undefined)
    const merged2 = this.coalesce(inlines)

    const props = this.paraProps(merged)
    if (marker) {
      const ms = toTextStyle(mergeRPr(markR, marker.rpr), this.base)
      if (marker.isBullet) {
        const cands = bulletCandidates(marker.text, marker.fontHint ?? marker.rpr.font)
        const face = this.env.catalog.face(ms.family === 'Symbol' || /wingdings|webdings/i.test(ms.family) ? this.base.family : ms.family, false, false)
        const pick = cands.find((c) => this.env.catalog.hasGlyph(face, c.codePointAt(0)!)) ?? cands.find((c) => this.env.catalog.hasGlyph(this.env.catalog.faceOf('NotoSans', false, false), c.codePointAt(0)!)) ?? '•'
        const style = /symbol|wingdings|webdings/i.test(ms.family) ? { ...ms, family: this.base.family, bold: false, italic: false } : ms
        props.marker = { text: marker.suff === 'tab' ? pick : `${pick} `, style }
      } else {
        props.marker = { text: marker.suff === 'space' ? `${marker.text} ` : marker.text, style: ms }
      }
      if (marker.suff !== 'tab') {
        // no tab after the label: the hanging indent still applies but text follows directly
      }
    }
    // Word puts the number/bullet in the hanging area; without an explicit indent give lists a sane default.
    if (marker && props.firstLine >= 0 && props.indentLeft === 0) {
      props.indentLeft = 36
      props.firstLine = -18
    }
    if (RTL_CHARS.test(this.textOf(merged2))) this.hasRtl = true
    const block: Paragraph = { k: 'p', props, inlines: merged2, markStyle }
    ;(block as Paragraph & { _style?: string; _ctx?: boolean })._style = styleId
    ;(block as Paragraph & { _ctx?: boolean })._ctx = merged.contextualSpacing
    return { block, extra }
  }

  private textOf(inlines: Inline[]): string {
    let s = ''
    for (const i of inlines) if (i.k === 'text') s += i.text
    return s
  }

  private paraProps(m: PPr): ParaProps {
    const tabs: TabStop[] = (m.tabs ?? []).filter((t) => t.kind !== 'clear').map((t) => ({ pos: t.pos, align: t.kind as TabStop['align'], leader: t.leader }))
    const borders: NonNullable<ParaProps['borders']> = {}
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const b = m.borders?.[side]
      if (b) borders[side] = b
    }
    const hanging = m.hanging ?? 0
    return {
      ...DEFAULT_PARA_PROPS,
      align: m.align ?? 'left',
      spaceBefore: m.spaceBefore ?? 0,
      spaceAfter: m.spaceAfter ?? 0,
      line: m.line ?? { rule: 'auto', value: 1 },
      indentLeft: m.indLeft ?? 0,
      indentRight: m.indRight ?? 0,
      firstLine: hanging > 0 ? -hanging : (m.firstLine ?? 0),
      tabs,
      keepNext: !!m.keepNext,
      keepLines: !!m.keepLines,
      pageBreakBefore: !!m.pageBreakBefore,
      widowControl: m.widowControl !== false,
      shading: m.shading,
      borders: Object.keys(borders).length ? borders : undefined,
      rtl: m.rtl
    }
  }

  private coalesce(inlines: Inline[]): Inline[] {
    const out: Inline[] = []
    for (const il of inlines) {
      const last = out[out.length - 1]
      if (il.k === 'text' && last && last.k === 'text' && last.link === il.link && sameStyle(last.style, il.style)) last.text += il.text
      else out.push(il.k === 'text' ? { ...il } : il)
    }
    return out
  }

  // -------------------------------------------------------------------------------------------------
  // Runs and inline content
  // -------------------------------------------------------------------------------------------------

  private currentLink(fallback: string | undefined): string | undefined {
    for (let i = this.fields.length - 1; i >= 0; i--) if (this.fields[i].link) return this.fields[i].link
    return fallback
  }

  private inSuppressedField(): boolean {
    return this.fields.some((f) => f.phase === 'instr' || f.suppress)
  }

  private collectInlines(node: XNode, ctx: PartCtx, baseR: RPr, out: Inline[], extra: Block[], link: string | undefined): void {
    for (const c of node.children) {
      switch (c.name) {
        case 'r':
          this.readRun(c, ctx, baseR, out, extra, link)
          break
        case 'hyperlink': {
          const rid = attr(c, 'id')
          const rel = rid ? ctx.rels.get(rid) : undefined
          const url = rel && rel.external ? rel.target : undefined
          this.collectInlines(c, ctx, baseR, out, extra, url ?? link)
          break
        }
        case 'fldSimple': {
          const instr = attr(c, 'instr') ?? ''
          const kind = fieldKind(instr)
          if (kind === 'page' || kind === 'pages') {
            out.push({ k: 'field', field: kind, style: this.styleFor(baseR, c.children.find((x) => x.name === 'r'), ctx) })
          } else this.collectInlines(c, ctx, baseR, out, extra, kind === 'hyperlink' ? (hyperlinkTarget(instr) ?? link) : link)
          break
        }
        case 'ins':
        case 'smartTag':
        case 'customXml':
        case 'moveTo':
        case 'sdtContent':
        case 'bdo':
        case 'dir':
          this.collectInlines(c, ctx, baseR, out, extra, link)
          break
        case 'sdt': {
          const content = child(c, 'sdtContent')
          if (content) this.collectInlines(content, ctx, baseR, out, extra, link)
          break
        }
        case 'del':
        case 'moveFrom':
          this.warn('Tracked changes: deleted text is omitted and inserted text is shown as accepted.')
          break
        case 'oMath':
        case 'oMathPara': {
          const t = descendants(c, 't').map((x) => textContent(x)).join('')
          if (t) {
            out.push({ k: 'text', text: t, style: { ...toTextStyle(baseR, this.base), italic: true } })
            this.warn('Equations are shown as plain text.')
          }
          break
        }
        case 'AlternateContent': {
          const choice = child(c, 'Choice')
          const fallback = child(c, 'Fallback')
          const pick = choice && (descendants(choice, 'drawing').length || descendants(choice, 'blip').length || descendants(choice, 'txbxContent').length) ? choice : (fallback ?? choice)
          if (pick) this.collectInlines(pick, ctx, baseR, out, extra, link)
          break
        }
        case 'pict':
        case 'drawing':
          this.readDrawingContainer(c, ctx, baseR, out, extra)
          break
        default:
          break
      }
    }
  }

  private styleFor(baseR: RPr, run: XNode | undefined, ctx: PartCtx): TextStyle {
    void ctx
    const rpr = run ? this.runRPr(run, baseR) : baseR
    return toTextStyle(rpr, this.base)
  }

  private runRPr(run: XNode, baseR: RPr): RPr {
    const direct = parseRPr(child(run, 'rPr'), this.styles.theme)
    let r = baseR
    if (direct.rStyle) {
      const chain = chainOf(this.styles, direct.rStyle)
      r = mergeRPr(r, ...chain.map((s) => s.rpr))
    }
    return mergeRPr(r, direct)
  }

  private readRun(run: XNode, ctx: PartCtx, baseR: RPr, out: Inline[], extra: Block[], link: string | undefined): void {
    const rpr = this.runRPr(run, baseR)
    const hidden = !!rpr.hidden
    const style = toTextStyle(rpr, this.base)
    const emit = (il: Inline): void => {
      if (this.inSuppressedField() || hidden) return
      out.push(il)
    }
    for (const c of run.children) {
      switch (c.name) {
        case 'fldChar': {
          const t = attr(c, 'fldCharType')
          if (t === 'begin') this.fields.push({ instr: '', phase: 'instr', suppress: false })
          else if (t === 'separate') {
            const f = this.fields[this.fields.length - 1]
            if (f) {
              f.phase = 'result'
              const kind = fieldKind(f.instr)
              if (kind === 'page' || kind === 'pages') {
                f.suppress = true
                if (!hidden) out.push({ k: 'field', field: kind, style })
              } else if (kind === 'hyperlink') f.link = hyperlinkTarget(f.instr)
            }
          } else if (t === 'end') this.fields.pop()
          break
        }
        case 'instrText': {
          const f = this.fields[this.fields.length - 1]
          if (f && f.phase === 'instr') f.instr += textContent(c)
          break
        }
        case 't': {
          const text = textContent(c)
          if (text) emit({ k: 'text', text, style, link: this.currentLink(link) })
          break
        }
        case 'tab':
        case 'ptab':
          emit({ k: 'tab', style })
          break
        case 'br': {
          const t = attr(c, 'type')
          emit({ k: 'br', type: t === 'page' ? 'page' : t === 'column' ? 'column' : 'line', style })
          break
        }
        case 'cr':
          emit({ k: 'br', type: 'line', style })
          break
        case 'noBreakHyphen':
          emit({ k: 'text', text: '-', style })
          break
        case 'sym': {
          const ch = attr(c, 'char')
          if (ch) {
            const cp = parseInt(ch, 16)
            const font = attr(c, 'font')
            const cand = bulletCandidates(String.fromCodePoint(cp), font)[0]
            emit({ k: 'text', text: cand, style })
          }
          break
        }
        case 'footnoteReference':
        case 'endnoteReference': {
          const id = attr(c, 'id')
          const isFoot = c.name === 'footnoteReference'
          if (id !== undefined && !hidden) {
            const list = isFoot ? this.usedFootnotes : this.usedEndnotes
            const body = (isFoot ? this.footnoteBodies : this.endnoteBodies).get(id)
            const n = list.length + 1
            const label = isFoot ? String(n) : toRomanLower(n)
            if (body) list.push({ label, blocks: body })
            if (!this.inSuppressedField()) out.push({ k: 'text', text: label, style: { ...style, vertAlign: 'super' } })
          }
          break
        }
        case 'drawing':
        case 'pict':
        case 'object':
          if (!hidden && !this.inSuppressedField()) this.readDrawingContainer(c, ctx, baseR, out, extra)
          break
        case 'AlternateContent': {
          const choice = child(c, 'Choice')
          const fallback = child(c, 'Fallback')
          const pick = choice && (descendants(choice, 'drawing').length || descendants(choice, 'txbxContent').length) ? choice : (fallback ?? choice)
          if (pick && !hidden) this.collectInlines(pick, ctx, baseR, out, extra, link)
          break
        }
        default:
          break
      }
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Drawings
  // -------------------------------------------------------------------------------------------------

  private imageFrom(rid: string | undefined, ctx: PartCtx, alt: string): { bytes: Uint8Array; format: 'png' | 'jpeg' } | null {
    const rel = rid ? ctx.rels.get(rid) : undefined
    if (!rel || rel.external) {
      this.warn(`An image linked from outside the document (${rel?.target ?? 'unknown'}) was not included.`)
      return null
    }
    const bytes = this.pkg.bytes(rel.target)
    if (!bytes) return null
    const fmt = imageFormat(bytes)
    if (fmt === 'png' || fmt === 'jpeg') return { bytes, format: fmt }
    this.warn(`Images in ${fmt === 'unknown' ? 'an unknown format' : fmt.toUpperCase()} (${alt || rel.target.split('/').pop()}) cannot be drawn by the built-in engine and are shown as placeholders.`)
    return null
  }

  private placeholder(text: string, baseR: RPr): Inline {
    return { k: 'text', text: `[${text}]`, style: { ...toTextStyle(baseR, this.base), italic: true, color: '#666666' } }
  }

  private readDrawingContainer(c: XNode, ctx: PartCtx, baseR: RPr, out: Inline[], extra: Block[]): void {
    const style = toTextStyle(baseR, this.base)
    if (c.name === 'object') {
      const img = descendants(c, 'imagedata')[0]
      if (img) {
        const im = this.imageFrom(attr(img, 'id'), ctx, 'embedded object')
        if (im) {
          out.push({ k: 'image', image: im, w: 100, h: 100, style })
          return
        }
      }
      out.push(this.placeholder('Embedded object', baseR))
      this.warn('Embedded objects (charts, OLE objects, equations) are shown as placeholders.')
      return
    }
    // DrawingML: wp:inline / wp:anchor
    for (const holder of [...descendants(c, 'inline'), ...descendants(c, 'anchor')]) {
      const isAnchor = holder.name === 'anchor'
      const ext = child(holder, 'extent')
      const w = (numAttr(ext, 'cx') ?? 0) / EMU_PER_PT
      const h = (numAttr(ext, 'cy') ?? 0) / EMU_PER_PT
      const docPr = child(holder, 'docPr')
      const alt = attr(docPr, 'descr') ?? attr(docPr, 'name') ?? ''
      const graphicData = path(holder, 'graphic', 'graphicData')
      const uri = attr(graphicData, 'uri') ?? ''
      // text boxes (wps) -> paragraphs after the anchor paragraph
      const boxes = descendants(holder, 'txbxContent')
      if (boxes.length) {
        this.warn('Text boxes are placed in the flow of the text rather than at their exact position.')
        for (const box of boxes) {
          const blocks: Block[] = []
          for (const el of box.children) this.readBodyElement2(el, blocks, ctx)
          extra.push(...blocks)
        }
      }
      if (/chart/i.test(uri)) {
        out.push(this.placeholder('Chart', baseR))
        this.warn('Charts are not rendered by the built-in engine and are shown as placeholders.')
        continue
      }
      if (/diagram|dgm/i.test(uri)) {
        out.push(this.placeholder('SmartArt diagram', baseR))
        this.warn('SmartArt diagrams are not rendered by the built-in engine and are shown as placeholders.')
        continue
      }
      const blips = descendants(graphicData ?? holder, 'blip')
      if (blips.length === 0 && boxes.length === 0 && !/picture|wordprocessingShape|wordprocessingGroup/i.test(uri)) {
        continue
      }
      for (const blip of blips) {
        const rid = attr(blip, 'embed') ?? attr(blip, 'link')
        const im = this.imageFrom(rid, ctx, alt)
        if (!im) {
          out.push(this.placeholder(`Image${alt ? `: ${alt}` : ''}`, baseR))
          continue
        }
        const pic = blip.parent?.parent
        const src = child(child(pic, 'blipFill') ?? blip.parent ?? undefined, 'srcRect') ?? child(blip.parent ?? undefined, 'srcRect')
        const crop = src
          ? { l: (numAttr(src, 'l') ?? 0) / 100000, t: (numAttr(src, 't') ?? 0) / 100000, r: (numAttr(src, 'r') ?? 0) / 100000, b: (numAttr(src, 'b') ?? 0) / 100000 }
          : undefined
        const iw = w || 100
        const ih = h || 100
        if (isAnchor) {
          const behind = attr(holder, 'behindDoc') === '1' || attr(holder, 'behindDoc') === 'true'
          const wrap = holder.children.find((x) => /^wrap/.test(x.name))
          const wrapNone = !wrap || wrap.name === 'wrapNone'
          const ph = child(holder, 'positionH')
          const pv = child(holder, 'positionV')
          const hRel = attr(ph, 'relativeFrom') ?? 'column'
          const vRel = attr(pv, 'relativeFrom') ?? 'paragraph'
          const hAlign = textContent(child(ph, 'align') ?? emptyNode()).trim()
          const vAlign = textContent(child(pv, 'align') ?? emptyNode()).trim()
          const hOff = Number(textContent(child(ph, 'posOffset') ?? emptyNode()).trim() || 0) / EMU_PER_PT
          const vOff = Number(textContent(child(pv, 'posOffset') ?? emptyNode()).trim() || 0) / EMU_PER_PT
          if (!wrapNone && wrap && wrap.name !== 'wrapTopAndBottom') this.warn('Text wrapping around floating images is approximated: the text is placed above/below the image.')
          out.push({
            k: 'float',
            spec: {
              image: im,
              w: iw,
              h: ih,
              crop,
              hRel: hRel === 'page' ? 'page' : hRel === 'margin' || hRel === 'insideMargin' || hRel === 'outsideMargin' ? 'margin' : hRel === 'character' ? 'character' : 'column',
              hAlign: hAlign === 'center' ? 'center' : hAlign === 'right' || hAlign === 'outside' ? 'right' : hAlign === 'left' || hAlign === 'inside' ? 'left' : undefined,
              hOffset: hOff,
              vRel: vRel === 'page' ? 'page' : vRel === 'margin' || vRel === 'topMargin' || vRel === 'bottomMargin' || vRel === 'insideMargin' || vRel === 'outsideMargin' ? 'margin' : vRel === 'line' ? 'line' : 'paragraph',
              vAlign: vAlign === 'center' ? 'center' : vAlign === 'bottom' ? 'bottom' : vAlign === 'top' ? 'top' : undefined,
              vOffset: vOff,
              behind,
              wrap: wrapNone ? 'none' : 'topAndBottom'
            }
          })
        } else {
          out.push({ k: 'image', image: im, w: iw, h: ih, crop, style })
        }
      }
    }
    // VML pictures (w:pict / v:imagedata)
    for (const im of descendants(c, 'imagedata')) {
      const rid = attr(im, 'id')
      const shape = im.parent
      const st = attr(shape, 'style') ?? ''
      const wm = /width:\s*([\d.]+)(pt|px|in|cm|mm)/.exec(st)
      const hm = /height:\s*([\d.]+)(pt|px|in|cm|mm)/.exec(st)
      const cv = (v: string, u: string): number => Number(v) * (u === 'pt' ? 1 : u === 'px' ? 0.75 : u === 'in' ? 72 : u === 'cm' ? 28.35 : 2.835)
      const w = wm ? cv(wm[1], wm[2]) : 100
      const h = hm ? cv(hm[1], hm[2]) : 100
      const image = this.imageFrom(rid, ctx, attr(im, 'title') ?? '')
      if (image) out.push({ k: 'image', image, w, h, style })
      else out.push(this.placeholder('Image', baseR))
    }
    for (const tb of descendants(c, 'textbox')) {
      for (const box of descendants(tb, 'txbxContent')) {
        const blocks: Block[] = []
        for (const el of box.children) this.readBodyElement2(el, blocks, ctx)
        extra.push(...blocks)
        this.warn('Text boxes are placed in the flow of the text rather than at their exact position.')
      }
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------------------------------

  private tableStyleLayers(id: string | undefined): { tblPr: TblPrStyle; tcPr: TcPr; ppr: PPr; rpr: RPr; cond: Map<string, { ppr: PPr; rpr: RPr; tcPr: TcPr; tblPr: TblPrStyle }>; style?: StyleDef } {
    const chain = chainOf(this.styles, id ?? this.styles.defaultTable)
    let tblPr: TblPrStyle = {}
    let tcPr: TcPr = {}
    let ppr: PPr = {}
    let rpr: RPr = {}
    const cond = new Map<string, { ppr: PPr; rpr: RPr; tcPr: TcPr; tblPr: TblPrStyle }>()
    for (const s of chain) {
      tblPr = { ...tblPr, ...s.tblPr, borders: { ...tblPr.borders, ...s.tblPr?.borders }, cellMar: { ...tblPr.cellMar, ...s.tblPr?.cellMar } }
      tcPr = { ...tcPr, ...s.tcPr }
      ppr = mergePPr(ppr, s.ppr)
      rpr = mergeRPr(rpr, s.rpr)
      for (const [k, v] of s.cond) {
        const cur = cond.get(k)
        cond.set(k, cur ? { ppr: mergePPr(cur.ppr, v.ppr), rpr: mergeRPr(cur.rpr, v.rpr), tcPr: { ...cur.tcPr, ...v.tcPr, borders: { ...cur.tcPr.borders, ...v.tcPr.borders } }, tblPr: { ...cur.tblPr, ...v.tblPr } } : v)
      }
    }
    return { tblPr, tcPr, ppr, rpr, cond, style: chain[chain.length - 1] }
  }

  private readTable(tbl: XNode, ctx: PartCtx, outer: TableCtx | undefined): Block[] {
    void outer
    const tblPrEl = child(tbl, 'tblPr')
    const styleId = attr(child(tblPrEl, 'tblStyle'), 'val')
    const layers = this.tableStyleLayers(styleId)
    const direct = parseTblPr(tblPrEl, this.styles.theme)
    const look = child(tblPrEl, 'tblLook')
    const lookVal = numAttr(look, 'val')
    const flag = (name: string, bit: number, dflt: boolean): boolean => {
      const a = attr(look, name)
      if (a !== undefined) return a === '1' || a === 'true'
      if (lookVal !== undefined) return (lookVal & bit) !== 0
      return dflt
    }
    const firstRow = flag('firstRow', 0x20, true)
    const lastRow = flag('lastRow', 0x40, false)
    const firstCol = flag('firstColumn', 0x80, true)
    const lastCol = flag('lastColumn', 0x100, false)
    const noHBand = flag('noHBand', 0x200, false)
    const noVBand = flag('noVBand', 0x400, true)

    const grid = childrenNamed(child(tbl, 'tblGrid'), 'gridCol').map((g) => twips(numAttr(g, 'w')))
    const trs = childrenNamed(tbl, 'tr')
    const nRows = trs.length

    const mar = { top: direct.cellMar?.top ?? layers.tblPr.cellMar?.top ?? 0, right: direct.cellMar?.right ?? layers.tblPr.cellMar?.right ?? 5.4, bottom: direct.cellMar?.bottom ?? layers.tblPr.cellMar?.bottom ?? 0, left: direct.cellMar?.left ?? layers.tblPr.cellMar?.left ?? 5.4 }
    const bd = (k: 'top' | 'bottom' | 'left' | 'right' | 'insideH' | 'insideV'): BorderSpec | undefined => {
      const d = direct.borders?.[k]
      if (d !== undefined) return d ?? undefined
      const s = layers.tblPr.borders?.[k]
      return s ?? undefined
    }

    interface PendingCell {
      cell: Cell
      col: number
      span: number
      vmerge?: 'restart' | 'continue'
      drop: boolean
    }
    const rowsInfo: PendingCell[][] = []
    const rowMeta: { height?: Row['height']; header: boolean; cantSplit: boolean }[] = []
    let dataRowIdx = 0

    trs.forEach((tr, r) => {
      const trPr = child(tr, 'trPr')
      const hEl = child(trPr, 'trHeight')
      const isHeader = child(trPr, 'tblHeader') !== undefined
      const hv = numAttr(hEl, 'val')
      rowMeta.push({
        height: hv ? { value: twips(hv), rule: attr(hEl, 'hRule') === 'exact' ? 'exact' : 'atLeast' } : undefined,
        header: isHeader,
        cantSplit: child(trPr, 'cantSplit') !== undefined
      })
      const cells: PendingCell[] = []
      let col = numAttr(child(trPr, 'gridBefore'), 'val') ?? 0
      if (col > 0) cells.push({ cell: { blocks: [this.emptyParagraph()], colSpan: col, rowSpan: 1, vAlign: 'top', borders: { top: null, bottom: null, left: null, right: null } }, col: 0, span: col, drop: false })
      const isFirstRow = r === 0
      const isLastRow = r === nRows - 1
      const bandIndex = firstRow && isFirstRow ? -1 : dataRowIdx
      if (!(firstRow && isFirstRow)) dataRowIdx++
      const tcs = childrenNamed(tr, 'tc')
      tcs.forEach((tc, ci) => {
        const tcPrEl = child(tc, 'tcPr')
        const tcp = parseTcPr(tcPrEl, this.styles.theme)
        const span = numAttr(child(tcPrEl, 'gridSpan'), 'val') ?? 1
        const vm = child(tcPrEl, 'vMerge')
        const vmerge: PendingCell['vmerge'] = vm ? (attr(vm, 'val') === 'restart' ? 'restart' : 'continue') : undefined
        const isFirstCol = col === 0 || (numAttr(child(trPr, 'gridBefore'), 'val') ?? 0) === col
        const isLastCol = ci === tcs.length - 1
        // conditional table-style layers, lowest priority first
        const conds: string[] = ['wholeTable']
        if (!noVBand) conds.push(ci % 2 === 0 ? 'band1Vert' : 'band2Vert')
        if (!noHBand && bandIndex >= 0) conds.push(bandIndex % 2 === 0 ? 'band1Horz' : 'band2Horz')
        if (lastCol && isLastCol) conds.push('lastCol')
        if (firstCol && isFirstCol) conds.push('firstCol')
        if (lastRow && isLastRow) conds.push('lastRow')
        if (firstRow && isFirstRow) conds.push('firstRow')
        if (firstRow && isFirstRow && firstCol && isFirstCol) conds.push('nwCell')
        if (firstRow && isFirstRow && lastCol && isLastCol) conds.push('neCell')
        let cPpr: PPr = {}
        let cRpr: RPr = {}
        let cTc: TcPr = { ...layers.tcPr }
        for (const k of conds) {
          const cd = layers.cond.get(k)
          if (!cd) continue
          cPpr = mergePPr(cPpr, cd.ppr)
          cRpr = mergeRPr(cRpr, cd.rpr)
          cTc = { ...cTc, ...(cd.tcPr.shading ? { shading: cd.tcPr.shading } : {}), borders: { ...cTc.borders, ...cd.tcPr.borders }, vAlign: cd.tcPr.vAlign ?? cTc.vAlign }
        }
        const tctx: TableCtx = { style: layers.style, ppr: mergePPr(layers.ppr, cPpr), rpr: mergeRPr(layers.rpr, cRpr) }
        const blocks: Block[] = []
        for (const el of tc.children) this.readBodyElement2(el, blocks, ctx, tctx)
        if (blocks.length === 0 || blocks[blocks.length - 1].k === 'table') blocks.push(this.emptyParagraph())
        applyContextualSpacing(blocks)
        const borders: Cell['borders'] = {}
        for (const side of ['top', 'bottom', 'left', 'right'] as const) {
          const v = tcp.borders?.[side] !== undefined ? tcp.borders[side] : cTc.borders?.[side]
          if (v !== undefined) borders[side] = v
        }
        cells.push({
          cell: {
            blocks,
            colSpan: span,
            rowSpan: 1,
            shading: tcp.shading ?? cTc.shading,
            borders: Object.keys(borders).length ? borders : undefined,
            padding: tcp.margins
              ? { top: tcp.margins.top ?? mar.top, right: tcp.margins.right ?? mar.right, bottom: tcp.margins.bottom ?? mar.bottom, left: tcp.margins.left ?? mar.left }
              : undefined,
            vAlign: tcp.vAlign ?? cTc.vAlign ?? 'top'
          },
          col,
          span,
          vmerge,
          drop: vmerge === 'continue'
        })
        col += span
      })
      rowsInfo.push(cells)
    })

    // vertical merges
    for (let r = 0; r < rowsInfo.length; r++) {
      for (const pc of rowsInfo[r]) {
        if (pc.vmerge !== 'restart') continue
        let n = 1
        for (let rr = r + 1; rr < rowsInfo.length; rr++) {
          const cont = rowsInfo[rr].find((x) => x.col === pc.col && x.vmerge === 'continue')
          if (!cont) break
          n++
        }
        pc.cell.rowSpan = n
      }
    }
    const nCols = Math.max(grid.length, ...rowsInfo.map((cs) => cs.reduce((m, c) => Math.max(m, c.col + c.span), 0)), 1)
    let widths = grid.length ? [...grid] : []
    if (widths.length < nCols) {
      // derive missing widths from cell widths
      const fallback = widths.length ? widths.reduce((s, x) => s + x, 0) / widths.length : 72
      while (widths.length < nCols) widths.push(fallback)
    }
    const wEl = child(tblPrEl, 'tblW')
    if (wEl && attr(wEl, 'type') === 'pct') {
      // percentage widths are resolved against the available width at layout time; keep proportions
      widths = widths.map((x) => x)
    }
    const rows: Row[] = rowsInfo.map((cells, i) => ({
      cells: cells.filter((c) => !c.drop).map((c) => c.cell),
      height: rowMeta[i].height,
      header: rowMeta[i].header,
      cantSplit: rowMeta[i].cantSplit
    }))
    // Rows whose merged continuation cells were the only cells still need at least one cell.
    const table: Table = {
      k: 'table',
      colWidths: widths,
      rows,
      borders: { top: bd('top'), bottom: bd('bottom'), left: bd('left'), right: bd('right'), insideH: bd('insideH'), insideV: bd('insideV') },
      padding: mar,
      align: direct.align ?? layers.tblPr.align ?? 'left',
      indent: direct.indent ?? layers.tblPr.indent ?? 0
    }
    return [table]
  }
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/** "Don't add space between paragraphs of the same style": drops the space between neighbours that share a style and ask for it. */
function applyContextualSpacing(blocks: Block[]): void {
  type Tagged = Paragraph & { _style?: string; _ctx?: boolean }
  for (let i = 0; i + 1 < blocks.length; i++) {
    const a = blocks[i] as Tagged
    const b = blocks[i + 1] as Tagged
    if (a.k === 'p' && b.k === 'p' && a._ctx && b._ctx && a._style === b._style) {
      a.props.spaceAfter = 0
      b.props.spaceBefore = 0
    }
  }
}

const emptyNode = (): XNode => ({ name: '', prefix: '', attrs: {}, children: [], text: '', nodes: [], parent: null })

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return (
    a.family === b.family &&
    a.size === b.size &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.color === b.color &&
    a.highlight === b.highlight &&
    a.vertAlign === b.vertAlign &&
    a.caps === b.caps &&
    a.smallCaps === b.smallCaps &&
    a.spacing === b.spacing
  )
}

export function fieldKind(instr: string): 'page' | 'pages' | 'hyperlink' | 'other' {
  const w = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  if (w === 'PAGE') return 'page'
  if (w === 'NUMPAGES' || w === 'SECTIONPAGES') return 'pages'
  if (w === 'HYPERLINK') return 'hyperlink'
  return 'other'
}

export function hyperlinkTarget(instr: string): string | undefined {
  const m = /HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/i.exec(instr) ?? /HYPERLINK\s+(\S+)/i.exec(instr)
  if (!m) return undefined
  return /^(https?:|mailto:)/i.test(m[1]) ? m[1] : undefined
}

const toRomanLower = (n: number): string => {
  const map: [number, string][] = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [v, s] of map) while (n >= v) {
    out += s
    n -= v
  }
  return out
}

void colorOf
void parseBorder
