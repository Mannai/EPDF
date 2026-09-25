import { firstPageOf, type OutlineNode } from './outline'
import { rangeLabel, type PageRange } from './ranges'

/**
 * Split planners: they decide which pages go into which output file. They are pure (the size-based one
 * takes the size measurement as a function), so they can be tested without producing real PDFs.
 */

export interface SplitPart {
  /** 0-based page indices, in output order. */
  pages: number[]
  /** Human text used in the summary and in the file name: "pages 1-3", a bookmark title... */
  label: string
  /** For size-based parts: the measured size, and whether it still exceeds the limit (a single page too big). */
  bytes?: number
  oversized?: boolean
}

export interface SplitPlan {
  parts: SplitPart[]
  warnings: string[]
}

const seq = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** One part per range typed by the user ("1-3, 4-10, 11-"). */
export function planByRanges(ranges: PageRange[]): SplitPlan {
  return { parts: ranges.map((r) => ({ pages: seq(r.from - 1, r.to - 1), label: `pages ${rangeLabel(r)}` })), warnings: [] }
}

/** Parts of `n` pages each (the last one may be shorter). */
export function planEveryN(numPages: number, n: number): SplitPlan {
  const size = Math.max(1, Math.floor(n))
  const parts: SplitPart[] = []
  for (let start = 0; start < numPages; start += size) {
    const end = Math.min(numPages, start + size) - 1
    parts.push({ pages: seq(start, end), label: `pages ${start + 1}${end > start ? `-${end + 1}` : ''}` })
  }
  return { parts, warnings: [] }
}

export interface SizePlanOptions {
  onProgress?: (pagesPlaced: number, total: number) => void
  signal?: { aborted: boolean }
}

/**
 * Builds parts that stay under `maxBytes`, always splitting between pages. `sizeOf` measures the file that
 * a given set of pages would produce. Each part is grown greedily: the number of measurements per part is
 * about 2·log2(pages in the part), because the size is searched by doubling and then bisecting.
 * A single page that is already over the limit becomes a part of its own, flagged `oversized`.
 */
export async function planBySize(
  numPages: number,
  maxBytes: number,
  sizeOf: (pages: number[]) => Promise<number>,
  opts: SizePlanOptions = {}
): Promise<SplitPlan> {
  const parts: SplitPart[] = []
  const warnings: string[] = []
  const cache = new Map<string, number>()
  const measure = async (from: number, to: number): Promise<number> => {
    const key = `${from}-${to}`
    let v = cache.get(key)
    if (v === undefined) {
      if (opts.signal?.aborted) throw new Error('Cancelled')
      v = await sizeOf(seq(from, to))
      cache.set(key, v)
    }
    return v
  }
  let start = 0
  while (start < numPages) {
    const single = await measure(start, start)
    if (single > maxBytes) {
      parts.push({ pages: [start], label: `page ${start + 1}`, bytes: single, oversized: true })
      warnings.push(`Page ${start + 1} alone is ${formatBytes(single)}, which is over the limit of ${formatBytes(maxBytes)}.`)
      start++
      opts.onProgress?.(start, numPages)
      continue
    }
    // `lo` always fits (it was measured); `hi` is the first end known not to fit.
    let lo = start
    let hi = -1
    let step = 1
    while (hi < 0 && lo < numPages - 1) {
      const probe = Math.min(numPages - 1, lo + step)
      if ((await measure(start, probe)) <= maxBytes) {
        lo = probe
        step *= 2
      } else hi = probe
    }
    while (hi >= 0 && hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if ((await measure(start, mid)) <= maxBytes) lo = mid
      else hi = mid
    }
    parts.push({ pages: seq(start, lo), label: lo > start ? `pages ${start + 1}-${lo + 1}` : `page ${start + 1}`, bytes: await measure(start, lo) })
    start = lo + 1
    opts.onProgress?.(start, numPages)
  }
  return { parts, warnings }
}

/**
 * One part per top-level bookmark that has a page destination. Parts start at the bookmark's page and end
 * before the next bookmark's page (bookmarks are ordered by page; two on the same page share a part).
 * Pages before the first bookmark become a leading part. Bookmarks without a resolvable page are skipped
 * (a heading whose children have destinations uses the first of them).
 */
export function planByBookmarks(outline: OutlineNode[], numPages: number): SplitPlan {
  const warnings: string[] = []
  const starts: { page: number; title: string }[] = []
  let skipped = 0
  for (const node of outline) {
    const page = firstPageOf(node)
    if (page === null || page < 0 || page >= numPages) {
      skipped++
      continue
    }
    starts.push({ page, title: node.title })
  }
  if (skipped) warnings.push(`${skipped} top-level bookmark${skipped === 1 ? ' was' : 's were'} skipped because ${skipped === 1 ? 'it has' : 'they have'} no page to go to.`)
  if (starts.length === 0) {
    warnings.push(outline.length ? 'None of the top-level bookmarks point at a page.' : 'This document has no bookmarks.')
    return { parts: [], warnings }
  }
  // Stable sort by page; merge bookmarks that start on the same page under the first title.
  const ordered = starts.map((s, i) => ({ ...s, i })).sort((a, b) => a.page - b.page || a.i - b.i)
  const merged: { page: number; title: string }[] = []
  for (const s of ordered) {
    if (merged.length && merged[merged.length - 1].page === s.page) continue
    merged.push(s)
  }
  const parts: SplitPart[] = []
  if (merged[0].page > 0) parts.push({ pages: seq(0, merged[0].page - 1), label: 'Front matter' })
  merged.forEach((s, i) => {
    const end = (i + 1 < merged.length ? merged[i + 1].page : numPages) - 1
    parts.push({ pages: seq(s.page, end), label: s.title })
  })
  return { parts, warnings }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`
}
