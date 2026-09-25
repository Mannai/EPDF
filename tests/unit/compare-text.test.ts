import { describe, expect, it } from 'vitest'
import { charWeight, foldChar, foldText, isPunctuationToken, keyOf, tokenize } from '../../src/renderer/src/features/compare/diff/normalize'
import { buildPageModel, pageWords } from '../../src/renderer/src/features/compare/diff/words'
import { wordBoxes } from '../../src/renderer/src/features/compare/diff/words'
import { helvWidth, keysOf, opts, paragraph, run } from './helpers/compareItems'

describe('normalisation and tokenisation', () => {
  it('expands ligatures and presentation forms', () => {
    expect(foldText('ﬁnal ﬂow ﬃ')).toBe('final flow ffi')
    expect(tokenize('eﬃcient', opts())).toEqual(['efficient'])
    expect(foldChar('ﬁ')).toBe('fi')
  })

  it('treats every kind of space as one space and drops invisible characters', () => {
    expect(foldText('a b c d　e')).toBe('a b c d e')
    expect(foldText('zero​width﻿')).toBe('zerowidth')
    expect(tokenize('one   two\tthree\n', opts())).toEqual(['one', 'two', 'three'])
  })

  it('unifies typographic quotes and dashes', () => {
    expect(foldText('“quoted” — don’t – it')).toBe('"quoted" - don\'t - it')
    expect(tokenize('don’t', opts())).toEqual(["don't"])
    expect(tokenize("don't", opts())).toEqual(["don't"])
  })

  it('keeps numbers, dates and addresses whole', () => {
    expect(tokenize('Total: 1,234.50 USD on 12/03/2024 at www.example.com.', opts())).toEqual(['Total', ':', '1,234.50', 'USD', 'on', '12/03/2024', 'at', 'www.example.com', '.'])
    expect(tokenize('3.5%', opts())).toEqual(['3.5', '%'])
  })

  it('splits punctuation off words and treats every ideograph as a word', () => {
    expect(tokenize('Hello, world!', opts())).toEqual(['Hello', ',', 'world', '!'])
    expect(tokenize('日本語のテキスト', opts())).toEqual(['日', '本', '語', 'の', 'テ', 'キ', 'ス', 'ト'])
  })

  it('handles combining marks and other scripts', () => {
    expect(tokenize('Zoë Ελληνικά Привет', opts())).toEqual(['Zoë', 'Ελληνικά', 'Привет'])
    // decomposed and precomposed forms compare equal
    expect(tokenize('café', opts())).toEqual(tokenize('café', opts()))
  })

  it('case-insensitive and punctuation-insensitive modes', () => {
    expect(tokenize('Hello World', opts({ ignoreCase: true }))).toEqual(['hello', 'world'])
    expect(tokenize('Hello, World!', opts({ ignorePunctuation: true }))).toEqual(['Hello', 'World'])
    expect(keyOf('---', opts({ ignorePunctuation: true }))).toBeNull()
    expect(keyOf("don't", opts({ ignorePunctuation: true }))).toBe('dont')
    expect(isPunctuationToken('…')).toBe(true)
    expect(isPunctuationToken('a.')).toBe(false)
  })

  it('character widths follow Helvetica', () => {
    expect(charWeight('A')).toBe(667)
    expect(charWeight('i')).toBe(222)
    expect(charWeight(' ')).toBe(278)
    expect(charWeight('~')).toBe(584)
    expect(charWeight('日')).toBe(1000)
    expect(helvWidth('Hello', 10)).toBeCloseTo((722 + 556 + 222 + 222 + 556) / 100, 6)
  })
})

describe('words from text runs', () => {
  it('a single run gives one word per token with boxes that tile the run exactly (Helvetica)', () => {
    const it = run('The quick brown fox', 72, 100, 12)
    const words = pageWords([it], opts())
    expect(words.map((w) => w.text)).toEqual(['The', 'quick', 'brown', 'fox'])
    const quick = words[1].boxes[0]
    expect(quick.x).toBeCloseTo(72 + helvWidth('The ', 12), 3)
    expect(quick.w).toBeCloseTo(helvWidth('quick', 12), 3)
    expect(quick.y).toBeCloseTo(it.y0, 5)
    expect(quick.h).toBeCloseTo(it.y1 - it.y0, 5)
  })

  it('joins words split across separate runs and inserts spaces only at real gaps', () => {
    const a = run('Hello', 72, 100)
    const b = run('world', a.x1 + 3.5, 100) // a gap of a space width
    const c = run('!', b.x1, 100) // touching: no space
    expect(pageWords([a, b, c], opts()).map((w) => w.text)).toEqual(['Hello', 'world', '!'])
    const d = run('Hel', 72, 200)
    const e = run('lo', d.x1, 200) // one word cut into two runs
    expect(pageWords([d, e], opts()).map((w) => w.text)).toEqual(['Hello'])
  })

  it('removes the hyphen and joins the word when a line ends in "letters-" and the next starts in lowercase', () => {
    const items = [run('This is an exam-', 72, 100), run('ple of wrapping', 72, 115)]
    const words = pageWords(items, opts())
    expect(words.map((w) => w.text)).toEqual(['This', 'is', 'an', 'example', 'of', 'wrapping'])
    const ex = words[3]
    expect(ex.key).toBe('example')
    expect(ex.boxes).toHaveLength(2) // one rectangle per line, so highlights land on both fragments
    expect(ex.boxes[0].y).toBeLessThan(ex.boxes[1].y)
    // and the hyphenated and unhyphenated versions of a document compare equal
    expect(keysOf(items)).toEqual(keysOf([run('This is an example of wrapping', 72, 100)]))
  })

  it('keeps a real hyphen when the next line starts in capitals or the hyphen is not at the line end', () => {
    expect(keysOf([run('Some well-', 72, 100), run('Known thing', 72, 115)])).toEqual(['Some', 'well', '-', 'Known', 'thing'])
    expect(keysOf([run('a well-known fact', 72, 100)])).toEqual(['a', 'well', '-', 'known', 'fact'])
    // a dangling hyphen at the very end of the page stays
    expect(keysOf([run('Trailing dash-', 72, 100)])).toEqual(['Trailing', 'dash', '-'])
  })

  it('a soft hyphen at a line end is dehyphenated too', () => {
    expect(keysOf([run('exam­', 72, 100), run('ple text', 72, 115)])).toEqual(['example', 'text'])
  })

  it('ignores whitespace-only and non-finite runs', () => {
    const bad = { ...run('x', 10, 10), x1: NaN }
    expect(keysOf([run('  ', 72, 100), bad, run('real', 72, 120)])).toEqual(['real'])
  })

  it('orders a run list that arrives scrambled by position, not by input order', () => {
    const items = paragraph(['First line here', 'Second line here', 'Third line here'], 72, 100)
    const scrambled = [items[2], items[0], items[1]]
    expect(keysOf(scrambled)).toEqual(keysOf(items))
    expect(keysOf(items)).toEqual(['First', 'line', 'here', 'Second', 'line', 'here', 'Third', 'line', 'here'])
  })

  it('page model stores geometry compactly and can be read back per word', () => {
    const m = buildPageModel([run('Hello world', 72, 100)], 612, 792, opts())
    expect(m.text).toEqual(['Hello', 'world'])
    expect(m.box).toBeInstanceOf(Float32Array)
    expect(m.box).toHaveLength(8)
    expect(wordBoxes(m, 1)[0].x).toBeCloseTo(72 + helvWidth('Hello ', 12), 2)
    expect(m.block[0]).toBe(m.block[1])
  })
})
