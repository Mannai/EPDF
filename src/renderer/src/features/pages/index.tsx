import { activeTab } from '../../state/actions'
import { useWorkspace } from '../../state/workspace'
import { registerCommand, registerDialog, registerView } from '../api'
import { PageDialogs } from './Dialogs'
import { Organizer } from './Organizer'
import { rotatePages } from './actions'
import { useOrganizerSelection, usePageDialog, type PageDialogKind } from './store'

/**
 * Page organization: the full-tab organizer view, the page-tool dialogs (insert, blank page, extract,
 * delete, rotate, split) and the Rotate Page Clockwise/Counterclockwise commands. The main-process half
 * (native dialogs, split job, menu items) is src/main/features/pages.
 */

registerView({ id: 'organize', label: 'Organize pages', Component: Organizer, hideToolbar: true })
registerDialog(PageDialogs)

const readyTab = (): NonNullable<ReturnType<typeof activeTab>> | null => {
  const t = activeTab()
  return t && t.status === 'ready' && t.numPages > 0 ? t : null
}

registerCommand({
  id: 'pages.organize',
  label: 'Organize Pages',
  run: () => {
    const t = readyTab()
    if (t) useWorkspace.getState().setView(t.docId, 'organize')
  }
})

const dialogCommand = (id: string, label: string, kind: PageDialogKind): void =>
  registerCommand({
    id,
    label,
    run: () => {
      const t = readyTab()
      if (!t) return
      const selected = useOrganizerSelection.getState().byDoc[t.docId]
      usePageDialog.getState().open(kind, t.docId, { pages: selected?.length ? selected : undefined })
    }
  })

dialogCommand('pages.insert', 'Insert Pages', 'insert')
dialogCommand('pages.extract', 'Extract Pages', 'extract')
dialogCommand('pages.delete', 'Delete Pages', 'delete')
dialogCommand('pages.rotate', 'Rotate Pages', 'rotate')
dialogCommand('pages.split', 'Split Document', 'split')

/** Rotates the pages selected in the organizer, or the current page anywhere else. */
async function rotateCommand(delta: 90 | -90): Promise<void> {
  const t = readyTab()
  if (!t) return
  const selected = useOrganizerSelection.getState().byDoc[t.docId]
  await rotatePages(t.docId, t.numPages, selected?.length ? selected : [t.view.page - 1], delta)
}
registerCommand({ id: 'page.rotateCW', label: 'Rotate Page Clockwise', run: () => rotateCommand(90) })
registerCommand({ id: 'page.rotateCCW', label: 'Rotate Page Counterclockwise', run: () => rotateCommand(-90) })
