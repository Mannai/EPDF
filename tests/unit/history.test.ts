import { describe, expect, it } from 'vitest'
import { History } from '../../src/renderer/src/edit/history'

const b = (n: number, size = 4): Uint8Array => new Uint8Array(size).fill(n)

describe('History', () => {
  it('starts clean at the original', () => {
    const h = new History<Uint8Array>()
    expect(h.dirty).toBe(false)
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.current).toBeNull()
  })

  it('tracks edits, undo and redo with labels', () => {
    const h = new History<Uint8Array>()
    h.push('Rotate', b(1))
    h.push('Delete page', b(2))
    expect(h.dirty).toBe(true)
    expect(h.undoLabel).toBe('Delete page')
    expect(h.current).toEqual(b(2))

    expect(h.undo()).toBe(true)
    expect(h.current).toEqual(b(1))
    expect(h.redoLabel).toBe('Delete page')
    expect(h.canRedo).toBe(true)

    expect(h.undo()).toBe(true)
    expect(h.current).toBeNull() // back at the original
    expect(h.dirty).toBe(false) // ...which is what is on disk
    expect(h.undo()).toBe(false)

    expect(h.redo()).toBe(true)
    expect(h.redo()).toBe(true)
    expect(h.redo()).toBe(false)
    expect(h.current).toEqual(b(2))
  })

  it('a new edit discards the redo branch', () => {
    const h = new History<Uint8Array>()
    h.push('a', b(1))
    h.push('b', b(2))
    h.undo()
    h.push('c', b(3))
    expect(h.canRedo).toBe(false)
    expect(h.length).toBe(2)
    expect(h.current).toEqual(b(3))
  })

  it('is clean after save, dirty after another edit, and clean again after undoing to the saved state', () => {
    const h = new History<Uint8Array>()
    h.push('a', b(1))
    h.markSaved()
    expect(h.dirty).toBe(false)
    h.push('b', b(2))
    expect(h.dirty).toBe(true)
    h.undo()
    expect(h.dirty).toBe(false)
  })

  it('undoing past the saved state makes the document dirty again', () => {
    const h = new History<Uint8Array>()
    h.push('a', b(1))
    h.markSaved()
    h.undo()
    expect(h.dirty).toBe(true)
    h.redo()
    expect(h.dirty).toBe(false)
  })

  it('never reports clean when the saved state was discarded by a new edit (regression)', () => {
    const h = new History<Uint8Array>()
    h.push('a', b(1))
    h.push('b', b(2)) // index 1
    h.markSaved() // disk == state 1
    h.undo() // back to state 0
    h.push('c', b(3)) // new state lands on index 1, but is NOT what is on disk
    expect(h.position).toBe(1)
    expect(h.dirty).toBe(true)
  })

  it('bounds history by entry count; the oldest kept edit becomes the new original', () => {
    const h = new History<Uint8Array>(3)
    for (let i = 1; i <= 5; i++) h.push(`e${i}`, b(i))
    expect(h.length).toBe(3)
    expect(h.original).toEqual(b(2))
    expect(h.undoLabel).toBe('e5')
    h.undo()
    h.undo()
    h.undo()
    expect(h.current).toBeNull()
    expect(h.canUndo).toBe(false)
  })

  it('bounds history by total bytes but always keeps the latest state', () => {
    const h = new History<Uint8Array>(100, 10)
    h.push('a', b(1, 6))
    h.push('b', b(2, 6))
    h.push('c', b(3, 6))
    expect(h.length).toBe(1)
    expect(h.current).toEqual(b(3, 6))
  })

  it('every state has a unique revision; a new edit after undo never reuses one', () => {
    const h = new History<Uint8Array>()
    const r0 = h.revision
    const r1 = h.push('a', b(1))
    expect(h.revision).toBe(r1)
    h.undo()
    expect(h.revision).toBe(r0)
    const r2 = h.push('b', b(2))
    expect(new Set([r0, r1, r2]).size).toBe(3)
    // another history (e.g. after the edits were discarded) never issues these again
    const other = new History<Uint8Array>()
    expect([r0, r1, r2]).not.toContain(other.revision)
    expect(other.firstRevision).toBeGreaterThan(r2)
  })

  it('markSaved(revision) marks exactly that state, not whatever is current when the save finishes', () => {
    const h = new History<Uint8Array>()
    const written = h.push('a', b(1))
    h.push('b', b(2)) // made while the save was running
    expect(h.markSaved(written)).toBe(true)
    expect(h.dirty).toBe(true)
    h.undo()
    expect(h.dirty).toBe(false) // back at what is on disk
    h.undo()
    expect(h.dirty).toBe(true)
  })

  it('an undo made while saving leaves the document dirty', () => {
    const h = new History<Uint8Array>()
    const written = h.push('a', b(1))
    h.undo()
    h.markSaved(written)
    expect(h.dirty).toBe(true)
    h.redo()
    expect(h.dirty).toBe(false)
  })

  it('ignores revisions it did not issue (from a discarded history or another document)', () => {
    const stale = new History<Uint8Array>()
    const staleRev = stale.push('a', b(1))
    const h = new History<Uint8Array>()
    const other = new History<Uint8Array>()
    const otherRev = other.push('x', b(9))
    h.push('b', b(2))
    expect(h.markSaved(staleRev)).toBe(false)
    expect(h.markSaved(otherRev)).toBe(false)
    expect(h.markSaved(123456789)).toBe(false)
    expect(h.dirty).toBe(true)
    expect(h.savedRevision).toBe(h.firstRevision)
  })

  it('lineage lists the tags of every edit up to the current state and follows undo/redo', () => {
    const h = new History<Uint8Array>()
    const red = h.push('Apply redactions', b(1), ['redaction'])
    const rot = h.push('Rotate', b(2))
    const lock = h.push('Lock filled-in items', b(3), ['fill'])
    expect(h.lineage).toEqual([
      { tag: 'redaction', revision: red },
      { tag: 'fill', revision: lock }
    ])
    h.undo()
    expect(h.revision).toBe(rot)
    expect(h.lineage).toEqual([{ tag: 'redaction', revision: red }])
    h.undo()
    h.undo()
    expect(h.lineage).toEqual([])
    h.redo()
    expect(h.lineage).toEqual([{ tag: 'redaction', revision: red }])
  })

  it('trimmed edits hand their tags to the original', () => {
    const h = new History<Uint8Array>(2)
    const red = h.push('Apply redactions', b(1), ['redaction'])
    h.push('b', b(2))
    h.push('c', b(3)) // trims the redaction: it is part of the original now
    expect(h.length).toBe(2)
    expect(h.lineage).toEqual([{ tag: 'redaction', revision: red }])
    h.undo()
    h.undo()
    expect(h.current).toBeNull()
    expect(h.revision).toBe(red)
    expect(h.lineage).toEqual([{ tag: 'redaction', revision: red }])
  })

  it('clearSteps: the current state becomes the original with the same revision and lineage', () => {
    const h = new History<Uint8Array>()
    const red = h.push('Apply redactions', b(1), ['redaction'])
    h.markSaved(red)
    const after = h.push('Rotate', b(2)) // an edit made after the save
    h.push('redo branch', b(3))
    h.undo()
    h.clearSteps()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.length).toBe(0)
    expect(h.current).toBeNull()
    expect(h.original).toEqual(b(2))
    expect(h.revision).toBe(after)
    expect(h.lineage).toEqual([{ tag: 'redaction', revision: red }])
    expect(h.dirty).toBe(true) // the rotation is still unsaved
    expect(h.markSaved(after)).toBe(true)
    expect(h.dirty).toBe(false)
  })

  it('clearSteps at the saved state leaves it clean', () => {
    const h = new History<Uint8Array>()
    const r = h.push('Apply redactions', b(1), ['redaction'])
    h.markSaved(r)
    h.clearSteps()
    expect(h.dirty).toBe(false)
    expect(h.original).toEqual(b(1))
    h.push('next', b(2))
    expect(h.dirty).toBe(true)
    h.undo()
    expect(h.dirty).toBe(false)
  })

  it('trimming away the saved state leaves the document dirty', () => {
    const h = new History<Uint8Array>(2)
    h.markSaved() // original saved
    h.push('a', b(1))
    h.push('b', b(2))
    h.push('c', b(3)) // trims 'a'; the original is now 'a', which is not what is on disk
    expect(h.dirty).toBe(true)
    h.undo()
    h.undo()
    expect(h.current).toBeNull()
    expect(h.dirty).toBe(true) // the on-disk original is unreachable
  })
})
