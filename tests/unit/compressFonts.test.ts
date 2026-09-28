import fontkit from '@pdf-lib/fontkit'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, type PDFFont } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { PRESETS, type CompressOptions } from '../../src/renderer/src/features/compress/pdf/options'
import { glyphsForText, parseSfnt, pruneTrueType } from '../../src/renderer/src/features/compress/pdf/ttf'
import { decodeStream, encodedBytes } from '../../src/renderer/src/features/compress/pdf/streams'
import { pdfjsPageCount, pdfjsText } from './compressPdfjs'
import { notoBytes } from './helpers/pdfBuilder'

const N = (s: string): PDFName => PDFName.of(s)
const run = (bytes: Uint8Array, extra: Partial<CompressOptions> = {}) => compressPdf(bytes, { ...PRESETS.balanced, subsetFonts: true, ...extra }, { codec: pureCodec })

type Kit = { create(b: Uint8Array): { numGlyphs: number; getGlyph(id: number): { path: { commands: unknown[] } }; glyphForCodePoint(cp: number): { id: number; isComposite: boolean; path: { commands: unknown[] } } } }
const kit = fontkit as unknown as Kit

async function fontDoc(pages: string[], opts: { formDefault?: boolean } = {}): Promise<{ bytes: Uint8Array; font: PDFFont }> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(notoBytes('Regular'), { subset: false })
  pages.forEach((t) => doc.addPage([420, 200]).drawText(t, { x: 20, y: 100, size: 18, font }))
  if (opts.formDefault) doc.catalog.set(N('AcroForm'), doc.context.obj({ Fields: [], DR: { Font: { Noto: font.ref } }, DA: '/Noto 12 Tf 0 g' }))
  return { bytes: await doc.save(), font }
}

const fontPrograms = (doc: PDFDocument): PDFStream[] => {
  const out: PDFStream[] = []
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict)) continue
    const ff = o.get(N('FontFile2'))
    if (ff instanceof PDFRef) out.push(doc.context.lookup(ff) as PDFStream)
  }
  return out
}

describe('TrueType pruning', () => {
  it('keeps used glyphs (and the parts of composite glyphs) byte-identical and empties the rest', () => {
    const original = notoBytes('Regular')
    const k = kit.create(original)
    const wanted = 'Hello, Café Ünïcode 123'
    const gids = [...wanted].map((ch) => k.glyphForCodePoint(ch.codePointAt(0)!).id)
    const pruned = pruneTrueType(original, gids)!
    expect(pruned).toBeTruthy()
    expect(pruned.bytes.length).toBeLessThan(original.length * 0.45)
    expect(pruned.glyphsKept).toBeGreaterThanOrEqual(new Set(gids).size)
    expect(pruned.glyphsKept).toBeLessThan(pruned.glyphsTotal / 20)
    const p = kit.create(pruned.bytes)
    expect(p.numGlyphs).toBe(k.numGlyphs) // ids unchanged
    for (const g of new Set(gids)) expect(JSON.stringify(p.getGlyph(g).path.commands), `glyph ${g}`).toBe(JSON.stringify(k.getGlyph(g).path.commands))
    // accented letters are composites in most fonts: their components must survive too
    const eacute = k.glyphForCodePoint(0xe9)
    const e = kit.create(pruned.bytes).glyphForCodePoint(0xe9)
    expect(JSON.stringify(e.path.commands)).toBe(JSON.stringify(eacute.path.commands))
    // an unused glyph is empty
    const unused = k.glyphForCodePoint('W'.codePointAt(0)!).id
    expect(k.getGlyph(unused).path.commands.length).toBeGreaterThan(0)
    expect(p.getGlyph(unused).path.commands.length).toBe(0)
    // ...but the letters FreeType's auto-hinter measures stay, so the used ones are hinted as before (Linux)
    for (const ch of 'HOoxpg') {
      const g = k.glyphForCodePoint(ch.codePointAt(0)!).id
      expect(JSON.stringify(p.getGlyph(g).path.commands), ch).toBe(JSON.stringify(k.getGlyph(g).path.commands))
    }
    // the Greek references only when Greek is shown
    const omega = k.glyphForCodePoint(0x3a9).id
    expect(p.getGlyph(omega).path.commands.length).toBe(0)
    const withGreek = kit.create(pruneTrueType(original, [...gids, k.glyphForCodePoint(0x3b1).id])!.bytes)
    expect(withGreek.getGlyph(omega).path.commands.length).toBeGreaterThan(0)
  })

  it('maps characters to glyph ids through the cmap as fontkit does (Latin, Greek, Cyrillic, Hebrew, Arabic, missing)', () => {
    for (const face of ['Regular', 'Bold'] as const) {
      const font = notoBytes(face)
      const k = kit.create(font)
      const cmap = parseSfnt(font)!.tables.get('cmap')
      const text = 'AHox0ΩЖש'
      const expected = [...text].map((ch) => k.glyphForCodePoint(ch.codePointAt(0)!).id).filter((g) => g > 0)
      expect(glyphsForText(cmap, text), face).toEqual(expected)
    }
    expect(glyphsForText(undefined, 'abc')).toEqual([])
  })

  it('produces a structurally valid sfnt: sorted directory, correct checksums, whole-file checksum constant', () => {
    const pruned = pruneTrueType(notoBytes('Bold'), [40, 41, 42])!
    const b = pruned.bytes
    const u32 = (o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
    const n = (b[4] << 8) | b[5]
    const tags: string[] = []
    let sum = 0
    for (let i = 0; i < b.length; i += 4) sum = (sum + u32(i)) >>> 0
    expect(sum).toBe(0xb1b0afba)
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16
      tags.push(String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]))
      const off = u32(o + 8)
      const len = u32(o + 12)
      expect(off % 4).toBe(0)
      let s = 0
      const padded = new Uint8Array((len + 3) & ~3)
      padded.set(b.subarray(off, off + len))
      // head's own checksum is defined with the adjustment field zeroed
      if (tags[i] === 'head') padded.fill(0, 8, 12)
      for (let k = 0; k < padded.length; k += 4) s = (s + ((padded[k] << 24) | (padded[k + 1] << 16) | (padded[k + 2] << 8) | padded[k + 3])) >>> 0
      expect(u32(o + 4), `checksum of ${tags[i]}`).toBe(s)
    }
    expect(tags).toEqual([...tags].sort())
    expect(tags).not.toContain('GPOS')
    expect(tags).toContain('glyf')
    expect(parseSfnt(b)!.tables.get('maxp')).toBeTruthy()
  })

  it('refuses fonts it cannot prune safely (CFF, collections, junk, colour tables)', () => {
    expect(pruneTrueType(new Uint8Array([1, 2, 3]), [1])).toBeNull()
    const otto = new Uint8Array(64)
    otto.set([0x4f, 0x54, 0x54, 0x4f])
    expect(pruneTrueType(otto, [1])).toBeNull()
    expect(pruneTrueType(notoBytes('Regular').subarray(0, 4000), [1])).toBeNull() // truncated
  })
})

