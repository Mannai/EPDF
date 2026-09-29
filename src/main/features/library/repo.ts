import type Database from 'better-sqlite3'
import { dirname } from 'node:path'
import {
  INDEX_STATES,
  fileRef,
  recentRef,
  type ContentHit,
  type IndexState,
  type LibraryCollection,
  type LibraryCounts,
  type LibraryFilter,
  type LibraryItem,
  type LibraryRoot,
  type ListResult,
  type RootKind,
  type Scope,
  type SortKey
} from '../../../shared/features/library'
import { buildFtsQuery } from '../../../shared/features/library/query'
import { INDEX_VERSION, type KnownFile, type ScanEntry } from '../../../shared/features/library/plan'
import { MARK_END, MARK_START, highlightTerm, nameTokens, normalizeKey, parseSnippet, sanitizeDisplay } from '../../../shared/features/library/text'

/** rowid of a page in the FTS table: one contiguous range per file. */
export const PAGE_SHIFT = 1_048_576
export const pageRowid = (fileId: number, page: number): number => fileId * PAGE_SHIFT + page

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export interface FileRow {
  id: number
  rootId: number | null
  path: string
  relDir: string
  name: string
  size: number
  mtime: number
  pages: number | null
  hash: string | null
  state: IndexState
  cloud: boolean
  note: string
  indexVersion: number
  favorite: boolean
  hidden: boolean
  thumbKey: string | null
}

export interface IndexOutcome {
  state: IndexState
  note: string
  pages: number | null
  hash: string | null
  words: number
  size: number
  mtime: number
  cloud: boolean
  /** Page texts to store (already cleaned). Omit to leave the stored text untouched. */
  texts?: { page: number; text: string }[]
}

export class CollectionError extends Error {}

const mapFile = (r: Record<string, unknown>): FileRow => ({
  id: r.id as number,
  rootId: (r.root_id as number | null) ?? null,
  path: r.path as string,
  relDir: r.rel_dir as string,
  name: r.name as string,
  size: r.size as number,
  mtime: r.mtime as number,
  pages: (r.pages as number | null) ?? null,
  hash: (r.hash as string | null) ?? null,
  state: r.state as IndexState,
  cloud: r.cloud === 1,
  note: r.note as string,
  indexVersion: r.index_version as number,
  favorite: r.favorite === 1,
  hidden: r.hidden === 1,
  thumbKey: (r.thumb_key as string | null) ?? null
})

const ITEM_SELECT = `
  SELECT f.id AS fid, f.name AS name, f.name_key AS name_key, f.path AS path, f.size AS size, f.mtime AS mtime,
         f.pages AS pages, f.favorite AS favorite, f.state AS state, f.note AS note, f.cloud AS cloud,
         (f.thumb_key IS NOT NULL) AS thumb, rec.last_opened_at AS opened, ro.label AS root_label, f.added_at AS added
  FROM library_files f
  LEFT JOIN library_roots ro ON ro.id = f.root_id
  LEFT JOIN recent_files rec ON rec.path = f.path`

function toItem(r: Record<string, unknown>): LibraryItem {
  const state = (INDEX_STATES as readonly string[]).includes(r.state as string) ? (r.state as IndexState) : 'pending'
  return {
    ref: fileRef(r.fid as number),
    name: sanitizeDisplay(r.name as string, 260),
    dir: dirname(r.path as string),
    size: r.size as number,
    mtime: r.mtime as number,
    pages: (r.pages as number | null) ?? null,
    favorite: r.favorite === 1,
    state,
    note: sanitizeDisplay((r.note as string) ?? ''),
    cloud: r.cloud === 1 || state === 'cloud',
    hasThumb: r.thumb === 1,
    lastOpenedAt: (r.opened as number | null) ?? null,
    rootLabel: (r.root_label as string | null) ?? null,
    inLibrary: true
  }
}

