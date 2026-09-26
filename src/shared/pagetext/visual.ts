import { analyzeBidi, bidiClassOf, bracketPartner, lineLevels, reorderVisual } from '../text/bidi'

/**
 * Recovering the logical order of a line from its visual order.
 *
 * A PDF stores where glyphs are drawn, i.e. the VISUAL order produced by the Unicode Bidirectional Algorithm (UBA),
 * not the order the text was typed in. For a line of glyph clusters ("units", each carrying its own logical text, in
 * visual order left to right along the baseline) we look for a logical order whose UBA display (rules W1-W7, N0-N2,
 * I1-I2, L1-L2 of UAX #9, via bidi-js) reproduces exactly the visual order we see.
 *
 *  1. Candidate levels: the UBA run on the visual string as if it were logical (inverts the common structures:
 *     right-to-left words, numbers and Latin runs inside them), plus two other starting points (neutrals at the
 *     paragraph level; numbers kept whole with the punctuation touching them). Rule L2 applied to items that keep
 *     their levels is an involution, so a candidate logical order is `reorderVisual(levels)` of the visual units.
 *  2. Every candidate is VERIFIED by running the UBA forwards on the candidate logical string, and REFINED to a fixed
 *     point: the levels the UBA gives the candidate, carried back to the visual units, define the next candidate. A
 *     fixed point displays exactly like the page.
 *  3. A neighbourhood search over the ambiguous stretches (neutral runs: spaces, punctuation, separators between
 *     numbers, each belonging to its left or right neighbour or the paragraph level, or split; bracket pairs jointly;
 *     digit runs in left-to-right paragraphs) finds the exact readings. This recovers e.g. an Arabic-context date
 *     `2026-09-26`, which the UBA displays as `26-09-2026` (the digits become Arabic numbers, rule W2, and the hyphens
 *     between them resolve to right-to-left, rule N1).
 *  4. Several logical strings can display identically (the UBA is not injective). Exact readings are ranked: brackets
 *     that pair up (and enclose something); Latin+digit clusters ("BHD 45.500", "PDF 42", "ISO 9001") in the
 *     left-to-right order a reader sees them, so copying gives what a person reads; numbers kept whole with their
 *     symbols; then the order the producer drew the glyphs in when that carries information, else the fewest
 *     direction runs.
 *  5. Paired brackets: producers either map a mirrored glyph to the character typed (LibreOffice, Skia, our engine) or
 *     to the shape drawn. Both are tried; the variant whose brackets pair up in the logical text wins.
 *
 * If no exact reading exists (the producer did not follow the UBA), a right-to-left line falls back to the usual
 * non-conforming behaviour (reverse the line, keep left-to-right runs), flagged `exact: false`.
 *
 * Measured (tests/unit/pagetext-bidi.test.ts): every case of the vendored BidiCharacterTest sample and of 6,000
 * generated mixed sentences is inverted to a reading that displays identically; the typed original is recovered for
 * ~97% of the conformance cases and ~91% (right-to-left) / ~75% (left-to-right with Arabic) of the generated ones
 * (99.7% / 91% of those typed in reader order), the rest being genuine ambiguities.
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

/**
 * Class of a unit from the bidi classes of its characters (the first strong or number character decides):
 * R/AL -> 'R', L -> 'L', EN/AN -> 'D' (Western, Arabic-Indic and Persian digits, Arabic decimal separators), else 'N'.
 */
