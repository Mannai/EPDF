import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { extname } from 'node:path'
import type { DocHandle, DocViewState, OpenedDoc, Settings } from '../shared/types'
import type { Repos } from './db'
import { DocRegistry, InvalidPdfError } from './services/docRegistry'
import { FileService } from './services/fileService'
import { WindowManager, type ManagedWindow } from './windows/WindowManager'

export const isPdfPath = (p: string): boolean => extname(p).toLowerCase() === '.pdf'

/**
 * Extracts PDF paths from a process argv. In dev argv[1] is the app path, which is never a `.pdf`,
 * so the same filter works for packaged and unpackaged runs.
 */
export function pdfPathsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && isPdfPath(a))
}

export class Controller {
  readonly registry: DocRegistry
  readonly windows = new WindowManager()
  readonly files: FileService
  quitting = false
  /** A quit was paused while a window asks about unsaved edits; continue it once that window has closed. */
  resumeQuit = false
  onRecentsChanged?: () => void

  constructor(
    readonly repos: Repos,
    dataDir: string
  ) {
    this.files = new FileService(dataDir, repos)
    this.registry = new DocRegistry((docId) => this.windows.broadcast('doc:changedOnDisk', { docId }))
    this.windows.onClosed = () => {
      // While quitting, keep the snapshot so the next launch can restore every window.
      if (!this.quitting && !this.resumeQuit) this.saveSession()
      if (this.resumeQuit) {
        this.resumeQuit = false
        app.quit() // carry on with the quit; the next window (if any) will ask in turn
      }
    }
    this.windows.onBounds = (b) => this.repos.settings.setFlag('bounds', JSON.stringify(b))
    this.windows.onCloseBlocked = () => {
      // The window's renderer now decides; a quit in progress waits for its answer.
      this.resumeQuit = this.resumeQuit || this.quitting
      this.quitting = false
    }
  }

  /** The user chose Cancel in an unsaved-changes prompt: abandon any quit that was waiting on it. */
  cancelPendingQuit(): void {
    this.resumeQuit = false
  }

  get settings(): Settings {
    return this.repos.settings.getAll()
  }

  applyTheme(): void {
    nativeTheme.themeSource = this.settings.theme
  }

  savedBounds(): Partial<Electron.Rectangle> | undefined {
    const raw = this.repos.settings.getFlag('bounds')
    if (!raw) return undefined
    try {
      const b = JSON.parse(raw) as Electron.Rectangle
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    } catch {
      return undefined
    }
  }

  newWindow(): ManagedWindow {
    return this.windows.create(this.windows.all().length === 0 ? this.savedBounds() : undefined)
  }

  /** Registers a file and records it in recents. Returns null (after telling the user) on failure. */
  async registerFile(path: string, opts: { silent?: boolean; touchRecent?: boolean } = {}): Promise<DocHandle | null> {
    try {
      const lastPage = this.repos.recent.getLastPage(path) ?? undefined
      const registered = await this.registry.register(path, lastPage)
      const handle = { ...registered, hasRecovery: this.files.hasRecovery(path) }
      if (opts.touchRecent !== false) this.touchRecent(handle)
      return handle
    } catch (err) {
      if (!opts.silent) {
        const msg = err instanceof InvalidPdfError ? err.message : 'The file could not be opened.'
        void dialog.showMessageBox({ type: 'error', title: 'Epdf', message: `Cannot open “${path}”`, detail: msg })
      }
      this.repos.recent.remove(path)
      this.onRecentsChanged?.()
      return null
    }
  }

  private touchRecent(h: DocHandle): void {
    this.repos.recent.touch(h.path, h.name, h.size)
    app.addRecentDocument(h.path)
    this.onRecentsChanged?.()
  }

  defaultView(handle: DocHandle): DocViewState {
    const s = this.settings
    return { page: handle.lastPage ?? 1, zoom: 1, zoomMode: s.defaultZoomMode, viewMode: s.defaultViewMode }
  }

  /** Opens paths in `target` (or the focused window; a new one if none exist). */
  async openPaths(paths: string[], target?: ManagedWindow): Promise<void> {
    const w = target ?? this.windows.focused() ?? this.newWindow()
    const docs: OpenedDoc[] = []
    for (const p of paths) {
      const handle = await this.registerFile(p)
      if (handle) docs.push({ handle, view: this.defaultView(handle), activate: docs.length === paths.length - 1 })
    }
    if (docs.length) docs[docs.length - 1].activate = true
    this.windows.openDocs(w, docs)
  }

  async pickPdfs(parent: BrowserWindow | undefined, multi = true): Promise<string[]> {
    const opts: Electron.OpenDialogOptions = {
      title: 'Open PDF',
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
    }
    const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths
  }

  saveSession(): void {
    const windows = this.windows
      .all()
      .map((w) => ({
        tabs: w.tabs.tabs.map((t) => ({ path: t.path, view: t.view, active: t.docId === w.tabs.activeDocId }))
      }))
      .filter((w) => w.tabs.length > 0)
    this.repos.session.save(windows)
  }

  /** Recreates windows and tabs from the last snapshot. Returns true if anything was restored. */
  async restoreSession(): Promise<boolean> {
    const snapshot = this.repos.session.load()
    let restored = false
    for (const sw of snapshot) {
      const docs: OpenedDoc[] = []
      for (const t of sw.tabs) {
        const handle = await this.registerFile(t.path, { silent: true, touchRecent: false })
        if (handle) docs.push({ handle, view: t.view, activate: t.active })
      }
      if (docs.length === 0) continue
      if (!docs.some((d) => d.activate)) docs[0].activate = true
      const w = this.windows.create(restored ? undefined : this.savedBounds())
      this.windows.openDocs(w, docs)
      restored = true
    }
    return restored
  }

  setDefaultPdfApp(): void {
    if (process.platform === 'win32') {
      void shell.openExternal('ms-settings:defaultapps')
    } else {
      void dialog.showMessageBox({
        message: 'Set Epdf as the default PDF app',
        detail:
          'In Finder, select any PDF, choose File ▸ Get Info, pick Epdf under “Open with”, then click “Change All…”.'
      })
    }
  }
}
