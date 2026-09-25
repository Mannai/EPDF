import { describe, expect, it } from 'vitest'
import { charMarks, segmentsOf, similarity } from '../../src/renderer/src/features/compare/diff/charDiff'
import { diffPage } from '../../src/renderer/src/features/compare/diff/pageDiff'
import { applyHunks, diffSequences } from '../../src/renderer/src/features/compare/diff/myers'
import { opts, pageOf, rng } from './helpers/compareItems'

const d = (a: string, b: string, o = {}): ReturnType<typeof diffPage> => diffPage(pageOf(a, o), pageOf(b, o), opts(o))
const summary = (cs: ReturnType<typeof diffPage>): string[] => cs.map((c) => `${c.kind}:${c.old?.parts.map((p) => p.join('-')).join('+') ?? ''}|${c.new?.parts.map((p) => p.join('-')).join('+') ?? ''}`)

describe('classification of page changes', () => {
  it('identical pages have no changes', () => {
    expect(d('The same text here.', 'The same text here.')).toEqual([])
  })

  it('inserted words are added, deleted words removed', () => {
    expect(summary(d('one two three four', 'one two brand new three four'))).toEqual(['added:|2-4'])
    expect(summary(d('one two brand new three four', 'one two three four'))).toEqual(['removed:2-4|'])
  })

  it('a replaced word is a modification (not remove + add)', () => {
    const c = d('Total: 100 USD', 'Total: 200 USD')
    expect(summary(c)).toEqual(['modified:2-3|2-3'])
    expect(d('the cat sat', 'the dog sat')[0].kind).toBe('modified') // even without shared letters: one word for one word
  })

  it('a rewritten phrase with similar text is a modification', () => {
    const c = d('payment is due within thirty days of the invoice date', 'payment is due within fourteen days of the invoice date')
    expect(summary(c)).toEqual(['modified:4-5|4-5'])
  })

  it('a long unrelated replacement is a removal plus an addition', () => {
    const c = d('intro alpha bravo charlie delta echo foxtrot outro', 'intro lorem ipsum dolor sit amet consectetur outro')
    expect(c.map((x) => x.kind)).toEqual(['removed', 'added'])
  })

  it('a removal next to an addition of similar text is a modification', () => {
    const c = d('please review the attached agreement carefully today', 'please review the attached agreements carefully today')
    expect(c).toHaveLength(1)
    expect(c[0].kind).toBe('modified')
  })

  it('changes separated by a single unchanged word are merged; two words apart they are separate', () => {
    const merged = d('a b c d e f g', 'a X c Y e f g')
    expect(merged).toHaveLength(1)
    expect(merged[0].old!.parts).toEqual([
      [1, 2],
      [3, 4]
    ])
    expect(merged[0].old!.span).toEqual([1, 4])
    expect(d('a b c d e f g', 'a X c d Y f g')).toHaveLength(2)
  })

  it('a changed number inside a sentence is found exactly', () => {
    const c = d('Revenue grew by 12.5% in 2023 to 4,300 units.', 'Revenue grew by 15.5% in 2023 to 4,300 units.')
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'modified', old: { parts: [[3, 4]] }, new: { parts: [[3, 4]] } })
  })

  it('reports positions in the new page order', () => {
    const c = d('a b c d e f', 'a b c NEW d e f')
    expect(c[0].at).toBe(3)
  })

  it('case, punctuation and whitespace modes ignore the respective differences', () => {
    expect(d('Hello World', 'hello world')).toHaveLength(1)
    expect(d('Hello World', 'hello world', { ignoreCase: true })).toEqual([])
    const punct = d('Hello, World!', 'Hello World')
    expect(punct).toHaveLength(1) // the comma and the "!" are one word apart: one change with two parts
    expect(punct[0].old!.parts).toEqual([
      [1, 2],
      [3, 4]
    ])
    expect(d('Hello, World!', 'Hello World', { ignorePunctuation: true })).toEqual([])
    // whitespace-insensitive: spacing and line breaks are irrelevant, real edits are still found at word level
    expect(d('Hello world again', 'Helloworld   again', { ignoreWhitespace: true })).toEqual([])
    const ws = d('The quick brown fox', 'Thequick brown fax', { ignoreWhitespace: true })
    expect(ws).toHaveLength(1)
    expect(ws[0].kind).toBe('modified')
    expect(ws[0].old!.parts).toEqual([[3, 4]])
  })

  it('whitespace mode: an insertion inside a word widens to that word', () => {
    const c = d('a cat sat', 'a caat sat', { ignoreWhitespace: true })
    expect(summary(c)).toEqual(['modified:1-2|1-2'])
  })
})

describe('property: word diff versus a reference', () => {
  it('applying the hunks of random word sequences to the old text gives the new text', () => {
    const r = rng(2024)
    const vocab = ['the', 'a', 'of', 'and', 'to', 'in', 'is', 'it', 'you', 'that', 'he', 'was']
    const seq = (n: number): string[] => Array.from({ length: n }, () => vocab[Math.floor(r() * vocab.length)])
    for (let i = 0; i < 300; i++) {
      const a = seq(Math.floor(r() * 30))
      const b = r() < 0.5 ? seq(Math.floor(r() * 30)) : a.map((w) => (r() < 0.2 ? vocab[Math.floor(r() * vocab.length)] : w)).filter(() => r() < 0.9)
      const ids = new Map<string, number>()
      const id = (w: string): number => ids.get(w) ?? (ids.set(w, ids.size), ids.size - 1)
      const h = diffSequences(a.map(id), b.map(id))
      expect(applyHunks(a, b, h)).toEqual(b)
      // and the page-level change list never claims a difference where there is none
      const cs = diffPage(a, b, opts())
      expect(cs.length === 0).toBe(a.length === b.length && a.every((w, k) => w === b[k]))
    }
  })
})

describe('character-level marks', () => {
  it('marks only the differing characters of a modified number', () => {
    expect(charMarks('1,234.50', '1,284.50')).toEqual({ a: [[3, 4]], b: [[3, 4]] })
  })

  it('marks additions and deletions inside a word', () => {
    expect(charMarks('colour', 'color')).toEqual({ a: [[4, 5]], b: [] })
    expect(charMarks('color', 'colour')).toEqual({ a: [], b: [[4, 5]] })
  })

  it('absorbs one-character islands and marks everything when the strings are unrelated', () => {
    expect(charMarks('12345678', '1a3b5678').a).toEqual([[1, 4]])
    expect(charMarks('12345678', '1a3b5678').b).toEqual([[1, 4]])
    expect(charMarks('cat', 'dog')).toEqual({ a: [[0, 3]], b: [[0, 3]] })
    expect(charMarks('same', 'same')).toEqual({ a: [], b: [] })
  })

  it('splits text into plain and marked segments', () => {
    expect(segmentsOf('Total 100 USD', [[6, 9]])).toEqual([
      { text: 'Total ', marked: false },
      { text: '100', marked: true },
      { text: ' USD', marked: false }
    ])
    expect(segmentsOf('abc', [])).toEqual([{ text: 'abc', marked: false }])
  })

  it('similarity is symmetric-ish and bounded', () => {
    expect(similarity('night', 'nacht')).toBeCloseTo(0.25, 5)
    expect(similarity('abc', 'abc')).toBe(1)
    expect(similarity('abc', 'xyz')).toBe(0)
    expect(similarity('a', 'b')).toBe(0)
    expect(similarity('', '')).toBe(1)
  })
})
