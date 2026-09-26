import { describe, expect, it } from 'vitest'
import { findNormalized, normalizeForSearch, visualToLogical } from '../../src/shared/text/search'

const n = (s: string, o?: Parameters<typeof normalizeForSearch>[1]): string => normalizeForSearch(s, o).text

describe('Arabic normalisation', () => {
  it('removes tashkeel (harakat, shadda, sukun, tanwin, dagger alef) and Quranic marks', () => {
    expect(n('مُحَمَّدٌ')).toBe('محمد')
    expect(n('بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ')).toBe('بسم الله الرحمن الرحيم')
    expect(n('مُحَمَّدٌ', { removeArabicMarks: false })).toBe('مُحَمَّدٌ')
  })
  it('unifies alef variants (أ إ آ ٱ -> ا)', () => {
    expect(n('أحمد إبراهيم آمنة ٱلله')).toBe('احمد ابراهيم امنة الله')
    expect(n('أحمد', { unifyAlef: false })).toBe('أحمد')
  })
  it('unifies yeh (ى ی -> ي) and Persian/Urdu kaf and heh variants', () => {
    expect(n('على')).toBe('علي')
    expect(n('فارسی')).toBe('فارسي')
    expect(n('کتاب')).toBe('كتاب')
    expect(n('ھے')).toBe('هي')
    expect(n('على', { unifyYa: false })).toBe('على')
  })
  it('teh marbuta and hamza carriers are opt-in', () => {
    expect(n('مدرسة')).toBe('مدرسة')
    expect(n('مدرسة', { taMarbuta: true })).toBe('مدرسه')
    expect(n('مؤمن')).toBe('مؤمن')
    expect(n('مؤمن رئيس', { hamza: true })).toBe('مومن رييس')
  })
  it('removes tatweel/kashida', () => {
    expect(n('مــرحــبا')).toBe('مرحبا')
    expect(n('مــرحــبا', { removeTatweel: false })).toBe('مــرحــبا')
  })
  it('maps presentation forms and ligatures back to base letters', () => {
    expect(n('ﻣﺮﺣﺒﺎ')).toBe('مرحبا') // ﻣﺮﺣﺒﺎ
    expect(n('ﷲ')).toBe('الله') // ﷲ
    expect(n('ﻻ')).toBe('لا') // ﻻ
    expect(n('ﻼ')).toBe('لا')
    expect(n('ﷺ')).toBe('صلي الله عليه وسلم') // its alef maqsura is unified with yeh too
  })
  it('unifies digit systems and Arabic punctuation (٠-٩, ۰-۹ -> 0-9)', () => {
    expect(n('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789')
    expect(n('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789')
    expect(n('سعر ٢٥٠ ريال، أو ۳۰۰؟')).toBe('سعر 250 ريال, او 300?')
    expect(n('٣٫١٤')).toBe('3.14')
    expect(n('٠١٢', { digits: false })).toBe('٠١٢')
  })
  it('ignores zero-width and directional format characters (ZWNJ, ZWJ, RLM, LRM, ALM)', () => {
    expect(n('می‌خواهم')).toBe('میخواهم'.replace('ی', 'ي'))
    expect(n('a‏b‎c؜d')).toBe('abcd')
    expect(n('a b')).toBe('a b')
  })
})

describe('other scripts', () => {
  it('Hebrew: niqqud and cantillation are ignored', () => {
    expect(n('בְּרֵאשִׁית')).toBe('בראשית')
    expect(n('בְּרֵאשִׁית', { removeHebrewPoints: false })).toBe('בְּרֵאשִׁית')
  })
  it('Latin: case folding, ß, ligatures, optional diacritic stripping', () => {
    expect(n('Straße ﬁnal OFFICE')).toBe('strasse final office')
    expect(n('Crème brûlée')).toBe('crème brûlée')
    expect(n('Crème brûlée', { stripDiacritics: true })).toBe('creme brulee')
    expect(n('Crème', { foldCase: false })).toBe('Crème')
  })
  it('full-width and compatibility forms', () => {
    expect(n('ＡＢＣ１２３！')).toBe('abc123!')
    expect(n('①②', {})).toBe('12')
    expect(n('ｱｲｳ')).toBe('アイウ')
  })
  it('does not touch scripts it has no rule for', () => {
    expect(n('नमस्ते')).toBe('नमस्ते')
    expect(n('你好世界')).toBe('你好世界')
    expect(n('สวัสดี')).toBe('สวัสดี')
  })
})

describe('index mapping (highlight the right original characters)', () => {
  it('maps normalised ranges back to the original, covering removed marks with their base', () => {
    const text = 'قال مُحَمَّدٌ للناس'
    const norm = normalizeForSearch(text)
    const i = norm.text.indexOf('محمد')
    const [a, b] = norm.toOriginal(i, i + 4)
    expect(text.slice(a, b)).toBe('مُحَمَّدٌ')
  })

  it('ligature expansion maps every produced letter to the ligature character', () => {
    const text = 'xﷲy' // ﷲ
    const norm = normalizeForSearch(text)
    expect(norm.text).toBe('xاللهy')
    expect(norm.toOriginal(1, 5)).toEqual([1, 2])
    expect(norm.toOriginal(0, 6)).toEqual([0, 3])
  })

  it('findNormalized finds a plain word in vocalised text and returns original offsets', () => {
    const text = 'الحمد لله رب العالمين. الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ'
    const hits = findNormalized(text, 'الحمد لله')
    expect(hits.length).toBe(2)
    expect(text.slice(hits[0]!.start, hits[0]!.end)).toBe('الحمد لله')
    expect(text.slice(hits[1]!.start, hits[1]!.end)).toBe('الْحَمْدُ لِلَّهِ')
  })

  it('finds Persian text typed with Arabic letters and digits typed either way', () => {
    const text = 'شماره ۱۲۳ کتاب فارسی'
    expect(findNormalized(text, 'شماره 123').length).toBe(1)
    expect(findNormalized(text, 'كتاب فارسي').length).toBe(1)
  })

  it('property: mapping is monotonic, in bounds, and every hit normalises to the needle (random Arabic/Latin/mark soup)', () => {
    const pool = ['ا', 'أ', 'ب', 'ت', 'ي', 'ى', 'ی', 'ك', 'ک', 'ة', 'ه', 'م', 'ن', 'ل', 'َ', 'ُ', 'ّ', 'ـ', ' ', '٣', '3', 'a', 'B', 'ß', 'ﷲ', 'ﻻ', '‌', 'é', 'é', '😀']
    let seed = 12345
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let iter = 0; iter < 300; iter++) {
      const len = 1 + Math.floor(rnd() * 25)
      let text = ''
      for (let i = 0; i < len; i++) text += pool[Math.floor(rnd() * pool.length)]
      const norm = normalizeForSearch(text)
      // in bounds and monotonic non-decreasing
      for (let i = 0; i < norm.text.length; i++) {
        expect(norm.starts[i]!).toBeGreaterThanOrEqual(0)
        expect(norm.ends[i]!).toBeLessThanOrEqual(text.length)
        expect(norm.starts[i]!).toBeLessThan(norm.ends[i]!)
        if (i > 0) {
          expect(norm.starts[i]!).toBeGreaterThanOrEqual(norm.starts[i - 1]!)
          expect(norm.ends[i]!).toBeGreaterThanOrEqual(norm.ends[i - 1]!)
        }
      }
      // any substring of the normalised text, searched for, is found and its original span normalises to the same text
      if (norm.text.length === 0) continue
      const a = Math.floor(rnd() * norm.text.length)
      const b = a + 1 + Math.floor(rnd() * (norm.text.length - a))
      const needle = norm.text.slice(a, b)
      const hits = findNormalized(text, needle)
      expect(hits.length, `${JSON.stringify(text)} / ${JSON.stringify(needle)}`).toBeGreaterThan(0)
      for (const h of hits) {
        // the original span, normalised, contains the needle (it can be wider when a hit starts or ends inside an
        // expansion such as ß -> ss)
        expect(normalizeForSearch(text.slice(h.start, h.end)).text.includes(needle), JSON.stringify(text)).toBe(true)
      }
    }
  })
})

describe('visual to logical repair (best effort)', () => {
  it('is the identity for left-to-right text', () => {
    expect(visualToLogical('Hello world 123')).toBe('Hello world 123')
  })
  it('turns reversed Hebrew and Arabic back', () => {
    expect(visualToLogical('םולש')).toBe('שלום')
    expect(visualToLogical('ابحرم', { direction: 'rtl' })).toBe('مرحبا')
  })
  it('keeps numbers in RTL text in order and mirrors parentheses', () => {
    const logical = 'سعر 250 (ريال)'
    // The visual order of that logical text (what a legacy producer stores) is the same reordering: it is an involution
    // on this input, so applying it twice returns the logical text; numbers stay contiguous, parentheses are mirrored.
    const visual = visualToLogical(logical, { direction: 'rtl' })
    expect(visual).toContain('250')
    expect(visual.indexOf('(')).toBeLessThan(visual.indexOf(')'))
    expect(visualToLogical(visual, { direction: 'rtl' })).toBe(logical)
  })
})
