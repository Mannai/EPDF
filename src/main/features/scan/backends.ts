import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { ScanAcquireRequest, ScanBackendId, ScannerCaps, ScannerDevice } from '../../../shared/features/scan'
import { SCAN_ERROR_TEXT, ScanError, type ScanErrorCode } from './errors'
import { runHelper, type HelperSpec } from './helper'
import type { ProtocolMessage } from './protocol'
import { buildWiaSpec, offeredResolutions, type WiaCommand } from './wia'

/**
 * Scanner backends behind one interface:
 *  - `wia`   Windows Image Acquisition through PowerShell (./wia.ts)
 *  - `mac`   a native helper speaking the same line protocol (resources/native/mac-scan, macOS only, UNTESTED here)
 *  - `stub`  feeds pictures from a folder (EPDF_SCANNER_STUB=<dir>): the test scanner
 */

export interface AcquiredPage {
  index: number
  mime: 'image/png' | 'image/jpeg' | 'image/bmp'
  dpi: number
  bytes: Uint8Array
}

export interface AcquireContext {
  signal: AbortSignal
  progress(fraction: number, message?: string): void
  onPage(page: AcquiredPage): void | Promise<void>
  /** A per-job scratch directory (created by the backend, removed by the caller). */
  tempDir: string
}

export interface ScanBackend {
  readonly id: Exclude<ScanBackendId, 'none'>
  listDevices(signal?: AbortSignal): Promise<ScannerDevice[]>
  capabilities(deviceId: string, signal?: AbortSignal): Promise<ScannerCaps>
  acquire(req: ScanAcquireRequest, ctx: AcquireContext): Promise<number>
}

const MIME_BY_EXT: Record<string, AcquiredPage['mime']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp' }

const DEFAULT_CAPS: ScannerCaps = { resolutions: [100, 150, 200, 300, 600], colorModes: ['color', 'gray', 'bw'], sources: ['flatbed'], duplex: false }

// ---- helper-process based backends (WIA + macOS) -------------------------------------------------------------

type SpecBuilder = (cmd: WiaCommand) => HelperSpec

/** Reads a page file a helper announced. The path must lie inside the job directory (a helper cannot make us read elsewhere). */
export async function readAnnouncedPage(dir: string, m: Extract<ProtocolMessage, { type: 'page' }>, fallbackDpi: number): Promise<AcquiredPage> {
  const root = resolve(dir) + sep
  const file = resolve(m.file)
  if (!file.startsWith(root)) throw new ScanError('general', 'The scanner produced a file outside its working folder; it was ignored.')
  const mime = MIME_BY_EXT[extname(file).toLowerCase()]
  if (!mime) throw new ScanError('unsupported')
  const bytes = new Uint8Array(await readFile(file))
  await rm(file, { force: true })
  return { index: m.index, mime, dpi: m.dpi ?? fallbackDpi, bytes }
}

function helperBackend(id: 'wia' | 'mac', spec: SpecBuilder): ScanBackend {
  return {
    id,
    async listDevices(signal) {
      const r = await runHelper(spec({ command: 'list' }), { signal, idleTimeoutMs: 45_000 })
      const m = r.messages.find((x): x is Extract<ProtocolMessage, { type: 'devices' }> => x.type === 'devices')
      return m ? m.devices : []
    },
    async capabilities(deviceId, signal) {
      try {
        const r = await runHelper(spec({ command: 'caps', deviceId }), { signal, idleTimeoutMs: 45_000 })
        const m = r.messages.find((x): x is Extract<ProtocolMessage, { type: 'caps' }> => x.type === 'caps')
        if (!m) return DEFAULT_CAPS
        return {
          resolutions: offeredResolutions(m.resolutions),
          colorModes: m.colorModes.length ? m.colorModes : DEFAULT_CAPS.colorModes,
          sources: m.sources.length ? m.sources : ['flatbed'],
          duplex: m.duplex
        }
      } catch (err) {
        if (signal?.aborted) throw err
        // Reading capabilities is a convenience: fall back to safe defaults, scanning itself will report real problems.
        if (err instanceof ScanError && err.code === 'not_found') throw err
        return DEFAULT_CAPS
      }
    },
    async acquire(req, ctx) {
      await mkdir(ctx.tempDir, { recursive: true })
      let pages = 0
      await runHelper(spec({ command: 'scan', dir: ctx.tempDir, deviceId: req.deviceId, dpi: req.dpi, colorMode: req.colorMode, source: req.source, duplex: req.duplex, maxPages: req.maxPages }), {
        signal: ctx.signal,
        idleTimeoutMs: 5 * 60_000,
        onMessage: async (m) => {
          if (m.type === 'progress') ctx.progress(m.fraction ?? 0.1, m.message)
          else if (m.type === 'page') {
            const page = await readAnnouncedPage(ctx.tempDir, m, req.dpi)
            pages++
            ctx.progress(Math.min(0.9, 0.1 + pages * 0.1), `Received page ${pages}`)
            await ctx.onPage(page)
          }
        }
      })
      return pages
    }
  }
}

