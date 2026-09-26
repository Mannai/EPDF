import { analyzeBidi, bracketPartner, lineLevels, reorderVisual } from '../text/bidi'

/**
 * Recovering the logical order of a line from its visual order.
 *
 * A PDF stores where glyphs are drawn, i.e. the VISUAL order produced by the Unicode Bidirectional Algorithm (UBA),
 * not the order the text was typed in. For a line of glyph clusters ("units", each carrying its own logical text, in
 * visual order left to right along the baseline) we look for a logical order whose UBA display (rules W1-W7, N0-N2,
 * I1-I2, L1-L2 of UAX #9, via bidi-js) reproduces exactly the visual order we see.
 *
 *  1. Candidate levels come from running the UBA on the visual string as if it were logical, which inverts the common
 *     structures (right-to-left words, numbers and Latin runs inside them). Rule L2 applied to items that keep their
 *     levels is an involution, so the candidate logical order is `reorderVisual(levels)` of the visual units.
 *  2. The candidate is VERIFIED by running the UBA forwards on the candidate logical string.
 *  3. If it does not reproduce the visual order, the levels of the ambiguous stretches (neutrals: spaces, punctuation,
 *     separators between numbers) are searched: each neutral run can belong to its left neighbour, its right neighbour
 *     or the paragraph level (or be split between the two neighbours). This recovers e.g. an Arabic-context date
 *     `2026-09-26`, which the UBA displays as `26-09-2026` (the digits become Arabic numbers, rule W2, and the hyphens
 *     between them resolve to right-to-left, rule N1).
 *  4. Several logical strings can display identically (the UBA is not injective). Among exact solutions, the one whose
 *     order agrees best with the order the producer drew the glyphs in (content stream order) wins: most producers
 *     draw runs in logical order.
 *  5. Paired brackets: producers either map a mirrored glyph to the character typed (LibreOffice, Skia, our engine) or
 *     to the shape drawn. The variant whose brackets pair up in the logical text wins.
 *
 * The result reports whether an exact solution was found; if not, the best-scoring candidate is returned (flagged).
 */

export interface VisualUnit {
  /** Logical text of the unit (a glyph cluster, or the /ActualText of a span). */
  text: string
  /** Stream order of the unit (lowest sequence number of its glyphs). */
  seq: number
}

export interface LogicalOrder {
  /** Visual indices in logical order. */
  order: number[]
  /** Embedding level of every visual unit. */
  levels: number[]
  /** Units whose bracket character must be replaced by its mirror (the producer mapped the drawn shape). */
  mirror: boolean[]
  exact: boolean
}

type Cls = 'R' | 'L' | 'N' | 'D'

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u
const LTR_CHAR = /\p{L}/u
const RTL_OR_CONTROL = /[֐-ࣿיִ-﷿ﹰ-ﻼ‏‪-‮⁦-⁩؜\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u
const DIGIT = /[\p{Nd}]/u

function classOf(text: string): Cls {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'R'
    if (LTR_CHAR.test(ch)) return 'L'
    if (DIGIT.test(ch)) return 'D'
  }
  return 'N'
}

const MIRROR_PAIRS: Record<string, string> = {}
for (const [a, b] of ['()', '[]', '{}', '<>', '«»', '‹›', '⁅⁆', '⁽⁾', '₍₎', '〈〉', '〈〉', '《》', '「」', '『』', '【】', '〔〕', '（）', '［］', '｛｝']) {
  MIRROR_PAIRS[a] = b
  MIRROR_PAIRS[b] = a
}
const mirrorChar = (ch: string): string => MIRROR_PAIRS[ch] ?? ch
const isBracketish = (t: string): boolean => t.length > 0 && [...t].some((c) => MIRROR_PAIRS[c] !== undefined)

/** Per-unit levels of `units` (joined) under the UBA, for paragraph level `para`, rule L1 applied to the line. */
function unitLevels(texts: string[], para: 0 | 1): number[] {
  const s = texts.join('')
  if (!s) return texts.map(() => para)
  const info = analyzeBidi(s, para ? 'rtl' : 'ltr')
  const lv = lineLevels(info, 0, s.length, para)
  const out: number[] = []
  let o = 0
  for (const t of texts) {
    out.push(t.length ? lv[o] : para)
    o += t.length
  }
  return out
}

/** Visual order (indices into `logicalTexts`) that the UBA gives the logical sequence. */
function forwardVisual(logicalTexts: string[], para: 0 | 1): number[] {
  return reorderVisual(unitLevels(logicalTexts, para))
}

function textsWith(units: VisualUnit[], mirror: boolean[]): string[] {
  return units.map((u, i) => (mirror[i] ? [...u.text].map(mirrorChar).join('') : u.text))
}

/** Number of visual positions the candidate order reproduces (n = exact). */
function score(texts: string[], order: number[], para: 0 | 1): number {
  const logical = order.map((i) => texts[i])
  const vis = forwardVisual(logical, para)
  let ok = 0
  for (let k = 0; k < vis.length; k++) if (order[vis[k]] === k) ok++
  return ok
}

