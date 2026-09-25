import { registerCommand, registerDialog } from '../api'
import { openBatch } from './batch'
import { BatchDialog } from './BatchDialog'
import { CompressDialog } from './CompressDialog'
import { openCompress } from './store'

/**
 * File > Reduce File Size... and File > Reduce Several Files... (the menu items are contributed by src/main/features/compress).
 * All the work happens in a Web Worker (./worker.ts) using the pure logic in ./pdf; the single-document mode touches neither the
 * file system nor the network, the batch mode reads and writes files only through main's tokenised channels.
 */
registerCommand({ id: 'compress.open', label: 'Reduce File Size…', run: () => void openCompress() })
registerCommand({ id: 'compress.batch', label: 'Reduce Several Files…', run: () => void openBatch() })
registerDialog(CompressDialog)
registerDialog(BatchDialog)
