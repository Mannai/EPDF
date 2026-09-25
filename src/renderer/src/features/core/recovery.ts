import { bytesForWriting, replaceBytes, useEdits, whenEditsSettled } from '../../edit/session'
import { askConfirm } from '../../state/confirm'
import { tabAddedListeners } from '../../state/tabs'

const AUTOSAVE_INTERVAL_MS = 15_000

/** Edit-history version last written to the recovery folder, per document. */
const written = new Map<string, number>()

/** Writes the current unsaved state to the recovery folder right now (also used before moving a tab). */
export async function flushRecovery(docId: string): Promise<void> {
  await whenEditsSettled(docId)
  const info = useEdits.getState()[docId]
  if (!info?.dirty) return
  // Through the same write hooks as Save, so a protected document never lands in the recovery folder as plaintext.
  await window.epdf.writeRecovery(docId, await bytesForWriting(docId))
  written.set(docId, info.version)
}

async function autosaveTick(): Promise<void> {
  const all = useEdits.getState()
  for (const [docId, info] of Object.entries(all)) {
    try {
      if (info.dirty) {
        if (written.get(docId) !== info.version) await flushRecovery(docId)
      } else if (written.has(docId)) {
        // Undone back to the saved state: the recovery copy is stale.
        written.delete(docId)
        await window.epdf.clearRecovery(docId)
      }
    } catch (err) {
      console.warn('autosave failed', err)
    }
  }
  for (const id of [...written.keys()]) if (!(id in all)) written.delete(id)
}

async function applyRecovery(docId: string): Promise<void> {
  const bytes = await window.epdf.readRecovery(docId)
  if (bytes) replaceBytes(docId, 'Recover unsaved changes', bytes)
}

export function initRecovery(): void {
  void window.epdf.getAppInfo().then(({ autosaveMs }) => setInterval(() => void autosaveTick(), autosaveMs || AUTOSAVE_INTERVAL_MS))

  // A file with an autosaved copy (after a crash, or a tab moved to another window) offers its edits back.
  tabAddedListeners.add(async (tab, info) => {
    if (!info.hasRecovery) return
    if (!info.autoRecover) {
      const choice = await askConfirm({
        title: `Recover unsaved changes to “${tab.name}”?`,
        message: 'Epdf found edits that were not saved when it last closed.',
        buttons: [
          { label: 'Recover', value: 'recover', variant: 'primary' },
          { label: 'Discard', value: 'discard', variant: 'danger' }
        ],
        cancelValue: 'discard'
      })
      if (choice !== 'recover') return void window.epdf.clearRecovery(tab.docId).catch(() => undefined)
    }
    await applyRecovery(tab.docId).catch((err) => console.warn('recovery failed', err))
  })
}

/** For tests: run one autosave pass immediately. */
export const _autosaveNow = autosaveTick