/** Inversions between the logical order and the stream order (lower = the producer drew the runs in this order). */
function streamDisagreement(units: VisualUnit[], order: number[]): number {
  let inv = 0
  // count only between different directional runs: O(n^2) on small n, sampled for long lines
  const n = order.length
  const step = n > 400 ? Math.ceil(n / 400) : 1
  for (let a = 0; a < n; a += step) for (let b = a + 1; b < n; b += step) if (units[order[a]].seq > units[order[b]].seq) inv++
  return inv
}

function bracketImbalance(text: string): number {
  const stack: string[] = []
  let bad = 0
  for (const ch of text) {
    const p = bracketPartner(ch.codePointAt(0)!)
    if (!p) continue
    if (p.kind === 'open') stack.push(ch)
    else {
      const want = String.fromCodePoint(p.other)
      const at = stack.lastIndexOf(want)
      if (at < 0) bad++
      else {
        bad += stack.length - 1 - at
        stack.length = at
      }
    }
  }
  return bad + stack.length
}

interface Solution {
  order: number[]
  levels: number[]
  mirror: boolean[]
  score: number
  exact: boolean
  disagreement: number
  imbalance: number
}

function solve(units: VisualUnit[], para: 0 | 1, mirror: boolean[], budget: { n: number }): Solution {
  const n = units.length
  const texts = textsWith(units, mirror)
  const cls = texts.map(classOf)
  const base = unitLevels(texts, para)
  const evaluate = (levels: number[]): Solution => {
    const order = reorderVisual(levels)
    budget.n--
    const sc = score(texts, order, para)
    return { order, levels, mirror, score: sc, exact: sc === n, disagreement: -1, imbalance: -1 }
  }
  let best = evaluate(base)
  if (best.exact) return best

  // neutral runs (visual), with their neighbours
  const runs: { from: number; to: number }[] = []
  for (let i = 0; i < n; ) {
    if (cls[i] !== 'N') {
      i++
      continue
    }
    let j = i
    while (j < n && cls[j] === 'N') j++
    runs.push({ from: i, to: j })
    i = j
  }
  // digit runs can also be ambiguous in a left-to-right paragraph (0 = part of the text, 2 = a number after RTL)
  const digitRuns: { from: number; to: number }[] = []
  for (let i = 0; i < n; ) {
    if (cls[i] !== 'D') {
      i++
      continue
    }
    let j = i
    while (j < n && (cls[j] === 'D' || (cls[j] === 'N' && j + 1 < n && cls[j + 1] === 'D'))) j++
    digitRuns.push({ from: i, to: j })
    i = j
  }

  const exacts: Solution[] = []
  for (let pass = 0; pass < 3 && budget.n > 0; pass++) {
    let improved = false
    for (const r of runs) {
      if (budget.n <= 0) break
      const cur = best.levels
      const left = r.from > 0 ? cur[r.from - 1] : para
      const right = r.to < n ? cur[r.to] : para
      const options = new Set<string>()
      const cands: number[][] = []
      const add = (lv: number[]): void => {
        const k = lv.slice(r.from, r.to).join(',')
        if (options.has(k)) return
        options.add(k)
        cands.push(lv)
      }
      const len = r.to - r.from
      for (const v of [para, left, right, para + 1 + ((para + 1) % 2 === 0 ? 0 : 1)]) {
        const lv = cur.slice()
        for (let k = r.from; k < r.to; k++) lv[k] = v
        add(lv)
      }
      if (len > 1 && left !== right) {
        for (let split = 1; split < len && split <= 6; split++) {
          const lv = cur.slice()
          for (let k = r.from; k < r.to; k++) lv[k] = k - r.from < split ? left : right
          add(lv)
          const lv2 = cur.slice()
          for (let k = r.from; k < r.to; k++) lv2[k] = k - r.from < split ? left : para
          add(lv2)
          const lv3 = cur.slice()
          for (let k = r.from; k < r.to; k++) lv3[k] = k - r.from < split ? para : right
          add(lv3)
        }
      }
      for (const lv of cands) {
        if (budget.n <= 0) break
        const s = evaluate(lv)
        if (s.exact) exacts.push(s)
        if (s.score > best.score) {
          best = s
          improved = true
        }
      }
    }
    if (para === 0) {
      for (const r of digitRuns) {
        if (budget.n <= 0) break
        for (const v of [0, 2]) {
          const lv = best.levels.slice()
          for (let k = r.from; k < r.to; k++) lv[k] = v
          const s = evaluate(lv)
          if (s.exact) exacts.push(s)
          if (s.score > best.score) {
            best = s
            improved = true
          }
        }
      }
    }
    if (!improved) break
  }
  if (best.exact) exacts.push(best)
  if (exacts.length) {
    for (const s of exacts) s.disagreement = streamDisagreement(units, s.order)
    exacts.sort((a, b) => a.disagreement - b.disagreement)
    return exacts[0]
  }
  return best
}

