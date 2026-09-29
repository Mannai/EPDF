import { bytesForWriting, isDirty, markSaved, snapshotForWriting, whenEditsSettled, type Tagged } from '../../edit/session'
import { askConfirm } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { runBeforeSave } from '../api'

const tabOf = (docId: string) => useTabs.getState().tabs.find((t) => t.docId === docId)

/** What a finished Save / Save As wrote. */
export interface SaveCompleted {
  docId: string
  /** The edit-history revision that is now on disk. */
  revision: number
  /** The tags of every edit in that revision (e.g. a redaction), oldest first. */
  lineage: Tagged[]
  /** The file the tab represented before the save, and the file that was written. Equal unless `saveAs`. */
  oldPath: string
  newPath: string
  saveAs: boolean
}

const saveCompletedListeners = new Set<(e: SaveCompleted) => void>()

/**
 * Called after a Save or Save As has written the file, marked the document saved and updated the tab. Returns an
 * unsubscribe function.
 */
export function onSaveCompleted(listener: (e: SaveCompleted) => void): () => void {
  saveCompletedListeners.add(listener)
  return () => void saveCompletedListeners.delete(listener)
}

function emitSaveCompleted(e: SaveCompleted): void {
  for (const l of [...saveCompletedListeners]) {
    try {
      l(e)
    } catch (err) {
      console.error('save listener failed', err)
    }
  }
}

/**
 * Saves of one document run one after another: a second Save (a double click, Save then Ctrl+S, closing while a save
 * runs) waits for the first and then saves whatever is still unsaved.
 */
const saveLocks = new Map<string, Promise<unknown>>()

function withSaveLock<T>(docId: string, work: () => Promise<T>): Promise<T> {
  const run = (saveLocks.get(docId) ?? Promise.resolve()).then(work, work)
  const tail = run.catch(() => undefined)
  saveLocks.set(docId, tail)
  void tail.then(() => {
    if (saveLocks.get(docId) === tail) saveLocks.delete(docId)
  })
  return run
}

/** Features' before-save steps (Fill & sign locking, ...). For Save / Save As they edit the document itself. */
async function beforeSaving(docId: string): Promise<boolean> {
  await whenEditsSettled(docId)
  if ((await runBeforeSave(docId, 'save')) === false) return false
  await whenEditsSettled(docId) // a step may have made an edit (e.g. locking items into the page)
  return true
}

/**
 * Saves the document back to its own file. Returns true if there is nothing left unsaved afterwards.
 * Failures are reported to the user (with a Save As… shortcut) rather than thrown.
 */
export function saveDoc(docId: string): Promise<boolean> {
  return withSaveLock(docId, () => saveDocLocked(docId))
}

/** Save As…: asks for a new file; the tab then represents that file. Returns false if cancelled or failed. */
export function saveDocAs(docId: string): Promise<boolean> {
  return withSaveLock(docId, () => saveDocAsLocked(docId))
}

async function saveDocLocked(docId: string): Promise<boolean> {
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
    if (choice === 'saveAs') return saveDocAsLocked(docId) // already holding the lock
    if (choice !== 'overwrite') return false
  }

  if (!(await beforeSaving(docId))) return false
  try {
    const snap = await snapshotForWriting(docId)
    await window.epdf.saveFile(docId, snap.bytes)
    const path = tabOf(docId)?.path ?? tab.path
    // Exactly the state that was written: an edit or undo made meanwhile stays unsaved.
    markSaved(docId, snap.revision)
    useTabs.getState().patchTab(docId, { changedOnDisk: false })
    emitSaveCompleted({ docId, revision: snap.revision, lineage: snap.lineage, oldPath: path, newPath: path, saveAs: false })
    return !isDirty(docId)
  } catch (err) {
    notify('error', `Couldn’t save “${tab.name}”: ${errorMessage(err)}`, {
      label: 'Save As…',
      run: () => void saveDocAs(docId)
    })
    return false
  }
}

async function saveDocAsLocked(docId: string): Promise<boolean> {
  const tab = tabOf(docId)
  if (!tab) return false
  if (!(await beforeSaving(docId))) return false
  try {
    const snap = await snapshotForWriting(docId)
    const res = await window.epdf.saveFileAs(docId, snap.bytes)
    if (!res) return false
    const oldPath = tabOf(docId)?.path ?? tab.path
    markSaved(docId, snap.revision)
    useTabs.getState().patchTab(docId, { path: res.path, name: res.name, changedOnDisk: false })
    emitSaveCompleted({ docId, revision: snap.revision, lineage: snap.lineage, oldPath, newPath: res.path, saveAs: true })
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
  await whenEditsSettled(docId)
  const transforms = await runBeforeSave(docId, 'copy')
  if (transforms === false) return false
  try {
    let bytes = await bytesForWriting(docId)
    for (const t of transforms) bytes = await t(bytes)
    const res = await window.epdf.saveCopy(docId, bytes)
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
