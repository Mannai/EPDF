import { registerCommand, registerDialog } from '../api'
import { LibraryDialog } from './LibraryDialog'
import { onLibraryChanged, openLibrary, useLibrary } from './store'

/**
 * Local file library: File ▸ Library… (menu item contributed by src/main/features/library, shortcut Ctrl/Cmd+Shift+L)
 * opens a full-window layer with watched folders, virtual folders, favorites, recents, and name and content search.
 */
registerCommand({ id: 'library.open', label: 'Library…', run: () => void openLibrary() })
registerDialog(LibraryDialog)

// Main tells every window when the index changed and how far a background sync has come.
window.epdf.onFeature('library:changed', () => void onLibraryChanged())
window.epdf.onFeature('library:status', (status) => {
  useLibrary.setState((s) => (s.state ? { state: { ...s.state, status: status as NonNullable<typeof s.state>['status'] } } : {}))
})
