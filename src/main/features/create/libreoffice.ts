import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { JobContext } from '../../jobs/JobManager'
import { runProcess as defaultRunProcess } from '../../jobs/workerRunner'

/**
 * OPTIONAL high-fidelity Office engine: runs an installed LibreOffice (`soffice`, MPL-2.0, never bundled or
 * modified by Epdf) headless. It is used only when LibreOffice is found AND the user chose it; the built-in
 * converter (./office) is the default and never depends on this.
 */

export const SOFFICE_TIMEOUT_MS = 180_000

/** Typical install locations, checked when `soffice` is not bundled, overridden or on PATH. */
export function wellKnownSofficePaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['ProgramW6432'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter((r): r is string => !!r)
    return [...new Set(roots)].map((r) => join(r, 'LibreOffice', 'program', 'soffice.exe'))
  }
  if (platform === 'darwin') return ['/Applications/LibreOffice.app/Contents/MacOS/soffice', join(env['HOME'] ?? '', 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')]
  return ['/usr/bin/soffice', '/usr/local/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice.soffice']
}

const isFile = (p: string): boolean => {
  try {
    accessSync(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface DiscoverOptions {
  /** `resolveTool('soffice')` from services/tools (env override, bundled copy, PATH). */
  resolveTool: (name: string) => string | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
}

/** Where LibreOffice is, or null. `EPDF_DISABLE_SOFFICE_DISCOVERY=1` restricts the search to the standard tool lookup (tests). */
export function discoverSoffice(o: DiscoverOptions): string | null {
  const env = o.env ?? process.env
  const found = o.resolveTool('soffice')
  if (found) return found
  if (env['EPDF_DISABLE_SOFFICE_DISCOVERY'] === '1') return null
  const exists = o.exists ?? isFile
  for (const p of wellKnownSofficePaths(o.platform ?? process.platform, env)) if (exists(p)) return p
  return null
}

export const SOFFICE_HELP =
  'Install LibreOffice (free, libreoffice.org) and choose it here, or copy soffice next to Epdf’s helper tools (resources/bin/<platform>-<arch>/), or point the EPDF_TOOL_SOFFICE environment variable at it.'

export const notInstalledMessage = (purpose: string): string => `${purpose} needs LibreOffice, which is not installed on this computer. ${SOFFICE_HELP} You can also switch back to Epdf’s built-in converter.`

export interface SofficeArgs {
  profileDir: string
  outDir: string
  inputPath: string
}

/** Argument array for a headless conversion. Never goes through a shell; the input is always an absolute path. */
export function buildSofficeArgs(a: SofficeArgs): string[] {
  return [
    `-env:UserInstallation=${pathToFileURL(a.profileDir).href}`,
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nologo',
    '--convert-to',
    'pdf',
    '--outdir',
    a.outDir,
    a.inputPath
  ]
}

/** Test/power-user hook: `EPDF_TOOL_SOFFICE` may be a .js/.mjs/.cjs script, run with Electron's/Node's own runtime. */
export function toolCommand(tool: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (/\.(c|m)?js$/i.test(tool)) return { file: process.execPath, args: [tool], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  return { file: tool, args: [], env: process.env }
}

const SAFE_EXT = /^[a-z0-9]{1,6}$/

export interface LibreOfficeJob {
  soffice: string
  inputPath: string
  inputName: string
  ctx: JobContext
  timeoutMs?: number
  tempRoot?: string
  runProcess?: typeof defaultRunProcess
}

export class LibreOfficeTimeout extends Error {}

/**
 * Converts one document to PDF with a private temp profile (so parallel runs and the user's own LibreOffice
 * never clash), a hard timeout, kill-on-cancel, and removal of every temp file afterwards.
 */
export async function convertWithLibreOffice(j: LibreOfficeJob): Promise<Uint8Array> {
  const run = j.runProcess ?? defaultRunProcess
  const root = await mkdtemp(join(j.tempRoot ?? tmpdir(), 'epdf-lo-'))
  const timeoutMs = j.timeoutMs ?? SOFFICE_TIMEOUT_MS
  const timeout = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    timeout.abort()
  }, timeoutMs)
  const onAbort = (): void => timeout.abort()
  j.ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const inDir = join(root, 'in')
    const outDir = join(root, 'out')
    const profileDir = join(root, 'profile')
    await Promise.all([mkdir(inDir), mkdir(outDir), mkdir(profileDir)])
    const extMatch = /\.([^./\\]+)$/.exec(j.inputName)
    const ext = extMatch && SAFE_EXT.test(extMatch[1].toLowerCase()) ? extMatch[1].toLowerCase() : 'bin'
    // A neutral name in a private folder: hostile or unusual file names never reach the command line.
    const inputPath = join(inDir, `document.${ext}`)
    await copyFile(j.inputPath, inputPath)
    j.ctx.progress(0.1, 'Starting LibreOffice')
    const cmd = toolCommand(j.soffice)
    try {
      await run(cmd.file, [...cmd.args, ...buildSofficeArgs({ profileDir, outDir, inputPath })], { signal: timeout.signal, progress: j.ctx.progress }, { env: cmd.env, cwd: root })
    } catch (err) {
      if (timedOut) throw new LibreOfficeTimeout(`LibreOffice did not finish converting “${j.inputName}” within ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.`)
      if (j.ctx.signal.aborted) throw new Error('Cancelled')
      const msg = err instanceof Error ? err.message : String(err)
      if (/ENOENT/.test(msg)) throw new Error(notInstalledMessage('Converting Office documents'))
      throw new Error(`LibreOffice could not convert “${j.inputName}”: ${msg.replace(/^.*failed:\s*/, '').slice(0, 300)}`)
    }
    j.ctx.progress(0.9, 'Reading result')
    try {
      return new Uint8Array(await readFile(join(outDir, 'document.pdf')))
    } catch {
      throw new Error(`LibreOffice finished but produced no PDF for “${j.inputName}”. The file may be damaged or password protected.`)
    }
  } finally {
    clearTimeout(timer)
    j.ctx.signal.removeEventListener('abort', onAbort)
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => undefined)
  }
}
