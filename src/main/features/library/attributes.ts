import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Windows file attribute words for a batch of paths, via PowerShell's `Get-Item` (which reads metadata only and
 * never downloads a cloud placeholder). Paths travel in a UTF-8 file, not on the command line, so any file name
 * is safe. PowerShell ships with Windows; when it is missing or fails the caller falls back to treating suspects
 * as cloud-only, so this is an accuracy aid, never a requirement.
 */

const SCRIPT =
  "$ErrorActionPreference = 'Stop'; foreach ($p in [System.IO.File]::ReadAllLines($env:EPDF_PATHS_FILE, [System.Text.Encoding]::UTF8)) { " +
  "try { [int](Get-Item -LiteralPath $p -Force).Attributes } catch { -1 } }"

const BATCH = 400

export async function readWindowsAttributes(paths: string[], timeoutMs = 30_000): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (process.platform !== 'win32') return out
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'epdf-attrs-'))
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH)
      const file = join(dir, `paths-${i}.txt`)
      await writeFile(file, chunk.join('\n'), 'utf8')
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
          { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, EPDF_PATHS_FILE: file } },
          (err, so) => (err ? reject(err) : resolve(String(so)))
        )
      }).catch(() => '')
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
      chunk.forEach((p, idx) => {
        const n = lines.length === chunk.length ? Number(lines[idx]) : NaN
        out.set(p, Number.isFinite(n) && n >= 0 ? n : null)
      })
    }
  } catch {
    /* unknown attributes: callers treat null as "cannot tell" */
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  return out
}
