import { beforeEach, describe, expect, it } from 'vitest'
import { History } from '../../src/renderer/src/edit/history'
import { _resetEditHooks, registerEditHooks, runBeforeWrite, runDecrypt } from '../../src/renderer/src/edit/hooks'

const b = (...n: number[]): Uint8Array => new Uint8Array(n)

beforeEach(() => _resetEditHooks())

describe('edit hooks', () => {
  it('decrypt: the first hook that returns bytes wins; hooks that decline are skipped', async () => {
    const calls: string[] = []
    registerEditHooks({ decrypt: async () => (calls.push('a'), null) })
    registerEditHooks({ decrypt: async () => (calls.push('b'), b(9)) })
    registerEditHooks({ decrypt: async () => (calls.push('c'), b(7)) })
    expect(await runDecrypt('d', b(1))).toEqual(b(9))
    expect(calls).toEqual(['a', 'b'])
  })

  it('decrypt: null when nobody can unlock the document', async () => {
    expect(await runDecrypt('d', b(1))).toBeNull()
    registerEditHooks({ decrypt: async () => null })
    expect(await runDecrypt('d', b(1))).toBeNull()
  })

  it('beforeWrite: every hook runs in order, each seeing the previous output; no hooks = unchanged', async () => {
    expect(await runBeforeWrite('d', b(1, 2))).toEqual(b(1, 2))
    registerEditHooks({ beforeWrite: async (_id, x) => Uint8Array.from([...x, 10]) })
    registerEditHooks({ decrypt: async () => null }) // a hook without beforeWrite is skipped
    registerEditHooks({ beforeWrite: async (_id, x) => Uint8Array.from([...x, 20]) })
    expect(await runBeforeWrite('d', b(1))).toEqual(b(1, 10, 20))
  })

  it('beforeWrite receives the document id', async () => {
    const seen: string[] = []
    registerEditHooks({ beforeWrite: async (id, x) => (seen.push(id), x) })
    await runBeforeWrite('doc-42', b(1))
    expect(seen).toEqual(['doc-42'])
  })
})

describe('History.replaceCurrent (used when an encrypted snapshot is unlocked)', () => {
  it('swaps the original without creating an undo step or a dirty document', () => {
    const h = new History<Uint8Array>()
    h.original = b(1)
    h.replaceCurrent(b(2))
    expect(h.original).toEqual(b(2))
    expect(h.dirty).toBe(false)
    expect(h.canUndo).toBe(false)
  })

  it('swaps the current snapshot in place and keeps undo/dirty state', () => {
    const h = new History<Uint8Array>()
    h.push('Recovered', b(1))
    h.markSaved()
    h.push('Edit', b(2))
    h.undo() // back at the saved 'Recovered' snapshot
    h.replaceCurrent(b(9))
    expect(h.current).toEqual(b(9))
    expect(h.dirty).toBe(false)
    expect(h.length).toBe(2)
    h.redo()
    expect(h.current).toEqual(b(2))
    h.undo()
    expect(h.current).toEqual(b(9))
  })
})
