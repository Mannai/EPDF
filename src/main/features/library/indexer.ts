import { stat } from 'node:fs/promises'
import { LIBRARY_LIMITS, type LibrarySettings } from '../../../shared/features/library'
import { INDEX_VERSION, planSync, type KnownFile, type PlanItem } from '../../../shared/features/library/plan'
import type { IndexEngine } from './engine'
import type { ExtractAssets, ExtractResult } from './extract'
import type { LibraryRepo } from './repo'

/**
 * Brings the database in line with the disk for one watched folder (scan -> plan -> record -> extract -> clean up).
 * The heavy work (walking the folder, reading PDFs) is done by the `IndexEngine`, which runs in a worker thread;
 * this function only decides and writes to SQLite, one file at a time, so cancelling loses nothing that was
 * finished, and the next run resumes with what is left (rows still `pending`).
 */

export interface SyncDeps {
  repo: LibraryRepo
  engine: IndexEngine
  settings: LibrarySettings
  assets: ExtractAssets
  /** Sleep between files so a big library does not monopolise a CPU core. Tests turn this off. */
  throttle?: boolean
  exists?: (path: string) => Promise<boolean>
  now?: () => number
}

export interface SyncProgress {
  phase: 'scanning' | 'indexing'
  done: number
  total: number
  message: string
}

export interface SyncSummary {
  rootOk: boolean
  scanned: number
  added: number
  changed: number
  removed: number
  moved: number
  indexed: number
  noText: number
  unindexable: number
  cloud: number
  tooLarge: number
  /** Files that could not be read or indexed. */
  problems: number
  cancelled: boolean
  note: string
}

