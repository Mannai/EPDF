import { BrowserWindow, nativeTheme, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { EventChannel } from '../../shared/channels'
import type { EventPayloads } from '../../shared/ipc'
import type { OpenedDoc, TabReport } from '../../shared/types'
import { APP_ORIGIN } from '../services/protocol'
import { lockDownWebContents } from '../security'

export interface ManagedWindow {
  win: BrowserWindow
  ready: boolean
  queue: OpenedDoc[]
  tabs: TabReport
  /** Set once the renderer has confirmed (save/discard) so the next close goes through. */
  forceClose: boolean
}

export class WindowManager {
  private windows = new Map<number, ManagedWindow>()
  onClosed?: (w: ManagedWindow) => void
  onBounds?: (b: Rectangle) => void
  /** A close was deferred to the renderer, which may prompt about unsaved edits (a quit in progress pauses). */
  onCloseBlocked?: (w: ManagedWindow) => void

  create(bounds?: Partial<Rectangle>): ManagedWindow {
    const win = new BrowserWindow({
      width: bounds?.width ?? 1200,
      height: bounds?.height ?? 800,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 640,
      minHeight: 400,
      show: false,
      title: 'Epdf',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#ffffff',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false
      }
    })
    const managed: ManagedWindow = { win, ready: false, queue: [], tabs: { tabs: [], activeDocId: null }, forceClose: false }
    this.windows.set(win.id, managed)

    lockDownWebContents(win.webContents)
    win.once('ready-to-show', () => win.show())
    win.on('close', (e) => {
      // The renderer is the source of truth for unsaved edits (main's copy of the dirty flag can lag
      // behind by a debounce), so a window that has documents open always asks it before closing. The
      // renderer replies with `window:close` immediately if nothing is dirty, or prompts first.
      const canAsk = managed.ready && managed.tabs.tabs.length > 0 && !win.webContents.isCrashed()
      if (!managed.forceClose && canAsk) {
        e.preventDefault()
        this.send(managed, 'window:closeRequested', undefined)
        this.onCloseBlocked?.(managed)
        return
      }
      this.onBounds?.(win.getNormalBounds())
    })
    win.on('closed', () => {
      this.windows.delete(win.id)
      this.onClosed?.(managed)
    })

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) void win.loadURL(devUrl)
    else void win.loadURL(`${APP_ORIGIN}/index.html`)
    return managed
  }

  get(id: number): ManagedWindow | undefined {
    return this.windows.get(id)
  }

  fromWebContentsId(id: number): ManagedWindow | undefined {
    for (const w of this.windows.values()) if (w.win.webContents.id === id) return w
    return undefined
  }

  focused(): ManagedWindow | undefined {
    const f = BrowserWindow.getFocusedWindow()
    return (f && this.windows.get(f.id)) || [...this.windows.values()].find((w) => !w.win.isDestroyed())
  }

  all(): ManagedWindow[] {
    return [...this.windows.values()]
  }

  /** Delivers documents to a window, queueing until its renderer has signalled ready. */
  openDocs(w: ManagedWindow, docs: OpenedDoc[]): void {
    if (docs.length === 0) return
    // Track the tabs immediately, so a session snapshot taken before the renderer's first report
    // (e.g. while other windows are still restoring) does not lose them.
    for (const d of docs) {
      if (!w.tabs.tabs.some((t) => t.path === d.handle.path)) {
        w.tabs.tabs.push({ docId: d.handle.docId, path: d.handle.path, view: d.view, dirty: false })
      }
      if (d.activate) w.tabs.activeDocId = d.handle.docId
    }
    if (!w.ready) w.queue.push(...docs)
    else this.send(w, 'doc:open', docs)
    if (w.win.isMinimized()) w.win.restore()
    w.win.focus()
  }

  markReady(w: ManagedWindow): void {
    w.ready = true
    if (w.queue.length) {
      const q = w.queue
      w.queue = []
      this.send(w, 'doc:open', q)
    }
  }

  send<C extends EventChannel>(w: ManagedWindow, channel: C, payload: EventPayloads[C]): void {
    if (!w.win.isDestroyed()) w.win.webContents.send(channel, payload)
  }

  broadcast<C extends EventChannel>(channel: C, payload: EventPayloads[C]): void {
    for (const w of this.windows.values()) this.send(w, channel, payload)
  }
}

