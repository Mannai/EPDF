import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../src/main/db/migrations'
import { FeatureKv, RecentFilesRepo, RecoveryRepo, SessionRepo, SettingsRepo, VersionsRepo } from '../../src/main/db/repos'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
})

describe('migrations', () => {
  it('is idempotent and applies every migration exactly once', () => {
    migrate(db)
    migrate(db)
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }
    expect(rows.n).toBe(MIGRATIONS.length)
  })
  it('has strictly increasing, gap-free versions (append-only)', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1))
  })
})

describe('FeatureKv', () => {
  it('keeps each feature’s keys separate and round-trips JSON values', () => {
    const ocr = new FeatureKv(db, 'ocr')
    const scan = new FeatureKv(db, 'scan')
    ocr.set('languages', ['eng', 'deu'])
    scan.set('languages', 'not the same key')
    expect(ocr.get('languages', [])).toEqual(['eng', 'deu'])
    expect(scan.get('languages', '')).toBe('not the same key')
    ocr.set('languages', ['fra'])
    expect(ocr.get('languages', [])).toEqual(['fra'])
  })
  it('returns the fallback for missing keys and corrupt values, and can delete', () => {
    const kv = new FeatureKv(db, 'x')
    expect(kv.get('nope', 42)).toBe(42)
    db.prepare("INSERT INTO feature_kv VALUES ('x', 'bad', '{oops')").run()
    expect(kv.get('bad', 'fallback')).toBe('fallback')
    kv.set('a', 1)
    kv.set('b', 2)
    expect(kv.keys()).toEqual(['a', 'b', 'bad'])
    kv.delete('a')
    expect(kv.get('a', null)).toBeNull()
  })
})

describe('RecoveryRepo', () => {
  it('stores one recovery file per document and removes it', () => {
    const r = new RecoveryRepo(db)
    expect(r.get('/a.pdf')).toBeNull()
    r.set('/a.pdf', '/rec/1.pdf', 100)
    r.set('/a.pdf', '/rec/2.pdf', 200)
    expect(r.get('/a.pdf')).toEqual({ recoveryPath: '/rec/2.pdf', savedAt: 200 })
    expect(r.remove('/a.pdf')).toBe('/rec/2.pdf')
    expect(r.get('/a.pdf')).toBeNull()
    expect(r.remove('/a.pdf')).toBeNull()
  })
})

describe('VersionsRepo', () => {
  it('lists newest first and only for the requested document', () => {
    const v = new VersionsRepo(db)
    v.add('/a.pdf', '/v/1', 10, '', 100)
    v.add('/a.pdf', '/v/2', 20, '', 200)
    v.add('/b.pdf', '/v/3', 30, '', 300)
    expect(v.list('/a.pdf').map((x) => x.snapshotPath)).toEqual(['/v/2', '/v/1'])
    expect(v.list('/b.pdf')).toHaveLength(1)
  })
  it('lists the versions beyond the newest N without deleting them; records go one by one', () => {
    const v = new VersionsRepo(db)
    for (let i = 1; i <= 5; i++) v.add('/a.pdf', `/v/${i}`, i, '', i)
    v.add('/other.pdf', '/v/other', 1, '', 1)
    const old = v.beyond('/a.pdf', 2)
    expect(old.map((x) => x.snapshotPath)).toEqual(['/v/3', '/v/2', '/v/1'])
    expect(v.list('/a.pdf')).toHaveLength(5) // nothing is dropped until the caller has deleted the file
    for (const x of old) v.remove(x.id)
    expect(v.list('/a.pdf').map((x) => x.snapshotPath)).toEqual(['/v/5', '/v/4'])
    expect(v.list('/other.pdf')).toHaveLength(1)
    expect(v.docPaths().sort()).toEqual(['/a.pdf', '/other.pdf'])
    expect(v.allSnapshotPaths().sort()).toEqual(['/v/4', '/v/5', '/v/other'])
  })
})

