import { describe, expect, it } from 'vitest'
import { partFileNames, sanitizeFileName, stemOf, uniqueFileName } from '../../src/shared/features/pages/filenames'
import {
  EMPTY_SELECTION,
  clickSelect,
  columnsFor,
  describeMove,
  dropSlot,
  isNoopMove,
  moveBlock,
  moveByStep,
  navigate,
  planInsertBlank,
  planMoveByStep,
  planReorder,
  selectAll,
  visibleRowRange
} from '../../src/shared/features/pages/order'
import { expandRanges, formatPageList, parsePageRanges, toRuns } from '../../src/shared/features/pages/ranges'
import { planByBookmarks, planByRanges, planBySize, planEveryN } from '../../src/shared/features/pages/split'
import type { OutlineNode } from '../../src/shared/features/pages/outline'

describe('parsePageRanges', () => {
  const ok = (s: string, n: number): [number, number][] => {
    const r = parsePageRanges(s, n)
    if (!r.ok) throw new Error(r.error)
    return r.ranges.map((x) => [x.from, x.to])
  }
  it('parses lists, ranges and open ends', () => {
    expect(ok('1-3, 7, 9-', 12)).toEqual([[1, 3], [7, 7], [9, 12]])
    expect(ok('-4', 10)).toEqual([[1, 4]])
    expect(ok('5', 5)).toEqual([[5, 5]])
    expect(ok(' 2 – 4 ;6  8-9 ', 10)).toEqual([[2, 4], [6, 6], [8, 9]]) // en dash, semicolons, spaces
    expect(ok('1 - 3', 5)).toEqual([[1, 3]])
    expect(ok('3-3', 5)).toEqual([[3, 3]])
  })
  it('explains every kind of mistake', () => {
    const err = (s: string, n = 10): string => {
      const r = parsePageRanges(s, n)
      if (r.ok) throw new Error('expected an error')
      return r.error
    }
    expect(err('')).toMatch(/at least one page/)
    expect(err('   ')).toMatch(/at least one page/)
    expect(err('abc')).toMatch(/“abc” isn’t a page number/)
    expect(err('1-2-3')).toMatch(/isn’t a page number/)
    expect(err('0')).toMatch(/start at 1/)
    expect(err('0-3')).toMatch(/start at 1/)
    expect(err('5-3')).toMatch(/runs backwards/)
    expect(err('11')).toMatch(/Page 11 is out of range: the document has 10 pages/)
    expect(err('8-20')).toMatch(/Page 20 is out of range/)
    expect(err('-')).toMatch(/isn’t a page number/)
    expect(err('1', 0)).toMatch(/no pages/)
    expect(err('2', 1)).toMatch(/has 1 page\./)
  })
  it('expands, de-duplicates and formats', () => {
    const r = parsePageRanges('3-4, 1, 4-5', 6)
    if (!r.ok) throw new Error()
    expect(expandRanges(r.ranges)).toEqual([2, 3, 0, 3, 4])
    expect(expandRanges(r.ranges, { unique: true })).toEqual([2, 3, 0, 4])
    expect(formatPageList([4, 0, 1, 2, 9, 3])).toBe('1-5, 10')
    expect(formatPageList([])).toBe('')
    expect(toRuns([5, 0, 1, 2])).toEqual([{ from: 1, to: 3 }, { from: 6, to: 6 }])
  })
})

describe('selection', () => {
  it('click, ctrl+click and shift+click', () => {
    let s = clickSelect(EMPTY_SELECTION, 2, {}, 10)
    expect(s.selected).toEqual([2])
    s = clickSelect(s, 5, { shift: true }, 10)
    expect(s.selected).toEqual([2, 3, 4, 5])
    s = clickSelect(s, 8, { ctrl: true }, 10)
    expect(s.selected).toEqual([2, 3, 4, 5, 8])
    s = clickSelect(s, 3, { ctrl: true }, 10)
    expect(s.selected).toEqual([2, 4, 5, 8])
    s = clickSelect(s, 0, { shift: true }, 10) // anchor is now 3 (the last toggled)
    expect(s.selected).toEqual([0, 1, 2, 3])
    s = clickSelect(s, 7, {}, 10)
    expect(s.selected).toEqual([7])
    s = clickSelect(s, 99, {}, 10) // out of range is ignored
    expect(s.selected).toEqual([7])
  })
  it('ctrl+shift adds a range to the selection', () => {
    let s = clickSelect(EMPTY_SELECTION, 0, {}, 10)
    s = clickSelect(s, 5, { ctrl: true }, 10)
    s = clickSelect(s, 7, { ctrl: true, shift: true }, 10)
    expect(s.selected).toEqual([0, 5, 6, 7])
  })
  it('select all', () => {
    expect(selectAll(4).selected).toEqual([0, 1, 2, 3])
    expect(selectAll(0).selected).toEqual([])
  })
})

