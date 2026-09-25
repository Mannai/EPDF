import { BrowserWindow, dialog } from 'electron'
import { basename, dirname, extname, join } from 'node:path'
import { CsvSaveSchema, type CsvSaveResult } from '../../../shared/features/formbuilder'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { atomicWrite } from '../../services/fileService'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'

/**
 * Main half of the form builder: the Tools menu entries and the "export field list" save step. All PDF work
 * (detection, creating fields, properties) happens in the renderer through the edit pipeline; main only
 * chooses the destination of the CSV (never taken from the renderer) and writes it atomically.
 */
export function register(ctx: MainContext): void {
  registerFeatureChannel('formbuilder:saveCsv', CsvSaveSchema, async ({ docId, text }, { window }): Promise<CsvSaveResult | null> => {
    const docPath = ctx.pathOfDoc(docId)
    if (!docPath) throw new Error('That document is no longer open.')
    const parent = window?.win ?? BrowserWindow.getFocusedWindow() ?? undefined
    const opts: Electron.SaveDialogOptions = {
      title: 'Export list of form fields',
      defaultPath: join(dirname(docPath), `${basename(docPath, extname(docPath))}-fields.csv`),
      filters: [{ name: 'CSV files', extensions: ['csv'] }]
    }
    const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    const target = extname(res.filePath).toLowerCase() === '.csv' ? res.filePath : `${res.filePath}.csv`
    await atomicWrite(target, new Uint8Array(Buffer.from(`﻿${text}`, 'utf8')))
    return { path: target, name: basename(target) }
  })

  contributeMenu({
    menu: 'Tools',
    items: () => [
      { type: 'separator' },
      commandItem('Prepare Form…', 'formbuilder.prepare'),
      commandItem('Detect Form Fields…', 'formbuilder.detect')
    ]
  })
}
