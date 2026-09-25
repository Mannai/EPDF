import { BrowserWindow, dialog } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MAX_COMPARE_BYTES, PickCompareRequestSchema, SaveReportRequestSchema, type PickedCompareFile, type SavedReport } from '../../../shared/features/compare'
import { sanitizeFileName } from '../../../shared/features/pages/filenames'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { registerFeatureChannel, type FeatureCallContext, type MainContext } from '../api'

/**
 * Main-process half of Compare Files. The renderer never supplies a path: the "old version" comes from a native
 * open dialog (returning bytes only) and the report is written to wherever the user picks in a native save
 * dialog. Both dialogs are looked up through `electron.dialog` at call time so tests can stub them.
 */

const parentOf = (ctx: FeatureCallContext): BrowserWindow | undefined => ctx.window?.win

/** Native "open PDF" dialog; returns the file's name and bytes, or null if the user cancelled. */
async function pickFile(ctx: FeatureCallContext, side: 'old' | 'new'): Promise<PickedCompareFile | null> {
  const opts: Electron.OpenDialogOptions = {
    title: side === 'old' ? 'Choose the old version to compare with' : 'Choose the new version to compare with',
    properties: ['openFile'],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
  }
  const parent = parentOf(ctx)
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) return null
  const path = res.filePaths[0]
  const st = await stat(path)
  if (!st.isFile()) throw new Error('That is not a file.')
  if (st.size > MAX_COMPARE_BYTES) throw new Error('That file is too large to compare.')
  return { name: basename(path), bytes: new Uint8Array(await readFile(path)) }
}

async function saveReport(main: MainContext, ctx: FeatureCallContext, req: { docId: string; kind: 'pdf' | 'csv'; bytes: Uint8Array; suggestedName: string }): Promise<SavedReport | null> {
  const ext = req.kind
  const stem = sanitizeFileName(req.suggestedName.replace(/\.(pdf|csv)$/i, ''), { fallback: 'comparison', maxLength: 120 })
  const docPath = main.pathOfDoc(req.docId)
  const name = `${stem}.${ext}`
  const opts: Electron.SaveDialogOptions = {
    title: req.kind === 'pdf' ? 'Save the comparison report (PDF)' : 'Save the change list (CSV)',
    defaultPath: docPath ? join(dirname(docPath), name) : name,
    filters: [req.kind === 'pdf' ? { name: 'PDF documents', extensions: ['pdf'] } : { name: 'CSV spreadsheet', extensions: ['csv'] }]
  }
  const parent = parentOf(ctx)
  const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  const target = new RegExp(`\\.${ext}$`, 'i').test(res.filePath) ? res.filePath : `${res.filePath}.${ext}`
  const { size } = await main.files.writeNew(target, req.bytes)
  return { name: basename(target), size }
}

export function register(ctx: MainContext): void {
  registerFeatureChannel('compare:pickFile', PickCompareRequestSchema, ({ side }, call) => pickFile(call, side))
  registerFeatureChannel('compare:saveReport', SaveReportRequestSchema, (req, call) => saveReport(ctx, call, req))
  contributeMenu({ menu: 'Tools', items: () => [commandItem('Compare Files…', 'compare.open')] })
}
