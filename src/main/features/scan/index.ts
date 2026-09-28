import { app, BrowserWindow, dialog } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  PhoneStartSchema,
  PhoneStopSchema,
  SCAN_LIMITS,
  ScanAcquireSchema,
  ScanCapsRequestSchema,
  ScanDevicesRequestSchema,
  ScanSaveSchema,
  ScanSessionRequestSchema,
  type PhoneEndpoint,
  type PhoneImageEvent,
  type PhoneStartResult,
  type PhoneStatusEvent,
  type ScanEnvironment,
  type ScanPageEvent,
  type ScanSaveResult,
  type ScannerCaps,
  type ScannerDevice
} from '../../../shared/features/scan'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { atomicWrite } from '../../services/fileService'
import { resolveTool } from '../../services/tools'
import type { ManagedWindow } from '../../windows/WindowManager'
import type { MainContext } from '../api'
import { registerFeatureChannel, sendFeatureEvent } from '../api'
import { chooseBackend } from './backends'
import { ScanError } from './errors'
import { listLanAddresses } from './lan'
import { PhoneUploadServer } from './phoneServer'

/**
 * Main half of File ▸ Scan to PDF…: enumerates scanners and runs scans as cancellable jobs (backends.ts), runs the
 * temporary phone-upload server (phoneServer.ts) and saves the finished PDF. Pictures travel to the renderer as
 * events tagged with a session id; the renderer does all image cleanup in a Web Worker and builds the PDF.
 */

interface Session {
  window: ManagedWindow
  phone: PhoneUploadServer | null
}

export function register(ctx: MainContext): void {
  const choice = chooseBackend({ platform: process.platform, macHelperPath: process.platform === 'darwin' ? resolveTool('epdf-mac-scan') : null })
  const sessions = new Map<string, Session>()

  const platform = (process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux') as ScanEnvironment['platform']
  const backendOrThrow = (): NonNullable<typeof choice.backend> => {
    if (!choice.backend) throw new ScanError('unavailable', choice.message)
    return choice.backend
  }
  const sessionOf = (id: string): Session => {
    const s = sessions.get(id)
    if (!s) throw new Error('This scanning session is not active. Close the Scan window and open it again.')
    return s
  }

  registerFeatureChannel('scan:environment', z.object({}), (): ScanEnvironment => ({ backend: choice.id, platform, message: choice.message, stub: choice.stub }))

  // ---- sessions (which window gets the pictures) ------------------------------------------------------------
  registerFeatureChannel('scan:session', ScanSessionRequestSchema, ({ sessionId }, { window }) => {
    if (!window) throw new Error('No window for this scanning session.')
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { window, phone: null })
      window.win.once('closed', () => endSession(sessionId))
    }
  })
  const endSession = (id: string): void => {
    const s = sessions.get(id)
    if (!s) return
    s.phone?.close('closed')
    sessions.delete(id)
  }
  registerFeatureChannel('scan:endSession', ScanSessionRequestSchema, ({ sessionId }) => endSession(sessionId))
  app.on('before-quit', () => [...sessions.keys()].forEach(endSession))

  // ---- scanners ------------------------------------------------------------------------------------------------
  registerFeatureChannel('scan:devices', ScanDevicesRequestSchema, async (): Promise<ScannerDevice[]> => backendOrThrow().listDevices())
  registerFeatureChannel('scan:capabilities', ScanCapsRequestSchema, async ({ deviceId }): Promise<ScannerCaps> => backendOrThrow().capabilities(deviceId))

  ctx.jobs.register('scan:acquire', 'Scanning', ScanAcquireSchema, async (p, jobCtx) => {
    const backend = backendOrThrow()
    const session = sessionOf(p.sessionId)
    const dir = await mkdtemp(join(app.getPath('temp'), 'epdf-scan-'))
    try {
      jobCtx.progress(0.02, 'Contacting the scanner')
      const pages = await backend.acquire(p, {
        signal: jobCtx.signal,
        tempDir: dir,
        progress: (f, m) => jobCtx.progress(f, m),
        onPage: (page) => {
          const ev: ScanPageEvent = { sessionId: p.sessionId, index: page.index, mime: page.mime, dpi: page.dpi, bytes: page.bytes }
          sendFeatureEvent(session.window, 'scan:page', ev)
        }
      })
      if (pages === 0) throw new ScanError('no_paper')
      return { pages }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    }
  })

  // ---- phone over the local network ------------------------------------------------------------------------------
  registerFeatureChannel('scan:phoneStart', PhoneStartSchema, async ({ sessionId }): Promise<PhoneStartResult> => {
    const session = sessionOf(sessionId)
    session.phone?.close('closed')
    session.phone = null
    const override = process.env['EPDF_PHONE_ADDRESSES']
    const lan = override ? override.split(',').map((a) => ({ address: a.trim(), interfaceName: 'test', likelyVirtual: false })) : listLanAddresses()
    if (lan.length === 0) {
      throw new Error('Epdf found no local network to use. Connect this computer to the same Wi-Fi or network as your phone (guest networks and VPNs often block it), then try again.')
    }
    const server = await PhoneUploadServer.start({
      addresses: lan.map((l) => l.address),
      onUpload: (img) => {
        const ev: PhoneImageEvent = { sessionId, id: img.id, mime: img.mime, bytes: new Uint8Array(img.bytes) }
        sendFeatureEvent(session.window, 'scan:phoneImage', ev)
      },
      onClose: (reason) => {
        if (session.phone === server) session.phone = null
        const ev: PhoneStatusEvent = { sessionId, state: reason }
        if (!session.window.win.isDestroyed()) sendFeatureEvent(session.window, 'scan:phoneStatus', ev)
      },
      ttlMs: Number(process.env['EPDF_PHONE_TTL_MS']) || SCAN_LIMITS.phoneTtlMs
    })
    session.phone = server
    const endpoints: PhoneEndpoint[] = server.endpoints.map((e) => {
      const info = lan.find((l) => l.address === e.address)!
      return { address: e.address, interfaceName: info.interfaceName, url: e.url, likelyVirtual: info.likelyVirtual }
    })
    return { endpoints, expiresAt: server.expiresAt, maxFileMb: SCAN_LIMITS.maxPhoneFileBytes / 1024 / 1024, warnings: server.warnings }
  })

  registerFeatureChannel('scan:phoneStop', PhoneStopSchema, ({ sessionId }) => {
    const s = sessions.get(sessionId)
    s?.phone?.close('closed')
    if (s) s.phone = null
  })

  // ---- saving ----------------------------------------------------------------------------------------------------
  registerFeatureChannel('scan:save', ScanSaveSchema, async ({ bytes, suggestedName }, { window }): Promise<ScanSaveResult | null> => {
    const parent = window?.win ?? BrowserWindow.getFocusedWindow() ?? undefined
    const safeName = suggestedName.replace(/[\\/:*?"<>|\0-\x1f]/g, '_').replace(/\.pdf$/i, '') || 'Scan'
    const opts: Electron.SaveDialogOptions = { title: 'Save scanned PDF', defaultPath: join(app.getPath('documents'), `${safeName}.pdf`), filters: [{ name: 'PDF documents', extensions: ['pdf'] }] }
    const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    const path = /\.pdf$/i.test(res.filePath) ? res.filePath : `${res.filePath}.pdf`
    await atomicWrite(path, bytes)
    return { path, name: path.split(/[\\/]/).pop() ?? path }
  })

  contributeMenu({ menu: 'File', position: 'start', items: () => [commandItem('Scan to PDF…', 'scan.open', undefined, { anyTime: true })] })
}
