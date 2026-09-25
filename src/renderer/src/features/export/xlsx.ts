import { appXml, colLetters, contentTypesXml, coreXml, CT, esc, escAttr, NS, REL, relsXml, XML_DECL, zipParts, type Parts, type Rel } from './ooxml'
import type { ExportOptions, PageLayout, TableBlock } from './model'
import { builtinFormatId, formatCode, parseNumber, type NumFormat } from './numbers'

/**
 * Writes an .xlsx (SpreadsheetML): detected tables become cell grids (numbers stored as numbers), everything
 * else one row per text line. Strings go through a shared string table.
 */

export interface SheetCell {
  value: string | number
  format?: NumFormat
  bold?: boolean
  align?: 'left' | 'center' | 'right'
}

export interface SheetData {
  name: string
  /** Row-major; `null` = empty cell. */
  rows: (SheetCell | null)[][]
}

const MAX_ROWS = 1_048_576
const MAX_COLS = 16_384
const MAX_TEXT = 32_767

/** A valid, unique sheet name: at most 31 characters, none of `[]:*?/\`, no leading/trailing apostrophe. */
export function sheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[[\]:*?/\\]/g, '-').replace(/^'+|'+$/g, '').replace(/[\u0000-\u001F]/g, '').trim() || 'Sheet'
  base = base.slice(0, 31)
  let name = base
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  used.add(name.toLowerCase())
  return name
}

export function cellFromText(text: string, opts: { bold?: boolean; align?: 'left' | 'center' | 'right' } = {}): SheetCell | null {
  const t = text.trim()
  if (!t) return null
  const n = parseNumber(t)
  if (n) return { value: n.value, format: n.format, bold: opts.bold, align: opts.align }
  return { value: t.slice(0, MAX_TEXT), bold: opts.bold, align: opts.align }
}

const alignOf = (a: string): 'left' | 'center' | 'right' | undefined => (a === 'right' ? 'right' : a === 'center' ? 'center' : undefined)

function rowsOfTable(t: TableBlock): (SheetCell | null)[][] {
  const headerRow = t.rows.length > 1 && t.rows[0].some((c) => c.text) && t.rows[0].every((c) => !c.text || c.bold)
  return t.rows.map((r, ri) => r.map((c) => cellFromText(c.text, { bold: headerRow && ri === 0 ? true : undefined, align: alignOf(c.align) })))
}

/** Decides what goes on which sheet. */
export function buildSheets(pages: PageLayout[], options: Pick<ExportOptions, 'xlsxMode'>): SheetData[] {
  const used = new Set<string>()
  const sheets: SheetData[] = []
  const tables: { page: number; t: TableBlock }[] = []
  for (const p of pages) for (const b of p.blocks) if (b.type === 'table') tables.push({ page: p.number, t: b })

  if (options.xlsxMode === 'tables' && tables.length > 0) {
    tables.forEach(({ t }, i) => sheets.push({ name: sheetName(`Table ${i + 1}`, used), rows: rowsOfTable(t) }))
    return sheets
  }
  for (const p of pages) {
    const rows: (SheetCell | null)[][] = []
    for (const b of p.blocks) {
      if (b.type === 'paragraph') {
        for (const line of b.srcLines) rows.push(line.map((s) => cellFromText(s, { bold: b.heading > 0 ? true : undefined })))
      } else if (b.type === 'table') rows.push(...rowsOfTable(b))
    }
    sheets.push({ name: sheetName(`Page ${p.number}`, used), rows })
  }
  return sheets
}

interface StyleKey {
  numFmtId: number
  bold: boolean
  align: string
}

