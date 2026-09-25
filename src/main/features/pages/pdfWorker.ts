import { PDFDocument } from 'pdf-lib'
import { serveJob } from '../../jobs/serveJob'
import type { SplitSpec } from '../../../shared/features/pages'
import { readOutline } from '../../../shared/features/pages/outline'
import { extractPages } from '../../../shared/features/pages/pdfOps'
import { formatPageList } from '../../../shared/features/pages/ranges'
import { planByBookmarks, planByRanges, planBySize, planEveryN, type SplitPlan } from '../../../shared/features/pages/split'
import type { PrepareJob } from '../../../shared/features/print'
import { preparePrintPdf } from '../../../shared/features/print/prepare'

/**
 * Worker thread for heavy PDF work, so loading, copying and saving big documents never blocks the app:
 * splitting a document into parts and preparing the pages to print. Cancelling the job terminates it.
 */

export type WorkerTask =
  | { task: 'split'; bytes: Uint8Array; spec: SplitSpec }
  | ({ task: 'prepare' } & PrepareJob)

export interface SplitPartOut {
  bytes: Uint8Array
  pages: string
  label: string
  oversized: boolean
}

export type WorkerResult = { task: 'split'; parts: SplitPartOut[]; warnings: string[] } | { task: 'prepare'; bytes: Uint8Array }

export const friendlyPdfError = (err: unknown): Error => {
  const msg = err instanceof Error ? err.message : String(err)
  if (/encrypt/i.test(msg)) return new Error('This document is password protected. Remove the password first.')
  return new Error(`This document could not be processed: ${msg}`)
}

async function planFor(bytes: Uint8Array, spec: SplitSpec, report: (f: number, m?: string) => void): Promise<SplitPlan> {
  let src: PDFDocument
  try {
    src = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (err) {
    throw friendlyPdfError(err)
  }
  const n = src.getPageCount()
  switch (spec.by) {
    case 'ranges': {
      const bad = spec.ranges.find((r) => r.from > n || r.to > n || r.from > r.to)
      if (bad) throw new Error(`The range ${bad.from}-${bad.to} does not fit a document of ${n} pages.`)
      return planByRanges(spec.ranges)
    }
    case 'every':
      return planEveryN(n, spec.pages)
    case 'bookmarks': {
      const { nodes, warnings } = readOutline(src)
      const plan = planByBookmarks(nodes, n)
      return { parts: plan.parts, warnings: [...warnings, ...plan.warnings] }
    }
    case 'size':
      return planBySize(n, spec.maxBytes, async (pages) => (await extractPages(bytes, pages)).length, {
        onProgress: (done, total) => report(0.05 + 0.4 * (done / total), `Measuring parts (${done} of ${total} pages placed)`)
      })
  }
}

serveJob<WorkerTask, WorkerResult>(async (task, report) => {
  if (task.task === 'prepare') {
    try {
      report(0.1, 'Preparing pages')
      return { task: 'prepare', bytes: await preparePrintPdf(task.bytes, { pages: task.pages, annotations: task.annotations, scale: task.scale }) }
    } catch (err) {
      throw friendlyPdfError(err)
    }
  }
  report(0.02, 'Reading the document')
  const plan = await planFor(task.bytes, task.spec, report)
  if (plan.parts.length === 0) throw new Error(plan.warnings.join(' ') || 'There is nothing to split.')
  const parts: SplitPartOut[] = []
  for (let i = 0; i < plan.parts.length; i++) {
    const p = plan.parts[i]
    report(0.5 + 0.5 * (i / plan.parts.length), `Creating part ${i + 1} of ${plan.parts.length}`)
    parts.push({ bytes: await extractPages(task.bytes, p.pages), pages: formatPageList(p.pages), label: p.label, oversized: !!p.oversized })
  }
  return { task: 'split', parts, warnings: plan.warnings }
})
