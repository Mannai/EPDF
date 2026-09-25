import { describe, expect, it } from 'vitest'
import { charRects, highlightRects } from '../../src/renderer/src/features/compare/diff/rects'
import { NO_FILTER, ALL_KINDS, countsPerPage, describeChange, describeCounts, filterChanges, primaryPage, stepChange } from '../../src/renderer/src/features/compare/diff/summary'
import { buildPageModel } from '../../src/renderer/src/features/compare/diff/words'
import type { Change, ChangeKind } from '../../src/renderer/src/features/compare/diff/types'
import type { ChangeText } from '../../src/renderer/src/features/compare/diff/enrich'
import { helvWidth, opts, run } from './helpers/compareItems'

describe('highlight rectangles from word geometry', () => {
  const page = buildPageModel([run('The quick brown fox jumps', 72, 100, 12), run('over the lazy dog', 72, 116, 12)], 612, 792, opts())

  it('a single word gets a tight rectangle at its true position', () => {
    const [r] = highlightRects(page, [[1, 2]], 0)
    expect(r.x).toBeCloseTo(72 + helvWidth('The ', 12), 3)
    expect(r.w).toBeCloseTo(helvWidth('quick', 12), 3)
    expect(r.y).toBeCloseTo(100 - 12 * 0.85, 3)
    expect(r.h).toBeCloseTo(12 * 1.07, 3)
  })

  it('adjacent words on a line merge into one rectangle that includes the space between them', () => {
    const rects = highlightRects(page, [[1, 4]], 0)
    expect(rects).toHaveLength(1)
    expect(rects[0].x).toBeCloseTo(72 + helvWidth('The ', 12), 3)
    expect(rects[0].w).toBeCloseTo(helvWidth('quick brown fox', 12), 3)
  })

  it('a phrase that wraps onto the next line gives one rectangle per line', () => {
    const rects = highlightRects(page, [[3, 7]], 0) // fox jumps | over the
    expect(rects).toHaveLength(2)
    expect(rects[0].y).toBeLessThan(rects[1].y)
    expect(rects[1].x).toBeCloseTo(72, 3)
  })

  it('separate parts never merge, and padding grows the rectangle', () => {
    const rects = highlightRects(page, [[0, 1], [1, 2]], 0)
    expect(rects).toHaveLength(2)
    const [padded] = highlightRects(page, [[0, 1]], 2)
    const [tight] = highlightRects(page, [[0, 1]], 0)
    expect(padded.w).toBeCloseTo(tight.w + 4, 5)
    expect(padded.x).toBeCloseTo(tight.x - 2, 5)
  })

  it('a hyphenated word is highlighted on both of its lines', () => {
    const p = buildPageModel([run('an exam-', 72, 100), run('ple here', 72, 116)], 612, 792, opts())
    expect(p.text).toEqual(['an', 'example', 'here'])
    const rects = highlightRects(p, [[1, 2]], 0)
    expect(rects).toHaveLength(2)
    expect(rects[0].y).toBeLessThan(rects[1].y)
  })

  it('character rectangles cover the marked characters proportionally', () => {
    const box = { x: 100, y: 50, w: helvWidth('1,234.50', 12), h: 12 }
    const [r] = charRects('1,234.50', box, [[3, 4]], 0) // the "3"
    expect(r.x).toBeCloseTo(100 + helvWidth('1,2', 12), 3)
    expect(r.w).toBeCloseTo(helvWidth('3', 12), 3)
    expect(charRects('abc', box, [])).toEqual([])
  })
})

const change = (id: number, kind: ChangeKind, page: number, extra: Partial<Change> = {}): Change => ({
  id,
  kind,
  pair: page - 1,
  ...(kind !== 'added' ? { old: { pair: page - 1, page, parts: [[0, 1]] as [number, number][], span: [0, 1] as [number, number] } } : {}),
  ...(kind !== 'removed' ? { new: { pair: page - 1, page, parts: [[0, 1]] as [number, number][], span: [0, 1] as [number, number] } } : {}),
  ...extra
})
const text = (o: string, n: string): ChangeText => ({ oldText: o, newText: n, oldMarks: [], newMarks: [], before: '', after: '' })

describe('change list helpers', () => {
  const changes = [change(0, 'removed', 1), change(1, 'modified', 1), change(2, 'added', 2), change(3, 'moved', 3, { old: { pair: 0, page: 1, parts: [[0, 1]], span: [0, 1] } }), change(4, 'modified', 3)]
  const texts = [text('gone', ''), text('100', '200'), text('', 'fresh Text'), text('moved', 'moved'), text('alpha', 'beta')]

  it('filters by kind, page and text (case-insensitive, either side)', () => {
    expect(filterChanges(changes, texts, NO_FILTER)).toHaveLength(5)
    expect(filterChanges(changes, texts, { ...NO_FILTER, kinds: new Set<ChangeKind>(['modified']) }).map((c) => c.id)).toEqual([1, 4])
    expect(filterChanges(changes, texts, { ...NO_FILTER, page: 1 }).map((c) => c.id)).toEqual([0, 1]) // the move is listed under its NEW page (3)
    expect(filterChanges(changes, texts, { ...NO_FILTER, page: 3 }).map((c) => c.id)).toEqual([3, 4])
    expect(filterChanges(changes, texts, { ...NO_FILTER, query: 'FRESH' }).map((c) => c.id)).toEqual([2])
    expect(filterChanges(changes, texts, { ...NO_FILTER, query: '100' }).map((c) => c.id)).toEqual([1])
    expect(filterChanges(changes, texts, { kinds: new Set(ALL_KINDS), page: 2, query: 'beta' })).toEqual([])
  })

  it('counts changes per page and per kind', () => {
    expect(countsPerPage(changes)).toEqual([
      { page: 1, added: 0, removed: 1, modified: 1, moved: 0, total: 2 },
      { page: 2, added: 1, removed: 0, modified: 0, moved: 0, total: 1 },
      { page: 3, added: 0, removed: 0, modified: 1, moved: 1, total: 2 }
    ])
    expect(primaryPage(changes[3])).toBe(3)
  })

  it('next and previous wrap around, also when the current change is filtered out', () => {
    expect(stepChange(changes, null, 1)).toBe(0)
    expect(stepChange(changes, null, -1)).toBe(4)
    expect(stepChange(changes, 4, 1)).toBe(0)
    expect(stepChange(changes, 0, -1)).toBe(4)
    expect(stepChange(changes, 2, 1)).toBe(3)
    const visible = [changes[1], changes[4]]
    expect(stepChange(visible, 2, 1)).toBe(1) // change 2 is filtered out: next visible after it is id 4
    expect(stepChange(visible, 2, -1)).toBe(0)
    expect(stepChange([], 1, 1)).toBe(-1)
  })

  it('announcements name the position, kind, page and the words', () => {
    expect(describeChange(changes[1], 5, 42, texts[1])).toBe('Change 5 of 42. Modified on page 1: “100” to “200”.')
    expect(describeChange(changes[0], 1, 5, texts[0])).toBe('Change 1 of 5. Removed on page 1: “gone”.')
    expect(describeChange(changes[3], 4, 5, texts[3])).toBe('Change 4 of 5. Moved from page 1 to page 3: “moved”.')
    expect(describeCounts({ added: 1, removed: 0, modified: 2, moved: 0, total: 3 })).toBe('3 changes: 1 added, 2 modified')
    expect(describeCounts({ added: 0, removed: 0, modified: 0, moved: 0, total: 0 })).toBe('No differences')
  })
})
