import { errorMessage, notify } from '../../state/notify'
import { registerCommand, registerDialog } from '../api'
import { ScanDialogHost } from './ScanDialog'
import { openScanDialog } from './pages'

/**
 * File ▸ Scan to PDF… (menu item contributed by src/main/features/scan/index.ts). One dialog with three steps:
 * Capture (scanner, webcam or phone over the local network), Adjust (corners, rotate, clean-up) and Save
 * (new PDF, or add to the open document). Image work runs in a Web Worker (./worker/scanWorker.ts).
 */
registerCommand({
  id: 'scan.open',
  label: 'Scan to PDF…',
  run: () => openScanDialog().catch((err) => notify('error', errorMessage(err)))
})
registerDialog(ScanDialogHost)
