import type { TextFont } from './fonts'
import { shapeText } from './shape'
import type { GlyphRun, LayoutGlyph, Line } from './types'

/**
 * Arabic justification by elongation (kashida): connecting letters are stretched with tatweel (U+0640) glyphs
 * instead of only widening the spaces, like typeset Arabic. The tatweel glyph is the one the font itself produces
 * for a tatweel between two joined letters, so the letters keep their joined forms and the bar meets them exactly.
 *
 * Placement rules (simplified from the usual Arabic typographic conventions):
 *  - only between two letters that are joined to each other (a dual-joining letter followed by a joining letter);
 *  - never inside a lam-alef pair, never after the last letter of a word;
 *  - seen/sheen/sad/dad (letters with a long, stretchable body) first, then other letters; spread over words evenly;
 *  - at most three tatweels at one point, and at most `MAX_SHARE` of the slack is spent on kashida (the rest widens spaces).
 */

const MAX_SHARE = 0.75
const MAX_PER_POINT = 3

/** Letters that do not join to the FOLLOWING letter (right-joining or non-joining). */
const RIGHT_JOINING = new Set<number>([
  0x0622, 0x0623, 0x0624, 0x0625, 0x0627, 0x0629, 0x062f, 0x0630, 0x0631, 0x0632, 0x0648, 0x0671, 0x0672, 0x0673, 0x0675, 0x0676, 0x0677,
  0x0688, 0x0689, 0x068a, 0x068b, 0x068c, 0x068d, 0x068e, 0x068f, 0x0690, 0x0691, 0x0692, 0x0693, 0x0694, 0x0695, 0x0696, 0x0697, 0x0698,
  0x0699, 0x06c0, 0x06c3, 0x06c4, 0x06c5, 0x06c6, 0x06c7, 0x06c8, 0x06c9, 0x06ca, 0x06cb, 0x06cd, 0x06cf, 0x06d2, 0x06d3, 0x06d5, 0x06ee, 0x06ef
])

