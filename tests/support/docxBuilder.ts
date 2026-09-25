import { strToU8, zipSync } from 'fflate'

/** Builds .docx packages from hand-written WordprocessingML, the way Word lays them out. */

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export interface DocxParts {
  /** Content of <w:body> (without sectPr unless you want to control it). */
  body: string
  sectPr?: string
  styles?: string
  numbering?: string
  settings?: string
  theme?: string
  footnotes?: string
  endnotes?: string
  headers?: Record<string, string>
  footers?: Record<string, string>
  /** name in word/media -> bytes */
  media?: Record<string, Uint8Array>
  /** extra relationships in document.xml.rels: id -> {type, target, external?} */
  rels?: Record<string, { type: string; target: string; external?: boolean }>
  /** relationships for header/footer parts by part name (e.g. header1.xml) */
  partRels?: Record<string, Record<string, { type: string; target: string; external?: boolean }>>
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const relsXml = (rels: Record<string, { type: string; target: string; external?: boolean }>): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.entries(rels)
    .map(([id, r]) => `<Relationship Id="${id}" Type="${r.type.startsWith('http') ? r.type : `${REL}/${r.type}`}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`

export const DEFAULT_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/><w:b/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="56"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
<w:style w:type="table" w:styleId="Banded"><w:name w:val="Banded"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="4472C4"/></w:tcPr></w:tblStylePr><w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr></w:tblStylePr></w:style>
</w:styles>`

export const DEFAULT_SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'

export function buildDocx(parts: DocxParts): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const add = (name: string, xml: string): void => void (files[name] = strToU8(xml))
  const overrides: string[] = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  ]
  add('_rels/.rels', relsXml({ rId1: { type: 'officeDocument', target: 'word/document.xml' } }))
  add('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${parts.body}${parts.sectPr ?? DEFAULT_SECT}</w:body></w:document>`)
  add('word/styles.xml', parts.styles ?? DEFAULT_STYLES)
  const rels: Record<string, { type: string; target: string; external?: boolean }> = { rIdStyles: { type: 'styles', target: 'styles.xml' } }
  if (parts.numbering) {
    add('word/numbering.xml', parts.numbering)
    rels['rIdNum'] = { type: 'numbering', target: 'numbering.xml' }
    overrides.push('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>')
  }
  if (parts.settings) {
    add('word/settings.xml', parts.settings)
    rels['rIdSettings'] = { type: 'settings', target: 'settings.xml' }
  }
  if (parts.theme) {
    add('word/theme/theme1.xml', parts.theme)
    rels['rIdTheme'] = { type: 'theme', target: 'theme/theme1.xml' }
  }
  if (parts.footnotes) {
    add('word/footnotes.xml', parts.footnotes)
    rels['rIdFoot'] = { type: 'footnotes', target: 'footnotes.xml' }
  }
  if (parts.endnotes) {
    add('word/endnotes.xml', parts.endnotes)
    rels['rIdEnd'] = { type: 'endnotes', target: 'endnotes.xml' }
  }
  for (const [name, xml] of Object.entries(parts.headers ?? {})) {
    add(`word/${name}`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${xml}</w:hdr>`)
    rels[`rId_${name}`] = { type: 'header', target: name }
  }
  for (const [name, xml] of Object.entries(parts.footers ?? {})) {
    add(`word/${name}`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}>${xml}</w:ftr>`)
    rels[`rId_${name}`] = { type: 'footer', target: name }
  }
  for (const [name, bytes] of Object.entries(parts.media ?? {})) {
    files[`word/media/${name}`] = bytes
  }
  for (const [id, r] of Object.entries(parts.rels ?? {})) rels[id] = r
  add('word/_rels/document.xml.rels', relsXml(rels))
  for (const [part, r] of Object.entries(parts.partRels ?? {})) add(`word/_rels/${part}.rels`, relsXml(r))
  add(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${overrides.join('')}</Types>`
  )
  return zipSync(files)
}

// ---- tiny XML helpers -------------------------------------------------------------------------------

export interface RunOpts {
  b?: boolean
  i?: boolean
  u?: boolean
  strike?: boolean
  sz?: number // points
  color?: string
  font?: string
  style?: string
  caps?: boolean
  vert?: 'superscript' | 'subscript'
  highlight?: string
}

export const rPr = (o: RunOpts = {}): string => {
  const parts: string[] = []
  if (o.style) parts.push(`<w:rStyle w:val="${o.style}"/>`)
  if (o.font) parts.push(`<w:rFonts w:ascii="${o.font}" w:hAnsi="${o.font}"/>`)
  if (o.b) parts.push('<w:b/>')
  if (o.i) parts.push('<w:i/>')
  if (o.caps) parts.push('<w:caps/>')
  if (o.strike) parts.push('<w:strike/>')
  if (o.color) parts.push(`<w:color w:val="${o.color}"/>`)
  if (o.sz) parts.push(`<w:sz w:val="${o.sz * 2}"/>`)
  if (o.highlight) parts.push(`<w:highlight w:val="${o.highlight}"/>`)
  if (o.u) parts.push('<w:u w:val="single"/>')
  if (o.vert) parts.push(`<w:vertAlign w:val="${o.vert}"/>`)
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : ''
}

export const r = (text: string, o: RunOpts = {}): string => `<w:r>${rPr(o)}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`

export interface ParaOpts {
  style?: string
  jc?: 'left' | 'center' | 'right' | 'both'
  ind?: string
  spacing?: string
  numId?: number
  ilvl?: number
  keepNext?: boolean
  pageBreakBefore?: boolean
  tabs?: string
  extra?: string
  sectPr?: string
  shd?: string
  pBdr?: string
  mark?: RunOpts
}

export const p = (content: string | string[], o: ParaOpts = {}): string => {
  const inner = Array.isArray(content) ? content.join('') : content
  const props: string[] = []
  if (o.style) props.push(`<w:pStyle w:val="${o.style}"/>`)
  if (o.keepNext) props.push('<w:keepNext/>')
  if (o.pageBreakBefore) props.push('<w:pageBreakBefore/>')
  if (o.numId !== undefined) props.push(`<w:numPr><w:ilvl w:val="${o.ilvl ?? 0}"/><w:numId w:val="${o.numId}"/></w:numPr>`)
  if (o.pBdr) props.push(o.pBdr)
  if (o.shd) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>`)
  if (o.tabs) props.push(`<w:tabs>${o.tabs}</w:tabs>`)
  if (o.spacing) props.push(`<w:spacing ${o.spacing}/>`)
  if (o.ind) props.push(`<w:ind ${o.ind}/>`)
  if (o.jc) props.push(`<w:jc w:val="${o.jc}"/>`)
  if (o.mark) props.push(rPr(o.mark))
  if (o.sectPr) props.push(o.sectPr)
  return `<w:p>${props.length ? `<w:pPr>${props.join('')}</w:pPr>` : ''}${inner}</w:p>`
}

