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

/** Don't let one stuck edit keep a window from closing. */
const EDITS_SETTLE_TIMEOUT_MS = 5000

let closeInFlight = false

/**
 * Main deferred a window close to us: check for unsaved edits, ask if there are any, then close for real
 * or stay open. Designed so a window can never get stuck:
 *  - it acknowledges immediately (main's watchdog force-closes a window that never answers),
 *  - repeated close attempts while a prompt is showing don't stack more prompts,
 *  - a stuck edit only delays us for a few seconds,
 *  - any unexpected error falls back to a plain "close anyway?" question.
 */
export async function handleWindowCloseRequest(): Promise<void> {
  void window.epdf.ackClose().catch(() => undefined)
  if (closeInFlight) return
  closeInFlight = true
  try {
    await decideWindowClose()
  } catch (err) {
    console.error('close check failed', err)
    const choice = await askConfirm({
      title: 'Couldn’t check for unsaved changes',
      message: 'Close this window anyway? Any unsaved edits may be lost.',
      buttons: [
        { label: 'Close Anyway', value: 'close', variant: 'danger' },
        { label: 'Stay Open', value: 'stay', variant: 'primary' }
      ],
      cancelValue: 'stay'
    }).catch(() => 'close')
    if (choice === 'close') await window.epdf.closeWindow(true).catch(() => undefined)
    else await window.epdf.cancelClose().catch(() => undefined)
  } finally {
    closeInFlight = false
  }
}

async function decideWindowClose(): Promise<void> {
  await Promise.race([
    Promise.all(useTabs.getState().tabs.map((t) => whenEditsSettled(t.docId))),
    new Promise((r) => setTimeout(r, EDITS_SETTLE_TIMEOUT_MS))
  ])
  const dirty = dirtyDocIds()
  if (dirty.length === 0) return void (await window.epdf.closeWindow(true))
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
  if (choice === 'cancel') return void (await window.epdf.cancelClose())
  if (choice === 'save' && !(await saveAll(dirty))) return void (await window.epdf.cancelClose())
  if (choice === 'discard') await Promise.all(dirty.map((id) => window.epdf.clearRecovery(id).catch(() => undefined)))
  await window.epdf.closeWindow(true)
}
