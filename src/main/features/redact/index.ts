import { readdir, rm, rmdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { commandItem, contributeMenu } from '../../menu/contributions'
import type { MainContext } from '../api'
import { registerFeatureChannel } from '../api'

/**
 * Main-process half of Redaction. Applying a redaction happens in the renderer through the edit pipeline; main
 * only does what the sandboxed renderer cannot: forgetting the copies Epdf itself keeps of the file it just saved.
 *
 * Every save snapshots the file that was on disk into the version history, and unsaved edits are autosaved into
 * the recovery folder. Those copies still hold the UNREDACTED content, so after a redacted document is saved the
 * user is offered to purge them. The renderer names a document (`docId`), never a path: main resolves it.
 */

const payload = z.object({ docId: z.string().min(1) }).strict()

export interface PurgeSummary {
  /** Version-history snapshots that existed / were deleted. */
  versions: number
  deleted: number
  /** An autosaved recovery copy was removed. */
  recovery: boolean
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  } catch {
    /* not empty, or already gone */
  }
}

export function register(ctx: MainContext): void {
  registerFeatureChannel('redact:historyInfo', payload, ({ docId }) => {
    const path = ctx.pathOfDoc(docId)
    if (!path) return { versions: 0, recovery: false }
    return { versions: ctx.files.listVersions(path).length, recovery: ctx.files.hasRecovery(path) }
  })

  registerFeatureChannel('redact:purgeHistory', payload, async ({ docId }): Promise<PurgeSummary> => {
    const path = ctx.pathOfDoc(docId)
    if (!path) throw new Error('Unknown document')
    const existing = ctx.files.listVersions(path).length
    // keep = 0: every snapshot row goes; the files it pointed to are ours to delete
    const files = ctx.repos.versions.prune(path, 0)
    let deleted = 0
    const dirs = new Set<string>()
    for (const f of files) {
      dirs.add(dirname(f))
      try {
        await rm(f, { force: true })
        deleted++
      } catch (err) {
        console.warn('could not delete a version snapshot', err)
      }
    }
    for (const d of dirs) await removeIfEmpty(d)
    const hadRecovery = ctx.files.hasRecovery(path)
    await ctx.files.clearRecovery(path)
    return { versions: existing, deleted, recovery: hadRecovery }
  })

  contributeMenu({ menu: 'Tools', items: () => [commandItem('Redact…', 'redact.open')] })
}
