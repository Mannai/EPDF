import { describe, expect, it } from 'vitest'
import { layoutParagraph } from '../../src/shared/text/layout'
import { caretAt, hitTest, selectionRects } from '../../src/shared/text/query'
import type { ParagraphLayout } from '../../src/shared/text/types'
import { font, setupText } from './helpers/text'

setupText()

const AR = 'اللغة العربية هي أكثر اللغات السامية تحدثا وإحدى أكثر اللغات انتشارا في العالم'
const EN = 'The quick brown fox jumps over the lazy dog and keeps running through the forest'
const lineText = (l: ParagraphLayout, i: number): string => l.text.slice(l.lines[i]!.textStart, l.lines[i]!.textEnd)

describe('paragraph layout: wrapping', () => {
  it('wraps to the width: every line fits, all text is kept, nothing is lost', async () => {
    for (const [text, size] of [[EN, 14], [AR, 16]] as const) {
      const lay = await layoutParagraph(text, { size, width: 150 })
      expect(lay.lines.length).toBeGreaterThan(2)
      for (const l of lay.lines) expect(l.width).toBeLessThanOrEqual(150.01)
      expect(lay.lines.map((_, i) => lineText(lay, i)).join('')).toBe(text)
      // lines are contiguous, in source order
      for (let i = 1; i < lay.lines.length; i++) expect(lay.lines[i]!.textStart).toBe(lay.lines[i - 1]!.textEnd)
    }
  })

  it('a narrower box gives more lines and the same text', async () => {
    const wide = await layoutParagraph(AR, { size: 16, width: 400 })
    const narrow = await layoutParagraph(AR, { size: 16, width: 120 })
    expect(narrow.lines.length).toBeGreaterThan(wide.lines.length)
    expect(narrow.height).toBeGreaterThan(wide.height)
  })

  it('honours explicit newlines and keeps blank lines', async () => {
    const lay = await layoutParagraph('one\n\ntwo\r\nthree', { size: 12 })
    expect(lay.lines.length).toBe(4)
    expect(lay.lines[1]!.runs.length).toBe(0)
    expect(lay.lines[1]!.height).toBeGreaterThan(0)
    expect(lay.lines.map((l) => l.paragraph)).toEqual([0, 1, 2, 3])
  })

  it('breaks a single word wider than the box (unless disabled)', async () => {
    const word = 'Supercalifragilisticexpialidocious'
    const cut = await layoutParagraph(word, { size: 16, width: 80 })
    expect(cut.lines.length).toBeGreaterThan(1)
    for (const l of cut.lines) expect(l.width).toBeLessThanOrEqual(80.01)
    const keep = await layoutParagraph(word, { size: 16, width: 80, breakLongWords: false })
    expect(keep.lines.length).toBe(1)
    expect(keep.lines[0]!.width).toBeGreaterThan(80)
  })

  it('wraps Thai and CJK without spaces and never starts a line with closing punctuation', async () => {
    const th = await layoutParagraph('สวัสดีชาวโลกยินดีต้อนรับสู่ประเทศไทยวันนี้อากาศดีมาก', { size: 16, width: 120, fontStack: ['Noto Sans Thai'] })
    expect(th.lines.length).toBeGreaterThan(1)
    for (let i = 1; i < th.lines.length; i++) expect(/^[ัิ-ฺ็-๎]/.test(lineText(th, i))).toBe(false)
    const zh = await layoutParagraph('你好，世界。这是一个很长的中文句子，用来测试换行。', { size: 16, width: 90 })
    expect(zh.lines.length).toBeGreaterThan(2)
    for (let i = 1; i < zh.lines.length; i++) expect(/^[，。、！？]/.test(lineText(zh, i))).toBe(false)
  })

  it('maxLines truncates and reports it', async () => {
    const lay = await layoutParagraph(EN, { size: 14, width: 100, maxLines: 2 })
    expect(lay.lines.length).toBe(2)
    expect(lay.truncated).toBe(true)
  })
})

