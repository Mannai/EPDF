/**
 * Recognises numbers in extracted text so spreadsheets get real numeric cells: plain integers/decimals,
 * thousands separators (US style), negatives (minus sign or parentheses), percentages and currency symbols.
 * Anything else (dates, phone numbers, codes with leading zeros, very long digit strings) stays text.
 */

export interface NumFormat {
  kind: 'number' | 'percent' | 'currency'
  decimals: number
  thousands: boolean
  /** Currency symbol for kind 'currency'. */
  symbol?: string
}

export interface ParsedNumber {
  value: number
  format: NumFormat
}

const CURRENCY = '$€£¥'
const MINUS = /^[-−–]/

export function parseNumber(input: string): ParsedNumber | null {
  let s = input.trim().replace(/ /g, ' ')
  if (!s || s.length > 40) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1).trim()
  }
  if (MINUS.test(s)) {
    negative = true
    s = s.slice(1).trim()
  }
  let symbol: string | undefined
  if (s.length && CURRENCY.includes(s[0])) {
    symbol = s[0]
    s = s.slice(1).trim()
    if (MINUS.test(s)) {
      negative = true
      s = s.slice(1).trim()
    }
  } else if (s.length && CURRENCY.includes(s[s.length - 1])) {
    symbol = s[s.length - 1]
    s = s.slice(0, -1).trim()
  }
  let percent = false
  if (s.endsWith('%')) {
    percent = true
    s = s.slice(0, -1).trim()
  }
  if (percent && symbol) return null
  const thousands = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)
  if (!thousands && !/^(\d+(\.\d+)?|\.\d+)$/.test(s)) return null
  const digits = s.replace(/,/g, '')
  if (digits.replace('.', '').length > 15) return null
  // "007" or "01234" are identifiers, not numbers
  if (!thousands && /^0\d/.test(digits) && !digits.includes('.')) return null
  const decimals = digits.includes('.') ? digits.length - digits.indexOf('.') - 1 : 0
  let value = parseFloat(digits)
  if (!Number.isFinite(value)) return null
  if (percent) value = value / 100
  if (negative) value = -value
  if (percent) return { value: Math.round(value * 1e12) / 1e12, format: { kind: 'percent', decimals, thousands: false } }
  if (symbol) return { value, format: { kind: 'currency', decimals, thousands, symbol } }
  return { value, format: { kind: 'number', decimals, thousands } }
}

/** The Excel number-format code for a format (`0.00`, `#,##0`, `0.0%`, `"$"#,##0.00`). */
export function formatCode(f: NumFormat): string {
  const dec = f.decimals > 0 ? '.' + '0'.repeat(Math.min(f.decimals, 15)) : ''
  if (f.kind === 'percent') return `0${dec}%`
  const body = (f.thousands || f.kind === 'currency' ? '#,##0' : '0') + dec
  return f.kind === 'currency' ? `"${f.symbol}"${body}` : body
}

const BUILTIN: Record<string, number> = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10 }

/** Built-in numFmtId for a code, or undefined when a custom format must be declared. */
export const builtinFormatId = (code: string): number | undefined => BUILTIN[code]
