import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The text Windows' own PDF engine extracts (the search filter of Windows.Data.Pdf.dll, what Windows Search indexes),
 * through scripts/ifilter-text.ps1. Null when not on Windows or when the filter is missing (N editions, Server core).
 * The filter joins the whole page into one paragraph.
 */
export function windowsText(bytes: Uint8Array): string | null {
  if (process.platform !== 'win32') return null
  const dir = mkdtempSync(join(tmpdir(), 'epdf-ifilter-'))
  try {
    writeFileSync(join(dir, 'a.pdf'), bytes)
    execFileSync('powershell', ['-NoProfile', '-File', resolve('scripts/ifilter-text.ps1'), '-Pdf', join(dir, 'a.pdf'), '-Out', join(dir, 'a.txt')], { stdio: 'pipe' })
    return readFileSync(join(dir, 'a.txt'), 'utf8')
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
