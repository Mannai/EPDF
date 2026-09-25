import { appXml, contentTypesXml, coreXml, CT, emu, escAttr, NS, REL, relsXml, textEl, XML_DECL, zipParts, type Parts, type Rel } from './ooxml'
import type { ImageBlock, PageLayout, ParagraphBlock, Run, TableBlock } from './model'

/**
 * Writes a .pptx: one slide per PDF page, slide size = page size, text as positioned text boxes, table cells as
 * (bordered) shapes, images as pictures. A blank master, layout and theme make the package complete.
 */

export interface PptxOptions {
  title?: string
  now?: Date
}

const P_NS = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`
const MIN_EMU = 914400 // 1 inch
const MAX_EMU = 51206400 // 56 inches, PowerPoint's limit

const THEME =
  XML_DECL +
  `<a:theme xmlns:a="${NS.a}" name="Epdf"><a:themeElements>` +
  '<a:clrScheme name="Epdf"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Epdf"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Epdf"><a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  [6350, 12700, 19050].map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('') +
  '</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
  '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'

const GROUP_HEADER =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

const lvl = (n: number): string => `<a:lvl${n}pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`

const MASTER =
  XML_DECL +
  `<p:sldMaster ${P_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_HEADER}</p:spTree></p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  `<p:txStyles><p:titleStyle>${lvl(1)}</p:titleStyle><p:bodyStyle>${lvl(1)}</p:bodyStyle><p:otherStyle>${lvl(1)}</p:otherStyle></p:txStyles></p:sldMaster>`

const LAYOUT =
  XML_DECL +
  `<p:sldLayout ${P_NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP_HEADER}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`

interface SlideCtx {
  rels: Rel[]
  parts: Parts
  media: Map<Uint8Array, string>
  links: Map<string, string>
  nextRel: number
  nextId: number
  /** page -> slide scale and offset (points -> EMU handled by `X`/`Y`/`S`). */
  k: number
  ox: number
  oy: number
}

const X = (c: SlideCtx, v: number): number => emu(c.ox + v * c.k)
const Y = (c: SlideCtx, v: number): number => emu(c.oy + v * c.k)
const S = (c: SlideCtx, v: number): number => Math.max(1, emu(v * c.k))

function linkRel(c: SlideCtx, url: string): string {
  let id = c.links.get(url)
  if (!id) {
    id = `rId${c.nextRel++}`
    c.links.set(url, id)
    c.rels.push({ id, type: REL.hyperlink, target: url, external: true })
  }
  return id
}

function runXml(r: Run, c: SlideCtx): string {
  const sz = Math.max(100, Math.min(400000, Math.round(r.size * c.k * 100)))
  const fill = `<a:solidFill><a:srgbClr val="${r.url ? '0563C1' : r.color}"/></a:solidFill>`
  const font = `<a:latin typeface="${escAttr(r.family)}"/><a:cs typeface="${escAttr(r.family)}"/>`
  const link = r.url ? `<a:hlinkClick r:id="${linkRel(c, r.url)}"/>` : ''
  const text = r.text.replace(/\t/g, '    ')
  return `<a:r><a:rPr lang="en-US" sz="${sz}"${r.bold ? ' b="1"' : ''}${r.italic ? ' i="1"' : ''}${r.url ? ' u="sng"' : ''} dirty="0">${fill}${font}${link}</a:rPr>${textEl('a:t', text)}</a:r>`
}

const ALGN: Record<string, string> = { left: 'l', center: 'ctr', right: 'r', both: 'just' }

function paraXml(runs: Run[], align: string, lnPts: number, c: SlideCtx): string {
  const first = runs[0]
  const end = first ? `<a:endParaRPr lang="en-US" sz="${Math.max(100, Math.round(first.size * c.k * 100))}" dirty="0"/>` : ''
  return (
    `<a:p><a:pPr algn="${ALGN[align] ?? 'l'}">` +
    (lnPts > 0 ? `<a:lnSpc><a:spcPts val="${Math.round(lnPts * c.k * 100)}"/></a:lnSpc>` : '') +
    '<a:spcBef><a:spcPts val="0"/></a:spcBef></a:pPr>' +
    runs.map((r) => runXml(r, c)).join('') +
    end +
    '</a:p>'
  )
}

function shapeXml(c: SlideCtx, name: string, x: number, y: number, w: number, h: number, paras: string, o: { box?: boolean; border?: boolean; anchor?: string; inset?: number }): string {
  const id = c.nextId++
  const ins = emu((o.inset ?? 0) * c.k)
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escAttr(name)} ${id}"/><p:cNvSpPr${o.box === false ? '' : ' txBox="1"'}/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${X(c, x)}" y="${Y(c, y)}"/><a:ext cx="${S(c, w)}" cy="${S(c, h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>` +
    (o.border ? '<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>' : '<a:ln><a:noFill/></a:ln>') +
    '</p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" rtlCol="0" anchor="${o.anchor ?? 't'}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`
  )
}

function paragraphShape(b: ParagraphBlock, c: SlideCtx, pageW: number): string {
  const w = Math.min(b.width * 1.06 + 4, pageW - b.x + 20)
  const h = Math.max(b.height * 1.12, b.runs[0]?.size ?? 10)
  return shapeXml(c, b.heading ? `Heading ${b.heading}` : 'Text', b.x, b.y, w, h, paraXml(b.runs, b.align, b.pitch, c), {})
}

