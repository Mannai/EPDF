import { serveJob } from '../../jobs/serveJob'
import type { SplitSpec } from '../../../shared/features/pages'
import type { PrepareJob } from '../../../shared/features/print'
import { preparePrintPdf } from '../../../shared/features/print/prepare'
import { friendlyPdfError, runSplit, type SplitPartOut } from './splitJob'

/**
 * Worker thread for heavy PDF work, so loading, copying and saving big documents never blocks the app:
 * splitting a document into parts and preparing pages (extract / print). Cancelling the job terminates it.
 */

export type WorkerTask =
  | { task: 'split'; bytes: Uint8Array; spec: SplitSpec }
  | ({ task: 'prepare' } & PrepareJob)

export type WorkerResult = { task: 'split'; parts: SplitPartOut[]; warnings: string[] } | { task: 'prepare'; bytes: Uint8Array }

serveJob<WorkerTask, WorkerResult>(async (task, report) => {
  if (task.task === 'prepare') {
    try {
      report(0.1, 'Preparing pages')
      return { task: 'prepare', bytes: await preparePrintPdf(task.bytes, { pages: task.pages, annotations: task.annotations, scale: task.scale }) }
    } catch (err) {
      throw friendlyPdfError(err)
    }
  }
  const out = await runSplit(task.bytes, task.spec, report)
  return { task: 'split', ...out }
})
