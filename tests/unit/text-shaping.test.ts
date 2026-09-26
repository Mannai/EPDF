import { describe, expect, it } from 'vitest'
import { clearShapingCache, normalizeFeatures, shapeText, shapingCacheStats } from '../../src/shared/text/shape'
import { font, setupText } from './helpers/text'

/**
 * Shaping golden tests: what HarfBuzz must produce for known words in the bundled fonts. Glyph ids are compared
 * relatively (forms differ from the nominal glyphs; ligatures reduce the glyph count), never against magic numbers.
 */
setupText()

const shape = async (file: string, text: string, opts: { rtl?: boolean; script?: string; lang?: string; features?: string | Record<string, boolean | number> } = {}) =>
  shapeText({ font: await font(file), rtl: opts.rtl ?? false, script: opts.script, lang: opts.lang, features: opts.features }, text)

describe('Arabic', () => {
  it('joins letters: initial, medial and final forms are not the isolated glyphs', async () => {
    const f = await font('NotoNaskhArabic-Regular.ttf')
    const s = await shape('NotoNaskhArabic-Regular.ttf', 'ببب', { rtl: true, script: 'Arab', lang: 'ar' })
    const isolated = f.glyphFor(0x0628)
    const base = [...s.gid].filter((g, i) => s.cluster[i] !== undefined && g !== 0)
    // beh (with its dot components as separate glyphs): the letter body of each form differs from the isolated body
    expect(new Set(base).size).toBeGreaterThan(2)
    expect([...s.gid].filter((g) => g === isolated).length).toBeLessThan(3)
  })

  it('shows the word in visual order: glyph clusters run from the end of the text to the start', async () => {
    const s = await shape('NotoNaskhArabic-Regular.ttf', 'مرحبا', { rtl: true, script: 'Arab' })
    const bases = [...s.cluster]
    // first glyph on screen (leftmost) is the last letter
    expect(Math.max(...bases)).toBe(bases[0])
    expect(Math.min(...bases)).toBe(bases[bases.length - 1])
  })

  it('forms the mandatory lam-alef ligature (rlig): different glyphs than without the feature', async () => {
    const on = await shape('NotoNaskhArabic-Regular.ttf', 'لا', { rtl: true, script: 'Arab' })
    const off = await shape('NotoNaskhArabic-Regular.ttf', 'لا', { rtl: true, script: 'Arab', features: { rlig: false } })
    expect([...on.gid]).not.toEqual([...off.gid])
    // the ligature pair is wider than the plain forms would be laid out separately
    const w = (s: typeof on): number => [...s.ax].reduce((a, b) => a + b, 0)
    expect(w(on)).not.toBe(w(off))
  })

  it('positions tashkeel: marks have no advance and a GPOS offset above/below the base', async () => {
    const s = await shape('NotoNaskhArabic-Regular.ttf', 'مُحَمَّد', { rtl: true, script: 'Arab', lang: 'ar' })
    let marks = 0
    for (let i = 0; i < s.length; i++) {
      if (s.ax[i] === 0) {
        marks++
        expect(s.dx[i] !== 0 || s.dy[i] !== 0, `mark glyph ${i} must be offset`).toBe(true)
      }
    }
    expect(marks).toBeGreaterThanOrEqual(3) // damma, fatha, fatha, shadda
    // the marks are attached at different heights (GPOS mark-to-base, mark-to-mark): several distinct vertical offsets
    const ys = new Set([...s.dy].filter((_, i) => s.ax[i] === 0))
    expect(ys.size).toBeGreaterThan(1)
  })

  it('shapes Persian and Urdu letters (پ چ ژ گ ٹ ڈ ں ے) without missing glyphs', async () => {
    for (const file of ['NotoNaskhArabic-Regular.ttf', 'NotoSansArabic-Regular.ttf']) {
      const s = await shape(file, 'پچژگٹڈںے', { rtl: true, script: 'Arab', lang: 'ur' })
      expect([...s.gid].filter((g) => g === 0)).toEqual([])
    }
  })

  it('Nastaliq Urdu applies its cursive positioning (vertical offsets on base letters)', async () => {
    const s = await shape('NotoNastaliqUrdu-Regular.ttf', 'اردو زبان', { rtl: true, script: 'Arab', lang: 'ur' })
    expect([...s.gid].every((g) => g !== 0)).toBe(true)
    expect([...s.dy].some((d) => d !== 0)).toBe(true)
  })

  it('mirrors paired punctuation in right-to-left runs', async () => {
    const f = await font('NotoSans-Regular.ttf')
    const ltr = await shape('NotoSans-Regular.ttf', '(', { rtl: false, script: 'Latn' })
    const rtl = await shape('NotoSans-Regular.ttf', '(', { rtl: true, script: 'Arab' })
    expect(ltr.gid[0]).toBe(f.glyphFor(0x28))
    expect(rtl.gid[0]).toBe(f.glyphFor(0x29))
  })
})

