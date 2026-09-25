import { realpathSync, watch, type FSWatcher } from 'node:fs'
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_LIBRARY_SETTINGS,
  MAX_THUMB_BYTES,
  type LibrarySettings,
  type LibraryState,
  type LibraryStatus,
  type RootKind
} from '../../../shared/features/library'
import type { JobContext } from '../../jobs/JobManager'
import type { IndexEngine } from './engine'
import type { ExtractAssets } from './extract'
import { syncRoot, type SyncSummary } from './indexer'
import type { LibraryRepo } from './repo'

/** Small persistent settings store (`ctx.kv('library')`). */
export interface KvLike {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
}

export interface ServicePorts {
  /** Starts a `library:sync` job; returns its id. `owner` is the window whose job tray shows it. */
  startJob(payload: SyncJobPayload, owner?: number): string
  cancelJob(jobId: string): boolean
  emit(channel: 'library:changed' | 'library:status', payload: unknown): void
  kv: KvLike
  createEngine(): IndexEngine
  assets(): ExtractAssets
  thumbsDir: string
  /** Called for every debounced/periodic rescan trigger (tests use a short delay). */
  watchDebounceMs?: number
  rescanIntervalMs?: number
  /** Extra pause after every indexed file (test hook). */
  extraDelayMs?: number
}

export interface SyncJobPayload {
  rootIds: number[]
  force?: number[]
}

const IDLE: LibraryStatus = { running: false, jobId: null, phase: 'idle', rootLabel: null, done: 0, total: 0, message: '', problems: 0 }

/** Coordinates syncs (queue + job), folder watchers, settings, thumbnails. No Electron imports: testable. */
export class LibraryService {
  private status: LibraryStatus = { ...IDLE }
  private pending = new Set<number>()
  private force = new Set<number>()
  /** Folders whose indexing the user cancelled: only an explicit request (or a new session) resumes them. */
  private paused = new Set<number>()
  private currentRoots: number[] = []
  private owner: number | undefined
  private running = false
  private watchers = new Map<number, FSWatcher>()
  private debounce = new Map<number, NodeJS.Timeout>()
  private timer: NodeJS.Timeout | null = null
  private changedTimer: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private disposed = false
  /** Last summary of each folder's sync, for tests/diagnostics. */
  readonly lastSummary = new Map<number, SyncSummary>()

  constructor(
    readonly repo: LibraryRepo,
    private ports: ServicePorts
  ) {}

  // ---- settings -------------------------------------------------------------------------------------------------------

  settings(): LibrarySettings {
    const s = this.ports.kv.get<Partial<LibrarySettings>>('settings', {})
    return { ...DEFAULT_LIBRARY_SETTINGS, ...s }
  }