describe('RecoveryRepo lookups', () => {
  it('finds every document that points to one recovery file', () => {
    const r = new RecoveryRepo(db)
    r.set('/a/Doc.pdf', '/rec/x.pdf', 100)
    r.set('/a/doc.pdf', '/rec/x.pdf', 200)
    r.set('/b.pdf', '/rec/y.pdf', 50)
    expect(r.usersOf('/rec/x.pdf')).toEqual(expect.arrayContaining([{ docPath: '/a/Doc.pdf', savedAt: 100 }, { docPath: '/a/doc.pdf', savedAt: 200 }]))
    expect(r.usersOf('/rec/none.pdf')).toEqual([])
    expect(r.allPaths().sort()).toEqual(['/rec/x.pdf', '/rec/x.pdf', '/rec/y.pdf'])
    expect(r.all()[0]).toEqual({ docPath: '/a/doc.pdf', recoveryPath: '/rec/x.pdf', savedAt: 200 })
  })
})

describe('RecentFilesRepo', () => {
  it('orders by most recent and counts re-opens', () => {
    const r = new RecentFilesRepo(db)
    r.touch('/a.pdf', 'a.pdf', 1, 100)
    r.touch('/b.pdf', 'b.pdf', 2, 200)
    r.touch('/a.pdf', 'a.pdf', 1, 300)
    const list = r.list()
    expect(list.map((x) => x.path)).toEqual(['/a.pdf', '/b.pdf'])
    expect(list[0].openCount).toBe(2)
  })
  it('remembers the last page and removes entries', () => {
    const r = new RecentFilesRepo(db)
    r.touch('/a.pdf', 'a.pdf', 1)
    expect(r.getLastPage('/a.pdf')).toBe(1)
    r.setLastPage('/a.pdf', 42)
    expect(r.getLastPage('/a.pdf')).toBe(42)
    expect(r.getLastPage('/missing.pdf')).toBeNull()
    r.remove('/a.pdf')
    expect(r.list()).toHaveLength(0)
  })
  it('bounds history to 100 entries', () => {
    const r = new RecentFilesRepo(db)
    for (let i = 0; i < 130; i++) r.touch(`/f${i}.pdf`, `f${i}.pdf`, 1, i)
    expect(r.list(1000)).toHaveLength(100)
    expect(r.list(1)[0].path).toBe('/f129.pdf')
  })
})

describe('SessionRepo', () => {
  const view = { page: 3, zoom: 1.5, zoomMode: 'custom', viewMode: 'two' } as const
  it('round-trips windows, tab order and the active tab', () => {
    const s = new SessionRepo(db)
    s.save([
      { tabs: [{ path: '/a.pdf', view, active: false }, { path: '/b.pdf', view, active: true }] },
      { tabs: [{ path: '/c.pdf', view, active: true }] }
    ])
    const loaded = s.load()
    expect(loaded).toHaveLength(2)
    expect(loaded[0].tabs.map((t) => t.path)).toEqual(['/a.pdf', '/b.pdf'])
    expect(loaded[0].tabs[1].active).toBe(true)
    expect(loaded[0].tabs[0].view).toEqual(view)
  })
  it('replaces the previous snapshot', () => {
    const s = new SessionRepo(db)
    s.save([{ tabs: [{ path: '/a.pdf', view, active: true }] }])
    s.save([])
    expect(s.load()).toEqual([])
  })
})

describe('SettingsRepo', () => {
  it('returns defaults, persists changes and ignores corrupt values', () => {
    const s = new SettingsRepo(db)
    expect(s.getAll()).toEqual(DEFAULT_SETTINGS)
    s.set('theme', 'dark')
    s.set('sidebarOpen', false)
    expect(s.get('theme')).toBe('dark')
    expect(s.get('sidebarOpen')).toBe(false)
    db.prepare("UPDATE settings SET value_json = '{oops' WHERE key = 'theme'").run()
    expect(s.get('theme')).toBe('system')
  })
  it('keeps internal flags out of the public settings object', () => {
    const s = new SettingsRepo(db)
    s.setFlag('cleanExit', '0')
    expect(s.getFlag('cleanExit')).toBe('0')
    expect(s.getAll()).toEqual(DEFAULT_SETTINGS)
  })
})
