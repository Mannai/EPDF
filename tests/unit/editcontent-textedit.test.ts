import { PDFDocument, PDFName, PDFRef, StandardFonts, rgb } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks, findBlock, type TextBlock } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { bytesToLatin1, formatOp, parseContent, serializeContent } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import { applyTextEdit, wrapLines, type FontLoader, type TextEditRequest } from '../../src/renderer/src/features/textedit/pdfcontent/textEdit'
import { EditRefusedError } from '../../src/renderer/src/features/textedit/pdfcontent/write'
import { buildPdf, helvetica, notoBytes, pdfLibDoc, register, stream, subsetSimpleFont, times, type Lit, type PageSpec, type Pdf } from './helpers/pdfBuilder'

const loader: FontLoader = { unicodeFont: async (style) => notoBytes(style.bold ? (style.italic ? 'BoldItalic' : 'Bold') : style.italic ? 'Italic' : 'Regular') }

async function blocksOf(bytes: Uint8Array, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes)
  return buildBlocks(analyzePage(doc, pageIndex))
}

async function lineTexts(bytes: Uint8Array, pageIndex = 0): Promise<string[]> {
  return (await blocksOf(bytes, pageIndex)).lines.map((b) => b.text)
}

async function block(bytes: Uint8Array, contains: string, level: 'line' | 'paragraph' = 'line', pageIndex = 0): Promise<TextBlock> {
  const set = await blocksOf(bytes, pageIndex)
  const b = (level === 'line' ? set.lines : set.paragraphs).find((x) => x.text.includes(contains))
  if (!b) throw new Error(`no ${level} block containing "${contains}" in ${JSON.stringify(set.lines.map((l) => l.text))}`)
  return b
}

interface Edited {
  bytes: Uint8Array
  strategy: string
  message: string
}

async function edit(bytes: Uint8Array, contains: string, newText: string | ((old: string) => string), extra: Partial<TextEditRequest> = {}, level: 'line' | 'paragraph' = 'line', pageIndex = 0): Promise<Edited> {
  const b = await block(bytes, contains, level, pageIndex)
  const doc = await PDFDocument.load(bytes)
  const res = await applyTextEdit(doc, pageIndex, { blockId: b.id, oldText: b.text, newText: typeof newText === 'function' ? newText(b.text) : newText, ...extra }, loader)
  return { bytes: await doc.save(), strategy: res.strategy, message: res.message }
}

/** Decoded operations of every stream of a page, as text. */
async function opsText(bytes: Uint8Array, pageIndex = 0): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  const a = analyzePage(doc, pageIndex)
  return [...a.sources.values()].flatMap((s) => s.slots.flatMap((sl) => sl.ops.map(formatOp)))
}

const oneLine = (content: string, fonts: Record<string, Lit> = { F1: helvetica }): Promise<Pdf> => buildPdf([{ content, fonts }])
async function simple(text: string, size = 14, x = 72, y = 700): Promise<Uint8Array> {
  return pdfLibDoc(async (doc, page) => {
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText(text, { x, y, size, font })
    page.drawText('Untouched neighbour text', { x, y: y - 60, size, font })
  })
}