const isArabicLetter = (cp: number): boolean => (cp >= 0x0620 && cp <= 0x064a) || (cp >= 0x0671 && cp <= 0x06d3) || (cp >= 0x06fa && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || cp === 0x06d5
/** Joins to the following letter (dual-joining). */
const joinsForward = (cp: number): boolean => isArabicLetter(cp) && !RIGHT_JOINING.has(cp) && cp !== 0x0621
const joinsBackward = (cp: number): boolean => isArabicLetter(cp) && cp !== 0x0621
const isAlef = (cp: number): boolean => cp === 0x0627 || cp === 0x0622 || cp === 0x0623 || cp === 0x0625 || cp === 0x0671
const priorityOf = (cp: number): number => (cp === 0x0633 || cp === 0x0634 || cp === 0x0635 || cp === 0x0636 ? 0 : cp === 0x0637 || cp === 0x0638 || cp === 0x062d || cp === 0x062c || cp === 0x062e || cp === 0x0643 ? 1 : 2)

interface Tatweel {
  gid: number
  /** Advance in font units. */
  advance: number
}
const tatweelCache = new WeakMap<TextFont, Tatweel | null>()

/** The tatweel glyph the font uses between joined letters (found by shaping ب ـ ب), or null if it has none. */
function tatweelOf(font: TextFont): Tatweel | null {
  let t = tatweelCache.get(font)
  if (t === undefined) {
    t = null
    if (font.hasGlyph(0x0640) && font.hasGlyph(0x0628)) {
      const s = shapeText({ font, rtl: true, script: 'Arab', lang: 'ar' }, 'بـب')
      // Glyphs of the middle character: cluster 1.
      const mid: number[] = []
      for (let i = 0; i < s.length; i++) if (s.cluster[i] === 1) mid.push(i)
      if (mid.length === 1) t = { gid: s.gid[mid[0]!]!, advance: s.ax[mid[0]!]! }
    }
    tatweelCache.set(font, t)
  }
  return t
}

interface Candidate {
  run: GlyphRun
  /** Index in run.glyphs before which the tatweel goes (visual position). */
  at: number
  priority: number
  word: number
  order: number
  tatweel: Tatweel
}

/**
 * Widen `line` by up to `extra` layout units with kashida. Returns the width actually added (0 when the line has no
 * suitable letters or the font has no tatweel). `text` is the layout's source text.
 */
export function kashidaJustify(line: Line, extra: number, text: string): number {
  const candidates: Candidate[] = []
  let word = 0
  for (const run of line.runs) {
    if (run.hanging) continue
    if (!run.rtl || run.script !== 'Arab') {
      word++
      continue
    }
    const tatweel = tatweelOf(run.font)
    if (!tatweel) continue
    const gs = run.glyphs
    // Logical scan: glyphs carrying characters, sorted by source position.
    const order = gs.map((g, i) => ({ g, i })).filter((x) => x.g.chars > 0).sort((a, b) => a.g.cluster - b.g.cluster)
    for (let n = 0; n < order.length; n++) {
      const cur = order[n]!
      const cp = text.charCodeAt(cur.g.cluster)
      if (cp === 0x20) {
        word++
        continue
      }
      if (!joinsForward(cp) || cp === 0x0640) continue
      // next joining letter of the same word (skip marks)
      let m = n + 1
      while (m < order.length && /\p{Mn}/u.test(text[order[m]!.g.cluster] ?? '')) m++
      const nxt = order[m]
      if (!nxt) continue
      const cq = text.charCodeAt(nxt.g.cluster)
      if (!joinsBackward(cq)) continue
      if (cp === 0x0644 && isAlef(cq)) continue // lam-alef
      // Insert before the leftmost glyph of the current letter (its base and every glyph up to the next letter).
      let leftmost = cur.i
      for (let k = 0; k < gs.length; k++) {
        const c = gs[k]!.cluster
        if (c >= cur.g.cluster && c < nxt.g.cluster) leftmost = Math.min(leftmost, k)
      }
      // The letter after the next one must exist unless next is the last letter and not an alef: allow.
      candidates.push({ run, at: leftmost, priority: priorityOf(cp), word, order: n, tatweel })
    }
    word++
  }
  if (candidates.length === 0) return 0
  const adv = (c: Candidate): number => (c.tatweel.advance * c.run.size) / c.run.font.upem
  const unit = adv(candidates[0]!)
  if (unit <= 0) return 0
  let budget = Math.floor((extra * MAX_SHARE) / unit)
  if (budget <= 0) return 0
  // Best candidate first inside each word.
  const byWord = new Map<number, Candidate[]>()
  for (const c of candidates) {
    const l = byWord.get(c.word) ?? []
    l.push(c)
    byWord.set(c.word, l)
  }
  const lists = [...byWord.values()].map((l) => l.sort((a, b) => a.priority - b.priority || Math.abs(a.order - l.length / 2) - Math.abs(b.order - l.length / 2)))
  const counts = new Map<Candidate, number>()
  let progress = true
  for (let pass = 0; budget > 0 && progress; pass++) {
    progress = false
    for (const l of lists) {
      if (budget <= 0) break
      const c = l[pass % l.length]
      if (!c) continue
      const have = counts.get(c) ?? 0
      if (have >= MAX_PER_POINT) continue
      counts.set(c, have + 1)
      budget--
      progress = true
    }
  }
  // Apply: insert from the highest index down so earlier indices stay valid.
  const byRun = new Map<GlyphRun, [Candidate, number][]>()
  for (const [c, n] of counts) {
    const l = byRun.get(c.run) ?? []
    l.push([c, n])
    byRun.set(c.run, l)
  }
  let added = 0
  for (const [run, list] of byRun) {
    list.sort((a, b) => b[0].at - a[0].at)
    for (const [c, n] of list) {
      const right = run.glyphs[c.at]
      const w = adv(c)
      for (let k = 0; k < n; k++) {
        const g: LayoutGlyph = {
          gid: c.tatweel.gid,
          cluster: right?.cluster ?? 0,
          chars: 0,
          advance: w,
          natural: w,
          x: 0,
          y: (right?.y ?? 0) - (right?.dy ?? 0),
          dx: 0,
          dy: 0
        }
        run.glyphs.splice(c.at, 0, g)
        added += w
      }
    }
  }
  return added
}