describe('keyboard navigation in a grid', () => {
  it('moves by page and by row, staying inside the grid', () => {
    // 10 pages, 4 columns: rows are 0-3, 4-7, 8-9
    expect(navigate(5, 'ArrowRight', 4, 10)).toBe(6)
    expect(navigate(0, 'ArrowLeft', 4, 10)).toBe(0)
    expect(navigate(9, 'ArrowRight', 4, 10)).toBe(9)
    expect(navigate(5, 'ArrowUp', 4, 10)).toBe(1)
    expect(navigate(2, 'ArrowUp', 4, 10)).toBe(2)
    expect(navigate(5, 'ArrowDown', 4, 10)).toBe(9)
    expect(navigate(6, 'ArrowDown', 4, 10)).toBe(6) // no page below column 2 of the last row
    expect(navigate(5, 'Home', 4, 10)).toBe(4)
    expect(navigate(5, 'End', 4, 10)).toBe(7)
    expect(navigate(9, 'End', 4, 10)).toBe(9)
    expect(navigate(5, 'Home', 4, 10, 3, true)).toBe(0)
    expect(navigate(5, 'End', 4, 10, 3, true)).toBe(9)
    expect(navigate(1, 'PageDown', 4, 10, 2)).toBe(9)
    expect(navigate(9, 'PageUp', 4, 10, 1)).toBe(5)
  })
  it('computes columns and visible rows', () => {
    expect(columnsFor(1000, 200)).toBe(5)
    expect(columnsFor(50, 200)).toBe(1)
    expect(visibleRowRange(0, 500, 200, 100, 1)).toEqual([0, 3])
    expect(visibleRowRange(1000, 500, 200, 100, 1)).toEqual([4, 8])
    expect(visibleRowRange(0, 500, 200, 0)).toEqual([0, -1])
  })
})

describe('moving pages', () => {
  it('moveBlock places the selection in a gap, preserving relative order', () => {
    expect(moveBlock(6, [1, 2], 5).order).toEqual([0, 3, 4, 1, 2, 5])
    expect(moveBlock(6, [1, 2], 5).selection).toEqual([3, 4])
    expect(moveBlock(6, [4, 1], 0).order).toEqual([1, 4, 0, 2, 3, 5])
    expect(moveBlock(6, [0], 6).order).toEqual([1, 2, 3, 4, 5, 0])
    expect(moveBlock(6, [5], 99).order).toEqual([0, 1, 2, 3, 4, 5]) // clamped, and the same place
  })
  it('a drop next to the selection is a no-op', () => {
    expect(isNoopMove(6, [2], 2)).toBe(true) // gap just before
    expect(isNoopMove(6, [2], 3)).toBe(true) // gap just after
    expect(isNoopMove(6, [2, 3], 3)).toBe(true) // inside its own block
    expect(isNoopMove(6, [2], 4)).toBe(false)
    expect(planReorder(6, [2], 3)).toBeNull()
  })
  it('moveByStep moves blocks and stops at the edges', () => {
    expect(moveByStep(5, [2], -1)).toEqual({ order: [0, 2, 1, 3, 4], selection: [1] })
    expect(moveByStep(5, [1, 2], 1)).toEqual({ order: [0, 3, 1, 2, 4], selection: [2, 3] })
    expect(moveByStep(5, [0, 1], -1).order).toEqual([0, 1, 2, 3, 4])
    expect(moveByStep(5, [0, 3], -1)).toEqual({ order: [0, 1, 3, 2, 4], selection: [0, 2] }) // the page at the edge stays
    expect(moveByStep(6, [1], 3)).toEqual({ order: [0, 2, 3, 4, 1, 5], selection: [4] })
    expect(moveByStep(4, [3], 5).order).toEqual([0, 1, 2, 3])
    expect(planMoveByStep(4, [0], -1)).toBeNull()
  })
  it('describes moves for the live region', () => {
    expect(describeMove([3])).toBe('Page moved to position 4.')
    expect(describeMove([1, 2, 3])).toBe('3 pages moved to positions 2 to 4.')
    expect(describeMove([1, 5])).toBe('2 pages moved.')
    expect(describeMove([])).toBe('')
  })
  it('maps a pointer position to a drop gap', () => {
    // cells 100x150, 3 columns, 7 pages: rows 0-2, 3-5, 6
    expect(dropSlot(10, 10, 100, 150, 3, 7)).toBe(0) // left half of page 1
    expect(dropSlot(90, 10, 100, 150, 3, 7)).toBe(1) // right half of page 1
    expect(dropSlot(140, 200, 100, 150, 3, 7)).toBe(4) // second row, middle page, left half: gap before page 5
    expect(dropSlot(160, 200, 100, 150, 3, 7)).toBe(5) // right half: gap after it
    expect(dropSlot(10, 200, 100, 150, 3, 7)).toBe(3)
    expect(dropSlot(250, 10, 100, 150, 3, 7)).toBe(3) // right half of the last column, first row
    expect(dropSlot(500, 500, 100, 150, 3, 7)).toBe(7) // beyond the end
    expect(dropSlot(150, 350, 100, 150, 3, 7)).toBe(7) // empty cell of the last row
    expect(dropSlot(0, 0, 100, 150, 3, 0)).toBe(0)
  })
  it('blank pages copy the neighbour before the gap (or after it at the start)', () => {
    expect(planInsertBlank(4, 2, 'neighbour').specs[2]).toEqual({ kind: 'blank', like: 1 })
    expect(planInsertBlank(4, 0, 'neighbour').specs[0]).toEqual({ kind: 'blank', like: 0 })
    expect(planInsertBlank(4, 4, 'neighbour', 2).selection).toEqual([4, 5])
  })
})

