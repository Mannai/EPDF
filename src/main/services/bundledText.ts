import { app, dialog, shell } from 'electron'
import { join } from 'node:path'

export type BundledText = 'LICENSE' | 'EULA' | 'THIRD-PARTY-NOTICES'

/** A text file that ships next to the app (see extraResources); unpackaged runs use the source or build output. */
export function bundledTextPath(name: BundledText): string {
  const dev = { LICENSE: 'LICENSE.md', EULA: 'build/license.txt', 'THIRD-PARTY-NOTICES': `out/${name}.txt` }
  return app.isPackaged ? join(process.resourcesPath, `${name}.txt`) : join(app.getAppPath(), dev[name])
}

/** Opens it in the system's text viewer. */
export async function openBundledText(name: BundledText): Promise<void> {
  const error = await shell.openPath(bundledTextPath(name))
  if (error) dialog.showErrorBox('Epdf', `Could not open ${name}.\n\n${error}`)
}
