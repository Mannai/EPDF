import { strToU8, zipSync } from 'fflate'

/** Builds small .odp packages shaped like LibreOffice Impress output, for tests. */

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"'

export interface OdpSlide {
  body: string
  attrs?: string
  /** Extra attributes for draw:page, e.g. draw:style-name="dp2". */
  master?: string
}

export interface OdpOptions {
  slides: OdpSlide[]
  /** Extra automatic styles for content.xml. */
  autoStyles?: string
  /** Shapes inside the master page. */
  masterShapes?: string
  /** Extra styles in styles.xml (office:styles). */
  styles?: string
  width?: string
  height?: string
  media?: Record<string, Uint8Array>
  masterStyleAttrs?: string
}

export const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function buildOdp(o: OdpOptions): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const add = (n: string, c: string | Uint8Array): void => void (files[n] = typeof c === 'string' ? strToU8(c) : c)
  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:font-face-decls><style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'"/><style:font-face style:name="Calibri" svg:font-family="Calibri"/></office:font-face-decls><office:styles><style:default-style style:family="graphic"><style:graphic-properties svg:stroke-color="#3465a4" draw:fill-color="#729fcf" fo:wrap-option="no-wrap"/><style:paragraph-properties style:writing-mode="lr-tb"/><style:text-properties style:font-name="Liberation Sans" fo:font-size="18pt"/></style:default-style><style:style style:name="standard" style:family="graphic"><style:graphic-properties draw:stroke="solid" svg:stroke-width="0.1cm" svg:stroke-color="#3465a4" draw:fill="solid" draw:fill-color="#729fcf" fo:padding-top="0.125cm" fo:padding-bottom="0.125cm" fo:padding-left="0.25cm" fo:padding-right="0.25cm" fo:wrap-option="wrap"/></style:style><style:style style:name="Default-title" style:family="presentation"><style:graphic-properties draw:stroke="none" draw:fill="none" draw:textarea-vertical-align="middle"/><style:text-properties fo:font-size="44pt"/></style:style><style:style style:name="Default-outline1" style:family="presentation"><style:graphic-properties draw:stroke="none" draw:fill="none" draw:textarea-vertical-align="top"/><style:text-properties fo:font-size="32pt"/></style:style>${o.styles ?? ''}</office:styles><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="${o.width ?? '28cm'}" fo:page-height="${o.height ?? '15.75cm'}" style:print-orientation="landscape"/></style:page-layout><style:style style:name="Mdp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#ffffff"/></style:style></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1" draw:style-name="Mdp1"${o.masterStyleAttrs ?? ''}>${o.masterShapes ?? ''}</style:master-page></office:master-styles></office:document-styles>`
  const contentXml = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3"><office:font-face-decls><style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'"/></office:font-face-decls><office:automatic-styles><style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:background-visible="true" presentation:background-objects-visible="true" presentation:display-footer="false" presentation:display-page-number="false" presentation:display-date-time="false"/></style:style><style:style style:name="dp2" style:family="drawing-page"><style:drawing-page-properties presentation:display-footer="true" presentation:display-page-number="true" presentation:display-date-time="false" draw:fill="solid" draw:fill-color="#ffff00"/></style:style><style:style style:name="fr1" style:family="graphic" style:parent-style-name="standard"><style:graphic-properties draw:stroke="none" draw:fill="none" draw:textarea-vertical-align="top" fo:padding-top="0.125cm" fo:padding-bottom="0.125cm" fo:padding-left="0.25cm" fo:padding-right="0.25cm"/></style:style>${o.autoStyles ?? ''}</office:automatic-styles><office:body><office:presentation>${o.slides
    .map((s, i) => `<draw:page draw:name="page${i + 1}" draw:style-name="dp1" draw:master-page-name="${s.master ?? 'Default'}"${s.attrs ? ' ' + s.attrs : ''}>${s.body}</draw:page>`)
    .join('')}</office:presentation></office:body></office:document-content>`
  add('mimetype', 'application/vnd.oasis.opendocument.presentation')
  add('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`)
  add('styles.xml', stylesXml)
  add('content.xml', contentXml)
  for (const [n, b] of Object.entries(o.media ?? {})) add(n, b)
  return zipSync(files)
}

export const cm = (n: number): string => `${n}cm`

/** A text frame (`draw:frame` with `draw:text-box`). */
export function frame(x: number, y: number, w: number, h: number, inner: string, attrs = ''): string {
  return `<draw:frame draw:style-name="fr1" draw:layer="layout" svg:width="${cm(w)}" svg:height="${cm(h)}" svg:x="${cm(x)}" svg:y="${cm(y)}"${attrs ? ' ' + attrs : ''}><draw:text-box>${inner}</draw:text-box></draw:frame>`
}

export const para = (text: string, style = '', spans = ''): string => `<text:p${style ? ` text:style-name="${style}"` : ''}>${spans || escapeXml(text)}</text:p>`

export const span = (text: string, style: string): string => `<text:span text:style-name="${style}">${escapeXml(text)}</text:span>`

export function customShape(type: string, x: number, y: number, w: number, h: number, style: string, text = '', attrs = ''): string {
  return `<draw:custom-shape draw:style-name="${style}" draw:layer="layout" svg:width="${cm(w)}" svg:height="${cm(h)}" svg:x="${cm(x)}" svg:y="${cm(y)}"${attrs ? ' ' + attrs : ''}>${text ? `<text:p>${escapeXml(text)}</text:p>` : ''}<draw:enhanced-geometry draw:type="${type}" svg:viewBox="0 0 21600 21600"/></draw:custom-shape>`
}

export const graphicStyle = (name: string, gp: string, extra = ''): string => `<style:style style:name="${name}" style:family="graphic" style:parent-style-name="standard"><style:graphic-properties ${gp}/>${extra}</style:style>`