function recentOnlyItem(r: Record<string, unknown>): LibraryItem {
  return {
    ref: recentRef(r.id as number),
    name: sanitizeDisplay(r.name as string, 260),
    dir: dirname(r.path as string),
    size: r.size as number,
    mtime: null,
    pages: null,
    favorite: r.favorite === 1,
    state: 'pending',
    note: '',
    cloud: false,
    hasThumb: false,
    lastOpenedAt: r.last_opened_at as number,
    rootLabel: null,
    inLibrary: false
  }
}

const cmp = (a: number | string | null, b: number | string | null): number => {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : 1
}

export function sortItems(items: LibraryItem[], sort: SortKey, descending: boolean): LibraryItem[] {
  const key = (i: LibraryItem): number | string | null => {
    switch (sort) {
      case 'name':
        return normalizeKey(i.name)
      case 'folder':
        return normalizeKey(i.dir)
      case 'size':
        return i.size
      case 'modified':
        return i.mtime
      case 'pages':
        return i.pages
      case 'opened':
        return i.lastOpenedAt
      case 'added':
        return i.mtime
    }
  }
  const dir = descending ? -1 : 1
  return [...items].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    // Missing values always sort last, whatever the direction.
    if (ka === null || kb === null) return cmp(ka, kb)
    return dir * cmp(ka, kb) || cmp(a.ref, b.ref)
  })
}

export function filterItems(items: LibraryItem[], name: string | undefined, filter: LibraryFilter): LibraryItem[] {
  const tokens = name ? nameTokens(name) : []
  return items.filter((i) => {
    if (tokens.length > 0) {
      const key = normalizeKey(i.name)
      if (!tokens.every((t) => key.includes(t))) return false
    }
    switch (filter) {
      case 'all':
        return true
      case 'cloud':
        return i.cloud
      case 'notIndexable':
        return i.state === 'unindexable'
      case 'noText':
        return i.state === 'no_text'
      case 'tooLarge':
        return i.state === 'too_large'
    }
  })
}

/** All SQL of the library. Pure database access: no file system, no Electron. */
export class LibraryRepo {
  private insertText: Database.Statement
  private deleteTextRange: Database.Statement

  constructor(readonly db: Database.Database) {
    this.insertText = db.prepare('INSERT INTO library_text (rowid, text) VALUES (?, ?)')
    this.deleteTextRange = db.prepare('DELETE FROM library_text WHERE rowid >= ? AND rowid < ?')
  }

  // ---- watched folders ------------------------------------------------------------------------------------------------

  addRoot(path: string, label: string, kind: RootKind, now = Date.now()): { id: number; created: boolean } {
    const existing = this.db.prepare('SELECT id FROM library_roots WHERE path = ?').get(path) as { id: number } | undefined
    if (existing) return { id: existing.id, created: false }
    const id = Number(this.db.prepare('INSERT INTO library_roots (path, label, kind, added_at) VALUES (?, ?, ?, ?)').run(path, label, kind, now).lastInsertRowid)
    return { id, created: true }
  }

