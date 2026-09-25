import { strToU8, zipSync } from 'fflate'

/** Builders for OpenDocument text packages that mimic what LibreOffice writes (used by the ODT reader tests). */

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3"'

export interface OdtOptions {
  /** Inside office:automatic-styles of content.xml. */
  autoStyles?: string
  /** Inside office:text. */
  body: string
  /** Extra common styles (inside office:styles of styles.xml), added after the defaults. */
  styles?: string
  /** Inside office:automatic-styles of styles.xml (header/footer paragraph styles ...). */
  stylesAuto?: string
  /** Replaces the default page layout / master pages (inside office:automatic-styles / office:master-styles). */
  pageLayouts?: string
  masters?: string
  files?: Record<string, Uint8Array>
  title?: string
  mimetype?: string
  omitContent?: boolean
}

export const A4_LAYOUT =
  '<style:page-layout style:name="Mpm1"><style:page-layout-properties fo:page-width="21.001cm" fo:page-height="29.7cm" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/><style:header-style/><style:footer-style/></style:page-layout>'

export const STANDARD_MASTER = '<style:master-page style:name="Standard" style:page-layout-name="Mpm1"/>'

const DEFAULT_STYLES = `
<style:default-style style:family="paragraph"><style:paragraph-properties fo:orphans="2" fo:widows="2" style:tab-stop-distance="1.25cm"/><style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt"/></style:default-style>
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Text_20_body" style:class="text"><style:paragraph-properties fo:margin-top="0.423cm" fo:margin-bottom="0.212cm" fo:keep-with-next="always"/><style:text-properties style:font-name="Liberation Sans" fo:font-size="14pt"/></style:style>
<style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.247cm"/></style:style>
<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="1"><style:text-properties fo:font-size="130%" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="2"><style:text-properties fo:font-size="115%" fo:font-weight="bold"/></style:style>
<style:style style:name="Strong_20_Emphasis" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
`

const FONTS = `<office:font-face-decls>
<style:font-face style:name="Liberation Serif" svg:font-family="'Liberation Serif'" style:font-family-generic="roman"/>
<style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'" style:font-family-generic="swiss"/>
<style:font-face style:name="Liberation Mono" svg:font-family="'Liberation Mono'" style:font-family-generic="modern"/>
</office:font-face-decls>`

export function odtPackage(o: OdtOptions): Uint8Array {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}>${FONTS}<office:automatic-styles>${o.autoStyles ?? ''}</office:automatic-styles><office:body><office:text>${o.body}</office:text></office:body></office:document-content>`
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS}>${FONTS}<office:styles>${DEFAULT_STYLES}${o.styles ?? ''}</office:styles><office:automatic-styles>${o.pageLayouts ?? A4_LAYOUT}${o.stylesAuto ?? ''}</office:automatic-styles><office:master-styles>${o.masters ?? STANDARD_MASTER}</office:master-styles></office:document-styles>`
  const meta = `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS}><office:meta>${o.title ? `<dc:title>${o.title}</dc:title>` : ''}</office:meta></office:document-meta>`
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8(o.mimetype ?? 'application/vnd.oasis.opendocument.text'), { level: 0 }],
    'META-INF/manifest.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
        `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${o.mimetype ?? 'application/vnd.oasis.opendocument.text'}"/>` +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
        Object.keys(o.files ?? {})
          .map((f) => `<manifest:file-entry manifest:full-path="${f}" manifest:media-type="${f.endsWith('.png') ? 'image/png' : ''}"/>`)
          .join('') +
        '</manifest:manifest>'
    ),
    'styles.xml': strToU8(styles),
    'meta.xml': strToU8(meta),
    ...(o.omitContent ? {} : { 'content.xml': strToU8(content) })
  }
  for (const [k, v] of Object.entries(o.files ?? {})) files[k] = v
  return zipSync(files as never)
}

/** A paragraph in the default style. */
export const p = (text: string, style = 'Standard'): string => `<text:p text:style-name="${style}">${text}</text:p>`
