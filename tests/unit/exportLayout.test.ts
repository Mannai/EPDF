import { describe, expect, it } from 'vitest'
import { describeFont } from '../../src/renderer/src/features/export/fonts'
import { assignTextColors, colorFromArgs, compose, interpretOperators } from '../../src/renderer/src/features/export/graphics'
import { documentStats, findGutter, layoutPage } from '../../src/renderer/src/features/export/layout'
import { alignOfBox, buildLines, runsOf } from '../../src/renderer/src/features/export/lines'
import type { LineItem, PageModel, ParagraphBlock, TableBlock, TextItem } from '../../src/renderer/src/features/export/model'
import { formatCode, parseNumber } from '../../src/renderer/src/features/export/numbers'
import { detectAlignedTables, detectRulingTables } from '../../src/renderer/src/features/export/tables'
import { openWithPdfjs } from '../support/exportFixtures'

const CHAR_W = 0.5

function item(text: string, x: number, y: number, o: Partial<TextItem> = {}): TextItem {
  const size = o.size ?? 11
  return { text, x, y, width: text.length * size * CHAR_W, size, fontName: 'Arial', family: 'Arial', bold: false, italic: false, mono: false, serif: false, color: '000000', ...o }
}

/** A left-aligned paragraph as separate line items, `pitch` apart. */
function lines(texts: string[], x: number, y0: number, o: Partial<TextItem> & { pitch?: number } = {}): TextItem[] {
  const { pitch = 14, ...rest } = o
  return texts.map((t, i) => item(t, x, y0 + i * pitch, rest))
}

const pageOf = (items: TextItem[], extra: Partial<PageModel> = {}): PageModel => ({ number: 1, width: 612, height: 792, items, images: [], rects: [], lines: [], links: [], ...extra })
const layout = (items: TextItem[], extra: Partial<PageModel> = {}) => {
  const page = pageOf(items, extra)
  return layoutPage(page, documentStats([page]))
}
const paragraphs = (l: ReturnType<typeof layout>): ParagraphBlock[] => l.blocks.filter((b): b is ParagraphBlock => b.type === 'paragraph')
const text = (p: ParagraphBlock): string => p.runs.map((r) => r.text).join('')

describe('lines and runs', () => {
  it('groups items with the same baseline into one line, ordered left to right', () => {
    const ls = buildLines([item('world', 80, 100.3), item('Hello', 40, 100), item('next', 40, 114)])
    expect(ls.length).toBe(2)
    expect(ls[0].items.map((i) => i.text)).toEqual(['Hello', 'world'])
  })

  it('inserts a space only where the gap needs one and merges equal styles', () => {
    const a = item('Hello', 40, 100)
    const b = item('world', 40 + a.width + 3, 100)
    const c = item('!', b.x + b.width, 100)
    expect(runsOf([a, b, c]).map((r) => r.text)).toEqual(['Hello world!'])
    const bold = item('bold', c.x + c.width + 3, 100, { bold: true })
    const runs = runsOf([a, b, c, bold])
    expect(runs.map((r) => [r.text, r.bold])).toEqual([['Hello world! ', false], ['bold', true]])
  })

  it('splits a line into segments at wide gaps', () => {
    const [l] = buildLines([item('Name', 72, 100), item('Qty', 250, 100), item('Price', 400, 100)])
    expect(l.segs.length).toBe(3)
    const [w] = buildLines([item('a', 72, 100), item('b', 72 + 5.5 + 3, 100)])
    expect(w.segs.length).toBe(1)
  })

  it('classifies alignment from the extents', () => {
    expect(alignOfBox(72, 200, 72, 540)).toBe('left')
    expect(alignOfBox(250, 350, 72, 540)).toBe('center')
    expect(alignOfBox(440, 540, 72, 540)).toBe('right')
  })
})