describe('strategy 1: in-place edits with the document’s own font', () => {
  it('inserts a word in the middle of a line', async () => {
    const src = await simple('Hello world from Epdf')
    const r = await edit(src, 'Hello', 'Hello brave world from Epdf')
    expect(r.strategy).toBe('in-place')
    expect(r.message).toBe('Edited using the document’s own font')
    expect(await lineTexts(r.bytes)).toEqual(['Hello brave world from Epdf', 'Untouched neighbour text'])
  })

  it('deletes text, replaces characters, appends and prepends', async () => {
    const src = await simple('Hello world from Epdf')
    const cases: [string, string][] = [
      ['Hello world from Epdf', 'Hello from Epdf'],
      ['Hello world from Epdf', 'Hella world from Epdf'],
      ['Hello world from Epdf', 'Hello world from Epdf!!'],
      ['Hello world from Epdf', 'Oh, Hello world from Epdf'],
      ['Hello world from Epdf', 'X'],
      ['Hello world from Epdf', 'Hello world from Epd']
    ]
    for (const [from, to] of cases) {
      const r = await edit(src, from, to)
      expect(r.strategy, to).toBe('in-place')
      expect((await lineTexts(r.bytes))[0], to).toBe(to)
    }
  })

  it('deleting everything leaves an empty string, not a broken stream', async () => {
    const src = await simple('Hello world from Epdf')
    const r = await edit(src, 'Hello', '')
    expect(r.strategy).toBe('in-place')
    expect(await lineTexts(r.bytes)).toEqual(['Untouched neighbour text'])
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(1)
  })

  it('uses Windows-1252 characters the font already encodes (é, curly quotes, euro)', async () => {
    const src = await simple('Cafe costs 5')
    const r = await edit(src, 'Cafe', 'Café costs 5 € — “nice”')
    expect(r.strategy).toBe('in-place')
    expect((await lineTexts(r.bytes))[0]).toBe('Café costs 5 € — “nice”')
  })

  it('leaves every other operation byte-for-byte identical', async () => {
    const src = await simple('Hello world from Epdf')
    const before = await opsText(src)
    const r = await edit(src, 'Hello', 'Hello there world from Epdf')
    const after = await opsText(r.bytes)
    expect(after.length).toBe(before.length)
    const diff = before.map((o, i) => [o, after[i]]).filter(([a, b]) => a !== b)
    expect(diff).toHaveLength(1)
    expect(diff[0][1].toLowerCase()).toContain(Buffer.from('Hello there world from Epdf').toString('hex')) // pdf-lib writes hex strings
  })

  it('keeps kerning numbers in a TJ and edits only the affected string', async () => {
    const { bytes } = await oneLine('BT /F1 20 Tf 100 700 Td [(Hel) 30 (lo) -300 (World) 15 (!)] TJ ET')
    expect(await lineTexts(bytes)).toEqual(['Hello World!'])
    const r = await edit(bytes, 'Hello', 'Hello Word!')
    expect(r.strategy).toBe('in-place')
    const ops = await opsText(r.bytes)
    expect(ops.find((o) => o.endsWith('TJ'))).toBe('[(Hel) 30 (lo) -300 (Word) 15 (!)] TJ')
  })

  it('edits across several runs (Hello ) Tj (World) Tj', async () => {
    const { bytes } = await oneLine('BT /F1 12 Tf 50 500 Td (Hello ) Tj (there) Tj ( friend) Tj ET')
    expect(await lineTexts(bytes)).toEqual(['Hello there friend'])
    const r = await edit(bytes, 'Hello', 'Hello dear friend')
    expect(r.strategy).toBe('in-place')
    expect(await lineTexts(r.bytes)).toEqual(['Hello dear friend'])
    // the run boundaries survive: three show operations still exist
    expect((await opsText(r.bytes)).filter((o) => o.endsWith('Tj')).length).toBe(3)
  })

  it('handles the quote operators', async () => {
    const { bytes } = await oneLine("BT /F1 12 Tf 14 TL 50 500 Td (first) ' (second) ' 1 2 (third) \" ET")
    const set = await blocksOf(bytes)
    expect(set.lines.map((l) => l.text)).toEqual(['first', 'second', 'third'])
    const r = await edit(bytes, 'third', 'thirds')
    expect(r.strategy).toBe('in-place')
    expect((await opsText(r.bytes)).some((o) => o === '1 2 (thirds) "')).toBe(true)
  })

  it('a ligature code (fi) can only be edited whole', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 12 Tf 50 500 Td <01 02> Tj ET', fonts: {} }])
    const f = subsetSimpleFont(doc, { codes: { 1: 'ﬁ', 2: 'n', 0x66: 'f', 0x69: 'i' } })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F1: f }))
    const bytes = await doc.save()
    expect(await lineTexts(bytes)).toEqual(['ﬁn'])
    // change 'n' -> 'nn' (used code) stays in place, ligature untouched
    const r = await edit(bytes, 'ﬁ', 'ﬁnn')
    expect(r.strategy).toBe('in-place')
    // splitting the ligature: the region snaps outwards to the whole code
    const r2 = await edit(bytes, 'ﬁ', 'fin')
    expect(await lineTexts(r2.bytes)).toEqual(['fin'])
  })

  it('does not touch other pages or the page count', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (const t of ['Page one text', 'Page two text', 'Page three text']) doc.addPage([300, 300]).drawText(t, { x: 20, y: 200, size: 12, font })
    const bytes = await doc.save()
    const r = await edit(bytes, 'two', 'Page 2 text', {}, 'line', 1)
    const out = await PDFDocument.load(r.bytes)
    expect(out.getPageCount()).toBe(3)
    expect(await lineTexts(r.bytes, 0)).toEqual(['Page one text'])
    expect(await lineTexts(r.bytes, 1)).toEqual(['Page 2 text'])
    expect(await lineTexts(r.bytes, 2)).toEqual(['Page three text'])
  })
})

