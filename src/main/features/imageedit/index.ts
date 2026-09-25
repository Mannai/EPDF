import { dialog } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import type { PickedImage } from '../../../shared/features/imageedit'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'

/**
 * Main-process half of "Edit images": a native open dialog that returns the chosen picture's bytes.
 * The renderer never supplies a path; it can only ask for the dialog and receives the file the user picked.
 */

const MAX_BYTES = 40 * 1024 * 1024
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function detectKind(b: Uint8Array): 'png' | 'jpg' | null {
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'png'
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  return null
}

export function register(_ctx: MainContext): void {
  registerFeatureChannel('imageedit:pickImage', z.object({}).strict(), async (_req, { window }): Promise<PickedImage | null> => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose an image',
      properties: ['openFile'],
      filters: [
        { name: 'Images (PNG, JPEG)', extensions: ['png', 'jpg', 'jpeg'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const res = window ? await dialog.showOpenDialog(window.win, options) : await dialog.showOpenDialog(options)
    const path = res.filePaths[0]
    if (res.canceled || !path) return null
    const st = await stat(path)
    if (!st.isFile()) throw new Error('That is not a file.')
    if (st.size > MAX_BYTES) throw new Error('That image is larger than 40 MB.')
    const buf = await readFile(path)
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length)
    const kind = detectKind(bytes)
    if (!kind) throw new Error('That file is not a PNG or JPEG image.')
    return { name: basename(path), kind, bytes }
  })
}