/**
 * Logical order of a line given in visual order. `para` is the paragraph direction (0 = LTR, 1 = RTL).
 */
export function visualToLogicalOrder(units: VisualUnit[], para: 0 | 1): LogicalOrder {
  const n = units.length
  if (n === 0) return { order: [], levels: [], mirror: [], exact: true }
  const noMirror = new Array<boolean>(n).fill(false)
  // fast path: a left-to-right line without right-to-left letters or bidi controls reads as drawn
  if (para === 0 && !units.some((u) => RTL_OR_CONTROL.test(u.text))) return { order: units.map((_, i) => i), levels: new Array<number>(n).fill(0), mirror: noMirror, exact: true }
  const budget = { n: 600 }
  const first = solve(units, para, noMirror, budget)
  const candidates: Solution[] = [first]
  // Producers that map a mirrored glyph to the character it LOOKS like: the brackets that end up in right-to-left runs
  // are the mirrors of what was typed. Found by a small fixed-point iteration (start by mirroring all brackets).
  const brackets = units.map((u) => isBracketish(u.text))
  if (brackets.some(Boolean)) {
    let mirror = brackets
    for (let k = 0; k < 3; k++) {
      const s = solve(units, para, mirror, budget)
      const next = s.levels.map((l, i) => brackets[i] && (l & 1) === 1)
      if (next.every((v, i) => v === s.mirror[i]) || !next.some(Boolean)) {
        if (next.some(Boolean)) candidates.push(s)
        break
      }
      mirror = next
    }
  }
  for (const c of candidates) {
    const texts = textsWith(units, c.mirror)
    c.imbalance = bracketImbalance(c.order.map((i) => texts[i]).join(''))
  }
  const mirrored = (s: Solution): number => s.mirror.filter(Boolean).length
  candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || a.imbalance - b.imbalance || mirrored(a) - mirrored(b) || b.score - a.score)
  const c = candidates[0]
  // No logical text displays like this under the bidi algorithm: the producer did not use it. The usual non-conforming
  // producer reverses a right-to-left line and keeps each left-to-right run (words, numbers) in order.
  if (!c.exact && para === 1) return simpleReversal(units)
  return { order: c.order, levels: c.levels, mirror: c.mirror, exact: c.exact }
}

const JOINERS = '.,:/-_%@#+&=?'

/** Reverse the line, restore left-to-right runs, and mirror brackets outside them if that balances them. */
function simpleReversal(units: VisualUnit[]): LogicalOrder {
  const n = units.length
  const cls = units.map((u) => classOf(u.text))
  const ltrish = (i: number): boolean => cls[i] === 'L' || cls[i] === 'D'
  const rev = units.map((_, i) => n - 1 - i)
  const order: number[] = []
  const levels = new Array<number>(n).fill(1)
  for (let k = 0; k < n; ) {
    if (!ltrish(rev[k])) {
      order.push(rev[k++])
      continue
    }
    let j = k
    while (j < n && (ltrish(rev[j]) || (j > k && j + 1 < n && JOINERS.includes(units[rev[j]].text) && ltrish(rev[j + 1])))) j++
    const run = rev.slice(k, j).reverse()
    for (const i of run) levels[i] = 2
    order.push(...run)
    k = j
  }
  const plain = new Array<boolean>(n).fill(false)
  const flip = units.map((u, i) => levels[i] === 1 && isBracketish(u.text))
  const text = (m: boolean[]): string => order.map((i) => (m[i] ? mirrorText(units[i].text) : units[i].text)).join('')
  const mirror = flip.some(Boolean) && bracketImbalance(text(flip)) < bracketImbalance(text(plain)) ? flip : plain
  return { order, levels, mirror, exact: false }
}

export const mirrorText = (t: string): string => [...t].map(mirrorChar).join('')

/**
 * Logical order of a string stored in visual order (leftmost character first), e.g. a line some other extractor read
 * glyph by glyph. Characters are the units (combining marks stay with their base). `dir: 'auto'` = right-to-left when
 * right-to-left letters outnumber left-to-right ones. Presentation forms are left as they are (see normalizeGlyphText).
 */
export function visualToLogicalText(visual: string, dir: 'ltr' | 'rtl' | 'auto' = 'auto'): string {
  const units: VisualUnit[] = []
  for (const m of visual.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) units.push({ text: m[0], seq: units.length })
  let para: 0 | 1
  if (dir === 'auto') {
    let r = 0
    let l = 0
    for (const ch of visual) {
      if (RTL_CHAR.test(ch)) r++
      else if (LTR_CHAR.test(ch)) l++
    }
    para = r > l ? 1 : 0
  } else para = dir === 'rtl' ? 1 : 0
  const res = visualToLogicalOrder(units, para)
  return res.order.map((i) => (res.mirror[i] ? mirrorText(units[i].text) : units[i].text)).join('')
}
