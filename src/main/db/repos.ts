import type Database from 'better-sqlite3'
import { DEFAULT_SETTINGS } from '../../shared/types'
import type { DocViewState, RecentFile, Settings, VersionInfo } from '../../shared/types'

const MAX_RECENT = 100
export const MAX_VERSIONS_PER_DOC = 20

/**
 * Small persistent key/value state scoped to one feature: `ctx.kv('ocr').set('languages', ['eng'])`.
 * Values are JSON. Reads of missing or corrupt values return the fallback. For large or relational data
 * (or anything needing an index), a feature owns real tables instead — coordinate the migration number.
 */
export class FeatureKv {
  constructor(
    private db: Database.Database,
    readonly feature: string
  ) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare('SELECT value_json FROM feature_kv WHERE feature = ? AND key = ?')
      .get(this.feature, key) as { value_json: string } | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return fallback
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO feature_kv (feature, key, value_json) VALUES (?, ?, ?)
         ON CONFLICT(feature, key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(this.feature, key, JSON.stringify(value))
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM feature_kv WHERE feature = ? AND key = ?').run(this.feature, key)
  }

  keys(): string[] {
    return (this.db.prepare('SELECT key FROM feature_kv WHERE feature = ? ORDER BY key').all(this.feature) as { key: string }[]).map((r) => r.key)
  }
}

export class RecoveryRepo {
  constructor(private db: Database.Database) {}

  set(docPath: string, recoveryPath: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO recovery_files (doc_path, recovery_path, saved_at) VALUES (?, ?, ?)
         ON CONFLICT(doc_path) DO UPDATE SET recovery_path = excluded.recovery_path, saved_at = excluded.saved_at`
      )
      .run(docPath, recoveryPath, now)
  }

  get(docPath: string): { recoveryPath: string; savedAt: number } | null {
    const r = this.db.prepare('SELECT recovery_path, saved_at FROM recovery_files WHERE doc_path = ?').get(docPath) as
      | { recovery_path: string; saved_at: number }
      | undefined
    return r ? { recoveryPath: r.recovery_path, savedAt: r.saved_at } : null
  }

  remove(docPath: string): string | null {
    const cur = this.get(docPath)
    this.db.prepare('DELETE FROM recovery_files WHERE doc_path = ?').run(docPath)
    return cur?.recoveryPath ?? null
  }

  /** The documents whose record points to this recovery file (more than one only for names from before 1.1). */
  usersOf(recoveryPath: string): { docPath: string; savedAt: number }[] {
    const rows = this.db.prepare('SELECT doc_path, saved_at FROM recovery_files WHERE recovery_path = ?').all(recoveryPath) as { doc_path: string; saved_at: number }[]
    return rows.map((r) => ({ docPath: r.doc_path, savedAt: r.saved_at }))
  }

  all(): { docPath: string; recoveryPath: string; savedAt: number }[] {
    const rows = this.db.prepare('SELECT doc_path, recovery_path, saved_at FROM recovery_files ORDER BY saved_at DESC').all() as { doc_path: string; recovery_path: string; saved_at: number }[]
    return rows.map((r) => ({ docPath: r.doc_path, recoveryPath: r.recovery_path, savedAt: r.saved_at }))
  }

  allPaths(): string[] {
    return this.all().map((r) => r.recoveryPath)
  }
}

export interface VersionRow extends VersionInfo {
  docPath: string
  snapshotPath: string
}

export class VersionsRepo {
  constructor(private db: Database.Database) {}

  add(docPath: string, snapshotPath: string, size: number, note = '', now = Date.now()): number {
    return Number(
      this.db
        .prepare('INSERT INTO versions (doc_path, saved_at, snapshot_path, size, note) VALUES (?, ?, ?, ?, ?)')
        .run(docPath, now, snapshotPath, size, note).lastInsertRowid
    )
  }

  list(docPath: string): VersionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM versions WHERE doc_path = ? ORDER BY saved_at DESC, id DESC')
      .all(docPath) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as number,
      docPath: r.doc_path as string,
      savedAt: r.saved_at as number,
      snapshotPath: r.snapshot_path as string,
      size: r.size as number,
      note: r.note as string
    }))
  }

  get(id: number): VersionRow | null {
    const r = this.db.prepare('SELECT * FROM versions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r
      ? {
          id: r.id as number,
          docPath: r.doc_path as string,
          savedAt: r.saved_at as number,
          snapshotPath: r.snapshot_path as string,
          size: r.size as number,
          note: r.note as string
        }
      : null
  }

  /**
   * The versions of a document beyond the newest `keep`, oldest last. The caller deletes each snapshot file and only
   * then its record (`remove`), so a file that could not be deleted is never forgotten.
   */
  beyond(docPath: string, keep = MAX_VERSIONS_PER_DOC): VersionRow[] {
    return this.list(docPath).slice(keep)
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM versions WHERE id = ?').run(id)
  }

  /** Every document path that has versions. */
  docPaths(): string[] {
    return (this.db.prepare('SELECT DISTINCT doc_path FROM versions').all() as { doc_path: string }[]).map((r) => r.doc_path)
  }

  allSnapshotPaths(): string[] {
    return (this.db.prepare('SELECT snapshot_path FROM versions').all() as { snapshot_path: string }[]).map((r) => r.snapshot_path)
  }
}

export class RecentFilesRepo {
  constructor(private db: Database.Database) {}

  touch(path: string, name: string, size: number, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO recent_files (path, name, size, last_opened_at)
         VALUES (@path, @name, @size, @now)
         ON CONFLICT(path) DO UPDATE SET
           name = @name, size = @size, last_opened_at = @now, open_count = open_count + 1`
      )
      .run({ path, name, size, now })
    // Keep the table bounded, but never evict favorites.
    this.db
      .prepare(
        `DELETE FROM recent_files WHERE favorite = 0 AND id NOT IN (
           SELECT id FROM recent_files ORDER BY last_opened_at DESC LIMIT ?)`
      )
      .run(MAX_RECENT)
  }

  setLastPage(path: string, page: number): void {
    this.db.prepare('UPDATE recent_files SET last_page = ? WHERE path = ?').run(page, path)
  }

  list(limit = 20): RecentFile[] {
    const rows = this.db
      .prepare('SELECT * FROM recent_files ORDER BY last_opened_at DESC, id DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      path: r.path as string,
      name: r.name as string,
      size: r.size as number,
      lastOpenedAt: r.last_opened_at as number,
      openCount: r.open_count as number,
      lastPage: r.last_page as number,
      favorite: r.favorite === 1
    }))
  }

  getLastPage(path: string): number | null {
    const row = this.db.prepare('SELECT last_page FROM recent_files WHERE path = ?').get(path) as
      | { last_page: number }
      | undefined
    return row ? row.last_page : null
  }

  remove(path: string): void {
    this.db.prepare('DELETE FROM recent_files WHERE path = ?').run(path)
  }

  clear(): void {
    this.db.prepare('DELETE FROM recent_files WHERE favorite = 0').run()
  }
}

