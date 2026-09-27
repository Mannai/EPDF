import { canRedo, canUndo, useEdits } from '../../edit/session'
import { openSearch } from '../../state/actions'
import { useSearch } from '../../state/search'
import { useUi } from '../../state/ui'
import { registerContextItems } from '../api'

/** Right-click on pages: the always-available items (copy / search the selection; undo, go to page). */

const short = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 28 ? `${t.slice(0, 27)}…` : t
}

registerContextItems('selection', 0, (at) => [
  { label: 'Copy', keys: 'Ctrl+C', run: () => void document.execCommand('copy') },
  {
    label: `Search for “${short(at.selectionText)}”`,
    enabled: at.selectionText.trim().length > 0,
    run: () => {
      openSearch()
      useSearch.getState().setQuery(at.selectionText.replace(/\s+/g, ' ').trim())
    }
  }
])

registerContextItems('page', 0, (at) => {
  const info = useEdits.getState()[at.docId]
  return [
    // "Undo Rotate pages", like the title bar's Undo button.
    { label: info?.undoLabel ? `Undo ${info.undoLabel}` : 'Undo', command: 'edit.undo', keys: 'Ctrl+Z', enabled: canUndo(at.docId) },
    { label: info?.redoLabel ? `Redo ${info.redoLabel}` : 'Redo', command: 'edit.redo', keys: 'Ctrl+Y', enabled: canRedo(at.docId) },
    { type: 'separator' },
    { label: 'Select all text on this page', run: () => selectAllOnPage(at.pageIndex) },
    { label: 'Go to page…', keys: 'Ctrl+Alt+G', run: () => useUi.getState().setGoToPageOpen(true) }
  ]
})

function selectAllOnPage(pageIndex: number): void {
  const el = document.querySelector<HTMLElement>(`.epdf-page[data-page="${pageIndex + 1}"] .textLayer`)
  if (!el) return
  const r = document.createRange()
  r.selectNodeContents(el)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}
