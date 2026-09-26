import { activeTab } from '../../state/actions'
import { useUi } from '../../state/ui'
import { useWorkspace } from '../../state/workspace'
import { registerCommand, registerDialog, registerPanel } from '../api'
import { addBookmarkHere } from './actions'
import { GenerateDialog } from './Generate'
import { IconBookmarks } from './icons'
import { BookmarksPanel } from './Panel'
import { BOOKMARKS_PANEL, useBookmarkUi } from './store'

/**
 * Bookmarks (the document outline): a left sidebar panel with the tree (view, navigate, add, rename, delete,
 * nest, reorder by drag and drop or keyboard, style), and "Generate bookmarks from headings" with a review list.
 * The outline logic lives in ./pdf (pure pdf-lib); the heading detector runs in a worker (src/main/features/bookmarks).
 * See docs/features/links-bookmarks.md.
 */

registerPanel({ id: BOOKMARKS_PANEL, label: 'Bookmarks', icon: <IconBookmarks />, side: 'left', order: 10, width: 288, Component: BookmarksPanel })
registerDialog(GenerateDialog)

const hasDoc = (): boolean => activeTab()?.status === 'ready'

/** Shows the sidebar with the Bookmarks panel; toggles back to page thumbnails when it is already showing. */
function togglePanel(): void {
  const ws = useWorkspace.getState()
  const ui = useUi.getState()
  if (ui.sidebarOpen && ws.leftPanel === BOOKMARKS_PANEL) ws.setLeftPanel('thumbnails')
  else {
    ui.setSidebarOpen(true)
    ws.setLeftPanel(BOOKMARKS_PANEL)
  }
}

function showPanel(): void {
  useUi.getState().setSidebarOpen(true)
  useWorkspace.getState().setLeftPanel(BOOKMARKS_PANEL)
}

registerCommand({ id: 'bookmarks.toggle', label: 'Bookmarks Panel', shortcut: 'mod+alt+b', enabled: hasDoc, run: togglePanel })
registerCommand({
  id: 'bookmarks.addHere',
  label: 'Add Bookmark Here',
  shortcut: 'mod+alt+d',
  enabled: hasDoc,
  run: async () => {
    const t = activeTab()
    if (!t) return
    showPanel()
    await addBookmarkHere(t.docId)
  }
})
registerCommand({
  id: 'bookmarks.generate',
  label: 'Generate Bookmarks from Headings',
  enabled: hasDoc,
  run: () => {
    const t = activeTab()
    if (t) useBookmarkUi.getState().openGenerate(t.docId)
  }
})
