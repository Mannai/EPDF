import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, marksOf, pagesOf, settingsToOptions, totalRects, useRedact, type SearchResult, type UiMark } from '../../src/renderer/src/features/redact/store'

/** The marks store: what is marked, reviewed and undone before anything is applied. */

const D = 'doc'
const s = (): ReturnType<typeof useRedact.getState> => useRedact.getState()
const area = (page: number, x = 0): Omit<UiMark, 'id'> => ({ kind: 'area', pageIndex: page, rects: [{ x0: x, y0: 0, x1: x + 10, y1: 10 }], quads: [null] })
const hit = (id: string, page: number): SearchResult => ({ id, pageIndex: page, text: `hit ${id}`, rects: [{ x0: 0, y0: 0, x1: 5, y1: 5 }], quads: [null], hiddenOnly: false, decision: 'pending' })

beforeEach(() => {
  useRedact.setState({ docs: {}, settings: DEFAULT_SETTINGS, dialogDoc: null, pendingPurge: {}, announcement: '' })
})

describe('marks', () => {
  it('adds, selects, removes; every change is one undo step and redo re-applies it', () => {
    const a = s().addMark(D, area(0))
    const b = s().addMark(D, area(1))
    expect(marksOf(D).map((m) => m.id)).toEqual([a, b])
    expect(s().docs[D].selectedId).toBe(b)
    s().removeMark(D, a)
    expect(marksOf(D).map((m) => m.id)).toEqual([b])
    s().undoMarks(D)
    expect(marksOf(D).map((m) => m.id)).toEqual([a, b])
    s().undoMarks(D)
    s().undoMarks(D)
    expect(marksOf(D)).toEqual([])
    expect(s().docs[D].past).toHaveLength(0)
    s().redoMarks(D)
    s().redoMarks(D)
    expect(marksOf(D).map((m) => m.id)).toEqual([a, b])
    // a new change clears the redo branch
    s().undoMarks(D)
    s().addMark(D, area(2))
    expect(s().docs[D].future).toHaveLength(0)
  })

  it('addMarks adds several as one step; clear empties them undoably', () => {
    s().addMarks(D, [area(0), area(0, 20), area(3)])
    expect(marksOf(D)).toHaveLength(3)
    expect(pagesOf(marksOf(D))).toEqual([0, 3])
    expect(totalRects(marksOf(D))).toBe(3)
    s().undoMarks(D)
    expect(marksOf(D)).toHaveLength(0)
    s().redoMarks(D)
    s().clearMarks(D)
    expect(marksOf(D)).toHaveLength(0)
    s().undoMarks(D)
    expect(marksOf(D)).toHaveLength(3)
  })

  it('moving the same mark repeatedly (nudges) is one undo step; a pause or another mark starts a new one', () => {
    const a = s().addMark(D, area(0))
    for (let i = 1; i <= 5; i++) s().updateMark(D, a, { rects: [{ x0: i, y0: 0, x1: i + 10, y1: 10 }] }, `key:${a}`)
    expect(marksOf(D)[0].rects[0].x0).toBe(5)
    s().undoMarks(D)
    expect(marksOf(D)[0].rects[0].x0).toBe(0) // back to before the whole run of nudges
    s().undoMarks(D)
    expect(marksOf(D)).toHaveLength(0)
  })

  it('undo cannot go past the start and a selection of a removed mark is dropped', () => {
    const a = s().addMark(D, area(0))
    s().select(D, a)
    s().removeMark(D, a)
    expect(s().docs[D].selectedId).toBeNull()
    s().undoMarks(D)
    s().undoMarks(D)
    s().undoMarks(D)
    expect(marksOf(D)).toEqual([])
  })

  it('resetDoc forgets a document', () => {
    s().addMark(D, area(0))
    s().resetDoc(D)
    expect(marksOf(D)).toEqual([])
    expect(s().docs[D]).toBeUndefined()
  })
})

describe('search results review', () => {
  it('accepting a result marks it, rejecting or resetting removes the mark; results follow undo', () => {
    s().setResults(D, [hit('r1', 0), hit('r2', 0), hit('r3', 1)], '3 matches')
    s().decide(D, 'r1', 'accepted')
    expect(marksOf(D).map((m) => [m.id, m.kind, m.text])).toEqual([['r1', 'search', 'hit r1']])
    s().decide(D, 'r2', 'rejected')
    expect(marksOf(D)).toHaveLength(1)
    expect(s().docs[D].results.map((r) => r.decision)).toEqual(['accepted', 'rejected', 'pending'])
    s().decide(D, 'r1', 'pending')
    expect(marksOf(D)).toHaveLength(0)
    s().undoMarks(D) // brings the mark back and the result follows
    expect(s().docs[D].results[0].decision).toBe('accepted')
    s().undoMarks(D)
    expect(s().docs[D].results[0].decision).toBe('pending')
  })

  it('mark all / unmark all work on a chosen set and are single steps', () => {
    s().setResults(D, [hit('a', 0), hit('b', 0), hit('c', 1)], '')
    s().decideAll(D, ['a', 'c'], 'accepted')
    expect(marksOf(D).map((m) => m.id)).toEqual(['a', 'c'])
    s().decideAll(D, ['a'], 'rejected')
    expect(marksOf(D).map((m) => m.id)).toEqual(['c'])
    expect(s().docs[D].results.map((r) => r.decision)).toEqual(['rejected', 'pending', 'accepted'])
    s().undoMarks(D)
    expect(marksOf(D).map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('removing a mark that came from a result puts the result back to pending', () => {
    s().setResults(D, [hit('a', 0)], '')
    s().decide(D, 'a', 'accepted')
    s().removeMark(D, 'a')
    expect(s().docs[D].results[0].decision).toBe('pending')
  })
})

describe('apply settings', () => {
  it('turn into engine options: colour, overlay text, metadata and hidden data', () => {
    expect(settingsToOptions(DEFAULT_SETTINGS)).toEqual({ fill: [0, 0, 0], overlayText: '', removeMetadata: false, removeHidden: false })
    const o = settingsToOptions({ fill: '#ff8000', overlay: 'redacted', custom: 'ignored', removeMetadata: true, removeHidden: true })
    expect(o.fill[0]).toBeCloseTo(1)
    expect(o.fill[1]).toBeCloseTo(0.502, 2)
    expect(o.fill[2]).toBe(0)
    expect(o).toMatchObject({ overlayText: 'REDACTED', removeMetadata: true, removeHidden: true })
    expect(settingsToOptions({ ...DEFAULT_SETTINGS, overlay: 'custom', custom: '  CONFIDENTIAL ' }).overlayText).toBe('CONFIDENTIAL')
    expect(settingsToOptions({ ...DEFAULT_SETTINGS, fill: 'nonsense' }).fill).toEqual([0, 0, 0])
  })

  it('tracks documents whose applied redaction is not saved yet', () => {
    s().markPending(D, '/a.pdf')
    expect(s().pendingPurge[D]).toEqual({ path: '/a.pdf' })
    s().markPending(D, null)
    expect(s().pendingPurge[D]).toBeUndefined()
  })
})
