import { similarity } from './charDiff'

/**
 * Moved-text detection. A block of text that vanished in one place and appeared in another is a MOVE, not a
 * deletion plus an addition. Candidates are the removed and added chunks of the page diffs; a chunk is matched
 * with an identical chunk (exact) or a nearly identical one (edited move). Matching is one-to-one.
 */

/** Shorter chunks are ordinary edits: "of the" removed here and added there is a coincidence, not a move. */
export const MIN_MOVE_WORDS = 4
const FUZZY_MIN_WORDS = 6
const FUZZY_TRIGRAM_DICE = 0.6
const FUZZY_TEXT_SIMILARITY = 0.85

export interface Chunk {
  /** Any id the caller uses to identify the chunk. */
  id: number
  /** Comparison keys of the chunk's words. */
  keys: string[]
  /** Page pair the chunk lives in (the nearest candidate wins). */
  pair: number
}

export interface MovePair {
  removed: number
  added: number
  /** The texts differ slightly. */
  edited: boolean
}

const trigrams = (keys: string[]): Set<string> => {
  const out = new Set<string>()
  for (let i = 0; i + 2 < keys.length; i++) out.add(`${keys[i]}\u0001${keys[i + 1]}\u0001${keys[i + 2]}`)
  return out
}

/** Pairs removed chunks with added chunks that hold the same (or almost the same) text. */
export function detectMoves(removed: Chunk[], added: Chunk[]): MovePair[] {
  const R = removed.filter((c) => c.keys.length >= MIN_MOVE_WORDS)
  const A = added.filter((c) => c.keys.length >= MIN_MOVE_WORDS)
  const out: MovePair[] = []
  const usedR = new Set<number>()
  const usedA = new Set<number>()

  // Exact matches. Longest chunks first so a long block is not stolen by a short coincidence.
  const byText = new Map<string, Chunk[]>()
  for (const a of A) {
    const k = a.keys.join('\u0001')
    byText.set(k, [...(byText.get(k) ?? []), a])
  }
  for (const r of [...R].sort((x, y) => y.keys.length - x.keys.length || x.id - y.id)) {
    const list = byText.get(r.keys.join('\u0001'))?.filter((a) => !usedA.has(a.id))
    if (!list || list.length === 0) continue
    // The nearest chunk wins (a paragraph moved within its page beats one that happens to match a far page).
    const best = [...list].sort((p, q) => Math.abs(p.pair - r.pair) - Math.abs(q.pair - r.pair) || p.id - q.id)[0]
    usedR.add(r.id)
    usedA.add(best.id)
    out.push({ removed: r.id, added: best.id, edited: false })
  }

  // Near matches for longer chunks, through an inverted index over word trigrams.
  const restA = A.filter((a) => !usedA.has(a.id) && a.keys.length >= FUZZY_MIN_WORDS)
  const restR = R.filter((r) => !usedR.has(r.id) && r.keys.length >= FUZZY_MIN_WORDS)
  if (restA.length && restR.length) {
    const grams = new Map<Chunk, Set<string>>()
    const index = new Map<string, Chunk[]>()
    for (const a of restA) {
      const g = trigrams(a.keys)
      grams.set(a, g)
      for (const t of g) {
        const p = index.get(t)
        if (p) p.push(a)
        else index.set(t, [a])
      }
    }
    for (const r of restR.sort((x, y) => y.keys.length - x.keys.length || x.id - y.id)) {
      const rg = trigrams(r.keys)
      const shared = new Map<Chunk, number>()
      for (const t of rg) for (const a of index.get(t) ?? []) if (!usedA.has(a.id)) shared.set(a, (shared.get(a) ?? 0) + 1)
      let best: Chunk | null = null
      let bestScore = 0
      for (const [a, c] of shared) {
        const dice = (2 * c) / (rg.size + (grams.get(a)?.size ?? 0))
        if (dice >= FUZZY_TRIGRAM_DICE && dice > bestScore) {
          best = a
          bestScore = dice
        }
      }
      if (!best) continue
      if (similarity(r.keys.join(' '), best.keys.join(' ')) < FUZZY_TEXT_SIMILARITY) continue
      usedR.add(r.id)
      usedA.add(best.id)
      out.push({ removed: r.id, added: best.id, edited: true })
    }
  }
  return out
}
