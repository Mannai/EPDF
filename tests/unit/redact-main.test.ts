import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetFeatureChannels, callFeatureChannel, type MainContext } from '../../src/main/features/api'
import { register } from '../../src/main/features/redact'
import { contributionsFor } from '../../src/main/menu/contributions'

/** The main-process half: purging the version history and recovery copy of a document the renderer names by id. */

let work: string
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'epdf-redact-'))
  _resetFeatureChannels()
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

function fakeCtx(paths: Record<string, string>, snapshots: string[], recovery: { path: string | null }): { ctx: MainContext; log: string[] } {
  const rows = snapshots.map((p, i) => ({ id: i + 1, docPath: '/docs/a.pdf', savedAt: 1, snapshotPath: p, size: 1, note: '' }))
  const log: string[] = []
  const ctx = {
    pathOfDoc: (id: string) => paths[id] ?? null,
    files: {
      listVersions: (p: string) => rows.filter((r) => r.docPath === p),
      hasRecovery: () => recovery.path !== null,
      clearRecovery: async () => {
        log.push('clearRecovery')
        recovery.path = null
      }
    },
    repos: {
      versions: {
        prune: (p: string, keep: number) => {
          log.push(`prune ${p} keep=${keep}`)
          const gone = rows.filter((r) => r.docPath === p).slice(keep)
          return gone.map((r) => r.snapshotPath)
        }
      }
    }
  } as unknown as MainContext
  return { ctx, log }
}

const call = (channel: string, payload: unknown): Promise<unknown> => callFeatureChannel(channel, payload, { event: {} as never, window: undefined })

describe('redact:purgeHistory', () => {
  it('deletes every version snapshot and the recovery copy of the named document (and only those)', async () => {
    const dir = join(work, 'versions', 'abc')
    mkdirSync(dir, { recursive: true })
    const snaps = [join(dir, '1.pdf'), join(dir, '2.pdf')]
    for (const s of snaps) writeFileSync(s, 'old unredacted content')
    const other = join(work, 'keep.txt')
    writeFileSync(other, 'unrelated')
    const rec = { path: join(work, 'recovery.pdf') }
    const { ctx, log } = fakeCtx({ doc1: '/docs/a.pdf' }, snaps, rec)
    register(ctx)
    const info = (await call('redact:historyInfo', { docId: 'doc1' })) as { versions: number; recovery: boolean }
    expect(info).toEqual({ versions: 2, recovery: true })
    const res = (await call('redact:purgeHistory', { docId: 'doc1' })) as { versions: number; deleted: number; recovery: boolean }
    expect(res).toEqual({ versions: 2, deleted: 2, recovery: true })
    for (const s of snaps) expect(existsSync(s)).toBe(false)
    expect(existsSync(dir)).toBe(false) // the now-empty folder goes too
    expect(existsSync(other)).toBe(true)
    expect(log).toContain('prune /docs/a.pdf keep=0')
    expect(log).toContain('clearRecovery')
  })

  it('rejects unknown documents, and payloads that try to supply a path or anything extra', async () => {
    const { ctx } = fakeCtx({}, [], { path: null })
    register(ctx)
    await expect(call('redact:purgeHistory', { docId: 'nope' })).rejects.toThrow(/Unknown document/)
    await expect(call('redact:purgeHistory', { docId: 'x', path: 'C:/Windows/notepad.exe' })).rejects.toThrow(/Invalid request/)
    await expect(call('redact:purgeHistory', {})).rejects.toThrow(/Invalid request/)
    await expect(call('redact:purgeHistory', { docId: '' })).rejects.toThrow(/Invalid request/)
    expect(await call('redact:historyInfo', { docId: 'nope' })).toEqual({ versions: 0, recovery: false })
  })

  it('a missing snapshot file does not fail the purge', async () => {
    const { ctx } = fakeCtx({ d: '/docs/a.pdf' }, [join(work, 'gone.pdf')], { path: null })
    register(ctx)
    const res = (await call('redact:purgeHistory', { docId: 'd' })) as { deleted: number }
    expect(res.deleted).toBe(1) // rm -f semantics
  })

  it('adds Tools > Redact… which runs redact.open', () => {
    const { ctx } = fakeCtx({}, [], { path: null })
    register(ctx)
    const items = contributionsFor('Tools', 'end')
    expect(items.some((i) => i.label === 'Redact…')).toBe(true)
  })
})
