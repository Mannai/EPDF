import { PDFArray, PDFDocument, PDFName, PDFRef } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { formatOp } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import { applyTextEdit, type FontLoader } from '../../src/renderer/src/features/textedit/pdfcontent/textEdit'
import { buildPdf, helvetica, notoBytes, register, stream, subsetSimpleFont, toUnicodeCMap, type Lit, type Pdf, type PageSpec } from './helpers/pdfBuilder'

/**
 * Documents assembled the way common producers write them (Word, Chrome/Skia, LibreOffice, pdfTeX, scanners),
 * to check that reading and editing survive their habits: flipped coordinate systems, tiny CTM scales, one
 * TJ per word, marked content, several streams, inherited resources.
 */

const loader: FontLoader = { unicodeFont: async () => notoBytes() }

const blocksOf = async (bytes: Uint8Array, page = 0) => buildBlocks(analyzePage(await PDFDocument.load(bytes), page))
async function edit(bytes: Uint8Array, contains: string, next: string, extra = {}): Promise<{ bytes: Uint8Array; strategy: string }> {
  const set = await blocksOf(bytes)
  const b = set.lines.find((l) => l.text.includes(contains)) ?? set.paragraphs.find((l) => l.text.includes(contains))
  if (!b) throw new Error(`no block "${contains}" in ${JSON.stringify(set.lines.map((l) => l.text))}`)
  const doc = await PDFDocument.load(bytes)
  const r = await applyTextEdit(doc, 0, { blockId: b.id, oldText: b.text, newText: next, ...extra }, loader)
  return { bytes: await doc.save(), strategy: r.strategy }
}
const near = (a: number, b: number, eps = 0.02): void => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(eps)

describe('Word-like output', () => {
  const word = async (): Promise<Pdf> => {
    const { doc } = await buildPdf([{ content: '', fonts: {} }])
    const f1 = subsetSimpleFont(doc, {
      name: 'ABCDEF+Calibri',
      codes: { 0x20: ' ', 0x2c: ',', 0x2e: '.', ...Object.fromEntries('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('').map((c) => [c.charCodeAt(0), c])) },
      width: 480
    })
    const f2 = subsetSimpleFont(doc, { name: 'GHIJKL+Calibri-Bold', codes: { 0x48: 'H', 0x65: 'e', 0x61: 'a', 0x64: 'd', 0x69: 'i', 0x6e: 'n', 0x67: 'g', 0x20: ' ' }, width: 500 })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F1: f1, F2: f2 }))
    // Word writes: marked content, text in a q/Q with a tiny scaling cm, one TJ per line with word gaps as numbers.
    const content = [
      '/P <</MCID 0>> BDC',
      'q 0.12 0 0 0.12 0 0 cm',
      'BT /F2 133.33 Tf 1 0 0 1 600 6500 Tm 0 g [(Heading)] TJ ET',
      'BT /F1 100 Tf 1 0 0 1 600 6000 Tm [(Word)-250(processors)-250(write)-250(text)-250(like)-250(this.)] TJ ET',
      'BT /F1 100 Tf 1 0 0 1 600 5850 Tm [(Second)-250(line)-250(of)-250(the)-250(paragraph.)] TJ ET',
      'Q',
      'EMC'
    ].join('\n')
    doc.getPage(0).node.set(PDFName.of('Contents'), stream(doc, content))
    return { doc, bytes: await doc.save() }
  }

  it('reads scaled text with one TJ per line and word gaps expressed as kerning numbers', async () => {
    const { bytes } = await word()
    const set = await blocksOf(bytes)
    expect(set.lines.map((l) => l.text)).toEqual(['Heading', 'Word processors write text like this.', 'Second line of the paragraph.'])
    // size 100 units under a 0.12 scale = 12 pt
    near(set.lines[1].size, 12)
    near(set.lines[1].bbox.x0, 72, 0.01)
    expect(set.paragraphs.map((p) => p.text)).toEqual(['Word processors write text like this.\nSecond line of the paragraph.'])
  })

  it('edits a word in place (used glyphs only) and keeps the TJ structure', async () => {
    const { bytes } = await word()
    const r = await edit(bytes, 'Word processors', 'Word editors write text like this.')
    expect(r.strategy).toBe('in-place')
    const doc = await PDFDocument.load(r.bytes)
    const a = analyzePage(doc, 0)
    const tjs = a.runs.map((x) => x.op)
    expect(tjs.every((op) => op === 'TJ')).toBe(true)
    expect(buildBlocks(a).lines.map((l) => l.text)).toContain('Word editors write text like this.')
    const ops = [...a.sources.values()][0].slots[0].ops.map(formatOp).join('\n')
    expect(ops).toContain('-250')
    expect(ops).toContain('BDC')
    expect(ops).toContain('EMC')
  })

  it('replaces with a fallback font at the same scaled size and baseline when a glyph is missing', async () => {
    const { bytes } = await word()
    const before = (await blocksOf(bytes)).lines.find((l) => l.text.startsWith('Word'))!
    const r = await edit(bytes, 'Word processors', 'Word processors write TEXT like this.') // 'T' is unused → not in the subset
    expect(r.strategy).toBe('fallback-font')
    const after = (await blocksOf(r.bytes)).lines.find((l) => l.text.includes('TEXT'))!
    near(after.size, before.size)
    near(after.lines[0].baseline, before.lines[0].baseline)
    near(after.bbox.x0, before.bbox.x0, 0.1)
    // and the untouched heading is still there in its own bold font
    expect((await blocksOf(r.bytes)).lines.some((l) => l.text === 'Heading')).toBe(true)
  })
})

