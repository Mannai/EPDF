import { OCR_CHANNELS, selectPages, type LanguagesResponse, type OcrPrefs } from '@shared/features/ocr'
import { activeTab } from '../../state/actions'
import { notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { clean, runOcr } from './flow'
import { useOcrUi } from './store'

/**
 * The `ocr.run` command. Other features call it through `runCommand('ocr.run', args)`:
 *
 *   runCommand('ocr.run')                                       // dialog for the active document
 *   runCommand('ocr.run', { docId })                            // dialog for that document
 *   runCommand('ocr.run', { docId, silent: true })              // no dialog: all pages, saved languages/options
 *   runCommand('ocr.run', { docId, silent: true, languages: ['deu', 'eng'] })
 *
 * `silent` skips the dialog and the success toast (errors and the low-confidence warning are still shown). Pages
 * that already have text are skipped unless the saved "recognize pages that already contain text" option is on.
 * The returned promise resolves when the run has finished.
 */
export interface OcrCommandArgs {
  docId?: string
  languages?: string[]
  silent?: boolean
}

export async function runOcrCommand(args?: unknown): Promise<void> {
  const a = (args && typeof args === 'object' ? args : {}) as OcrCommandArgs
  const tab = a.docId ? useTabs.getState().tabs.find((t) => t.docId === a.docId) : activeTab()
  if (!tab) return void notify('info', 'Open a document first to recognize its text.')
  if (!a.silent) {
    await useOcrUi.getState().show(tab.docId, tab.numPages, tab.view.page)
    return
  }
  let prefs: OcrPrefs
  try {
    prefs = (await window.epdf.call<LanguagesResponse>(OCR_CHANNELS.languages, {})).prefs
  } catch (err) {
    return void notify('error', clean(err))
  }
  const sel = selectPages({ mode: 'all' }, tab.numPages)
  if (!sel.ok) return void notify('error', sel.error)
  const languages = Array.isArray(a.languages) && a.languages.length ? a.languages : prefs.languages
  await runOcr({ docId: tab.docId, pages: sel.pages, languages, prefs, silent: true })
}
