import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/db/migrations'
import { resolveTarget } from '../../src/main/features/library/access'
import { FeatureKv, RecentFilesRepo } from '../../src/main/db/repos'
import { LibraryRepo } from '../../src/main/features/library/repo'
import { LibraryService, type ServicePorts, type SyncJobPayload } from '../../src/main/features/library/service'
import { detectFolders, dropboxPathsFromInfo, type SuggestEnv } from '../../src/main/features/library/suggest'
import { DEFAULT_LIBRARY_SETTINGS } from '../../src/shared/features/library'
import { DirectEngine, TEST_ASSETS } from '../support/libraryEngine'
import { makeTextPdf } from '../support/libraryFixtures'

// ---- folder suggestions ------------------------------------------------------------------------------------------

function fakeEnv(over: Partial<SuggestEnv> & { dirs: string[]; files?: Record<string, string> }): SuggestEnv {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
  const dirs = new Map(over.dirs.map((d) => [norm(d), d.replace(/[\\/]+/g, '/')]))
  return {
    platform: 'win32',
    home: 'C:\\Users\\Ann',
    env: {},
    isDir: (p) => dirs.has(norm(p)),
    listDir: (p) =>
      [...dirs.entries()]
        .filter(([k]) => k.startsWith(norm(p) + '/') && !k.slice(norm(p).length + 1).includes('/'))
        .map(([, orig]) => orig.slice(orig.lastIndexOf('/') + 1)),
    readText: (p) => over.files?.[norm(p)] ?? null,
    ...over
  }
}

describe('folder suggestions', () => {
  it('finds OneDrive (env vars and home folders), Google Drive, Dropbox, iCloud and the usual folders on Windows', () => {
    const env = fakeEnv({
      env: { OneDrive: 'C:\\Users\\Ann\\OneDrive', OneDriveCommercial: 'C:\\Users\\Ann\\OneDrive - Contoso', APPDATA: 'C:\\Users\\Ann\\AppData\\Roaming' },
      dirs: [
        'C:\\Users\\Ann\\OneDrive',
        'C:\\Users\\Ann\\OneDrive - Contoso',
        'G:\\My Drive',
        'C:\\Users\\Ann\\Dropbox (Team)',
        'D:\\Work\\Dropbox',
        'C:\\Users\\Ann\\iCloudDrive',
        'C:\\Users\\Ann\\Documents',
        'C:\\Users\\Ann\\Downloads',
        'C:\\Users\\Ann\\Desktop'
      ],
      files: { 'c:/users/ann/appdata/roaming/dropbox/info.json': JSON.stringify({ personal: { path: 'D:\\Work\\Dropbox' }, business: { path: 'C:\\Users\\Ann\\Dropbox (Team)' } }) }
    })
    const s = detectFolders(env)
    const kinds = s.map((x) => `${x.kind}:${x.label}`)
    expect(kinds).toEqual(
      expect.arrayContaining(['onedrive:OneDrive', 'onedrive:OneDrive (work)', 'gdrive:Google Drive (G:)', 'dropbox:Dropbox', 'dropbox:Dropbox (business)', 'icloud:iCloud Drive', 'documents:Documents', 'downloads:Downloads', 'desktop:Desktop'])
    )
    expect(s.find((x) => x.kind === 'gdrive')!.path).toBe('G:\\My Drive')
    expect(s.filter((x) => x.cloud).length).toBeGreaterThanOrEqual(6)
    expect(s.find((x) => x.kind === 'documents')!.cloud).toBe(false)
    // OneDrive is listed once even though the env var and the home folder both point at it.
    expect(s.filter((x) => x.path.toLowerCase() === 'c:\\users\\ann\\onedrive')).toHaveLength(1)
  })

  it('only suggests folders that exist', () => {
    const s = detectFolders(fakeEnv({ env: { OneDrive: 'C:\\Users\\Ann\\OneDrive' }, dirs: ['C:\\Users\\Ann\\Documents'] }))
    expect(s.map((x) => x.kind)).toEqual(['documents'])
  })

  it('macOS: CloudStorage providers, iCloud Drive and ~/Dropbox', () => {
    const home = '/Users/ann'
    const s = detectFolders(
      fakeEnv({
        platform: 'darwin',
        home,
        dirs: [
          `${home}/Library/CloudStorage`,
          `${home}/Library/CloudStorage/GoogleDrive-ann@example.com`,
          `${home}/Library/CloudStorage/GoogleDrive-ann@example.com/My Drive`,
          `${home}/Library/CloudStorage/OneDrive-Personal`,
          `${home}/Library/CloudStorage/Dropbox`,
          `${home}/Library/Mobile Documents/com~apple~CloudDocs`,
          `${home}/Dropbox`
        ]
      })
    )
    const by = (k: string) => s.filter((x) => x.kind === k)
    expect(by('gdrive')[0].path).toBe(`${home}/Library/CloudStorage/GoogleDrive-ann@example.com/My Drive`)
    expect(by('gdrive')[0].label).toContain('ann@example.com')
    expect(by('onedrive')).toHaveLength(1)
    expect(by('icloud')[0].path).toContain('com~apple~CloudDocs')
    expect(by('dropbox').length).toBeGreaterThanOrEqual(1)
  })

  it('Linux and empty machines give at most the document folders', () => {
    expect(detectFolders(fakeEnv({ platform: 'linux', home: '/home/ann', dirs: [] }))).toEqual([])
    expect(detectFolders(fakeEnv({ platform: 'linux', home: '/home/ann', dirs: ['/home/ann/Documents'] })).map((x) => x.kind)).toEqual(['documents'])
  })

  it('reads Dropbox info.json, tolerating garbage', () => {
    expect(dropboxPathsFromInfo('{"personal":{"path":"/a/Dropbox"},"business":{"path":"/b"},"x":{"nope":1}}')).toEqual([
      { label: 'Dropbox', path: '/a/Dropbox' },
      { label: 'Dropbox (business)', path: '/b' }
    ])
    expect(dropboxPathsFromInfo('{oops')).toEqual([])
    expect(dropboxPathsFromInfo(null)).toEqual([])
    expect(dropboxPathsFromInfo('[]')).toEqual([])
  })
})

