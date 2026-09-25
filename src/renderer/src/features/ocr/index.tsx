import { registerCommand, registerDialog } from '../api'
import { runOcrCommand } from './command'
import { OcrDialog } from './OcrDialog'

/**
 * Tools ▸ Recognize Text (OCR)… (the menu item is contributed by src/main/features/ocr/index.ts).
 * Other features start OCR through the `ocr.run` command; see ./command.ts for its arguments.
 */
registerCommand({ id: 'ocr.run', label: 'Recognize Text (OCR)…', run: runOcrCommand })
registerDialog(OcrDialog)
