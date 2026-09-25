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
