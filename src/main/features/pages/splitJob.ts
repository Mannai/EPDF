import { PDFDocument } from 'pdf-lib'
import type { SplitSpec } from '../../../shared/features/pages'
import { readOutline } from '../../../shared/features/pages/outline'
import { extractPages } from '../../../shared/features/pages/pdfOps'
import { formatPageList } from '../../../shared/features/pages/ranges'
import { planByBookmarks, planByRanges, planBySize, planEveryN, type SplitPlan } from '../../../shared/features/pages/split'

/** The work of the split job, free of worker plumbing so it can be unit-tested. */

export interface SplitPartOut {
  bytes: Uint8Array
  pages: string
  label: string
  oversized: boolean
}

export interface SplitOutput {
  parts: SplitPartOut[]
  warnings: string[]
}

/** A user-presentable version of what pdf-lib throws for unreadable or protected files. */
export const friendlyPdfError = (err: unknown): Error => {
  const msg = err instanceof Error ? err.message : String(err)
  if (/encrypt/i.test(msg)) return new Error('This document is password protected. Remove the password first.')
  return new Error(`This document could not be processed: ${msg}`)
}

export async function planFor(bytes: Uint8Array, spec: SplitSpec, report: (fraction: number, message?: string) => void, signal?: { aborted: boolean }): Promise<SplitPlan> {
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
        signal,
        onProgress: (done, total) => report(0.05 + 0.4 * (done / total), `Measuring parts (${done} of ${total} pages placed)`)
      })
  }
}

/** Plans the split and produces every part as PDF bytes. Throws with a readable message when nothing can be made. */
export async function runSplit(bytes: Uint8Array, spec: SplitSpec, report: (fraction: number, message?: string) => void): Promise<SplitOutput> {
  report(0.02, 'Reading the document')
  const plan = await planFor(bytes, spec, report)
  if (plan.parts.length === 0) throw new Error(plan.warnings.join(' ') || 'There is nothing to split.')
  const parts: SplitPartOut[] = []
  for (let i = 0; i < plan.parts.length; i++) {
    const p = plan.parts[i]
    report(0.5 + 0.5 * (i / plan.parts.length), `Creating part ${i + 1} of ${plan.parts.length}`)
    try {
      parts.push({ bytes: await extractPages(bytes, p.pages), pages: formatPageList(p.pages), label: p.label, oversized: !!p.oversized })
    } catch (err) {
      throw friendlyPdfError(err)
    }
  }
  return { parts, warnings: plan.warnings }
}
