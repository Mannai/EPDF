import bidiFactory, { type BidiCharTypeName, type EmbeddingLevels } from 'bidi-js'

/**
 * Unicode Bidirectional Algorithm (UAX #9) on top of `bidi-js` (MIT; implements UBA 13.0 including isolates,
 * bracket pairs and numbers, and passes the official BidiTest/BidiCharacterTest vectors: see
 * tests/unit/text-bidi.test.ts, which runs a vendored sample of them against this module).
 *
 * What this file adds:
 *   - astral characters (Adlam, Old South Arabian, emoji, ...) are classified correctly (bidi-js looks at UTF-16
 *     code units, so a surrogate pair would count as two strong-L characters);
 *   - rule L1 for one line (trailing whitespace goes back to the paragraph level) and rule L2 as a permutation
 *     of any sequence of levels (used for characters in tests and for glyph runs in layout).
 */

export type ParagraphDirection = 'ltr' | 'rtl' | 'auto'

export interface BidiInfo {
  /** Embedding level of every UTF-16 code unit of the text (both halves of a surrogate pair carry one level). */
  levels: Uint8Array
  paragraphs: { start: number; end: number; level: number }[]
  /** The text the levels were computed for. */
  text: string
  /** Text as seen by the algorithm (astral characters replaced by BMP characters of the same bidi class). */
  proxy: string
  raw: EmbeddingLevels
}

const bidi = bidiFactory()

const ASTRAL = /[\ud800-\udbff][\udc00-\udfff]/

const PROXY: Record<string, string> = {
  L: 'a',
  R: 'א',
  AL: 'ا',
  ON: '!',
  EN: '0',
  NSM: '̀',
  BN: '­'
}

/** Bidi class (proxy) of an astral code point, from block knowledge of Unicode 13-15. */
function astralClass(cp: number): keyof typeof PROXY {
  if (cp >= 0x1f000 && cp <= 0x1faff) return 'ON' // emoji, pictographs, symbols
  if (cp >= 0x1d7ce && cp <= 0x1d7ff) return 'EN'
  if (cp >= 0x1e800 && cp <= 0x1e8df) return 'R'
  if (cp >= 0x1e900 && cp <= 0x1e95f) return 'R' // Adlam
  if (cp >= 0x1ec70 && cp <= 0x1ecbf) return 'AL'
  if (cp >= 0x1ed00 && cp <= 0x1ed4f) return 'AL'
  if (cp >= 0x1ee00 && cp <= 0x1eeff) return 'AL' // Arabic mathematical alphabetic symbols
  if (cp >= 0x10d00 && cp <= 0x10d3f) return 'AL' // Hanifi Rohingya
  if (cp >= 0x10ac0 && cp <= 0x10aff) return 'AL' // Manichaean, Mandaic supplement
  if (cp >= 0x10b80 && cp <= 0x10baf) return 'AL' // Psalter Pahlavi
  if (cp >= 0x10f30 && cp <= 0x10f6f) return 'AL' // Sogdian
  if (cp >= 0x10ec0 && cp <= 0x10eff) return 'AL'
  if (cp >= 0x10800 && cp <= 0x10fff) return 'R' // Cypriot .. Old Hungarian, Nabataean, Phoenician, ...
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 'NSM' // variation selectors supplement
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'BN' // tags
  return 'L'
}

function toProxy(text: string): string {
  if (!ASTRAL.test(text)) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000
        const p = PROXY[astralClass(cp)]!
        out += p + p
        i++
        continue
      }
    }
    out += text[i]
  }
  return out
}

/** Resolve the embedding levels of `text` (paragraph direction `auto` = first strong character, per paragraph). */
export function analyzeBidi(text: string, direction: ParagraphDirection = 'auto'): BidiInfo {
  const proxy = toProxy(text)
  const raw = bidi.getEmbeddingLevels(proxy, direction)
  return { levels: raw.levels, paragraphs: raw.paragraphs, text, proxy, raw }
}

