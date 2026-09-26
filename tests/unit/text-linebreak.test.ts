import { describe, expect, it } from 'vitest'
import { BREAK_ALLOWED, BREAK_MANDATORY, BREAK_NONE, lineBreakOpportunities } from '../../src/shared/text/linebreak'

/** Break opportunities as the indices where a line may break (before that UTF-16 index). */
const breaks = (text: string, opts: Parameters<typeof lineBreakOpportunities>[1] = {}): number[] => {
  const r = lineBreakOpportunities(text, opts)
  const out: number[] = []
  for (let i = 1; i < text.length; i++) if (r[i] !== BREAK_NONE) out.push(i)
  return out
}
const at = (text: string, index: number): number => lineBreakOpportunities(text)[index]!

describe('line breaking: Latin and general rules (UAX #14)', () => {
  it('breaks after spaces, not inside words', () => {
    expect(breaks('hello big world')).toEqual([6, 10])
  })
  it('never breaks before closing punctuation or after opening brackets', () => {
    expect(breaks('a (b) c, d.')).toEqual([2, 6, 9])
    expect(at('word,next', 5)).toBe(BREAK_NONE)
    expect(at('(word)', 1)).toBe(BREAK_NONE)
  })
  it('does not break inside numbers or between a number and its unit sign', () => {
    expect(breaks('1,000.50')).toEqual([])
    expect(breaks('50%')).toEqual([])
    expect(breaks('$100')).toEqual([])
  })
  it('breaks after a hyphen but not before one, and respects non-breaking spaces', () => {
    expect(at('well-known', 5)).toBe(BREAK_ALLOWED)
    expect(at('a b', 1)).toBe(BREAK_NONE)
    expect(at('a b', 2)).toBe(BREAK_NONE)
    expect(at('a⁠b', 1)).toBe(BREAK_NONE)
    expect(at('a​b', 2)).toBe(BREAK_ALLOWED)
  })
  it('makes newlines mandatory and CRLF a single break', () => {
    expect(at('a\nb', 2)).toBe(BREAK_MANDATORY)
    expect(at('a\r\nb', 3)).toBe(BREAK_MANDATORY)
    expect(at('a\r\nb', 2)).toBe(BREAK_NONE)
    expect(lineBreakOpportunities('abc')[3]).toBe(BREAK_MANDATORY)
  })
  it('keeps combining marks with their base', () => {
    expect(at('é x', 1)).toBe(BREAK_NONE)
  })
  it('never splits a regional-indicator flag pair', () => {
    const flags = '\u{1f1e9}\u{1f1ea}\u{1f1eb}\u{1f1f7}'
    expect(at(flags, 2)).toBe(BREAK_NONE)
    expect(at(flags, 4)).toBe(BREAK_ALLOWED)
  })
})

describe('line breaking: Arabic and Hebrew', () => {
  it('breaks between words only', () => {
    expect(breaks('مرحبا بالعالم اليوم')).toEqual([6, 14])
    expect(breaks('שלום עולם')).toEqual([5])
  })
  it('does not break Arabic punctuation away from its word', () => {
    expect(at('نعم، شكرا', 3)).toBe(BREAK_NONE) // before the Arabic comma
    expect(at('ماذا؟ هنا', 4)).toBe(BREAK_NONE) // before the Arabic question mark
  })
})

describe('line breaking: Thai (dictionary segmentation) and CJK (kinsoku)', () => {
  it('breaks Thai at word boundaries although it has no spaces', () => {
    const t = 'สวัสดีชาวโลก'
    const b = breaks(t, { lang: 'th' })
    expect(b.length).toBeGreaterThanOrEqual(1)
    expect(b).toContain(6) // สวัสดี | ชาว...
    // never inside a combining-mark cluster
    for (const i of b) expect(/\p{M}/u.test(t[i]!)).toBe(false)
  })
  it('breaks Chinese and Japanese between any two ideographs', () => {
    expect(breaks('你好世界')).toEqual([1, 2, 3])
    expect(breaks('日本語')).toEqual([1, 2])
  })
  it('applies kinsoku: no break before closing punctuation, small kana or the prolonged sound mark, none after an opening bracket', () => {
    expect(at('你好。世界', 2)).toBe(BREAK_NONE)
    expect(at('你好、世界', 2)).toBe(BREAK_NONE)
    expect(at('「你好」', 1)).toBe(BREAK_NONE)
    expect(at('「你好」', 3)).toBe(BREAK_NONE)
    expect(at('きゃっと', 1)).toBe(BREAK_NONE) // small ゃ
    expect(at('コーヒー', 1)).toBe(BREAK_NONE) // ー
    expect(at('コーヒー', 2)).toBe(BREAK_ALLOWED)
  })
  it("'phrase' word-break keeps dictionary words together", () => {
    const t = '我们喜欢学习中文'
    const normal = breaks(t, { lang: 'zh' })
    const phrase = breaks(t, { lang: 'zh', wordBreak: 'phrase' })
    expect(phrase.length).toBeLessThan(normal.length)
  })
  it('lets Hangul wrap between syllables (default) and at spaces', () => {
    expect(breaks('안녕 하세요')).toContain(3)
  })
})
