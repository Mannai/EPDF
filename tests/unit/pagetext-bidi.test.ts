import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { visualToLogicalOrder, visualToLogicalText } from '../../src/shared/pagetext/visual'
import { analyzeBidi, lineLevels, reorderVisual } from '../../src/shared/text/bidi'

/**
 * Visual -> logical reordering (src/shared/pagetext/visual.ts), checked against the forward Unicode Bidirectional
 * Algorithm (bidi-js, itself verified against the official test vectors in text-bidi.test.ts):
 *   - the official BidiCharacterTest sample, read BACKWARDS: from the resolved visual order to a logical order;
 *   - 6,000 generated sentences mixing Arabic/Hebrew, Latin, numbers (Western, Arabic-Indic, Persian), dates, times,
 *     currencies, percentages, brackets and punctuation, in both paragraph directions;
 *   - the exact cases of the bug report.
 * "Valid" = the reading displays exactly like the visual order under the UBA. The UBA is not injective, so a valid
 * reading can differ from the typed original; how often the original is recovered is measured and bounded below.
 */

const forward = (text: string, para: 0 | 1): number[] => reorderVisual(lineLevels(analyzeBidi(text, para ? 'rtl' : 'ltr'), 0, text.length, para))

describe('BidiCharacterTest sample, inverted', () => {
  const lines = readFileSync('tests/fixtures/unicode/BidiCharacterTest.sample.txt', 'utf8').split('\n')
  let cases = 0
  let valid = 0
  let original = 0
  const failures: string[] = []
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue
    const f = line.split(';')
    const cps = f[0].trim().split(/\s+/).map((h) => parseInt(h, 16))
    const text = String.fromCodePoint(...cps)
    // explicit embeddings/overrides and other X9-removed characters are not drawn, so they cannot be recovered
    if (cps.some((c) => c > 0xffff) || /[‪-‮­​⁠﻿]/.test(text)) continue
    const para = Number(f[2]) as 0 | 1
    const order = f[4].trim() ? f[4].trim().split(/\s+/).map(Number) : []
    const chars = [...text]
    if (order.length !== chars.length) continue
    const visual = order.map((i) => chars[i])
    const r = visualToLogicalOrder(visual.map((t, i) => ({ text: t, seq: i })), para)
    const logical = r.order.map((i) => visual[i]).join('')
    cases++
    const display = forward(logical, para).map((i) => logical[i]).join('')
    if (display === visual.join('')) valid++
    else if (failures.length < 5) failures.push(`${f[0]} (para ${para})`)
    if (logical === text) original++
  }
  it('inverts every case to a reading that displays identically', () => {
    expect(cases).toBeGreaterThan(2500)
    expect(failures).toEqual([])
    expect(valid).toBe(cases)
  })
  it('recovers the original text in most cases (the rest are genuine ambiguities)', () => {
    console.log(`BidiCharacterTest sample: ${cases} cases, valid ${valid}, original recovered ${((100 * original) / cases).toFixed(1)}%`)
    expect(original / cases).toBeGreaterThan(0.95)
  })
})