describe('paragraph reconstruction', () => {
  const body = 'x'.repeat(60)

  it('joins consecutive lines of one paragraph and starts a new one after a larger gap', () => {
    const items = [
      ...lines([body + ' one', body + ' two', body + ' end.'], 72, 100),
      ...lines([body + ' three', body + ' four.'], 72, 100 + 2 * 14 + 30)
    ]
    const ps = paragraphs(layout(items))
    expect(ps.length).toBe(2)
    expect(ps[0].lineCount).toBe(3)
    expect(text(ps[0])).toBe(`${body} one ${body} two ${body} end.`)
    expect(ps[1].lineCount).toBe(2)
    expect(ps[1].spaceBefore).toBeCloseTo(16) // 30pt gap minus one line pitch
    expect(ps[0].pitch).toBeCloseTo(14)
  })

  it('starts a new paragraph at a first-line indent and at a short line that ends a sentence', () => {
    const items = [
      item(body + ' first', 72, 100),
      item(body + ' cont', 72, 114),
      item('Short end of paragraph.', 72, 128),
      item(body + ' second', 72, 142),
      item(body + ' cont2', 72, 156),
      item('  indented start ' + body, 90, 170),
      item(body + ' cont3', 72, 184)
    ]
    const ps = paragraphs(layout(items))
    expect(ps.map((p) => p.lineCount)).toEqual([3, 2, 2])
    expect(ps[2].firstLine).toBeCloseTo(18)
  })

  it('keeps hanging list items together and starts a paragraph at each bullet', () => {
    const items = [
      item('• First item that wraps onto the next line of text', 72, 100),
      item('continuation of the first item', 90, 114),
      item('• Second item', 72, 128),
      item('1. Numbered', 72, 142)
    ]
    const ps = paragraphs(layout(items))
    expect(ps.length).toBe(3)
    expect(ps[0].lineCount).toBe(2)
    expect(ps[0].firstLine).toBeCloseTo(-18)
    expect(ps[0].indentLeft).toBeCloseTo(18)
  })

  it('removes a hyphen that ends a full line when the word continues in lower case, and only then', () => {
    const full = 'y'.repeat(70)
    const a = paragraphs(layout([item(full + ' inter-', 72, 100), item('national trade agreements.', 72, 114), item(full + ' fill', 72, 128)]))
    expect(text(a[0])).toContain('international trade')
    const upper = paragraphs(layout([item(full + ' Anglo-', 72, 100), item('Saxon kings.', 72, 114), item(full + ' fill', 72, 128)]))
    expect(text(upper[0])).toContain('Anglo- Saxon')
    const notFull = paragraphs(layout([item('short line well-', 72, 100), item('known fact.', 72, 114), item(full + ' fill', 72, 128), item(full + ' x', 72, 142)]))
    expect(text(notFull[0])).toContain('well- known')
  })

  it('assigns heading levels from relative font size, only when clearly larger than the body', () => {
    const items = [
      item('Big Title', 72, 60, { size: 28, bold: true }),
      item('Section heading', 72, 100, { size: 18 }),
      ...lines([body + ' text', body + ' more text.'], 72, 130),
      item('Almost body', 72, 180, { size: 12 }),
      ...lines([body + ' aaa', body + ' bbb', body + ' ccc.'], 72, 210)
    ]
    const ps = paragraphs(layout(items))
    expect(ps.map((p) => p.heading)).toEqual([1, 2, 0, 0, 0].slice(0, ps.length))
    expect(ps[0].heading).toBe(1)
    expect(ps[1].heading).toBe(2)
    expect(ps.find((p) => text(p) === 'Almost body')!.heading).toBe(0)
  })

  it('detects centered, right-aligned and justified paragraphs', () => {
    const items = [
      item('Centered title text', 250, 100, { size: 11 }),
      item('Right aligned line', 441, 130),
      ...[0, 1, 2, 3, 4].map((i) => item('j'.repeat(80), 72, 200 + i * 14, { width: 468 })),
      item('last line of it.', 72, 270)
    ]
    const ps = paragraphs(layout(items))
    expect(ps.find((p) => text(p).startsWith('Centered'))!.align).toBe('center')
    expect(ps.find((p) => text(p).startsWith('Right'))!.align).toBe('right')
    expect(ps.find((p) => text(p).startsWith('jjj'))!.align).toBe('both')
  })

  it('takes margins from the text bounding box (clamped) and indents relative to them', () => {
    const l = layout([...lines([body + ' a', body + ' b.'], 100, 120), item('Indented', 136, 200)])
    expect(l.margins.left).toBe(100)
    expect(l.margins.top).toBeGreaterThanOrEqual(18)
    expect(paragraphs(l).find((p) => text(p) === 'Indented')!.indentLeft).toBeCloseTo(36)
    expect(layout([]).margins).toEqual({ top: 72, right: 72, bottom: 72, left: 72 })
  })

  it('reads two-column pages column by column, with full-width headings first', () => {
    const left = Array.from({ length: 8 }, (_, i) => item(`L${i} ${'l'.repeat(40)}`, 72, 160 + i * 14))
    const right = Array.from({ length: 8 }, (_, i) => item(`R${i} ${'r'.repeat(40)}`, 330, 160 + i * 14))
    const items = [item('A full width title spanning both columns', 72, 100, { size: 11, width: 468 }), ...left, ...right]
    expect(findGutter(items)).not.toBeNull()
    const ps = paragraphs(layout(items))
    const order = ps.map((p) => text(p).slice(0, 2))
    expect(order[0]).toBe('A ')
    expect(order.indexOf('L0')).toBeLessThan(order.indexOf('R0'))
    const all = ps.map(text).join(' ')
    expect(all.indexOf('L7')).toBeLessThan(all.indexOf('R0'))
  })
})

