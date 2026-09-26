import { appXml, contentTypesXml, coreXml, CT, emu, escAttr, NS, REL, relsXml, textEl, twips, XML_DECL, zipParts, type Parts, type Rel } from './ooxml'
import type { ImageBlock, PageLayout, ParagraphBlock, Run, TableBlock, TableCell } from './model'

/**
 * Writes a .docx (WordprocessingML) from the page layouts: one flow of paragraphs, tables and inline pictures
 * with a page break (or a new section when the page size changes) between the PDF's pages.
 */

export interface DocxOptions {
  title?: string
  now?: Date
}

const W_NS = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"`

const STYLES = (): string =>
  XML_DECL +
  `<w:styles xmlns:w="${NS.w}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  [1, 2, 3]
    .map(
      (n) =>
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${[32, 28, 24][n - 1]}"/><w:szCs w:val="${[32, 28, 24][n - 1]}"/></w:rPr></w:style>`
    )
    .join('') +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>' +
  '</w:styles>'

interface Ctx {
  rels: Rel[]
  media: Map<Uint8Array, string>
  mediaParts: Parts
  links: Map<string, string>
  nextRel: number
  nextDocPr: number
}

const newRel = (ctx: Ctx): string => `rId${ctx.nextRel++}`

function linkRel(ctx: Ctx, url: string): string {
  let id = ctx.links.get(url)
  if (!id) {
    id = newRel(ctx)
    ctx.links.set(url, id)
    ctx.rels.push({ id, type: REL.hyperlink, target: url, external: true })
  }
  return id
}

function runXml(r: Run, ctx: Ctx): string {
  const rPr =
    (r.url ? '<w:rStyle w:val="Hyperlink"/>' : '') +
    `<w:rFonts w:ascii="${escAttr(r.family)}" w:hAnsi="${escAttr(r.family)}" w:eastAsia="${escAttr(r.family)}" w:cs="${escAttr(r.family)}"/>` +
    (r.bold ? '<w:b/><w:bCs/>' : '') +
    (r.italic ? '<w:i/><w:iCs/>' : '') +
    (!r.url && r.color !== '000000' ? `<w:color w:val="${r.color}"/>` : '') +
    `<w:sz w:val="${Math.max(2, Math.round(r.size * 2))}"/><w:szCs w:val="${Math.max(2, Math.round(r.size * 2))}"/>` +
    (r.rtl ? '<w:rtl/>' : '')
  const parts = r.text.split('\t')
  const body = parts.map((t, i) => (i > 0 ? '<w:tab/>' : '') + (t ? textEl('w:t', t) : '')).join('')
  const xml = `<w:r><w:rPr>${rPr}</w:rPr>${body}</w:r>`
  return r.url ? `<w:hyperlink r:id="${linkRel(ctx, r.url)}" w:history="1">${xml}</w:hyperlink>` : xml
}

const PAGE_BREAK = '<w:r><w:br w:type="page"/></w:r>'

const jcOf = (a: string): string => (a === 'center' ? '<w:jc w:val="center"/>' : a === 'right' ? '<w:jc w:val="right"/>' : a === 'both' ? '<w:jc w:val="both"/>' : '')

function paragraphXml(b: ParagraphBlock, ctx: Ctx, opts: { pageBreak: boolean; leftAdj: number }): string {
  const style = b.heading ? `<w:pStyle w:val="Heading${b.heading}"/>` : ''
  const spacing = `<w:spacing w:before="${twips(b.spaceBefore)}" w:after="0"${b.pitch > 0 ? ` w:line="${twips(b.pitch)}" w:lineRule="atLeast"` : ''}/>`
  const left = Math.max(0, b.indentLeft + opts.leftAdj)
  let ind = ''
  if (left > 0.5 || Math.abs(b.firstLine) > 0.5) {
    ind = `<w:ind w:left="${twips(left)}"${b.firstLine < -0.5 ? ` w:hanging="${twips(-b.firstLine)}"` : b.firstLine > 0.5 ? ` w:firstLine="${twips(b.firstLine)}"` : ''}/>`
  }
  const runs = b.runs.map((r) => runXml(r, ctx)).join('')
  // A right-to-left paragraph (most of its text): bidi paragraph, whose natural (start) alignment is the right edge.
  const rtlChars = b.runs.reduce((s, r) => s + (r.rtl ? r.text.length : 0), 0)
  const rtl = rtlChars * 2 > b.runs.reduce((s, r) => s + r.text.length, 0)
  if (rtl) return `<w:p><w:pPr>${style}<w:bidi/>${spacing}${b.align === 'right' ? '' : jcOf(b.align === 'left' ? 'right' : b.align)}</w:pPr>${opts.pageBreak ? PAGE_BREAK : ''}${runs}</w:p>`
  return `<w:p><w:pPr>${style}${spacing}${ind}${jcOf(b.align)}</w:pPr>${opts.pageBreak ? PAGE_BREAK : ''}${runs}</w:p>`
}

