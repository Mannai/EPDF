import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * LibreOffice for CROSS-CHECKING in tests only (the product never needs it). Tests that use it must skip when
 * `HAVE_SOFFICE` is false. One soffice at a time (a cross-process lock shared with the other comparison tests), a
 * throw-away profile per run, temp files removed.
 */

export { HAVE_SOFFICE, SOFFICE } from './tools'
import { SOFFICE } from './tools'
const LOCK = join(tmpdir(), 'epdf-soffice.lock')

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(LOCK)
      break
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 10 * 60_000) rmSync(LOCK, { recursive: true, force: true })
      } catch {
        /* raced with the owner */
      }
      if (Date.now() - start > 8 * 60_000) throw new Error('timed out waiting for the soffice lock')
      await new Promise((r) => setTimeout(r, 700))
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(LOCK, { recursive: true, force: true })
  }
}

/** Converts `bytes` (a file called `name`) to PDF with LibreOffice. */
export function libreOfficePdf(name: string, bytes: Uint8Array): Promise<Uint8Array> {
  return withLock(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-lo-rtl-'))
    try {
      const input = join(dir, name)
      writeFileSync(input, bytes)
      const out = join(dir, 'out')
      mkdirSync(out)
      await new Promise<void>((res, rej) =>
        execFile(SOFFICE, ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--convert-to', 'pdf', '--outdir', out, input], { timeout: 180_000, windowsHide: true }, (err) =>
          err ? rej(err) : res()
        )
      )
      return new Uint8Array(readFileSync(join(out, name.replace(/\.[^.]+$/, '.pdf'))))
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  })
}
