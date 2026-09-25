import { describe, expect, it } from 'vitest'
import { alignPages, fingerprint, fingerprintSimilarity } from '../../src/renderer/src/features/compare/diff/align'
import { rng } from './helpers/compareItems'

const VOCAB = Array.from({ length: 400 }, (_, i) => `w${i.toString(36)}x${(i * 7919) % 1000}`)

/** Distinct pseudo-random text for "page id": the same id always yields the same page. */
function pageText(id: number, words = 120): string[] {
  const r = rng(id * 7919 + 13)
  return Array.from({ length: words }, () => VOCAB[Math.floor(r() * VOCAB.length)])
}

const doc = (ids: number[]): string[][] => ids.map((i) => (i < 0 ? [] : pageText(i)))
const ids = (pairs: ReturnType<typeof alignPages>): string[] => pairs.map((p) => `${p.old ?? '-'}:${p.new ?? '-'}${p.moved ? 'm' : ''}`)

describe('page alignment', () => {
  it('identical documents pair page i with page i', () => {
    const pairs = alignPages(doc([1, 2, 3, 4]), doc([1, 2, 3, 4]))
    expect(ids(pairs)).toEqual(['1:1', '2:2', '3:3', '4:4'])
    expect(pairs.every((p) => p.similarity === 1)).toBe(true)
  })

  it('an inserted page is new-only and later pages keep their partners', () => {
    expect(ids(alignPages(doc([1, 2, 3]), doc([1, 2, 99, 3])))).toEqual(['1:1', '2:2', '-:3', '3:4'])
    expect(ids(alignPages(doc([1, 2, 3]), doc([99, 1, 2, 3])))).toEqual(['-:1', '1:2', '2:3', '3:4'])
    expect(ids(alignPages(doc([1, 2, 3]), doc([1, 2, 3, 99])))).toEqual(['1:1', '2:2', '3:3', '-:4'])
  })

  it('a deleted page is old-only', () => {
    expect(ids(alignPages(doc([1, 2, 3, 4]), doc([1, 3, 4])))).toEqual(['1:1', '2:-', '3:2', '4:3'])
    expect(ids(alignPages(doc([1, 2, 3, 4]), doc([2, 3, 4])))).toEqual(['1:-', '2:1', '3:2', '4:3'])
  })

  it('a moved page is paired with its partner and flagged as moved', () => {
    const pairs = alignPages(doc([1, 2, 3, 4, 5]), doc([1, 4, 2, 3, 5]))
    const moved = pairs.filter((p) => p.moved)
    expect(moved).toHaveLength(1)
    // pages 1,2,3,5 keep order; page 4 was moved to position 2 (the chain keeps the longest run: 1,2,3,5)
    expect(pairs.find((p) => p.old === 4)).toMatchObject({ new: 2, moved: true })
    expect(pairs.filter((p) => p.old !== null && p.new !== null)).toHaveLength(5)
    expect(pairs.every((p) => p.old !== null && p.new !== null)).toBe(true)
  })

  it('swapped adjacent pages and a reversed document are all paired', () => {
    const swapped = alignPages(doc([1, 2, 3]), doc([1, 3, 2]))
    expect(swapped.every((p) => p.old !== null && p.new !== null)).toBe(true)
    expect(swapped.filter((p) => p.moved)).toHaveLength(1)
    const reversed = alignPages(doc([1, 2, 3, 4, 5, 6]), doc([6, 5, 4, 3, 2, 1]))
    expect(reversed.every((p) => p.old !== null && p.new !== null)).toBe(true)
    expect(reversed.filter((p) => p.moved)).toHaveLength(5)
    for (const p of reversed) expect(p.old).toBe(7 - p.new!)
  })

  it('duplicated pages pair one-to-one in order and the extra copy is new-only', () => {
    expect(ids(alignPages(doc([1, 2, 3]), doc([1, 2, 2, 3])))).toEqual(['1:1', '2:2', '-:3', '3:4'])
    expect(ids(alignPages(doc([1, 2, 2, 3]), doc([1, 2, 3])))).toEqual(['1:1', '2:2', '3:-', '4:3'])
    const all = alignPages(doc([7, 7, 7]), doc([7, 7, 7]))
    expect(ids(all)).toEqual(['1:1', '2:2', '3:3'])
  })

  it('an edited page stays paired with its old version; a rewritten page in an otherwise equal spot pairs too', () => {
    const edited = pageText(2).map((w, i) => (i % 9 === 0 ? `${w}changed` : w))
    const pairs = alignPages(doc([1, 2, 3]), [pageText(1), edited, pageText(3)])
    expect(ids(pairs)).toEqual(['1:1', '2:2', '3:3'])
    expect(pairs[1].similarity).toBeGreaterThan(0.3)
    expect(pairs[1].similarity).toBeLessThan(1)
    // wholly rewritten: still the same slot between two anchors
    expect(ids(alignPages(doc([1, 2, 3]), doc([1, 50, 3])))).toEqual(['1:1', '2:2', '3:3'])
  })

  it('combines insertion, deletion and edits', () => {
    const newDoc = [pageText(1), pageText(3), pageText(99), pageText(4).map((w, i) => (i % 5 === 0 ? `${w}!` : w)), pageText(5)]
    const pairs = alignPages(doc([1, 2, 3, 4, 5]), newDoc)
    expect(ids(pairs)).toEqual(['1:1', '2:-', '3:2', '-:3', '4:4', '5:5'])
  })

  it('blank pages pair with blank pages in order, and never with text pages', () => {
    expect(ids(alignPages(doc([1, -1, 3]), doc([1, -1, 3])))).toEqual(['1:1', '2:2', '3:3'])
    expect(ids(alignPages(doc([1, -1, -1, 3]), doc([1, -1, 3])))).toEqual(['1:1', '2:2', '3:-', '4:3'])
    const pairs = alignPages(doc([-1, 1]), doc([1, -1]))
    // the text page pairs with the text page; the blanks pair with each other
    expect(pairs.find((p) => p.old === 2)!.new).toBe(1)
  })

  it('empty and one-sided documents', () => {
    expect(alignPages([], [])).toEqual([])
    expect(ids(alignPages(doc([1, 2]), []))).toEqual(['1:-', '2:-'])
    expect(ids(alignPages([], doc([1, 2])))).toEqual(['-:1', '-:2'])
  })

  it('a running header repeated on every page does not glue unrelated pages together', () => {
    const header = ['ACME', 'CONFIDENTIAL', 'DRAFT', 'v2']
    const withHeader = (ids: number[]): string[][] => ids.map((i) => [...header, ...pageText(i, 60)])
    const pairs = alignPages(withHeader(Array.from({ length: 80 }, (_, i) => i + 1)), withHeader([...Array.from({ length: 40 }, (_, i) => i + 1), 500, ...Array.from({ length: 40 }, (_, i) => i + 41)]))
    expect(pairs.filter((p) => p.old === null)).toHaveLength(1)
    expect(pairs.find((p) => p.old === null)!.new).toBe(41)
    expect(pairs.filter((p) => p.new !== null && p.old !== null && (p.new - p.old === 0 || p.new - p.old === 1))).toHaveLength(80)
  })

  it('500-page documents align quickly', () => {
    const a = Array.from({ length: 500 }, (_, i) => i + 1)
    const b = [...a.slice(0, 200), ...a.slice(210), 9001, 9002] // ten pages deleted in the middle, two appended
    const t = Date.now()
    const pairs = alignPages(doc(a), doc(b))
    expect(Date.now() - t).toBeLessThan(8000)
    expect(pairs.filter((p) => p.new === null)).toHaveLength(10)
    expect(pairs.filter((p) => p.old === null)).toHaveLength(2)
  })
})

describe('fingerprints', () => {
  it('similarity is 1 for equal pages, 0 for disjoint ones, and empty pages equal each other only', () => {
    const a = fingerprint(pageText(1))
    expect(fingerprintSimilarity(a, fingerprint(pageText(1)))).toBe(1)
    expect(fingerprintSimilarity(a, fingerprint(pageText(2)))).toBeLessThan(0.05)
    expect(fingerprintSimilarity(fingerprint([]), fingerprint([]))).toBe(1)
    expect(fingerprintSimilarity(fingerprint([]), a)).toBe(0)
  })

  it('short pages still get a usable fingerprint', () => {
    expect(fingerprintSimilarity(fingerprint(['Page', '3']), fingerprint(['Page', '3']))).toBe(1)
    expect(fingerprintSimilarity(fingerprint(['Page', '3']), fingerprint(['Page', '4']))).toBeLessThan(1)
  })
})