describe('table detection', () => {
  const row = (y: number, cells: string[], xs = [72, 220, 360]): TextItem[] => cells.map((c, i) => item(c, xs[i], y))

  it('finds a table from consistently aligned columns', () => {
    const items = [...row(100, ['Region', 'Q1', 'Q2']), ...row(114, ['North', '1,200', '1,350']), ...row(128, ['South', '900', '950'])]
    const seq = detectAlignedTables(buildLines(items))
    expect(seq.length).toBe(1)
    const t = seq[0] as TableBlock
    expect(t.type).toBe('table')
    expect(t.bordered).toBe(false)
    expect(t.rows.map((r) => r.map((c) => c.text))).toEqual([['Region', 'Q1', 'Q2'], ['North', '1,200', '1,350'], ['South', '900', '950']])
  })

  it('handles right-aligned numeric columns', () => {
    const r = (y: number, label: string, num: string): TextItem[] => [item(label, 72, y), item(num, 400 - num.length * 5.5, y)]
    const items = [...r(100, 'Total sales', '12,000'), ...r(114, 'Refunds', '300'), ...r(128, 'Net', '11,700')]
    const t = detectAlignedTables(buildLines(items))[0] as TableBlock
    expect(t.type).toBe('table')
    expect(t.rows.map((c) => c[1].text)).toEqual(['12,000', '300', '11,700'])
    expect(t.rows[1][1].align).toBe('right')
  })

  it('rejects uneven rows whose pieces do not line up', () => {
    const items = [
      item('alpha', 72, 100), item('beta', 200, 100),
      item('gamma', 91, 114), item('delta', 333, 114), item('eps', 460, 114),
      item('zeta', 130, 128), item('eta', 277, 128)
    ]
    const seq = detectAlignedTables(buildLines(items))
    expect(seq.some((s) => 'type' in s && s.type === 'table')).toBe(false)
  })

  it('does not treat a single multi-piece line or long prose as a table', () => {
    expect(detectAlignedTables(buildLines(row(100, ['a', 'b', 'c']))).some((s) => 'type' in s)).toBe(false)
    const prose = [item('x'.repeat(80), 72, 100), item('y'.repeat(80) + ' ' + 'z'.repeat(20), 72, 114)]
    expect(detectAlignedTables(buildLines(prose)).some((s) => 'type' in s)).toBe(false)
  })

  it('finds tables from ruling lines, assigns text to cells and takes the text away from the page flow', () => {
    const xs = [72, 172, 272]
    const ys = [200, 220, 240]
    const rulings: LineItem[] = [
      ...ys.map((y) => ({ x1: 72, y1: y, x2: 272, y2: y })),
      ...xs.map((x) => ({ x1: x, y1: 200, x2: x, y2: 240 }))
    ]
    const items = [item('H1', 76, 214), item('H2', 176, 214), item('a', 76, 234), item('b', 176, 234), item('outside', 72, 300)]
    const { tables, consumed } = detectRulingTables(rulings, items)
    expect(tables.length).toBe(1)
    expect(tables[0].bordered).toBe(true)
    expect(tables[0].rows.map((r) => r.map((c) => c.text))).toEqual([['H1', 'H2'], ['a', 'b']])
    expect(consumed.size).toBe(4)
    const l = layout(items, { lines: rulings })
    expect(l.blocks.filter((b) => b.type === 'table').length).toBe(1)
    expect(paragraphs(l).map(text)).toEqual(['outside'])
  })

  it('ignores lone lines, rules under headings and boxes without text', () => {
    const one: LineItem[] = [{ x1: 72, y1: 100, x2: 300, y2: 100 }]
    expect(detectRulingTables(one, [item('Heading', 72, 95)]).tables.length).toBe(0)
    const box: LineItem[] = [
      { x1: 72, y1: 100, x2: 172, y2: 100 }, { x1: 72, y1: 140, x2: 172, y2: 140 }, { x1: 72, y1: 180, x2: 172, y2: 180 },
      { x1: 72, y1: 100, x2: 72, y2: 180 }, { x1: 122, y1: 100, x2: 122, y2: 180 }, { x1: 172, y1: 100, x2: 172, y2: 180 }
    ]
    expect(detectRulingTables(box, []).tables.length).toBe(0)
    expect(detectRulingTables(box, [item('t', 76, 120)]).tables.length).toBe(1)
  })
})

