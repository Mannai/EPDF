import { zipSync } from 'fflate'

/** Shared helpers for writing OOXML packages by hand. */

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Removes characters that are illegal in XML 1.0 (control characters, lone surrogates, U+FFFE/U+FFFF). */
export const stripInvalid = (s: string): string => s.replace(INVALID, '')

/** Escapes text for element content. */
export const esc = (s: string): string => stripInvalid(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Escapes text for a double-quoted attribute value. */
export const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;')

/** Text element that keeps leading/trailing spaces: `<w:t xml:space="preserve">…</w:t>`. */
export const textEl = (tag: string, text: string): string => `<${tag} xml:space="preserve">${esc(text)}</${tag}>`

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  x: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  dcmitype: 'http://purl.org/dc/dcmitype/',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  ep: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'
}

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const REL = {
  officeDocument: `${R}/officeDocument`,
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extProps: `${R}/extended-properties`,
  styles: `${R}/styles`,
  image: `${R}/image`,
  hyperlink: `${R}/hyperlink`,
  worksheet: `${R}/worksheet`,
  sharedStrings: `${R}/sharedStrings`,
  slide: `${R}/slide`,
  slideMaster: `${R}/slideMaster`,
  slideLayout: `${R}/slideLayout`,
  theme: `${R}/theme`,
  presProps: `${R}/presProps`,
  viewProps: `${R}/viewProps`,
  tableStyles: `${R}/tableStyles`
}

export const CT = {
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
  png: 'image/png',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  docxStyles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  xlsxSheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  xlsxStyles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  xlsxStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  pptxSlide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  pptxMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  pptxLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  pptxPres: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  pptxView: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  pptxTableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml'
}

export interface Rel {
  id: string
  type: string
  target: string
  external?: boolean
}

export function relsXml(rels: Rel[]): string {
  return (
    XML_DECL +
    `<Relationships xmlns="${NS.rels}">` +
    rels.map((r) => `<Relationship Id="${escAttr(r.id)}" Type="${escAttr(r.type)}" Target="${escAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
    '</Relationships>'
  )
}

export function contentTypesXml(defaults: Record<string, string>, overrides: Record<string, string>): string {
  return (
    XML_DECL +
    `<Types xmlns="${NS.ct}">` +
    Object.entries(defaults).map(([ext, type]) => `<Default Extension="${escAttr(ext)}" ContentType="${escAttr(type)}"/>`).join('') +
    Object.entries(overrides).map(([part, type]) => `<Override PartName="${escAttr(part)}" ContentType="${escAttr(type)}"/>`).join('') +
    '</Types>'
  )
}

export function coreXml(title: string | undefined, now: Date): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return (
    XML_DECL +
    `<cp:coreProperties xmlns:cp="${NS.cp}" xmlns:dc="${NS.dc}" xmlns:dcterms="${NS.dcterms}" xmlns:dcmitype="${NS.dcmitype}" xmlns:xsi="${NS.xsi}">` +
    (title ? `<dc:title>${esc(title)}</dc:title>` : '') +
    '<dc:creator>Epdf</dc:creator><cp:lastModifiedBy>Epdf</cp:lastModifiedBy>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    '</cp:coreProperties>'
  )
}

export function appXml(extra = ''): string {
  return XML_DECL + `<Properties xmlns="${NS.ep}"><Application>Epdf</Application><AppVersion>1.0</AppVersion>${extra}</Properties>`
}

export type Parts = Record<string, string | Uint8Array>

/** Zips parts; `[Content_Types].xml` is written first as the OPC spec recommends. */
export function zipParts(parts: Parts): Uint8Array {
  const enc = new TextEncoder()
  const data: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {}
  const names = Object.keys(parts).sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0))
  for (const name of names) {
    const v = parts[name]
    data[name] = typeof v === 'string' ? enc.encode(v) : name.endsWith('.png') ? [v, { level: 0 }] : v
  }
  return zipSync(data as never, { level: 6 })
}

/** Column number (1-based) to spreadsheet letters: 1 -> A, 27 -> AA. */
export function colLetters(n: number): string {
  let s = ''
  for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s
  return s
}

export const EMU_PER_PT = 12700
export const emu = (pt: number): number => Math.round(pt * EMU_PER_PT)
export const twips = (pt: number): number => Math.round(pt * 20)
