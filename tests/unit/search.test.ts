import { describe, expect, it } from 'vitest'
import { buildPageText, buildRegex, findMatches, itemIndexAt } from '../../src/renderer/src/pdf/search'

const opts = { matchCase: false, wholeWord: false }
const find = (text: string, q: string, o = opts) => findMatches(text, buildRegex(q, o)!)

describe('buildPageText', () => {
  it('skips marked-content items and records item offsets', () => {
    const pt = buildPageText([{ str: 'Hello ' }, { type: 'beginMarkedContent' } as never, { str: 'world', hasEOL: true }, { str: 'Next' }])
    expect(pt.text).toBe('Hello world\nNext')
    expect(pt.itemStarts).toEqual([0, 6, 12])
  })
  it('normalizes non-breaking spaces without changing length', () => {
    expect(buildPageText([{ str: 'a b' }]).text).toBe('a b')
  })
})

describe('buildRegex / findMatches', () => {
  it('returns null for blank queries', () => {
    expect(buildRegex('   ', opts)).toBeNull()
  })
  it('is case-insensitive by default and case-sensitive on request', () => {
    expect(find('Needle needle NEEDLE', 'needle')).toHaveLength(3)
    expect(find('Needle needle NEEDLE', 'needle', { ...opts, matchCase: true })).toHaveLength(1)
  })
  it('treats regex metacharacters literally', () => {
    expect(find('cost: $5.00 (approx) [x]', '$5.00')).toEqual([{ start: 6, end: 11 }])
    expect(find('a.b axb', 'a.b')).toHaveLength(1)
    expect(find('f(x) [y]', '(x)')).toHaveLength(1)
  })
  it('matches across any whitespace run, including line breaks', () => {
    expect(find('hello\nworld and hello   world', 'hello world')).toHaveLength(2)
  })
  it('supports whole-word matching, including Unicode letters', () => {
    const w = { ...opts, wholeWord: true }
    expect(find('cat concat cat.', 'cat', w)).toHaveLength(2)
    expect(find('élan vital', 'lan', w)).toHaveLength(0)
    expect(find('élan vital', 'élan', w)).toHaveLength(1)
  })
  it('never loops on pathological input', () => {
    expect(find('aaaa', 'a')).toHaveLength(4)
    expect(find('', 'a')).toEqual([])
  })
})

describe('itemIndexAt', () => {
  const starts = [0, 6, 12, 20]
  it('maps character offsets to text items', () => {
    expect(itemIndexAt(starts, 0)).toBe(0)
    expect(itemIndexAt(starts, 5)).toBe(0)
    expect(itemIndexAt(starts, 6)).toBe(1)
    expect(itemIndexAt(starts, 19)).toBe(2)
    expect(itemIndexAt(starts, 999)).toBe(3)
  })
  it('handles a single item', () => {
    expect(itemIndexAt([0], 3)).toBe(0)
  })
})