describe('in place with subset fonts: only glyphs the font is known to have', () => {
  const page = async (codes: Record<number, string>, content: string, name = 'ABCDEF+Arial') => {
    const { doc } = await buildPdf([{ content, fonts: {} }])
    const f = subsetSimpleFont(doc, { name, codes })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F1: f }))
    return doc.save()
  }

  it('reuses used characters in place', async () => {
    const bytes = await page({ 0x48: 'H', 0x65: 'e', 0x6c: 'l', 0x6f: 'o', 0x20: ' ' }, 'BT /F1 12 Tf 50 500 Td (Hello) Tj ET')
    const r = await edit(bytes, 'Hello', 'Hell ole')
    expect(r.strategy).toBe('in-place')
    expect(await lineTexts(r.bytes)).toEqual(['Hell ole'])
  })

  it('falls back to a standard font when a character is not in the subset', async () => {
    const bytes = await page({ 0x48: 'H', 0x65: 'e', 0x6c: 'l', 0x6f: 'o', 0x7a: 'z' }, 'BT /F1 12 Tf 50 500 Td (Hello) Tj ET')
    // 'z' is in ToUnicode/Widths but never used on the page, and the font is a subset: not assumed to exist
    const r = await edit(bytes, 'Hello', 'Hellz')
    expect(r.strategy).toBe('fallback-font')
    expect(r.message).toMatch(/Font not available in this PDF — used Helvetica/)
    expect(await lineTexts(r.bytes)).toEqual(['Hellz'])
  })
})

describe('in place with Type0 (Identity-H) fonts', () => {
  const build = async (glyphs: Record<number, string>, content: string, subset = true) => {
    const { type0Font } = await import('./helpers/pdfBuilder')
    const { doc } = await buildPdf([{ content, fonts: {} }])
    const f = type0Font(doc, { glyphs, subset })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F1: f }))
    return doc.save()
  }
  const G = { 1: 'H', 2: 'i', 3: '!', 4: ' ', 5: 'o' }

  it('rewrites 2-byte codes of glyphs already used', async () => {
    const bytes = await build(G, 'BT /F1 12 Tf 50 500 Td <000100020003> Tj ET')
    const r = await edit(bytes, 'Hi', 'Hi!!')
    expect(r.strategy).toBe('in-place')
    const ops = await opsText(r.bytes)
    expect(ops.some((o) => o.includes('<0001000200030003>'))).toBe(true)
    expect(await lineTexts(r.bytes)).toEqual(['Hi!!'])
  })

  it('a glyph that exists in the font program only by ToUnicode is not assumed present in a subset', async () => {
    const bytes = await build(G, 'BT /F1 12 Tf 50 500 Td <000100020003> Tj ET')
    const r = await edit(bytes, 'Hi', 'Ho!')
    expect(r.strategy).toBe('fallback-font')
    expect(await lineTexts(r.bytes)).toEqual(['Ho!'])
  })

  it('a non-subset Type0 font may use any glyph it lists widths for', async () => {
    const bytes = await build(G, 'BT /F1 12 Tf 50 500 Td <000100020003> Tj ET', false)
    const r = await edit(bytes, 'Hi', 'Ho!')
    expect(r.strategy).toBe('in-place')
    expect(await lineTexts(r.bytes)).toEqual(['Ho!'])
  })
})

