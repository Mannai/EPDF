import { dialog, type OpenDialogOptions } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename } from 'node:path'
import { z } from 'zod'
import { commandItem, contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'
import { MAX_STAMP_IMAGE_BYTES, sniffImage, systemUserName } from './image'

/**
 * Main-process half of Comments and markup. Everything else (reading and writing annotations) happens in
 * the renderer through the edit pipeline; main only provides what the sandboxed renderer cannot:
 *  - the OS user name (default author), and
 *  - a native file dialog for the custom image stamp. The renderer never supplies a path: main shows
 *    the dialog, validates the chosen file's signature and size, and returns its bytes.
 */
export function register(_ctx: MainContext): void {
  registerFeatureChannel('markup:defaultAuthor', z.object({}).strict(), () => systemUserName(userInfo))

  // `.strict()`: a payload carrying a path (or anything else) is rejected, so the renderer cannot steer the dialog.
  registerFeatureChannel('markup:pickImage', z.object({}).strict(), async (_req, { window }) => {
    const opts: OpenDialogOptions = {
      title: 'Choose an image for the stamp',
      properties: ['openFile'],
      filters: [{ name: 'PNG or JPEG images', extensions: ['png', 'jpg', 'jpeg'] }]
    }
    const res = window ? await dialog.showOpenDialog(window.win, opts) : await dialog.showOpenDialog(opts)
    const path = res.filePaths[0]
    if (res.canceled || !path) return null
    if ((await stat(path)).size > MAX_STAMP_IMAGE_BYTES) throw new Error('That image is larger than 25 MB.')
    const bytes = new Uint8Array(await readFile(path))
    const kind = sniffImage(bytes)
    if (!kind) throw new Error('Choose a PNG or JPEG image.')
    return { name: basename(path), kind, bytes }
  })

  contributeMenu({ menu: 'View', position: 'end', items: () => [{ type: 'separator' }, commandItem('Comments Panel', 'markup.toggleComments')] })
}
