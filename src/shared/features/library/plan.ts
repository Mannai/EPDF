import type { IndexState } from '../library'

/**
 * Bump when text extraction improves: every file is re-indexed once.
 * 2: Arabic tashkeel / letter variants folded in the index (library search ignores them, like the in-document search).
 */
export const INDEX_VERSION = 2

/** What the scanner found on disk for one PDF. */
export interface ScanEntry {
  path: string
  /** Folder relative to the watched folder, `/`-separated ('' for the top level). */
  relDir: string
  name: string
  size: number
  /** Whole milliseconds. */
  mtime: number
  /** Content not on this machine (see placeholder.ts). */
  cloud: boolean
}

/** What the database knows about a file of the folder being synced. */
export interface KnownFile {
  id: number
  path: string
  size: number
  mtime: number
  hash: string | null
  state: IndexState
  cloud: boolean
  indexVersion: number
  hidden: boolean
}

export type PlanReason = 'new' | 'changed' | 'retry' | 'hydrated' | 'limit' | 'forced'

export interface PlanItem {
  entry: ScanEntry
  known: KnownFile | null
  reason: PlanReason
}

export interface SyncPlan {
  /** Extract text (and hash) for these. */
  toIndex: PlanItem[]
  /** Record without reading the content: `cloud` (not downloaded) or `too_large` (over the size limit). */
  toRecord: (PlanItem & { state: 'cloud' | 'too_large' })[]
  /** Only the "content is in the cloud" flag changed (the file was downloaded or freed since). */
  toFlag: { known: KnownFile; cloud: boolean }[]
  unchanged: number
  /** In the database but not on disk any more (a moved file may match one of these by size + hash). */
  missing: KnownFile[]
}

export interface PlanOptions {
  maxBytes: number
  /** File ids the user asked to index regardless of the size limit. */
  forceIds?: ReadonlySet<number>
}

/**
 * Decides what a synchronisation must do. Pure: the same inputs always give the same plan.
 *
 *  - a path the database has never seen        -> new
 *  - same path, other size or modification time -> changed (the extractor then compares a quick hash and skips the
 *    expensive text extraction when only the timestamp moved)
 *  - same size/mtime but still pending, indexed by an older extractor, or downloaded since -> retry / hydrated
 *  - files the user removed from the library (`hidden`) are left alone
 *  - cloud placeholders and oversized files are only recorded, never read
 */
export function planSync(entries: readonly ScanEntry[], known: readonly KnownFile[], opts: PlanOptions): SyncPlan {
  const byPath = new Map(known.map((k) => [k.path, k]))
  const seen = new Set<string>()
  const plan: SyncPlan = { toIndex: [], toRecord: [], toFlag: [], unchanged: 0, missing: [] }

  for (const entry of entries) {
    seen.add(entry.path)
    const k = byPath.get(entry.path) ?? null
    if (k?.hidden) {
      plan.unchanged++
      continue
    }
    const forced = !!k && !!opts.forceIds?.has(k.id)
    const tooLarge = entry.size > opts.maxBytes && !forced

    let reason: PlanReason | null = null
    if (!k) reason = 'new'
    else if (k.size !== entry.size || k.mtime !== entry.mtime) reason = 'changed'
    else if (forced && k.state === 'too_large') reason = 'forced'
    else if (k.state === 'cloud' && !entry.cloud) reason = 'hydrated'
    else if (k.state === 'too_large' && !tooLarge) reason = 'limit'
    else if (k.state === 'pending' || k.indexVersion < INDEX_VERSION) reason = 'retry'

    if (!reason) {
      if (k && k.cloud !== entry.cloud) plan.toFlag.push({ known: k, cloud: entry.cloud })
      else plan.unchanged++
      continue
    }
    if (entry.cloud) plan.toRecord.push({ entry, known: k, reason, state: 'cloud' })
    else if (tooLarge) plan.toRecord.push({ entry, known: k, reason, state: 'too_large' })
    else plan.toIndex.push({ entry, known: k, reason })
  }

  for (const k of known) if (!seen.has(k.path) && !k.hidden) plan.missing.push(k)
  return plan
}

/** True if `path` lies inside `root` (both absolute, same separator style). Case-insensitive on Windows/macOS. */
export function isInside(root: string, path: string, caseInsensitive: boolean): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
    return caseInsensitive ? s.toLowerCase() : s
  }
  const r = norm(root)
  const p = norm(path)
  return p === r || p.startsWith(`${r}/`)
}

/** `/`-separated path of `dir` relative to `root` ('' when they are the same). Assumes `dir` is inside `root`. */
export function relativeDir(root: string, dir: string): string {
  const r = root.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const d = dir.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  return d.length <= r.length ? '' : d.slice(r.length + 1)
}
