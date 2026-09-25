import { activeTab } from '../../state/actions'
import { getView, registerCommand, registerView } from '../api'
import { useWorkspace } from '../../state/workspace'
import { CompareView } from './CompareView'
import { useCompare } from './store'

/**
 * Compare Files: a full-tab view that lines up the pages of two versions of a document and shows every text
 * difference side by side (plus a summary list, next/previous navigation, a visual pixel comparison and PDF/CSV
 * reports). The main-process half (native picker, report saving, menu item) is src/main/features/compare.
 */

registerView({ id: 'compare', label: 'Compare files', Component: CompareView, hideToolbar: true })

const readyTab = (): NonNullable<ReturnType<typeof activeTab>> | null => {
  const t = activeTab()
  return t && t.status === 'ready' && t.numPages > 0 ? t : null
}

const inResults = (): boolean => {
  const t = activeTab()
  if (!t) return false
  const viewing = useWorkspace.getState().viewByDoc[t.docId] === 'compare'
  return viewing && useCompare.getState().byDoc[t.docId]?.phase === 'done'
}

registerCommand({
  id: 'compare.open',
  label: 'Compare Files',
  run: () => {
    const t = readyTab()
    if (!t || !getView('compare')) return
    useCompare.getState().ensure(t)
    useWorkspace.getState().setView(t.docId, 'compare')
  }
})

// F8 / Shift+F8: next and previous change while the comparison results are showing.
registerCommand({
  id: 'compare.nextChange',
  label: 'Next Change',
  shortcut: 'f8',
  enabled: inResults,
  run: () => {
    const t = activeTab()
    if (t) useCompare.getState().step(t.docId, 1)
  }
})
registerCommand({
  id: 'compare.prevChange',
  label: 'Previous Change',
  shortcut: 'shift+f8',
  enabled: inResults,
  run: () => {
    const t = activeTab()
    if (t) useCompare.getState().step(t.docId, -1)
  }
})
