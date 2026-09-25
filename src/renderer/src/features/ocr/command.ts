import { OCR_CHANNELS, type LanguagesResponse, type OcrPrefs } from '@shared/features/ocr'
import { activeTab } from '../../state/actions'
import { notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { clean, runOcr } from './flow'
import { useOcrUi } from './store'

/**
 * The `ocr.run` command. Other features call it through `runCommand('ocr.run', args)`:
 *
 *   runCommand('ocr.run')                                       // menu: the dialog for the active document
 *   runCommand('ocr.run', { docId })                            // Scanning: recognize ALL pages of that document now
 *                                                               //   (saved languages/options), with a completion toast
 *   runCommand('ocr.run', { docId, dialog: true })              // the dialog for that document
 *   runCommand('ocr.run', { docId, silent: true })              // like { docId } but without the success toast
 *   runCommand('ocr.run', { docId, languages: ['deu', 'eng'] }) // explicit languages
 *
 * With a `docId` (the caller has already asked the user) there is no dialog unless `dialog: true`. Errors and the
 * low-confidence warning are always shown. Pages that already have text are skipped unless the saved "recognize
 * pages that already contain text" option is on. The returned promise resolves when the run has finished.
 */
export interface OcrCommandArgs {
  docId?: string
  languages?: string[]
  silent?: boolean
  dialog?: boolean
}

export async function runOcrCommand(args?: unknown): Promise<void> {
  const a = (args && typeof args === 'object' ? args : {}) as OcrCommandArgs
  const tab = a.docId ? useTabs.getState().tabs.find((t) => t.docId === a.docId) : activeTab()
  if (!tab) return void notify('info', 'Open a document first to recognize its text.')
  if (!a.docId || a.dialog) {
    await useOcrUi.getState().show(tab.docId, tab.numPages, tab.view.page)
    return
  }
  let prefs: OcrPrefs
  try {
    prefs = (await window.epdf.call<LanguagesResponse>(OCR_CHANNELS.languages, {})).prefs
  } catch (err) {
    return void notify('error', clean(err))
  }
  const languages = Array.isArray(a.languages) && a.languages.length ? a.languages : prefs.languages
  await runOcr({ docId: tab.docId, pages: 'all', languages, prefs, silent: !!a.silent })
}
