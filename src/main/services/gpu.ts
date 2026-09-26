import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * "Use hardware acceleration" (View menu). Some setups make Chromium's GPU compositing flash black or stop repainting:
 * notably a Remote Desktop session (the RDP client re-encodes GPU-composited windows) and some graphics drivers.
 * Turning acceleration off draws with the CPU instead, which costs little in a PDF viewer (pages are rendered on the
 * CPU by PDF.js either way). The choice must be known before the app is ready, so it lives in a tiny file next to the
 * database rather than in SQLite.
 *
 *  - An explicit choice in the View menu always wins.
 *  - Otherwise it is on, except in a Windows Remote Desktop session, where it defaults to off.
 *  - `--disable-gpu` on the command line forces it off for one run.
 */
const file = (): string => join(app.getPath('userData'), 'gpu.json')

export const isRemoteSession = (env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean =>
  platform === 'win32' && /^RDP-/i.test(env['SESSIONNAME'] ?? '')

/** The saved choice, or null when the user has never chosen. */
function savedChoice(): boolean | null {
  try {
    if (!existsSync(file())) return null
    const v = (JSON.parse(readFileSync(file(), 'utf8')) as { hardwareAcceleration?: unknown }).hardwareAcceleration
    return typeof v === 'boolean' ? v : null
  } catch {
    return null
  }
}

export function hardwareAccelerationEnabled(): boolean {
  if (process.argv.includes('--disable-gpu')) return false
  return savedChoice() ?? !isRemoteSession()
}

export function setHardwareAcceleration(on: boolean): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify({ hardwareAcceleration: on }))
}

/** Call once, before `app.whenReady()`. */
export function applyHardwareAccelerationChoice(): void {
  if (!hardwareAccelerationEnabled()) app.disableHardwareAcceleration()
}