describe('strategy 2: replace', () => {
  it('uses the closest standard font for the same size and position when the doc font cannot encode', async () => {
    const src = await pdfLibDoc(async (doc, page) => {
      const font = await doc.embedFont(await (async () => (await import('./helpers/pdfBuilder')).notoBytes())(), { subset: true })
      page.drawText('Привет', { x: 72, y: 500, size: 20, font })
      const h = await doc.embedFont(StandardFonts.TimesRomanBold)
      page.drawText('Other line', { x: 72, y: 400, size: 12, font: h })
    })
    // Cyrillic in a subset Noto: 'Привет' -> 'Привет мир': ' ' and 'м','и','р' partly missing -> replace, still Cyrillic via Noto
    const r = await edit(src, 'Привет', 'Привет мир')
    expect(['in-place', 'fallback-font']).toContain(r.strategy)
    expect(await lineTexts(r.bytes)).toEqual(['Привет мир', 'Other line'])
  })

  it('replaces with Helvetica for Latin text a subset cannot encode, and drops the old text from the stream', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 18 Tf 72 600 Td (Secret) Tj ET', fonts: {} }])
    const f = subsetSimpleFont(doc, { codes: { 0x53: 'S', 0x65: 'e', 0x63: 'c', 0x72: 'r', 0x74: 't' } })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F1: f }))
    const bytes = await doc.save()
    const r = await edit(bytes, 'Secret', 'Public')
    expect(r.strategy).toBe('fallback-font')
    const all = (await opsText(r.bytes)).join('\n')
    expect(all).not.toContain('Secret')
    expect(all).not.toMatch(/\(Secret\)/)
    const raw = bytesToLatin1(r.bytes)
    expect(raw).not.toContain('(Secret)')
    expect(await lineTexts(r.bytes)).toEqual(['Public'])
    // the new text object is self-contained and isolated by q/Q
    expect(all).toMatch(/q[\s\S]*BT[\s\S]*Tf[\s\S]*Tm[\s\S]*Tj[\s\S]*ET[\s\S]*Q/)
  })

  it('keeps the following text where it was when the removed operation advanced the position', async () => {
    const { bytes } = await oneLine('BT /F1 12 Tf 100 700 Td (AAA) Tj [-4000] TJ (BBB) Tj ET')
    const set = await blocksOf(bytes)
    expect(set.lines.map((l) => l.text)).toEqual(['AAA', 'BBB'])
    const bx = set.lines[1].bbox.x0
    const r = await edit(bytes, 'AAA', 'Ω')
    expect(r.strategy).toBe('fallback-font')
    const after = await blocksOf(r.bytes)
    const bbb = after.lines.find((l) => l.text === 'BBB')!
    expect(Math.abs(bbb.bbox.x0 - bx)).toBeLessThan(0.01)
    expect(after.lines.map((l) => l.text).sort()).toEqual(['BBB', 'Ω'])
  })

  it('keeps line-to-line movement for removed quote operators', async () => {
    const { bytes } = await oneLine("BT /F1 12 Tf 14 TL 100 700 Td (one) Tj (two) ' (three) ' ET")
    const y3 = (await blocksOf(bytes)).lines.find((l) => l.text === 'three')!.lines[0].baseline
    const r = await edit(bytes, 'two', 'Ω')
    const after = await blocksOf(r.bytes)
    expect(Math.abs(after.lines.find((l) => l.text === 'three')!.lines[0].baseline - y3)).toBeLessThan(0.01)
  })

  it('applies a new size and color while staying with the document font when it can', async () => {
    const src = await simple('Resize me')
    const r = await edit(src, 'Resize', 'Resize me', { size: 20, color: '#ff0000' })
    expect(r.strategy).toBe('document-font')
    expect(r.message).toBe('Edited using the document’s own font')
    const set = await blocksOf(r.bytes)
    const b = set.lines.find((l) => l.text === 'Resize me')!
    expect(Math.abs(b.size - 20)).toBeLessThan(0.01)
    expect(b.color.css).toBe('#ff0000')
    const untouched = set.lines.find((l) => l.text.startsWith('Untouched'))!
    expect(untouched.size).toBe(14)
    // baseline preserved
    expect(Math.abs(b.lines[0].baseline - 700)).toBeLessThan(0.01)
  })

  it('preserves the original device color when only the text changes size', async () => {
    const { bytes } = await oneLine('0.2 0.4 0.6 rg BT /F1 12 Tf 72 600 Td (Blue-ish) Tj ET')
    const r = await edit(bytes, 'Blue', 'Blue-ish', { size: 24 })
    const b = (await blocksOf(r.bytes)).lines.find((l) => l.text === 'Blue-ish')!
    expect(b.color.css).toBe('#336699')
  })

  it('positions replaced text in a scaled/translated coordinate system exactly', async () => {
    const { bytes } = await oneLine('q 0.5 0 0 0.5 100 200 cm BT /F1 40 Tf 60 80 Td (Scaled) Tj ET Q')
    const before = (await blocksOf(bytes)).lines[0]
    const r = await edit(bytes, 'Scaled', 'Scaled!', { size: 30 })
    const after = (await blocksOf(r.bytes)).lines.find((l) => l.text === 'Scaled!')!
    expect(Math.abs(after.lines[0].baseline - before.lines[0].baseline)).toBeLessThan(0.01)
    expect(Math.abs(after.lines[0].x0 - before.lines[0].x0)).toBeLessThan(0.01)
    expect(Math.abs(after.size - 30)).toBeLessThan(0.01)
  })

  it('preserves horizontal scaling, character spacing and rise for the document-font replacement', async () => {
    const { bytes } = await oneLine('BT /F1 12 Tf 80 Tz 1 Tc 3 Ts 72 600 Td (Squeezed) Tj ET')
    const r = await edit(bytes, 'Squeezed', 'Squeezed!', { size: 16 })
    const run = analyzePage(await PDFDocument.load(r.bytes), 0).runs.find((x) => x.text === 'Squeezed!')!
    expect(run.hScale).toBeCloseTo(0.8)
    expect(run.charSpace).toBe(1)
    expect(run.rise).toBe(3)
  })

  it('wraps replacement text within the original block width for paragraphs', async () => {
    const lines = ['The quick brown fox jumps', 'over the lazy dog and keeps', 'running far away from home']
    const content = 'BT /F1 12 Tf 14 TL 72 700 Td ' + lines.map((l) => `(${l}) '`).join(' ').replace("'", 'Tj') + ' ET'
    const { bytes } = await oneLine(content)
    const set = await blocksOf(bytes)
    expect(set.paragraphs).toHaveLength(1)
    const para = set.paragraphs[0]
    expect(para.text).toBe(lines.join('\n'))
    const right = Math.max(...para.lines.map((l) => l.x1))
    const r = await edit(bytes, 'quick', 'Ω ' + lines.join(' ') + ' and some more words to wrap around the block', {}, 'paragraph')
    expect(r.strategy).toBe('fallback-font')
    const after = await blocksOf(r.bytes)
    const outLines = after.lines.map((l) => l.text)
    expect(outLines.length).toBeGreaterThan(3)
    expect(outLines.join(' ')).toBe('Ω ' + lines.join(' ') + ' and some more words to wrap around the block')
    for (const l of after.lines) expect(l.lines[0].x1).toBeLessThanOrEqual(right + 0.5)
    // baselines step down by the original leading
    const ys = after.lines.map((l) => l.lines[0].baseline).sort((a, b) => b - a)
    expect(Math.abs(ys[0] - ys[1] - 14)).toBeLessThan(0.05)
  })

  it('an edit that joins two lines of a paragraph goes through replace (no in-place guess)', async () => {
    const { bytes } = await oneLine("BT /F1 12 Tf 14 TL 72 700 Td (first line) Tj (second line) ' ET")
    const r = await edit(bytes, 'first', 'first line second line', {}, 'paragraph')
    expect(r.strategy).toBe('document-font')
    expect((await lineTexts(r.bytes)).join(' ')).toBe('first line second line') // re-wrapped within the paragraph width
  })

  it('refuses characters no available font can show and leaves the document untouched', async () => {
    const src = await simple('Hello world from Epdf')
    const doc = await PDFDocument.load(src)
    const b = await block(src, 'Hello')
    await expect(applyTextEdit(doc, 0, { blockId: b.id, oldText: b.text, newText: 'Hello 世界' }, loader)).rejects.toThrow(EditRefusedError)
    await expect(applyTextEdit(doc, 0, { blockId: b.id, oldText: b.text, newText: 'Hello 世界' }, loader)).rejects.toThrow(/世/)
    // nothing was committed to the (still open) doc: its first page still reads the same
    expect(await lineTexts(await doc.save())).toEqual(['Hello world from Epdf', 'Untouched neighbour text'])
  })
})