describe('font names', () => {
  it('maps PostScript names to Office families with bold/italic flags', () => {
    const f = (n: string, g?: string) => describeFont(n, g)
    expect(f('ABCDEF+ArialMT')).toMatchObject({ family: 'Arial', bold: false, italic: false })
    expect(f('Helvetica-Bold')).toMatchObject({ family: 'Arial', bold: true })
    expect(f('TimesNewRomanPS-BoldItalicMT')).toMatchObject({ family: 'Times New Roman', bold: true, italic: true, serif: true })
    expect(f('Times-Roman')).toMatchObject({ family: 'Times New Roman' })
    expect(f('Times-Italic')).toMatchObject({ family: 'Times New Roman', italic: true })
    expect(f('Courier')).toMatchObject({ family: 'Courier New', mono: true })
    expect(f('CourierNewPS-BoldMT')).toMatchObject({ family: 'Courier New', bold: true })
    expect(f('Calibri-Light')).toMatchObject({ family: 'Calibri' })
    expect(f('SegoeUI-Semibold')).toMatchObject({ family: 'Segoe UI', bold: true })
    expect(f('MyriadPro-Regular')).toMatchObject({ family: 'Myriad' })
    expect(f('BXQWJK+SomeFontName-Oblique')).toMatchObject({ family: 'Some Font Name', italic: true })
  })
  it('falls back to the generic family when the name says nothing', () => {
    expect(describeFont('g_d0_f1', 'serif').family).toBe('Times New Roman')
    expect(describeFont('F12', 'monospace')).toMatchObject({ family: 'Courier New', mono: true })
    expect(describeFont(undefined, 'sans-serif').family).toBe('Arial')
    expect(describeFont('', undefined).family).toBe('Arial')
  })
})

describe('number recognition', () => {
  it('recognises integers, decimals, thousands separators, negatives, percentages and currency', () => {
    const n = (s: string) => parseNumber(s)
    expect(n('42')).toMatchObject({ value: 42, format: { kind: 'number', decimals: 0, thousands: false } })
    expect(n('3.14159')).toMatchObject({ value: 3.14159, format: { decimals: 5 } })
    expect(n('1,234,567.89')).toMatchObject({ value: 1234567.89, format: { thousands: true, decimals: 2 } })
    expect(n('-12.5')).toMatchObject({ value: -12.5 })
    expect(n('(1,200)')).toMatchObject({ value: -1200 })
    expect(n('−7')).toMatchObject({ value: -7 })
    expect(n('12.5%')).toMatchObject({ value: 0.125, format: { kind: 'percent', decimals: 1 } })
    expect(n('$1,234.50')).toMatchObject({ value: 1234.5, format: { kind: 'currency', symbol: '$', decimals: 2, thousands: true } })
    expect(n('€ 99')).toMatchObject({ value: 99, format: { symbol: '€' } })
    expect(n('-$5.00')).toMatchObject({ value: -5 })
    expect(n('.5')).toMatchObject({ value: 0.5 })
  })
  it('leaves everything else as text', () => {
    for (const s of ['', ' ', 'abc', '12abc', '007', '01234', '555-1234', '1,23', '1,2345', '2024-05-01', '12/31/2024', '1.2.3', '12345678901234567', '$', '%', '5%%', '$5%', 'N/A', '1e5', '0x10']) {
      expect(parseNumber(s), s).toBeNull()
    }
    expect(parseNumber('0')).toMatchObject({ value: 0 })
    expect(parseNumber('0.5')).toMatchObject({ value: 0.5 })
  })
  it('builds Excel number-format codes', () => {
    expect(formatCode({ kind: 'number', decimals: 0, thousands: false })).toBe('0')
    expect(formatCode({ kind: 'number', decimals: 2, thousands: true })).toBe('#,##0.00')
    expect(formatCode({ kind: 'percent', decimals: 1, thousands: false })).toBe('0.0%')
    expect(formatCode({ kind: 'currency', decimals: 2, thousands: false, symbol: '$' })).toBe('"$"#,##0.00')
  })
})