export function buildXlsx(sheets: SheetData[], opts: { title?: string; now?: Date } = {}): Uint8Array {
  if (sheets.length === 0) sheets = [{ name: 'Sheet1', rows: [] }]
  // --- shared strings + styles -------------------------------------------------------------------
  const strings: string[] = []
  const stringIndex = new Map<string, number>()
  let stringRefs = 0
  const customFormats = new Map<string, number>() // code -> id
  const xfs: StyleKey[] = [{ numFmtId: 0, bold: false, align: '' }]
  const xfIndex = new Map<string, number>([['0|0|', 0]])
  const styleOf = (c: SheetCell): number => {
    let numFmtId = 0
    if (c.format) {
      const code = formatCode(c.format)
      const id = builtinFormatId(code)
      if (id !== undefined) numFmtId = id
      else {
        if (!customFormats.has(code)) customFormats.set(code, 164 + customFormats.size)
        numFmtId = customFormats.get(code)!
      }
    }
    const key = `${numFmtId}|${c.bold ? 1 : 0}|${c.align ?? ''}`
    let i = xfIndex.get(key)
    if (i === undefined) {
      i = xfs.length
      xfs.push({ numFmtId, bold: !!c.bold, align: c.align ?? '' })
      xfIndex.set(key, i)
    }
    return i
  }

  const sheetXml = sheets.map((s, si) => {
    const rows = s.rows.slice(0, MAX_ROWS)
    let maxCol = 0
    const widths: number[] = []
    let out = ''
    rows.forEach((row, ri) => {
      let cells = ''
      row.slice(0, MAX_COLS).forEach((c, ci) => {
        if (!c) return
        maxCol = Math.max(maxCol, ci + 1)
        const ref = `${colLetters(ci + 1)}${ri + 1}`
        const st = styleOf(c)
        const sAttr = st ? ` s="${st}"` : ''
        const len = typeof c.value === 'number' ? String(c.value).length + 2 : Math.min(c.value.length, 80)
        widths[ci] = Math.max(widths[ci] ?? 0, len)
        if (typeof c.value === 'number') {
          cells += `<c r="${ref}"${sAttr}><v>${Number.isFinite(c.value) ? String(c.value) : '0'}</v></c>`
        } else {
          let idx = stringIndex.get(c.value)
          if (idx === undefined) {
            idx = strings.length
            strings.push(c.value)
            stringIndex.set(c.value, idx)
          }
          stringRefs++
          cells += `<c r="${ref}"${sAttr} t="s"><v>${idx}</v></c>`
        }
      })
      if (cells) out += `<row r="${ri + 1}">${cells}</row>`
    })
    const cols = widths
      .map((w, i) => (w ? `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, w + 2))}" customWidth="1"/>` : ''))
      .join('')
    const dim = maxCol && rows.length ? `<dimension ref="A1:${colLetters(maxCol)}${rows.length}"/>` : '<dimension ref="A1"/>'
    return (
      XML_DECL +
      `<worksheet xmlns="${NS.x}" xmlns:r="${NS.r}">${dim}<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}/></sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
      (cols ? `<cols>${cols}</cols>` : '') +
      `<sheetData>${out}</sheetData></worksheet>`
    )
  })

  const sst =
    XML_DECL +
    `<sst xmlns="${NS.x}" count="${stringRefs}" uniqueCount="${strings.length}">` +
    strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') +
    '</sst>'

  const numFmts = [...customFormats.entries()]
  const styles =
    XML_DECL +
    `<styleSheet xmlns="${NS.x}">` +
    (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escAttr(code)}"/>`).join('')}</numFmts>` : '') +
    '<fonts count="2"><font><sz val="11"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="11"/><name val="Arial"/><family val="2"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">` +
    xfs
      .map(
        (x) =>
          `<xf numFmtId="${x.numFmtId}" fontId="${x.bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"${x.numFmtId ? ' applyNumberFormat="1"' : ''}${x.bold ? ' applyFont="1"' : ''}${x.align ? ' applyAlignment="1"' : ''}` +
          (x.align ? `><alignment horizontal="${x.align}"/></xf>` : '/>')
      )
      .join('') +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'

  const wbRels: Rel[] = sheets.map((_, i) => ({ id: `rId${i + 1}`, type: REL.worksheet, target: `worksheets/sheet${i + 1}.xml` }))
  wbRels.push({ id: `rId${sheets.length + 1}`, type: REL.styles, target: 'styles.xml' })
  wbRels.push({ id: `rId${sheets.length + 2}`, type: REL.sharedStrings, target: 'sharedStrings.xml' })
  const workbook =
    XML_DECL +
    `<workbook xmlns="${NS.x}" xmlns:r="${NS.r}"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets>` +
    sheets.map((s, i) => `<sheet name="${escAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>'

  const overrides: Record<string, string> = {
    '/xl/workbook.xml': CT.xlsx,
    '/xl/styles.xml': CT.xlsxStyles,
    '/xl/sharedStrings.xml': CT.xlsxStrings,
    '/docProps/core.xml': CT.core,
    '/docProps/app.xml': CT.app
  }
  sheets.forEach((_, i) => (overrides[`/xl/worksheets/sheet${i + 1}.xml`] = CT.xlsxSheet))
  const parts: Parts = {
    '[Content_Types].xml': contentTypesXml({ rels: CT.rels, xml: CT.xml }, overrides),
    '_rels/.rels': relsXml([
      { id: 'rId1', type: REL.officeDocument, target: 'xl/workbook.xml' },
      { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.extProps, target: 'docProps/app.xml' }
    ]),
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': relsXml(wbRels),
    'xl/styles.xml': styles,
    'xl/sharedStrings.xml': sst,
    'docProps/core.xml': coreXml(opts.title, opts.now ?? new Date()),
    'docProps/app.xml': appXml()
  }
  sheetXml.forEach((x, i) => (parts[`xl/worksheets/sheet${i + 1}.xml`] = x))
  return zipParts(parts)
}