describe('font subsetting in the document pipeline', () => {
  it('a fully embedded font shrinks to what the page needs, and text is unchanged', async () => {
    const { bytes } = await fontDoc(['Hello, Café Quarterly 2025'])
    const before = fontPrograms(await PDFDocument.load(bytes))
    expect(encodedBytes(before[0]).length).toBeGreaterThan(200_000)
    const r = await run(bytes)
    expect(r.kept).toBe('result')
    expect(r.stats.fonts).toMatchObject({ candidates: 1, subsetted: 1 })
    const out = await PDFDocument.load(r.bytes)
    const prog = fontPrograms(out)
    expect(prog).toHaveLength(1)
    expect(encodedBytes(prog[0]).length).toBeLessThan(encodedBytes(before[0]).length * 0.2)
    expect(r.bytes.length).toBeLessThan(bytes.length * 0.3)
    expect(await pdfjsText(r.bytes)).toBe('Hello, Café Quarterly 2025')
    // the font name now carries a subset tag, Length1 matches the program
    const raw = decodeStream(out.context, prog[0])!
    expect(Number((prog[0].dict.get(N('Length1')) as unknown as { asNumber(): number }).asNumber())).toBe(raw.length)
    const type0 = out.context.enumerateIndirectObjects().map(([, o]) => o).find((o) => o instanceof PDFDict && String(o.get(N('Subtype'))) === '/Type0') as PDFDict
    expect(String(type0.get(N('BaseFont')))).toMatch(/^\/[A-Z]{6}\+/)
  })

  it('glyphs used on ANY page are kept: the union across pages', async () => {
    const { bytes } = await fontDoc(['Alpha Bravo', 'Charlie Delta 789'])
    const r = await run(bytes)
    expect(r.stats.fonts.subsetted).toBe(1)
    expect(await pdfjsText(r.bytes, 1)).toBe('Alpha Bravo')
    expect(await pdfjsText(r.bytes, 2)).toBe('Charlie Delta 789')
    const k = kit.create(notoBytes('Regular'))
    const p = kit.create(decodeStream((await PDFDocument.load(r.bytes)).context, fontPrograms(await PDFDocument.load(r.bytes))[0])!)
    for (const ch of 'AlphBravoCDeti789') {
      const g = k.glyphForCodePoint(ch.codePointAt(0)!).id
      expect(JSON.stringify(p.getGlyph(g).path.commands), ch).toBe(JSON.stringify(k.getGlyph(g).path.commands))
    }
  })

  it('a font that is also a form default resource (someone may type new text with it) is left whole', async () => {
    const { bytes } = await fontDoc(['Only some letters'], { formDefault: true })
    const r = await run(bytes)
    expect(r.stats.fonts.subsetted).toBe(0)
    const out = await PDFDocument.load(r.bytes)
    expect(encodedBytes(fontPrograms(out)[0]).length).toBeGreaterThan(200_000)
  })

  it('does nothing unless the option is on', async () => {
    const { bytes } = await fontDoc(['Hello'])
    const r = await run(bytes, { subsetFonts: false })
    expect(r.stats.fonts.subsetted).toBe(0)
    expect(encodedBytes(fontPrograms(await PDFDocument.load(r.bytes))[0]).length).toBeGreaterThan(200_000)
  })

  it('content that cannot be parsed keeps the font intact', async () => {
    const { bytes } = await fontDoc(['Hello'])
    const doc = await PDFDocument.load(bytes)
    const page = doc.getPage(0)
    const bad = doc.context.register(doc.context.flateStream('BT (unterminated'))
    const c = page.node.get(N('Contents'))
    const arr = c instanceof PDFArray ? c : doc.context.obj([c as PDFRef])
    arr.push(bad)
    page.node.set(N('Contents'), arr)
    const r = await run(await doc.save())
    expect(r.stats.fonts.subsetted).toBe(0)
  })

  it('the Smallest preset trims fonts, Balanced and High do not', () => {
    expect(PRESETS.smallest.subsetFonts).toBe(true)
    expect(PRESETS.balanced.subsetFonts).toBe(false)
    expect(PRESETS.high.subsetFonts).toBe(false)
  })

  it('pages still count and open in PDF.js after trimming', async () => {
    const { bytes } = await fontDoc(['One', 'Two', 'Three'])
    const r = await run(bytes)
    expect(await pdfjsPageCount(r.bytes)).toBe(3)
  })
})
