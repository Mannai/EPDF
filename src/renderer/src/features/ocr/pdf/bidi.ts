import { analyzeBidi, mirroredCodePoint, reorderVisual } from '@shared/text/bidi'

/**
 * Visual order of a recognized line, for the invisible text layer.
 *
 * Tesseract reports every line in LOGICAL order (the order the text is read and typed), also for Arabic, Persian,
 * Urdu and Hebrew, with the box of each word on the page. PDF readers get logical text back from what a page DRAWS,
 * in the order it is drawn: PDF.js, PDFium (Chrome, Edge) and Epdf's own page text model all take the glyphs of a line
 * as they appear from left to right and run the Unicode bidi algorithm (UAX #9) backwards over them, like any
 * producer's output (Word, LibreOffice, browsers write right-to-left text in visual order).
 *
 * So the layer draws each line exactly as the scan shows it:
 *   - the words from left to right, by their boxes in the scan (the geometry decides, not an assumption about the
 *     language);
 *   - the characters inside each word in the order the bidi algorithm displays them, computed over the WHOLE line
 *     with the paragraph direction that reproduces the word order seen in the scan (digits after Arabic letters are
 *     Arabic numbers, a "2026-48" in an Arabic sentence is shown as 48-2026, a Latin word glued to Arabic keeps its
 *     place, ...);
 *   - brackets and other mirrored characters inside right-to-left runs are stored as the shape seen on the page
 *     (Unicode rule L4), the convention PDFium and the page text model read back correctly.
 */

export interface VisualLine {
  /** Paragraph direction of the line. */
  rtl: boolean
  /** Each word's characters in visual order (left to right), mirrored where the bidi algorithm mirrors them. */
  words: string[]
  /** Word indices from left to right on the page. */
  order: number[]
}

const RTL_BLOCK = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u
const LETTER = /\p{L}/u

/** Strong right-to-left and left-to-right letters in a text, and the direction of the first one. */
function strongCounts(text: string): { r: number; l: number; firstRtl: boolean } {
  let r = 0
  let l = 0
  let first: boolean | null = null
  for (const ch of text) {
    if (!LETTER.test(ch)) continue
    const rtl = RTL_BLOCK.test(ch)
    if (rtl) r++
    else l++
    first ??= rtl
  }
  return { r, l, firstRtl: first === true }
}

interface Reading {
  rtl: boolean
  /** Visual position of every code point of the line text. */
  pos: number[]
  /** Level of every code point. */
  level: number[]
}

function read(cps: string[], text: string, rtl: boolean): Reading {
  const info = analyzeBidi(text, rtl ? 'rtl' : 'ltr')
  // one level per code point (both halves of a surrogate pair carry the same level)
  const level: number[] = []
  let u = 0
  for (const c of cps) {
    level.push(info.levels[u])
    u += c.length
  }
  const order = reorderVisual(level)
  const pos: number[] = new Array(cps.length)
  order.forEach((cpIndex, k) => (pos[cpIndex] = k))
  return { rtl, pos, level }
}

/** How many consecutive pairs of `a` (word indices) appear in the same order in `b`. */
function agreement(a: number[], b: number[]): number {
  const rank = new Map(b.map((w, i) => [w, i]))
  let n = 0
  for (let i = 1; i < a.length; i++) if (rank.get(a[i - 1])! < rank.get(a[i])!) n++
  return n
}

/**
 * `words` in logical order (as recognized; non-empty, without spaces), `offsets` their position along the line
 * (increasing to the right in the reading frame).
 */
export function visualLine(words: string[], offsets: number[]): VisualLine {
  const n = words.length
  const byPlace = words.map((_, i) => i).sort((a, b) => offsets[a] - offsets[b] || a - b)
  if (n === 0) return { rtl: false, words: [], order: [] }

  const cps: string[] = []
  const wordOf: number[] = []
  words.forEach((w, i) => {
    if (i > 0) {
      cps.push(' ')
      wordOf.push(-1)
    }
    for (const c of w) {
      cps.push(c)
      wordOf.push(i)
    }
  })
  const text = cps.join('')

  const { r, l, firstRtl } = strongCounts(text)
  const preferRtl = r > l || (r === l && firstRtl)
  const candidates = (preferRtl ? [true, false] : [false, true]).map((rtl) => read(cps, text, rtl))

  const wordOrder = (rd: Reading): number[] => {
    const first = new Array<number>(n).fill(Infinity)
    rd.pos.forEach((p, k) => {
      const w = wordOf[k]
      if (w >= 0 && p < first[w]) first[w] = p
    })
    return words.map((_, i) => i).sort((a, b) => first[a] - first[b])
  }
  // the paragraph direction that shows the words where the scan has them (the preferred one on a tie)
  let best = candidates[0]
  let bestScore = agreement(wordOrder(best), byPlace)
  const other = agreement(wordOrder(candidates[1]), byPlace)
  if (other > bestScore) {
    best = candidates[1]
    bestScore = other
  }

  const visualWords = words.map((_, i) => {
    const idx: number[] = []
    wordOf.forEach((w, k) => {
      if (w === i) idx.push(k)
    })
    // Combining marks stay where the algorithm puts them: before their base letter in a right-to-left run (rule L3
    // is not applied). Every reader measured reverses the run as a whole, which puts them back after their letter.
    idx.sort((a, b) => best.pos[a] - best.pos[b])
    return idx
      .map((k) => {
        if (best.level[k] & 1) {
          const m = mirroredCodePoint(cps[k].codePointAt(0)!)
          if (m !== null) return String.fromCodePoint(m)
        }
        return cps[k]
      })
      .join('')
  })
  return { rtl: best.rtl, words: visualWords, order: byPlace }
}