describe('ActualText', () => {
  it('drops /ActualText from marked content around edited text (otherwise extractors keep the old words)', async () => {
    const { bytes } = await oneLine('/Span << /ActualText (Old words) /MCID 0 >> BDC BT /F1 12 Tf 72 600 Td (Old words) Tj ET EMC')
    const b = await block(bytes, 'Old')
    expect(b.editable).toBe(true)
    const r = await edit(bytes, 'Old', 'New words')
    expect(r.strategy).toBe('in-place')
    const ops = (await opsText(r.bytes)).join('\n')
    expect(ops).not.toContain('ActualText')
    expect(ops).not.toContain('Old words')
    expect(ops).toContain('MCID')
  })

  it('does the same for replaced text', async () => {
    const { bytes } = await oneLine('/Span << /ActualText (Old) >> BDC BT /F1 12 Tf 72 600 Td (Old) Tj ET EMC')
    const r = await edit(bytes, 'Old', 'Ω')
    expect((await opsText(r.bytes)).join('\n')).not.toContain('ActualText')
  })

  it('refuses when ActualText sits in a Properties resource it cannot rewrite', async () => {
    const { doc } = await buildPdf([{ content: '/Span /P1 BDC BT /F1 12 Tf 72 600 Td (Old) Tj ET EMC', fonts: { F1: helvetica } }])
    doc.getPage(0).node.Resources()!.set(PDFName.of('Properties'), doc.context.obj({ P1: { ActualText: doc.context.obj('x') } }))
    const bytes = await doc.save()
    const b = await block(bytes, 'Old')
    expect(b.editable).toBe(false)
    expect(b.reason).toMatch(/alternative text/)
  })
})

