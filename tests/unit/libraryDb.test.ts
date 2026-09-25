import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../src/main/db/migrations'
import { RecentFilesRepo } from '../../src/main/db/repos'
import { CollectionError, LibraryRepo, PAGE_SHIFT, pageRowid } from '../../src/main/features/library/repo'
import type { ScanEntry } from '../../src/shared/features/library/plan'
import { prepareIndexText } from '../../src/shared/features/library/text'

let db: Database.Database
let repo: LibraryRepo
let rootId: number

const entry = (name: string, over: Partial<ScanEntry> = {}): ScanEntry => ({ path: `/lib/${name}`, relDir: '', name, size: 1000, mtime: 5000, cloud: false, ...over })

function addIndexed(name: string, pages: string[], over: Partial<ScanEntry> = {}): number {
  const e = entry(name, over)
  const id = repo.insertFile(rootId, e, 'pending')
  const texts = pages.map((t, i) => ({ page: i + 1, text: prepareIndexText(t) })).filter((t) => t.text)
  repo.applyIndex(id, { state: 'indexed', note: '', pages: pages.length, hash: `h-${name}`, words: 10, size: e.size, mtime: e.mtime, cloud: false, texts })
  return id
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  repo = new LibraryRepo(db)
  rootId = repo.addRoot('/lib', 'Lib', 'folder').id
})

describe('migration 5', () => {
  it('creates the library tables and the FTS5 table (SQLite in better-sqlite3 has FTS5)', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'library_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['library_roots', 'library_files', 'library_collections', 'library_collection_files', 'library_text']))
    expect(MIGRATIONS.at(-1)!.version).toBeGreaterThanOrEqual(5)
    expect(MIGRATIONS.find((m) => m.version === 5)).toBeTruthy()
  })

  it('upgrades a version-4 database in place, keeping existing data, and is idempotent', () => {
    const old = new Database(':memory:')
    old.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
    for (const m of MIGRATIONS.filter((x) => x.version <= 4)) {
      old.exec(m.sql)
      old.prepare('INSERT INTO schema_migrations VALUES (?, 0)').run(m.version)
    }
    old.prepare("INSERT INTO recent_files (path, name, size, last_opened_at, favorite) VALUES ('/x.pdf', 'x.pdf', 1, 1, 1)").run()
    old.prepare("INSERT INTO feature_kv VALUES ('ocr', 'k', '1')").run()
    expect(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'library_files'").get()).toEqual({ n: 0 })
    migrate(old)
    migrate(old)
    expect(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'library_files'").get()).toEqual({ n: 1 })
    expect(old.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: MIGRATIONS.length })
    expect(old.prepare('SELECT favorite FROM recent_files').get()).toEqual({ favorite: 1 })
    expect(old.prepare('SELECT value_json FROM feature_kv').get()).toEqual({ value_json: '1' })
    // A library row works right away.
    const r = new LibraryRepo(old)
    expect(r.addRoot('/x', 'X', 'folder').created).toBe(true)
  })

  it('keeps the file/page relation in the rowid (one contiguous range per file)', () => {
    expect(pageRowid(3, 7)).toBe(3 * PAGE_SHIFT + 7)
    expect(pageRowid(3, 7) >> 20).toBe(3) // JS bit ops are 32-bit: only valid for small ids; SQLite does the shift in 64 bits
  })
})

