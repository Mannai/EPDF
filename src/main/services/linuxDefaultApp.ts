import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/**
 * "Set as Default PDF App" on Linux: the freedesktop way is `xdg-mime default <desktop entry> application/pdf`,
 * which only needs the desktop entry the .deb installs (epdf.desktop). An AppImage run without desktop integration
 * has no entry, so the user is shown how to do it from the file manager instead.
 */

export const LINUX_MANUAL_STEPS =
  'In your file manager, right-click any PDF, choose “Open With” (or Properties ▸ Open With), pick Epdf and make it the default.'

/** Folders that hold desktop entries, most specific first (XDG base directories). */
export function applicationDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dataHome = env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share')
  const dataDirs = (env['XDG_DATA_DIRS'] || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [dataHome, ...dataDirs].map((d) => join(d, 'applications'))
}

/**
 * The desktop entry that starts this Epdf: `epdf.desktop` (what the .deb installs), or any entry whose Exec runs
 * `execPath`. Returns its file name (the id xdg-mime wants), or null.
 */
export function findDesktopEntry(
  execPath: string,
  dirs: string[],
  fs: { exists(p: string): boolean; read(p: string): string } = { exists: existsSync, read: (p) => readFileSync(p, 'utf8') }
): string | null {
  for (const dir of dirs) {
    const p = join(dir, 'epdf.desktop')
    if (fs.exists(p)) return 'epdf.desktop'
  }
  const exe = basename(execPath)
  for (const dir of dirs) {
    for (const name of ['Epdf.desktop', 'epdf-app.desktop']) {
      const p = join(dir, name)
      if (!fs.exists(p)) continue
      const exec = /^Exec=(.*)$/m.exec(fs.read(p))?.[1] ?? ''
      if (exec.includes(execPath) || exec.split(/\s+/)[0]?.endsWith(exe)) return name
    }
  }
  return null
}

/** Makes `entry` the default for PDFs (no shell: the entry id is a separate argument). */
export function setDefaultPdfEntry(entry: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile('xdg-mime', ['default', entry, 'application/pdf'], { timeout: 15_000 }, (err, _out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve()
    )
  )
}
