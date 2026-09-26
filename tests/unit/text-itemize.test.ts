import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadFontFromBytes, resolveStack } from '../../src/shared/text/fonts'
import { layoutParagraph } from '../../src/shared/text/layout'
import { isCommonCodePoint, resolveScripts, scriptOfCodePoint } from '../../src/shared/text/script'
import { setupText } from './helpers/text'

setupText()

const scriptsOf = (text: string): string[] => {
  const r = resolveScripts(text)
  return Array.from(r.ids, (i) => r.tags[i]!)
}

describe('script itemization (UAX #24 style)', () => {
  it('assigns scripts and lets spaces, digits and punctuation join their neighbours', () => {
    const s = scriptsOf('Hello مرحبا 123!')
    expect(s.slice(0, 5)).toEqual(Array(5).fill('Latn'))
    expect(s.slice(6, 11)).toEqual(Array(5).fill('Arab'))
    // the space between Latin and Arabic follows the text before it; digits and '!' follow the Arabic before them
    expect(s[5]).toBe('Latn')
    expect(s[11]).toBe('Arab')
    expect(s[12]).toBe('Arab')
    expect(s[15]).toBe('Arab')
  })

  it('leading common characters take the first specific script that follows', () => {
    expect(scriptsOf('  «مرحبا»')[0]).toBe('Arab')
    expect(scriptsOf('123 abc')[0]).toBe('Latn')
  })

  it('paired brackets follow the script of their opener', () => {
    const s = scriptsOf('abc (مرحبا) def')
    expect(s[4]).toBe('Latn') // (
    expect(s[10]).toBe('Latn') // )
    expect(s[11]).toBe('Arab') // the space after ) is not paired: it follows the text before it
  })

  it('combining marks inherit their base; Hiragana, Han and Hangul are told apart', () => {
    expect(scriptsOf('é')).toEqual(['Latn', 'Latn'])
    expect(scriptsOf('あ漢한')).toEqual(['Hira', 'Hani', 'Hang'])
    expect(scriptOfCodePoint(0x0627)).toBe('Arab')
    expect(scriptOfCodePoint(0x20)).toBe('Zyyy')
    expect(isCommonCodePoint(0x31)).toBe(true)
    expect(isCommonCodePoint(0x41)).toBe(false)
  })

  it('handles astral characters (surrogate pairs) as one character', () => {
    const s = scriptsOf('a\u{1f600}b')
    expect(s.length).toBe(4)
    expect(s[1]).toBe(s[2])
  })
})

describe('font stacks and per-character fallback', () => {
  it('uses the document font first, then bundled fonts for what it lacks', async () => {
    const lib = new Uint8Array(readFileSync('resources/fonts/LiberationSerif-Regular.ttf'))
    const lay = await layoutParagraph('Hello مرحبا', { fontStack: [{ bytes: lib, name: 'Doc' }], size: 16 })
    const families = lay.lines[0]!.runs.map((r) => r.font.family)
    expect(families[0]).toMatch(/Liberation Serif/)
    expect(families.some((f) => /Arabic/.test(f))).toBe(true)
    expect(lay.missing).toEqual([])
  })

  it('a user font takes precedence for the characters it covers', async () => {
    const lib = new Uint8Array(readFileSync('resources/fonts/LiberationSerif-Regular.ttf'))
    const f = await loadFontFromBytes(lib)
    const stack = await resolveStack({ fontStack: [f] })
    expect(stack[0]!.covers(0x41)).toBe(true)
    expect(stack[0]!.covers(0x0627)).toBe(false)
    const arabic = stack.find((c) => c.covers(0x0627))!
    expect(arabic.family).toMatch(/Arabic|Naskh/)
  })

  it('reports characters no font covers instead of dropping them', async () => {
    // U+A4D0 (Lisu letter) and U+16A0 (runic) are in no bundled font
    const lay = await layoutParagraph('ok ꓐ ᚠ ok', { size: 16 })
    expect(lay.missing.map((m) => m.codePoint).sort((a, b) => a - b)).toEqual([0x16a0, 0xa4d0])
    for (const m of lay.missing) expect(lay.text[m.index]).toBe(m.char)
    // a glyph (the font's .notdef) is still drawn: nothing is silently dropped
    const glyphs = lay.lines[0]!.runs.flatMap((r) => r.glyphs.filter((g) => !g.space))
    expect(glyphs.length).toBe(lay.text.replace(/ /g, '').length)
  })

  it('can refuse instead: onMissing throws and names the characters', async () => {
    await expect(layoutParagraph('a ꓐ', { onMissing: 'throw' })).rejects.toThrow(/No font covers/)
  })

  it('with fallback disabled the caller sees every uncovered character', async () => {
    const stack = await resolveStack({ fontStack: ['Liberation Sans'], fallback: false })
    expect(stack.length).toBe(1)
    expect(stack[0]!.covers(0x0627)).toBe(false)
  })

  it('resolves family names, aliases and weights', async () => {
    const bold = await resolveStack({ fontStack: ['Helvetica'], weight: 'bold' })
    expect(bold[0]!.file).toBe('LiberationSans-Bold.ttf')
    const italic = await resolveStack({ fontStack: ['serif'], italic: true })
    expect(italic[0]!.file).toBe('LiberationSerif-Italic.ttf')
    const arabicBold = await resolveStack({ fontStack: ['Noto Sans Arabic'], weight: 700 })
    expect(arabicBold[0]!.file).toBe('NotoSansArabic-Bold.ttf')
    const synth = await resolveStack({ fontStack: ['Noto Sans Ethiopic'], weight: 'bold' })
    expect(synth[0]!.synthBold).toBe(true)
  })

  it('orders CJK fonts by language (Japanese kanji from the JP font, Traditional from TC, Korean hangul from KR)', async () => {
    const ja = await resolveStack({ lang: 'ja' })
    const firstCjk = (stack: typeof ja): string | undefined => stack.find((c) => c.category === 'cjk' && c.covers(0x76f4))?.file
    expect(firstCjk(ja)).toBe('NotoSansJP-Regular.otf')
    expect(firstCjk(await resolveStack({ lang: 'zh-Hant' }))).toBe('NotoSansTC-Regular.otf')
    expect(firstCjk(await resolveStack({ lang: 'zh-Hans' }))).toBe('NotoSansSC-Regular.otf')
    const hangul = (await resolveStack({ lang: 'ko' })).find((c) => c.covers(0xd55c))!
    expect(hangul.file).toBe('NotoSansKR-Regular.otf')
  })

  it('prefers the emoji font for emoji-presentation characters and keeps digits out of it', async () => {
    const lay = await layoutParagraph('1 \u{1f600} 2', { size: 16 })
    const fam = lay.lines[0]!.runs.map((r) => ({ f: r.font.family, s: lay.text.slice(r.textStart, r.textEnd) }))
    const emoji = fam.find((x) => x.s.includes('\u{1f600}'))!
    expect(emoji.f).toMatch(/Emoji/)
    const digit = fam.find((x) => x.s.includes('2'))!
    expect(digit.f).not.toMatch(/Emoji|Symbols/)
  })

  it('splits runs by bidi level, script and font', async () => {
    const lay = await layoutParagraph('abc مرحبا 123', { size: 16, direction: 'ltr' })
    const runs = lay.lines[0]!.runs
    expect(runs.some((r) => r.script === 'Latn' && r.level === 0)).toBe(true)
    expect(runs.some((r) => r.script === 'Arab' && r.level === 1)).toBe(true)
    expect(new Set(runs.map((r) => r.font.family)).size).toBeGreaterThan(1)
  })
})