describe('operator interpretation', () => {
  it('maps colour operands', () => {
    expect(colorFromArgs(['#ff8000'])).toBe('FF8000')
    expect(colorFromArgs([255, 0, 128])).toBe('FF0080')
    expect(colorFromArgs([0.5])).toBe('808080')
    expect(colorFromArgs([0, 0, 0, 1])).toBe('000000')
    expect(colorFromArgs(['nope'])).toBeNull()
  })

  it('composes matrices with PDF cm semantics', () => {
    expect(compose([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 20, 40])
    expect(compose([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 20])).toEqual([2, 0, 0, 2, 10, 20])
  })

  it('aligns shown text to items even when PDF.js merges or splits the show operations', () => {
    const runs = [
      { text: 'Hello ', color: 'FF0000' },
      { text: 'wor', color: '00FF00' },
      { text: 'ld again', color: '0000FF' }
    ]
    // items merged differently from the operations: 'Hello wor' | 'ld' | 'again'
    expect(assignTextColors([{ str: 'Hello wor' }, { str: 'ld' }, { str: 'again' }, { str: ' ' }], runs)).toEqual(['FF0000', '0000FF', '0000FF', null])
    // an item that cannot be found does not derail the rest
    expect(assignTextColors([{ str: 'Hello' }, { str: 'zzz' }, { str: 'world' }], runs)[0]).toBe('FF0000')
    expect(assignTextColors([{ str: 'x' }], [])).toEqual([null])
  })

  it('reads rulings, rectangles, fills and image boxes from a real operator list, with the page flip applied', async () => {
    const { PDFDocument, rgb } = await import('pdf-lib')
    const d = await PDFDocument.create()
    const p = d.addPage([400, 400])
    p.drawRectangle({ x: 10, y: 10, width: 100, height: 50, color: rgb(1, 0, 0), borderWidth: 1, borderColor: rgb(0, 0, 0) })
    p.drawLine({ start: { x: 20, y: 300 }, end: { x: 220, y: 300 }, thickness: 1 })
    p.drawRectangle({ x: 30, y: 200, width: 150, height: 0.5, color: rgb(0, 0, 0) })
    const { doc, OPS } = await openWithPdfjs(await d.save())
    const page = await (doc as { getPage(n: number): Promise<{ getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }> }> }).getPage(1)
    const ol = await page.getOperatorList()
    const g = interpretOperators(ol.fnArray, ol.argsArray, OPS, (x, y) => [x, 400 - y])
    expect(g.rects).toEqual([{ x: 10, y: 340, width: 100, height: 50, fill: 'FF0000', stroke: true }])
    const has = (l: LineItem): boolean => g.lines.some((m) => Math.abs(m.x1 - l.x1) < 0.01 && Math.abs(m.y1 - l.y1) < 0.01 && Math.abs(m.x2 - l.x2) < 0.01 && Math.abs(m.y2 - l.y2) < 0.01)
    expect(has({ x1: 20, y1: 100, x2: 220, y2: 100 })).toBe(true) // the stroked line, flipped
    expect(has({ x1: 30, y1: 199.75, x2: 180, y2: 199.75 })).toBe(true) // a hairline fill counts as a rule
    expect(has({ x1: 10, y1: 340, x2: 110, y2: 340 })).toBe(true) // border of the stroked rectangle
  })
})
