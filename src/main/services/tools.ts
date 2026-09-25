import { app } from 'electron'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Finds a native helper tool (qpdf, tesseract, soffice, ...). Search order:
 *   1. `EPDF_TOOL_<NAME>` environment variable (tests / power users)
 *   2. bundled: `<resources>/bin/<name>` when packaged, `resources/bin/<platform>-<arch>/<name>` in dev
 *      (`extraResources` in electron-builder.yml copies `resources/bin/<platform>-<arch>` to `<resources>/bin`)
 *   3. the system PATH
 * Returns null if the tool is not available; callers must show a clear "X is not installed" message.
 */
export function resolveTool(name: string): string | null {
  const fromEnv = process.env[`EPDF_TOOL_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
  if (fromEnv && isExecutable(fromEnv)) return fromEnv

  const bundledDir = app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(app.getAppPath(), 'resources', 'bin', `${process.platform}-${process.arch}`)
  const bundled = join(bundledDir, exe(name))
  if (isExecutable(bundled)) return bundled

  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exe(name))
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** Like `resolveTool` but throws an error whose message is safe to show to the user. */
export function requireTool(name: string, purpose: string): string {
  const p = resolveTool(name)
  if (!p) throw new Error(`${purpose} needs “${name}”, which is not installed with this copy of Epdf.`)
  return p
}