describe('Hebrew', () => {
  it('reverses visually and positions niqqud', async () => {
    const s = await shape('NotoSansHebrew-Regular.ttf', 'בְּרֵאשִׁית', { rtl: true, script: 'Hebr', lang: 'he' })
    expect([...s.gid].every((g) => g !== 0)).toBe(true)
    expect([...s.ax].some((a) => a === 0)).toBe(true) // combining points
    expect(s.cluster[0]).toBeGreaterThan(s.cluster[s.length - 1]!)
  })
})

describe('Thai', () => {
  it('splits sara am and positions the tone mark above the consonant', async () => {
    const s = await shape('NotoSansThai-Regular.ttf', 'น้ำ', { script: 'Thai', lang: 'th' })
    // น + ้ + ำ -> น, ้, ํ (nikhahit), า : 4 glyphs for 3 characters
    expect(s.length).toBe(4)
    const zeroAdvance = [...s.ax].filter((a) => a === 0).length
    expect(zeroAdvance).toBeGreaterThanOrEqual(2)
    // the tone mark and nikhahit are attached to the consonant by GPOS (offsets, zero advance)
    expect([...s.ax].some((a, i) => a === 0 && (s.dx[i] !== 0 || s.dy[i] !== 0))).toBe(true)
  })
})

describe('Devanagari', () => {
  it('forms the conjunct क्ष (fewer glyphs than characters) and reorders the i-matra before its consonant', async () => {
    const conj = await shape('NotoSansDevanagari-Regular.ttf', 'क्ष', { script: 'Deva', lang: 'hi' })
    expect(conj.length).toBeLessThan(3)
    const ki = await shape('NotoSansDevanagari-Regular.ttf', 'कि', { script: 'Deva', lang: 'hi' })
    expect(ki.length).toBe(2)
    // visual order: the matra (character 1) is drawn first
    expect(ki.cluster[0]).toBe(1)
    expect(ki.cluster[1]).toBe(0)
  })
})

describe('Latin, CJK and features', () => {
  it('applies ligatures (ffi) and lets the caller turn them off', async () => {
    const on = await shape('NotoSans-Regular.ttf', 'office', { script: 'Latn' })
    const off = await shape('NotoSans-Regular.ttf', 'office', { script: 'Latn', features: 'liga=0, clig=0' })
    expect(on.length).toBeLessThan(off.length)
  })

  it('applies kerning (AV is tighter with kern on)', async () => {
    const on = await shape('NotoSans-Regular.ttf', 'AV', { script: 'Latn' })
    const off = await shape('NotoSans-Regular.ttf', 'AV', { script: 'Latn', features: { kern: false } })
    const w = (s: typeof on): number => [...s.ax].reduce((a, b) => a + b, 0)
    expect(w(on)).toBeLessThan(w(off))
  })

  it('shapes CJK one glyph per character (CFF outlines)', async () => {
    const s = await shape('NotoSansJP-Regular.otf', 'こんにちは世界', { script: 'Jpan', lang: 'ja' })
    expect(s.length).toBe(7)
    expect([...s.gid].every((g) => g !== 0)).toBe(true)
  })

  it('normalises feature settings (CSS-like strings and objects)', () => {
    expect(normalizeFeatures('liga=0, smcp, "ss01" 1')).toEqual(['liga=0', 'smcp=1'])
    expect(normalizeFeatures({ liga: false, smcp: true, ss01: 2 })).toEqual(['liga=0', 'smcp=1', 'ss01=2'])
    expect(normalizeFeatures(undefined)).toEqual([])
  })

  it('caches shaped segments', async () => {
    clearShapingCache()
    await shape('NotoSans-Regular.ttf', 'cache me', { script: 'Latn' })
    await shape('NotoSans-Regular.ttf', 'cache me', { script: 'Latn' })
    const st = shapingCacheStats()
    expect(st.hits).toBe(1)
    expect(st.misses).toBe(1)
  })
})
