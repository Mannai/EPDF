import { z } from 'zod'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { forgetTraces } from '../../services/traces'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'

/**
 * Main-process half of Redaction. Applying a redaction happens in the renderer through the edit pipeline; main
 * only does what the sandboxed renderer cannot: forgetting the copies Epdf itself keeps of the file it just saved.
 *
 * Every save snapshots the file that was on disk into the version history, unsaved edits are autosaved into the
 * recovery folder, and the library keeps the page text and a thumbnail of indexed files. Those still hold the
 * UNREDACTED content, so after a redacted (or newly protected) document is saved the user is offered to purge them.
 * The renderer names a document (`docId`), never a path: main resolves it.
 */

const payload = z.object({ docId: z.string().min(1) }).strict()

export interface PurgeSummary {
  /** Version-history snapshots that existed / were deleted. */
  versions: number
  deleted: number
  /** An autosaved recovery copy was removed. */
  recovery: boolean
  /** Copies that could not be deleted (their records are kept, so a later purge retries them). */
  failed: number
}

export function register(ctx: MainContext): void {
  registerFeatureChannel('redact:historyInfo', payload, ({ docId }) => {
    const path = ctx.pathOfDoc(docId)
    if (!path) return { versions: 0, recovery: false }
    return ctx.files.historyInfo(path)
  })

  registerFeatureChannel('redact:purgeHistory', payload, async ({ docId }): Promise<PurgeSummary> => {
    const path = ctx.pathOfDoc(docId)
    if (!path) throw new Error('Unknown document')
    const history = await ctx.files.purgeHistory(path)
    const traces = await forgetTraces(path)
    return { versions: history.versions, deleted: history.deleted, recovery: history.recovery, failed: history.failed + traces.failed }
  })

  contributeMenu({ menu: 'Tools', items: () => [commandItem('Redact…', 'redact.open')] })
}