describe('paragraph layout: direction and alignment', () => {
  it('detects direction per paragraph (auto) and honours forced directions', async () => {
    const auto = await layoutParagraph('مرحبا\nhello\n123 مرحبا', { size: 14 })
    expect(auto.directions).toEqual(['rtl', 'ltr', 'rtl'])
    const forced = await layoutParagraph('hello', { size: 14, direction: 'rtl' })
    expect(forced.directions).toEqual(['rtl'])
  })

  it('aligns start/end/left/right/center relative to the paragraph direction inside the box', async () => {
    const box = 300
    const l = async (text: string, align: 'start' | 'end' | 'left' | 'right' | 'center') => (await layoutParagraph(text, { size: 14, width: box, align })).lines[0]!
    const ltrStart = await l('hello', 'start')
    const ltrEnd = await l('hello', 'end')
    const rtlStart = await l('مرحبا', 'start')
    const rtlEnd = await l('مرحبا', 'end')
    expect(ltrStart.x).toBeCloseTo(0, 3)
    expect(ltrEnd.x).toBeCloseTo(box - ltrEnd.width, 3)
    expect(rtlStart.x).toBeCloseTo(box - rtlStart.width, 3)
    expect(rtlEnd.x).toBeCloseTo(0, 3)
    expect((await l('hello', 'center')).x).toBeCloseTo((box - ltrStart.width) / 2, 3)
    expect((await l('مرحبا', 'left')).x).toBeCloseTo(0, 3)
    expect((await l('hello', 'right')).x).toBeCloseTo(box - ltrStart.width, 3)
  })

  it('places runs in visual order: an Arabic word inside English text is laid out right to left', async () => {
    const lay = await layoutParagraph('abc مرحبا def', { size: 16, direction: 'ltr' })
    const runs = lay.lines[0]!.runs
    for (let i = 1; i < runs.length; i++) expect(runs[i]!.x).toBeGreaterThanOrEqual(runs[i - 1]!.x + runs[i - 1]!.width - 0.01)
    const arabic = runs.find((r) => r.script === 'Arab' && r.level === 1)!
    // glyph clusters inside an RTL run descend as x grows
    const cl = arabic.glyphs.map((g) => g.cluster)
    expect(cl[0]).toBeGreaterThan(cl[cl.length - 1]!)
  })

  it('hangs trailing spaces outside the line width', async () => {
    const lay = await layoutParagraph('hello   ', { size: 14, width: 200 })
    const l = lay.lines[0]!
    const solid = await layoutParagraph('hello', { size: 14, width: 200 })
    expect(l.width).toBeCloseTo(solid.lines[0]!.width, 3)
    expect(l.runs.some((r) => r.hanging)).toBe(true)
  })
})

describe('paragraph layout: justification', () => {
  it('stretches every line but the last to the box width (spaces)', async () => {
    const lay = await layoutParagraph(EN, { size: 14, width: 200, align: 'justify' })
    expect(lay.lines.length).toBeGreaterThan(2)
    lay.lines.forEach((l, i) => {
      if (i < lay.lines.length - 1) expect(l.width).toBeCloseTo(200, 1)
      else expect(l.width).toBeLessThan(200)
    })
    const withLast = await layoutParagraph(EN, { size: 14, width: 200, align: 'justify', justifyLast: true })
    expect(withLast.lines.at(-1)!.width).toBeCloseTo(200, 1)
  })

  it('Arabic justification elongates with kashida (tatweel glyphs), spaces alone when disabled', async () => {
    const opts = { size: 16, width: 250, align: 'justify' as const, fontStack: ['Noto Naskh Arabic'] }
    const kashida = await layoutParagraph(AR, opts)
    const spaces = await layoutParagraph(AR, { ...opts, kashida: false })
    const extra = (lay: ParagraphLayout): number => lay.lines.flatMap((l) => l.runs.flatMap((r) => r.glyphs.filter((g) => g.chars === 0 && !g.space && g.advance > 0))).length
    expect(extra(kashida)).toBeGreaterThan(0)
    expect(extra(spaces)).toBe(0)
    for (const lay of [kashida, spaces]) lay.lines.slice(0, -1).forEach((l) => expect(l.width).toBeCloseTo(250, 1))
  })

  it('justifies CJK by spreading between characters', async () => {
    const lay = await layoutParagraph('你好世界这是一个用来测试对齐的中文段落文本', { size: 16, width: 100, align: 'justify' })
    expect(lay.lines.length).toBeGreaterThan(2)
    expect(lay.lines[0]!.width).toBeCloseTo(100, 1)
  })
})

