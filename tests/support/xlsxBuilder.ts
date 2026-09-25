import { strToU8, zipSync } from 'fflate'

/** Builds hand-written XLSX packages that mimic what Excel writes (for converter tests). */

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

export const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<fonts count="4">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
<font><i/><u/><sz val="14"/><color rgb="FFFF0000"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor theme="4" tint="0.39997558519241921"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>
<border><left/><right/><top/><bottom style="double"><color rgb="FFFF0000"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="19">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" indent="2"/></xf>
<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment shrinkToFit="1"/></xf>
</cellXfs>
<dxfs count="1"><dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>
</styleSheet>`

/** xf indexes of STYLES */
export const XF = { bold: 1, dec2: 2, usd: 3, date: 4, pct: 5, yellow: 6, boxed: 7, wrap: 8, center: 9, isoDate: 10, thousands: 11, fancyFont: 12, themeFill: 13, right: 14, indent: 15, header: 16, doubleBottom: 17, shrink: 18 }

export interface CellSpec {
  ref: string
  v?: string | number | boolean
  /** Shared string index instead of a value. */
  sst?: number
  s?: number
  t?: string
  f?: string
}

export const cell = (c: CellSpec): string => {
  const attrs = `r="${c.ref}"${c.s ? ` s="${c.s}"` : ''}`
  if (c.sst !== undefined) return `<c ${attrs} t="s"><v>${c.sst}</v></c>`
  const f = c.f ? `<f>${esc(c.f)}</f>` : ''
  if (typeof c.v === 'string' && !c.t) return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`
  if (typeof c.v === 'boolean') return `<c ${attrs} t="b">${f}<v>${c.v ? 1 : 0}</v></c>`
  return `<c ${attrs}${c.t ? ` t="${c.t}"` : ''}>${f}${c.v === undefined ? '' : `<v>${esc(String(c.v))}</v>`}</c>`
}

export const row = (r: number, cells: CellSpec[], attrs = ''): string => `<row r="${r}"${attrs ? ' ' + attrs : ''}>${cells.map(cell).join('')}</row>`

/** Row of plain values starting at column A. */
export const simpleRow = (r: number, values: (string | number | boolean | undefined)[], s?: number): string =>
  row(
    r,
    values.map((v, i) => ({ ref: `${String.fromCharCode(65 + (i % 26))}${r}`, v, s })).filter((c) => c.v !== undefined)
  )

export interface WorksheetParts {
  sheetPr?: string
  cols?: string
  rows: string
  /** Elements after sheetData, in schema order (mergeCells, hyperlinks, printOptions, pageMargins, pageSetup, headerFooter, rowBreaks, drawing...). */
  after?: string
  sheetFormatPr?: string
}

export const worksheet = (p: WorksheetParts): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}>${p.sheetPr ?? ''}<dimension ref="A1"/>${p.sheetFormatPr ?? '<sheetFormatPr defaultRowHeight="15"/>'}${p.cols ?? ''}<sheetData>${p.rows}</sheetData>${p.after ?? ''}</worksheet>`

export interface XlsxSpec {
  sheets: { name: string; xml: string; state?: string; rels?: string }[]
  styles?: string | null
  sharedStrings?: (string | { runs: { text: string; rPr?: string }[] })[]
  definedNames?: string
  date1904?: boolean
  files?: Record<string, Uint8Array | string>
}

export function buildXlsx(spec: XlsxSpec): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const put = (name: string, data: string | Uint8Array): void => void (files[name] = typeof data === 'string' ? strToU8(data) : data)
  const overrides: string[] = []
  spec.sheets.forEach((s, i) => {
    put(`xl/worksheets/sheet${i + 1}.xml`, s.xml)
    if (s.rels) put(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, s.rels)
    overrides.push(`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
  })
  put(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${NS}><workbookPr${spec.date1904 ? ' date1904="1"' : ''}/><sheets>${spec.sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`)
      .join('')}</sheets>${spec.definedNames ? `<definedNames>${spec.definedNames}</definedNames>` : ''}</workbook>`
  )
  const rels = spec.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
  rels.push(`<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`)
  if (spec.sharedStrings) rels.push(`<Relationship Id="rIdSS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`)
  put('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`)
  if (spec.styles !== null) put('xl/styles.xml', spec.styles ?? STYLES)
  if (spec.sharedStrings) {
    const si = spec.sharedStrings
      .map((s) => (typeof s === 'string' ? `<si><t xml:space="preserve">${esc(s)}</t></si>` : `<si>${s.runs.map((r) => `<r>${r.rPr ? `<rPr>${r.rPr}</rPr>` : ''}<t xml:space="preserve">${esc(r.text)}</t></r>`).join('')}</si>`))
      .join('')
    put('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${spec.sharedStrings.length}" uniqueCount="${spec.sharedStrings.length}">${si}</sst>`)
  }
  put(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides.join('')}</Types>`
  )
  put('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  for (const [k, v] of Object.entries(spec.files ?? {})) put(k, v)
  return zipSync(files)
}