  listRoots(): LibraryRoot[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM library_files f WHERE f.root_id = r.id AND f.hidden = 0) AS files,
                (SELECT COUNT(*) FROM library_files f WHERE f.root_id = r.id AND f.hidden = 0 AND f.state IN ('indexed', 'no_text')) AS indexed
         FROM library_roots r ORDER BY r.added_at, r.id`
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as number,
      path: r.path as string,
      label: r.label as string,
      kind: r.kind as RootKind,
      status: r.status as LibraryRoot['status'],
      note: r.note as string,
      lastScanAt: (r.last_scan_at as number | null) ?? null,
      files: r.files as number,
      indexed: r.indexed as number
    }))
  }

  getRoot(id: number): LibraryRoot | null {
    return this.listRoots().find((r) => r.id === id) ?? null
  }

  setRootScan(id: number, patch: { status: LibraryRoot['status']; note: string; at?: number }): void {
    this.db.prepare('UPDATE library_roots SET status = ?, note = ?, last_scan_at = COALESCE(?, last_scan_at) WHERE id = ?').run(patch.status, patch.note, patch.at ?? null, id)
  }

  /** Removes a watched folder with everything indexed from it. Returns the ids of the files that were removed. */
  removeRoot(id: number): number[] {
    const ids = (this.db.prepare('SELECT id FROM library_files WHERE root_id = ?').all(id) as { id: number }[]).map((r) => r.id)
    this.db.transaction(() => {
      for (const fid of ids) this.deleteText(fid)
      this.db.prepare('DELETE FROM library_files WHERE root_id = ?').run(id)
      this.db.prepare('DELETE FROM library_roots WHERE id = ?').run(id)
    })()
    return ids
  }

  /** "Forget everything": watched folders, files, text, library folders. Nothing on disk is touched. */
  forget(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM library_text').run()
      this.db.prepare('DELETE FROM library_collection_files').run()
      this.db.prepare('DELETE FROM library_files').run()
      this.db.prepare('DELETE FROM library_collections').run()
      this.db.prepare('DELETE FROM library_roots').run()
    })()
  }

  /**
   * After "Forget everything": rewrites the database file without the freed pages and empties the write-ahead log,
   * so no deleted page text is left in `epdf.db` or `epdf.db-wal`. (secure_delete already zeroes freed content; this
   * also drops the old copies the log still holds.)
   */
  compact(): void {
    this.db.exec('VACUUM')
    this.checkpoint()
  }

  /** Copies everything from the write-ahead log into the database and truncates the log. */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)')
  }

  /** Library rows for a path (ignoring case where the file system does). */
  filesByPath(path: string, caseInsensitive: boolean): FileRow[] {
    if (!caseInsensitive) {
      const f = this.getFileByPath(path)
      return f ? [f] : []
    }
    // SQLite's NOCASE folds ASCII only, so compare in JS (one pass over the paths; used rarely).
    const want = path.toLowerCase()
    const ids = (this.db.prepare('SELECT id, path FROM library_files').all() as { id: number; path: string }[]).filter((r) => r.path.toLowerCase() === want).map((r) => r.id)
    return ids.map((id) => this.getFile(id)).filter((f): f is FileRow => f !== null)
  }

  /**
   * Forgets what was read from a file (its page text, page count, hash, thumbnail key) and marks it pending, so a
   * watched folder reads it again on its next sync. Used after the file was redacted.
   */
  forgetContent(id: number): void {
    this.db.transaction(() => {
      this.deleteText(id)
      this.db
        .prepare("UPDATE library_files SET state = 'pending', hash = NULL, index_version = 0, note = '', pages = NULL, words = 0, thumb_key = NULL, indexed_at = NULL WHERE id = ?")
        .run(id)
    })()
  }

  /** "Rebuild index": drops all indexed text and marks every file to be read again; keeps favorites, folders, thumbnails. */
  rebuild(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM library_text').run()
      this.db.prepare("UPDATE library_files SET state = 'pending', hash = NULL, index_version = 0, note = '', pages = NULL, words = 0").run()
      this.db.prepare("UPDATE library_roots SET last_scan_at = NULL, note = ''").run()
    })()
  }

  // ---- files ----------------------------------------------------------------------------------------------------------

  knownFiles(rootId: number): KnownFile[] {
    const rows = this.db.prepare('SELECT id, path, size, mtime, hash, state, cloud, index_version, hidden FROM library_files WHERE root_id = ?').all(rootId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as number,
      path: r.path as string,
      size: r.size as number,
      mtime: r.mtime as number,
      hash: (r.hash as string | null) ?? null,
      state: r.state as IndexState,
      cloud: r.cloud === 1,
      indexVersion: r.index_version as number,
      hidden: r.hidden === 1
    }))
  }

  getFile(id: number): FileRow | null {
    const r = this.db.prepare('SELECT * FROM library_files WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? mapFile(r) : null
  }

  getFileByPath(path: string): FileRow | null {
    const r = this.db.prepare('SELECT * FROM library_files WHERE path = ?').get(path) as Record<string, unknown> | undefined
    return r ? mapFile(r) : null
  }

  insertFile(rootId: number | null, e: ScanEntry, state: IndexState, note = '', now = Date.now()): number {
    const fav = this.db.prepare('SELECT favorite FROM recent_files WHERE path = ?').get(e.path) as { favorite: number } | undefined
    return Number(
      this.db
        .prepare(
          `INSERT INTO library_files (root_id, path, rel_dir, name, name_key, size, mtime, state, cloud, note, favorite, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(rootId, e.path, e.relDir, e.name, normalizeKey(e.name), e.size, e.mtime, state, e.cloud ? 1 : 0, note, fav?.favorite === 1 ? 1 : 0, now).lastInsertRowid
    )
  }

  /** Stores the result of (re)indexing one file: replaces its page text and updates its row, atomically. */
  applyIndex(id: number, o: IndexOutcome, now = Date.now()): void {
    this.db.transaction(() => {
      if (o.texts) {
        this.deleteText(id)
        for (const t of o.texts) this.insertText.run(pageRowid(id, t.page), t.text)
      }
      this.db
        .prepare(
          `UPDATE library_files SET state = ?, note = ?, pages = ?, hash = ?, words = ?, size = ?, mtime = ?, cloud = ?,
             index_version = ?, indexed_at = ? WHERE id = ?`
        )
        .run(o.state, o.note, o.pages, o.hash, o.words, o.size, o.mtime, o.cloud ? 1 : 0, INDEX_VERSION, now, id)
    })()
  }

  /** Records a file whose content is not read (cloud placeholder / too large): drops stale text, keeps nothing else. */
  applyRecorded(id: number, e: ScanEntry, state: IndexState, note: string): void {
    this.db.transaction(() => {
      this.deleteText(id)
      this.db
        .prepare(
          `UPDATE library_files SET state = ?, note = ?, size = ?, mtime = ?, cloud = ?, pages = NULL, hash = NULL, words = 0,
             index_version = ?, thumb_key = NULL WHERE id = ?`
        )
        .run(state, note, e.size, e.mtime, e.cloud ? 1 : 0, INDEX_VERSION, id)
    })()
  }

  /** Timestamp moved but the content is the same: refresh the metadata only. */
  touchFile(id: number, size: number, mtime: number, cloud: boolean): void {
    this.db.prepare('UPDATE library_files SET size = ?, mtime = ?, cloud = ?, index_version = MAX(index_version, ?) WHERE id = ?').run(size, mtime, cloud ? 1 : 0, INDEX_VERSION, id)
  }

  setCloudFlag(id: number, cloud: boolean): void {
    this.db.prepare('UPDATE library_files SET cloud = ? WHERE id = ?').run(cloud ? 1 : 0, id)
  }

  /** A file was renamed or moved: keep its identity (favorite, collections, thumbnail, text). */
  moveFile(id: number, rootId: number | null, e: ScanEntry): void {
    this.db
      .prepare('UPDATE library_files SET root_id = ?, path = ?, rel_dir = ?, name = ?, name_key = ?, size = ?, mtime = ?, cloud = ? WHERE id = ?')
      .run(rootId, e.path, e.relDir, e.name, normalizeKey(e.name), e.size, e.mtime, e.cloud ? 1 : 0, id)
  }

  deleteText(fileId: number): void {
    this.deleteTextRange.run(fileId * PAGE_SHIFT, (fileId + 1) * PAGE_SHIFT)
  }

  deleteFiles(ids: number[]): void {
    this.db.transaction(() => {
      const del = this.db.prepare('DELETE FROM library_files WHERE id = ?')
      for (const id of ids) {
        this.deleteText(id)
        del.run(id)
      }
    })()
  }

  /** "Remove from library": hidden files stay in the table (so a rescan does not bring them back) but leave every list. */
  hideFile(id: number): void {
    this.db.transaction(() => {
      this.deleteText(id)
      this.db.prepare('DELETE FROM library_collection_files WHERE file_id = ?').run(id)
      this.db.prepare('UPDATE library_files SET hidden = 1, favorite = 0, thumb_key = NULL, pages = NULL, words = 0 WHERE id = ?').run(id)
    })()
  }

  setThumbKey(id: number, key: string | null, pages?: number): void {
    this.db.prepare('UPDATE library_files SET thumb_key = ?, pages = COALESCE(pages, ?) WHERE id = ?').run(key, pages ?? null, id)
  }

  thumbKeys(ids: number[]): Map<number, string> {
    const out = new Map<number, string>()
    const q = this.db.prepare('SELECT thumb_key FROM library_files WHERE id = ?')
    for (const id of ids) {
      const r = q.get(id) as { thumb_key: string | null } | undefined
      if (r?.thumb_key) out.set(id, r.thumb_key)
    }
    return out
  }

  // ---- favorites / recents --------------------------------------------------------------------------------------------

  /** Favorites live on the library file and are mirrored to `recent_files.favorite` (which recents/menus already know). */
  setFavoriteFile(id: number, value: boolean): void {
    const f = this.getFile(id)
    if (!f) return
    this.db.transaction(() => {
      this.db.prepare('UPDATE library_files SET favorite = ? WHERE id = ?').run(value ? 1 : 0, id)
      this.db.prepare('UPDATE recent_files SET favorite = ? WHERE path = ?').run(value ? 1 : 0, f.path)
    })()
  }

  setFavoriteRecent(id: number, value: boolean): void {
    this.db.transaction(() => {
      const r = this.db.prepare('SELECT path FROM recent_files WHERE id = ?').get(id) as { path: string } | undefined
      this.db.prepare('UPDATE recent_files SET favorite = ? WHERE id = ?').run(value ? 1 : 0, id)
      if (r) this.db.prepare('UPDATE library_files SET favorite = ? WHERE path = ?').run(value ? 1 : 0, r.path)
    })()
  }

  getRecent(id: number): { id: number; path: string; name: string } | null {
    return (this.db.prepare('SELECT id, path, name FROM recent_files WHERE id = ?').get(id) as { id: number; path: string; name: string } | undefined) ?? null
  }

  // ---- listing --------------------------------------------------------------------------------------------------------

  private scopeSql(scope: Scope): { where: string; args: unknown[] } {
    switch (scope.kind) {
      case 'root': {
        const dir = (scope.dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        if (!dir) return { where: 'f.root_id = ?', args: [scope.rootId] }
        return { where: "f.root_id = ? AND (f.rel_dir = ? OR f.rel_dir LIKE ? ESCAPE '\\')", args: [scope.rootId, dir, `${likeEscape(dir)}/%`] }
      }
      case 'collection':
        return { where: 'f.id IN (SELECT file_id FROM library_collection_files WHERE collection_id = ?)', args: [scope.id] }
      case 'favorites':
        return { where: 'f.favorite = 1', args: [] }
      case 'recent':
        return { where: 'f.path IN (SELECT path FROM recent_files)', args: [] }
      case 'all':
        return { where: '1 = 1', args: [] }
    }
  }

  /** One page of files for a scope, name filter, filter and sort. */
  list(req: { scope: Scope; name?: string; sort: SortKey; descending: boolean; filter: LibraryFilter; offset: number; limit: number }): ListResult {
    const { scope } = req
    // Recents (bounded by the recents table) and favorites merge library files with files that only exist in the
    // recents table, so they are assembled in memory; everything else is one indexed SQL query.
    if (scope.kind === 'recent' || scope.kind === 'favorites') {
      let items: LibraryItem[]
      if (scope.kind === 'recent') {
        const rows = this.db
          .prepare(
            `SELECT rec.id AS id, rec.path AS path, rec.name AS name, rec.size AS size, rec.last_opened_at, rec.favorite AS favorite, f.id AS fid,
                    f.name_key, f.mtime, f.pages, f.state, f.note, f.cloud, (f.thumb_key IS NOT NULL) AS thumb, ro.label AS root_label
             FROM recent_files rec
             LEFT JOIN library_files f ON f.path = rec.path AND f.hidden = 0
             LEFT JOIN library_roots ro ON ro.id = f.root_id
             ORDER BY rec.last_opened_at DESC, rec.id DESC LIMIT 200`
          )
          .all() as Record<string, unknown>[]
        items = rows.map((r) =>
          r.fid
            ? toItem({ ...r, name: r.name, opened: r.last_opened_at, favorite: r.favorite })
            : recentOnlyItem(r)
        )
      } else {
        const lib = this.db.prepare(`${ITEM_SELECT} WHERE f.hidden = 0 AND f.favorite = 1`).all() as Record<string, unknown>[]
        const only = this.db
          .prepare('SELECT rec.* FROM recent_files rec WHERE rec.favorite = 1 AND NOT EXISTS (SELECT 1 FROM library_files f WHERE f.path = rec.path AND f.hidden = 0)')
          .all() as Record<string, unknown>[]
        items = [...lib.map(toItem), ...only.map(recentOnlyItem)]
      }
      const filtered = filterItems(items, req.name, req.filter)
      // Recents default to "most recently opened first" unless the caller asks for another order.
      const sorted = scope.kind === 'recent' && req.sort === 'opened' ? (req.descending ? filtered : [...filtered].reverse()) : sortItems(filtered, req.sort, req.descending)
      return { items: sorted.slice(req.offset, req.offset + req.limit), total: sorted.length }
    }

    const { where, args } = this.scopeSql(scope)
    const conds = ['f.hidden = 0', where]
    const params: unknown[] = [...args]
    for (const t of req.name ? nameTokens(req.name) : []) {
      conds.push("f.name_key LIKE ? ESCAPE '\\'")
      params.push(`%${likeEscape(t)}%`)
    }
    switch (req.filter) {
      case 'cloud':
        conds.push("(f.cloud = 1 OR f.state = 'cloud')")
        break
      case 'notIndexable':
        conds.push("f.state = 'unindexable'")
        break
      case 'noText':
        conds.push("f.state = 'no_text'")
        break
      case 'tooLarge':
        conds.push("f.state = 'too_large'")
        break
      default:
    }
    const whereSql = conds.join(' AND ')
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM library_files f WHERE ${whereSql}`).get(...params) as { n: number }).n
    const col: Record<SortKey, string> = {
      name: 'f.name_key',
      folder: 'f.rel_dir, f.name_key',
      size: 'f.size',
      modified: 'f.mtime',
      pages: 'f.pages',
      added: 'f.added_at',
      opened: 'rec.last_opened_at'
    }
    const dir = req.descending ? 'DESC' : 'ASC'
    const first = col[req.sort].split(',')[0]
    const order = `(${first} IS NULL), ${col[req.sort]
      .split(',')
      .map((c) => `${c.trim()} ${dir}`)
      .join(', ')}, f.id`
    const rows = this.db.prepare(`${ITEM_SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, req.limit, req.offset) as Record<string, unknown>[]
    return { items: rows.map(toItem), total }
  }

  /** Every folder (relative path) of a watched folder that directly contains files, with counts. */
  treeDirs(rootId: number): { dir: string; files: number }[] {
    return this.db.prepare('SELECT rel_dir AS dir, COUNT(*) AS files FROM library_files WHERE root_id = ? AND hidden = 0 GROUP BY rel_dir ORDER BY rel_dir').all(rootId) as { dir: string; files: number }[]
  }

  itemsByIds(ids: number[]): Map<number, LibraryItem> {
    const out = new Map<number, LibraryItem>()
    const q = this.db.prepare(`${ITEM_SELECT} WHERE f.id = ?`)
    for (const id of ids) {
      const r = q.get(id) as Record<string, unknown> | undefined
      if (r) out.set(id, toItem(r))
    }
    return out
  }

  // ---- content search -------------------------------------------------------------------------------------------------

  /**
   * Full-text search: bm25-ranked pages with highlighted snippets. `query` is what the user typed (parsed by
   * `buildFtsQuery`, so nothing typed can alter the SQL or the shape of the FTS expression).
   */
  search(req: { query: string; scope: Scope; offset: number; limit: number }): { ok: true; hits: ContentHit[]; total: number; capped: boolean; terms: string[] } | { ok: false; error: string } {
    const built = buildFtsQuery(req.query)
    if (!built.ok) return built
    const { where, args } = this.scopeSql(req.scope)
    const from = `FROM library_text JOIN library_files f ON f.id = (library_text.rowid >> 20)
                  WHERE library_text MATCH ? AND f.hidden = 0 AND ${where}`
    const CAP = 10_000
    try {
      const rows = this.db
        .prepare(
          `SELECT library_text.rowid AS rid, snippet(library_text, 0, ?, ?, '…', 22) AS snip, f.id AS fid, f.name AS name, f.path AS path,
                  f.favorite AS favorite, f.cloud AS cloud ${from} ORDER BY rank LIMIT ? OFFSET ?`
        )
        .all(MARK_START, MARK_END, built.match, ...args, req.limit, req.offset) as Record<string, unknown>[]
      const countRow = this.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${from} LIMIT ${CAP + 1})`).get(built.match, ...args) as { n: number }
      const hits: ContentHit[] = rows.map((r) => {
        const snippet = parseSnippet(r.snip as string)
        const rid = r.rid as number
        return {
          ref: fileRef(r.fid as number),
          name: sanitizeDisplay(r.name as string, 260),
          dir: dirname(r.path as string),
          page: rid % PAGE_SHIFT,
          snippet,
          term: highlightTerm(snippet) || built.terms[0] || '',
          favorite: r.favorite === 1,
          cloud: r.cloud === 1
        }
      })
      return { ok: true, hits, total: Math.min(countRow.n, CAP), capped: countRow.n > CAP, terms: built.terms }
    } catch (err) {
      // The expression is generated, so this should not happen; never leak SQLite internals to the UI.
      return { ok: false, error: `That search could not be run (${(err as Error).message.replace(/\s+/g, ' ').slice(0, 100)}).` }
    }
  }

  // ---- collections ----------------------------------------------------------------------------------------------------

  listCollections(): LibraryCollection[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.parent_id, c.name, (SELECT COUNT(*) FROM library_collection_files m JOIN library_files f ON f.id = m.file_id
           WHERE m.collection_id = c.id AND f.hidden = 0) AS files FROM library_collections c ORDER BY c.name COLLATE NOCASE, c.id`
      )
      .all() as { id: number; parent_id: number | null; name: string; files: number }[]
    return rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, files: r.files }))
  }

  private cleanName(raw: string): string {
    const name = sanitizeDisplay(raw, 100).replace(/[\\/]/g, ' ').trim()
    if (!name) throw new CollectionError('Enter a name for the folder.')
    return name
  }

  /** Creates (or finds) a folder; "Projects/Invoices" creates both levels. Returns the innermost folder's id. */
  ensureCollectionPath(path: string, parentId: number | null = null, now = Date.now()): number {
    const segments = path.split(/[\\/]+/).map((s) => s.trim()).filter(Boolean)
    if (segments.length === 0) throw new CollectionError('Enter a name for the folder.')
    if (segments.length > 8) throw new CollectionError('Folders can be nested at most 8 levels deep.')
    let parent = parentId
    if (parent !== null && !this.db.prepare('SELECT 1 FROM library_collections WHERE id = ?').get(parent)) throw new CollectionError('That folder no longer exists.')
    return this.db.transaction(() => {
      for (const seg of segments) {
        const name = this.cleanName(seg)
        const found = this.db.prepare('SELECT id FROM library_collections WHERE COALESCE(parent_id, 0) = ? AND name = ? COLLATE NOCASE').get(parent ?? 0, name) as { id: number } | undefined
        parent = found ? found.id : Number(this.db.prepare('INSERT INTO library_collections (parent_id, name, created_at) VALUES (?, ?, ?)').run(parent, name, now).lastInsertRowid)
      }
      return parent!
    })()
  }

  renameCollection(id: number, raw: string): void {
    const name = this.cleanName(raw)
    const row = this.db.prepare('SELECT parent_id FROM library_collections WHERE id = ?').get(id) as { parent_id: number | null } | undefined
    if (!row) throw new CollectionError('That folder no longer exists.')
    const clash = this.db.prepare('SELECT id FROM library_collections WHERE COALESCE(parent_id, 0) = ? AND name = ? COLLATE NOCASE AND id <> ?').get(row.parent_id ?? 0, name, id)
    if (clash) throw new CollectionError(`A folder named “${name}” already exists here.`)
    this.db.prepare('UPDATE library_collections SET name = ? WHERE id = ?').run(name, id)
  }

  deleteCollection(id: number): void {
    this.db.prepare('DELETE FROM library_collections WHERE id = ?').run(id)
  }

  addToCollection(collectionId: number, fileIds: number[], now = Date.now()): number {
    if (!this.db.prepare('SELECT 1 FROM library_collections WHERE id = ?').get(collectionId)) throw new CollectionError('That folder no longer exists.')
    let added = 0
    this.db.transaction(() => {
      const ins = this.db.prepare(
        'INSERT OR IGNORE INTO library_collection_files (collection_id, file_id, added_at) SELECT ?, id, ? FROM library_files WHERE id = ? AND hidden = 0'
      )
      for (const id of fileIds) added += ins.run(collectionId, now, id).changes
    })()
    return added
  }

  removeFromCollection(collectionId: number, fileIds: number[]): void {
    const del = this.db.prepare('DELETE FROM library_collection_files WHERE collection_id = ? AND file_id = ?')
    this.db.transaction(() => fileIds.forEach((id) => del.run(collectionId, id)))()
  }

  // ---- statistics -----------------------------------------------------------------------------------------------------

  counts(): LibraryCounts {
    const q = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n
    const state = (s: IndexState): number => q(`SELECT COUNT(*) AS n FROM library_files WHERE hidden = 0 AND state = '${s}'`)
    const pageSize = this.db.pragma('page_size', { simple: true }) as number
    const pageCount = this.db.pragma('page_count', { simple: true }) as number
    return {
      all: q('SELECT COUNT(*) AS n FROM library_files WHERE hidden = 0'),
      recent: q('SELECT COUNT(*) AS n FROM recent_files'),
      favorites: q(
        `SELECT (SELECT COUNT(*) FROM library_files WHERE hidden = 0 AND favorite = 1)
              + (SELECT COUNT(*) FROM recent_files rec WHERE rec.favorite = 1 AND NOT EXISTS (SELECT 1 FROM library_files f WHERE f.path = rec.path AND f.hidden = 0)) AS n`
      ),
      indexed: state('indexed'),
      pagesIndexed: q("SELECT COALESCE(SUM(pages), 0) AS n FROM library_files WHERE hidden = 0 AND state = 'indexed'"),
      words: q('SELECT COALESCE(SUM(words), 0) AS n FROM library_files WHERE hidden = 0'),
      notIndexable: state('unindexable'),
      cloudOnly: q("SELECT COUNT(*) AS n FROM library_files WHERE hidden = 0 AND (cloud = 1 OR state = 'cloud')"),
      noText: state('no_text'),
      tooLarge: state('too_large'),
      pending: state('pending'),
      dbBytes: pageSize * pageCount
    }
  }
}