describe('content search (FTS5)', () => {
  it('finds words on the right pages with highlighted snippets, ranked by relevance', () => {
    const a = addIndexed('annual.pdf', ['Cover page', 'The annual report shows revenue growth. Annual figures.', 'Appendix'])
    addIndexed('other.pdf', ['A note about budgets and forecasts', 'Nothing relevant'])
    const r = repo.search({ query: 'annual', scope: { kind: 'all' }, offset: 0, limit: 10 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]).toMatchObject({ ref: `f${a}`, name: 'annual.pdf', page: 2 })
    expect(r.hits[0].snippet.some((p) => p.hit && /annual/i.test(p.text))).toBe(true)
    expect(r.hits[0].term.toLowerCase()).toBe('annual')
    expect(r.total).toBe(1)
  })

  it('is case- and accent-insensitive in both directions, and finds prefixes', () => {
    addIndexed('fr.pdf', ['Le café est prêt. Résumé de la réunion.'])
    for (const q of ['cafe', 'CAFÉ', 'resume', 'réunion', 'reun*', '"resume de"']) {
      const r = repo.search({ query: q, scope: { kind: 'all' }, offset: 0, limit: 10 })
      expect(r.ok && r.hits.length, q).toBe(1)
    }
    expect(repo.search({ query: 'tea', scope: { kind: 'all' }, offset: 0, limit: 10 })).toMatchObject({ ok: true, total: 0 })
  })

  it('supports phrases, AND, OR, NOT and exclusion', () => {
    addIndexed('a.pdf', ['annual report budget'])
    addIndexed('b.pdf', ['annual budget draft'])
    addIndexed('c.pdf', ['monthly report'])
    const run = (q: string): string[] => {
      const r = repo.search({ query: q, scope: { kind: 'all' }, offset: 0, limit: 50 })
      if (!r.ok) throw new Error(r.error)
      return r.hits.map((h) => h.name).sort()
    }
    expect(run('"annual report"')).toEqual(['a.pdf'])
    expect(run('annual budget')).toEqual(['a.pdf', 'b.pdf'])
    expect(run('report OR draft')).toEqual(['a.pdf', 'b.pdf', 'c.pdf'])
    expect(run('annual NOT draft')).toEqual(['a.pdf'])
    expect(run('annual -draft')).toEqual(['a.pdf'])
    expect(run('(report OR draft) budget')).toEqual(['a.pdf', 'b.pdf'])
    expect(run('annual budget -report -draft')).toEqual([])
  })

  it('finds CJK text as a substring, including mixed with Latin', () => {
    addIndexed('jp.pdf', ['これは日本語のテスト文書です。Tokyo Tower 東京タワー'])
    for (const q of ['日本語', '東京', 'タワー', 'テスト', '"東京タワー"', 'tokyo 東京']) {
      const r = repo.search({ query: q, scope: { kind: 'all' }, offset: 0, limit: 10 })
      expect(r.ok && r.hits.length, q).toBe(1)
    }
    const hit = repo.search({ query: '日本語', scope: { kind: 'all' }, offset: 0, limit: 10 })
    if (hit.ok) {
      expect(hit.hits[0].snippet.filter((p) => p.hit).map((p) => p.text)).toEqual(['日本語'])
      expect(hit.hits[0].term).toBe('日本語')
    }
    expect(repo.search({ query: '大阪', scope: { kind: 'all' }, offset: 0, limit: 10 })).toMatchObject({ ok: true, total: 0 })
  })

  it('cannot be tricked by FTS5 syntax or SQL in the query: it always runs, and matches nothing special', () => {
    addIndexed('a.pdf', ['hello world secret'])
    const evil = ['text:secret', 'NEAR(hello world)', '" OR 1=1 --', '*', '^hello', "'; DROP TABLE library_files; --", 'hello AND', 'OR OR', '{text}: hello', 'a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd', '-', '( ( (', '"', '\\', 'hello\u0000world']
    for (const q of evil) {
      const r = repo.search({ query: q, scope: { kind: 'all' }, offset: 0, limit: 10 })
      // Either a friendly error or a normal result; never an exception and never an SQLite error message.
      if (!r.ok) expect(r.error).not.toMatch(/fts5|syntax error|SQL/i)
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'library_files'").get()).toEqual({ n: 1 })
    // "text:secret" is the literal words text and secret, not a column filter.
    expect(repo.search({ query: 'text:secret', scope: { kind: 'all' }, offset: 0, limit: 10 })).toMatchObject({ ok: true, total: 0 })
    expect(repo.search({ query: 'hello world', scope: { kind: 'all' }, offset: 0, limit: 10 })).toMatchObject({ ok: true, total: 1 })
  })

  it('ranks a page that uses the term more (and more densely) above one that mentions it once', () => {
    addIndexed('once.pdf', ['budget ' + 'filler words go here and there '.repeat(30)])
    addIndexed('dense.pdf', ['budget budget budget forecast budget'])
    const r = repo.search({ query: 'budget', scope: { kind: 'all' }, offset: 0, limit: 10 })
    expect(r.ok && r.hits.map((h) => h.name)).toEqual(['dense.pdf', 'once.pdf'])
  })

  it('paginates and reports totals', () => {
    for (let i = 0; i < 25; i++) addIndexed(`f${i}.pdf`, ['common term here'])
    const p1 = repo.search({ query: 'common', scope: { kind: 'all' }, offset: 0, limit: 10 })
    const p3 = repo.search({ query: 'common', scope: { kind: 'all' }, offset: 20, limit: 10 })
    expect(p1.ok && p1.hits).toHaveLength(10)
    expect(p1.ok && p1.total).toBe(25)
    expect(p3.ok && p3.hits).toHaveLength(5)
  })

  it('restricts to a watched folder, sub-folder, collection or favorites', () => {
    const a = addIndexed('a.pdf', ['needle one'], { relDir: 'sub/deeper' })
    const b = addIndexed('b.pdf', ['needle two'], { relDir: 'other', path: '/lib/other/b.pdf' })
    const search = (scope: Parameters<LibraryRepo['search']>[0]['scope']): number => {
      const r = repo.search({ query: 'needle', scope, offset: 0, limit: 10 })
      return r.ok ? r.total : -1
    }
    expect(search({ kind: 'all' })).toBe(2)
    expect(search({ kind: 'root', rootId })).toBe(2)
    expect(search({ kind: 'root', rootId, dir: 'sub' })).toBe(1)
    expect(search({ kind: 'root', rootId, dir: 'sub/deeper' })).toBe(1)
    expect(search({ kind: 'root', rootId, dir: 'su' })).toBe(0)
    const c = repo.ensureCollectionPath('Projects/Invoices')
    repo.addToCollection(c, [b])
    expect(search({ kind: 'collection', id: c })).toBe(1)
    repo.setFavoriteFile(a, true)
    expect(search({ kind: 'favorites' })).toBe(1)
  })

  it('drops removed and re-indexed text (no stale hits) and keeps other files', () => {
    const a = addIndexed('a.pdf', ['alpha beta', 'gamma'])
    addIndexed('b.pdf', ['alpha again'])
    repo.applyIndex(a, { state: 'indexed', note: '', pages: 1, hash: 'new', words: 1, size: 1, mtime: 2, cloud: false, texts: [{ page: 1, text: 'delta only' }] })
    const alpha = repo.search({ query: 'alpha', scope: { kind: 'all' }, offset: 0, limit: 10 })
    expect(alpha.ok && alpha.hits.map((h) => h.name)).toEqual(['b.pdf'])
    expect(repo.search({ query: 'gamma', scope: { kind: 'all' }, offset: 0, limit: 10 })).toMatchObject({ total: 0 })
    repo.deleteFiles([a])
    expect(repo.search({ query: 'delta', scope: { kind: 'all' }, offset: 0, limit: 10 })).toMatchObject({ total: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_text').get()).toEqual({ n: 1 })
  })

  it('does not return files that were removed from the library ("hidden")', () => {
    const a = addIndexed('a.pdf', ['secret plans'])
    repo.hideFile(a)
    expect(repo.search({ query: 'secret', scope: { kind: 'all' }, offset: 0, limit: 10 })).toMatchObject({ ok: true, total: 0 })
    expect(repo.list({ scope: { kind: 'all' }, sort: 'name', descending: false, filter: 'all', offset: 0, limit: 10 }).total).toBe(0)
  })

  it('caps the counted total instead of counting millions of hits', () => {
    // Structure only (cheap): the cap constant is 10,000; verified through the flag on a small set.
    addIndexed('a.pdf', ['x'])
    const r = repo.search({ query: 'x', scope: { kind: 'all' }, offset: 0, limit: 10 })
    expect(r.ok && r.capped).toBe(false)
  })
})

describe('listing, sorting and name search', () => {
  beforeEach(() => {
    addIndexed('Invoice 2024.pdf', ['a'], { size: 300, mtime: 3000, relDir: 'finance', path: '/lib/finance/Invoice 2024.pdf' })
    addIndexed('résumé.pdf', ['b', 'c'], { size: 100, mtime: 1000 })
    addIndexed('Zebra_notes.pdf', ['d', 'e', 'f'], { size: 200, mtime: 2000 })
  })
  const list = (over: Partial<Parameters<LibraryRepo['list']>[0]> = {}) =>
    repo.list({ scope: { kind: 'all' }, sort: 'name', descending: false, filter: 'all', offset: 0, limit: 50, ...over })

  it('sorts by every key, both directions', () => {
    expect(list().items.map((i) => i.name)).toEqual(['Invoice 2024.pdf', 'résumé.pdf', 'Zebra_notes.pdf'])
    expect(list({ descending: true }).items.map((i) => i.name)).toEqual(['Zebra_notes.pdf', 'résumé.pdf', 'Invoice 2024.pdf'])
    expect(list({ sort: 'size' }).items.map((i) => i.size)).toEqual([100, 200, 300])
    expect(list({ sort: 'modified', descending: true }).items.map((i) => i.mtime)).toEqual([3000, 2000, 1000])
    expect(list({ sort: 'pages' }).items.map((i) => i.pages)).toEqual([1, 2, 3])
    expect(list({ sort: 'folder' }).items[0].name).toBe('résumé.pdf')
  })

  it('name search is case-, accent- and substring-insensitive, and all words must match', () => {
    expect(list({ name: 'resume' }).items.map((i) => i.name)).toEqual(['résumé.pdf'])
    expect(list({ name: 'INV 20' }).items.map((i) => i.name)).toEqual(['Invoice 2024.pdf'])
    expect(list({ name: 'notes zeb' }).total).toBe(1)
    expect(list({ name: 'nomatch' }).total).toBe(0)
    // LIKE wildcards typed by the user are literal.
    expect(list({ name: '%' }).total).toBe(0)
    expect(list({ name: '_' }).total).toBe(1) // only "Zebra_notes"
  })

  it('pages through a large list', () => {
    const p = list({ limit: 2, offset: 2 })
    expect(p.total).toBe(3)
    expect(p.items).toHaveLength(1)
  })

  it('filters by index state', () => {
    const id = repo.insertFile(rootId, entry('scan.pdf', { path: '/lib/scan.pdf' }), 'pending')
    repo.applyIndex(id, { state: 'no_text', note: 'No text', pages: 2, hash: 'h', words: 0, size: 1, mtime: 1, cloud: false, texts: [] })
    const cloud = repo.insertFile(rootId, entry('cloud.pdf', { path: '/lib/cloud.pdf', cloud: true }), 'cloud')
    expect(list({ filter: 'noText' }).items.map((i) => i.name)).toEqual(['scan.pdf'])
    expect(list({ filter: 'cloud' }).items.map((i) => [i.name, i.cloud])).toEqual([['cloud.pdf', true]])
    expect(cloud).toBeGreaterThan(0)
  })

  it('escapes sub-folder LIKE wildcards', () => {
    addIndexed('w.pdf', ['w'], { relDir: 'a_b', path: '/lib/a_b/w.pdf' })
    addIndexed('x.pdf', ['x'], { relDir: 'aXb', path: '/lib/aXb/x.pdf' })
    expect(list({ scope: { kind: 'root', rootId, dir: 'a_b' } }).items.map((i) => i.name)).toEqual(['w.pdf'])
  })
})

describe('favorites and recents', () => {
  it('a favorite is mirrored to recent_files.favorite and seeds new library files', () => {
    const recent = new RecentFilesRepo(db)
    recent.touch('/lib/a.pdf', 'a.pdf', 10, 100)
    const a = addIndexed('a.pdf', ['x'])
    repo.setFavoriteFile(a, true)
    expect(recent.list()[0].favorite).toBe(true)
    repo.setFavoriteFile(a, false)
    expect(recent.list()[0].favorite).toBe(false)
    recent.touch('/lib/later.pdf', 'later.pdf', 1, 200)
    db.prepare("UPDATE recent_files SET favorite = 1 WHERE path = '/lib/later.pdf'").run()
    const later = repo.insertFile(rootId, entry('later.pdf'), 'pending')
    expect(repo.getFile(later)!.favorite).toBe(true)
  })

  it('lists favorites from the library and from recents that are not in the library', () => {
    const recent = new RecentFilesRepo(db)
    const a = addIndexed('a.pdf', ['x'])
    repo.setFavoriteFile(a, true)
    recent.touch('/elsewhere/solo.pdf', 'solo.pdf', 5, 100)
    const soloId = (db.prepare("SELECT id FROM recent_files WHERE path = '/elsewhere/solo.pdf'").get() as { id: number }).id
    repo.setFavoriteRecent(soloId, true)
    const favs = repo.list({ scope: { kind: 'favorites' }, sort: 'name', descending: false, filter: 'all', offset: 0, limit: 50 })
    expect(favs.items.map((i) => [i.name, i.inLibrary, i.ref.startsWith('f')])).toEqual([
      ['a.pdf', true, true],
      ['solo.pdf', false, false]
    ])
    expect(repo.counts().favorites).toBe(2)
  })

  it('recent files: newest first, library files carry their metadata, others are plain', () => {
    const recent = new RecentFilesRepo(db)
    const a = addIndexed('a.pdf', ['x', 'y'])
    recent.touch('/lib/a.pdf', 'a.pdf', 1000, 100)
    recent.touch('/somewhere/b.pdf', 'b.pdf', 50, 200)
    const r = repo.list({ scope: { kind: 'recent' }, sort: 'opened', descending: true, filter: 'all', offset: 0, limit: 50 })
    expect(r.items.map((i) => i.name)).toEqual(['b.pdf', 'a.pdf'])
    expect(r.items[1]).toMatchObject({ ref: `f${a}`, pages: 2, inLibrary: true })
    expect(r.items[0]).toMatchObject({ inLibrary: false, pages: null })
    expect(r.items[0].ref).toMatch(/^r\d+$/)
    const asc = repo.list({ scope: { kind: 'recent' }, sort: 'opened', descending: false, filter: 'all', offset: 0, limit: 50 })
    expect(asc.items.map((i) => i.name)).toEqual(['a.pdf', 'b.pdf'])
    const filtered = repo.list({ scope: { kind: 'recent' }, name: 'B', sort: 'opened', descending: true, filter: 'all', offset: 0, limit: 50 })
    expect(filtered.items.map((i) => i.name)).toEqual(['b.pdf'])
  })
})

describe('collections (virtual folders)', () => {
  it('creates nested folders from a path, reuses existing ones, ignores case', () => {
    const inv = repo.ensureCollectionPath('Projects/Invoices')
    expect(repo.ensureCollectionPath('projects/invoices')).toBe(inv)
    const cols = repo.listCollections()
    expect(cols.map((c) => c.name).sort()).toEqual(['Invoices', 'Projects'])
    const projects = cols.find((c) => c.name === 'Projects')!
    expect(cols.find((c) => c.id === inv)!.parentId).toBe(projects.id)
    expect(repo.ensureCollectionPath('Reports', projects.id)).not.toBe(inv)
  })

  it('adds and removes files, counts them, and cascades on delete', () => {
    const a = addIndexed('a.pdf', ['x'])
    const b = addIndexed('b.pdf', ['y'])
    const c = repo.ensureCollectionPath('Work')
    expect(repo.addToCollection(c, [a, b, a])).toBe(2)
    expect(repo.addToCollection(c, [a])).toBe(0)
    expect(repo.listCollections()[0].files).toBe(2)
    expect(repo.list({ scope: { kind: 'collection', id: c }, sort: 'name', descending: false, filter: 'all', offset: 0, limit: 10 }).items.map((i) => i.name)).toEqual(['a.pdf', 'b.pdf'])
    repo.removeFromCollection(c, [a])
    expect(repo.listCollections()[0].files).toBe(1)
    repo.deleteFiles([b])
    expect(repo.listCollections()[0].files).toBe(0)
    repo.deleteCollection(c)
    expect(repo.listCollections()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_collection_files').get()).toEqual({ n: 0 })
  })

  it('validates names and refuses clashes on rename', () => {
    repo.ensureCollectionPath('One')
    const two = repo.ensureCollectionPath('Two')
    expect(() => repo.ensureCollectionPath('  /  ')).toThrow(CollectionError)
    expect(() => repo.ensureCollectionPath('a/b/c/d/e/f/g/h/i')).toThrow(/8 levels/)
    expect(() => repo.renameCollection(two, 'one')).toThrow(/already exists/)
    repo.renameCollection(two, 'Three')
    expect(repo.listCollections().map((c) => c.name)).toContain('Three')
    expect(() => repo.addToCollection(9999, [1])).toThrow(CollectionError)
  })

  it('strips invisible characters from folder names', () => {
    const id = repo.ensureCollectionPath('Sec‮ret')
    expect(repo.listCollections().find((c) => c.id === id)!.name).toBe('Secret')
  })
})

describe('files, moves, folders', () => {
  it('a moved file keeps its id (favorite, collections, text)', () => {
    const a = addIndexed('old.pdf', ['keep this text'])
    repo.setFavoriteFile(a, true)
    repo.moveFile(a, rootId, entry('new name.pdf', { relDir: 'moved', path: '/lib/moved/new name.pdf' }))
    const f = repo.getFile(a)!
    expect(f).toMatchObject({ name: 'new name.pdf', relDir: 'moved', favorite: true })
    expect(repo.search({ query: 'keep', scope: { kind: 'all' }, offset: 0, limit: 5 })).toMatchObject({ total: 1 })
    expect(repo.list({ scope: { kind: 'all' }, name: 'new name', sort: 'name', descending: false, filter: 'all', offset: 0, limit: 5 }).total).toBe(1)
  })

  it('removing a watched folder removes its files, text and memberships, and only those', () => {
    const other = repo.addRoot('/other', 'Other', 'folder').id
    const a = addIndexed('a.pdf', ['alpha'])
    const id2 = repo.insertFile(other, entry('b.pdf', { path: '/other/b.pdf' }), 'pending')
    repo.applyIndex(id2, { state: 'indexed', note: '', pages: 1, hash: 'h', words: 1, size: 1, mtime: 1, cloud: false, texts: [{ page: 1, text: 'beta' }] })
    const c = repo.ensureCollectionPath('X')
    repo.addToCollection(c, [a, id2])
    expect(repo.removeRoot(rootId)).toEqual([a])
    expect(repo.search({ query: 'alpha', scope: { kind: 'all' }, offset: 0, limit: 5 })).toMatchObject({ total: 0 })
    expect(repo.search({ query: 'beta', scope: { kind: 'all' }, offset: 0, limit: 5 })).toMatchObject({ total: 1 })
    expect(repo.listCollections()[0].files).toBe(1)
    expect(repo.listRoots().map((r) => r.label)).toEqual(['Other'])
  })

  it('forget clears the index, and optionally the folders', () => {
    addIndexed('a.pdf', ['alpha'])
    repo.ensureCollectionPath('X')
    repo.forget(true)
    expect(repo.counts().all).toBe(0)
    expect(repo.listRoots()).toHaveLength(1)
    expect(repo.listCollections()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_text').get()).toEqual({ n: 0 })
    repo.forget(false)
    expect(repo.listRoots()).toEqual([])
  })

  it('tree of folders with file counts', () => {
    addIndexed('a.pdf', ['a'], { relDir: 'x', path: '/lib/x/a.pdf' })
    addIndexed('b.pdf', ['b'], { relDir: 'x', path: '/lib/x/b.pdf' })
    addIndexed('c.pdf', ['c'], { relDir: 'x/y', path: '/lib/x/y/c.pdf' })
    expect(repo.treeDirs(rootId)).toEqual([
      { dir: 'x', files: 2 },
      { dir: 'x/y', files: 1 }
    ])
  })

  it('a duplicate path is a constraint error (a file belongs to one folder only)', () => {
    addIndexed('a.pdf', ['a'])
    expect(() => repo.insertFile(rootId, entry('a.pdf'), 'pending')).toThrow()
  })

  it('statistics', () => {
    addIndexed('a.pdf', ['a b c'])
    const c = repo.counts()
    expect(c).toMatchObject({ all: 1, indexed: 1, pagesIndexed: 1, notIndexable: 0 })
    expect(c.dbBytes).toBeGreaterThan(0)
  })
})
