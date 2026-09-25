import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { describe, expect, it } from 'vitest'
import { stripHinting } from '../../src/main/features/create/office/fontHinting'

const dir = resolve('resources/fonts')
const fonts = readdirSync(dir).filter((f) => f.endsWith('.ttf'))
const tablesOf = (f: ReturnType<typeof fontkit.create>): string[] => Object.keys((f as unknown as { directory: { tables: Record<string, unknown> } }).directory.tables)

describe('stripHinting (regression: hinted Carlito/Noto subsets rendered with missing glyphs)', () => {
  it('has fonts to test', () => {
    expect(fonts.length).toBeGreaterThanOrEqual(20)
  })

  for (const file of ['Carlito-Regular.ttf', 'Carlito-BoldItalic.ttf', 'NotoSans-Regular.ttf', 'LiberationSans-Regular.ttf', 'Caladea-Bold.ttf']) {
    it(`removes hinting but keeps outlines, metrics and coverage of ${file}`, () => {
      const original = new Uint8Array(readFileSync(resolve(dir, file)))
      const stripped = stripHinting(original)
      const a = fontkit.create(original)
      const b = fontkit.create(stripped)
      const tags = tablesOf(b)
      expect(tags).not.toContain('fpgm')
      expect(tags).not.toContain('prep')
      expect(tags).not.toContain('cvt ')
      expect(b.numGlyphs).toBe(a.numGlyphs)
      expect(b.unitsPerEm).toBe(a.unitsPerEm)
      expect(b.ascent).toBe(a.ascent)
      expect(b.characterSet.length).toBe(a.characterSet.length)
      for (const ch of 'AaBbgQ&é€fi1') {
        const cp = ch.codePointAt(0)!
        if (!a.hasGlyphForCodePoint(cp)) continue
        const ga = a.glyphForCodePoint(cp)
        const gb = b.glyphForCodePoint(cp)
        expect(gb.advanceWidth).toBe(ga.advanceWidth)
        expect(gb.path.toSVG()).toBe(ga.path.toSVG())
      }
      expect(a.layout('Wave AV fi').advanceWidth).toBe(b.layout('Wave AV fi').advanceWidth)
    })
  }

  it('produces a subset every glyph of which survives (all bundled fonts)', async () => {
    for (const file of fonts) {
      const f = fontkit.create(stripHinting(new Uint8Array(readFileSync(resolve(dir, file)))))
      const sub = f.createSubset()
      for (const ch of 'Hello, World! 0123456789 àéîõü') if (f.hasGlyphForCodePoint(ch.codePointAt(0)!)) sub.includeGlyph(f.glyphForCodePoint(ch.codePointAt(0)!))
      const chunks: Uint8Array[] = []
      await new Promise<void>((res) => sub.encodeStream().on('data', (d) => chunks.push(d)).on('end', () => res()))
      const bytes = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
      let o = 0
      for (const c of chunks) (bytes.set(c, o), (o += c.length))
      const reopened = fontkit.create(bytes)
      expect(reopened.numGlyphs).toBeGreaterThan(5)
      expect(tablesOf(reopened)).not.toContain('fpgm')
    }
  })

  it('leaves non-TrueType data untouched', () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    const otf = new Uint8Array(200)
    new DataView(otf.buffer).setUint32(0, 0x4f54544f) // 'OTTO' with no tables
    expect(stripHinting(otf)).toBe(otf)
    expect(() => stripHinting(junk)).not.toThrow()
  })
})