export interface SessionTab {
  path: string
  view: DocViewState
  active: boolean
}
export interface SessionWindow {
  tabs: SessionTab[]
}

export class SessionRepo {
  constructor(private db: Database.Database) {}

  /** Replaces the whole snapshot atomically. */
  save(windows: SessionWindow[]): void {
    const insert = this.db.prepare(
      `INSERT INTO session_tabs (window_id, position, doc_path, page, zoom, zoom_mode, view_mode, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_tabs').run()
      windows.forEach((w, wi) =>
        w.tabs.forEach((t, pos) =>
          insert.run(wi, pos, t.path, t.view.page, t.view.zoom, t.view.zoomMode, t.view.viewMode, t.active ? 1 : 0)
        )
      )
    })()
  }

  load(): SessionWindow[] {
    const rows = this.db
      .prepare('SELECT * FROM session_tabs ORDER BY window_id, position')
      .all() as Record<string, unknown>[]
    const byWindow = new Map<number, SessionWindow>()
    for (const r of rows) {
      const wid = r.window_id as number
      if (!byWindow.has(wid)) byWindow.set(wid, { tabs: [] })
      byWindow.get(wid)!.tabs.push({
        path: r.doc_path as string,
        active: r.active === 1,
        view: {
          page: r.page as number,
          zoom: r.zoom as number,
          zoomMode: r.zoom_mode as DocViewState['zoomMode'],
          viewMode: r.view_mode as DocViewState['viewMode']
        }
      })
    }
    return [...byWindow.values()]
  }
}

export class SettingsRepo {
  constructor(private db: Database.Database) {}

  getAll(): Settings {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[]
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    for (const r of rows) {
      if (r.key in DEFAULT_SETTINGS) {
        try {
          out[r.key] = JSON.parse(r.value_json)
        } catch {
          /* keep default on corrupt value */
        }
      }
    }
    return out as unknown as Settings
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.getAll()[key]
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(key, JSON.stringify(value))
  }

  /** Internal flags that are not exposed to the renderer (e.g. clean-exit marker). */
  getFlag(key: string): string | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(`_${key}`) as
      | { value_json: string }
      | undefined
    return row ? (JSON.parse(row.value_json) as string) : null
  }

  setFlag(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(`_${key}`, JSON.stringify(value))
  }
}