// ---- opening: the gate ---------------------------------------------------------------------------------------------

let dir: string
let outside: string
let db: Database.Database
let repo: LibraryRepo
let rootId: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epdf-svc-'))
  outside = mkdtempSync(join(tmpdir(), 'epdf-out-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  repo = new LibraryRepo(db)
  rootId = repo.addRoot(dir, 'Test', 'folder').id
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const fileRow = (path: string, name = 'x.pdf'): number => repo.insertFile(rootId, { path, relDir: '', name, size: 10, mtime: 1, cloud: false }, 'indexed')

describe('opening a file by reference', () => {
  it('opens a known PDF inside its watched folder', async () => {
    const p = join(dir, 'ok.pdf')
    writeFileSync(p, await makeTextPdf(['hi']))
    const id = fileRow(p, 'ok.pdf')
    const t = await resolveTarget({ repo }, `f${id}`)
    expect(t).toMatchObject({ ok: true, name: 'ok.pdf', fileId: id, cloud: false })
  })

  it('refuses malformed refs, unknown ids and anything that is not a ref (paths!)', async () => {
    for (const bad of ['', 'f0', 'f99999', 'C:\\Windows\\win.ini', '../../etc/passwd', 'r99999', 42, null]) {
      const t = await resolveTarget({ repo }, bad)
      expect(t.ok, String(bad)).toBe(false)
    }
  })

  it('a file deleted since indexing is reported as gone (main then drops it)', async () => {
    const p = join(dir, 'gone.pdf')
    const id = fileRow(p, 'gone.pdf')
    const t = await resolveTarget({ repo }, `f${id}`)
    expect(t).toMatchObject({ ok: false, gone: true, fileId: id })
    expect((t as { reason: string }).reason).toMatch(/no longer exists/)
  })

  it('a file whose content is not a PDF any more is refused with a clear reason', async () => {
    const p = join(dir, 'fake.pdf')
    writeFileSync(p, 'hello, definitely not pdf')
    const id = fileRow(p, 'fake.pdf')
    const t = await resolveTarget({ repo }, `f${id}`)
    expect(t).toMatchObject({ ok: false })
    expect((t as { reason: string }).reason).toMatch(/not a valid PDF/)
  })

  it('never opens a file that a link inside the folder points out of the folder', async () => {
    writeFileSync(join(outside, 'secret.pdf'), await makeTextPdf(['secret']))
    try {
      symlinkSync(outside, join(dir, 'escape'), 'junction')
    } catch {
      return // links not permitted here
    }
    // Pretend an old scan (or a tampered database) recorded the path through the link.
    const id = fileRow(join(dir, 'escape', 'secret.pdf'), 'secret.pdf')
    const t = await resolveTarget({ repo }, `f${id}`)
    expect(t).toMatchObject({ ok: false })
    expect((t as { reason: string }).reason).toMatch(/outside the watched folder/)
  })

  it('a removed watched folder or a hidden file cannot be opened', async () => {
    const p = join(dir, 'a.pdf')
    writeFileSync(p, await makeTextPdf(['a']))
    const id = fileRow(p, 'a.pdf')
    repo.hideFile(id)
    expect(await resolveTarget({ repo }, `f${id}`)).toMatchObject({ ok: false })
    const id2 = fileRow(join(dir, 'b.pdf'), 'b.pdf')
    db.pragma('foreign_keys = OFF')
    db.prepare('UPDATE library_files SET root_id = 9999 WHERE id = ?').run(id2)
    expect(await resolveTarget({ repo }, `f${id2}`)).toMatchObject({ ok: false })
  })

  it('recent files open only if they are known recents', async () => {
    const p = join(outside, 'recent.pdf')
    writeFileSync(p, await makeTextPdf(['r']))
    new RecentFilesRepo(db).touch(p, 'recent.pdf', 10, 1)
    const rid = (db.prepare('SELECT id FROM recent_files').get() as { id: number }).id
    expect(await resolveTarget({ repo }, `r${rid}`)).toMatchObject({ ok: true, name: 'recent.pdf', fileId: null })
    expect(await resolveTarget({ repo }, `r${rid + 1}`)).toMatchObject({ ok: false })
  })

  it('cloud files are flagged (opening them downloads them: that is the user asking)', async () => {
    const p = join(dir, 'c.pdf')
    writeFileSync(p, await makeTextPdf(['c']))
    const id = repo.insertFile(rootId, { path: p, relDir: '', name: 'c.pdf', size: 10, mtime: 1, cloud: true }, 'cloud')
    expect(await resolveTarget({ repo }, `f${id}`)).toMatchObject({ ok: true, cloud: true })
  })
})

// ---- the service: queue, watchers, settings, thumbnails ------------------------------------------------------------------

function makeService(over: Partial<ServicePorts> = {}) {
  const events: { channel: string; payload: unknown }[] = []
  const jobs: SyncJobPayload[] = []
  const kvDb = new FeatureKv(db, 'library')
  let svc: LibraryService
  const engine = new DirectEngine()
  const ctls = new Map<string, AbortController>()
  const ports: ServicePorts = {
    startJob: (payload) => {
      jobs.push(payload)
      // Run like the job manager would: the handler starts at once, with a cancellable signal.
      const ctl = new AbortController()
      const id = `job${jobs.length}`
      ctls.set(id, ctl)
      void svc.runJob(payload, { progress: () => undefined, signal: ctl.signal }).catch(() => undefined)
      return id
    },
    cancelJob: (id) => (ctls.get(id)?.abort(), true),
    emit: (channel, payload) => events.push({ channel, payload }),
    kv: kvDb,
    createEngine: () => engine,
    assets: () => TEST_ASSETS,
    thumbsDir: join(dir, '..', `thumbs-${Date.now()}`),
    watchDebounceMs: 80,
    rescanIntervalMs: 60_000,
    ...over
  }
  svc = new LibraryService(repo, ports)
  return { svc, events, jobs, engine, ports }
}

const waitFor = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('library service', () => {
  it('syncs queued folders in one job at a time and coalesces requests made while it runs', async () => {
    writeFileSync(join(dir, 'a.pdf'), await makeTextPdf(['first']))
    const { svc, jobs } = makeService()
    svc.enqueue([rootId])
    svc.enqueue([rootId]) // while running: queued once, not twice in parallel
    expect(jobs).toHaveLength(1)
    await waitFor(() => !svc.getStatus().running && jobs.length === 2)
    await waitFor(() => !svc.getStatus().running)
    expect(repo.counts().indexed).toBe(1)
    expect(svc.getStatus()).toMatchObject({ running: false, phase: 'idle' })
    expect(svc.getStatus().message).toBe('Up to date.')
    svc.dispose()
  })

  it('cancel stops the running job; watcher/periodic requests do not resume it, an explicit rescan does', async () => {
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${i}.pdf`), await makeTextPdf([`file number ${i}`]))
    const { svc, jobs } = makeService({ extraDelayMs: 80 })
    svc.enqueue([rootId])
    await waitFor(() => svc.getStatus().phase === 'indexing' && svc.getStatus().done >= 2)
    expect(svc.getStatus().jobId).toBe('job1') // the id is known even though the handler started synchronously
    svc.cancel()
    await waitFor(() => !svc.getStatus().running)
    expect(svc.getStatus().message).toMatch(/cancelled/)
    const indexed = repo.counts().indexed
    expect(indexed).toBeGreaterThan(1)
    expect(indexed).toBeLessThan(30)
    // Something else (a change event caused by our own reads, the periodic timer) must not undo the cancel.
    svc.enqueue([rootId], { auto: true })
    await new Promise((r) => setTimeout(r, 200))
    expect(jobs).toHaveLength(1)
    expect(repo.counts().indexed).toBe(indexed)
    // The user asking again resumes where it stopped.
    svc.enqueue([rootId])
    await waitFor(() => repo.counts().indexed === 30, 30_000)
    expect(jobs).toHaveLength(2)
    svc.dispose()
  })

  it('notices a file added, changed and deleted while watching (debounced) and tells the windows', async () => {
    const { svc, events, jobs } = makeService()
    svc.refreshWatchers()
    if (!svc.isWatching(rootId)) {
      svc.dispose()
      return // this platform/filesystem cannot watch recursively: the periodic rescan covers it
    }
    writeFileSync(join(dir, 'new.pdf'), await makeTextPdf(['brand new words']))
    await waitFor(() => repo.counts().indexed === 1)
    expect(repo.search({ query: 'brand', scope: { kind: 'all' }, offset: 0, limit: 5 })).toMatchObject({ total: 1 })
    await waitFor(() => events.some((e) => e.channel === 'library:changed'))

    writeFileSync(join(dir, 'new.pdf'), await makeTextPdf(['completely different words']))
    await waitFor(() => (repo.search({ query: 'different', scope: { kind: 'all' }, offset: 0, limit: 5 }) as { total: number }).total === 1)
    expect(repo.search({ query: 'brand', scope: { kind: 'all' }, offset: 0, limit: 5 })).toMatchObject({ total: 0 })

    unlinkSync(join(dir, 'new.pdf'))
    await waitFor(() => repo.counts().all === 0)
    // A burst of changes is one sync, not one per event.
    const before = jobs.length
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `burst${i}.pdf`), await makeTextPdf([`burst ${i}`]))
    await waitFor(() => repo.counts().indexed === 5)
    expect(jobs.length - before).toBeLessThanOrEqual(3)
    // Non-PDF changes do not trigger anything.
    const n = jobs.length
    writeFileSync(join(dir, 'notes.txt'), 'x')
    await new Promise((r) => setTimeout(r, 400))
    expect(jobs.length).toBe(n)
    svc.dispose()
  })

  it('stops watching a removed folder, and does not watch when watching is switched off', async () => {
    const { svc } = makeService()
    svc.refreshWatchers()
    svc.setSettings({ watch: false })
    expect(svc.isWatching(rootId)).toBe(false)
    svc.setSettings({ watch: true })
    await svc.removeRoot(rootId)
    expect(svc.isWatching(rootId)).toBe(false)
    expect(repo.listRoots()).toEqual([])
    svc.dispose()
  })

  it('persists settings in the per-feature key-value store and merges with defaults', () => {
    const { svc } = makeService()
    expect(svc.settings()).toEqual(DEFAULT_LIBRARY_SETTINGS)
    svc.setSettings({ maxFileMb: 50, watch: false })
    expect(svc.settings()).toEqual({ ...DEFAULT_LIBRARY_SETTINGS, maxFileMb: 50, watch: false })
    expect(new FeatureKv(db, 'library').get('settings', null)).toMatchObject({ maxFileMb: 50 })
    svc.dispose()
  })

  it('state() bundles folders, collections, counts, status and settings', () => {
    const { svc } = makeService()
    repo.ensureCollectionPath('A')
    const s = svc.state()
    expect(s.roots).toHaveLength(1)
    expect(s.collections).toHaveLength(1)
    expect(s.fts).toBe(true)
    expect(s.counts.all).toBe(0)
    svc.dispose()
  })

  it('a failing job start leaves the service usable', () => {
    const { svc } = makeService({
      startJob: () => {
        throw new Error('nope')
      }
    })
    svc.enqueue([rootId])
    expect(svc.getStatus().running).toBe(false)
    expect(svc.getStatus().message).toMatch(/Could not start/)
    svc.dispose()
  })
})

describe('thumbnails cache', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])

  it('stores a PNG per file, serves it while the file is unchanged, and drops it when the file changes', async () => {
    const { svc, ports } = makeService()
    const id = fileRow(join(dir, 'a.pdf'), 'a.pdf')
    expect(await svc.readThumbs([id])).toEqual({})
    expect(await svc.saveThumb(id, PNG, 7)).toBe(true)
    const got = await svc.readThumbs([id])
    expect(got[`f${id}`]).toMatch(/^data:image\/png;base64,/)
    expect(repo.getFile(id)!.pages).toBe(7) // learned the page count from the renderer
    // file changed -> stale
    db.prepare('UPDATE library_files SET size = 999 WHERE id = ?').run(id)
    expect(await svc.readThumbs([id])).toEqual({})
    expect(repo.getFile(id)!.thumbKey).toBeNull()
    await svc.saveThumb(id, PNG)
    await svc.removeThumbs([id])
    expect(await svc.readThumbs([id])).toEqual({})
    rmSync(ports.thumbsDir, { recursive: true, force: true })
    svc.dispose()
  })

  it('rejects anything that is not a small PNG', async () => {
    const { svc, ports } = makeService()
    const id = fileRow(join(dir, 'a.pdf'), 'a.pdf')
    await expect(svc.saveThumb(id, new Uint8Array(20))).rejects.toThrow(/not a PNG/)
    await expect(svc.saveThumb(id, new Uint8Array(0))).rejects.toThrow(/too large/)
    await expect(svc.saveThumb(id, new Uint8Array(500_000))).rejects.toThrow(/too large/)
    expect(await svc.saveThumb(99999, PNG)).toBe(false)
    expect(existsSync(ports.thumbsDir) ? readdirSync(ports.thumbsDir) : []).toEqual([])
    svc.dispose()
  })

  it('forgetting everything also deletes the cached pictures', async () => {
    const { svc, ports } = makeService()
    const id = fileRow(join(dir, 'a.pdf'), 'a.pdf')
    await svc.saveThumb(id, PNG)
    expect(readdirSync(ports.thumbsDir)).toHaveLength(1)
    await svc.forget(false)
    expect(existsSync(ports.thumbsDir)).toBe(false)
    expect(repo.counts().all).toBe(0)
    svc.dispose()
  })
})