describe('Chrome/Skia-like output (flipped page, Identity-H, glyph ids)', () => {
  const chrome = async (): Promise<Uint8Array> => {
    const { doc } = await buildPdf([{ content: '', fonts: {} }])
    const toUni = stream(doc, toUnicodeCMap([[3, ' '], [36, 'H'], [37, 'e'], [38, 'l'], [39, 'o'], [40, 'W'], [41, 'r'], [42, 'd'], [43, '!']], 2))
    const desc = register(doc, { Type: 'FontDescriptor', FontName: 'AAAAAA+Roboto-Regular', Flags: 4, FontBBox: [-100, -300, 1200, 1000], ItalicAngle: 0, Ascent: 927, Descent: -244, CapHeight: 711, StemV: 80 })
    const cid = register(doc, {
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'AAAAAA+Roboto-Regular',
      FontDescriptor: desc,
      DW: 1000,
      W: [3, [248], 36, [640], 37, [560], 38, [244], 39, [575], 40, [910], 41, [340], 42, [574], 43, [275]],
      CIDToGIDMap: 'Identity'
    })
    const f = register(doc, { Type: 'Font', Subtype: 'Type0', BaseFont: 'AAAAAA+Roboto-Regular', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: toUni })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F4: f }))
    // Chrome: flip the whole page, then flip the text back with a negative y scale in the text matrix.
    const content = ['1 0 0 -1 0 792 cm', 'q', 'BT', '16 0 0 -16 72 100 Tm', '/F4 1 Tf', '[<00240025002600260027> 0 <0003> 0 <0028002700290026002a>] TJ', 'ET', 'Q'].join('\n')
    doc.getPage(0).node.set(PDFName.of('Contents'), stream(doc, content))
    return doc.save()
  }

  it('reads text whose size lives in the text matrix (Tf 1) and whose axes are flipped twice', async () => {
    const set = await blocksOf(await chrome())
    // codes 0024 0025 0026 0026 0027 → Hello ; 0003 → space ; 0028 0027 0029 0026 002a → World
    expect(set.lines).toHaveLength(1)
    expect(set.lines[0].text).toBe('Hello World')
    near(set.lines[0].size, 16)
    near(set.lines[0].lines[0].baseline, 792 - 100)
    near(set.lines[0].bbox.x0, 72)
  })

  it('edits in place through the double flip', async () => {
    const r = await edit(await chrome(), 'Hello', 'Hello Wold')
    expect(r.strategy).toBe('in-place')
    const b = (await blocksOf(r.bytes)).lines[0]
    expect(b.text).toBe('Hello Wold')
    near(b.lines[0].baseline, 692)
  })

  it('replaces through the double flip: same baseline, same size, upright, old glyph codes gone', async () => {
    const r = await edit(await chrome(), 'Hello', 'Hello World!') // the "!" glyph is not used on the page
    expect(r.strategy).toBe('fallback-font')
    const a = analyzePage(await PDFDocument.load(r.bytes), 0)
    const b = buildBlocks(a).lines.find((l) => l.text === 'Hello World!')!
    expect(b).toBeTruthy()
    near(b.lines[0].baseline, 692)
    near(b.size, 16)
    near(b.bbox.x0, 72)
    expect(b.runs[0].upright).toBe(true)
    const all = [...a.sources.values()][0].slots[0].ops.map(formatOp).join('\n')
    expect(all).not.toContain('00240025')
  })
})

