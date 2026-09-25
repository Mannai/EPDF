import { strToU8, zipSync } from 'fflate'

/** Builds small but structurally realistic .pptx packages (as PowerPoint writes them) for tests. */

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface Rel {
  id: string
  type: string
  target: string
  external?: boolean
}

export interface SlideSpec {
  shapes: string
  rels?: Rel[]
  /** Attributes on <p:sld> (e.g. show="0"). */
  attrs?: string
  /** Inner XML of <p:cSld> before spTree, e.g. a <p:bg>. */
  bg?: string
  /** Slide layout to use (index into `layouts`, default 0). */
  layout?: number
}

export interface LayoutSpec {
  shapes: string
  attrs?: string
  bg?: string
}

export interface PptxOptions {
  width?: number
  height?: number
  slides: SlideSpec[]
  layouts?: LayoutSpec[]
  masterShapes?: string
  masterBg?: string
  masterTxStyles?: string
  media?: Record<string, Uint8Array>
  tableStyles?: string
  themeXml?: string
}

const rels = (list: Rel[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith('http') ? r.type : `${REL}/${r.type}`}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`

export const spTree = (shapes: string): string =>
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree>`

export const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Cambria"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst></a:gradFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

export const MASTER_TX = `<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="3200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="742950" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="&#8211;"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl2pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles>`

export const MASTER_SHAPES = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Text Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>`

export const DEFAULT_LAYOUT_SHAPES = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>`

export function buildPptx(o: PptxOptions): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const add = (name: string, content: string | Uint8Array): void => void (files[name] = typeof content === 'string' ? strToU8(content) : content)
  const layouts = o.layouts ?? [{ shapes: DEFAULT_LAYOUT_SHAPES }]
  const width = o.width ?? 9144000
  const height = o.height ?? 6858000
  const overrides: string[] = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
  ]
  layouts.forEach((_, i) => overrides.push(`<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`))
  o.slides.forEach((_, i) => overrides.push(`<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`))
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${overrides.join('')}</Types>`)
  add('_rels/.rels', rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]))
  const presRels: Rel[] = [{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }]
  o.slides.forEach((_, i) => presRels.push({ id: `rId${i + 2}`, type: 'slide', target: `slides/slide${i + 1}.xml` }))
  if (o.tableStyles) presRels.push({ id: 'rIdTs', type: 'tableStyles', target: 'tableStyles.xml' })
  add('ppt/_rels/presentation.xml.rels', rels(presRels))
  add(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${o.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>`
  )
  if (o.tableStyles) add('ppt/tableStyles.xml', o.tableStyles)
  add('ppt/theme/theme1.xml', o.themeXml ?? THEME)
  add(
    'ppt/slideMasters/slideMaster1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${NS}><p:cSld>${o.masterBg ?? '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'}${spTree(o.masterShapes ?? MASTER_SHAPES)}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${layouts.map((_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldLayoutIdLst>${o.masterTxStyles ?? MASTER_TX}</p:sldMaster>`
  )
  add('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([...layouts.map((_, i) => ({ id: `rId${i + 1}`, type: 'slideLayout', target: `../slideLayouts/slideLayout${i + 1}.xml` })), { id: 'rIdT', type: 'theme', target: '../theme/theme1.xml' }]))
  layouts.forEach((l, i) => {
    add(`ppt/slideLayouts/slideLayout${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${NS} type="obj"${l.attrs ? ' ' + l.attrs : ''}><p:cSld name="Layout ${i + 1}">${l.bg ?? ''}${spTree(l.shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
    add(`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]))
  })
  o.slides.forEach((s, i) => {
    add(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}${s.attrs ? ' ' + s.attrs : ''}><p:cSld>${s.bg ?? ''}${spTree(s.shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)
    add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([{ id: 'rIdL', type: 'slideLayout', target: `../slideLayouts/slideLayout${(s.layout ?? 0) + 1}.xml` }, ...(s.rels ?? [])]))
  })
  for (const [name, bytes] of Object.entries(o.media ?? {})) add(name, bytes)
  return zipSync(files)
}

// -- shape snippets ---------------------------------------------------------------------------------

export const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const xfrm = (x: number, y: number, w: number, h: number, extra = ''): string => `<a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`

/** A text box (`<p:sp txBox>`). `paras` are `<a:p>` snippets or plain strings. */
export function textBox(id: number, x: number, y: number, w: number, h: number, paras: string[], opts: { bodyPr?: string; fill?: string; xfrmExtra?: string; lst?: string } = {}): string {
  const ps = paras.map((p) => (p.startsWith('<a:p') ? p : `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(p)}</a:t></a:r></a:p>`)).join('')
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, w, h, opts.xfrmExtra ?? '')}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${opts.fill ?? '<a:noFill/>'}</p:spPr><p:txBody><a:bodyPr wrap="square" ${opts.bodyPr ?? 'rtlCol="0"'}><a:spAutoFit/></a:bodyPr><a:lstStyle>${opts.lst ?? ''}</a:lstStyle>${ps}</p:txBody></p:sp>`
}

export const run = (text: string, rPr = ''): string => `<a:r><a:rPr lang="en-US"${rPr.startsWith('<') ? '>' + rPr + '</a:rPr>' : ' ' + rPr + '/>'}<a:t>${escapeXml(text)}</a:t></a:r>`

export function shape(id: number, prst: string, x: number, y: number, w: number, h: number, spPrInner = '', text = '', extra = ''): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, w, h, extra)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${spPrInner}</p:spPr>${text ? `<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody>` : ''}</p:sp>`
}

export function picture(id: number, rid: string, x: number, y: number, w: number, h: number, blipExtra = '', bfExtra = ''): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}">${blipExtra}</a:blip>${bfExtra}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
}

export const titlePlaceholder = (id: number, text: string, spPr = '<p:spPr/>'): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>${spPr}<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`

export const bodyPlaceholder = (id: number, paras: string[], spPr = '<p:spPr/>'): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Content ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>${spPr}<p:txBody><a:bodyPr/><a:lstStyle/>${paras.map((p) => (p.startsWith('<a:p') ? p : `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(p)}</a:t></a:r></a:p>`)).join('')}</p:txBody></p:sp>`

export const solidFill = (hex: string): string => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`

export const EMU = 12700