export interface SyncOptions {
  signal: AbortSignal
  onProgress?: (p: SyncProgress) => void
  /** Called after each database change worth showing (rate-limited by the caller). */
  onChanged?: () => void
  /** Index these files even if they are over the size limit. */
  forceIds?: ReadonlySet<number>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const fileExists = (p: string): Promise<boolean> => stat(p).then(() => true, (e: NodeJS.ErrnoException) => e.code !== 'ENOENT' && e.code !== 'ENOTDIR')

export const CLOUD_NOTE = 'Stored in the cloud and not downloaded yet, so it is not indexed. Open it once to download it; it is indexed afterwards.'
export const tooLargeNote = (mb: number): string => `Larger than ${mb} MB, so it is not indexed. Use “Index anyway” to include it.`

const isCancel = (e: unknown): boolean => e instanceof Error && e.message === 'Cancelled'

export async function syncRoot(deps: SyncDeps, rootId: number, opts: SyncOptions): Promise<SyncSummary> {
  const { repo, engine, settings } = deps
  const now = deps.now ?? Date.now
  const exists = deps.exists ?? fileExists
  const summary: SyncSummary = { rootOk: true, scanned: 0, added: 0, changed: 0, removed: 0, moved: 0, indexed: 0, noText: 0, unindexable: 0, cloud: 0, tooLarge: 0, problems: 0, cancelled: false, note: '' }
  const root = repo.getRoot(rootId)
  if (!root) return { ...summary, rootOk: false, note: 'The folder is not in the library.' }
  const report = (p: SyncProgress): void => opts.onProgress?.(p)

  try {
    // 1. scan
    report({ phase: 'scanning', done: 0, total: 0, message: `Scanning ${root.label}` })
    const scan = await engine.scan(
      root.path,
      { maxDepth: settings.maxDepth, maxFiles: settings.maxFilesPerFolder },
      (found) => report({ phase: 'scanning', done: found, total: 0, message: `Scanning ${root.label}: ${found.toLocaleString('en-US')} PDFs found` }),
      opts.signal
    )
    if (!scan.rootOk) {
      repo.setRootScan(rootId, { status: 'missing', note: scan.rootError ?? 'The folder cannot be read.' })
      return { ...summary, rootOk: false, note: scan.rootError ?? '' }
    }
    summary.scanned = scan.entries.length
    summary.note = scan.note

    // 2. plan
    const known = repo.knownFiles(rootId)
    const plan = planSync(scan.entries, known, { maxBytes: settings.maxFileMb * 1024 * 1024, forceIds: opts.forceIds })
    let missing = [...plan.missing]

    // 3. moves: a "new" file with the same size and content hash as a missing one is that file, renamed or moved.
    const moved = new Set<number>()
    const newItems = plan.toIndex.filter((i) => !i.known)
    if (missing.length > 0 && newItems.length > 0) {
      const bySize = new Map<number, KnownFile[]>()
      for (const m of missing) if (m.hash) bySize.set(m.size, [...(bySize.get(m.size) ?? []), m])
      for (const item of newItems) {
        const candidates = bySize.get(item.entry.size)
        if (!candidates || item.entry.cloud) continue
        const h = await engine.hash(item.entry.path, opts.signal).catch((e) => (isCancel(e) ? Promise.reject(e) : null))
        const match = h ? candidates.find((c) => c.hash === h.hash && !moved.has(c.id)) : undefined
        if (!match) continue
        moved.add(match.id)
        repo.moveFile(match.id, rootId, item.entry)
        item.known = { ...match, path: item.entry.path, mtime: item.entry.mtime }
        summary.moved++
      }
      plan.toIndex = plan.toIndex.filter((i) => !(i.known && moved.has(i.known.id) && i.reason === 'new'))
      missing = missing.filter((m) => !moved.has(m.id))
    }

    // 4. record what cannot be read, insert the new files as `pending` so they show up at once
    repo.db.transaction(() => {
      for (const f of plan.toFlag) repo.setCloudFlag(f.known.id, f.cloud)
      for (const r of plan.toRecord) {
        const note = r.state === 'cloud' ? CLOUD_NOTE : tooLargeNote(settings.maxFileMb)
        try {
          if (r.known) repo.applyRecorded(r.known.id, r.entry, r.state, note)
          else {
            repo.insertFile(rootId, r.entry, r.state, note, now())
            summary.added++
          }
          if (r.state === 'cloud') summary.cloud++
          else summary.tooLarge++
        } catch {
          summary.problems++
        }
      }
      for (const item of plan.toIndex) {
        if (!item.known) {
          try {
            const id = repo.insertFile(rootId, item.entry, 'pending', '', now())
            item.known = { id, path: item.entry.path, size: item.entry.size, mtime: item.entry.mtime, hash: null, state: 'pending', cloud: false, indexVersion: 0, hidden: false }
            summary.added++
          } catch {
            summary.problems++ // e.g. the same file already belongs to another watched folder
          }
        } else summary.changed++
      }
    })()
    plan.toIndex = plan.toIndex.filter((i) => i.known)
    opts.onChanged?.()

    // 5. extract text, one file at a time
    const total = plan.toIndex.length
    let done = 0
    for (const item of plan.toIndex) {
      if (opts.signal.aborted) throw new Error('Cancelled')
      const started = Date.now()
      report({ phase: 'indexing', done, total, message: `Indexing ${done + 1} of ${total}: ${item.entry.name}` })
      const outcome = await indexOne(deps, item, opts.signal)
      switch (outcome) {
        case 'indexed':
          summary.indexed++
          break
        case 'no_text':
          summary.noText++
          break
        case 'unindexable':
          summary.unindexable++
          summary.problems++
          break
        case 'gone':
          missing.push(item.known!)
          break
        default:
      }
      done++
      if (done % 25 === 0) opts.onChanged?.()
      if (deps.throttle !== false) await sleep(Math.min(120, Math.round((Date.now() - started) * 0.35)))
    }

    // 6. forget files that are really gone (a stat, not just "the scan did not list it": a scan can be incomplete)
    const gone: number[] = []
    for (const m of missing) if (!(await exists(m.path))) gone.push(m.id)
    if (gone.length > 0) repo.deleteFiles(gone)
    summary.removed = gone.length

    repo.setRootScan(rootId, { status: 'ok', note: scan.note, at: now() })
    opts.onChanged?.()
  } catch (err) {
    if (isCancel(err) || opts.signal.aborted) {
      summary.cancelled = true
      opts.onChanged?.()
      return summary
    }
    repo.setRootScan(rootId, { status: 'unreadable', note: (err as Error).message.slice(0, 200) })
    summary.rootOk = false
    summary.note = (err as Error).message
  }
  return summary
}

type Outcome = 'indexed' | 'no_text' | 'unindexable' | 'unchanged' | 'gone'

/** Extracts and stores one file. Never throws except for cancellation. */
async function indexOne(deps: SyncDeps, item: PlanItem, signal: AbortSignal): Promise<Outcome> {
  const { repo } = deps
  const known = item.known!
  const canSkip = item.reason === 'changed' && !!known.hash && known.indexVersion === INDEX_VERSION && known.state !== 'pending' && known.state !== 'cloud' && known.state !== 'too_large'
  let result: ExtractResult
  try {
    result = await deps.engine.extract(
      { path: item.entry.path, knownHash: canSkip ? known.hash : null, maxPages: LIBRARY_LIMITS.maxPagesPerFile, assets: deps.assets },
      signal
    )
  } catch (err) {
    if (isCancel(err) || signal.aborted) throw new Error('Cancelled')
    result = { kind: 'unindexable', hash: null, size: item.entry.size, reason: `The text could not be read (${(err as Error).message.slice(0, 120)}).` }
  }
  const base = { size: item.entry.size, mtime: item.entry.mtime, cloud: false }
  switch (result.kind) {
    case 'missing':
      return 'gone'
    case 'unchanged':
      repo.touchFile(known.id, item.entry.size, item.entry.mtime, false)
      return 'unchanged'
    case 'unindexable':
      repo.applyIndex(known.id, { ...base, state: 'unindexable', note: result.reason, pages: null, hash: result.hash, words: 0, texts: [] })
      return 'unindexable'
    case 'no_text':
      repo.applyIndex(known.id, { ...base, state: 'no_text', note: result.note, pages: result.pages, hash: result.hash, words: 0, texts: [] })
      return 'no_text'
    case 'indexed':
      repo.applyIndex(known.id, { ...base, state: 'indexed', note: result.note, pages: result.pages, hash: result.hash, words: result.words, texts: result.texts })
      return 'indexed'
  }
}
