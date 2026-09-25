import { PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks, findBlock } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { buildPdf, helvetica, times } from './helpers/pdfBuilder'

async function blocks(content: string | string[], fonts: Record<string, Record<string, unknown>> = { F1: helvetica, F2: times }, rotate?: number) {
  const { bytes } = await buildPdf([{ content, fonts, rotate }])
  const a = analyzePage(await PDFDocument.load(bytes), 0)
  return { a, set: buildBlocks(a) }
}

const lineTexts = (set: ReturnType<typeof buildBlocks>): string[] => set.lines.map((b) => b.text).sort()

describe('lines', () => {
  it('joins consecutive runs on one baseline into a line, adding spaces where words were positioned apart', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td (Hello) Tj 35 0 Td (world) Tj ET')
    expect(set.lines).toHaveLength(1)
    expect(set.lines[0].text).toBe('Hello world')
    expect(set.lines[0].runs).toHaveLength(2)
  })

  it('does not add a space when a run already ends or starts with one', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td (Hello ) Tj (world) Tj ET')
    expect(set.lines[0].text).toBe('Hello world')
  })

  it('reads a wide gap inside a TJ (positioning instead of a space glyph) as a space, but not tight kerning', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td [(He) 40 (llo) -300 (Wor) 60 (ld)] TJ ET')
    expect(set.lines[0].text).toBe('Hello World')
  })

  it('splits a baseline into separate blocks at wide gaps (table cells, columns)', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td (Name) Tj 200 0 Td (Amount) Tj 150 0 Td (Date) Tj ET')
    expect(lineTexts(set)).toEqual(['Amount', 'Date', 'Name'])
  })

  it('keeps different font sizes on one baseline apart', async () => {
    const { set } = await blocks('BT /F1 24 Tf 72 700 Td (Big) Tj /F1 8 Tf (small) Tj ET')
    expect(lineTexts(set)).toEqual(['Big', 'small'])
  })

  it('a superscript (raised baseline) is its own block', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td (E=mc) Tj 5 Ts /F1 8 Tf (2) Tj ET')
    expect(lineTexts(set)).toEqual(['2', 'E=mc'])
  })

  it('does not merge overprinted duplicates (fake bold) into "HelloHello"', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td (Hello) Tj ET BT /F1 12 Tf 72.3 700 Td (Hello) Tj ET')
    expect(lineTexts(set)).toEqual(['Hello', 'Hello'])
  })

  it('ignores whitespace-only runs and invisible (OCR) text', async () => {
    const { set, a } = await blocks('BT /F1 12 Tf 72 700 Td (   ) Tj ET BT /F1 12 Tf 3 Tr 72 600 Td (scanned words) Tj ET')
    expect(set.lines).toHaveLength(0)
    expect(a.hiddenRuns).toBe(1)
  })

  it('keeps blocks from the page and from a form apart even at the same place', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 12 Tf 72 700 Td (page) Tj ET /Fm1 Do', fonts: { F1: helvetica } }])
    const f = doc.context.register(doc.context.obj(helvetica))
    const form = doc.context.register(doc.context.flateStream('BT /T1 12 Tf 72 700 Td (form) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 300], Resources: { Font: { T1: f } } } as never))
    doc.getPage(0).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Fm1: form }))
    const set = buildBlocks(analyzePage(await PDFDocument.load(await doc.save()), 0))
    expect(lineTexts(set)).toEqual(['form', 'page'])
    expect(new Set(set.lines.map((l) => l.source)).size).toBe(2)
  })

  it('block ids are unique and stable across analyses of the same bytes', async () => {
    const { bytes } = await buildPdf([{ content: 'BT /F1 12 Tf 72 700 Td (a) Tj 0 -30 Td (b) Tj 0 -30 Td (c) Tj ET', fonts: { F1: helvetica } }])
    const ids = async () => buildBlocks(analyzePage(await PDFDocument.load(bytes), 0)).lines.map((l) => l.id)
    const one = await ids()
    expect(new Set(one).size).toBe(3)
    expect(await ids()).toEqual(one)
    const set = buildBlocks(analyzePage(await PDFDocument.load(bytes), 0))
    expect(findBlock(set, one[1])?.text).toBe('b')
    expect(findBlock(set, 'nope')).toBeUndefined()
  })

  it('reports geometry in user space with the ascent/descent of the font', async () => {
    const { set } = await blocks('BT /F1 20 Tf 100 300 Td (Height) Tj ET')
    const b = set.lines[0]
    expect(b.size).toBe(20)
    expect(b.bbox.x0).toBeCloseTo(100)
    expect(b.bbox.y1).toBeCloseTo(300 + 0.718 * 20, 1)
    expect(b.bbox.y0).toBeCloseTo(300 - 0.207 * 20, 1)
    expect(b.lines[0].baseline).toBeCloseTo(300)
  })
})