function classOf(text: string): Cls {
  for (const ch of text) {
    if (ch.length > 1) {
      // astral: block knowledge
      if (RTL_CHAR.test(ch)) return 'R'
      if (LTR_CHAR.test(ch)) return 'L'
      if (DIGIT.test(ch)) return 'D'
      continue
    }
    const t = bidiClassOf(ch, 0)
    if (t === 'R' || t === 'AL') return 'R'
    if (t === 'L') return 'L'
    if (t === 'EN' || t === 'AN') return 'D'
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
  const evaluateRaw = (levels: number[]): Solution => {
    const order = reorderVisual(levels)
    budget.n--
    const sc = score(texts, order, para)
    return { order, levels, mirror, score: sc, exact: sc === n, disagreement: -1, imbalance: -1 }
  }
  /**
   * Fixed-point refinement: the levels the UBA gives the candidate logical text, carried back to the visual units,
   * define the next candidate. A fixed point displays exactly as the visual order (L2 is an involution).
   */
  const evaluate = (levels0: number[]): Solution => {
    let s = evaluateRaw(levels0)
    for (let it = 0; it < 6 && !s.exact && budget.n > 0; it++) {
      const logical = s.order.map((i) => texts[i])
      const lv = unitLevels(logical, para)
      const next = new Array<number>(n)
      s.order.forEach((vi, k) => (next[vi] = lv[k]))
      if (next.every((v, i) => v === s.levels[i])) break
      const r = evaluateRaw(next)
      if (r.score < s.score) break
      s = r
    }
    return s
  }
  let best = evaluate(base)
  // A line with right-to-left text next to left-to-right text or numbers can have several logical readings that
  // display identically: look for the alternatives even when the first candidate is exact, and rank them below.
  const mixed = cls.includes('R') && (cls.includes('L') || cls.includes('D'))
  if (best.exact && !mixed) return best
  // only ranking alternatives from here: spend less
  if (best.exact) budget.n = Math.min(budget.n, EXPLORE_BUDGET)

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

  // bracket units (for joint moves: a bracket pair resolves to one level, rule N0)
  const brackets: number[] = []
  for (let i = 0; i < n; i++) if (isBracketish(texts[i])) brackets.push(i)

  /** Candidate level assignments one step away from `cur`. */
  const neighbours = (cur: number[]): number[][] => {
    const out: number[][] = []
    const seenKeys = new Set<string>()
    const add = (lv: number[]): void => {
      const k = lv.join(',')
      if (!seenKeys.has(k)) {
        seenKeys.add(k)
        out.push(lv)
      }
    }
    for (const r of runs) {
      const left = r.from > 0 ? cur[r.from - 1] : para
      const right = r.to < n ? cur[r.to] : para
      const len = r.to - r.from
      for (const v of [para, left, right, para + 1]) {
        const lv = cur.slice()
        for (let k = r.from; k < r.to; k++) lv[k] = v
        add(lv)
      }
      if (len > 1 && left !== right) {
        for (let split = 1; split < len && split <= 6; split++) {
          for (const [a, b] of [[left, right], [left, para], [para, right]]) {
            const lv = cur.slice()
            for (let k = r.from; k < r.to; k++) lv[k] = k - r.from < split ? a : b
            add(lv)
          }
        }
      }
    }
    // two brackets at once (they pair up in the logical text and share a level)
    for (let x = 0; x < brackets.length && brackets.length <= 16; x++) {
      for (let y = x + 1; y < brackets.length; y++) {
        for (const v of [para, para + 1]) {
          const lv = cur.slice()
          lv[brackets[x]] = v
          lv[brackets[y]] = v
          add(lv)
        }
      }
    }
    if (para === 0) {
      for (const r of digitRuns) {
        for (const v of [0, 2]) {
          const lv = cur.slice()
          for (let k = r.from; k < r.to; k++) lv[k] = v
          add(lv)
        }
      }
    }
    return out
  }

  const exacts: Solution[] = []
  const seen = new Set<string>()
  const note = (s: Solution): void => {
    if (!s.exact) return
    const k = s.order.join(',')
    if (seen.has(k)) return
    seen.add(k)
    exacts.push(s)
  }
  // starting points, each refined to a fixed point: the UBA on the visual string, neutrals at the paragraph level,
  // and numbers kept whole with the punctuation touching them ("95%", "$5", "12:30"); then a neighbourhood search
  // from each (single stretches, bracket pairs, digit runs), keeping every exact reading found
  const starts: Solution[] = [best]
  for (const lv of alternativeStarts(texts, cls, para)) if (budget.n > 0) starts.push(evaluate(lv))
  for (const st of starts) {
    note(st)
    if (st.score > best.score) best = st
  }
  for (const st of starts) {
    let cur = st
    for (let pass = 0; pass < 3 && budget.n > 0; pass++) {
      let improved = false
      for (const lv of neighbours(cur.levels)) {
        if (budget.n <= 0) break
        const s = evaluate(lv)
        note(s)
        if (s.score > cur.score) {
          cur = s
          improved = true
        }
        if (s.score > best.score) best = s
      }
      if (!improved) break
    }
  }
  if (exacts.length) return rankExact(units, texts, exacts)
  return best
}

const TIGHT = /^[^\s]+$/u
/** Candidate evaluations spent looking for better-ranked alternatives when an exact reading is already known. */
const EXPLORE_BUDGET = 120

function alternativeStarts(texts: string[], cls: Cls[], para: 0 | 1): number[][] {
  const n = texts.length
  const strongL = para ? 2 : 0
  // D next to right-to-left text (through neutrals) is a number of that text: level 2 in either paragraph direction
  const nearR = (i: number): boolean => {
    for (let k = i - 1; k >= 0; k--) if (cls[k] !== 'N' && cls[k] !== 'D') return cls[k] === 'R'
    for (let k = i + 1; k < n; k++) if (cls[k] !== 'N' && cls[k] !== 'D') return cls[k] === 'R'
    return para === 1
  }
  const digitLevel = (i: number): number => (para ? 2 : nearR(i) ? 2 : 0)
  const plain = cls.map((c, i) => (c === 'R' ? 1 : c === 'L' ? strongL : c === 'D' ? digitLevel(i) : para))
  // tight tokens (no whitespace between units) that contain a digit take the digit's level as a whole
  const tight = plain.slice()
  for (let i = 0; i < n; ) {
    let j = i
    while (j < n && TIGHT.test(texts[j]) && cls[j] !== 'R' && cls[j] !== 'L') j++
    if (j > i) {
      const d = cls.slice(i, j).indexOf('D')
      if (d >= 0) for (let k = i; k < j; k++) if (cls[k] === 'N' || cls[k] === 'D') tight[k] = digitLevel(i + d)
      i = j
    } else i++
  }
  return [plain, tight]
}

/**
 * Among readings that all display exactly like the page: brackets that pair up; Latin+digit clusters read in the
 * left-to-right order a reader sees them ("BHD 45.500", not "45.500 BHD": copying gives what a person reads); numbers
 * kept whole with the symbols touching them ("95%", "$5", "+966"); then the order the producer drew the runs in when
 * that carries information, else the simplest structure (fewest direction runs).
 */
function rankExact(units: VisualUnit[], texts: string[], exacts: Solution[]): Solution {
  const n = units.length
  let monotonic = true
  for (let i = 1; i < n && monotonic; i++) if (units[i].seq < units[i - 1].seq) monotonic = false
  const cls = texts.map(classOf)
  const ld = (i: number): boolean => cls[i] === 'L' || cls[i] === 'D'
  // Latin+digit clusters, in visual order: maximal runs of Latin words and numbers together with the separators and
  // spaces between them ("BHD 45.500", "PDF 42", "ISO 9001", "info@example.com"); brackets and right-to-left letters
  // end a cluster, and a cluster starts and ends with a Latin letter or digit.
  const clusters: number[][] = []
  for (let i = 0; i < n; ) {
    if (!ld(i)) {
      i++
      continue
    }
    let end = i // last L/D unit of the cluster
    let j = i + 1
    while (j < n && cls[j] !== 'R' && !isBracketish(texts[j])) {
      if (ld(j)) end = j
      j++
    }
    if (end > i) clusters.push(Array.from({ length: end - i + 1 }, (_, k) => i + k))
    i = end + 1
  }
  // groups of units drawn touching each other (no space) that contain a digit and a symbol: "966+", "95%", "$5"
  const groups: number[][] = []
  for (let i = 0; i < n; ) {
    let j = i
    while (j < n && TIGHT.test(texts[j]) && cls[j] !== 'R' && cls[j] !== 'L' && !isBracketish(texts[j])) j++
    if (j - i > 1 && texts.slice(i, j).some((t) => classOf(t) === 'D') && texts.slice(i, j).some((t) => classOf(t) === 'N')) groups.push(Array.from({ length: j - i }, (_, k) => i + k))
    i = Math.max(j, i + 1)
  }
  const scored = exacts.map((s) => {
    const pos = new Array<number>(n)
    s.order.forEach((vi, k) => (pos[vi] = k))
    // a cluster whose units are not, in the logical text, one piece in the left-to-right order a reader sees
    let reordered = 0
    for (const c of clusters) {
      for (let k = 1; k < c.length; k++) {
        if (pos[c[k]] !== pos[c[k - 1]] + 1) {
          reordered++
          break
        }
      }
    }
    // a number group that is not one contiguous piece of the logical text was torn apart
    let broken = 0
    for (const g of groups) {
      const ps = g.map((i) => pos[i])
      if (Math.max(...ps) - Math.min(...ps) !== g.length - 1) broken++
    }
    let runs = 0
    for (let i = 1; i < n; i++) if (s.levels[i] !== s.levels[i - 1]) runs++
    const logical = s.order.map((i) => texts[i]).join('')
    const emptyPairs = (logical.match(/[([{«‹]\s*[)\]}»›]/gu) ?? []).length
    return { s, imbalance: bracketImbalance(logical) + emptyPairs, reordered, broken, runs, dis: monotonic ? 0 : streamDisagreement(units, s.order) }
  })
  scored.sort((a, b) => a.imbalance - b.imbalance || a.reordered - b.reordered || a.broken - b.broken || a.dis - b.dis || a.runs - b.runs)
  return scored[0].s
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
