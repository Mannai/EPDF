import type { DateFormat, Digits, HeaderFooterSettings, NumberStyle } from '../../../../../shared/features/headerfooter'

/**
 * Tokens in header/footer text and how numbers and dates are written in every number system.
 *
 *   {page}   the page number (in the chosen number style)      {pages}  the last number of the range
 *   {date}   the date of applying (chosen format and digits)   {file}   the document's file name
 *   {bates}  the Bates number (prefix + zero-padded number + suffix)
 *   {{ and }} write a literal brace.
 *
 * Pure: no PDF library, no DOM.
 */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹'

/** Replaces the ASCII digits of `s` with the digits of `digits`. */
export function withDigits(s: string, digits: Digits): string {
  if (digits === 'latin') return s
  const set = digits === 'arabic-indic' ? ARABIC_INDIC : PERSIAN
  return s.replace(/[0-9]/g, (d) => set[d.charCodeAt(0) - 48]!)
}

const ROMAN: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I']
]

/** Roman numeral of 1..3999; anything else (0, negative, larger, fractional) is written with Western digits. */
export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 3999) return String(n)
  let out = ''
  let rest = n
  for (const [v, s] of ROMAN) {
    while (rest >= v) {
      out += s
      rest -= v
    }
  }
  return out
}

export function formatNumber(n: number, style: NumberStyle): string {
  switch (style) {
    case 'decimal':
      return String(n)
    case 'roman-upper':
      return toRoman(n)
    case 'roman-lower':
      return toRoman(n).toLowerCase()
    case 'arabic-indic':
      return withDigits(String(n), 'arabic-indic')
    case 'persian':
      return withDigits(String(n), 'persian')
  }
}

export const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** Gregorian month names as used across the Arab world (Egypt, the Gulf, the Maghreb in writing). */
export const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Formats a (local) date. Month names follow `months`; all digits follow `digits`. Deterministic (no Intl). */
export function formatDate(d: Date, format: DateFormat, digits: Digits, months: 'en' | 'ar'): string {
  const day = d.getDate()
  const month = d.getMonth()
  const year = d.getFullYear()
  const name = (months === 'ar' ? MONTHS_AR : MONTHS_EN)[month]!
  let s: string
  switch (format) {
    case 'd/m/yyyy':
      s = `${day}/${month + 1}/${year}`
      break
    case 'm/d/yyyy':
      s = `${month + 1}/${day}/${year}`
      break
    case 'yyyy-mm-dd':
      s = `${year}-${pad2(month + 1)}-${pad2(day)}`
      break
    case 'dd.mm.yyyy':
      s = `${pad2(day)}.${pad2(month + 1)}.${year}`
      break
    case 'd mmmm yyyy':
      s = `${day} ${name} ${year}`
      break
    case 'mmmm d, yyyy':
      // An Arabic "month day, year" puts the Arabic comma.
      s = months === 'ar' ? `${name} ${day}، ${year}` : `${name} ${day}, ${year}`
      break
  }
  return withDigits(s, digits)
}

/** Bates number: prefix + number zero-padded to `digits` + suffix (numbers wider than `digits` are not cut). */
export function formatBates(n: number, b: HeaderFooterSettings['bates']): string {
  return `${b.prefix}${String(n).padStart(b.digits, '0')}${b.suffix}`
}

export interface TokenValues {
  page: string
  pages: string
  date: string
  file: string
  bates: string
}

const TOKEN_RE = /\{\{|\}\}|\{(page|pages|date|file|bates)\}/g

/** Replaces the tokens of `template`. Unknown `{words}` stay as typed. */
export function expandTokens(template: string, v: TokenValues): string {
  return template.replace(TOKEN_RE, (m, key: keyof TokenValues | undefined) => (m === '{{' ? '{' : m === '}}' ? '}' : v[key!]))
}

export const usesToken = (template: string, token: keyof TokenValues): boolean => template.includes(`{${token}}`)

export interface NumberingContext {
  /** 0-based index of the page in the document. */
  pageIndex: number
  /** 0-based index of the first page of the selection. */
  firstIndex: number
  /** 0-based index of the last page of the selection. */
  lastIndex: number
  /** Position of this page among the pages that get the mark (0 = first), for Bates. */
  ordinal: number
  fileName: string
  now: Date
}

/**
 * Token values for one page. Page numbers count pages from the first page of the range (so odd/even pages keep
 * their real sequence: pages 1, 3, 5 of "odd" show 1, 3, 5); `{pages}` is the number of the last page of the range.
 * Bates numbers count only the pages that are stamped.
 */
export function tokenValues(s: HeaderFooterSettings, c: NumberingContext): TokenValues {
  return {
    page: formatNumber(s.startNumber + (c.pageIndex - c.firstIndex), s.numberStyle),
    pages: formatNumber(s.startNumber + (c.lastIndex - c.firstIndex), s.numberStyle),
    date: formatDate(c.now, s.date.format, s.date.digits, s.date.months),
    file: c.fileName,
    bates: formatBates(s.bates.start + c.ordinal, s.bates)
  }
}
