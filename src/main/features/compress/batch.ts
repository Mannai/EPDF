import { BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MAX_BATCH_FILES, MAX_BATCH_FILE_BYTES, type BatchPicked, type BatchRead, type BatchWritten } from '../../../shared/features/compress'
import type { FeatureCallContext } from '../api'

/**
 * File-system side of "Reduce File Size for several files". The renderer never supplies a path: files are chosen in a native
 * dialog, main hands back opaque tokens, and results are written as NEW files next to the originals
 * ("<name> (reduced).pdf", never overwriting anything).
 */

const MAX_TOKENS = 1000
const tokens = new Map<string, string>()

/** Hands out an opaque token for a path the user chose. (Exported for tests; only the file dialog calls it in the app.) */
export function issue(path: string): string {
  const t = randomUUID()
  tokens.set(t, path)
  if (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value as string)
  return t
}

/** Native multi-select "open PDFs" dialog. Null when cancelled. */
export async function pickFiles(ctx: FeatureCallContext): Promise<BatchPicked[] | null> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose the PDF files to reduce',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
  }
  const parent: BrowserWindow | undefined = ctx.window?.win
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) return null
  const out: BatchPicked[] = []
  for (const p of res.filePaths.slice(0, MAX_BATCH_FILES)) {
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) continue
    out.push({ token: issue(p), name: basename(p), size: st.size })
  }
  return out
}

export async function readPicked(token: string): Promise<BatchRead> {
  const path = tokens.get(token)
  if (!path) throw new Error('That file is no longer available. Choose the files again.')
  const st = await stat(path).catch(() => null)
  if (!st?.isFile()) throw new Error('The file could not be found.')
  if (st.size > MAX_BATCH_FILE_BYTES) throw new Error('This file is too large to reduce (over 1 GB).')
  return { name: basename(path), bytes: new Uint8Array(await readFile(path)) }
}

/** `Report.pdf` -> `Report (reduced).pdf`, `Report (reduced 2).pdf`, ... in the same folder; created exclusively so nothing is overwritten. */
export async function writeReduced(token: string, bytes: Uint8Array): Promise<BatchWritten> {
  const source = tokens.get(token)
  if (!source) throw new Error('That file is no longer available. Choose the files again.')
  const dir = dirname(source)
  const stem = basename(source).replace(/\.pdf$/i, '')
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${stem} (reduced).pdf` : `${stem} (reduced ${n}).pdf`
    const path = join(dir, name)
    try {
      const fh = await open(path, 'wx')
      try {
        await fh.writeFile(bytes)
        await fh.sync()
      } finally {
        await fh.close()
      }
      return { name, size: bytes.length }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('Could not find a free name for the reduced copy.')
}
