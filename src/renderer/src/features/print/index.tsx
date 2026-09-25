import { activeTab } from '../../state/actions'
import { registerCommand, registerDialog } from '../api'
import { PrintDialog } from './PrintDialog'
import { usePrintDialog } from './store'

/**
 * Printing (File ▸ Print…, Ctrl/Cmd+P) and Print to PDF. See pipeline.ts for how pages reach the printer and
 * src/main/features/print for the native side (system print dialog, EPDF_PRINT_TO_FILE test hook).
 */

registerDialog(PrintDialog)

const open = (mode: 'print' | 'pdf') => (): void => {
  const t = activeTab()
  if (t && t.status === 'ready' && t.numPages > 0) usePrintDialog.getState().open(t.docId, mode)
}

registerCommand({ id: 'print.open', label: 'Print', run: open('print') })
registerCommand({ id: 'print.toPdf', label: 'Print to PDF', run: open('pdf') })
