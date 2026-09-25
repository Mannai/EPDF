import { registerCommand, registerDialog } from '../api'
import { CreateFilesDialog, CreateWebDialog } from './CreateDialog'
import { startCreateFromFiles, startCreateFromWeb } from './flow'
import { ResultDialogHost } from './ResultDialog'

/**
 * File ▸ Create PDF from File… / Create PDF from Web Page… (menu items are contributed by
 * src/main/features/create/index.ts). Files are chosen in a native dialog in main, which hands back opaque ids;
 * conversion runs as a background job with progress and Cancel in the jobs tray.
 */
registerCommand({ id: 'create.fromFiles', label: 'Create PDF from File…', run: () => startCreateFromFiles() })
registerCommand({ id: 'create.fromWeb', label: 'Create PDF from Web Page…', run: () => startCreateFromWeb() })
registerDialog(CreateFilesDialog)
registerDialog(CreateWebDialog)
registerDialog(ResultDialogHost)
