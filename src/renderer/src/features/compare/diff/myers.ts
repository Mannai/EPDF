/**
 * Myers' O(ND) difference algorithm in linear space (the "middle snake" bisection), on integer sequences.
 * The result is a minimal edit script: hunks of deleted and inserted elements between common runs.
 */

export interface Hunk {
  /** Deleted elements of A: [aStart, aEnd). */
  aStart: number
  aEnd: number
  /** Inserted elements of B: [bStart, bEnd). */
  bStart: number
  bEnd: number
}

type Seq = ArrayLike<number>

interface Budget {
  /** Remaining inner-loop steps before the search gives up on optimality (huge, wholly different pages). */
  steps: number
}

const DEFAULT_BUDGET = 60_000_000

/**
 * Finds a point (x, y) on an optimal path such that the problem splits into (A[..x], B[..y]) and (A[x..], B[y..]).
 * Returns null when no split was found within the budget.
 */
function bisect(a: Seq, aLo: number, aHi: number, b: Seq, bLo: number, bHi: number, budget: Budget): [number, number] | null {
  const n = aHi - aLo
  const m = bHi - bLo
  const maxD = Math.ceil((n + m) / 2)
  const off = maxD + 1
  const size = 2 * maxD + 3
  const v1 = new Int32Array(size).fill(-1)
  const v2 = new Int32Array(size).fill(-1)
  v1[off + 1] = 0
  v2[off + 1] = 0
  const delta = n - m
  const front = delta % 2 !== 0
  let k1start = 0
  let k1end = 0
  let k2start = 0
  let k2end = 0
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const i1 = off + k1
      let x1 = k1 === -d || (k1 !== d && v1[i1 - 1] < v1[i1 + 1]) ? v1[i1 + 1] : v1[i1 - 1] + 1
      let y1 = x1 - k1
      const s1 = x1
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++
        y1++
      }
      budget.steps -= x1 - s1 + 1
      v1[i1] = x1
      if (x1 > n) k1end += 2
      else if (y1 > m) k1start += 2
      else if (front) {
        const i2 = off + delta - k1
        if (i2 >= 0 && i2 < size && v2[i2] !== -1) {
          if (x1 >= n - v2[i2]) return [x1, y1]
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const i2 = off + k2
      let x2 = k2 === -d || (k2 !== d && v2[i2 - 1] < v2[i2 + 1]) ? v2[i2 + 1] : v2[i2 - 1] + 1
      let y2 = x2 - k2
      const s2 = x2
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
        x2++
        y2++
      }
      budget.steps -= x2 - s2 + 1
      v2[i2] = x2
      if (x2 > n) k2end += 2
      else if (y2 > m) k2start += 2
      else if (!front) {
        const i1 = off + delta - k2
        if (i1 >= 0 && i1 < size && v1[i1] !== -1) {
          const x1 = v1[i1]
          const y1 = off + x1 - i1
          if (x1 >= n - x2) return [x1, y1]
        }
      }
    }
    if (budget.steps < 0) return null
  }
  return null
}

function diffRange(a: Seq, aLo: number, aHi: number, b: Seq, bLo: number, bHi: number, out: Hunk[], budget: Budget): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    aLo++
    bLo++
  }
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
    aHi--
    bHi--
  }
  if (aLo === aHi && bLo === bHi) return
  if (aLo === aHi || bLo === bHi) {
    out.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi })
    return
  }
  const split = bisect(a, aLo, aHi, b, bLo, bHi, budget)
  if (split) {
    const x = aLo + split[0]
    const y = bLo + split[1]
    // A split at a corner would recurse forever; it only happens for degenerate inputs.
    if (!((x === aLo && y === bLo) || (x === aHi && y === bHi))) {
      diffRange(a, aLo, x, b, bLo, y, out, budget)
      diffRange(a, x, aHi, b, y, bHi, out, budget)
      return
    }
  }
  // No commonality found (or the budget ran out): treat the rest as one replacement.
  out.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi })
}

/** Merges neighbouring hunks that touch (a hunk ending where the next begins in both sequences). */
function coalesce(hunks: Hunk[]): Hunk[] {
  const out: Hunk[] = []
  for (const h of hunks) {
    const last = out[out.length - 1]
    if (last && last.aEnd === h.aStart && last.bEnd === h.bStart) {
      last.aEnd = h.aEnd
      last.bEnd = h.bEnd
    } else out.push({ ...h })
  }
  return out
}

/**
 * Minimal edit script turning `a` into `b`: hunks in order. Elements of `a` outside the hunks equal the
 * elements of `b` outside the hunks, one for one. `maxSteps` bounds the work for huge, unrelated inputs (the
 * result is then valid but not necessarily minimal).
 */
export function diffSequences(a: Seq, b: Seq, maxSteps = DEFAULT_BUDGET): Hunk[] {
  const out: Hunk[] = []
  diffRange(a, 0, a.length, b, 0, b.length, out, { steps: maxSteps })
  return slideRight(a, b, coalesce(out))
}

/**
 * A pure insertion or deletion can often sit at several equivalent places (moving "the big" in "in the big house"
 * past a neighbour that repeats it). Slide each such hunk as far right as it goes, so that a moved paragraph
 * that ends in "." is reported as exactly that paragraph and not as "." plus the paragraph minus its last "."
 * (the equal-cost alternative Myers may pick). The script stays minimal and valid.
 */
function slideRight(a: Seq, b: Seq, hunks: Hunk[]): Hunk[] {
  for (let k = 0; k < hunks.length; k++) {
    const h = hunks[k]
    const nextA = k + 1 < hunks.length ? hunks[k + 1].aStart : a.length
    if (h.aStart === h.aEnd && h.bStart < h.bEnd) {
      while (h.aEnd < nextA && h.bEnd < b.length && b[h.bStart] === b[h.bEnd]) {
        h.aStart++
        h.aEnd++
        h.bStart++
        h.bEnd++
      }
    } else if (h.bStart === h.bEnd && h.aStart < h.aEnd) {
      while (h.aEnd < nextA && a[h.aStart] === a[h.aEnd]) {
        h.aStart++
        h.aEnd++
        h.bStart++
        h.bEnd++
      }
    }
  }
  return coalesce(hunks)
}

/** Applies hunks to `a`, taking inserted elements from `b`. Used by tests to prove a script is correct. */
export function applyHunks<T>(a: ArrayLike<T>, b: ArrayLike<T>, hunks: Hunk[]): T[] {
  const out: T[] = []
  let ai = 0
  for (const h of hunks) {
    while (ai < h.aStart) out.push(a[ai++])
    ai = h.aEnd
    for (let j = h.bStart; j < h.bEnd; j++) out.push(b[j])
  }
  while (ai < a.length) out.push(a[ai++])
  return out
}

/** Number of edits (deletions plus insertions) of a script. */
export const editCost = (hunks: Hunk[]): number => hunks.reduce((s, h) => s + (h.aEnd - h.aStart) + (h.bEnd - h.bStart), 0)
