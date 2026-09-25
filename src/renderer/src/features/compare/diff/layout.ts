import type { RawItem } from './types'

/**
 * Reading order from geometry. PDF text is stored in whatever order the producer wrote it, and multi-column
 * pages interleave badly if lines are simply sorted top to bottom, so items are ordered with a recursive
 * XY-cut: split at vertical gutters that no item crosses (columns), otherwise at the largest horizontal gap
 * (between blocks), and read the leaves as lines. The same algorithm runs on both documents, so what matters
 * is that it is deterministic and that it keeps columns apart.
 */

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 10
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const MAX_DEPTH = 64

/** Groups items along one axis: a new group starts where the gap to everything before it is at least `minGap`. */
function splitByGaps(items: RawItem[], axis: 'x' | 'y', minGap: number): RawItem[][] {
  const lo = (i: RawItem): number => (axis === 'x' ? i.x0 : i.y0)
  const hi = (i: RawItem): number => (axis === 'x' ? i.x1 : i.y1)
  const sorted = [...items].sort((a, b) => lo(a) - lo(b) || hi(a) - hi(b))
  const groups: RawItem[][] = []
  let cur: RawItem[] = []
  let reach = -Infinity
  for (const it of sorted) {
    if (cur.length && lo(it) - reach >= minGap) {
      groups.push(cur)
      cur = []
    }
    cur.push(it)
    reach = Math.max(reach, hi(it))
  }
  if (cur.length) groups.push(cur)
  return groups
}

/** The widest empty horizontal band: returns the items above and below it, or null if there is none of at least `minGap`. */
function splitAtLargestRowGap(items: RawItem[], minGap: number): [RawItem[], RawItem[]] | null {
  const sorted = [...items].sort((a, b) => a.y0 - b.y0 || a.y1 - b.y1)
  let reach = sorted[0].y1
  let best = -1
  let bestGap = minGap - 1e-9
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].y0 - reach
    if (gap > bestGap) {
      bestGap = gap
      best = i
    }
    reach = Math.max(reach, sorted[i].y1)
  }
  if (best < 0) return null
  return [sorted.slice(0, best), sorted.slice(best)]
}

function cut(items: RawItem[], size: number, depth: number, out: RawItem[][]): void {
  if (items.length < 2 || depth > MAX_DEPTH) {
    if (items.length) out.push(items)
    return
  }
  const columns = splitByGaps(items, 'x', Math.max(size, 8))
  if (columns.length > 1) {
    for (const c of columns) cut(c, size, depth + 1, out)
    return
  }
  const rows = splitAtLargestRowGap(items, Math.max(size * 0.5, 3))
  if (rows) {
    cut(rows[0], size, depth + 1, out)
    cut(rows[1], size, depth + 1, out)
    return
  }
  out.push(items)
}

/** Items in reading-order groups (columns and blocks); each group is then read line by line. */
export function readingGroups(items: RawItem[]): RawItem[][] {
  if (items.length === 0) return []
  const size = median(items.map((i) => i.size))
  const out: RawItem[][] = []
  cut(items, size, 0, out)
  return out
}

/** Lines (top to bottom) of one group; items inside a line run left to right. */
export function clusterLines(items: RawItem[]): RawItem[][] {
  const sorted = [...items].sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1) || a.x0 - b.x0)
  const lines: { y0: number; y1: number; items: RawItem[] }[] = []
  for (const it of sorted) {
    const last = lines[lines.length - 1]
    if (last) {
      const overlap = Math.min(it.y1, last.y1) - Math.max(it.y0, last.y0)
      const smaller = Math.min(it.y1 - it.y0, last.y1 - last.y0)
      if (overlap > 0.5 * smaller) {
        last.items.push(it)
        last.y0 = Math.min(last.y0, it.y0)
        last.y1 = Math.max(last.y1, it.y1)
        continue
      }
    }
    lines.push({ y0: it.y0, y1: it.y1, items: [it] })
  }
  return lines.map((l) => l.items.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0))
}