describe('LibreOffice-like output', () => {
  it('reads Td-positioned lines with /Differences and edits them', async () => {
    const { doc } = await buildPdf([{ content: '', fonts: {} }])
    const f = subsetSimpleFont(doc, {
      name: 'EEEEEE+LiberationSerif',
      codes: { 0x20: ' ', 0x4c: 'L', 0x69: 'i', 0x6e: 'n', 0x65: 'e', 1: 'ﬁ', 0x6f: 'o' },
      differences: [1, 'fi']
    })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F1: f }))
    doc.getPage(0).node.set(PDFName.of('Contents'), stream(doc, 'q\nBT\n56.7 720 Td\n/F1 12 Tf\n0 g\n(Line one) Tj\n0 -14.6 Td\n(Line \\001ne) Tj\nET\nQ'))
    const bytes = await doc.save()
    const set = await blocksOf(bytes)
    expect(set.lines.map((l) => l.text)).toEqual(['Line one', 'Line ﬁne'])
    const r = await edit(bytes, 'Line one', 'Line eon')
    expect(r.strategy).toBe('in-place')
    expect((await blocksOf(r.bytes)).lines.map((l) => l.text)).toEqual(['Line eon', 'Line ﬁne'])
  })
})

describe('pdfTeX-like output', () => {
  it('reads an embedded Type1 with /Differences and no ToUnicode; edits only used glyphs', async () => {
    const { doc } = await buildPdf([{ content: '', fonts: {} }])
    const ff = stream(doc, new Uint8Array([1, 2, 3]))
    const desc = register(doc, { Type: 'FontDescriptor', FontName: 'XYZABC+CMR10', Flags: 4, FontBBox: [-40, -250, 1009, 750], ItalicAngle: 0, Ascent: 694, Descent: -194, CapHeight: 683, StemV: 69, FontFile: ff })
    const widths = Array.from({ length: 12 }, () => 500)
    const f = register(doc, {
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'XYZABC+CMR10',
      FirstChar: 65,
      LastChar: 76,
      Widths: widths,
      FontDescriptor: desc,
      Encoding: { Type: 'Encoding', Differences: [65, ...'ABCDEFGHIJKL'.split('').map((c) => PDFName.of(c))] }
    })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F8: f }))
    doc.getPage(0).node.set(PDFName.of('Contents'), stream(doc, 'BT\n/F8 9.9626 Tf 133.768 707.125 Td [(ABC)-333(DEF)]TJ\nET'))
    const bytes = await doc.save()
    expect((await blocksOf(bytes)).lines[0].text).toBe('ABC DEF')
    const ok = await edit(bytes, 'ABC', 'ABC DEFFED')
    expect(ok.strategy).toBe('in-place')
    const missing = await edit(bytes, 'ABC', 'ABC DEFG') // G exists in the encoding but was never used
    expect(missing.strategy).toBe('fallback-font')
  })
})

describe('scanner/OCR output', () => {
  it('a page that is one image plus invisible text has no editable text, and says why', async () => {
    const { doc } = await buildPdf([{ content: 'q 612 0 0 792 0 0 cm /Im1 Do Q BT 3 Tr /F1 12 Tf 72 700 Td (invisible ocr words) Tj ET', fonts: { F1: helvetica } }])
    const img = doc.context.register(doc.context.stream(new Uint8Array(3), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 } as never))
    doc.getPage(0).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Im1: img }))
    const a = analyzePage(await PDFDocument.load(await doc.save()), 0)
    const set = buildBlocks(a)
    expect(set.lines).toHaveLength(0)
    expect(a.hiddenRuns).toBe(1)
    expect(a.images).toHaveLength(1)
    expect(a.images[0].bbox).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 })
  })
})

