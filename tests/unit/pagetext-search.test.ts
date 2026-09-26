import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rangeBoxes } from '../../src/shared/pagetext'
import { findInText } from '../../src/renderer/src/pdf/search'
import { engineLines } from '../fixtures/pagetext/engine'
import { FIXTURES, corpus, fixtureBytes, modelsOf } from './helpers/pagetext'
import { setupText } from './helpers/text'

/**
 * In-document search (src/renderer/src/pdf/search.ts `findInText`): the text engine's search normalisation on the
 * page text, ranges mapped back to the original text. Latin behaviour is the old behaviour (case, whole word,
 * whitespace, metacharacters); Arabic/Hebrew/Persian get tashkeel-, variant- and digit-insensitive matching.
 */
setupText()

const opts = { matchCase: false, wholeWord: false }
const hits = (text: string, q: string, o = opts): string[] => findInText(text, q, o).map((m) => text.slice(m.start, m.end))

describe('Latin behaviour is unchanged', () => {
  it('case-insensitive by default, case-sensitive on request', () => {
    expect(hits('Needle needle NEEDLE', 'needle')).toHaveLength(3)
    expect(hits('Needle needle NEEDLE', 'needle', { ...opts, matchCase: true })).toEqual(['needle'])
  })
  it('regex metacharacters are literal; whitespace runs match any whitespace (line breaks too)', () => {
    expect(findInText('cost: $5.00 (approx) [x]', '$5.00', opts)).toEqual([{ start: 6, end: 11 }])
    expect(hits('a.b axb', 'a.b')).toEqual(['a.b'])
    expect(hits('f(x) [y]', '(x)')).toEqual(['(x)'])
    expect(hits('hello\nworld and hello   world', 'hello world')).toHaveLength(2)
  })
  it('whole words, Unicode letters', () => {
    const w = { ...opts, wholeWord: true }
    expect(hits('cat concat cat.', 'cat', w)).toHaveLength(2)
    expect(hits('élan vital', 'lan', w)).toHaveLength(0)
    expect(hits('élan vital', 'élan', w)).toEqual(['élan'])
  })
  it('diacritics still count (é is not e); ligatures and full-width forms now match their letters (better than before)', () => {
    expect(hits('résumé resume', 'resume')).toEqual(['resume'])
    expect(hits('ﬁne print', 'fine')).toEqual(['ﬁne'])
    expect(hits('ＡＢＣ', 'abc')).toEqual(['ＡＢＣ'])
    expect(hits('Straße', 'strasse')).toEqual(['Straße'])
  })
  it('blank queries and empty pages find nothing', () => {
    expect(findInText('abc', '   ', opts)).toEqual([])
    expect(findInText('', 'a', opts)).toEqual([])
    expect(hits('aaaa', 'a')).toHaveLength(4)
  })
})

describe('Arabic, Persian, Urdu and Hebrew', () => {
  const vocalised = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ'
  it('tashkeel-insensitive both ways; the hit covers the marks of its letters', () => {
    expect(hits(vocalised, 'الرحمن')).toEqual(['الرَّحْمَٰنِ'])
    expect(hits(vocalised, 'بسم')).toEqual(['بِسْمِ'])
    expect(hits('بسم الله', 'بِسْمِ')).toEqual(['بسم'])
  })
  it('alef variants, yeh / alef maqsura / Persian yeh, kashida, presentation forms', () => {
    expect(hits('نعم، أعلم!', 'اعلم')).toEqual(['أعلم'])
    expect(hits('إلى آخره', 'الى اخره')).toEqual(['إلى آخره'])
    expect(hits('متن فارسی', 'فارسي')).toEqual(['فارسی'])
    expect(hits('مـــرحبا', 'مرحبا')).toEqual(['مـــرحبا'])
    expect(hits('ﻣﺮﺣﺒﺎ', 'مرحبا')).toEqual(['ﻣﺮﺣﺒﺎ'])
  })
  it('Arabic-Indic and Persian digits match Western digits and each other', () => {
    expect(hits('السعر ١٢٣٫٥٠ دينار', '123.50')).toEqual(['١٢٣٫٥٠'])
    expect(hits('سال ۱۴۰۵', '1405')).toEqual(['۱۴۰۵'])
    expect(hits('العدد 1405', '۱۴۰۵')).toEqual(['1405'])
  })
  it('teh marbuta and heh stay different (the letters differ in meaning)', () => {
    expect(hits('مدرسة', 'مدرسه')).toEqual([])
  })
  it('Hebrew points are ignored', () => {
    expect(hits('בְּרֵאשִׁית בָּרָא', 'בראשית')).toEqual(['בְּרֵאשִׁית'])
  })
})

describe('search on real page text models', () => {
  const boxes = JSON.parse(readFileSync(resolve(FIXTURES, 'chromium-lines.boxes.json'), 'utf8')) as { line: string; text: string; x0: number; x1: number; y0: number; y1: number }[]
  for (const name of ['lo-lines.pdf', 'chromium-lines.pdf', 'engine-lines']) {
    it(`${name}: every corpus query finds exactly its word, on the right line`, async () => {
      const [m] = await modelsOf(name === 'engine-lines' ? await engineLines() : fixtureBytes(name))
      for (const w of corpus.searchWords) {
        const found = findInText(m.text, w.query, opts)
        expect(found, `${w.query} in ${name}`).toHaveLength(1)
        const got = m.text.slice(found[0].start, found[0].end)
        expect(got.normalize('NFC'), w.query).toBe(w.match.normalize('NFC'))
        const line = m.lines.find((l) => l.start <= found[0].start && found[0].end <= l.end)!
        expect(m.text.slice(line.start, line.end).normalize('NFC')).toBe(corpus.lines.find((l) => l.id === w.line)!.text.normalize('NFC'))
        if (name === 'chromium-lines.pdf') {
          // the hit's glyph boxes lie inside the word Chromium laid out (its own layout, independent of the model)
          const word = boxes.find((b) => b.line === w.line && b.text.normalize('NFC').includes(w.match.normalize('NFC')))!
          for (const b of rangeBoxes(m, found[0].start, found[0].end)) {
            expect(b.x0, w.query).toBeGreaterThanOrEqual(word.x0 - 0.5)
            expect(b.x1, w.query).toBeLessThanOrEqual(word.x1 + 0.5)
          }
          const hb = rangeBoxes(m, found[0].start, found[0].end)
          const width = Math.max(...hb.map((b) => b.x1)) - Math.min(...hb.map((b) => b.x0))
          expect(width, w.query).toBeGreaterThan(0.6 * (word.x1 - word.x0))
        }
      }
    })
  }
})
