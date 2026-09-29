import type { SaveCompleted } from '../core/save'
import { claimTaggedEdit, queuePurgeOffer } from '../redact/purge'
import { PROTECT_TAG, UNPROTECT_TAG } from './session'

/**
 * After a save that added or changed password protection, the version history still holds the earlier copies of the
 * file, which are not protected (or protected with the old password). The user is offered to purge them, once per
 * protection edit. Save As writes a new file, so the history of the original file is left alone.
 */
export function protectionSaved(e: SaveCompleted): void {
  if (e.saveAs) return
  let latest: SaveCompleted['lineage'][number] | undefined
  for (const t of e.lineage) if (t.tag === PROTECT_TAG || t.tag === UNPROTECT_TAG) latest = t
  if (!latest || latest.tag !== PROTECT_TAG) return
  if (!claimTaggedEdit(e.docId, latest.revision)) return // already offered for this protection
  void queuePurgeOffer(e.docId, 'protect')
}
