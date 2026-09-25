import { describe, expect, it } from 'vitest'
import { applyHunks, diffSequences, editCost, type Hunk } from '../../src/renderer/src/features/compare/diff/myers'

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Reference: length of the longest common subsequence by the textbook DP. The minimal edit cost is |a|+|b|-2*LCS. */
function lcsLength(a: number[], b: number[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  return dp[a.length][b.length]
}

const randomSeq = (r: () => number, maxLen: number, alphabet: number): number[] => Array.from({ length: Math.floor(r() * (maxLen + 1)) }, () => Math.floor(r() * alphabet))

function mutate(r: () => number, a: number[], alphabet: number): number[] {
  const out = [...a]
  const edits = Math.floor(r() * 6)
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(r() * (out.length + 1))
    const roll = r()
    if (roll < 0.4) out.splice(at, 0, Math.floor(r() * alphabet))
    else if (roll < 0.8) out.splice(at, 1)
    else if (at < out.length) out[at] = Math.floor(r() * alphabet)
  }
  return out
}

function checkScript(a: number[], b: number[], hunks: Hunk[]): void {
  // hunks are ordered, non-overlapping, non-touching and never empty
  let ea = 0
  let eb = 0
  for (const h of hunks) {
    expect(h.aStart).toBeGreaterThanOrEqual(ea)
    expect(h.bStart).toBeGreaterThanOrEqual(eb)
    expect(h.aEnd - h.aStart + (h.bEnd - h.bStart)).toBeGreaterThan(0)
    // the equal run before the hunk really is equal
    expect(a.slice(ea, h.aStart)).toEqual(b.slice(eb, h.bStart))
    ea = h.aEnd
    eb = h.bEnd
  }
  expect(a.slice(ea)).toEqual(b.slice(eb))
  expect(applyHunks(a, b, hunks)).toEqual(b)
}

describe('Myers diff', () => {
  it('handles the trivial cases', () => {
    expect(diffSequences([], [])).toEqual([])
    expect(diffSequences([1, 2, 3], [1, 2, 3])).toEqual([])
    expect(diffSequences([], [1, 2])).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 2 }])
    expect(diffSequences([1, 2], [])).toEqual([{ aStart: 0, aEnd: 2, bStart: 0, bEnd: 0 }])
    expect(diffSequences([1, 2, 3], [4, 5, 6])).toEqual([{ aStart: 0, aEnd: 3, bStart: 0, bEnd: 3 }])
  })

  it('the classic ABCABBA / CBABAC example has the minimal cost 5', () => {
    const a = [...'ABCABBA'].map((c) => c.charCodeAt(0))
    const b = [...'CBABAC'].map((c) => c.charCodeAt(0))
    const h = diffSequences(a, b)
    checkScript(a, b, h)
    expect(editCost(h)).toBe(5)
  })

  it('a single changed word in a long sequence yields exactly one small hunk', () => {
    const a = Array.from({ length: 1000 }, (_, i) => i)
    const b = [...a]
    b[500] = -1
    expect(diffSequences(a, b)).toEqual([{ aStart: 500, aEnd: 501, bStart: 500, bEnd: 501 }])
  })

  it('applying the script to A yields B, and it is minimal, on 3000 random small inputs (tiny alphabet = many repeats)', () => {
    const r = rng(12345)
    for (let i = 0; i < 3000; i++) {
      const alphabet = 2 + Math.floor(r() * 5)
      const a = randomSeq(r, 14, alphabet)
      const b = r() < 0.5 ? randomSeq(r, 14, alphabet) : mutate(r, a, alphabet)
      const h = diffSequences(a, b)
      checkScript(a, b, h)
      expect(editCost(h), `a=${a} b=${b}`).toBe(a.length + b.length - 2 * lcsLength(a, b))
    }
  })

  it('is correct (applies cleanly) and minimal on larger inputs with sparse edits', () => {
    const r = rng(777)
    for (let i = 0; i < 60; i++) {
      const a = randomSeq(r, 400, 40)
      const b = mutate(r, mutate(r, a, 40), 40)
      const h = diffSequences(a, b)
      checkScript(a, b, h)
      expect(editCost(h)).toBe(a.length + b.length - 2 * lcsLength(a, b))
    }
  })

  it('still returns a valid script when the work budget is exhausted', () => {
    const r = rng(9)
    const a = randomSeq(r, 800, 3)
    const b = randomSeq(r, 800, 3)
    const h = diffSequences(a, b, 50)
    checkScript(a, b, h)
  })

  it('handles very different long sequences quickly', () => {
    const a = Array.from({ length: 6000 }, (_, i) => i)
    const b = Array.from({ length: 6000 }, (_, i) => i + 100000)
    const t = Date.now()
    const h = diffSequences(a, b)
    expect(h).toEqual([{ aStart: 0, aEnd: 6000, bStart: 0, bEnd: 6000 }])
    expect(Date.now() - t).toBeLessThan(3000)
  })
})