  setSettings(patch: Partial<LibrarySettings>): LibrarySettings {
    const next = { ...this.settings(), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as LibrarySettings
    this.ports.kv.set('settings', next)
    this.refreshWatchers()
    return next
  }

  // ---- state ----------------------------------------------------------------------------------------------------------

  state(): LibraryState {
    return {
      roots: this.repo.listRoots(),
      collections: this.repo.listCollections(),
      counts: this.repo.counts(),
      status: this.status,
      settings: this.settings(),
      fts: true,
      notice: this.watchGuardNote
    }
  }

  getStatus(): LibraryStatus {
    return this.status
  }

  // ---- folders --------------------------------------------------------------------------------------------------------

  addRoot(path: string, label: string, kind: RootKind, owner?: number): { id: number; created: boolean } {
    const r = this.repo.addRoot(path, label, kind)
    this.changed()
    if (r.created) this.enqueue([r.id], { owner })
    this.refreshWatchers()
    return r
  }

  async removeRoot(id: number): Promise<void> {
    this.pending.delete(id)
    this.unwatch(id)
    const ids = this.repo.removeRoot(id)
    await this.removeThumbs(ids)
    this.changed()
  }

  /** `rebuildOnly`: keep folders, favorites and library folders and just read everything again. */
  async forget(rebuildOnly: boolean): Promise<void> {
    this.cancel()
    this.pending.clear()
    if (rebuildOnly) {
      this.repo.rebuild()
    } else {
      this.repo.forget()
      await rm(this.ports.thumbsDir, { recursive: true, force: true }).catch(() => undefined)
      this.refreshWatchers()
    }
    this.changed(true)
    if (rebuildOnly) this.enqueue(this.repo.listRoots().map((r) => r.id))
  }

  // ---- syncing --------------------------------------------------------------------------------------------------------

  /**
   * Queues folders for a sync (all watched folders when `rootIds` is omitted). `auto` marks requests that nobody
   * asked for (file watcher, periodic rescan): they do not resume a folder whose indexing the user cancelled.
   * (Reading files can itself raise change events on Windows, so without this a cancel would be undone at once.)
   */
  enqueue(rootIds?: number[], opts: { force?: number[]; owner?: number; auto?: boolean } = {}): void {
    if (this.disposed) return
    let ids = rootIds ?? this.repo.listRoots().map((r) => r.id)
    if (opts.auto) ids = ids.filter((id) => !this.paused.has(id))
    else for (const id of ids) this.paused.delete(id)
    for (const id of ids) this.pending.add(id)
    for (const f of opts.force ?? []) this.force.add(f)
    if (opts.owner !== undefined) this.owner = opts.owner
    this.pump()
  }

  private pump(): void {
    if (this.running || this.pending.size === 0 || this.disposed) return
    const rootIds = [...this.pending]
    const force = [...this.force]
    this.pending.clear()
    this.force.clear()
    this.running = true
    this.status = { ...IDLE, running: true, phase: 'scanning', message: 'Starting…' }
    try {
      // The handler runs synchronously up to its first await and replaces `this.status`, so read the id first.
      const jobId = this.ports.startJob({ rootIds, force }, this.owner)
      this.status = { ...this.status, jobId }
    } catch (err) {
      this.running = false
      this.status = { ...IDLE, message: `Could not start indexing: ${(err as Error).message}` }
    }
    this.owner = undefined
    this.pushStatus(true)
  }

  cancel(): void {
    this.pending.clear()
    for (const id of this.currentRoots) this.paused.add(id)
    if (this.status.jobId) this.ports.cancelJob(this.status.jobId)
  }

  /** The `library:sync` job handler. */
  async runJob(payload: SyncJobPayload, job: JobContext): Promise<SyncSummary[]> {
    const engine = this.ports.createEngine()
    this.currentRoots = payload.rootIds
    const out: SyncSummary[] = []
    const force = new Set(payload.force ?? [])
    let problems = 0
    try {
      for (let i = 0; i < payload.rootIds.length; i++) {
        const rootId = payload.rootIds[i]
        const root = this.repo.getRoot(rootId)
        if (!root) continue
        const summary = await syncRoot(
          { repo: this.repo, engine, settings: this.settings(), assets: this.ports.assets(), throttle: true, extraDelayMs: this.ports.extraDelayMs },
          rootId,
          {
            signal: job.signal,
            forceIds: force,
            onChanged: () => this.changed(),
            onProgress: (p) => {
              const frac = p.phase === 'indexing' && p.total > 0 ? p.done / p.total : 0
              job.progress((i + frac) / payload.rootIds.length, p.message)
              this.status = { ...this.status, running: true, phase: p.phase, rootLabel: root.label, done: p.done, total: p.total, message: p.message, problems }
              this.pushStatus()
            }
          }
        )
        problems += summary.problems
        this.lastSummary.set(rootId, summary)
        out.push(summary)
        if (summary.cancelled) break
      }
      return out
    } finally {
      await engine.close().catch(() => undefined)
      const cancelled = job.signal.aborted
      this.currentRoots = []
      this.running = false
      this.status = {
        ...IDLE,
        problems,
        message: cancelled ? 'Indexing was cancelled. It will continue where it stopped the next time it runs.' : problems > 0 ? `Done. ${problems} file${problems === 1 ? '' : 's'} could not be indexed.` : 'Up to date.'
      }
      this.pushStatus(true)
      this.changed(true)
      this.pump()
    }
  }

  // ---- watching -------------------------------------------------------------------------------------------------------

  /** Starts the first sync and the change watchers. Called once at startup. */
  start(initialDelayMs = 1500): void {
    if (this.ports.kv.get<number>('watchGuard', 0) > 0) {
      // The previous run died right after creating file watchers: keep watching off until the user turns it on.
      this.ports.kv.set('watchGuard', 0)
      this.ports.kv.set('settings', { ...this.settings(), watch: false })
      this.watchGuardNote = 'Folder watching was switched off because the app stopped unexpectedly while starting it. Folders are still rescanned regularly; turn watching back on in the Library settings.'
    }
    setTimeout(() => this.enqueue(), initialDelayMs).unref()
    this.refreshWatchers()
    const every = this.ports.rescanIntervalMs ?? 10 * 60_000
    this.timer = setInterval(() => {
      if (this.settings().watch) this.enqueue(undefined, { auto: true })
    }, every)
    this.timer.unref()
  }

  private unwatch(id: number): void {
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
    clearTimeout(this.debounce.get(id))
    this.debounce.delete(id)
  }

  /** (Re)creates one recursive watcher per healthy folder; none when watching is switched off. */
  refreshWatchers(): void {
    const roots = this.repo.listRoots()
    const wanted = new Set(this.settings().watch ? roots.filter((r) => r.status !== 'missing').map((r) => r.id) : [])
    for (const id of [...this.watchers.keys()]) if (!wanted.has(id)) this.unwatch(id)
    if (this.watchGuardTripped) return
    for (const r of roots) {
      if (!wanted.has(r.id) || this.watchers.has(r.id)) continue
      try {
        // Always watch the canonical path: libuv on Windows aborts the whole process (an assertion, not an
        // exception) when the watched path is spelled differently from the one the OS reports (8.3 short names).
        const canonical = realpathSync.native(r.path)
        this.armGuard()
        const w = watch(canonical, { recursive: true, persistent: false }, (_evt, filename) => this.onFsEvent(r.id, filename))
        w.on('error', () => this.unwatch(r.id)) // e.g. the folder was deleted; the periodic rescan takes over
        this.watchers.set(r.id, w)
      } catch {
        /* recursive watching is unavailable here (network drive, old kernel): the periodic rescan covers it */
      }
    }
  }

  /**
   * Crash-loop breaker: a native crash inside the file watcher cannot be caught. The guard is written before
   * watchers are created and cleared a few seconds later (and on a normal quit); finding it set at startup means
   * the last run died right there, so watching is switched off (the periodic rescan still keeps the index fresh).
   */
  private watchGuardTripped = false
  /** Shown in the Library when watching was switched off by the crash-loop breaker. */
  watchGuardNote = ''
  private guardTimer: NodeJS.Timeout | null = null
  private armGuard(): void {
    if (this.guardTimer) return
    this.ports.kv.set('watchGuard', Date.now())
    this.guardTimer = setTimeout(() => {
      this.guardTimer = null
      this.ports.kv.set('watchGuard', 0)
    }, 5000)
    this.guardTimer.unref()
  }

  private onFsEvent(rootId: number, filename: string | Buffer | null): void {
    const name = filename ? filename.toString() : ''
    // Only PDFs (and folders, which have no extension) matter; skip office lock files and sync/editor temp files.
    if (name) {
      const base = name.split(/[\\/]/).pop() ?? ''
      if (base.startsWith('~$') || base.startsWith('.~lock')) return
      if (/\.[a-z0-9]{1,8}$/i.test(base) && !/\.(pdf|icloud)$/i.test(base)) return
    }
    clearTimeout(this.debounce.get(rootId))
    this.debounce.set(
      rootId,
      setTimeout(() => {
        this.debounce.delete(rootId)
        this.enqueue([rootId], { auto: true })
      }, this.ports.watchDebounceMs ?? 1500)
    )
  }

  /** Test/diagnostic helper: are watchers active for this folder? */
  isWatching(rootId: number): boolean {
    return this.watchers.has(rootId)
  }

  dispose(): void {
    this.disposed = true
    for (const id of [...this.watchers.keys()]) this.unwatch(id)
    if (this.guardTimer) {
      clearTimeout(this.guardTimer)
      this.guardTimer = null
    }
    try {
      if (this.ports.kv.get<number>('watchGuard', 0) > 0) this.ports.kv.set('watchGuard', 0)
    } catch {
      /* the database is already closed */
    }
    if (this.timer) clearInterval(this.timer)
    clearTimeout(this.changedTimer ?? undefined)
    clearTimeout(this.statusTimer ?? undefined)
    this.cancel()
  }

  // ---- events ---------------------------------------------------------------------------------------------------------

  /** Tells every window the library changed (coalesced to a few per second). */
  changed(immediate = false): void {
    if (this.disposed) return
    if (immediate) {
      clearTimeout(this.changedTimer ?? undefined)
      this.changedTimer = null
      this.ports.emit('library:changed', {})
      return
    }
    if (this.changedTimer) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      this.ports.emit('library:changed', {})
    }, 400)
  }

  private pushStatus(immediate = false): void {
    if (this.disposed) return
    if (immediate) {
      clearTimeout(this.statusTimer ?? undefined)
      this.statusTimer = null
      this.ports.emit('library:status', this.status)
      return
    }
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.ports.emit('library:status', this.status)
    }, 150)
  }

  // ---- thumbnails -----------------------------------------------------------------------------------------------------

  private thumbPath(id: number): string {
    return join(this.ports.thumbsDir, `${id}.png`)
  }

  private thumbKey(f: { size: number; mtime: number }): string {
    return `${f.size}-${f.mtime}`
  }

  /** Cached first-page thumbnails (data URLs) of the given library files; stale or missing ones are omitted. */
  async readThumbs(ids: number[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const id of ids) {
      const f = this.repo.getFile(id)
      if (!f || f.hidden || !f.thumbKey) continue
      if (f.thumbKey !== this.thumbKey(f)) {
        this.repo.setThumbKey(id, null)
        continue
      }
      try {
        const png = await readFile(this.thumbPath(id))
        out[`f${id}`] = `data:image/png;base64,${png.toString('base64')}`
      } catch {
        this.repo.setThumbKey(id, null)
      }
    }
    return out
  }

  async saveThumb(id: number, png: Uint8Array, pages?: number): Promise<boolean> {
    const f = this.repo.getFile(id)
    if (!f || f.hidden) return false
    if (png.length === 0 || png.length > MAX_THUMB_BYTES) throw new Error('The thumbnail is too large.')
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (!sig.every((b, i) => png[i] === b)) throw new Error('The thumbnail is not a PNG image.')
    await mkdir(this.ports.thumbsDir, { recursive: true })
    await writeFile(this.thumbPath(id), png)
    this.repo.setThumbKey(id, this.thumbKey(f), pages)
    return true
  }

  async removeThumbs(ids: number[]): Promise<void> {
    for (const id of ids) await rm(this.thumbPath(id), { force: true }).catch(() => undefined)
  }
}