describe('generated mixed-direction sentences', () => {
  let seed = 20260926
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
  const AR = ['مرحبا', 'بالعالم', 'الطلب', 'رقم', 'بتاريخ', 'السعر', 'دينار', 'كتاب', 'في', 'من', 'إلى', 'على', 'فارسی', 'دنیا']
  const HE = ['שלום', 'עולם', 'טקסט', 'בעברית', 'ספר']
  const LA = ['Epdf', 'PDF', 'hello', 'World', 'v2']
  const NUM = ['12345', '42', '3.14', '١٢٣', '١٢٣٫٥٠', '2026-09-26', '12:30', '95%', '$5', '+966', '1,234.50', '۱۴۰۵']
  const PUN = ['.', '،', '!', '؟', ':', '-']
  const sentence = (rtl: readonly string[]): string => {
    const parts: string[] = []
    for (let i = 0, k = 3 + Math.floor(rnd() * 7); i < k; i++) {
      const x = rnd()
      if (x < 0.55) parts.push(pick(rtl))
      else if (x < 0.7) parts.push(pick(LA))
      else if (x < 0.88) parts.push(pick(NUM))
      else if (x < 0.94) parts.push(`(${pick(rnd() < 0.5 ? rtl : LA)})`)
      else parts.push(`[${pick(NUM)}]`)
    }
    return parts.join(' ') + (rnd() < 0.5 ? pick(PUN) : '')
  }
  const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[' }
  for (const [label, words, para, minOriginal] of [
    ['Arabic, right-to-left paragraphs', AR, 1, 0.88],
    ['Hebrew, right-to-left paragraphs', HE, 1, 0.88],
    ['left-to-right paragraphs with Arabic', AR, 0, 0.7]
  ] as const) {
    it(`${label}: 2,000 sentences`, () => {
      let valid = 0
      let original = 0
      for (let t = 0; t < 2000; t++) {
        const s = para ? sentence(words) : `The ${sentence(words)} end`
        const chars = [...s]
        // a producer that maps each glyph to the character typed (LibreOffice, Skia, the text engine)
        const visual = forward(s, para).map((i) => chars[i])
        const r = visualToLogicalOrder(visual.map((ch, i) => ({ text: ch, seq: i })), para)
        const logical = r.order.map((i) => (r.mirror[i] ? (MIRROR[visual[i]] ?? visual[i]) : visual[i])).join('')
        if (forward(logical, para).map((i) => logical[i]).join('') === visual.join('')) valid++
        if (logical === s) original++
      }
      console.log(`${label}: valid ${valid}/2000, original recovered ${((100 * original) / 2000).toFixed(1)}%`)
      expect(valid).toBe(2000)
      expect(original / 2000).toBeGreaterThan(minOriginal)
    })
  }
})

describe('the cases of the bug report and friends', () => {
  const cases: [string, 'rtl' | 'ltr'][] = [
    ['مرحبا بالعالم', 'rtl'],
    ['رقم الطلب 12345 بتاريخ 2026-09-26 (Epdf)', 'rtl'],
    ['السعر ١٢٣٫٥٠ دينار بحريني', 'rtl'],
    ['هل تعلم؟ نعم، أعلم! «اقتباس» [قوس] {معقوف}', 'rtl'],
    ['نسبة النجاح 95% في عام 2025م', 'rtl'],
    ['برنامج Epdf لتحرير ملفات PDF بسهولة', 'rtl'],
    ['شلومو: שלום עולם 2026.', 'rtl'],
    ['The word مرحبا means hello.', 'ltr'],
    ['English first, then عربي، then English again.', 'ltr']
  ]
  it('the UBA display of each, stored with the typed characters, reads back as typed', () => {
    for (const [s, dir] of cases) {
      const chars = [...s]
      const visual = forward(s, dir === 'rtl' ? 1 : 0).map((i) => chars[i]).join('')
      expect(visualToLogicalText(visual, dir), s).toBe(s)
    }
  })
  it('the date: displayed 26-09-2026 in Arabic context, read back as 2026-09-26', () => {
    // what LibreOffice draws, left to right: ")Epdf( 26-09-2026 خيراتب 12345 بلطلا مقر"
    expect(visualToLogicalText(')Epdf( 26-09-2026 خيراتب 12345 بلطلا مقر', 'rtl')).toBe('رقم الطلب 12345 بتاريخ 2026-09-26 (Epdf)')
  })
  it('brackets stored as the shapes drawn (legacy producers) are mirrored back', () => {
    expect(visualToLogicalText('(Epdf) 26-09-2026 خيراتب 12345 بلطلا مقر', 'rtl')).toBe('رقم الطلب 12345 بتاريخ 2026-09-26 (Epdf)')
  })
  it('a line stored by a producer that ignored the bidi algorithm falls back to reverse-and-keep-LTR-runs', () => {
    // "الأمن Security 2.0" stored as a naive reversal: no logical text displays like that under the UBA
    const r = visualToLogicalOrder([...'2.0 Security نمألا'].map((t, i) => ({ text: t, seq: i })), 1)
    expect(r.exact).toBe(false)
    expect(r.order.map((i) => '2.0 Security نمألا'[i]).join('')).toBe('الأمن Security 2.0')
  })
  it('left-to-right lines without right-to-left text are returned as drawn (fast path)', () => {
    expect(visualToLogicalText('Plain (text) 12:30, 95%', 'ltr')).toBe('Plain (text) 12:30, 95%')
  })
})