/** A simple paragraph of plain text. */
export const para = (text: string, o: ParaOpts = {}, ro: RunOpts = {}): string => p(text ? r(text, ro) : '', o)

export const pageBreak = (): string => '<w:r><w:br w:type="page"/></w:r>'

export const tc = (content: string, o: { w?: number; span?: number; vMerge?: 'restart' | 'continue'; shd?: string; borders?: string; vAlign?: string } = {}): string =>
  `<w:tc><w:tcPr>${o.w ? `<w:tcW w:w="${o.w}" w:type="dxa"/>` : ''}${o.span ? `<w:gridSpan w:val="${o.span}"/>` : ''}${o.vMerge ? (o.vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>') : ''}${o.borders ? `<w:tcBorders>${o.borders}</w:tcBorders>` : ''}${o.shd ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>` : ''}${o.vAlign ? `<w:vAlign w:val="${o.vAlign}"/>` : ''}</w:tcPr>${content || '<w:p/>'}</w:tc>`

export const tr = (cells: string[], o: { header?: boolean; height?: number; cantSplit?: boolean } = {}): string =>
  `<w:tr>${o.header || o.height || o.cantSplit ? `<w:trPr>${o.cantSplit ? '<w:cantSplit/>' : ''}${o.height ? `<w:trHeight w:val="${o.height}"/>` : ''}${o.header ? '<w:tblHeader/>' : ''}</w:trPr>` : ''}${cells.join('')}</w:tr>`

export const tbl = (rows: string[], grid: number[], o: { style?: string; look?: string; extraPr?: string } = {}): string =>
  `<w:tbl><w:tblPr>${o.style ? `<w:tblStyle w:val="${o.style}"/>` : ''}<w:tblW w:w="${grid.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${o.extraPr ?? ''}${o.look ?? '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>'}</w:tblPr><w:tblGrid>${grid.map((g) => `<w:gridCol w:w="${g}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`

export const inlineImage = (rid: string, cxPt: number, cyPt: number, id = 1, alt = 'picture'): string =>
  `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${Math.round(cxPt * 12700)}" cy="${Math.round(cyPt * 12700)}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(cxPt * 12700)}" cy="${Math.round(cyPt * 12700)}"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`

export const anchorImage = (rid: string, cxPt: number, cyPt: number, o: { behind?: boolean; hFrom?: string; vFrom?: string; hAlign?: string; vAlign?: string; hOff?: number; vOff?: number; wrap?: string } = {}): string =>
  `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="${o.behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="${o.hFrom ?? 'page'}">${o.hAlign ? `<wp:align>${o.hAlign}</wp:align>` : `<wp:posOffset>${Math.round((o.hOff ?? 0) * 12700)}</wp:posOffset>`}</wp:positionH><wp:positionV relativeFrom="${o.vFrom ?? 'page'}">${o.vAlign ? `<wp:align>${o.vAlign}</wp:align>` : `<wp:posOffset>${Math.round((o.vOff ?? 0) * 12700)}</wp:posOffset>`}</wp:positionV><wp:extent cx="${Math.round(cxPt * 12700)}" cy="${Math.round(cyPt * 12700)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:${o.wrap ?? 'wrapNone'}/><wp:docPr id="9" name="Picture 9"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="9" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`

export const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${NS}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#xF0B7;"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1.%2.%3"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2160" w:hanging="360"/></w:pPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>
</w:numbering>`
