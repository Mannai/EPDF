import { describe, expect, it } from 'vitest'
import { detectMoves } from '../../src/renderer/src/features/compare/diff/moves'
import { runCompare } from '../../src/renderer/src/features/compare/diff/engine'
import { changeText, pairedWords } from '../../src/renderer/src/features/compare/diff/enrich'
import { buildPageModel } from '../../src/renderer/src/features/compare/diff/words'
import { opts, paragraph, rng, run } from './helpers/compareItems'
import type { PageModel, RawItem } from '../../src/renderer/src/features/compare/diff/types'

const P1 = 'The committee met on Monday to review the annual budget and agreed that spending on travel should be reduced by ten percent.'
const P2 = 'New hires will receive their laptops during the first week and must complete the security training before accessing any customer data.'
const P3 = 'The warehouse in Rotterdam will close at the end of the quarter and its inventory will be transferred to the main distribution centre.'
const P4 = 'Please submit all expense reports before the fifteenth of each month so that reimbursements can be processed in the following payroll run.'

/** Each string becomes one page; a page is a list of paragraphs stacked vertically. */
function pageItems(paras: string[]): RawItem[] {
  return paras.flatMap((t, i) => {
    // wrap at ~60 chars into lines
    const lines: string[] = []
    let cur = ''
    for (const w of t.split(' ')) {
      if ((cur + ' ' + w).trim().length > 60) {
        lines.push(cur)
        cur = w
      } else cur = (cur + ' ' + w).trim()
    }
    if (cur) lines.push(cur)
    return paragraph(lines, 72, 80 + i * 110)
  })
}
const model = (paras: string[]): PageModel => buildPageModel(pageItems(paras), 612, 792, opts())
const docOf = (pages: string[][]): PageModel[] => pages.map(model)
const compare = (a: string[][], b: string[][]): ReturnType<typeof runCompare> => runCompare(docOf(a).map((m) => m.keys), docOf(b).map((m) => m.keys), opts())

describe('runCompare', () => {
  it('identical documents have no changes', () => {
    const r = compare([[P1, P2], [P3]], [[P1, P2], [P3]])
    expect(r.counts).toEqual({ added: 0, removed: 0, modified: 0, moved: 0, total: 0 })
    expect(r.changedPairs).toBe(0)
    expect(r.pairs).toHaveLength(2)
  })

  it('classifies an edited number as one modification with exact word positions and geometry-independent counts', () => {
    const edited = P1.replace('ten percent', 'twenty percent')
    const r = compare([[P1], [P2]], [[edited], [P2]])
    expect(r.counts).toMatchObject({ modified: 1, added: 0, removed: 0, moved: 0, total: 1 })
    const c = r.changes[0]
    expect(c.pair).toBe(0)
    expect(c.old!.page).toBe(1)
    const oldPage = model([P1])
    const newPage = model([edited])
    expect(oldPage.text.slice(...c.old!.parts[0])).toEqual(['ten'])
    expect(newPage.text.slice(...c.new!.parts[0])).toEqual(['twenty'])
    expect(r.pairs[0].changes).toBe(1)
    expect(r.pairs[1].changes).toBe(0)
    expect(r.changedPairs).toBe(1)
  })

  it('a paragraph added, one removed and one edited in the same document', () => {
    const editedP4 = P4.replace('fifteenth', 'twentieth')
    const r = compare([[P1, P2, P3, P4]], [[P1, P3, 'A completely unrelated remark about the weather in autumn and the falling leaves outside.', editedP4]])
    const kinds = r.changes.map((c) => c.kind).sort()
    expect(kinds).toEqual(['added', 'modified', 'removed'])
  })

  it('paragraph removed and re-added elsewhere on the page is ONE moved change, not remove + add', () => {
    const r = compare([[P1, P2, P3]], [[P2, P3, P1]])
    expect(r.counts.moved).toBe(1)
    expect(r.counts.added).toBe(0)
    expect(r.counts.removed).toBe(0)
    const moved = r.changes.find((c) => c.kind === 'moved')!
    expect(moved.old).toBeDefined()
    expect(moved.new).toBeDefined()
    expect(moved.edited).toBeUndefined()
  })

  it('a moved paragraph across pages is a move too, and an edited moved paragraph is flagged as edited', () => {
    const r = compare([[P1, P2], [P3]], [[P1], [P3, P2.replace('laptops', 'laptop computers')]])
    expect(r.counts.moved).toBe(1)
    const m = r.changes.find((c) => c.kind === 'moved')!
    expect(m.old!.page).toBe(1)
    expect(m.new!.page).toBe(2)
    expect(m.edited).toBe(true)
  })

  it('short phrases that vanish in one place and appear in another are not called moves', () => {
    const r = compare([['one two three four five six seven eight nine ten', 'alpha beta gamma delta']], [['one two three six seven eight nine ten', 'alpha beta gamma delta and four five']])
    expect(r.counts.moved).toBe(0)
  })

  it('an inserted page is an added change on a new-only pair; a deleted page is removed', () => {
    const inserted = compare([[P1], [P3]], [[P1], [P2], [P3]])
    expect(inserted.counts).toMatchObject({ added: 1, removed: 0, total: 1 })
    expect(inserted.pairs.map((p) => `${p.old}:${p.new}`)).toEqual(['1:1', 'null:2', '2:3'])
    expect(inserted.changes[0].new!.page).toBe(2)
    expect(inserted.changes[0].old).toBeUndefined()
    const deleted = compare([[P1], [P2], [P3]], [[P1], [P3]])
    expect(deleted.counts).toMatchObject({ removed: 1, added: 0, total: 1 })
    expect(deleted.changes[0].old!.page).toBe(2)
  })

  it('reordered pages produce no text changes but are flagged as moved pairs', () => {
    const r = compare([[P1], [P2], [P3]], [[P1], [P3], [P2]])
    expect(r.counts.total).toBe(0)
    expect(r.pairs.filter((p) => p.moved)).toHaveLength(1)
    expect(r.changedPairs).toBe(1)
  })

  it('changes are ordered by page pair and position', () => {
    const r = compare([[P1, P2], [P3, P4]], [[P1.replace('Monday', 'Tuesday'), P2.replace('first', 'second')], [P3.replace('Rotterdam', 'Antwerp'), P4]])
    expect(r.changes.map((c) => c.pair)).toEqual([0, 0, 1])
    expect(r.changes.map((c) => c.id)).toEqual([0, 1, 2])
  })

  it('a duplicated page yields exactly one added change', () => {
    const r = compare([[P1], [P2], [P3]], [[P1], [P2], [P2], [P3]])
    expect(r.counts).toMatchObject({ added: 1, total: 1 })
  })

  it('reports progress phases', () => {
    const seen = new Set<string>()
    runCompare([['a']], [['b']], opts(), { progress: (phase) => seen.add(phase) })
    expect([...seen].sort()).toEqual(['align', 'diff', 'moves'])
  })

  it('a 500-page document with scattered edits compares quickly', () => {
    const r = rng(5)
    const oldPages: string[][] = Array.from({ length: 500 }, (_, p) => Array.from({ length: 150 }, (_, w) => `word${(p * 131 + w * 17) % 977}x${p}`))
    const newPages = oldPages.map((pg, p) => (p % 25 === 0 ? pg.map((w, i) => (i === 40 ? `${w}CHANGED` : w)) : pg))
    void r
    const t = Date.now()
    const res = runCompare(oldPages, newPages, opts())
    expect(Date.now() - t).toBeLessThan(15000)
    expect(res.counts).toMatchObject({ modified: 20, total: 20 })
  })
})

