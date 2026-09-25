/**
 * Page-range text: "1-3, 7, 9-" → [{from:1,to:3},{from:7,to:7},{from:9,to:numPages}].
 * Pure (no PDF library) so it can be shared by the renderer, the main process and the tests.
 */

/** A 1-based, inclusive page range. */
export interface PageRange {
  from: number
  to: number
}

export type RangeParse = { ok: true; ranges: PageRange[] } | { ok: false; error: string }

const isInt = (s: string): boolean => /^\d+$/.test(s)

/**
 * Parses a user-typed range list against a document with `numPages` pages.
 * Accepted tokens (separated by commas, semicolons or spaces): `5`, `2-6` (also with an en dash),
 * `9-` (to the last page) and `-4` (from the first page). Every problem yields a readable message.
 */
export function parsePageRanges(input: string, numPages: number): RangeParse {
  const text = input.trim()
  if (!text) return { ok: false, error: 'Enter at least one page or range, for example 1-3, 7, 9-.' }
  if (numPages < 1) return { ok: false, error: 'The document has no pages.' }
  const tokens = text
    .replace(/\s*[-–—]\s*/g, '-') // "1 - 3" and "1–3" both mean 1-3
    .split(/[\s,;]+/)
    .filter(Boolean)
  const ranges: PageRange[] = []
  for (const tok of tokens) {
    let from: number
    let to: number
    if (isInt(tok)) {
      from = to = Number(tok)
    } else {
      const m = /^(\d*)-(\d*)$/.exec(tok)
      if (!m || (m[1] === '' && m[2] === '')) return { ok: false, error: `“${tok}” isn’t a page number or range.` }
      from = m[1] === '' ? 1 : Number(m[1])
      to = m[2] === '' ? numPages : Number(m[2])
      if (m[1] !== '' && m[2] !== '' && from > to) return { ok: false, error: `The range ${from}-${to} runs backwards.` }
    }
    if (from < 1 || to < 1) return { ok: false, error: 'Page numbers start at 1.' }
    const bad = from > numPages ? from : to > numPages ? to : 0
    if (bad) {
      return { ok: false, error: `Page ${bad} is out of range: the document has ${numPages} page${numPages === 1 ? '' : 's'}.` }
    }
    ranges.push({ from, to })
  }
  if (ranges.length === 0) return { ok: false, error: 'Enter at least one page or range, for example 1-3, 7, 9-.' }
  return { ok: true, ranges }
}

/** 0-based page indices of the ranges, in the order typed. `unique` drops repeats (first occurrence wins). */
export function expandRanges(ranges: PageRange[], opts: { unique?: boolean } = {}): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const r of ranges) {
    for (let p = r.from; p <= r.to; p++) {
      if (opts.unique && seen.has(p)) continue
      seen.add(p)
      out.push(p - 1)
    }
  }
  return out
}

/** Sorted, de-duplicated 0-based indices → "1-3, 7, 9-10" (1-based, for messages and file names). */
export function formatPageList(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j === i ? String(sorted[i] + 1) : `${sorted[i] + 1}-${sorted[j] + 1}`)
    i = j + 1
  }
  return parts.join(', ')
}

/** Shorthand for parts named after their pages: "1-3" or "7". */
export const rangeLabel = (r: PageRange): string => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)

/** Splits the sorted 0-based indices into runs of consecutive pages. */
export function toRuns(indices: number[]): PageRange[] {
  const sorted = [...new Set(indices)].sort((a, b) => a - b)
  const runs: PageRange[] = []
  for (const i of sorted) {
    const last = runs[runs.length - 1]
    if (last && last.to === i) last.to = i + 1
    else runs.push({ from: i + 1, to: i + 1 })
  }
  return runs
}
