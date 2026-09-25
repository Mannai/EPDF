import { app, BrowserWindow, dialog, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { basename, dirname, join } from 'node:path'
import type { DocHandle, OpenedDoc } from '../../shared/types'
import type { Controller } from '../controller'
import { callFeatureChannel } from '../features/api'
import { APP_ORIGIN } from '../services/protocol'
import { handle } from './registry'

export function registerIpcHandlers(c: Controller): void {
  const winOf = (senderId: number) => c.windows.fromWebContentsId(senderId)

  handle('file:openDialog', async (req, e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const paths = await c.pickPdfs(parent, req?.multi ?? true)
    const out: DocHandle[] = []
    for (const p of paths) {
      const h = await c.registerFile(p)
      if (h) out.push(h)
    }
    return out
  })

  handle('file:open', async (req) => c.registerFile(req.path))

  // Files dropped onto the window: paths resolved in preload via webUtils.getPathForFile.
  handle('file:openDropped', async (req) => {
    const out: DocHandle[] = []
    for (const p of req.paths) {
      if (!/\.pdf$/i.test(p)) continue
      const h = await c.registerFile(p)
      if (h) out.push(h)
    }
    return out
  })

  handle('file:close', (req) => c.registry.release(req.docId))

  handle('file:reveal', (req) => {
    const path = c.registry.pathOf(req.docId)
    if (path) shell.showItemInFolder(path)
  })

  const pathOrThrow = (docId: string): string => {
    const p = c.registry.pathOf(docId)
    if (!p) throw new Error('Unknown document')
    return p
  }

  handle('file:save', async (req) => {
    const path = pathOrThrow(req.docId)
    const { size, mtime } = await c.files.save(path, req.bytes)
    c.registry.noteWritten(req.docId, size, mtime)
    return { path, name: basename(path), size, mtime }
  })

  const askSavePath = async (docId: string, suggestedName: string | undefined, e: IpcMainInvokeEvent): Promise<string | null> => {
    const current = pathOrThrow(docId)
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts: Electron.SaveDialogOptions = {
      defaultPath: suggestedName ? join(dirname(current), suggestedName) : current,
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
    }
    const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    return /\.pdf$/i.test(res.filePath) ? res.filePath : `${res.filePath}.pdf`
  }

  handle('file:saveAs', async (req, e) => {
    const oldPath = pathOrThrow(req.docId)
    const target = await askSavePath(req.docId, req.suggestedName, e)
    if (!target) return null
    const { size, mtime } = await c.files.writeNew(target, req.bytes)
    c.registry.rebind(req.docId, target, size, mtime)
    // The old file keeps its on-disk content, so its autosaved edits no longer apply to it.
    if (oldPath !== target) await c.files.clearRecovery(oldPath)
    await c.files.clearRecovery(target)
    c.repos.recent.touch(target, basename(target), size)
    c.onRecentsChanged?.()
    return { path: target, name: basename(target), size, mtime }
  })

  handle('file:saveCopy', async (req, e) => {
    const target = await askSavePath(req.docId, req.suggestedName ?? `Copy of ${basename(pathOrThrow(req.docId))}`, e)
    if (!target) return null
    const { size, mtime } = await c.files.writeNew(target, req.bytes)
    return { path: target, name: basename(target), size, mtime }
  })

  handle('recovery:write', (req) => c.files.writeRecovery(pathOrThrow(req.docId), req.bytes))
  handle('recovery:read', (req) => c.files.readRecovery(pathOrThrow(req.docId)))
  handle('recovery:clear', (req) => c.files.clearRecovery(pathOrThrow(req.docId)))
  handle('versions:list', (req) => c.files.listVersions(pathOrThrow(req.docId)))
  handle('versions:read', (req) => c.files.readVersion(pathOrThrow(req.docId), req.versionId))

  handle('feature:call', (req, e) =>
    callFeatureChannel(req.channel, req.payload, { event: e, window: winOf(e.sender.id) })
  )

  handle('window:closeAck', (_req, e) => {
    const w = winOf(e.sender.id)
    if (w) c.windows.ackClose(w)
  })

  handle('window:close', (req, e) => {
    const w = winOf(e.sender.id)
    if (!w) return
    if (req?.cancel) {
      c.windows.cancelClose(w)
      return c.cancelPendingQuit()
    }
    if (req?.discard) w.forceClose = true
    w.win.close()
  })

  handle('recent:list', () => c.repos.recent.list(20))
  handle('recent:remove', (req) => {
    c.repos.recent.remove(req.path)
    c.onRecentsChanged?.()
  })
  handle('recent:clear', () => {
    c.repos.recent.clear()
    c.onRecentsChanged?.()
  })

  handle('tabs:report', (req, e) => {
    const w = winOf(e.sender.id)
    if (!w) return
    w.tabs = req
    const active = req.tabs.find((t) => t.docId === req.activeDocId)
    if (active) c.repos.recent.setLastPage(active.path, active.view.page)
    // macOS shows a dot in the close button and the title bar for documents with unsaved edits.
    w.win.setDocumentEdited(req.tabs.some((t) => t.dirty))
    if (!c.quitting) c.saveSession()
  })

  handle('tabs:detach', (req, e) => {
    const source = winOf(e.sender.id)
    const h = c.registry.addRef(req.docId)
    if (!h || !source) return
    const target = c.windows.create()
    const doc: OpenedDoc = { handle: { ...h, hasRecovery: c.files.hasRecovery(h.path) }, view: req.view, activate: true, autoRecover: true }
    c.windows.openDocs(target, [doc])
  })

  handle('window:ready', (_req, e) => {
    const w = winOf(e.sender.id)
    if (w) c.windows.markReady(w)
  })

  handle('settings:getAll', () => c.settings)
  handle('settings:get', (req) => c.settings[req.key])
  handle('settings:set', (req) => {
    // Discriminated union guarantees key/value agree; the cast only bridges the generic setter.
    c.repos.settings.set(req.key, req.value as never)
    if (req.key === 'theme') c.applyTheme()
  })

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    darkMode: nativeTheme.shouldUseDarkColors,
    docBaseUrl: `${APP_ORIGIN}/doc/`,
    autosaveMs: Number(process.env['EPDF_AUTOSAVE_MS']) || 15_000
  }))

  handle('app:setDefaultPdf', () => c.setDefaultPdfApp())
}