export const createWiaBackend = (env: NodeJS.ProcessEnv = process.env): ScanBackend => helperBackend('wia', (cmd) => buildWiaSpec(cmd, env))

/** How to launch the macOS helper (or a test double): a script path is run with Electron/Node, anything else is executed. */
export function macHelperSpec(path: string, cmd: WiaCommand, env: NodeJS.ProcessEnv = process.env): HelperSpec {
  const params = JSON.stringify(cmd)
  if (/\.(mjs|cjs|js)$/i.test(path)) return { file: process.execPath, args: [path, cmd.command], env: { ...env, ELECTRON_RUN_AS_NODE: '1', EPDF_SCAN_PARAMS: params } }
  return { file: path, args: [cmd.command], env: { ...env, EPDF_SCAN_PARAMS: params } }
}

export const createMacBackend = (helperPath: string, env: NodeJS.ProcessEnv = process.env): ScanBackend => helperBackend('mac', (cmd) => macHelperSpec(helperPath, cmd, env))

// ---- the test scanner ------------------------------------------------------------------------------------------

export const STUB_DEVICE_ID = 'epdf-stub:0'

export async function listStubImages(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names.filter((n) => MIME_BY_EXT[extname(n).toLowerCase()]).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

export function createStubBackend(dir: string, env: NodeJS.ProcessEnv = process.env): ScanBackend {
  let flatbedNext = 0
  const delay = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((res, rej) => {
      if (signal.aborted) return rej(new Error('Cancelled'))
      const onAbort = (): void => {
        clearTimeout(t)
        rej(new Error('Cancelled'))
      }
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        res()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  return {
    id: 'stub',
    async listDevices() {
      return [{ id: STUB_DEVICE_ID, name: 'Test scanner (image folder)', manufacturer: 'Epdf' }]
    },
    async capabilities(deviceId) {
      if (deviceId !== STUB_DEVICE_ID) throw new ScanError('not_found')
      return { resolutions: [100, 200, 300], colorModes: ['color', 'gray', 'bw'], sources: ['flatbed', 'feeder'], duplex: true }
    },
    async acquire(req, ctx) {
      if (req.deviceId !== STUB_DEVICE_ID) throw new ScanError('not_found')
      const simulated = env['EPDF_SCANNER_STUB_ERROR']
      if (simulated) {
        const code = (simulated in SCAN_ERROR_TEXT ? simulated : 'general') as ScanErrorCode
        throw new ScanError(code)
      }
      const files = await listStubImages(dir)
      if (files.length === 0) throw new ScanError('no_paper', 'The test scanner folder contains no pictures (png, jpg or bmp).')
      const wait = Number(env['EPDF_SCANNER_STUB_DELAY_MS'] ?? 0)
      const chosen = req.source === 'feeder' ? files.slice(0, req.maxPages) : [files[flatbedNext++ % files.length]]
      let n = 0
      for (const name of chosen) {
        if (ctx.signal.aborted) throw new Error('Cancelled')
        ctx.progress(n / chosen.length, `Scanning page ${n + 1}`)
        if (wait > 0) await delay(wait, ctx.signal)
        const bytes = new Uint8Array(await readFile(join(dir, name)))
        n++
        await ctx.onPage({ index: n, mime: MIME_BY_EXT[extname(name).toLowerCase()], dpi: req.dpi, bytes })
      }
      return n
    }
  }
}

// ---- selection ---------------------------------------------------------------------------------------------------

export interface BackendChoice {
  backend: ScanBackend | null
  id: ScanBackendId
  stub: boolean
  message?: string
}

export function chooseBackend(opts: { platform: NodeJS.Platform; env?: NodeJS.ProcessEnv; macHelperPath?: string | null }): BackendChoice {
  const env = opts.env ?? process.env
  const stubDir = env['EPDF_SCANNER_STUB']
  if (stubDir) return { backend: createStubBackend(stubDir, env), id: 'stub', stub: true }
  if (opts.platform === 'win32') return { backend: createWiaBackend(env), id: 'wia', stub: false }
  const macOverride = env['EPDF_MAC_SCAN_HELPER']
  if (opts.platform === 'darwin' || macOverride) {
    const helper = macOverride || opts.macHelperPath
    if (helper) return { backend: createMacBackend(helper, env), id: 'mac', stub: false }
    return {
      backend: null,
      id: 'none',
      stub: false,
      message: 'Scanner support on macOS needs the helper program that ships with Epdf, and it was not found in this copy. You can still use a webcam or your phone.'
    }
  }
  return {
    backend: null,
    id: 'none',
    stub: false,
    message: 'Scanning from a scanner is not supported on Linux in this version of Epdf. You can still use a webcam or your phone.'
  }
}