describe('moved-block detection', () => {
  const chunk = (id: number, text: string, pair = 0): { id: number; keys: string[]; pair: number } => ({ id, keys: text.split(' '), pair })

  it('matches identical chunks one-to-one', () => {
    const m = detectMoves([chunk(1, 'this is a moved block of text'), chunk(2, 'this is a moved block of text')], [chunk(3, 'this is a moved block of text', 4), chunk(4, 'this is a moved block of text', 9)])
    expect(m).toHaveLength(2)
    expect(new Set(m.map((x) => x.added)).size).toBe(2)
    expect(m.every((x) => !x.edited)).toBe(true)
  })

  it('ignores chunks below the minimum length', () => {
    expect(detectMoves([chunk(1, 'too short here')], [chunk(2, 'too short here')])).toEqual([])
  })

  it('matches near-identical long chunks as edited moves but not different ones', () => {
    const base = 'the quick brown fox jumps over the lazy dog while the cat watches from the fence nearby'
    const near = 'the quick brown fox jumps over the lazy dogs while the cat watches from the fence nearby'
    const m = detectMoves([chunk(1, base)], [chunk(2, near)])
    expect(m).toEqual([{ removed: 1, added: 2, edited: true }])
    expect(detectMoves([chunk(1, base)], [chunk(2, 'completely different words that share nothing with the other sentence at all here today')])).toEqual([])
  })
})

describe('change texts', () => {
  it('previews old and new text with character marks and context', () => {
    const oldM = model(['Total revenue was 1,234.50 dollars for the quarter ending in March.'])
    const newM = model(['Total revenue was 1,284.50 dollars for the quarter ending in March.'])
    const r = runCompare([oldM.keys], [newM.keys], opts())
    const t = changeText(r.changes[0], oldM, newM)
    expect(t.oldText).toBe('1,234.50')
    expect(t.newText).toBe('1,284.50')
    expect(t.oldMarks).toEqual([[3, 4]])
    expect(t.newMarks).toEqual([[3, 4]])
    expect(t.before).toBe('Total revenue was')
    expect(t.after.startsWith('dollars for')).toBe(true)
    expect(pairedWords(r.changes[0])).toEqual([[3, 3]])
  })

  it('whole-text marks for additions and removals', () => {
    const a = model(['one two three four five'])
    const b = model(['one two three NEW WORDS four five'])
    const r = runCompare([a.keys], [b.keys], opts())
    const t = changeText(r.changes[0], a, b)
    expect(r.changes[0].kind).toBe('added')
    expect(t.newText).toBe('NEW WORDS')
    expect(t.newMarks).toEqual([[0, 9]])
    expect(t.oldText).toBe('')
    expect(pairedWords(r.changes[0])).toEqual([])
  })
})

it('helper sanity: a run has the expected box', () => {
  const it = run('abc', 10, 50, 10)
  expect(it.y1 - it.y0).toBeCloseTo(10.7, 5)
})