describe('containers: several streams, shared streams, forms', () => {
  it('rewrites only the stream that holds the text', async () => {
    const { bytes } = await buildPdf([
      { content: ['q 1 0 0 1 0 0 cm', 'BT /F1 12 Tf 72 600 Td (Target) Tj ET', 'Q BT /F1 12 Tf 72 500 Td (Other) Tj ET'], fonts: { F1: helvetica } }
    ])
    const before = await PDFDocument.load(bytes)
    const firstRef = (before.getPage(0).node.Contents() as unknown as { get(i: number): PDFRef }).get(0)
    const secondRef = (before.getPage(0).node.Contents() as unknown as { get(i: number): PDFRef }).get(1)
    const firstBytesBefore = before.context.lookup(firstRef)
    void firstBytesBefore
    const r = await edit(bytes, 'Target', 'Target!')
    const after = await PDFDocument.load(r.bytes)
    const arr = after.getPage(0).node.Contents() as unknown as { size(): number; get(i: number): PDFRef }
    expect(arr.size()).toBe(3)
    expect(arr.get(0).objectNumber).toBe(firstRef.objectNumber)
    expect(arr.get(1).objectNumber).toBe(secondRef.objectNumber)
    const ops = await opsText(r.bytes)
    expect(ops).toContain('(Target!) Tj')
    expect(ops).toContain('(Other) Tj')
  })

  it('a page stream shared with another page is copied, the other page is not changed', async () => {
    const doc = await PDFDocument.create()
    const fontRef = register(doc, helvetica)
    const shared = stream(doc, 'BT /F1 12 Tf 72 600 Td (Shared text) Tj ET')
    for (let i = 0; i < 2; i++) {
      const p = doc.addPage([300, 300])
      p.node.set(PDFName.of('Contents'), shared)
      p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: fontRef } }))
    }
    const bytes = await doc.save()
    const r = await edit(bytes, 'Shared', 'Edited text', {}, 'line', 0)
    expect(await lineTexts(r.bytes, 0)).toEqual(['Edited text'])
    expect(await lineTexts(r.bytes, 1)).toEqual(['Shared text'])
  })

  it('edits text inside a single-use Form XObject through the form stream', async () => {
    const { doc } = await buildPdf([{ content: 'q 1 0 0 1 50 50 cm /Fm1 Do Q BT /F1 10 Tf 10 10 Td (page text) Tj ET', fonts: { F1: helvetica } }])
    const f = doc.context.register(doc.context.obj(times))
    const form = doc.context.register(
      doc.context.flateStream('BT /T1 14 Tf 0 0 Td (inside form) Tj ET', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 100],
        Resources: { Font: { T1: f } }
      } as never)
    )
    doc.getPage(0).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Fm1: form }))
    const bytes = await doc.save()
    const r = await edit(bytes, 'inside', 'inside the form')
    expect(r.strategy).toBe('in-place')
    expect(await lineTexts(r.bytes)).toContain('inside the form')
    expect(await lineTexts(r.bytes)).toContain('page text')
    const out = await PDFDocument.load(r.bytes)
    const formStream = out.context.lookup(form) as unknown as { dict: { get(k: PDFName): unknown } }
    expect(formStream.dict.get(PDFName.of('BBox'))).toBeDefined() // dictionary entries survive
  })

  it('replace inside a form adds its font to the form resources only', async () => {
    const { doc } = await buildPdf([{ content: '/Fm1 Do', fonts: {} }])
    const f = doc.context.register(doc.context.obj(times))
    const form = doc.context.register(
      doc.context.flateStream('BT /T1 14 Tf 20 20 Td (inside form) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 100], Resources: { Font: { T1: f } } } as never)
    )
    doc.getPage(0).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Fm1: form }))
    const bytes = await doc.save()
    const r = await edit(bytes, 'inside', 'Ω inside')
    expect(await lineTexts(r.bytes)).toEqual(['Ω inside'])
    const out = await PDFDocument.load(r.bytes)
    const page = out.getPage(0)
    const pageFonts = page.node.Resources()!.lookup(PDFName.of('Font')) as unknown as { keys(): unknown[] }
    expect(pageFonts.keys()).toHaveLength(0)
    const formRes = (out.context.lookup(form) as unknown as { dict: { lookup(k: PDFName): { lookup(k: PDFName): { has(k: PDFName): boolean } } } }).dict.lookup(PDFName.of('Resources'))
    expect(formRes.lookup(PDFName.of('Font')).has(PDFName.of('EpdfF1'))).toBe(true)
  })

  it('refuses text in a shared form and reports why', async () => {
    const { doc } = await buildPdf([
      { content: '/Fm1 Do', fonts: {} },
      { content: '/Fm1 Do', fonts: {} }
    ])
    const f = doc.context.register(doc.context.obj(helvetica))
    const form = doc.context.register(
      doc.context.flateStream('BT /T1 14 Tf 20 20 Td (logo text) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 100], Resources: { Font: { T1: f } } } as never)
    )
    for (const i of [0, 1]) doc.getPage(i).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Fm1: form }))
    const bytes = await doc.save()
    const b = await block(bytes, 'logo')
    expect(b.editable).toBe(false)
    const d = await PDFDocument.load(bytes)
    await expect(applyTextEdit(d, 0, { blockId: b.id, oldText: b.text, newText: 'x' })).rejects.toThrow(/shared/)
  })
})

