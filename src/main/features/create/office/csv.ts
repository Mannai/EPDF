import { OfficeError, throwIfCancelled, type ConvertEnv } from './env'
import type { Page } from './ops'
import { DEFAULT_CELL_STYLE, layoutRuns, layoutSheet, newSheet, setCell, type BorderLine, type CellFont, type CellStyle } from './sheet'
import { decodeText } from './text'

/** Parses delimiter-separated text (RFC 4180: quoted fields, doubled quotes, embedded newlines). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  let fieldStarted = false
  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true
      fieldStarted = true
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      fieldStarted = false
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      fieldStarted = false
      i++
      continue
    }
    field += ch
    fieldStarted = true
    i++
  }
  if (field !== '' || row.length > 0 || fieldStarted) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Picks the delimiter that yields the most consistent number of columns in the first lines. */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 20000)
  let best = ','
  let bestScore = -1
  for (const d of [',', ';', '\t', '|']) {
    const rows = parseCsv(sample, d).slice(0, 30)
    if (rows.length === 0) continue
    const counts = rows.map((r) => r.length)
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)]
    const consistent = counts.filter((c) => c === mode).length
    const score = mode > 1 ? consistent * 1000 + mode : 0
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

const NUMERIC = /^[-+]?[$€£¥]?\s?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?([eE][-+]?\d+)?%?$|^[-+]?[$€£¥]?\.\d+%?$/

const FONT: CellFont = { family: 'Liberation Sans', size: 10, bold: false, italic: false, underline: false, strike: false, color: '#000000' }
const GRID: BorderLine = { width: 0.5, color: '#b0b0b0', style: 'single' }

/** CSV -> table pages: bold shaded header row repeated on every page, auto widths, right-aligned numbers. */
export function convertCsv(bytes: Uint8Array, env: ConvertEnv): Page[] {
  const text = decodeText(bytes)
  if (!text.trim()) throw new OfficeError('This CSV file is empty.')
  const delim = detectDelimiter(text)
  const rows = parseCsv(text, delim)
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const sheet = newSheet('CSV', env.page)
  sheet.defaultRowHeight = 14
  sheet.print.gridLines = false
  sheet.print.margins = { left: 36, right: 36, top: 40, bottom: 40, header: 18, footer: 18 }
  const base: CellStyle = { ...DEFAULT_CELL_STYLE, font: FONT, wrap: true, v: 'top', borders: { left: GRID, right: GRID, top: GRID, bottom: GRID } }
  const head: CellStyle = { ...base, font: { ...FONT, bold: true }, fill: '#e6e6e6' }
  const CAP = 260
  const colW: number[] = Array(maxCols).fill(30)
  rows.forEach((row, ri) => {
    if (ri % 500 === 0) throwIfCancelled(env)
    row.forEach((val, ci) => {
      const style = ri === 0 ? head : base
      const isNum = ri > 0 && NUMERIC.test(val.trim())
      setCell(sheet, ri, ci, { text: val, kind: isNum ? 'number' : val ? 'text' : 'empty', style: isNum ? { ...style, wrap: false } : style })
      if (val) {
        const lines = layoutRuns(env, [{ text: val, font: style.font }], 1e9, false)
        const w = Math.min(CAP, lines[0].w + 10)
        if (w > colW[ci]) colW[ci] = w
      }
    })
    if (ri % 2000 === 1999) env.progress(0.5 * (ri / rows.length))
  })
  colW.forEach((w, i) => sheet.colWidths.set(i, w))
  // A row that is shorter than the widest keeps empty bordered cells so the grid stays regular.
  rows.forEach((row, ri) => {
    for (let ci = row.length; ci < maxCols; ci++) setCell(sheet, ri, ci, { text: '', kind: 'empty', style: ri === 0 ? head : base })
  })
  const total = colW.reduce((s, w) => s + w, 0)
  const portraitW = env.page.width - 72
  const landscape = total > portraitW
  const paper = landscape ? { w: Math.max(env.page.width, env.page.height), h: Math.min(env.page.width, env.page.height) } : { w: env.page.width, h: env.page.height }
  sheet.print.paper = paper
  sheet.print.fit = { w: 1, h: 0 }
  sheet.print.fitMinScale = 0.6
  sheet.print.titleRows = [0, 0]
  sheet.print.footer = { differentFirst: false, differentOddEven: false, odd: { left: [], center: [{ field: 'page', size: 9 }, { text: ' / ', size: 9 }, { field: 'pages', size: 9 }], right: [] } }
  if (rows.length === 0) throw new OfficeError('This CSV file is empty.')
  return layoutSheet(sheet, env)
}
