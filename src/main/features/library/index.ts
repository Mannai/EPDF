import { app, BrowserWindow, dialog, shell } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AddSuggestedSchema,
  AddToCollectionSchema,
  CollectionIdSchema,
  FavoriteRequestSchema,
  ForgetRequestSchema,
  IndexFileRequestSchema,
  ListRequestSchema,
  NameRequestSchema,
  OpenRequestSchema,
  RefRequestSchema,
  RemoveFromCollectionSchema,
  RenameCollectionSchema,
  RootRequestSchema,
  SaveThumbSchema,
  SearchRequestSchema,
  SettingsPatchSchema,
  SyncRequestSchema,
  ThumbsRequestSchema,
  TreeRequestSchema,
  parseRef,
  type FolderSuggestion,
  type OpenResult,
  type RootKind,
  type SearchResult,
  type ThumbSource
} from '../../../shared/features/library'
import { isInside } from '../../../shared/features/library/plan'
import type { DocHandle } from '../../../shared/types'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { registerFeatureChannel, sendFeatureEvent, type MainContext } from '../api'
import { resolveTarget } from './access'
import { WorkerEngine } from './engine'
import createIndexWorker from './indexWorker?nodeWorker'
import { CollectionError, LibraryRepo } from './repo'
import { LibraryService, type SyncJobPayload } from './service'
import { detectFolders, labelForFolder, realEnv, type Suggestion } from './suggest'

const SyncJobSchema = z.object({ rootIds: z.array(z.number().int().positive()).max(1000), force: z.array(z.number().int().positive()).max(100_000).optional() })

const envNumber = (name: string): number | undefined => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

type Result = { ok: true; id?: number; message?: string } | { ok: false; error: string }
const fail = (err: unknown): Result => ({ ok: false, error: err instanceof Error ? err.message : String(err) })

/**
 * Main-process half of the local file library: watched folders, the SQLite index (FTS5), background indexing in a
 * worker thread, search, favorites, virtual folders and the gate every "open" goes through. The renderer never
 * supplies a path: files are addressed by opaque refs and folders by id (see shared/features/library.ts).
 */