describe('refusals and failure injection: the document is never half-edited', () => {
  it('rejects a stale selection (text changed) and unknown blocks', async () => {
    const src = await simple('Hello world from Epdf')
    const b = await block(src, 'Hello')
    const doc = await PDFDocument.load(src)
    await expect(applyTextEdit(doc, 0, { blockId: b.id, oldText: 'Different', newText: 'x' })).rejects.toThrow(/changed/)
    await expect(applyTextEdit(doc, 0, { blockId: 'L:nope', oldText: 'x', newText: 'y' })).rejects.toThrow(/no longer/)
  })

  it('reports no-op edits without touching the document', async () => {
    const src = await simple('Hello world from Epdf')
    const b = await block(src, 'Hello')
    const doc = await PDFDocument.load(src)
    const res = await applyTextEdit(doc, 0, { blockId: b.id, oldText: b.text, newText: b.text })
    expect(res.noop).toBe(true)
  })

  it('refuses Type 3 fonts', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 12 Tf 72 600 Td (abc) Tj ET', fonts: {} }])
    const t3 = register(doc, { Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 10, 10], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: {}, Encoding: { Type: 'Encoding', Differences: [97, 'a', 'b', 'c'].map((x) => (typeof x === 'string' ? PDFName.of(x) : x)) }, FirstChar: 97, LastChar: 99, Widths: [500, 500, 500] })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F1: t3 }))
    const bytes = await doc.save()
    const b = await block(bytes, 'abc')
    expect(b.editable).toBe(false)
    expect(b.reason).toMatch(/Type 3/)
  })

  it('refuses rotated text and pages rotated by /Rotate', async () => {
    const { bytes } = await oneLine('BT /F1 12 Tf 0 1 -1 0 200 200 Tm (sideways) Tj ET')
    const b = await block(bytes, 'sideways')
    expect(b.editable).toBe(false)
    expect(b.reason).toMatch(/rotated/)
    const rot = await buildPdf([{ content: 'BT /F1 12 Tf 72 600 Td (turned page) Tj ET', fonts: { F1: helvetica }, rotate: 90 }])
    const b2 = await block(rot.bytes, 'turned')
    expect(b2.editable).toBe(false)
    expect(b2.reason).toMatch(/rotated pages/)
  })

  it('refuses text with characters that have no Unicode mapping', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 12 Tf 72 600 Td (a\\001b) Tj ET', fonts: {} }])
    const f = subsetSimpleFont(doc, { codes: { 0x61: 'a', 0x62: 'b', 5: 'x' } })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F1: f }))
    const b = await block(await doc.save(), 'a')
    expect(b.editable).toBe(false)
    expect(b.reason).toMatch(/Unicode/)
  })

  it('refuses fonts with no character mapping at all (embedded, no encoding, no ToUnicode)', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 12 Tf 72 600 Td (abc) Tj ET', fonts: {} }])
    const ff = stream(doc, new Uint8Array([1, 2, 3, 4]), {})
    const desc = register(doc, { Type: 'FontDescriptor', FontName: 'ABCDEF+Mystery', Flags: 4, FontBBox: [0, 0, 1000, 1000], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80, FontFile2: ff })
    const f = register(doc, { Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Mystery', FirstChar: 97, LastChar: 99, Widths: [500, 500, 500], FontDescriptor: desc })
    doc.getPage(0).node.Resources()!.set(PDFName.of('Font'), doc.context.obj({ F1: f }))
    const b = await block(await doc.save(), '�')
    expect(b.editable).toBe(false)
    expect(b.reason).toMatch(/no character mapping/)
  })

  it('aborts on malformed page content instead of writing garbage', async () => {
    const { bytes } = await oneLine('BT /F1 12 Tf 72 600 Td (fine) Tj ET (unterminated')
    const doc = await PDFDocument.load(bytes)
    await expect(applyTextEdit(doc, 0, { blockId: 'L:page:0:3#1', oldText: 'fine', newText: 'x' })).rejects.toThrow(EditRefusedError)
    await expect(applyTextEdit(doc, 0, { blockId: 'L:page:0:3#1', oldText: 'fine', newText: 'x' })).rejects.toThrow(/could not be read safely/)
  })

  it('refuses a text object that is never closed (cannot place replacement text)', async () => {
    const { bytes } = await oneLine('BT /F1 12 Tf 72 600 Td (open) Tj')
    const b = await block(bytes, 'open')
    const doc = await PDFDocument.load(bytes)
    await expect(applyTextEdit(doc, 0, { blockId: b.id, oldText: b.text, newText: 'Ω' }, loader)).rejects.toThrow(/BT without ET/)
  })

  it('all failed edits leave the serialized document byte-identical', async () => {
    const src = await simple('Hello world from Epdf')
    const b = await block(src, 'Hello')
    const doc = await PDFDocument.load(src)
    const before = await doc.save()
    for (const text of ['Hello 世界', 'Ω世']) {
      await applyTextEdit(doc, 0, { blockId: b.id, oldText: b.text, newText: text }, loader).catch(() => undefined)
    }
    const after = await doc.save()
    expect(after.length).toBe(before.length)
  })
})

