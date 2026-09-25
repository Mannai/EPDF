import type Database from 'better-sqlite3'

/** Append-only. Never edit a shipped migration; add a new one. */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE recent_files (
        id             INTEGER PRIMARY KEY,
        path           TEXT NOT NULL UNIQUE,
        name           TEXT NOT NULL,
        size           INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER NOT NULL,
        open_count     INTEGER NOT NULL DEFAULT 1,
        last_page      INTEGER NOT NULL DEFAULT 1,
        favorite       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_recent_last_opened ON recent_files(last_opened_at DESC);

      CREATE TABLE session_tabs (
        window_id  INTEGER NOT NULL,
        position   INTEGER NOT NULL,
        doc_path   TEXT NOT NULL,
        page       INTEGER NOT NULL DEFAULT 1,
        zoom       REAL NOT NULL DEFAULT 1,
        zoom_mode  TEXT NOT NULL DEFAULT 'fit-width',
        view_mode  TEXT NOT NULL DEFAULT 'continuous',
        active     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (window_id, position)
      );

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `
      -- Autosaved copies of documents with unsaved edits (crash recovery). One per document path.
      CREATE TABLE recovery_files (
        doc_path      TEXT PRIMARY KEY,
        recovery_path TEXT NOT NULL,
        saved_at      INTEGER NOT NULL
      );

      -- Local version history: the on-disk file as it was before each explicit save.
      CREATE TABLE versions (
        id            INTEGER PRIMARY KEY,
        doc_path      TEXT NOT NULL,
        saved_at      INTEGER NOT NULL,
        snapshot_path TEXT NOT NULL,
        size          INTEGER NOT NULL,
        note          TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_versions_doc ON versions(doc_path, saved_at DESC);
    `
  },
  {
    version: 3,
    sql: `
      -- Saved visual signatures / initials. \`image\` is NEVER a plain PNG: it is the Electron safeStorage
      -- ciphertext of the base64-encoded PNG (see src/main/features/sign).
      CREATE TABLE signatures (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('signature', 'initials')),
        method     TEXT NOT NULL DEFAULT 'draw',
        width      INTEGER NOT NULL,
        height     INTEGER NOT NULL,
        image      BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 4,
    sql: `
      -- Small per-feature settings/state (see FeatureKv). Features use this instead of adding tables,
      -- so parallel features never fight over migration numbers.
      CREATE TABLE feature_kv (
        feature    TEXT NOT NULL,
        key        TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (feature, key)
      );
    `
  }
]

export function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version)
  )
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now())
    })()
  }
}
