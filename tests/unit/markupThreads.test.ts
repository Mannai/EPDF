import { describe, expect, it } from 'vitest'
import { hitTest } from '../../src/renderer/src/features/markup/pdf/hit'
import type { AnnotInfo } from '../../src/renderer/src/features/markup/pdf/model'
import {
  NO_FILTERS,
  authorsOf,
  buildThreads,
  filterThreads,
  isResolved,
  previewOf,
  reviewStates,
  typesOf
} from '../../src/renderer/src/features/markup/pdf/threads'

let seq = 0
function annot(o: Partial<AnnotInfo>): AnnotInfo {
  seq++
  return {
    id: `${seq} 0`,
    pageIndex: 0,
    order: seq,
    subtype: 'Text',
    rect: [0, 0, 24, 24],
    contents: '',
    author: 'Ada',
    subject: '',
    modified: null,
    created: null,
    name: '',
    color: null,
    fill: null,
    opacity: 1,
    flags: 4,
    quads: [],
    ink: [],
    line: null,
    lineEnds: ['None', 'None'],
    borderWidth: 1,
    dashed: false,
    fontSize: 12,
    iconName: '',
    irt: null,
    replyType: 'R',
    state: null,
    stateModel: null,
    hasAppearance: true,
    complex: false,
    ours: false,
    fillSign: null,
    ...o
  }
}

describe('threads', () => {
  it('orders threads by page, then top to bottom, then left to right', () => {
    const a = annot({ id: 'a', pageIndex: 1, rect: [10, 500, 30, 520] })
    const b = annot({ id: 'b', pageIndex: 0, rect: [10, 100, 30, 120] })
    const c = annot({ id: 'c', pageIndex: 0, rect: [10, 700, 30, 720] })
    const d = annot({ id: 'd', pageIndex: 0, rect: [200, 700, 220, 720] })
    expect(buildThreads([a, b, c, d]).map((t) => t.root.id)).toEqual(['c', 'd', 'b', 'a'])
  })

  it('attaches replies (nested too) to their root in time order and keeps them out of the root list', () => {
    const root = annot({ id: 'root', contents: 'question', created: 1000 })
    const r2 = annot({ id: 'r2', irt: 'root', contents: 'second', created: 3000, author: 'Bob' })
    const r1 = annot({ id: 'r1', irt: 'root', contents: 'first', created: 2000, author: 'Cy' })
    const nested = annot({ id: 'n', irt: 'r1', contents: 'nested', created: 2500 })
    const threads = buildThreads([root, r2, r1, nested])
    expect(threads).toHaveLength(1)
    expect(threads[0].replies.map((r) => [r.annot.id, r.depth])).toEqual([
      ['r1', 1],
      ['n', 2],
      ['r2', 1]
    ])
  })

  it('treats a reply whose parent is missing as its own thread, and survives cycles', () => {
    const orphan = annot({ id: 'o', irt: 'gone' })
    const x = annot({ id: 'x', irt: 'y' })
    const y = annot({ id: 'y', irt: 'x' })
    const threads = buildThreads([orphan, x, y])
    expect(threads.map((t) => t.root.id)).toContain('o')
    expect(threads.length).toBeGreaterThanOrEqual(1) // must terminate
  })

  it('review state: the newest state record wins; resolve then reopen; state records are not comments', () => {
    const root = annot({ id: 'root', contents: 'todo' })
    const s1 = annot({ id: 's1', irt: 'root', stateModel: 'Review', state: 'Completed', created: 1000, author: 'Bob' })
    const s2 = annot({ id: 's2', irt: 'root', stateModel: 'Review', state: 'None', created: 2000, author: 'Ada' })
    let threads = buildThreads([root, s1])
    expect(threads[0].state).toBe('Completed')
    expect(threads[0].stateBy).toBe('Bob')
    expect(isResolved(threads[0].state)).toBe(true)
    expect(threads[0].replies).toEqual([])
    threads = buildThreads([root, s1, s2])
    expect(threads[0].state).toBe('None')
    expect(reviewStates([root, s1, s2]).get('root')?.state).toBe('None')
    // same timestamp: the later record in the file wins
    const tie1 = annot({ id: 't1', irt: 'root', stateModel: 'Review', state: 'Accepted', created: 5 })
    const tie2 = annot({ id: 't2', irt: 'root', stateModel: 'Review', state: 'Rejected', created: 5 })
    expect(buildThreads([root, tie1, tie2])[0].state).toBe('Rejected')
    // unknown states are ignored
    const odd = annot({ id: 'odd', irt: 'root', stateModel: 'Review', state: 'Whatever', created: 9 })
    expect(buildThreads([root, odd])[0].state).toBe('None')
  })

  it('filters by type, author (including repliers), status and free text', () => {
    const note = annot({ id: 'n', subtype: 'Text', contents: 'Fix the TYPO here', author: 'Ada' })
    const reply = annot({ id: 'nr', irt: 'n', contents: 'done', author: 'Bob', created: 5 })
    const hl = annot({ id: 'h', subtype: 'Highlight', contents: '', author: 'Cy', pageIndex: 1 })
    const done = annot({ id: 'ds', irt: 'h', stateModel: 'Review', state: 'Completed', created: 9, author: 'Cy' })
    const threads = buildThreads([note, reply, hl, done])
    expect(filterThreads(threads, NO_FILTERS)).toHaveLength(2)
    expect(filterThreads(threads, { ...NO_FILTERS, type: 'Highlight' }).map((t) => t.root.id)).toEqual(['h'])
    expect(filterThreads(threads, { ...NO_FILTERS, author: 'Bob' }).map((t) => t.root.id)).toEqual(['n'])
    expect(filterThreads(threads, { ...NO_FILTERS, status: 'Completed' }).map((t) => t.root.id)).toEqual(['h'])
    expect(filterThreads(threads, { ...NO_FILTERS, status: 'None' }).map((t) => t.root.id)).toEqual(['n'])
    expect(filterThreads(threads, { ...NO_FILTERS, query: ' typo ' }).map((t) => t.root.id)).toEqual(['n'])
    expect(filterThreads(threads, { ...NO_FILTERS, query: 'DONE' }).map((t) => t.root.id)).toEqual(['n']) // matches a reply
    expect(filterThreads(threads, { ...NO_FILTERS, query: 'highlight' }).map((t) => t.root.id)).toEqual(['h']) // type label
    expect(filterThreads(threads, { ...NO_FILTERS, query: 'zzz' })).toEqual([])
  })

  it('lists distinct authors and root types for the filter controls', () => {
    const list = [
      annot({ author: 'Cy', subtype: 'Highlight' }),
      annot({ author: 'Ada', subtype: 'Text' }),
      annot({ author: 'Ada', subtype: 'Text', irt: 'x' }),
      annot({ author: '', subtype: 'Ink' })
    ]
    expect(authorsOf(list)).toEqual(['Ada', 'Cy'])
    // sorted by their display labels: Drawing, Highlight, Note
    expect(typesOf(list)).toEqual(['Ink', 'Highlight', 'Text'])
  })

  it('previews the comment, or the kind of mark when there is no text; long text is truncated', () => {
    expect(previewOf(annot({ contents: '  hello\n world ' }))).toBe('hello world')
    expect(previewOf(annot({ subtype: 'Highlight' }))).toBe('Highlight')
    expect(previewOf(annot({ contents: 'x'.repeat(300) }), 50)).toHaveLength(50)
  })
})

