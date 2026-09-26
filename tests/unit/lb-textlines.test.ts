import { PDFDict, PDFName, PDFNumber } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildLines, isRtlCodePoint, rtlRatio, visualToLogical, type RunLike } from '../../src/shared/features/textlines'
import { addBookmarkTree } from '../../src/renderer/src/features/bookmarks/pdf/ops'
import { validateOutline } from '../../src/renderer/src/features/bookmarks/pdf/validate'
import { makeDoc } from './pdfTestUtils'

const run = (text: string, x: number, baseline: number, size = 12, bold = false, w = size * 0.5): RunLike => ({
  glyphs: Array.from(text).map((ch, i) => ({ text: ch, x0: x + i * w, x1: x + (i + 1) * w })),
  baseline,
  y0: baseline - size * 0.2,
  y1: baseline + size * 0.8,
  size,
  bold,
  italic: false,
  fontKey: bold ? 'Sans-Bold' : 'Sans'
})

describe('text lines', () => {
  it('joins runs on one baseline into a line, inserting a space for a gap, with a box per character', () => {
    const lines = buildLines([run('Hello', 72, 700), run('world', 72 + 5 * 6 + 3, 700)])
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('Hello world')
    expect(lines[0].chars).toHaveLength(lines[0].text.length)
    expect(lines[0].x0).toBe(72)
    expect(lines[0].x1).toBeCloseTo(72 + 5 * 6 + 3 + 5 * 6, 6)
    expect(lines[0].chars[0]).toEqual({ x0: 72, x1: 78 })
  })

  it('separates lines by baseline (top first) and columns by a wide horizontal gap', () => {
    const lines = buildLines([run('second', 72, 680), run('first', 72, 700), run('left column', 72, 660), run('right column', 320, 660)])
    expect(lines.map((l) => l.text)).toEqual(['first', 'second', 'left column', 'right column'])
  })

  it('takes size and weight from the dominant run and tolerates sub/superscript baselines', () => {
    const lines = buildLines([run('Chapter', 72, 700, 20, true), run('1', 72 + 7 * 10 + 1, 703, 10, false)])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ size: 20, bold: true, fontKey: 'Sans-Bold' })
  })

  it('splits a multi-character glyph (ligature) evenly across its characters', () => {
    const r: RunLike = { ...run('', 0, 0), glyphs: [{ text: 'ffi', x0: 10, x1: 25 }, { text: 'x', x0: 25, x1: 31 }] }
    const [line] = buildLines([r])
    expect(line.text).toBe('ffix')
    expect(line.chars.map((c) => [c.x0, c.x1])).toEqual([[10, 15], [15, 20], [20, 25], [25, 31]])
  })

  it('ignores runs with no visible text and unknown characters', () => {
    const r: RunLike = { ...run('', 0, 0), glyphs: [{ text: '�', x0: 0, x1: 5 }, { text: ' ', x0: 5, x1: 8 }] }
    expect(buildLines([r])).toEqual([])
  })

  it('marks right-to-left lines and gives them a logical reading', () => {
    // Stored visually (leftmost glyph first): the reverse of "مرحبا 42".
    const visual = '42 ابحرم'
    const [line] = buildLines([run(visual, 72, 700)])
    expect(line.rtl).toBe(true)
    expect(line.text).toBe(visual)
    expect(line.logical).toBe('مرحبا 42')
    expect(rtlRatio('abc')).toBe(0)
    expect(rtlRatio('שלום')).toBe(1)
    expect(isRtlCodePoint('ع'.codePointAt(0)!)).toBe(true)
    expect(isRtlCodePoint('٣'.codePointAt(0)!)).toBe(false) // Arabic-Indic digits are numbers, not letters
    expect(visualToLogical('Latin only 123')).toBe('Latin only 123')
  })
})

describe('outline validator: every kind of damage is named', () => {
  const N = (s: string): PDFName => PDFName.of(s)
  const build = async (): Promise<{ doc: Awaited<ReturnType<typeof makeDoc>>; items: PDFDict[]; root: PDFDict }> => {
    const doc = await makeDoc(3)
    addBookmarkTree(
      doc,
      [
        { title: 'A', page: { pageIndex: 0, tail: ['Fit'] }, children: [{ title: 'A1', page: { pageIndex: 1, tail: ['Fit'] } }] },
        { title: 'B', page: { pageIndex: 2, tail: ['Fit'] } }
      ],
      'replace'
    )
    const root = doc.catalog.lookup(N('Outlines'), PDFDict)
    const a = doc.context.lookup(root.get(N('First')) as never, PDFDict)
    const b = doc.context.lookup(a.get(N('Next')) as never, PDFDict)
    const a1 = doc.context.lookup(a.get(N('First')) as never, PDFDict)
    return { doc, items: [a, b, a1], root }
  }
  const problems = async (mutate: (x: { items: PDFDict[]; root: PDFDict; doc: Awaited<ReturnType<typeof makeDoc>> }) => void): Promise<string> => {
    const x = await build()
    expect(validateOutline(x.doc)).toEqual([])
    mutate(x)
    return validateOutline(x.doc).join(' | ')
  }

  it('wrong parent, wrong prev, wrong last, missing title, both Dest and A, bad count, cycles', async () => {
    expect(await problems(({ items }) => items[2].set(N('Parent'), items[0].get(N('Next'))!))).toMatch(/Parent/)
    expect(await problems(({ items }) => items[1].set(N('Prev'), items[0].get(N('First'))!))).toMatch(/Prev/)
    expect(await problems(({ root, items }) => root.set(N('Last'), items[0].get(N('First'))!))).toMatch(/Last/)
    expect(await problems(({ items }) => items[1].delete(N('Title')))).toMatch(/Title/)
    expect(await problems(({ items, doc }) => items[1].set(N('A'), doc.context.obj({ S: 'URI', URI: 'x' })))).toMatch(/both \/Dest and \/A/)
    expect(await problems(({ items }) => items[0].set(N('Count'), PDFNumber.of(7)))).toMatch(/Count/)
    expect(await problems(({ root }) => root.set(N('Count'), PDFNumber.of(1)))).toMatch(/root \/Count/)
    expect(await problems(({ items }) => items[1].set(N('Next'), items[0].get(N('Parent'))!))).toMatch(/twice|cycle/)
    expect(await problems(({ items, doc }) => items[1].set(N('Dest'), doc.context.obj([items[0].get(N('Parent')), 'Fit'])))).toMatch(/Dest does not start with a page/)
    expect(await problems(({ items, doc }) => items[0].set(N('C'), doc.context.obj([1, 2])))).toMatch(/\/C/)
    expect(await problems(({ items }) => items[0].set(N('F'), PDFNumber.of(9)))).toMatch(/\/F/)
  })
})
