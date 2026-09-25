import { bytesForWriting, isDirty, markSaved, whenEditsSettled } from '../../edit/session'
import { askConfirm } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'

const tabOf = (docId: string) => useTabs.getState().tabs.find((t) => t.docId === docId)

/**
 * Saves the document back to its own file. Returns true if there is nothing left unsaved afterwards.
 * Failures are reported to the user (with a Save As… shortcut) rather than thrown.
 */
export async function saveDoc(docId: string): Promise<boolean> {
  const tab = tabOf(docId)
  if (!tab) return false
  await whenEditsSettled(docId) // "rotate, then immediately save" must save the rotation
  if (!isDirty(docId)) return true

  if (tab.changedOnDisk) {
    const choice = await askConfirm({
      title: 'File changed on disk',
      message: `“${tab.name}” was modified by another program since you opened it. Saving will overwrite those changes.`,
      buttons: [
        { label: 'Save As…', value: 'saveAs', variant: 'primary' },
        { label: 'Overwrite', value: 'overwrite', variant: 'danger' },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    })
    if (choice === 'saveAs') return saveDocAs(docId)
    if (choice !== 'overwrite') return false
  }

  try {
    const bytes = await bytesForWriting(docId)
    await window.epdf.saveFile(docId, bytes)
    markSaved(docId)
    useTabs.getState().patchTab(docId, { changedOnDisk: false })
    return true
  } catch (err) {
    notify('error', `Couldn’t save “${tab.name}”: ${errorMessage(err)}`, {
      label: 'Save As…',
      run: () => void saveDocAs(docId)
    })
    return false
  }
}

/** Save As…: asks for a new file; the tab then represents that file. Returns false if cancelled or failed. */
export async function saveDocAs(docId: string): Promise<boolean> {
  const tab = tabOf(docId)
  if (!tab) return false
  try {
    const bytes = await bytesForWriting(docId)
    const res = await window.epdf.saveFileAs(docId, bytes)
    if (!res) return false
    markSaved(docId)
    useTabs.getState().patchTab(docId, { path: res.path, name: res.name, changedOnDisk: false })
    return true
  } catch (err) {
    notify('error', `Couldn’t save a copy of “${tab.name}”: ${errorMessage(err)}`)
    return false
  }
}

/** Save a Copy…: writes the current state elsewhere and leaves this tab (and its unsaved state) alone. */
export async function saveDocCopy(docId: string): Promise<boolean> {
  const tab = tabOf(docId)
  if (!tab) return false
  try {
    const res = await window.epdf.saveCopy(docId, await bytesForWriting(docId))
    if (res) notify('success', `Saved a copy as “${res.name}”.`, { label: 'Show in folder', run: () => void window.epdf.revealDoc(docId) })
    return !!res
  } catch (err) {
    notify('error', `Couldn’t save a copy: ${errorMessage(err)}`)
    return false
  }
}

/** Saves every listed document; stops and returns false at the first that fails or is cancelled. */
export async function saveAll(docIds: string[]): Promise<boolean> {
  for (const id of docIds) if (!(await saveDoc(id))) return false
  return true
}