function cellXml(c: TableCell, widthTw: number, ctx: Ctx): string {
  const runs = c.runs.map((r) => runXml(r, ctx)).join('')
  return `<w:tc><w:tcPr><w:tcW w:w="${widthTw}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/>${jcOf(c.align)}</w:pPr>${runs}</w:p></w:tc>`
}

function tableXml(t: TableBlock, ctx: Ctx, indentPt: number): string {
  const widths = t.colEdges.slice(1).map((e, i) => Math.max(20, twips(e - t.colEdges[i])))
  const total = widths.reduce((s, w) => s + w, 0)
  const ind = Math.max(0, twips(indentPt))
  const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
  const rows = t.rows
    .map((r, ri) => {
      const h = Math.max(0, t.rowEdges[ri + 1] - t.rowEdges[ri])
      return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${twips(Math.min(h, 400))}" w:hRule="atLeast"/></w:trPr>${r.map((c, ci) => cellXml(c, widths[ci], ctx)).join('')}</w:tr>`
    })
    .join('')
  return `<w:tbl><w:tblPr>${t.bordered ? '<w:tblStyle w:val="TableGrid"/>' : ''}<w:tblW w:w="${total}" w:type="dxa"/><w:tblInd w:w="${ind}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>${grid}${rows}</w:tbl>`
}

function imageXml(b: ImageBlock, ctx: Ctx, page: PageLayout, opts: { pageBreak: boolean; leftAdj: number }): string {
  let name = ctx.media.get(b.image.png)
  if (!name) {
    name = `image${ctx.media.size + 1}.png`
    ctx.media.set(b.image.png, name)
    ctx.mediaParts[`word/media/${name}`] = b.image.png
    ctx.rels.push({ id: newRel(ctx), type: REL.image, target: `media/${name}` })
  }
  const rid = ctx.rels.find((r) => r.target === `media/${name}`)!.id
  const contentW = page.width - page.margins.left - page.margins.right
  const k = Math.min(1, contentW / b.image.width)
  const cx = emu(b.image.width * k)
  const cy = emu(b.image.height * k)
  const id = ctx.nextDocPr++
  const centered = Math.abs(b.image.x + b.image.width / 2 - page.width / 2) < 0.06 * page.width
  const left = Math.max(0, b.image.x - page.margins.left + opts.leftAdj)
  const ind = !centered && left > 4 ? `<w:ind w:left="${twips(left)}"/>` : ''
  const drawing =
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="Image from page ${page.number}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${escAttr(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    '</a:graphicData></a:graphic></wp:inline></w:drawing>'
  return `<w:p><w:pPr><w:spacing w:before="${twips(b.spaceBefore)}" w:after="0"/>${ind}${centered ? '<w:jc w:val="center"/>' : ''}</w:pPr>${opts.pageBreak ? PAGE_BREAK : ''}<w:r>${drawing}</w:r></w:p>`
}

interface Sect {
  w: number
  h: number
  margins: { top: number; right: number; bottom: number; left: number }
}

function sectPr(s: Sect): string {
  const [w, h] = [twips(s.w), twips(s.h)]
  return (
    `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"${w > h ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${twips(s.margins.top)}" w:right="${twips(s.margins.right)}" w:bottom="${twips(s.margins.bottom)}" w:left="${twips(s.margins.left)}" w:header="${Math.min(708, twips(s.margins.top / 2))}" w:footer="${Math.min(708, twips(s.margins.bottom / 2))}" w:gutter="0"/></w:sectPr>`
  )
}