describe('paragraph layout: metrics, tabs, spacing, styles', () => {
  it('takes vertical metrics from the font: line height = ascent + descent + line gap', async () => {
    const f = await font('NotoSans-Regular.ttf')
    const lay = await layoutParagraph('Hello', { size: 20, fontStack: ['Noto Sans'] })
    const k = 20 / f.upem
    expect(lay.lines[0]!.height).toBeCloseTo((f.ascent + f.descent + f.lineGap) * k, 2)
    expect(lay.lines[0]!.baseline).toBeCloseTo((f.ascent + f.lineGap / 2) * k, 2)
  })

  it('lineHeight (points) and lineSpacing (multiple) set the line pitch', async () => {
    const a = await layoutParagraph('a\nb\nc', { size: 10, lineHeight: 30 })
    expect(a.height).toBeCloseTo(90, 3)
    const b = await layoutParagraph('a\nb', { size: 10, lineSpacing: 2 })
    expect(b.height).toBeCloseTo(40, 3)
  })

  it('advances tabs to the next tab stop', async () => {
    const lay = await layoutParagraph('a\tb\t\tc', { size: 12, fontStack: ['Noto Sans'], tabSize: 4 })
    const gs = lay.lines[0]!.runs.flatMap((r) => r.glyphs)
    const xs = gs.filter((g) => !g.tab).map((g) => g.x)
    const space = (await font('NotoSans-Regular.ttf')).advanceOf((await font('NotoSans-Regular.ttf')).glyphFor(0x20)) * (12 / 1000 * (1000 / (await font('NotoSans-Regular.ttf')).upem))
    const stop = 4 * space
    const off = (x: number): number => Math.min(x % stop, stop - (x % stop)) // distance to the nearest tab stop
    expect(off(xs[1]!)).toBeCloseTo(0, 1) // b starts on a tab stop
    expect(off(xs[2]!)).toBeCloseTo(0, 1) // c: two tabs later
    expect(xs[2]! - xs[1]!).toBeGreaterThan(stop - 0.01)
  })

  it('letter-spacing widens Latin text but not connected Arabic', async () => {
    const plain = await layoutParagraph('spacing', { size: 14 })
    const spaced = await layoutParagraph('spacing', { size: 14, letterSpacing: 2 })
    expect(spaced.width).toBeGreaterThan(plain.width + 10)
    const ar = await layoutParagraph('مرحبا', { size: 14 })
    const ar2 = await layoutParagraph('مرحبا', { size: 14, letterSpacing: 2 })
    expect(ar2.width).toBeCloseTo(ar.width, 3)
  })

  it('word-spacing widens spaces', async () => {
    const a = await layoutParagraph('a b c', { size: 14 })
    const b = await layoutParagraph('a b c', { size: 14, wordSpacing: 5 })
    expect(b.width).toBeCloseTo(a.width + 10, 3)
  })

  it('rich text: spans with their own size, weight and colour share lines and bidi', async () => {
    const lay = await layoutParagraph(
      [
        { text: 'Big ', size: 30 },
        { text: 'مرحبا ', size: 12, weight: 'bold', color: [1, 0, 0] },
        { text: 'small', size: 12 }
      ],
      { size: 20 }
    )
    const runs = lay.lines[0]!.runs
    expect(new Set(runs.map((r) => r.size))).toEqual(new Set([30, 12]))
    expect(runs.some((r) => Array.isArray(r.style.color))).toBe(true)
    // line height comes from the biggest run
    expect(lay.lines[0]!.height).toBeGreaterThan(30)
    expect(lay.text).toBe('Big مرحبا small')
  })

  it('applies OpenType features and language per call', async () => {
    const on = await layoutParagraph('office', { size: 20, fontStack: ['Noto Sans'] })
    const off = await layoutParagraph('office', { size: 20, fontStack: ['Noto Sans'], features: { liga: false } })
    expect(on.lines[0]!.runs[0]!.glyphs.length).toBeLessThan(off.lines[0]!.runs[0]!.glyphs.length)
  })
})

describe('caret, hit testing and selection geometry', () => {
  it('caret positions follow logical order in LTR text', async () => {
    const lay = await layoutParagraph('hello world', { size: 16, fontStack: ['Noto Sans'] })
    const xs = Array.from({ length: 12 }, (_, i) => caretAt(lay, i).x)
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!)
    expect(xs[11]!).toBeCloseTo(lay.width, 1)
  })

  it('caret positions run right to left in Arabic text', async () => {
    const lay = await layoutParagraph('مرحبا بالعالم', { size: 16, width: 200 })
    const n = lay.text.length
    const xs = Array.from({ length: n + 1 }, (_, i) => caretAt(lay, i).x)
    expect(xs[0]!).toBeGreaterThan(xs[n]!)
    for (let i = 1; i <= n; i++) expect(xs[i]!).toBeLessThanOrEqual(xs[i - 1]! + 0.01)
  })

  it('hitTest is the inverse of caretAt', async () => {
    for (const text of ['hello world', 'مرحبا بالعالم', 'abc مرحبا def']) {
      const lay = await layoutParagraph(text, { size: 16, direction: 'ltr' })
      for (let i = 0; i <= text.length; i += 2) {
        const c = caretAt(lay, i)
        const h = hitTest(lay, c.x, c.y + c.height / 2)
        expect(caretAt(lay, h.index).x).toBeCloseTo(c.x, 1)
      }
    }
  })

  it('selection rectangles cover the selected characters, in several pieces for mixed direction', async () => {
    const lay = await layoutParagraph('hello مرحبا world', { size: 16, direction: 'ltr' })
    const whole = selectionRects(lay, 0, lay.text.length)
    expect(whole.length).toBe(1)
    expect(whole[0]!.width).toBeCloseTo(lay.width, 1)
    const some = selectionRects(lay, 3, 9)
    const total = some.reduce((s, r) => s + r.width, 0)
    expect(total).toBeGreaterThan(5)
    expect(total).toBeLessThan(lay.width)
  })

  it('works across wrapped lines', async () => {
    const lay = await layoutParagraph(EN, { size: 14, width: 120 })
    const rects = selectionRects(lay, 0, EN.length)
    expect(new Set(rects.map((r) => r.line)).size).toBe(lay.lines.length)
    const c = caretAt(lay, lay.lines[1]!.textStart)
    expect(c.line).toBe(1)
    expect(c.y).toBeCloseTo(lay.lines[1]!.y, 3)
  })
})