describe('hit-testing', () => {
  it('uses QuadPoints for text markup, not the whole bounding box', () => {
    // Two separate line quads: a click between the lines must miss.
    const hl = annot({
      subtype: 'Highlight',
      rect: [0, 0, 100, 50],
      quads: [
        [0, 50, 100, 50, 0, 40, 100, 40],
        [0, 10, 100, 10, 0, 0, 100, 0]
      ]
    })
    expect(hitTest([hl], 0, [50, 45])).toBe(hl)
    expect(hitTest([hl], 0, [50, 5])).toBe(hl)
    expect(hitTest([hl], 0, [50, 25])).toBeUndefined()
  })

  it('hits ink near the stroke only, and lines near the segment', () => {
    const ink = annot({ subtype: 'Ink', rect: [0, 0, 100, 100], ink: [[0, 0, 100, 100]], borderWidth: 2 })
    expect(hitTest([ink], 0, [50, 51])).toBe(ink)
    expect(hitTest([ink], 0, [90, 10])).toBeUndefined() // inside the rect, far from the stroke
    const line = annot({ subtype: 'Line', rect: [0, 0, 100, 100], line: [0, 0, 100, 0], borderWidth: 2 })
    expect(hitTest([line], 0, [50, 1])).toBe(line)
    expect(hitTest([line], 0, [50, 60])).toBeUndefined()
  })

  it('falls back to /Rect (with tolerance) for boxes, notes, stamps and unknown types', () => {
    const box = annot({ subtype: 'Square', rect: [100, 100, 200, 200] })
    const caret = annot({ subtype: 'Caret', rect: [10, 10, 20, 20] })
    expect(hitTest([box, caret], 0, [150, 150])).toBe(box)
    expect(hitTest([box, caret], 0, [98, 150])).toBe(box) // within 3pt tolerance
    expect(hitTest([box, caret], 0, [50, 50])).toBeUndefined()
    expect(hitTest([box, caret], 0, [15, 15])).toBe(caret)
  })

  it('picks the annotation drawn last when several overlap, and ignores other pages', () => {
    const under = annot({ subtype: 'Square', rect: [0, 0, 100, 100], order: 1 })
    const over = annot({ subtype: 'Circle', rect: [0, 0, 100, 100], order: 2 })
    expect(hitTest([under, over], 0, [50, 50])).toBe(over)
    expect(hitTest([under, over], 1, [50, 50])).toBeUndefined()
  })

  it('cannot click replies, review-state records or hidden annotations', () => {
    const reply = annot({ irt: 'x', rect: [0, 0, 24, 24] })
    const state = annot({ stateModel: 'Review', state: 'Completed', rect: [0, 0, 24, 24] })
    const hidden = annot({ flags: 2, rect: [0, 0, 24, 24] })
    const noView = annot({ flags: 32, rect: [0, 0, 24, 24] })
    expect(hitTest([reply, state, hidden, noView], 0, [10, 10])).toBeUndefined()
  })
})
