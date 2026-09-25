import { BrowserWindow, dialog } from 'electron'
import { basename, dirname, extname, join } from 'node:path'
import { EXPORT_LABEL, ExportSaveSchema, type ExportSaveResult } from '../../../shared/features/export'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { atomicWrite } from '../../services/fileService'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'

/**
 * Main half of "Export To": the File ▸ Export To submenu and the save step. Content extraction and the OOXML
 * writing happen in the renderer; main only chooses the destination (never taken from the renderer) and
 * writes the finished file atomically.
 */

const FORMAT_INFO = {
  docx: { ext: 'docx', filter: 'Word documents' },
  xlsx: { ext: 'xlsx', filter: 'Excel workbooks' },
  pptx: { ext: 'pptx', filter: 'PowerPoint presentations' }
} as const

export function register(ctx: MainContext): void {
  registerFeatureChannel('export:save', ExportSaveSchema, async ({ docId, format, bytes }, { window }): Promise<ExportSaveResult | null> => {
    const docPath = ctx.pathOfDoc(docId)
    if (!docPath) throw new Error('That document is no longer open.')
    const { ext, filter } = FORMAT_INFO[format]
    const base = basename(docPath, extname(docPath))
    const parent = window?.win ?? BrowserWindow.getFocusedWindow() ?? undefined
    const opts: Electron.SaveDialogOptions = {
      title: `Export to ${EXPORT_LABEL[format]}`,
      defaultPath: join(dirname(docPath), `${base}.${ext}`),
      filters: [{ name: filter, extensions: [ext] }]
    }
    const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    const target = extname(res.filePath).toLowerCase() === `.${ext}` ? res.filePath : `${res.filePath}.${ext}`
    await atomicWrite(target, bytes)
    return { path: target, name: basename(target) }
  })

  contributeMenu({
    menu: 'File',
    position: 'start',
    items: () => [
      {
        label: 'Export To',
        submenu: [
          commandItem('Word (.docx)', 'export.docx'),
          commandItem('Excel (.xlsx)', 'export.xlsx'),
          commandItem('PowerPoint (.pptx)', 'export.pptx')
        ]
      }
    ]
  })
}
