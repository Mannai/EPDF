import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUNDLED_FONT_FILES, FontRequestSchema, type BundledFontName } from '../../../shared/features/forms'
import { commandItem, contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'

/**
 * Main-process half of "forms": the bundled fonts (channel `forms:font`) and menu items. Filling forms and
 * stamping text happen in the renderer through the edit pipeline (`editPdf`), so nothing here reads or
 * writes a PDF.
 */

const fontsDir = (): string => (app.isPackaged ? join(process.resourcesPath, 'fonts') : join(app.getAppPath(), 'resources', 'fonts'))

const cache = new Map<BundledFontName, Promise<Uint8Array>>()

/** Font bytes by bundled name (never by path). Cached: the files are static. */
export function readBundledFont(name: BundledFontName): Promise<Uint8Array> {
  let p = cache.get(name)
  if (!p) {
    p = readFile(join(fontsDir(), BUNDLED_FONT_FILES[name])).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
    p.catch(() => cache.delete(name))
    cache.set(name, p)
  }
  return p
}

export function register(_ctx: MainContext): void {
  registerFeatureChannel('forms:font', FontRequestSchema, ({ name }) => readBundledFont(name))

  contributeMenu({
    menu: 'Tools',
    items: () => [
      { type: 'separator' },
      commandItem('Highlight Form Fields', 'forms.toggleHighlight'),
      commandItem('Add Text', 'forms.activateAddText')
    ]
  })
}
