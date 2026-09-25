import { describe, expect, it } from 'vitest'
import { RegexBudgetError, RegexSyntaxError, RegexUnsupportedError, compileSafeRegex, validateRegex } from '../../src/renderer/src/features/redact/logic/safeRegex'

const native = (pattern: string, flags: string, text: string): [number, number][] => {
  const out: [number, number][] = []
  const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    out.push([m.index, m.index + m[0].length])
  }
  return out
}
const safe = (pattern: string, flags: string, text: string): [number, number][] => compileSafeRegex(pattern, flags).findAll(text).map((r) => [r.start, r.end])

const SAMPLE = [
  'The quick brown fox jumps over the lazy dog. Call 555-1234 or (555) 987-6543; mail me: a.b+c@example.org!',
  'aaa bbb aaab abab ababab 2024-03-15 and 15/03/2024, ID: AB123456C; total = $1,234.56 (approx.)',
  'Line one\nLine two\r\nLine three with TRAILING spaces   \nlast',
  'Ünïcödé Привет мир 你好 test_case CamelCaseWord snake_case_word 123abc abc123',
  'x'.repeat(30) + '!' + 'y'.repeat(30)
]

const PATTERNS: [string, string][] = [
  ['fox', ''],
  ['FOX', 'i'],
  ['\\d+', ''],
  ['\\d{3}-\\d{4}', ''],
  ['\\(\\d{3}\\) \\d{3}-\\d{4}', ''],
  ['[a-z]+@[a-z]+\\.[a-z]{2,}', ''],
  ['[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', ''],
  ['\\b\\w{5}\\b', ''],
  ['\\bthe\\b', 'i'],
  ['a+', ''],
  ['a+?', ''],
  ['a*b', ''],
  ['(ab)+', ''],
  ['(?:ab){2,3}', ''],
  ['(a|b)+', ''],
  ['(foo|bar|quick|lazy)', ''],
  ['^Line', 'm'],
  ['Line$', 'm'],
  ['^Line one$', 'm'],
  ['\\s+$', 'm'],
  ['(\\w)\\1', ''],
  ['(a)(b)?\\2', ''],
  ['\\d(?=abc)', ''],
  ['\\d(?!\\d)', ''],
  ['(?<=\\$)\\d[\\d,]*(\\.\\d+)?', ''],
  ['(?<!\\d)\\d{2}(?!\\d)', ''],
  ['(?<year>\\d{4})-(?<m>\\d{2})-(?<d>\\d{2})', ''],
  ['[A-Z]{2}\\d{6}[A-D]', ''],
  ['[^\\s]+', ''],
  ['.+', ''],
  ['.+', 's'],
  ['.*?TRAILING', 's'],
  ['\\p{L}+', 'u'],
  ['\\p{Lu}\\p{Ll}+', 'u'],
  ['[\\p{L}\\d_]+', 'u'],
  ['\\u4f60\\u597d', ''],
  ['\\x41\\x42', ''],
  ['x{5,10}', ''],
  ['x{5,}!', ''],
  ['y{0,3}$', ''],
  ['[a-c]{2,}', 'i'],
  ['\\$[0-9,]+\\.[0-9]{2}', ''],
  ['(\\d{1,3}(,\\d{3})*)(\\.\\d+)?', ''],
  ['a.c', ''],
  ['\\.', ''],
  ['[.]', ''],
  ['[\\]\\-]', ''],
  ['[a\\-z]', ''],
  ['\\/', ''],
  ['\\bB', ''],
  ['\\Bb', ''],
  ['[\\w-]+@', ''],
  ['^$', 'm'],
  ['(?:)', ''],
  ['é|ü|ö', ''],
  ['c|ca|cam', 'i'],
  ['(a*)*b', ''],
  ['(?=Line)Line \\w+', ''],
  ['[\\s\\S]{3}', ''],
  ['\\t|\\n', ''],
  ['\\r?\\n', '']
]

describe('the step-limited regular expression engine agrees with JavaScript', () => {
  for (const [p, f] of PATTERNS) {
    it(`/${p}/${f}`, () => {
      for (const text of SAMPLE) expect(safe(p, f, text), text.slice(0, 30)).toEqual(native(p, f, text))
    })
  }

  it('handles astral characters with the u flag (offsets stay UTF-16)', () => {
    const t = 'a😀b😀😀c'
    expect(safe('😀+', 'u', t)).toEqual(native('😀+', 'u', t))
    expect(safe('.', 'u', t).length).toBe(native('.', 'u', t).length)
    expect(safe('\\p{Emoji_Presentation}', 'u', t)).toEqual(native('\\p{Emoji_Presentation}', 'u', t))
  })

  it('handles long inputs without blowing the stack (simple loops are iterative)', () => {
    const t = 'a'.repeat(200_000)
    expect(safe('a+', '', t)).toEqual([[0, 200_000]])
    expect(safe('.*', '', t)).toEqual([[0, 200_000]])
    expect(safe('[a-z]{1,300}', '', 'a'.repeat(700)).length).toBe(3)
  })
})

describe('catastrophic backtracking is stopped', () => {
  const trap = 'a'.repeat(40) + '!'
  for (const p of ['(a+)+$', '(a|aa)+$', '(a*)*b', '(?:x+)+y', '(x+x+)+y']) {
    it(`/${p}/`, () => {
      const started = Date.now()
      const re = compileSafeRegex(p, '')
      const text = p.includes('x') ? 'x'.repeat(40) : trap
      expect(() => re.findAll(text, { maxSteps: 300_000, maxMs: 2000 })).toThrow(RegexBudgetError)
      expect(Date.now() - started).toBeLessThan(3000)
    })
  }

  it('the time limit alone also stops a pattern', () => {
    const re = compileSafeRegex('(a+)+$', '')
    expect(() => re.findAll('a'.repeat(60) + '!', { maxSteps: Number.MAX_SAFE_INTEGER, maxMs: 50 })).toThrow(RegexBudgetError)
  })

  it('the error explains what happened', () => {
    expect(new RegexBudgetError().message).toMatch(/too long/)
  })

  it('a well-behaved pattern on the same input finishes and is not throttled', () => {
    expect(compileSafeRegex('a{5}', '').findAll(trap).length).toBe(8)
  })
})

describe('validation', () => {
  it('reports syntax errors with the standard message', () => {
    for (const bad of ['a(', '(', ')', '[a', 'a**', '\\', '(?<n', 'a{2,1}', '*a', '+']) {
      const v = validateRegex(bad, '')
      expect(v.ok, bad).toBe(false)
    }
    expect(() => compileSafeRegex('a(', '')).toThrow(RegexSyntaxError)
  })

  it('refuses what it cannot run rather than guessing', () => {
    expect(() => compileSafeRegex('a{5000}', '')).toThrow(RegexUnsupportedError)
    expect(() => compileSafeRegex('(?i)a', '')).toThrow()
    expect(() => compileSafeRegex('x'.repeat(2100), '')).toThrow(RegexUnsupportedError)
    expect(validateRegex('', '').ok).toBe(false)
    expect(validateRegex('a', 'z').ok).toBe(false)
  })

  it('accepts ordinary patterns', () => {
    for (const ok of ['\\d+', '[A-Z]{2}\\d{6}', '(?<a>x)\\k<a>', '\\bfoo\\b', 'a|b|c', '(?<=x)y']) expect(validateRegex(ok, '').ok, ok).toBe(true)
  })

  it('an empty match set is fine and empty matches are skipped', () => {
    expect(safe('x*', '', 'abc')).toEqual([])
    expect(safe('nomatch', '', 'abc')).toEqual([])
  })
})