/** Puts a sectPr into the last paragraph of `blocks` (or after a trailing table, in a tiny paragraph). */
function endSection(blocks: string[], s: Sect): void {
  const last = blocks[blocks.length - 1]
  if (last && last.startsWith('<w:p>') && last.includes('</w:pPr>')) {
    const i = last.indexOf('</w:pPr>')
    blocks[blocks.length - 1] = last.slice(0, i) + sectPr(s) + last.slice(i)
  } else {
    blocks.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${sectPr(s)}</w:pPr></w:p>`)
  }
}

export function buildDocx(pages: PageLayout[], opts: DocxOptions = {}): Uint8Array {
  const ctx: Ctx = { rels: [], media: new Map(), mediaParts: {}, links: new Map(), nextRel: 1, nextDocPr: 1 }
  ctx.rels.push({ id: newRel(ctx), type: REL.styles, target: 'styles.xml' })

  // Margins per distinct page size: the smallest each side needs, so every page's text fits inside them.
  const sizeKey = (p: PageLayout): string => `${Math.round(p.width)}x${Math.round(p.height)}`
  const groupMargins = new Map<string, Sect['margins']>()
  for (const p of pages) {
    const g = groupMargins.get(sizeKey(p))
    const m = p.margins
    if (!g) groupMargins.set(sizeKey(p), { ...m })
    else groupMargins.set(sizeKey(p), { top: Math.min(g.top, m.top), right: Math.min(g.right, m.right), bottom: Math.min(g.bottom, m.bottom), left: Math.min(g.left, m.left) })
  }

  const body: string[] = []
  let section: string[] = []
  let sect: Sect | null = null
  pages.forEach((p, pi) => {
    const s: Sect = { w: p.width, h: p.height, margins: groupMargins.get(sizeKey(p))! }
    const newSection = !!sect && (Math.abs(sect.w - s.w) > 1 || Math.abs(sect.h - s.h) > 1)
    if (newSection) {
      endSection(section, sect!)
      body.push(...section)
      section = []
    }
    const startsPage = pi > 0 && !newSection
    const leftAdj = p.margins.left - s.margins.left
    let first = true
    const brk = (): boolean => {
      const need = first && startsPage
      first = false
      return need
    }
    if (p.blocks.length === 0) {
      // a blank PDF page still becomes a page
      section.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${startsPage ? PAGE_BREAK : ''}</w:p>`)
    }
    for (const b of p.blocks) {
      if (b.type === 'paragraph') section.push(paragraphXml(b, ctx, { pageBreak: brk(), leftAdj }))
      else if (b.type === 'image') section.push(imageXml(b, ctx, p, { pageBreak: brk(), leftAdj }))
      else {
        if (brk()) section.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>${PAGE_BREAK}</w:p>`)
        section.push(tableXml(b, ctx, b.x - p.margins.left + leftAdj))
        section.push('<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>')
      }
    }
    sect = s
  })
  if (sect) body.push(...section)
  if (pages.length === 0) body.push('<w:p/>')
  const finalSect = sect ?? { w: 612, h: 792, margins: { top: 72, right: 72, bottom: 72, left: 72 } }

  const documentXml = XML_DECL + `<w:document ${W_NS}><w:body>${body.join('')}${sectPr(finalSect)}</w:body></w:document>`
  const now = opts.now ?? new Date()
  const overrides: Record<string, string> = {
    '/word/document.xml': CT.docx,
    '/word/styles.xml': CT.docxStyles,
    '/docProps/core.xml': CT.core,
    '/docProps/app.xml': CT.app
  }
  const parts: Parts = {
    '[Content_Types].xml': contentTypesXml({ rels: CT.rels, xml: CT.xml, png: CT.png }, overrides),
    '_rels/.rels': relsXml([
      { id: 'rId1', type: REL.officeDocument, target: 'word/document.xml' },
      { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.extProps, target: 'docProps/app.xml' }
    ]),
    'word/document.xml': documentXml,
    'word/styles.xml': STYLES(),
    'word/_rels/document.xml.rels': relsXml(ctx.rels),
    'docProps/core.xml': coreXml(opts.title, now),
    'docProps/app.xml': appXml(`<Pages>${pages.length}</Pages>`),
    ...ctx.mediaParts
  }
  return zipParts(parts)
}
