import type { PurgeSummary } from '@shared/features/redact'
import { clearUndoSteps, useEdits } from '../../edit/session'
import { askConfirm } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { onSaveCompleted, type SaveCompleted } from '../core/save'
import { useRedact } from './store'

/**
 * A saved document leaves the previous file behind in Epdf's own version history (and possibly an autosaved recovery
 * copy). After a redaction is saved those copies still hold the original content; after password protection is added
 * they are still unprotected. So once such a save is done the user is offered to purge them. Main does the deleting;
 * the renderer only names the document.
 *
 * Which saves count is decided by the tags of the edits that are now on disk (see `EditOptions` in edit/session), not
 * by the newest undo step, so a redaction followed by any other edit (a rotation, an annotation, Fill & sign locking
 * its items during the save) is still recognised.
 */

/** Tag of the edit that applies redactions (set in ./apply). */
export const REDACTION_TAG = 'redaction'

export type PurgeReason = 'redaction' | 'protect'

interface HistoryInfo {
  versions: number
  recovery: boolean
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path

/** Tagged edits (by revision) whose save was already handled, per document. */
const handled = new Map<string, Set<number>>()

/** Marks the edit with `revision` as handled for `docId`. Returns false if it already was. */
export function claimTaggedEdit(docId: string, revision: number): boolean {
  let set = handled.get(docId)
  if (!set) handled.set(docId, (set = new Set()))
  if (set.has(revision)) return false
  set.add(revision)
  return true
}

/** Purge offers run one at a time per document. */
const offers = new Map<string, Promise<void>>()

/**
 * Queues the offer to purge the version history of `docId`. Each offer looks at what is left in the history only when
 * its turn comes, so a second offer after a purge does not ask again about copies that are already gone.
 */
export function queuePurgeOffer(docId: string, reason: PurgeReason): Promise<void> {
  const next = (offers.get(docId) ?? Promise.resolve()).then(() => offer(docId, reason)).catch((err) => console.warn('purge offer failed', err))
  offers.set(docId, next)
  void next.then(() => {
    if (offers.get(docId) === next) offers.delete(docId)
  })
  return next
}

const RESIDUE: Record<PurgeReason, string> = {
  redaction: 'the original, unredacted content',
  protect: 'the content without the current password protection'
}

async function offer(docId: string, reason: PurgeReason): Promise<void> {
  const tab = useTabs.getState().tabs.find((t) => t.docId === docId)
  if (!tab) return
  let info: HistoryInfo | null = null
  try {
    info = await window.epdf.call<HistoryInfo>('redact:historyInfo', { docId })
  } catch {
    /* unknown: offer anyway */
  }
  if (info && info.versions === 0 && !info.recovery) return // nothing to remove
  const what = info && info.versions > 0 ? `${info.versions} earlier ${info.versions === 1 ? 'version' : 'versions'} of “${tab.name}”` : 'earlier versions of this file'
  const recovery = info?.recovery ? ' and an autosaved recovery copy' : ''
  const message =
    reason === 'redaction'
      ? `The redaction is saved and cannot be undone in this file. Epdf still keeps ${what} in its version history${recovery}, and they contain the original, unredacted content. Purge them now?`
      : `“${tab.name}” is saved with password protection, but Epdf still keeps ${what} in its version history${recovery}, saved before this protection was set. They can be opened without the new password. Purge them now?`
  const choice = await askConfirm({
    title: 'Purge the version history?',
    message,
    buttons: [
      { label: 'Purge version history', value: 'purge', variant: 'danger' },
      { label: 'Keep it', value: 'keep' }
    ],
    cancelValue: 'keep'
  })
  if (choice !== 'purge') {
    notify('info', `The version history was kept: it still contains ${reason === 'redaction' ? 'the unredacted content' : 'copies without this protection'}.`)
    return
  }
  await purge(docId, reason)
}

const versionsText = (n: number): string => `${n} earlier ${n === 1 ? 'version' : 'versions'}`

/** Runs the purge; if some copies could not be deleted, says how many are left and offers to try again. */
async function purge(docId: string, reason: PurgeReason): Promise<void> {
  let deleted = 0
  let recovery = false
  for (;;) {
    let problem: string
    try {
      const r = await window.epdf.call<PurgeSummary>('redact:purgeHistory', { docId })
      deleted += r.deleted
      recovery ||= r.recovery
      const failed = r.failed ?? Math.max(0, r.versions - r.deleted)
      if (failed === 0) {
        notify('success', deleted > 0 || recovery ? `Purged ${versionsText(deleted)}${recovery ? ' and the recovery copy' : ''}.` : 'There was no earlier version to purge.')
        return
      }
      problem = `${failed === 1 ? '1 earlier version' : `${failed} earlier versions`} could not be deleted${deleted > 0 ? ` (${deleted} ${deleted === 1 ? 'was' : 'were'})` : ''}. ${failed === 1 ? 'It still contains' : 'They still contain'} ${RESIDUE[reason]}.`
    } catch (err) {
      problem = `Couldn’t purge the version history: ${errorMessage(err)}. It still contains ${RESIDUE[reason]}.`
    }
    const choice = await askConfirm({
      title: 'The version history was not fully purged',
      message: `${problem} The file may be open in another program. Try again?`,
      buttons: [
        { label: 'Retry', value: 'retry', variant: 'primary' },
        { label: 'Keep it', value: 'keep' }
      ],
      cancelValue: 'keep'
    })
    if (choice !== 'retry') {
      notify('error', problem)
      return
    }
  }
}

function onSaved(e: SaveCompleted): void {
  const fresh = e.lineage.filter((t) => t.tag === REDACTION_TAG && claimTaggedEdit(e.docId, t.revision))
  if (fresh.length === 0) return
  useRedact.getState().markPending(e.docId, null)
  // A saved redaction is irreversible: drop the in-memory undo steps (which still hold the unredacted bytes). The
  // current state stays as it is, including any edit made while the save was running.
  void clearUndoSteps(e.docId)
  if (e.saveAs) {
    // The redacted copy is a new file; the original file was not touched and still has everything.
    notify('info', `The redacted copy was saved as “${fileName(e.newPath)}”. The original file “${fileName(e.oldPath)}” is unchanged and still contains the unredacted content.`)
    return
  }
  notify('info', 'The redaction is saved and permanent. The undo history for this document was cleared.')
  void queuePurgeOffer(e.docId, 'redaction')
}

/** Watches saves: a saved redaction clears the undo steps and triggers the purge offer. */
export function watchSaves(): void {
  onSaveCompleted(onSaved)
  useEdits.subscribe((state) => {
    // Edits discarded (reloaded from disk / "Don't save"): the applied redaction is gone with them.
    for (const docId of Object.keys(useRedact.getState().pendingPurge)) if (!state[docId]) useRedact.getState().markPending(docId, null)
    for (const docId of [...handled.keys()]) if (!state[docId] && !useTabs.getState().tabs.some((t) => t.docId === docId)) handled.delete(docId)
  })
}