export function bidiClassOf(proxy: string, index: number): BidiCharTypeName {
  return bidi.getBidiCharTypeName(proxy[index]!)
}

/** Direction of an odd/even level. */
export const isRtlLevel = (level: number): boolean => (level & 1) === 1

/**
 * Levels for one line [start, end) after rule L1: segment/paragraph separators, and any whitespace or isolate
 * formatting characters before them or at the end of the line, are reset to the paragraph level.
 */
export function lineLevels(info: BidiInfo, start: number, end: number, paragraphLevel: number): Uint8Array {
  const out = info.levels.slice(start, end)
  let resetting = true // scanning backwards through a run of resettable characters at the end
  for (let i = end - 1; i >= start; i--) {
    const t = bidi.getBidiCharTypeName(info.proxy[i]!)
    if (t === 'B' || t === 'S') {
      out[i - start] = paragraphLevel
      resetting = true
    } else if (t === 'WS' || t === 'FSI' || t === 'LRI' || t === 'RLI' || t === 'PDI') {
      if (resetting) out[i - start] = paragraphLevel
    } else if (t === 'BN' || t === 'LRE' || t === 'RLE' || t === 'LRO' || t === 'RLO' || t === 'PDF') {
      // removed by rule X9: transparent for the purposes of L1
    } else {
      resetting = false
    }
  }
  return out
}

/**
 * Rule L2 as a permutation: `result[k]` is the index (into `levels`) of the item shown k-th from the left.
 * Works for characters or for runs.
 */
export function reorderVisual(levels: ArrayLike<number>): number[] {
  const n = levels.length
  const order = Array.from({ length: n }, (_, i) => i)
  let max = 0
  let minOdd = 255
  for (let i = 0; i < n; i++) {
    const l = levels[i]!
    if (l > max) max = l
    if (l & 1 && l < minOdd) minOdd = l
  }
  for (let level = max; level >= minOdd && level > 0; level--) {
    let i = 0
    while (i < n) {
      if (levels[order[i]!]! >= level) {
        let j = i
        while (j + 1 < n && levels[order[j + 1]!]! >= level) j++
        for (let a = i, b = j; a < b; a++, b--) {
          const t = order[a]!
          order[a] = order[b]!
          order[b] = t
        }
        i = j + 1
      } else i++
    }
  }
  return order
}

/** Mirrored counterpart of a code point (UAX #9 L4 / Bidi_Mirroring_Glyph), or null. Only for characters in an RTL run. */
export function mirroredCodePoint(cp: number): number | null {
  if (cp > 0xffff) return null
  const m = bidi.getMirroredCharacter(String.fromCharCode(cp))
  return m === null ? null : m.charCodeAt(0)
}

/** The paragraph text in visual order with mirrored characters swapped (rule L1-L4 for one line = the whole text). */
export function reorderedString(info: BidiInfo): string {
  return bidi.getReorderedString(info.text, info.raw)
}

/** For a bracket code point: whether it opens or closes, and the code point of its partner. */
export function bracketPartner(cp: number): { kind: 'open' | 'close'; other: number } | null {
  const ch = String.fromCharCode(cp)
  const close = bidi.openingToClosingBracket(ch)
  if (close) return { kind: 'open', other: close.charCodeAt(0) }
  const open = bidi.closingToOpeningBracket(ch)
  if (open) return { kind: 'close', other: open.charCodeAt(0) }
  return null
}

/** Paragraph level chosen for `text` when the direction is left to the algorithm (0 = LTR, 1 = RTL). */
export function detectParagraphLevel(text: string): 0 | 1 {
  const info = analyzeBidi(text, 'auto')
  return (info.paragraphs[0]?.level ?? 0) & 1 ? 1 : 0
}

/** True if the text contains any character with a strong right-to-left bidi class (R or AL). */
export function hasRtl(text: string): boolean {
  return /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10fff}\u{1e800}-\u{1efff}‏‫‮⁧]/u.test(text)
}
