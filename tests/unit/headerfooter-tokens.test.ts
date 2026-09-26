import { describe, expect, it } from 'vitest'
import { defaultHeaderFooter } from '../../src/shared/features/headerfooter'
import { expandTokens, formatBates, formatDate, formatNumber, toRoman, tokenValues, withDigits } from '../../src/renderer/src/features/headerfooter/pdf/tokens'

describe('number systems', () => {
  it('decimal, roman, Arabic-Indic and Persian digits', () => {
    expect([1, 9, 10, 2026].map((n) => formatNumber(n, 'decimal'))).toEqual(['1', '9', '10', '2026'])
    expect([1, 4, 9, 14, 40, 90, 400, 1994, 2026, 3999].map((n) => formatNumber(n, 'roman-upper'))).toEqual(['I', 'IV', 'IX', 'XIV', 'XL', 'XC', 'CD', 'MCMXCIV', 'MMXXVI', 'MMMCMXCIX'])
    expect(formatNumber(14, 'roman-lower')).toBe('xiv')
    expect([0, 1, 2, 3, 10, 123, 9876].map((n) => formatNumber(n, 'arabic-indic'))).toEqual(['٠', '١', '٢', '٣', '١٠', '١٢٣', '٩٨٧٦'])
    expect([0, 4, 5, 6, 1405].map((n) => formatNumber(n, 'persian'))).toEqual(['۰', '۴', '۵', '۶', '۱۴۰۵'])
  })

  it('roman numerals outside 1..3999 fall back to Western digits', () => {
    expect(toRoman(0)).toBe('0')
    expect(toRoman(4000)).toBe('4000')
    expect(toRoman(-3)).toBe('-3')
  })

  it('withDigits only touches ASCII digits', () => {
    expect(withDigits('Page 12 of 30 (v2)', 'arabic-indic')).toBe('Page ١٢ of ٣٠ (v٢)')
    expect(withDigits('abc', 'persian')).toBe('abc')
  })
})

describe('dates', () => {
  const d = new Date(2026, 8, 6) // 6 September 2026, local time
  it('numeric formats', () => {
    expect(formatDate(d, 'd/m/yyyy', 'latin', 'en')).toBe('6/9/2026')
    expect(formatDate(d, 'm/d/yyyy', 'latin', 'en')).toBe('9/6/2026')
    expect(formatDate(d, 'yyyy-mm-dd', 'latin', 'en')).toBe('2026-09-06')
    expect(formatDate(d, 'dd.mm.yyyy', 'latin', 'en')).toBe('06.09.2026')
  })
  it('month names in English and Arabic, digits in any system', () => {
    expect(formatDate(d, 'd mmmm yyyy', 'latin', 'en')).toBe('6 September 2026')
    expect(formatDate(d, 'mmmm d, yyyy', 'latin', 'en')).toBe('September 6, 2026')
    expect(formatDate(d, 'd mmmm yyyy', 'arabic-indic', 'ar')).toBe('٦ سبتمبر ٢٠٢٦')
    expect(formatDate(d, 'mmmm d, yyyy', 'arabic-indic', 'ar')).toBe('سبتمبر ٦، ٢٠٢٦')
    expect(formatDate(d, 'd/m/yyyy', 'arabic-indic', 'ar')).toBe('٦/٩/٢٠٢٦')
    expect(formatDate(d, 'yyyy-mm-dd', 'persian', 'en')).toBe('۲۰۲۶-۰۹-۰۶')
    expect(formatDate(new Date(2026, 0, 31), 'd mmmm yyyy', 'latin', 'ar')).toBe('31 يناير 2026')
    expect(formatDate(new Date(2026, 11, 1), 'd mmmm yyyy', 'latin', 'ar')).toBe('1 ديسمبر 2026')
  })
})

describe('Bates numbers', () => {
  it('prefix, zero padding, suffix; never cut', () => {
    const b = { prefix: 'ACME-', suffix: '-C', digits: 6, start: 1 }
    expect(formatBates(1, b)).toBe('ACME-000001-C')
    expect(formatBates(123456, b)).toBe('ACME-123456-C')
    expect(formatBates(1234567, b)).toBe('ACME-1234567-C')
    expect(formatBates(7, { ...b, prefix: 'مستند ', digits: 3, suffix: '' })).toBe('مستند 007')
  })
})

describe('tokens', () => {
  const now = new Date(2026, 8, 26)
  const base = (over: Partial<ReturnType<typeof defaultHeaderFooter>> = {}): ReturnType<typeof defaultHeaderFooter> => ({ ...defaultHeaderFooter(), ...over })

  it('expands every token, keeps unknown ones, escapes braces', () => {
    const v = { page: '3', pages: '9', date: 'D', file: 'report.pdf', bates: 'B-001' }
    expect(expandTokens('Page {page} of {pages} · {date} · {file} · {bates}', v)).toBe('Page 3 of 9 · D · report.pdf · B-001')
    expect(expandTokens('{unknown} {{page}} {page}', v)).toBe('{unknown} {page} 3')
    expect(expandTokens('صفحة {page} من {pages}', v)).toBe('صفحة 3 من 9')
  })

  it('page numbers count from the first page of the range; {pages} is the last number', () => {
    const s = base({ startNumber: 1 })
    const ctx = { firstIndex: 2, lastIndex: 9, ordinal: 0, fileName: 'f', now }
    expect(tokenValues(s, { ...ctx, pageIndex: 2 }).page).toBe('1')
    expect(tokenValues(s, { ...ctx, pageIndex: 5 }).page).toBe('4')
    expect(tokenValues(s, { ...ctx, pageIndex: 5 }).pages).toBe('8')
    const s2 = base({ startNumber: 10, numberStyle: 'roman-lower' })
    expect(tokenValues(s2, { ...ctx, pageIndex: 3 }).page).toBe('xi')
  })

  it('Arabic "صفحة ١ من ٣" with Arabic-Indic digits', () => {
    const s = base({ numberStyle: 'arabic-indic' })
    const v = tokenValues(s, { pageIndex: 0, firstIndex: 0, lastIndex: 2, ordinal: 0, fileName: 'f', now })
    expect(expandTokens('صفحة {page} من {pages}', v)).toBe('صفحة ١ من ٣')
  })

  it('Bates follows the stamped pages (ordinal), not the page index', () => {
    const s = base({ bates: { prefix: 'X', suffix: '', digits: 4, start: 100 } })
    expect(tokenValues(s, { pageIndex: 7, firstIndex: 0, lastIndex: 9, ordinal: 3, fileName: 'f', now }).bates).toBe('X0103')
  })

  it('dates use the chosen format, months and digits', () => {
    const s = base({ date: { format: 'd mmmm yyyy', digits: 'arabic-indic', months: 'ar' } })
    expect(tokenValues(s, { pageIndex: 0, firstIndex: 0, lastIndex: 0, ordinal: 0, fileName: 'f', now }).date).toBe('٢٦ سبتمبر ٢٠٢٦')
  })
})
