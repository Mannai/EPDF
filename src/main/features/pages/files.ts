import { BrowserWindow, dialog } from 'electron'
import { open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { FeatureCallContext, MainContext } from '../api'
import { partFileNames, sanitizeFileName, uniqueFileName } from '../../../shared/features/pages/filenames'
import type { PickedFolder, PickedPdf, SavedFile } from '../../../shared/features/pages'
import { issueToken } from './tokens'
import type { SplitPartOut } from './splitJob'

/** File-system side of the page tools: native dialogs and safe writing. Never takes a path from the renderer. */

const MAX_PICKED_BYTES = 1024 * 1024 * 1024 // refuse to load more than 1 GB into memory for an insert

const parentOf = (ctx: FeatureCallContext): BrowserWindow | undefined => ctx.window?.win

/** Native "open PDF" dialog; returns the file's bytes (the renderer never learns its path). Null if cancelled. */
export async function pickPdf(ctx: FeatureCallContext): Promise<PickedPdf | null> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose the PDF to take pages from',
    properties: ['openFile'],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
  }
  const parent = parentOf(ctx)
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) return null
  const path = res.filePaths[0]
  const st = await stat(path)
  if (!st.isFile()) throw new Error('That is not a file.')
  if (st.size > MAX_PICKED_BYTES) throw new Error('That file is too large to insert pages from.')
  return { name: basename(path), bytes: new Uint8Array(await readFile(path)) }
}

/** Native folder chooser. The result is a token main can turn back into the path. */
export async function pickFolder(ctx: FeatureCallContext): Promise<PickedFolder | null> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose the folder for the new files',
    properties: ['openDirectory', 'createDirectory']
  }
  const parent = parentOf(ctx)
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) return null
  const path = res.filePaths[0]
  return { token: issueToken({ path, kind: 'folder' }), name: basename(path) || path }
}

/** Native save dialog, then writes `bytes` there. Returns a token for the written file. Null if cancelled. */
export async function saveBytesWithDialog(
  main: MainContext,
  ctx: FeatureCallContext,
  req: { docId: string; bytes: Uint8Array; suggestedName: string }
): Promise<SavedFile | null> {
  const docPath = main.pathOfDoc(req.docId)
  const name = `${sanitizeFileName(req.suggestedName.replace(/\.pdf$/i, ''), { fallback: 'document', maxLength: 120 })}.pdf`
  const opts: Electron.SaveDialogOptions = {
    defaultPath: docPath ? join(dirname(docPath), name) : name,
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
  }
  const parent = parentOf(ctx)
  const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  const target = /\.pdf$/i.test(res.filePath) ? res.filePath : `${res.filePath}.pdf`
  const { size } = await main.files.writeNew(target, req.bytes)
  return { token: issueToken({ path: target, kind: 'file' }), name: basename(target), size }
}

export interface WrittenFile {
  name: string
  path: string
  size: number
}

/**
 * Writes the parts of a split into `dir` under safe, unique names. Existing files are never overwritten
 * (a clashing name gets " (2)"...; the file is created exclusively, so even a file that appears while we
 * work is not clobbered). If the job is cancelled or a write fails, the files created so far are removed.
 */
export async function writeSplitFiles(dir: string, baseName: string, parts: SplitPartOut[], signal: AbortSignal): Promise<WrittenFile[]> {
  const root = resolve(dir)
  const existing = await readdir(root).catch(() => {
    throw new Error('The chosen folder is not available.')
  })
  const names = partFileNames(
    baseName,
    parts.map((p) => p.label),
    existing
  )
  const taken = new Set([...existing, ...names].map((s) => s.toLowerCase()))
  const written: WrittenFile[] = []
  try {
    for (let i = 0; i < parts.length; i++) {
      if (signal.aborted) throw new Error('Cancelled')
      let name = names[i]
      for (let attempt = 0; ; attempt++) {
        const path = resolve(root, name)
        if (dirname(path) !== root && !path.startsWith(root + sep)) throw new Error('Refusing to write outside the chosen folder.')
        try {
          const fh = await open(path, 'wx') // fails if it exists
          try {
            await fh.writeFile(parts[i].bytes)
            await fh.sync()
          } finally {
            await fh.close()
          }
          written.push({ name, path, size: parts[i].bytes.length })
          break
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 50) throw err
          name = uniqueFileName(name.replace(/\.pdf$/i, ''), '.pdf', taken)
        }
      }
    }
    return written
  } catch (err) {
    for (const w of written) await rm(w.path, { force: true }).catch(() => undefined)
    throw err
  }
}