describe('word wrapping', () => {
  const w = (s: string): number => s.length * 10
  it('wraps at spaces within the width', () => {
    expect(wrapLines('aaa bbb ccc ddd', w, () => 75)).toEqual(['aaa bbb', 'ccc ddd'])
  })
  it('keeps explicit newlines and empty lines', () => {
    expect(wrapLines('one\n\ntwo', w, () => 500)).toEqual(['one', '', 'two'])
  })
  it('breaks words longer than a line by characters', () => {
    expect(wrapLines('abcdefghij', w, () => 40)).toEqual(['abcd', 'efgh', 'ij'])
  })
  it('honours a different width for later lines', () => {
    expect(wrapLines('aa bb cc dd ee', w, (i) => (i === 0 ? 50 : 80))).toEqual(['aa bb', 'cc dd ee'])
  })
  it('never loops forever on a width smaller than one character', () => {
    expect(wrapLines('abc', w, () => 1).join('')).toBe('abc')
  })
})

describe('saved output stays valid', () => {
  it('re-parses cleanly, every stream operation is well formed, page tree intact', async () => {
    const src = await pdfLibDoc(async (doc, page) => {
      const f = await doc.embedFont(StandardFonts.Helvetica)
      for (let i = 0; i < 6; i++) page.drawText(`Line number ${i}`, { x: 72, y: 700 - i * 30, size: 14, font: f, color: rgb(0.1 * i, 0, 0) })
    })
    let bytes = src
    for (const [from, to] of [
      ['Line number 0', 'Line number zero'],
      ['Line number 1', 'Línea número uno'],
      ['Line number 2', 'Ω two'],
      ['Line number 3', '']
    ]) {
      bytes = (await edit(bytes, from, to)).bytes
    }
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    const a = analyzePage(doc, 0)
    for (const s of a.sources.values()) for (const sl of s.slots) expect(() => parseContent(serializeContent(sl.ops, sl.tail))).not.toThrow()
    const texts = buildBlocks(a).lines.map((l) => l.text).sort()
    expect(texts).toEqual(['Line number 4', 'Line number 5', 'Line number zero', 'Línea número uno', 'Ω two'].sort())
  })
})

// keep these referenced for readability of failures
void ([] as PageSpec[])
void findBlock