function tableShapes(t: TableBlock, c: SlideCtx): string {
  let out = ''
  t.rows.forEach((row, ri) =>
    row.forEach((cell, ci) => {
      const x = t.colEdges[ci]
      const y = t.rowEdges[ri]
      const w = t.colEdges[ci + 1] - x
      const h = t.rowEdges[ri + 1] - y
      if (!cell.text && !t.bordered) return
      out += shapeXml(c, 'Table cell', x, y, w, h, cell.runs.length ? paraXml(cell.runs, cell.align, 0, c) : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>', {
        box: !t.bordered,
        border: t.bordered,
        anchor: 'ctr',
        inset: 2
      })
    })
  )
  return out
}

function pictureXml(b: ImageBlock, c: SlideCtx, pageNo: number): string {
  let name = c.media.get(b.image.png)
  if (!name) {
    name = `image${c.media.size + 1}.png`
    c.media.set(b.image.png, name)
  }
  const target = `../media/${name}`
  let rel = c.rels.find((r) => r.target === target)
  if (!rel) {
    rel = { id: `rId${c.nextRel++}`, type: REL.image, target }
    c.rels.push(rel)
  }
  c.parts[`ppt/media/${name}`] = b.image.png
  const id = c.nextId++
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="Image from page ${pageNo}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rel.id}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${X(c, b.image.x)}" y="${Y(c, b.image.y)}"/><a:ext cx="${S(c, b.image.width)}" cy="${S(c, b.image.height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  )
}

export function buildPptx(pages: PageLayout[], opts: PptxOptions = {}): Uint8Array {
  const first = pages[0] ?? { width: 720, height: 540 }
  const W = Math.min(MAX_EMU, Math.max(MIN_EMU, emu(first.width)))
  const H = Math.min(MAX_EMU, Math.max(MIN_EMU, emu(first.height)))
  const parts: Parts = {}
  const media = new Map<Uint8Array, string>()
  const slideXml: string[] = []
  const slideRels: Rel[][] = []

  pages.forEach((p) => {
    // Fit every page onto the presentation's slide size (pages of another size are scaled and centred).
    const k = Math.min(W / emu(p.width), H / emu(p.height))
    const c: SlideCtx = {
      rels: [{ id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' }],
      parts,
      media,
      links: new Map(),
      nextRel: 2,
      nextId: 2,
      k,
      ox: (W / 12700 - p.width * k) / 2,
      oy: (H / 12700 - p.height * k) / 2
    }
    let shapes = ''
    for (const b of p.blocks) {
      if (b.type === 'paragraph') shapes += paragraphShape(b, c, p.width)
      else if (b.type === 'table') shapes += tableShapes(b, c)
      else shapes += pictureXml(b, c, p.number)
    }
    slideXml.push(
      XML_DECL + `<p:sld ${P_NS}><p:cSld><p:spTree>${GROUP_HEADER}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    )
    slideRels.push(c.rels)
  })
  if (pages.length === 0) {
    slideXml.push(XML_DECL + `<p:sld ${P_NS}><p:cSld><p:spTree>${GROUP_HEADER}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)
    slideRels.push([{ id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' }])
  }
  const n = slideXml.length

  const presRels: Rel[] = [{ id: 'rId1', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' }]
  slideXml.forEach((_, i) => presRels.push({ id: `rId${i + 2}`, type: REL.slide, target: `slides/slide${i + 1}.xml` }))
  presRels.push(
    { id: `rId${n + 2}`, type: REL.presProps, target: 'presProps.xml' },
    { id: `rId${n + 3}`, type: REL.viewProps, target: 'viewProps.xml' },
    { id: `rId${n + 4}`, type: REL.theme, target: 'theme/theme1.xml' },
    { id: `rId${n + 5}`, type: REL.tableStyles, target: 'tableStyles.xml' }
  )
  const presentation =
    XML_DECL +
    `<p:presentation ${P_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>` +
    slideXml.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('') +
    `</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`

  const overrides: Record<string, string> = {
    '/ppt/presentation.xml': CT.pptx,
    '/ppt/slideMasters/slideMaster1.xml': CT.pptxMaster,
    '/ppt/slideLayouts/slideLayout1.xml': CT.pptxLayout,
    '/ppt/theme/theme1.xml': CT.theme,
    '/ppt/presProps.xml': CT.pptxPres,
    '/ppt/viewProps.xml': CT.pptxView,
    '/ppt/tableStyles.xml': CT.pptxTableStyles,
    '/docProps/core.xml': CT.core,
    '/docProps/app.xml': CT.app
  }
  slideXml.forEach((_, i) => (overrides[`/ppt/slides/slide${i + 1}.xml`] = CT.pptxSlide))

  Object.assign(parts, {
    '[Content_Types].xml': contentTypesXml({ rels: CT.rels, xml: CT.xml, png: CT.png }, overrides),
    '_rels/.rels': relsXml([
      { id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.extProps, target: 'docProps/app.xml' }
    ]),
    'ppt/presentation.xml': presentation,
    'ppt/_rels/presentation.xml.rels': relsXml(presRels),
    'ppt/presProps.xml': XML_DECL + `<p:presentationPr ${P_NS}/>`,
    'ppt/viewProps.xml': XML_DECL + `<p:viewPr ${P_NS}><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    'ppt/tableStyles.xml': XML_DECL + `<a:tblStyleLst xmlns:a="${NS.a}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    'ppt/theme/theme1.xml': THEME,
    'ppt/slideMasters/slideMaster1.xml': MASTER,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': relsXml([
      { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: REL.theme, target: '../theme/theme1.xml' }
    ]),
    'ppt/slideLayouts/slideLayout1.xml': LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': relsXml([{ id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }]),
    'docProps/core.xml': coreXml(opts.title, opts.now ?? new Date()),
    'docProps/app.xml': appXml(`<Slides>${n}</Slides>`)
  })
  slideXml.forEach((x, i) => {
    parts[`ppt/slides/slide${i + 1}.xml`] = x
    parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = relsXml(slideRels[i])
  })
  return zipParts(parts)
}
