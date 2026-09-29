import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/db/migrations'
import { syncRoot, type SyncDeps, type SyncSummary } from '../../src/main/features/library/indexer'
import { LibraryRepo } from '../../src/main/features/library/repo'
import { DEFAULT_LIBRARY_SETTINGS } from '../../src/shared/features/library'
import { DirectEngine, TEST_ASSETS } from '../support/libraryEngine'
import { makeCorruptPdf, makeImageOnlyPdf, makePasswordPdf, makeTextPdf } from '../support/libraryFixtures'

let dir: string
let db: Database.Database
let repo: LibraryRepo
let engine: DirectEngine
let rootId: number

const deps = (over: Partial<SyncDeps> = {}): SyncDeps => ({ repo, engine, settings: DEFAULT_LIBRARY_SETTINGS, assets: TEST_ASSETS, throttle: false, ...over })
const sync = (over: Partial<SyncDeps> = {}, opts: { force?: number[]; signal?: AbortSignal } = {}): Promise<SyncSummary> =>
  syncRoot(deps(over), rootId, { signal: opts.signal ?? new AbortController().signal, forceIds: opts.force ? new Set(opts.force) : undefined })
const put = async (rel: string, pages: string[]): Promise<string> => {
  const p = join(dir, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, await makeTextPdf(pages))
  return p
}
const search = (q: string): string[] => {
  const r = repo.search({ query: q, scope: { kind: 'all' }, offset: 0, limit: 50 })
  return r.ok ? r.hits.map((h) => `${h.name}:${h.page}`).sort() : []
}
const files = () => repo.list({ scope: { kind: 'all' }, sort: 'name', descending: false, filter: 'all', offset: 0, limit: 500 }).items

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epdf-idx-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  repo = new LibraryRepo(db)
  engine = new DirectEngine()
  rootId = repo.addRoot(dir, 'Test', 'folder').id
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('syncing a watched folder', () => {
  it('indexes new files: names, sizes, page counts and per-page text', async () => {
    await put('a.pdf', ['Alpha bravo', 'Charlie delta'])
    await put('sub/b.pdf', ['Echo foxtrot'])
    const s = await sync()
    expect(s).toMatchObject({ rootOk: true, scanned: 2, added: 2, indexed: 2, removed: 0, problems: 0, cancelled: false })
    expect(files().map((f) => [f.name, f.pages, f.state])).toEqual([
      ['a.pdf', 2, 'indexed'],
      ['b.pdf', 1, 'indexed']
    ])
    expect(search('delta')).toEqual(['a.pdf:2'])
    expect(search('echo')).toEqual(['b.pdf:1'])
    expect(repo.listRoots()[0]).toMatchObject({ status: 'ok', files: 2, indexed: 2 })
  })

  it('asks for the thumbnails of deleted files, and of files that are no longer read, to be deleted', async () => {
    const gone = await put('gone.pdf', ['soon deleted'])
    const big = await put('big.pdf', ['x'.repeat(10)])
    await sync()
    const idOf = (name: string): number => Number(files().find((f) => f.name === name)!.ref.slice(1))
    const bigId = idOf('big.pdf')
    const goneId = idOf('gone.pdf')
    const asked: number[][] = []
    const removeThumbs = async (ids: number[]): Promise<void> => void asked.push(ids)
    unlinkSync(gone)
    writeFileSync(big, Buffer.concat([await makeTextPdf(['bigger now']), Buffer.alloc(2 * 1024 * 1024)]))
    await sync({ removeThumbs, settings: { ...DEFAULT_LIBRARY_SETTINGS, maxFileMb: 1 } })
    expect(asked.flat().sort()).toEqual([bigId, goneId].sort())
  })

  it('is incremental: a second run with nothing changed reads nothing', async () => {
    await put('a.pdf', ['one'])
    await put('b.pdf', ['two'])
    await sync()
    const before = engine.extracts
    const s = await sync()
    expect(engine.extracts).toBe(before)
    expect(s).toMatchObject({ added: 0, changed: 0, removed: 0, indexed: 0, scanned: 2 })
  })

  it('re-indexes an edited file and drops its old text', async () => {
    const p = await put('a.pdf', ['oldword here'])
    await sync()
    expect(search('oldword')).toEqual(['a.pdf:1'])
    writeFileSync(p, await makeTextPdf(['newword here', 'second page']))
    const s = await sync()
    expect(s).toMatchObject({ changed: 1, indexed: 1 })
    expect(search('oldword')).toEqual([])
    expect(search('newword')).toEqual(['a.pdf:1'])
    expect(files()[0].pages).toBe(2)
  })

  it('only the timestamp moved: the content hash matches, so the text is not extracted again', async () => {
    const p = await put('a.pdf', ['stable words'])
    await sync()
    const idBefore = files()[0].ref
    utimesSync(p, new Date(), new Date(Date.now() + 60_000))
    const spy = engine.extracts
    const s = await sync()
    expect(s.changed).toBe(1)
    expect(engine.extracts).toBe(spy + 1) // the hash comparison happens in the extractor...
    const item = files()[0]
    expect(item.ref).toBe(idBefore)
    expect(search('stable')).toEqual(['a.pdf:1']) // ...and the stored text is kept
    expect(repo.getFile(Number(item.ref.slice(1)))!.mtime).toBeGreaterThan(0)
    // now nothing is pending any more
    const again = engine.extracts
    await sync()
    expect(engine.extracts).toBe(again)
  })

  it('removes files that were deleted, with their text', async () => {
    const a = await put('a.pdf', ['deleteme'])
    await put('b.pdf', ['keepme'])
    await sync()
    unlinkSync(a)
    const s = await sync()
    expect(s.removed).toBe(1)
    expect(files().map((f) => f.name)).toEqual(['b.pdf'])
    expect(search('deleteme')).toEqual([])
    expect(search('keepme')).toEqual(['b.pdf:1'])
  })

  it('recognises a renamed/moved file by size and content hash: same id, no re-extraction', async () => {
    const p = await put('old.pdf', ['moved content unique'])
    await sync()
    const before = files()[0]
    repo.setFavoriteFile(Number(before.ref.slice(1)), true)
    mkdirSync(join(dir, 'archive'))
    renameSync(p, join(dir, 'archive', 'renamed.pdf'))
    const extractsBefore = engine.extracts
    const s = await sync()
    expect(s).toMatchObject({ moved: 1, removed: 0 })
    expect(engine.extracts).toBe(extractsBefore) // hashed only, text kept
    const after = files()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ ref: before.ref, name: 'renamed.pdf', favorite: true })
    expect(search('unique')).toEqual(['renamed.pdf:1'])
  })

  it('a new file with the same size as a deleted one but different content is a delete + add, not a move', async () => {
    const a = await put('a.pdf', ['aaaa aaaa'])
    await sync()
    unlinkSync(a)
    await put('b.pdf', ['bbbb bbbb']) // same length text => same file size
    const s = await sync()
    expect(s).toMatchObject({ moved: 0, removed: 1, added: 1 })
    expect(search('bbbb')).toEqual(['b.pdf:1'])
    expect(search('aaaa')).toEqual([])
  })

  it('records encrypted, corrupt and scanned files with the reason and carries on', async () => {
    await put('good.pdf', ['fine text'])
    writeFileSync(join(dir, 'locked.pdf'), makePasswordPdf())
    writeFileSync(join(dir, 'broken.pdf'), makeCorruptPdf())
    writeFileSync(join(dir, 'scan.pdf'), await makeImageOnlyPdf(2))
    writeFileSync(join(dir, 'fake.pdf'), 'not a pdf at all')
    const s = await sync()
    expect(s).toMatchObject({ indexed: 1, noText: 1, unindexable: 3, problems: 3 })
    const by = Object.fromEntries(files().map((f) => [f.name, f]))
    expect(by['locked.pdf']).toMatchObject({ state: 'unindexable' })
    expect(by['locked.pdf'].note).toMatch(/Password-protected/)
    expect(by['broken.pdf'].state).toBe('unindexable')
    expect(by['fake.pdf'].note).toMatch(/Not a PDF/)
    expect(by['scan.pdf']).toMatchObject({ state: 'no_text', pages: 2 })
    expect(by['scan.pdf'].note).toMatch(/OCR/)
    expect(search('fine')).toEqual(['good.pdf:1'])
    // A second run does not retry them (they are done), so a broken file never makes the indexer spin.
    const n = engine.extracts
    await sync()
    expect(engine.extracts).toBe(n)
  })

  it('does not read cloud placeholders and oversized files, and indexes them when allowed', async () => {
    const big = await put('big.pdf', ['huge content words'])
    const s1 = await sync({ settings: { ...DEFAULT_LIBRARY_SETTINGS, maxFileMb: 0 } }) // everything is "too large"
    expect(s1).toMatchObject({ tooLarge: 1, indexed: 0 })
    expect(engine.extracts).toBe(0)
    expect(files()[0]).toMatchObject({ state: 'too_large' })
    expect(files()[0].note).toMatch(/Index anyway/)
    // "Index anyway"
    const s2 = await sync({ settings: { ...DEFAULT_LIBRARY_SETTINGS, maxFileMb: 0 } }, { force: [Number(files()[0].ref.slice(1))] })
    expect(s2.indexed).toBe(1)
    expect(search('huge')).toEqual(['big.pdf:1'])
    expect(big).toBeTruthy()
  })

  it('cloud placeholders are recorded without extraction (engine never asked to read them)', async () => {
    await put('local.pdf', ['local words'])
    const cloudPath = await put('cloud.pdf', ['cloud words'])
    const realScan = engine.scan.bind(engine)
    engine.scan = async (...args) => {
      const r = await realScan(...args)
      for (const e of r.entries) if (e.path === cloudPath || e.name === 'cloud.pdf') e.cloud = true
      return r
    }
    const s = await sync()
    expect(s).toMatchObject({ cloud: 1, indexed: 1 })
    expect(engine.extractedPaths.some((p) => p.endsWith('cloud.pdf'))).toBe(false)
    const cloud = files().find((f) => f.name === 'cloud.pdf')!
    expect(cloud).toMatchObject({ cloud: true, state: 'cloud' })
    expect(search('cloud')).toEqual([])
    // Once it is downloaded (not a placeholder any more) it is indexed.
    engine.scan = realScan
    const s2 = await sync()
    expect(s2.indexed).toBe(1)
    expect(search('cloud')).toEqual(['cloud.pdf:1'])
    expect(files().find((f) => f.name === 'cloud.pdf')!.cloud).toBe(false)
  })

  it('an indexed file that the sync client later "frees up" keeps its text and gets the cloud flag', async () => {
    await put('a.pdf', ['keepable text'])
    await sync()
    const realScan = engine.scan.bind(engine)
    engine.scan = async (...args) => {
      const r = await realScan(...args)
      r.entries.forEach((e) => (e.cloud = true))
      return r
    }
    const s = await sync()
    expect(s.indexed).toBe(0)
    expect(files()[0]).toMatchObject({ cloud: true, state: 'indexed' })
    expect(search('keepable')).toEqual(['a.pdf:1'])
  })

  it('cancelling stops between files; finished files are kept and the rest resumes next time', async () => {
    for (let i = 0; i < 6; i++) await put(`f${i}.pdf`, [`text number ${i}`])
    const ctl = new AbortController()
    const realExtract = engine.extract.bind(engine)
    let n = 0
    engine.extract = async (r, s) => {
      if (++n === 3) ctl.abort()
      return realExtract(r, s)
    }
    const s = await sync({}, { signal: ctl.signal })
    expect(s.cancelled).toBe(true)
    const states = files().map((f) => f.state)
    expect(states.filter((x) => x === 'indexed').length).toBeGreaterThanOrEqual(2)
    expect(states.filter((x) => x === 'pending').length).toBeGreaterThan(0)
    engine.extract = realExtract
    const s2 = await sync()
    expect(s2.cancelled).toBe(false)
    expect(files().every((f) => f.state === 'indexed')).toBe(true)
    expect(files()).toHaveLength(6)
  })

  it('a folder that vanished is marked missing and its files are kept (a drive may come back)', async () => {
    await put('a.pdf', ['survives'])
    await sync()
    rmSync(dir, { recursive: true, force: true })
    const s = await sync()
    expect(s.rootOk).toBe(false)
    expect(repo.listRoots()[0]).toMatchObject({ status: 'missing' })
    expect(repo.listRoots()[0].note).toMatch(/does not exist|not connected/)
    expect(files()).toHaveLength(1)
    expect(search('survives')).toEqual(['a.pdf:1'])
  })

  it('files a truncated scan did not list are kept if they still exist', async () => {
    for (let i = 0; i < 5; i++) await put(`f${i}.pdf`, [`t${i}`])
    await sync()
    const s = await sync({ settings: { ...DEFAULT_LIBRARY_SETTINGS, maxFilesPerFolder: 2 } })
    expect(s.removed).toBe(0)
    expect(files()).toHaveLength(5)
    expect(s.note).toMatch(/Stopped after 2 files/)
  })

  it('survives a file that disappears between the scan and the read', async () => {
    const a = await put('a.pdf', ['x'])
    await put('b.pdf', ['y'])
    const realExtract = engine.extract.bind(engine)
    engine.extract = async (r, s) => {
      if (r.path.endsWith('a.pdf')) unlinkSync(a)
      return realExtract(r, s)
    }
    const s = await sync()
    expect(s.indexed).toBe(1)
    expect(files().map((f) => f.name)).toEqual(['b.pdf'])
  })

  it('an extractor crash (worker died) is recorded as a problem for that file only', async () => {
    await put('a.pdf', ['fine'])
    await put('b.pdf', ['also fine'])
    const realExtract = engine.extract.bind(engine)
    engine.extract = async (r, s) => {
      if (r.path.endsWith('a.pdf')) throw new Error('The index worker stopped.')
      return realExtract(r, s)
    }
    const s = await sync()
    expect(s).toMatchObject({ indexed: 1, unindexable: 1, problems: 1 })
    expect(files().find((f) => f.name === 'a.pdf')!.note).toMatch(/worker stopped/)
  })

  it('handles accented and CJK file names and content', async () => {
    await put('Résumé_日本語.pdf', ['Curriculum vitæ café'])
    await sync()
    expect(files()[0].name).toBe('Résumé_日本語.pdf')
    expect(repo.list({ scope: { kind: 'all' }, name: 'resume', sort: 'name', descending: false, filter: 'all', offset: 0, limit: 5 }).total).toBe(1)
    expect(repo.list({ scope: { kind: 'all' }, name: '日本', sort: 'name', descending: false, filter: 'all', offset: 0, limit: 5 }).total).toBe(1)
  })

  it('a file that is also in another watched folder is counted as a problem, not a crash', async () => {
    await put('sub/a.pdf', ['shared'])
    const other = repo.addRoot(join(dir, 'sub'), 'Overlapping', 'folder').id
    await sync()
    const s = await syncRoot(deps(), other, { signal: new AbortController().signal })
    expect(s.rootOk).toBe(true)
    expect(s.problems).toBeGreaterThanOrEqual(1)
    expect(files()).toHaveLength(1)
  })
})