describe('structure: inherited resources and indirect content arrays', () => {
  it('finds fonts in Resources inherited from the page tree and adds fallback fonts without disturbing siblings', async () => {
    const doc = await PDFDocument.create()
    const p1 = doc.addPage([612, 792])
    const p2 = doc.addPage([612, 792])
    const font = register(doc, helvetica)
    const shared = doc.context.obj({ Font: { F1: font } })
    const pages = doc.catalog.lookup(PDFName.of('Pages')) as unknown as { set(k: PDFName, v: unknown): void }
    pages.set(PDFName.of('Resources'), shared)
    for (const [p, t] of [[p1, 'First page'], [p2, 'Second page']] as const) {
      p.node.delete(PDFName.of('Resources'))
      p.node.set(PDFName.of('Contents'), stream(doc, `BT /F1 12 Tf 72 700 Td (${t}) Tj ET`))
    }
    const bytes = await doc.save()
    const a = analyzePage(await PDFDocument.load(bytes), 0)
    expect(a.runs.map((r) => r.text)).toEqual(['First page'])
    const r = await edit(bytes, 'First', 'Ω First page')
    expect(r.strategy).toBe('fallback-font')
    const out = await PDFDocument.load(r.bytes)
    expect(buildBlocks(analyzePage(out, 0)).lines.map((l) => l.text)).toEqual(['Ω First page'])
    expect(buildBlocks(analyzePage(out, 1)).lines.map((l) => l.text)).toEqual(['Second page'])
    // the shared, inherited dictionary was not modified: page 2 does not see the added font
    const inherited = (out.catalog.lookup(PDFName.of('Pages')) as unknown as { lookup(k: PDFName): { lookup(k: PDFName): { keys(): unknown[] } } }).lookup(PDFName.of('Resources')).lookup(PDFName.of('Font'))
    expect(inherited.keys()).toHaveLength(1)
  })

  it('handles /Contents as an indirect array of streams', async () => {
    const { doc } = await buildPdf([{ content: '', fonts: { F1: helvetica } }])
    const s1 = stream(doc, 'BT /F1 12 Tf 72 700 Td (part one) Tj ET')
    const s2 = stream(doc, 'BT /F1 12 Tf 72 500 Td (part two) Tj ET')
    const arrRef = doc.context.register(doc.context.obj([s1, s2]))
    doc.getPage(0).node.set(PDFName.of('Contents'), arrRef)
    const bytes = await doc.save()
    expect((await blocksOf(bytes)).lines.map((l) => l.text).sort()).toEqual(['part one', 'part two'])
    const r = await edit(bytes, 'part two', 'part 2')
    expect((await blocksOf(r.bytes)).lines.map((l) => l.text).sort()).toEqual(['part 2', 'part one'])
    const out = await PDFDocument.load(r.bytes)
    const c = out.getPage(0).node.Contents()
    expect(c).toBeInstanceOf(PDFArray)
    expect((c as PDFArray).size()).toBe(2)
    void PDFRef
  })

  it('tolerates pages without any content stream, and content that is not a stream', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([200, 200])
    const a = analyzePage(await PDFDocument.load(await doc.save()), 0)
    expect(a.runs).toHaveLength(0)
    expect(a.images).toHaveLength(0)
    expect(a.endDepth).toBe(0)
  })

  it('analysis of an out-of-range page is a clean error', async () => {
    const { bytes } = await buildPdf([{ content: '', fonts: {} }] as PageSpec[])
    const doc = await PDFDocument.load(bytes)
    expect(() => analyzePage(doc, 3)).toThrow(/not found/)
  })
})

describe('randomised in-place edits always produce exactly the requested text', () => {
  const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
  it('60 random insert/delete/replace edits on a WinAnsi line', async () => {
    const r = rng(2024)
    const alphabet = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJ0123456789.,;:!?-'
    const base = 'The quick brown fox jumps over 13 lazy dogs'
    const { bytes } = await buildPdf([{ content: `BT /F1 12 Tf 72 700 Td [(The quick) -300 (brown fox) -300 (jumps over) -300 (13 lazy dogs)] TJ ET`, fonts: { F1: helvetica } }])
    for (let i = 0; i < 60; i++) {
      let s = base
      const nOps = 1 + Math.floor(r() * 3)
      for (let k = 0; k < nOps; k++) {
        const pos = Math.floor(r() * (s.length + 1))
        const kind = r()
        const len = Math.floor(r() * 4)
        const ins = Array.from({ length: 1 + Math.floor(r() * 4) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('')
        if (kind < 0.33) s = s.slice(0, pos) + ins + s.slice(pos)
        else if (kind < 0.66) s = s.slice(0, pos) + s.slice(pos + len)
        else s = s.slice(0, pos) + ins + s.slice(pos + len)
      }
      if (s === base) continue
      const out = await edit(bytes, 'quick', s)
      expect((await blocksOf(out.bytes)).lines.map((l) => l.text), s).toEqual([s === '' ? undefined : s].filter(Boolean) as string[])
    }
  })
})

void ([] as Lit[])
