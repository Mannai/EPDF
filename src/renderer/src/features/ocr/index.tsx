import { OCR_CHANNELS, selectPages, type LanguagesResponse } from '@shared/features/ocr'
import { activeTab } from '../../state/actions'
import { notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { registerCommand, registerDialog } from '../api'
import { OcrDialog } from './OcrDialog'
import { clean, runOcr, type OcrOutcome } from './flow'
import { useOcrUi } from './store'

/**
 * Tools ▸ Recognize Text (OCR)… (the menu item is contributed by src/main/features/ocr/index.ts).
 *
 * Other features can start OCR through the command:
 *   runCommand('ocr.run', { docId })                                  // opens the dialog for that document
 *   runCommand('ocr.run', { docId, silent: true })                    // no dialog: all pages, saved languages
 *   runCommand('ocr.run', { docId, silent: true, languages: ['deu'] })
 * `silent` skips the dialog and the success toast; errors are still reported. Pages that already have text are
 * skipped unless the saved "force" option is on.
 */

export interface OcrCommandArgs {
  docId?: string
  languages?: string[]
  silent?: boolean
}

async function run(args?: unknown): Promise<void> {
  const a = (args && typeof args === 'object' ? args : {}) as OcrCommandArgs
  const tab = a.docId ? useTabs.getState().tabs.find((t) => t.docId === a.docId) : activeTab()
  if (!tab) return void notify('info', 'Open a document first to recognize its text.')
  if (!a.silent) {
    await useOcrUi.getState().show(tab.docId, tab.numPages, tab.view.page)
    return
  }
  let prefs
  let known: LanguagesResponse
  try {
    known = await window.epdf.call<LanguagesResponse>(OCR_CHANNELS.languages, {})
    prefs = known.prefs
  } catch (err) {
    return void notify('error', clean(err))
  }
  const sel = selectPages({ mode: 'all' }, tab.numPages)
  if (!sel.ok) return void notify('error', sel.error)
  const languages = a.languages?.length ? a.languages : prefs.languages
  await runOcr({ docId: tab.docId, pages: sel.pages, languages, prefs, silent: true })
}

registerCommand({ id: 'ocr.run', label: 'Recognize Text (OCR)…', run })
registerDialog(OcrDialog)

export type { OcrOutcome }
