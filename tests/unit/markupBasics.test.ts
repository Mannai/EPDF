import { describe, expect, it } from 'vitest'
import { StandardFonts, PDFDocument } from 'pdf-lib'
import {
  AUTHOR_FALLBACK,
  clamp01,
  clampOpacity,
  formatPdfDate,
  hexToRgb,
  newAnnotName,
  parsePdfDate,
  resolveAuthor,
  rgbToHex,
  sanitizeColor,
  toRgb
} from '../../src/renderer/src/features/markup/pdf/basics'
import { sanitizeText, wrapLines } from '../../src/renderer/src/features/markup/pdf/fonts'
import { catmullRom, distToSegment, simplify, smoothStroke } from '../../src/renderer/src/features/markup/pdf/ink'
import { STAMPS, stampByName, stampLabel } from '../../src/renderer/src/features/markup/pdf/stamps'
import { parseDA, stripRichText } from '../../src/renderer/src/features/markup/pdf/read'
import { capabilities } from '../../src/renderer/src/features/markup/pdf/model'
import type { Pt } from '../../src/renderer/src/features/markup/pdf/geometry'

describe('colour and opacity clamping', () => {
  it('clamps components into 0..1 and rejects NaN', () => {
    expect(clamp01(2)).toBe(1)
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(NaN)).toBe(0)
    expect(sanitizeColor([2, -1, 0.5])).toEqual([1, 0, 0.5])
    expect(sanitizeColor([NaN, 0.2, 1])).toEqual([0, 0.2, 1])
  })

  it('falls back for unusable colour arrays (wrong length, null)', () => {
    expect(sanitizeColor([1, 2], [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3])
    expect(sanitizeColor(null)).toEqual([0, 0, 0])
    expect(sanitizeColor([0.5])).toEqual([0.5])
    expect(sanitizeColor([0, 0, 0, 1])).toHaveLength(4)
  })

  it('keeps opacity within 0.05..1 so an annotation can never become invisible', () => {
    expect(clampOpacity(0)).toBe(0.05)
    expect(clampOpacity(-3)).toBe(0.05)
    expect(clampOpacity(7)).toBe(1)
    expect(clampOpacity(0.4)).toBe(0.4)
    expect(clampOpacity(NaN, 0.5)).toBe(0.5)
  })

  it('converts hex ↔ rgb and other colour spaces to rgb', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(hexToRgb('nonsense', [0, 1, 0])).toEqual([0, 1, 0])
    expect(rgbToHex([1, 0, 0])).toBe('#ff0000')
    expect(rgbToHex(null, '#123456')).toBe('#123456')
    expect(toRgb([0.5])).toEqual([0.5, 0.5, 0.5])
    expect(toRgb([0, 0, 0, 1])).toEqual([0, 0, 0])
    expect(toRgb([1, 2])).toBeNull()
  })
})

describe('PDF dates', () => {
  it('formats with an explicit offset', () => {
    const d = new Date(Date.UTC(2026, 8, 25, 10, 30, 5))
    expect(formatPdfDate(d, 0)).toBe("D:20260925103005+00'00'")
    expect(formatPdfDate(d, 120)).toBe("D:20260925123005+02'00'")
    expect(formatPdfDate(d, -330)).toBe("D:20260925050005-05'30'")
  })

  it('round-trips through parsePdfDate for any offset', () => {
    const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
    for (const off of [0, 60, -300, 330]) expect(parsePdfDate(formatPdfDate(d, off))).toBe(d.getTime())
  })

  it('parses partial and Z dates, and rejects garbage', () => {
    expect(parsePdfDate('D:20200102')).toBe(Date.UTC(2020, 0, 2))
    expect(parsePdfDate('D:20200102030405Z')).toBe(Date.UTC(2020, 0, 2, 3, 4, 5))
    expect(parsePdfDate("D:20200102030405-05'00'")).toBe(Date.UTC(2020, 0, 2, 8, 4, 5))
    expect(parsePdfDate('20200102')).toBe(Date.UTC(2020, 0, 2))
    expect(parsePdfDate('yesterday')).toBeNull()
    expect(parsePdfDate('')).toBeNull()
    expect(parsePdfDate(undefined)).toBeNull()
  })
})

describe('default author', () => {
  it('prefers the stored name, then the system user, then a fixed fallback', () => {
    expect(resolveAuthor('  Ada  ', 'root')).toBe('Ada')
    expect(resolveAuthor('', 'root')).toBe('root')
    expect(resolveAuthor(null, 'root')).toBe('root')
    expect(resolveAuthor('   ', '   ')).toBe(AUTHOR_FALLBACK)
    expect(resolveAuthor(undefined, undefined)).toBe(AUTHOR_FALLBACK)
  })

  it('strips control characters and bounds the length', () => {
    expect(resolveAuthor('A\u0000B\nC', '')).toBe('A B C')
    expect(resolveAuthor('x'.repeat(500), '').length).toBe(80)
  })
})

