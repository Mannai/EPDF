import { registerCommand, registerDialog } from '../api'
import { ExportDialogHost } from './ExportDialog'
import { openExportDialog } from './flow'

/**
 * File ▸ Export To ▸ Word / Excel / PowerPoint. The menu items are contributed by
 * src/main/features/export/index.ts and call these commands. Everything runs locally: PDF.js reads the
 * document, our own OOXML writers produce the file, main asks where to save it.
 */
registerCommand({ id: 'export.docx', label: 'Export to Word (.docx)', run: () => openExportDialog('docx') })
registerCommand({ id: 'export.xlsx', label: 'Export to Excel (.xlsx)', run: () => openExportDialog('xlsx') })
registerCommand({ id: 'export.pptx', label: 'Export to PowerPoint (.pptx)', run: () => openExportDialog('pptx') })
registerDialog(ExportDialogHost)