describe('paragraphs', () => {
  const para = (n: number, lead = 15, x = 72, size = 12) =>
    `BT /F1 ${size} Tf ${lead} TL ${x} 700 Td ` + Array.from({ length: n }, (_, i) => `(Line number ${i + 1} of text) ${i === 0 ? 'Tj' : "'"}`).join(' ') + ' ET'

  it('chains lines with the same leading and left edge', async () => {
    const { set } = await blocks(para(4))
    expect(set.lines).toHaveLength(4)
    expect(set.paragraphs).toHaveLength(1)
    const p = set.paragraphs[0]
    expect(p.text).toBe('Line number 1 of text\nLine number 2 of text\nLine number 3 of text\nLine number 4 of text')
    expect(p.lines).toHaveLength(4)
    expect(p.leading).toBeCloseTo(15)
    expect(p.level).toBe('paragraph')
    expect(p.editable).toBe(true)
  })

  it('a bigger gap starts a new paragraph', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td (one) Tj 0 -14 Td (two) Tj 0 -14 Td (three) Tj 0 -60 Td (far away) Tj 0 -14 Td (next) Tj ET')
    expect(set.paragraphs.map((p) => p.text)).toEqual(['one\ntwo\nthree', 'far away\nnext'])
  })

  it('does not chain lines of different sizes, or leading that changes', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td (small) Tj /F1 20 Tf 0 -22 Td (large) Tj ET')
    expect(set.paragraphs).toHaveLength(0)
    const irregular = await blocks('BT /F1 12 Tf 72 700 Td (a) Tj 0 -14 Td (b) Tj 0 -14 Td (c) Tj 0 -30 Td (d) Tj ET')
    expect(irregular.set.paragraphs.map((p) => p.text)).toEqual(['a\nb\nc'])
  })

  it('keeps two columns apart', async () => {
    const left = 'BT /F1 12 Tf 72 700 Td (left one) Tj 0 -14 Td (left two) Tj 0 -14 Td (left three) Tj ET'
    const right = 'BT /F1 12 Tf 350 700 Td (right one) Tj 0 -14 Td (right two) Tj 0 -14 Td (right three) Tj ET'
    const { set } = await blocks([left, right].join('\n'))
    expect(set.paragraphs.map((p) => p.text).sort()).toEqual(['left one\nleft two\nleft three', 'right one\nright two\nright three'])
  })

  it('handles centered and right-aligned paragraphs', async () => {
    const centered = await blocks('BT /F1 12 Tf 250 700 Td (Title) Tj -20 -14 Td (A longer subtitle) Tj ET')
    expect(centered.set.paragraphs).toHaveLength(0) // centers differ by > tolerance: stays two lines
    const right = await blocks('BT /F1 12 Tf 1 0 0 1 400 700 Tm (short) Tj ET BT /F1 12 Tf 1 0 0 1 367.3 686 Tm (a bit longer) Tj ET')
    expect(right.set.paragraphs.map((p) => p.text)).toEqual(['short\na bit longer'])
  })

  it('an indented first line still belongs to its paragraph', async () => {
    const { set } = await blocks('BT /F1 12 Tf 90 700 Td (Indented first line of it) Tj -18 -14 Td (second line at the margin) Tj 0 -14 Td (third at the margin) Tj ET')
    expect(set.paragraphs).toHaveLength(1)
    expect(set.paragraphs[0].lines).toHaveLength(3)
  })

  it('lines with different fonts but the same size can share a paragraph', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td (regular text) Tj /F2 12 Tf 0 -14 Td (serif text) Tj ET')
    expect(set.paragraphs).toHaveLength(1)
  })
})

describe('editability flags', () => {
  it('flags page rotation, rotated text and unmapped characters with a reason', async () => {
    const rot = await blocks('BT /F1 12 Tf 72 700 Td (turned) Tj ET', undefined, 90)
    expect(rot.set.lines[0].editable).toBe(false)
    expect(rot.set.lines[0].reason).toMatch(/rotated pages/)
    const skew = await blocks('BT /F1 12 Tf 1 0 0.3 1 72 700 Tm (slanted) Tj ET')
    expect(skew.set.lines[0].editable).toBe(false)
    expect(skew.set.lines[0].reason).toMatch(/rotated, mirrored or skewed/)
    const mirrored = await blocks('BT /F1 12 Tf -1 0 0 1 300 700 Tm (mirror) Tj ET')
    expect(mirrored.set.lines[0].editable).toBe(false)
  })

  it('paragraphs are only built from editable lines', async () => {
    const { set } = await blocks('BT /F1 12 Tf 72 700 Td (ok one) Tj 0 -14 Td (ok two) Tj ET BT /Nofont 12 Tf 72 672 Td (broken) Tj ET')
    expect(set.paragraphs.map((p) => p.text)).toEqual(['ok one\nok two'])
    expect(set.lines.filter((l) => !l.editable)).toHaveLength(1) // the run in the missing font
  })
})