describe('annotation names', () => {
  it('are unique and recognisable as ours', () => {
    const a = newAnnotName()
    const b = newAnnotName()
    expect(a).toMatch(/^epdf-[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})

describe('ink smoothing', () => {
  const noisyLine = (n: number): Pt[] => Array.from({ length: n }, (_, i) => [i * 2, (i % 2) * 0.05] as Pt)

  it('keeps the endpoints exactly', () => {
    const raw = noisyLine(40)
    for (const s of [0, 0.3, 1]) {
      const out = smoothStroke(raw, s)
      expect(out[0]).toEqual(raw[0])
      expect(out[out.length - 1]).toEqual(raw[raw.length - 1])
    }
  })

  it('simplifies a near-straight jittery line to a few points', () => {
    const out = smoothStroke(noisyLine(60), 0.5)
    expect(out.length).toBeLessThan(6)
  })

  it('smoothing 0 leaves the samples untouched (minus duplicates)', () => {
    const raw: Pt[] = [
      [0, 0],
      [0, 0],
      [5, 5],
      [10, 0]
    ]
    expect(smoothStroke(raw, 0)).toEqual([
      [0, 0],
      [5, 5],
      [10, 0]
    ])
  })

  it('a corner is rounded: the smoothed curve has more points and stays near the original', () => {
    const raw: Pt[] = [
      [0, 0],
      [50, 0],
      [50, 50],
      [100, 50]
    ]
    const out = smoothStroke(raw, 1)
    expect(out.length).toBeGreaterThan(raw.length)
    for (const p of out) {
      const d = Math.min(...raw.slice(0, -1).map((a, i) => distToSegment(p, a, raw[i + 1])))
      expect(d).toBeLessThan(15)
    }
  })

  it('turns a single click into a tiny dot and drops non-finite samples', () => {
    expect(smoothStroke([[5, 5]])).toEqual([
      [5, 5],
      [5.01, 5]
    ])
    expect(smoothStroke([])).toEqual([])
    expect(smoothStroke([[NaN, 1], [1, 1], [2, 2]] as Pt[], 0)).toEqual([
      [1, 1],
      [2, 2]
    ])
  })

  it('simplify and catmullRom edge cases', () => {
    expect(simplify([[0, 0], [1, 1]], 1)).toEqual([[0, 0], [1, 1]])
    expect(catmullRom([[0, 0], [1, 1]], 4)).toEqual([[0, 0], [1, 1]])
    const line = simplify([[0, 0], [1, 0.001], [2, 0], [3, 0]], 0.1)
    expect(line).toEqual([[0, 0], [3, 0]])
  })
})

describe('text layout', () => {
  const measure = (t: string): number => t.length * 10

  it('wraps at word boundaries and honours newlines', () => {
    expect(wrapLines('aaa bbb ccc', 70, measure)).toEqual(['aaa bbb', 'ccc'])
    expect(wrapLines('a\n\nb', 100, measure)).toEqual(['a', '', 'b'])
    expect(wrapLines('', 100, measure)).toEqual([''])
  })

  it('breaks words that are wider than the box', () => {
    expect(wrapLines('abcdefghij', 40, measure)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('replaces characters WinAnsi cannot show with "?"', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    expect(sanitizeText(font, 'Café – “ok”\nnext')).toBe('Café – “ok”\nnext')
    expect(sanitizeText(font, '日本 ok')).toBe('?? ok')
  })
})

describe('reading helpers', () => {
  it('parses /DA colour and size', () => {
    expect(parseDA('0 0 1 rg /Helv 14 Tf')).toEqual({ color: [0, 0, 1], size: 14 })
    expect(parseDA('/Helv 9 Tf 0.5 g')).toEqual({ color: [0.5], size: 9 })
    expect(parseDA('0 0 0 1 k /F1 10.5 Tf')).toEqual({ color: [0, 0, 0, 1], size: 10.5 })
    expect(parseDA(undefined)).toEqual({ color: [0, 0, 0], size: 12 })
    expect(parseDA('garbage')).toEqual({ color: [0, 0, 0], size: 12 })
  })

  it('extracts plain text from rich text', () => {
    expect(stripRichText('<body><p>Hello &amp; <b>bye</b></p><p>Line 2</p></body>')).toBe('Hello & bye\nLine 2')
  })
})

describe('stamps and capabilities', () => {
  it('has the required built-in stamps with unique names', () => {
    const names = STAMPS.map((s) => s.name)
    for (const n of ['Approved', 'Draft', 'Confidential', 'Reviewed', 'Rejected', 'SignHere', 'NotApproved']) expect(names).toContain(n)
    expect(new Set(names).size).toBe(names.length)
    expect(stampByName('Approved')?.label).toBe('APPROVED')
    expect(stampByName('nope')).toBeUndefined()
    expect(stampLabel('NotApproved')).toBe('Not Approved')
    expect(stampLabel('NotForPublicRelease')).toBe('Not For Public Release')
  })

  it('only offers edits Epdf can apply without destroying the annotation', () => {
    const base = { complex: false, ours: false }
    expect(capabilities({ ...base, subtype: 'Highlight' })).toMatchObject({ move: true, recolor: true, resize: false, fill: false })
    expect(capabilities({ ...base, subtype: 'Square' })).toMatchObject({ resize: true, fill: true, width: true })
    expect(capabilities({ ...base, subtype: 'Stamp' })).toMatchObject({ resize: true, recolor: false, opacity: false })
    expect(capabilities({ ...base, ours: true, subtype: 'Stamp' })).toMatchObject({ opacity: true })
    expect(capabilities({ ...base, complex: true, subtype: 'Square' })).toMatchObject({ recolor: false, fill: false, opacity: false })
    expect(capabilities({ ...base, subtype: 'Caret' })).toMatchObject({ move: true, recolor: false, resize: false, text: true })
  })
})