export function register(ctx: MainContext): void {
  const repo = new LibraryRepo(ctx.repos.db)
  const kv = ctx.kv('library')
  const thumbsDir = join(app.getPath('userData'), 'library-thumbs')
  const rendererPdfjs = join(__dirname, '../renderer/pdfjs')

  const service = new LibraryService(repo, {
    startJob: (payload: SyncJobPayload, owner) => ctx.jobs.start('library:sync', payload, owner),
    cancelJob: (id) => ctx.jobs.cancel(id),
    emit: (channel, payload) => sendFeatureEvent('all', channel, payload),
    kv,
    createEngine: () => new WorkerEngine(() => createIndexWorker({})),
    assets: () => ({ cMapUrl: join(rendererPdfjs, 'cmaps') + '/', standardFontDataUrl: join(rendererPdfjs, 'standard_fonts') + '/' }),
    thumbsDir,
    watchDebounceMs: envNumber('EPDF_LIBRARY_WATCH_MS'),
    rescanIntervalMs: envNumber('EPDF_LIBRARY_RESCAN_MS'),
    extraDelayMs: envNumber('EPDF_LIBRARY_THROTTLE_MS')
  })
  ctx.jobs.register('library:sync', 'Indexing library', SyncJobSchema, (payload, job) => service.runJob(payload, job))
  service.start(envNumber('EPDF_LIBRARY_START_MS') ?? 1500)
  app.once('will-quit', () => service.dispose())

  const suggestions = (): Suggestion[] =>
    detectFolders(
      realEnv({
        documents: safePath('documents'),
        downloads: safePath('downloads'),
        desktop: safePath('desktop')
      })
    )
  function safePath(name: 'documents' | 'downloads' | 'desktop'): string | undefined {
    try {
      return app.getPath(name)
    } catch {
      return undefined
    }
  }
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  const samePath = (a: string, b: string): boolean => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b)

  /** Adds a folder unless it overlaps an existing one (a file can belong to only one watched folder). */
  async function addFolder(path: string, label: string, kind: RootKind, owner?: number): Promise<Result> {
    let real: string
    try {
      real = await realpath(path)
      if (!(await stat(real)).isDirectory()) return { ok: false, error: 'That is not a folder.' }
    } catch {
      return { ok: false, error: 'That folder cannot be read.' }
    }
    for (const r of repo.listRoots()) {
      let rr = r.path
      try {
        rr = await realpath(r.path)
      } catch {
        /* a missing folder still blocks overlaps by its stored path */
      }
      if (samePath(rr, real)) return { ok: false, error: `“${r.label}” is already in the library.` }
      if (isInside(rr, real, caseInsensitive)) return { ok: false, error: `This folder is already covered by “${r.label}”.` }
      if (isInside(real, rr, caseInsensitive)) return { ok: false, error: `This folder contains “${r.label}”, which is already in the library. Remove that one first.` }
    }
    const { id } = service.addRoot(real, label, kind, owner)
    return { ok: true, id }
  }

  // ---- overview -------------------------------------------------------------------------------------------------------
  registerFeatureChannel('library:state', z.object({}), () => service.state())
  registerFeatureChannel('library:suggestions', z.object({}), async (): Promise<FolderSuggestion[]> => {
    const roots = repo.listRoots()
    const out: FolderSuggestion[] = []
    for (const s of suggestions()) {
      let real = s.path
      try {
        real = await realpath(s.path)
      } catch {
        /* keep the plain path */
      }
      const added = roots.some((r) => samePath(r.path, real) || samePath(r.path, s.path) || isInside(r.path, real, caseInsensitive))
      out.push({ key: s.key, label: s.label, path: s.path, kind: s.kind, cloud: s.cloud, added })
    }
    return out
  })

  registerFeatureChannel('library:addFolder', z.object({}), async (_req, call): Promise<Result> => {
    let path: string | undefined = process.env['EPDF_LIBRARY_PICK_FOLDER'] || undefined // test hook: skips the native dialog
    if (!path) {
      const opts: Electron.OpenDialogOptions = { title: 'Add a folder to the library', properties: ['openDirectory'] }
      const parent = call.window?.win as BrowserWindow | undefined
      const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
      if (res.canceled || res.filePaths.length === 0) return { ok: true, message: 'cancelled' }
      path = res.filePaths[0]
    }
    const known = suggestions().find((s) => samePath(s.path, path!))
    return addFolder(path, known?.label ?? labelForFolder(path), known?.kind ?? 'folder', call.window?.win.id)
  })

  registerFeatureChannel('library:addSuggested', AddSuggestedSchema, async ({ key }, call): Promise<Result> => {
    const s = suggestions().find((x) => x.key === key)
    if (!s) return { ok: false, error: 'That folder is no longer available.' }
    return addFolder(s.path, s.label, s.kind, call.window?.win.id)
  })

  registerFeatureChannel('library:removeFolder', RootRequestSchema, async ({ rootId }) => {
    await service.removeRoot(rootId)
  })
  registerFeatureChannel('library:rescan', SyncRequestSchema, ({ rootId }, call) => {
    service.enqueue(rootId ? [rootId] : undefined, { owner: call.window?.win.id })
  })
  registerFeatureChannel('library:cancel', z.object({}), () => service.cancel())
  registerFeatureChannel('library:forget', ForgetRequestSchema, async ({ keepFolders }) => service.forget(keepFolders))
  registerFeatureChannel('library:settings', SettingsPatchSchema, (patch) => service.setSettings(patch))
  registerFeatureChannel('library:indexAnyway', IndexFileRequestSchema, ({ ref }, call) => {
    const p = parseRef(ref)
    const f = p?.kind === 'file' ? repo.getFile(p.id) : null
    if (!f || f.rootId === null) throw new Error('That file is not in a watched folder.')
    service.enqueue([f.rootId], { force: [f.id], owner: call.window?.win.id })
  })

  // ---- lists and search -----------------------------------------------------------------------------------------------
  registerFeatureChannel('library:list', ListRequestSchema, (req) => repo.list(req))
  registerFeatureChannel('library:tree', TreeRequestSchema, ({ rootId }) => ({ rootId, dirs: repo.treeDirs(rootId) }))
  registerFeatureChannel('library:search', SearchRequestSchema, (req): SearchResult => {
    const t0 = performance.now()
    const r = repo.search(req)
    return r.ok ? { ...r, tookMs: Math.round(performance.now() - t0) } : r
  })

  // ---- opening --------------------------------------------------------------------------------------------------------
  registerFeatureChannel('library:open', OpenRequestSchema, async ({ refs }): Promise<OpenResult> => {
    const handles: DocHandle[] = []
    const failed: OpenResult['failed'] = []
    let downloaded = 0
    for (const ref of refs) {
      const t = await resolveTarget({ repo }, ref)
      if (!t.ok) {
        failed.push({ ref, name: t.name, reason: t.reason })
        if (t.gone && t.fileId) {
          repo.deleteFiles([t.fileId])
          await service.removeThumbs([t.fileId])
          service.changed(true)
        }
        continue
      }
      const h = await ctx.controller.registerFile(t.path, { silent: true })
      if (h) {
        handles.push(h)
        if (t.cloud) downloaded++
      } else failed.push({ ref, name: t.name, reason: 'The file could not be opened.' })
    }
    if (handles.length > 0) service.changed(true)
    return { handles, failed, downloaded }
  })

  registerFeatureChannel('library:reveal', RefRequestSchema, async ({ ref }) => {
    const t = await resolveTarget({ repo, validate: async () => undefined }, ref)
    if (!t.ok) throw new Error(t.reason)
    shell.showItemInFolder(t.path)
  })

  registerFeatureChannel('library:removeFile', z.object({ refs: z.array(z.string().max(20)).min(1).max(500) }), async ({ refs }) => {
    const gone: number[] = []
    for (const ref of refs) {
      const p = parseRef(ref)
      if (!p) continue
      if (p.kind === 'file') {
        const f = repo.getFile(p.id)
        if (!f) continue
        if (f.rootId === null) repo.deleteFiles([f.id])
        else repo.hideFile(f.id)
        gone.push(f.id)
      } else {
        const r = repo.getRecent(p.id)
        if (r) ctx.repos.recent.remove(r.path)
      }
    }
    await service.removeThumbs(gone)
    ctx.controller.onRecentsChanged?.()
    service.changed(true)
  })

  registerFeatureChannel('library:favorite', FavoriteRequestSchema, ({ refs, value }) => {
    for (const ref of refs) {
      const p = parseRef(ref)
      if (!p) continue
      if (p.kind === 'file') repo.setFavoriteFile(p.id, value)
      else repo.setFavoriteRecent(p.id, value)
    }
    service.changed(true)
  })

  // ---- virtual folders ------------------------------------------------------------------------------------------------
  const fileIds = (refs: string[]): number[] => refs.map(parseRef).flatMap((p) => (p && p.kind === 'file' ? [p.id] : []))
  const guard = (fn: () => Result | void): Result => {
    try {
      const r = fn()
      service.changed(true)
      return r ?? { ok: true }
    } catch (err) {
      if (err instanceof CollectionError) return fail(err)
      throw err
    }
  }
  registerFeatureChannel('library:createCollection', NameRequestSchema, ({ name, parentId }) => guard(() => ({ ok: true, id: repo.ensureCollectionPath(name, parentId ?? null) })))
  registerFeatureChannel('library:renameCollection', RenameCollectionSchema, ({ id, name }) => guard(() => repo.renameCollection(id, name)))
  registerFeatureChannel('library:deleteCollection', CollectionIdSchema, ({ id }) => guard(() => repo.deleteCollection(id)))
  registerFeatureChannel('library:addToCollection', AddToCollectionSchema, ({ collectionId, refs }) =>
    guard(() => {
      const ids = fileIds(refs)
      if (ids.length === 0) return { ok: false, error: 'Only files in a watched folder can be added to a library folder. Files opened from elsewhere can be added once their folder is in the library.' }
      const added = repo.addToCollection(collectionId, ids)
      return { ok: true, message: added === 0 ? 'Already in that folder.' : undefined }
    })
  )
  registerFeatureChannel('library:removeFromCollection', RemoveFromCollectionSchema, ({ collectionId, refs }) => guard(() => repo.removeFromCollection(collectionId, fileIds(refs))))

  // ---- thumbnails (rendered by the renderer's PDF.js, cached here as PNG files) --------------------------------------------
  registerFeatureChannel('library:thumbs', ThumbsRequestSchema, ({ refs }) => service.readThumbs(fileIds(refs)))
  registerFeatureChannel('library:thumbSource', RefRequestSchema, async ({ ref }): Promise<ThumbSource | null> => {
    const p = parseRef(ref)
    const f = p?.kind === 'file' ? repo.getFile(p.id) : null
    if (!f || f.hidden || f.cloud || f.state === 'cloud' || f.state === 'unindexable') return null // never download or unlock just for a picture
    const t = await resolveTarget({ repo }, ref)
    if (!t.ok) return null
    const h = await ctx.controller.registry.register(t.path)
    return { docId: h.docId }
  })
  registerFeatureChannel('library:saveThumb', SaveThumbSchema, async ({ ref, png, pages }) => {
    const p = parseRef(ref)
    if (!p || p.kind !== 'file') return false
    return service.saveThumb(p.id, png, pages)
  })

  contributeMenu({
    menu: 'File',
    position: 'start',
    items: () => [commandItem('Library…', 'library.open', 'CmdOrCtrl+Shift+L')]
  })
}
