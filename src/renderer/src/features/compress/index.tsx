import { registerCommand, registerDialog } from '../api'
import { CompressDialog } from './CompressDialog'
import { openCompress } from './store'

/**
 * File > Reduce File Size... (the menu item is contributed by src/main/features/compress). All the work happens in a Web
 * Worker (./worker.ts) using the pure logic in ./pdf; nothing here touches the file system or the network.
 */
registerCommand({ id: 'compress.open', label: 'Reduce File Size…', run: () => void openCompress() })
registerDialog(CompressDialog)
