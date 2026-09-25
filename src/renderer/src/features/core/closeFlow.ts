import { dirtyDocIds, isDirty, whenEditsSettled } from '../../edit/session'
import { askConfirm } from '../../state/confirm'
import { useTabs } from '../../state/tabs'
import { saveAll, saveDoc } from './save'

/** Closes a tab, asking first if it has unsaved edits. Returns false if the user cancelled. */
export async function closeTabInteractive(docId: string): Promise<boolean> {
  const tab = useTabs.getState().tabs.find((t) => t.docId === docId)
  if (!tab) return true
  await whenEditsSettled(docId)
  if (isDirty(docId)) {
    const choice = await askConfirm({
      title: `Save changes to “${tab.name}”?`,
      message: 'Your changes will be lost if you don’t save them.',
      buttons: [
        { label: 'Save', value: 'save', variant: 'primary' },
        { label: 'Don’t Save', value: 'discard', variant: 'danger' },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    })
    if (choice === 'cancel') return false
    if (choice === 'save' && !(await saveDoc(docId))) return false
    if (choice === 'discard') await window.epdf.clearRecovery(docId).catch(() => undefined)
  }
  useTabs.getState().closeTab(docId)
  return true
}

/** Main vetoed a window close because of unsaved edits: ask, then close for real or stay open. */
export async function handleWindowCloseRequest(): Promise<void> {
  await Promise.all(useTabs.getState().tabs.map((t) => whenEditsSettled(t.docId)))
  const dirty = dirtyDocIds()
  if (dirty.length === 0) return void window.epdf.closeWindow(true)
  const names = dirty.map((id) => useTabs.getState().tabs.find((t) => t.docId === id)?.name ?? 'Untitled')
  const choice = await askConfirm({
    title: dirty.length === 1 ? `Save changes to “${names[0]}”?` : `Save changes to ${dirty.length} documents?`,
    message:
      dirty.length === 1
        ? 'Your changes will be lost if you don’t save them.'
        : `Unsaved changes:\n${names.map((n) => `• ${n}`).join('\n')}`,
    buttons: [
      { label: dirty.length === 1 ? 'Save' : 'Save All', value: 'save', variant: 'primary' },
      { label: 'Don’t Save', value: 'discard', variant: 'danger' },
      { label: 'Cancel', value: 'cancel' }
    ],
    cancelValue: 'cancel'
  })
  if (choice === 'cancel') return void window.epdf.cancelClose()
  if (choice === 'save' && !(await saveAll(dirty))) return void window.epdf.cancelClose()
  if (choice === 'discard') await Promise.all(dirty.map((id) => window.epdf.clearRecovery(id).catch(() => undefined)))
  await window.epdf.closeWindow(true)
}
