import { APPLY_LABEL } from './apply'
import { reloadFromDisk, useEdits } from '../../edit/session'
import { askConfirm } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { useRedact } from './store'

/**
 * A redacted document that is saved leaves the previous file behind in Epdf's own version history (and possibly an
 * autosaved recovery copy). Both still hold the original content, so once the redaction has been saved the user is
 * offered to purge them. Main does the deleting; the renderer only names the document.
 */

const asking = new Set<string>()

interface PurgeSummary {
  versions: number
  deleted: number
  recovery: boolean
}

async function offer(docId: string, pathAtApply: string): Promise<void> {
  const tab = useTabs.getState().tabs.find((t) => t.docId === docId)
  useRedact.getState().markPending(docId, null)
  if (!tab) return
  if (tab.path !== pathAtApply) {
    // Save As: the redacted copy is a new file; the original file was not touched and still has everything.
    notify('info', `The redacted copy was saved as “${tab.name}”. The original file “${pathAtApply.split(/[\\/]/).pop()}” is unchanged and still contains the unredacted content.`)
    return
  }
  notify('info', 'The redaction is saved and permanent. The undo history for this document was cleared.')
  let info = { versions: 0, recovery: false }
  try {
    info = await window.epdf.call<typeof info>('redact:historyInfo', { docId })
  } catch {
    /* fall through: offer anyway */
  }
  const what = info.versions > 0 ? `${info.versions} earlier ${info.versions === 1 ? 'version' : 'versions'} of “${tab.name}”` : 'earlier versions of this file'
  const choice = await askConfirm({
    title: 'Purge the version history?',
    message: `The redaction is saved and cannot be undone in this file. Epdf still keeps ${what} in its version history${info.recovery ? ' and an autosaved recovery copy' : ''}, and they contain the original, unredacted content. Purge them now?`,
    buttons: [
      { label: 'Purge version history', value: 'purge', variant: 'danger' },
      { label: 'Keep it', value: 'keep' }
    ],
    cancelValue: 'keep'
  })
  if (choice !== 'purge') {
    notify('info', 'The version history was kept: it still contains the unredacted content.')
    return
  }
  try {
    const r = await window.epdf.call<PurgeSummary>('redact:purgeHistory', { docId })
    notify('success', r.deleted > 0 || r.recovery ? `Purged ${r.deleted} earlier ${r.deleted === 1 ? 'version' : 'versions'}${r.recovery ? ' and the recovery copy' : ''}.` : 'There was no earlier version to purge.')
  } catch (err) {
    notify('error', `Couldn’t purge the version history: ${errorMessage(err)}`)
  }
}

/** Watches the edit state: an applied redaction that has been saved triggers the purge offer. */
export function watchSaves(): void {
  useEdits.subscribe((state) => {
    const pending = useRedact.getState().pendingPurge
    for (const [docId, p] of Object.entries(pending)) {
      const info = state[docId]
      if (!info) {
        // the session is gone (tab closed / edits discarded)
        useRedact.getState().markPending(docId, null)
        continue
      }
      // saved with the redaction as the newest step (undoing it before saving leaves a different undo label)
      if (!info.dirty && info.undoLabel === APPLY_LABEL && !asking.has(docId)) {
        asking.add(docId)
        // A saved redaction is irreversible: drop the in-memory undo history (which still holds the unredacted
        // bytes) and continue from what is on disk. Deferred so the save flow that triggered this can finish.
        setTimeout(() => reloadFromDisk(docId), 0)
        void offer(docId, p.path).finally(() => asking.delete(docId))
      }
    }
  })
}
