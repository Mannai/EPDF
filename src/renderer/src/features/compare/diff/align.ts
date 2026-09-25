import type { PagePair } from './types'

/**
 * Page alignment. Documents are compared page pair by page pair, so the first job is to decide which old page
 * corresponds to which new page even when pages were inserted, deleted, duplicated or moved:
 *
 *  1. every page gets a fingerprint (the set of hashed word trigrams); similarity is the Dice coefficient;
 *  2. an inverted index finds candidate pairs without comparing all N*M pairs (very common trigrams, such as a
 *     running header, are ignored);
 *  3. the heaviest in-order chain of similar pages (weighted longest increasing subsequence) becomes the anchors;
 *  4. pages left over that are alike are matched as MOVED pages;
 *  5. what remains between two anchors is paired in order where it is alike enough (a rewritten page), otherwise
 *     it is a removed page (old only) or an added page (new only).
 */

export const ANCHOR_SIMILARITY = 0.35
export const MOVED_SIMILARITY = 0.6
export const GAP_SIMILARITY = 0.1

const hashStr = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h | 0
}

/** Sorted unique hashes of the word trigrams of a page (words and word pairs for very short pages). */
export function fingerprint(keys: string[]): Int32Array {
  const hs = keys.map(hashStr)
  const set = new Set<number>()
  if (hs.length >= 3) {
    for (let i = 0; i + 2 < hs.length; i++) set.add((Math.imul(Math.imul(hs[i], 31) + hs[i + 1], 31) + hs[i + 2]) | 0)
  } else {
    for (let i = 0; i < hs.length; i++) set.add(hs[i])
    for (let i = 0; i + 1 < hs.length; i++) set.add((Math.imul(hs[i], 31) + hs[i + 1] + 7) | 0)
  }
  return Int32Array.from(set).sort()
}

/** Dice similarity of two fingerprints. Two empty pages are identical (1); an empty and a non-empty page share nothing (0). */
export function fingerprintSimilarity(a: Int32Array, b: Int32Array): number {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  let i = 0
  let j = 0
  let shared = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared++
      i++
      j++
    } else if (a[i] < b[j]) i++
    else j++
  }
  return (2 * shared) / (a.length + b.length)
}

interface Edge {
  i: number
  j: number
  sim: number
}

/** Heaviest chain of edges strictly increasing in both i and j (weights are similarities). */
function heaviestChain(edges: Edge[], nNew: number): Edge[] {
  const sorted = [...edges].sort((a, b) => a.i - b.i || b.j - a.j)
  // Fenwick tree over j holding the best chain weight ending at or before j, and the edge that achieves it.
  const bestW = new Float64Array(nNew + 2)
  const bestE = new Int32Array(nNew + 2).fill(-1)
  const prev = new Int32Array(sorted.length).fill(-1)
  const weight = new Float64Array(sorted.length)
  /** Heavier chains win; equal weights prefer the earlier page pair (so an extra duplicate ends up last). */
  const beats = (w1: number, e1: number, w2: number, e2: number): boolean => {
    if (e2 < 0) return w1 > 0
    if (w1 > w2 + 1e-9) return true
    if (w1 < w2 - 1e-9) return false
    return sorted[e1].j < sorted[e2].j || (sorted[e1].j === sorted[e2].j && sorted[e1].i < sorted[e2].i)
  }
  const query = (j: number): [number, number] => {
    let w = 0
    let e = -1
    for (let x = j; x > 0; x -= x & -x) {
      if (bestE[x] >= 0 && beats(bestW[x], bestE[x], w, e)) {
        w = bestW[x]
        e = bestE[x]
      }
    }
    return [w, e]
  }
  const update = (j: number, w: number, e: number): void => {
    for (let x = j; x <= nNew; x += x & -x) {
      if (beats(w, e, bestW[x], bestE[x])) {
        bestW[x] = w
        bestE[x] = e
      }
    }
  }
  let top = -1
  let topW = 0
  sorted.forEach((edge, idx) => {
    const [w, e] = query(edge.j) // chains ending strictly before column j (1-based index j means column j-1)
    weight[idx] = w + edge.sim
    prev[idx] = e
    update(edge.j + 1, weight[idx], idx)
    if (weight[idx] > topW) {
      topW = weight[idx]
      top = idx
    }
  })
  const chain: Edge[] = []
  for (let e = top; e >= 0; e = prev[e]) chain.push(sorted[e])
  return chain.reverse()
}

