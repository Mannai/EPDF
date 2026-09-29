import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/db/migrations'
import { RecoveryRepo, VersionsRepo } from '../../src/main/db/repos'
import { _resetFeatureChannels, callFeatureChannel, type MainContext } from '../../src/main/features/api'
import { register } from '../../src/main/features/redact'
import { contributionsFor } from '../../src/main/menu/contributions'
import { FileService } from '../../src/main/services/fileService'
import { _resetTraceSources, registerTraceSource } from '../../src/main/services/traces'

/** The main-process half: purging the version history, recovery copy and library traces of a document the renderer names by id. */

let work: string
let files: FileService
let versions: VersionsRepo
let recovery: RecoveryRepo
let docA: string
let docB: string
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'epdf-redact-'))
  _resetFeatureChannels()
  _resetTraceSources()
  const db = new Database(':memory:')
  migrate(db)
  versions = new VersionsRepo(db)
  recovery = new RecoveryRepo(db)
  files = new FileService(join(work, 'data'), { versions, recovery })
  docA = join(work, 'a.pdf')
  docB = join(work, 'b.pdf')
  writeFileSync(docA, 'A original unredacted')
  writeFileSync(docB, 'B original')
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

function ctxFor(paths: Record<string, string>): MainContext {
  return { pathOfDoc: (id: string) => paths[id] ?? null, files } as unknown as MainContext
}

const call = (channel: string, payload: unknown): Promise<unknown> => callFeatureChannel(channel, payload, { event: {} as never, window: undefined })

describe('redact:purgeHistory', () => {
  it('deletes every version snapshot and the recovery copy of the named document (and only those)', async () => {
    await files.save(docA, enc('A v2 unredacted'))
    await files.save(docA, enc('A v3 redacted'))
    await files.save(docB, enc('B v2'))
    await files.writeRecovery(docA, enc('A autosave unredacted'))
    const snaps = versions.list(docA).map((v) => v.snapshotPath)
    register(ctxFor({ doc1: docA }))
    expect(await call('redact:historyInfo', { docId: 'doc1' })).toEqual({ versions: 2, recovery: true })
    const res = await call('redact:purgeHistory', { docId: 'doc1' })
    expect(res).toEqual({ versions: 2, deleted: 2, recovery: true, failed: 0 })
    for (const s of snaps) expect(existsSync(s)).toBe(false)
    expect(existsSync(dirname(snaps[0]))).toBe(false) // the now-empty folder goes too
    expect(files.hasRecovery(docA)).toBe(false)
    expect(files.listVersions(docB)).toHaveLength(1) // another document's history is untouched
    expect(await call('redact:historyInfo', { docId: 'doc1' })).toEqual({ versions: 0, recovery: false })
  })

  it('a copy that cannot be deleted keeps its record and is reported as failed', async () => {
    await files.save(docA, enc('A v2'))
    await files.save(docA, enc('A v3'))
    const [newest] = versions.list(docA)
    rmSync(newest.snapshotPath)
    mkdirSync(newest.snapshotPath) // a folder where the snapshot was: deleting it fails
    writeFileSync(join(newest.snapshotPath, 'x'), 'x')
    register(ctxFor({ d: docA }))
    expect(await call('redact:purgeHistory', { docId: 'd' })).toEqual({ versions: 2, deleted: 1, recovery: false, failed: 1 })
    expect(versions.list(docA).map((v) => v.id)).toEqual([newest.id]) // still listed, so a later purge retries it
    rmSync(newest.snapshotPath, { recursive: true })
    expect(await call('redact:purgeHistory', { docId: 'd' })).toEqual({ versions: 1, deleted: 1, recovery: false, failed: 0 })
  })

  it('also asks the library (and any other registered source) to forget the document', async () => {
    const asked: string[] = []
    registerTraceSource('library', (p) => {
      asked.push(p)
      return { failed: 1 }
    })
    registerTraceSource('broken', () => {
      throw new Error('boom')
    })
    register(ctxFor({ d: docA }))
    expect(await call('redact:purgeHistory', { docId: 'd' })).toEqual({ versions: 0, deleted: 0, recovery: false, failed: 2 })
    expect(asked).toEqual([docA])
  })

  it('rejects unknown documents, and payloads that try to supply a path or anything extra', async () => {
    register(ctxFor({}))
    await expect(call('redact:purgeHistory', { docId: 'nope' })).rejects.toThrow(/Unknown document/)
    await expect(call('redact:purgeHistory', { docId: 'x', path: 'C:/Windows/notepad.exe' })).rejects.toThrow(/Invalid request/)
    await expect(call('redact:purgeHistory', {})).rejects.toThrow(/Invalid request/)
    await expect(call('redact:purgeHistory', { docId: '' })).rejects.toThrow(/Invalid request/)
    expect(await call('redact:historyInfo', { docId: 'nope' })).toEqual({ versions: 0, recovery: false })
  })

  it('a snapshot file that is already missing does not fail the purge', async () => {
    await files.save(docA, enc('A v2'))
    rmSync(versions.list(docA)[0].snapshotPath)
    register(ctxFor({ d: docA }))
    const res = (await call('redact:purgeHistory', { docId: 'd' })) as { deleted: number; failed: number }
    expect(res).toMatchObject({ deleted: 1, failed: 0 }) // rm -f semantics
  })

  it('adds Tools > Redact… which runs redact.open', () => {
    register(ctxFor({}))
    const items = contributionsFor('Tools', 'end')
    expect(items.some((i) => i.label === 'Redact…')).toBe(true)
  })
})
