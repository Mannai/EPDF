import { registerCommand, registerDialog } from '../api'
import { CombineDialog } from './CombineDialog'
import { openCombine, takePendingCombine } from './flow'

/**
 * File ▸ Combine Files… (menu item contributed by src/main/features/create/index.ts). The command-line verb
 * `--combine <files…>` (used by the Explorer/Finder entry) makes main send `combine:pending`; the files are
 * fetched with `combine:takePending`, which also covers the window not being ready when the verb arrived.
 */
registerCommand({ id: 'combine.open', label: 'Combine Files…', run: () => openCombine() })
registerDialog(CombineDialog)

window.epdf.onFeature('combine:pending', () => void takePendingCombine())
void takePendingCombine()