/**
 * Aligns the pages of two documents. `oldPages`/`newPages` hold each page's comparison keys. The result lists
 * page pairs in the new document's order, with pages that exist only in the old document placed where they were.
 */
export function alignPages(oldPages: string[][], newPages: string[][]): PagePair[] {
  const nOld = oldPages.length
  const nNew = newPages.length
  const fpOld = oldPages.map(fingerprint)
  const fpNew = newPages.map(fingerprint)
  const sim = (i: number, j: number): number => fingerprintSimilarity(fpOld[i], fpNew[j])

  // ---- candidate pairs through an inverted index ------------------------------------------------------------
  const dfOld = new Map<number, number>()
  const dfNew = new Map<number, number>()
  for (const f of fpOld) for (const h of f) dfOld.set(h, (dfOld.get(h) ?? 0) + 1)
  for (const f of fpNew) for (const h of f) dfNew.set(h, (dfNew.get(h) ?? 0) + 1)
  const maxDf = nOld + nNew > 60 ? Math.max(12, Math.ceil(0.08 * Math.max(nOld, nNew))) : Infinity
  const useful = (h: number): boolean => (dfOld.get(h) ?? 0) <= maxDf && (dfNew.get(h) ?? 0) <= maxDf
  const sizeOld = fpOld.map((f) => f.filter(useful).length)
  const sizeNew = fpNew.map((f) => f.filter(useful).length)
  const postings = new Map<number, number[]>()
  fpOld.forEach((f, i) => {
    for (const h of f) {
      if (!useful(h)) continue
      const p = postings.get(h)
      if (p) p.push(i)
      else postings.set(h, [i])
    }
  })
  const edges: Edge[] = []
  const edgeSim = new Map<number, number>() // i * nNew + j -> similarity
  const addEdge = (i: number, j: number, s: number): void => {
    const k = i * nNew + j
    if (edgeSim.has(k)) return
    edgeSim.set(k, s)
    edges.push({ i, j, sim: s })
  }
  for (let j = 0; j < nNew; j++) {
    const shared = new Map<number, number>()
    for (const h of fpNew[j]) {
      if (!useful(h)) continue
      for (const i of postings.get(h) ?? []) shared.set(i, (shared.get(i) ?? 0) + 1)
    }
    for (const [i, c] of shared) {
      const s = (2 * c) / (sizeOld[i] + sizeNew[j])
      if (s >= ANCHOR_SIMILARITY) addEdge(i, j, s)
    }
  }
  // Pages whose every trigram was ignored as boilerplate can only be matched when they are identical.
  const byText = new Map<string, number[]>()
  oldPages.forEach((keys, i) => {
    if (keys.length === 0) return
    const k = keys.join('\u0001')
    byText.set(k, [...(byText.get(k) ?? []), i])
  })
  newPages.forEach((keys, j) => {
    if (keys.length === 0) return
    const olds = byText.get(keys.join('\u0001'))
    if (!olds) return
    for (const i of olds) if (olds.length * 1 <= 200 || Math.abs(i - j) <= 50) addEdge(i, j, 1)
  })

  // ---- in-order anchors, then moved pages --------------------------------------------------------------------
  const chain = heaviestChain(edges, nNew)
  const oldTaken = new Int32Array(nOld).fill(-1) // partner (new index) of each old page
  const newTaken = new Int32Array(nNew).fill(-1)
  const movedNew = new Set<number>()
  for (const e of chain) {
    oldTaken[e.i] = e.j
    newTaken[e.j] = e.i
  }
  const simOf = new Map<number, number>()
  for (const e of chain) simOf.set(e.i * nNew + e.j, e.sim)
  const leftovers = edges
    .filter((e) => e.sim >= MOVED_SIMILARITY && oldTaken[e.i] < 0 && newTaken[e.j] < 0)
    .sort((a, b) => b.sim - a.sim || Math.abs(a.i - a.j) - Math.abs(b.i - b.j) || a.i - b.i)
  for (const e of leftovers) {
    if (oldTaken[e.i] >= 0 || newTaken[e.j] >= 0) continue
    oldTaken[e.i] = e.j
    newTaken[e.j] = e.i
    movedNew.add(e.j)
    simOf.set(e.i * nNew + e.j, e.sim)
  }

  // ---- fill the gaps between anchors -------------------------------------------------------------------------
  const anchors: [number, number][] = [[-1, -1], ...chain.map((e): [number, number] => [e.i, e.j]), [nOld, nNew]]
  const out: PagePair[] = []
  const pair = (o: number | null, n: number | null, s: number, moved = false): PagePair => ({
    old: o === null ? null : o + 1,
    new: n === null ? null : n + 1,
    similarity: s,
    moved,
    changes: 0
  })

  for (let a = 0; a + 1 < anchors.length; a++) {
    const [ia, ja] = anchors[a]
    const [ib, jb] = anchors[a + 1]
    const freeOld: number[] = []
    const freeNew: number[] = []
    const movedHere: number[] = []
    for (let i = ia + 1; i < ib; i++) if (oldTaken[i] < 0) freeOld.push(i)
    for (let j = ja + 1; j < jb; j++) {
      if (newTaken[j] < 0) freeNew.push(j)
      else if (movedNew.has(j)) movedHere.push(j)
    }

    const ops: { o: number | null; n: number | null; s: number }[] = []
    const cells = freeOld.length * freeNew.length
    if (freeOld.length === 1 && freeNew.length === 1) {
      ops.push({ o: freeOld[0], n: freeNew[0], s: sim(freeOld[0], freeNew[0]) })
    } else if (cells > 0) {
      const score = (i: number, j: number): number => {
        const known = edgeSim.get(i * nNew + j)
        if (known !== undefined) return known
        if (cells > 20_000) return fpOld[i].length === 0 && fpNew[j].length === 0 ? 1 : 0
        const s = sim(i, j)
        return s >= GAP_SIMILARITY ? s : 0
      }
      const R = freeOld.length
      const C = freeNew.length
      const f = new Float64Array((R + 1) * (C + 1))
      const at = (r: number, c: number): number => r * (C + 1) + c
      for (let r = 1; r <= R; r++) {
        for (let c = 1; c <= C; c++) {
          const s = score(freeOld[r - 1], freeNew[c - 1])
          f[at(r, c)] = Math.max(f[at(r - 1, c)], f[at(r, c - 1)], s > 0 ? f[at(r - 1, c - 1)] + s : 0)
        }
      }
      const rev: typeof ops = []
      let r = R
      let c = C
      // Walking back from the end, skipping a page is preferred over pairing it, so the EARLIER pages get paired
      // and any surplus pages end up last.
      while (r > 0 || c > 0) {
        if (r > 0 && (c === 0 || Math.abs(f[at(r, c)] - f[at(r - 1, c)]) < 1e-9)) {
          rev.push({ o: freeOld[r - 1], n: null, s: 0 })
          r--
        } else if (c > 0 && (r === 0 || Math.abs(f[at(r, c)] - f[at(r, c - 1)]) < 1e-9)) {
          rev.push({ o: null, n: freeNew[c - 1], s: 0 })
          c--
        } else {
          rev.push({ o: freeOld[r - 1], n: freeNew[c - 1], s: score(freeOld[r - 1], freeNew[c - 1]) })
          r--
          c--
        }
      }
      ops.push(...rev.reverse())
    } else {
      for (const o of freeOld) ops.push({ o, n: null, s: 0 })
      for (const n of freeNew) ops.push({ o: null, n, s: 0 })
    }

    // Emit: moved-in pages sit at their new position among the other pages of the gap.
    let m = 0
    for (const op of ops) {
      if (op.n !== null) {
        while (m < movedHere.length && movedHere[m] < op.n) {
          out.push(pair(newTaken[movedHere[m]], movedHere[m], simOf.get(newTaken[movedHere[m]] * nNew + movedHere[m]) ?? 0, true))
          m++
        }
      }
      out.push(pair(op.o, op.n, op.s))
    }
    for (; m < movedHere.length; m++) out.push(pair(newTaken[movedHere[m]], movedHere[m], simOf.get(newTaken[movedHere[m]] * nNew + movedHere[m]) ?? 0, true))
    if (a + 2 < anchors.length) out.push(pair(ib, jb, simOf.get(ib * nNew + jb) ?? 0))
  }
  return out
}