describe('split planners', () => {
  it('by ranges', () => {
    const r = parsePageRanges('1-3, 4-10, 11-', 12)
    if (!r.ok) throw new Error()
    const plan = planByRanges(r.ranges)
    expect(plan.parts.map((p) => p.pages.length)).toEqual([3, 7, 2])
    expect(plan.parts[2].pages).toEqual([10, 11])
    expect(plan.parts[0].label).toBe('pages 1-3')
  })
  it('every N pages', () => {
    expect(planEveryN(7, 3).parts.map((p) => p.pages)).toEqual([[0, 1, 2], [3, 4, 5], [6]])
    expect(planEveryN(2, 5).parts).toHaveLength(1)
  })

  describe('by size (fake size function: 100 bytes per page + 50 overhead)', () => {
    const size = (pages: number[]): Promise<number> => Promise.resolve(50 + 100 * pages.length)
    it('fills each part up to the limit and never exceeds it', async () => {
      const plan = await planBySize(10, 360, size) // 3 pages = 350 fit, 4 = 450 do not
      expect(plan.parts.map((p) => p.pages.length)).toEqual([3, 3, 3, 1])
      expect(plan.parts.every((p) => (p.bytes ?? 0) <= 360)).toBe(true)
      expect(plan.parts.flatMap((p) => p.pages)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(plan.warnings).toEqual([])
    })
    it('puts everything in one part when it fits', async () => {
      expect((await planBySize(5, 10_000, size)).parts).toHaveLength(1)
    })
    it('reports pages that alone exceed the limit and keeps going', async () => {
      const big = new Set([2, 6])
      const sizeOf = (pages: number[]): Promise<number> => Promise.resolve(pages.reduce((sum, p) => sum + (big.has(p) ? 1000 : 100), 50))
      const plan = await planBySize(8, 400, sizeOf)
      expect(plan.parts.map((p) => p.pages)).toEqual([[0, 1], [2], [3, 4, 5], [6], [7]])
      expect(plan.parts.filter((p) => p.oversized).map((p) => p.pages[0])).toEqual([2, 6])
      expect(plan.warnings).toHaveLength(2)
      expect(plan.warnings[0]).toMatch(/Page 3 alone is/)
    })
    it('uses few measurements (galloping + bisection) and reports progress', async () => {
      let calls = 0
      const progress: number[] = []
      const plan = await planBySize(500, 50 + 100 * 200, (p) => ((calls++), size(p)), { onProgress: (done) => progress.push(done) })
      expect(plan.parts.map((p) => p.pages.length)).toEqual([200, 200, 100])
      expect(calls).toBeLessThan(60)
      expect(progress.at(-1)).toBe(500)
    })
    it('can be cancelled', async () => {
      const signal = { aborted: false }
      await expect(planBySize(50, 300, (p) => { signal.aborted = true; return size(p) }, { signal })).rejects.toThrow('Cancelled')
    })
  })

  describe('by bookmarks', () => {
    const node = (title: string, page: number | null, children: OutlineNode[] = []): OutlineNode => ({
      title,
      dest: page === null ? null : { pageIndex: page, tail: ['Fit'] },
      open: false,
      children
    })
    it('makes one part per top-level bookmark, ending before the next', () => {
      const plan = planByBookmarks([node('A', 0, [node('A.1', 2)]), node('B', 4), node('C', 7)], 10)
      expect(plan.parts.map((p) => [p.label, p.pages[0], p.pages.at(-1)])).toEqual([['A', 0, 3], ['B', 4, 6], ['C', 7, 9]])
      expect(plan.warnings).toEqual([])
    })
    it('adds front matter, sorts by page, merges bookmarks on one page and skips unusable ones', () => {
      const plan = planByBookmarks([node('Late', 6), node('Skip me', null), node('Early', 2), node('Same page', 2), node('Off the end', 99)], 8)
      expect(plan.parts.map((p) => [p.label, p.pages[0], p.pages.at(-1)])).toEqual([['Front matter', 0, 1], ['Early', 2, 5], ['Late', 6, 7]])
      expect(plan.warnings[0]).toMatch(/2 top-level bookmarks were skipped/)
    })
    it('a heading without a page uses its first child with one', () => {
      const plan = planByBookmarks([node('Heading', null, [node('x', null), node('y', 3)]), node('Next', 5)], 8)
      expect(plan.parts.map((p) => [p.label, p.pages[0]])).toEqual([['Front matter', 0], ['Heading', 3], ['Next', 5]])
    })
    it('explains why there is nothing to split', () => {
      expect(planByBookmarks([], 5)).toEqual({ parts: [], warnings: ['This document has no bookmarks.'] })
      expect(planByBookmarks([node('Nowhere', null)], 5).warnings.join(' ')).toMatch(/None of the top-level bookmarks point at a page/)
    })
  })
})

describe('file names', () => {
  it('removes path separators and traversal', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('etc passwd')
    expect(sanitizeFileName('..\\..\\Windows\\System32')).toBe('Windows System32')
    expect(sanitizeFileName('..')).toBe('part')
    expect(sanitizeFileName('.hidden')).toBe('hidden')
    expect(sanitizeFileName('C:\\evil.exe')).toBe('C evil.exe')
    expect(sanitizeFileName('a/b')).not.toMatch(/[/\\]/)
  })
  it('avoids reserved Windows names and trailing dots or spaces', () => {
    for (const n of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'lpt9', 'nul.txt', 'COM1.tar.gz']) expect(sanitizeFileName(n)).toBe(`_${n}`)
    expect(sanitizeFileName('CONSOLE')).toBe('CONSOLE')
    expect(sanitizeFileName('report. ')).toBe('report')
    expect(sanitizeFileName('   ')).toBe('part')
    expect(sanitizeFileName('')).toBe('part')
    expect(sanitizeFileName('', { fallback: 'x' })).toBe('x')
  })
  it('strips control, zero-width and bidi-override characters, keeps unicode', () => {
    expect(sanitizeFileName('a\u0000b\u001fc')).toBe('a b c')
    expect(sanitizeFileName('gpj.\u202Efdp')).toBe('gpj. fdp')
    expect(sanitizeFileName('Kapitel \u00dcbersicht \u2013 \u65e5\u672c\u8a9e \ud83d\ude00')).toBe('Kapitel \u00dcbersicht \u2013 \u65e5\u672c\u8a9e \ud83d\ude00')
    expect(sanitizeFileName('e\u0301')).toBe('\u00e9') // NFC
  })
  it('bounds the length without breaking surrogate pairs', () => {
    const long = 'x'.repeat(500)
    expect(sanitizeFileName(long).length).toBe(100)
    const emoji = '\ud83d\ude00'.repeat(80)
    const cut = sanitizeFileName(emoji, { maxLength: 11 })
    expect(cut).toBe('\ud83d\ude00'.repeat(5))
    expect(sanitizeFileName('a'.repeat(99) + '.')).toBe('a'.repeat(99))
  })
  it('makes names unique, case-insensitively, without overwriting', () => {
    const taken = new Set(['report.pdf'])
    expect(uniqueFileName('Report', 'pdf', taken)).toBe('Report (2).pdf')
    expect(uniqueFileName('REPORT', '.pdf', taken)).toBe('REPORT (3).pdf')
    expect(uniqueFileName('other', 'pdf', taken)).toBe('other.pdf')
  })
  it('names the parts of a split, avoiding existing files and duplicates between parts', () => {
    expect(partFileNames('Annual Report', ['Intro', 'Intro', undefined, '../bad'], ['annual report - 01 - intro.pdf'])).toEqual([
      'Annual Report - 01 - Intro (2).pdf',
      'Annual Report - 02 - Intro.pdf',
      'Annual Report - 03.pdf',
      'Annual Report - 04 - bad.pdf'
    ])
    expect(partFileNames('x', Array.from({ length: 100 }, () => undefined))[99]).toBe('x - 100.pdf')
    expect(stemOf('Doc.PDF')).toBe('Doc')
  })
})
