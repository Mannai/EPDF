import { describe, expect, it } from 'vitest'
import { clusterLines, readingGroups } from '../../src/renderer/src/features/compare/diff/layout'
import { keysOf, paragraph, rng, run } from './helpers/compareItems'

const words = (s: string): string[] => s.split(' ')

describe('reading order of multi-column pages', () => {
  const left = ['Left column line one', 'left column line two', 'left column line three', 'left column line four']
  const right = ['Right column line one', 'right column line two', 'right column line three', 'right column line four']

  it('reads a two-column page column by column, not row by row', () => {
    const items = [...paragraph(left, 72, 100), ...paragraph(right, 330, 100)]
    const keys = keysOf(items)
    expect(keys.join(' ')).toBe([...left, ...right].join(' '))
  })

  it('does not depend on the order the runs are stored in', () => {
    const items = [...paragraph(left, 72, 100), ...paragraph(right, 330, 100)]
    const r = rng(42)
    const shuffled = [...items].sort(() => r() - 0.5)
    expect(keysOf(shuffled)).toEqual(keysOf(items))
    // interleaved storage (row by row), as some producers write it
    const interleaved = left.flatMap((_, i) => [items[i], items[i + 4]])
    expect(keysOf(interleaved)).toEqual(keysOf(items))
  })

  it('a full-width title comes first, and a full-width footer last', () => {
    const title = run('A Title Spanning The Whole Width Of The Page Above Both Columns', 72, 60, 16)
    const footer = run('Footer text spanning both columns of the page below the two of them right here', 72, 400)
    const items = [footer, ...paragraph(right, 330, 100), title, ...paragraph(left, 72, 100)]
    expect(keysOf(items).join(' ')).toBe([title.str, ...left, ...right, footer.str].join(' '))
  })

  it('three columns', () => {
    const cols = [0, 1, 2].map((c) => paragraph([`col${c} alpha one`, `col${c} beta two`, `col${c} gamma three`], 60 + c * 190, 100))
    const expected = cols.flatMap((c) => c.map((i) => i.str)).join(' ')
    expect(keysOf(cols.flat().reverse()).join(' ')).toBe(expected)
  })

  it('a single column stays in top-to-bottom order with paragraphs', () => {
    const p1 = paragraph(['First paragraph line one', 'first paragraph line two'], 72, 100)
    const p2 = paragraph(['Second paragraph line one', 'second paragraph line two'], 72, 160)
    expect(keysOf([...p2, ...p1]).join(' ')).toBe([...p1, ...p2].map((i) => i.str).join(' '))
  })

  it('runs of one line that are far apart stay in their column order but are not merged across the gutter', () => {
    const items = [run('Name: John', 72, 100), run('Age: 30', 400, 100), run('Name: Mary', 72, 120), run('Age: 41', 400, 120)]
    expect(keysOf(items).join(' ')).toBe('Name : John Name : Mary Age : 30 Age : 41')
  })

  it('clusters runs into lines by vertical overlap (superscripts stay on their line)', () => {
    const base = run('E = mc', 72, 100)
    const sup = { ...run('2', base.x1, 100, 8), y0: base.y0 - 3, y1: base.y0 + 6 }
    const next = run('next line', 72, 120)
    const lines = clusterLines([next, sup, base])
    expect(lines).toHaveLength(2)
    expect(lines[0].map((i) => i.str)).toEqual(['E = mc', '2'])
  })

  it('readingGroups of nothing is empty', () => {
    expect(readingGroups([])).toEqual([])
  })

  it('is fast on a dense page (thousands of runs)', () => {
    const items = Array.from({ length: 4000 }, (_, i) => run(`word${i}`, 72 + (i % 8) * 60, 60 + Math.floor(i / 8) * 1.4))
    const t = Date.now()
    keysOf(items)
    expect(Date.now() - t).toBeLessThan(4000)
  })
})
