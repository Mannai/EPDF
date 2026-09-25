import { strToU8, zipSync } from 'fflate'
import { esc } from './xlsxBuilder'

/** Hand-written ODS packages that mimic LibreOffice Calc output. */

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"'

export const ODS_AUTOMATIC_STYLES = `
<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="3.5cm"/></style:style>
<style:style style:name="co2" style:family="table-column"><style:table-column-properties style:column-width="5cm"/></style:style>
<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.452cm" style:use-optimal-row-height="true"/></style:style>
<style:style style:name="ro2" style:family="table-row"><style:table-row-properties style:row-height="1.2cm" style:use-optimal-row-height="false"/></style:style>
<style:style style:name="ce_bold" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold" fo:font-size="12pt"/></style:style>
<style:style style:name="ce_fill" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffff00" fo:border="0.75pt solid #000000"/></style:style>
<style:style style:name="ce_wrap" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:wrap-option="wrap" style:vertical-align="top"/></style:style>
<style:style style:name="ce_center" style:family="table-cell" style:parent-style-name="Default"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:color="#ff0000" fo:font-style="italic" style:text-underline-style="solid"/></style:style>
<style:style style:name="ta1" style:family="table" style:master-page-name="Default"><style:table-properties table:display="true" style:writing-mode="lr-tb"/></style:style>
`

export interface OdsTable {
  name: string
  /** Inner XML: table:table-column / table:table-row elements. */
  xml: string
  attrs?: string
}

export interface OdsSpec {
  tables: OdsTable[]
  automaticStyles?: string
  /** styles.xml `office:master-styles` inner XML; default: one plain master page. */
  masterStyles?: string
  pageLayout?: string
  files?: Record<string, Uint8Array | string>
}

export const tcell = (value: string | number | boolean | undefined, style?: string, extra = ''): string => {
  const st = style ? ` table:style-name="${style}"` : ''
  if (value === undefined) return `<table:table-cell${st}${extra ? ' ' + extra : ''}/>`
  if (typeof value === 'number') return `<table:table-cell${st} office:value-type="float" office:value="${value}"${extra ? ' ' + extra : ''}><text:p>${value}</text:p></table:table-cell>`
  if (typeof value === 'boolean') return `<table:table-cell${st} office:value-type="boolean" office:boolean-value="${value}"${extra ? ' ' + extra : ''}><text:p>${value ? 'TRUE' : 'FALSE'}</text:p></table:table-cell>`
  return `<table:table-cell${st} office:value-type="string"${extra ? ' ' + extra : ''}><text:p>${esc(value)}</text:p></table:table-cell>`
}

export const trow = (cells: string, style = 'ro1', attrs = ''): string => `<table:table-row table:style-name="${style}"${attrs ? ' ' + attrs : ''}>${cells}</table:table-row>`

export function buildOds(spec: OdsSpec): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const put = (n: string, d: string | Uint8Array): void => void (files[n] = typeof d === 'string' ? strToU8(d) : d)
  put('mimetype', 'application/vnd.oasis.opendocument.spreadsheet')
  put(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3"><office:font-face-decls><style:font-face style:name="Liberation Sans" svg:font-family="&apos;Liberation Sans&apos;"/></office:font-face-decls><office:automatic-styles>${spec.automaticStyles ?? ODS_AUTOMATIC_STYLES}</office:automatic-styles><office:body><office:spreadsheet>${spec.tables
      .map((t) => `<table:table table:name="${esc(t.name)}" table:style-name="ta1"${t.attrs ? ' ' + t.attrs : ''}>${t.xml}</table:table>`)
      .join('')}</office:spreadsheet></office:body></office:document-content>`
  )
  put(
    'styles.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles><style:default-style style:family="table-cell"><style:text-properties style:font-name="Liberation Sans" fo:font-size="10pt"/></style:default-style><style:style style:name="Default" style:family="table-cell"/></office:styles><office:automatic-styles>${
      spec.pageLayout ??
      `<style:page-layout style:name="Mpm1"><style:page-layout-properties fo:page-width="21.001cm" fo:page-height="29.7cm" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/><style:header-style><style:header-footer-properties fo:min-height="0.5cm" fo:margin-bottom="0.25cm"/></style:header-style><style:footer-style><style:header-footer-properties fo:min-height="0.5cm" fo:margin-top="0.25cm"/></style:footer-style></style:page-layout>`
    }</office:automatic-styles><office:master-styles>${spec.masterStyles ?? '<style:master-page style:name="Default" style:page-layout-name="Mpm1"/>'}</office:master-styles></office:document-styles>`
  )
  const extra = Object.entries(spec.files ?? {})
    .map(([k]) => `<manifest:file-entry manifest:full-path="${k}" manifest:media-type="${k.endsWith('.png') ? 'image/png' : ''}"/>`)
    .join('')
  put(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>${extra}</manifest:manifest>`
  )
  for (const [k, v] of Object.entries(spec.files ?? {})) put(k, v)
  // ODF requires the `mimetype` entry first and stored without compression
  const ordered: Record<string, [Uint8Array, { level: 0 | 6 }]> = { mimetype: [files['mimetype'], { level: 0 }] }
  for (const [k, v] of Object.entries(files)) if (k !== 'mimetype') ordered[k] = [v, { level: 6 }]
  return zipSync(ordered)
}
