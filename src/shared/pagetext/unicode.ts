/**
 * Character classes and normalisation used by the page text model. Pure functions, no dependencies.
 */

/** A combining mark (Arabic harakat, Hebrew points, Indic matras and signs, Latin combining accents, ...). */
export const MARK_RE = /\p{M}/u
const ONLY_MARKS_RE = /^\p{M}+$/u
export const isOnlyMarks = (s: string): boolean => s.length > 0 && ONLY_MARKS_RE.test(s)

/** Strong right-to-left letters (bidi classes R and AL): Hebrew, Arabic, Syriac, Thaana, NKo, ..., presentation forms. */
const RTL_RE = /[֐-׿؀-ۿ܀-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u
export const hasRtlChar = (s: string): boolean => RTL_RE.test(s)

/**
 * Scripts whose text PDF.js is known to mangle (right-to-left scripts, Arabic presentation forms, and complex scripts with
 * combining signs or reordering: Indic, Thai, Lao, Tibetan, Myanmar, Khmer, Sinhala). A page containing any of these is
 * read with the page text model; other pages keep PDF.js's own text.
 */
const COMPLEX_RE = /[֐-ࣿיִ-﷿ﹰ-ﻼऀ-෿฀-࿿က-႟ក-៿\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u
export const hasComplexScript = (s: string): boolean => COMPLEX_RE.test(s)

/** Letters with a strong left-to-right direction (for direction voting). */
const LTR_LETTER_RE = /[\p{L}]/u

export type StrongDir = 'L' | 'R' | null

/** Direction of the first strong character of `s` (numbers and punctuation are not strong). */
export function firstStrong(s: string): StrongDir {
  for (const ch of s) {
    if (RTL_RE.test(ch)) return 'R'
    if (LTR_LETTER_RE.test(ch)) return 'L'
  }
  return null
}

/** Counts of strong RTL and LTR letters. */
export function strongCounts(s: string): { r: number; l: number } {
  let r = 0
  let l = 0
  for (const ch of s) {
    if (RTL_RE.test(ch)) r++
    else if (LTR_LETTER_RE.test(ch)) l++
  }
  return { r, l }
}

/**
 * Normalisation applied to glyph text: Arabic, Hebrew and Latin presentation forms and ligatures become their base
 * letters (U+FB00-FDFF, U+FE70-FEFF via NFKC), control characters and U+0000 mean "no mapping". Everything else is
 * kept as the producer wrote it (no general NFKC, so e.g. superscripts and full-width forms survive copy/paste).
 */
const PRESENTATION_RE = /[ﬀ-﷿ﹰ-﻿]/u

export function normalizeGlyphText(s: string): string {
  if (!s) return s
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (PRESENTATION_RE.test(s)) {
    let out = ''
    for (const ch of s) {
      if (ch === '﻿') continue // zero-width no-break space / BOM
      out += PRESENTATION_RE.test(ch) ? ch.normalize('NFKC') : ch
    }
    s = out
  }
  return s
}

export const isSpaceText = (s: string): boolean => s.length > 0 && /^[\s  -​　]+$/u.test(s)

/** Pre-base (left-side) dependent vowels of Indic scripts and Myanmar/Khmer: drawn before the consonant, stored after it. */
const PREBASE_RE = /^[िॎিেৈਿિେୈୋୌெ-ைె-ైെ-ൈෙ-ෛေេ-ៃ]/u
export const isPreBaseMatra = (s: string): boolean => PREBASE_RE.test(s)

/** Characters of a script whose marks follow the base to the LEFT in reading order (RTL scripts). */
export const isRtlMark = (s: string): boolean => /[֑-ׇؐ-ًؚ-ٰٟۖ-ܑۭܰ-݊ަ-ް߫-࣓߳-ࣿ]/u.test(s)

/** Decodes a PDF text string (UTF-16BE with BOM, UTF-8 with BOM, or PDFDocEncoding). */
export function decodePdfString(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let s = ''
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1])
    return stripLangEscapes(s)
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    // UTF-16LE is not allowed by the standard but some producers write it
    let s = ''
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8))
    return s
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3))
  let s = ''
  for (const c of b) s += String.fromCharCode(c >= 0x80 && c <= 0x9f ? (PDFDOC_HIGH[c - 0x80] ?? c) : c >= 0x18 && c <= 0x1f ? (PDFDOC_LOW[c - 0x18] ?? c) : c)
  return s
}

/** UTF-16 language escape sequences (U+001B ... U+001B) are metadata, not text. */
const stripLangEscapes = (s: string): string => (s.includes('\u001b') ? s.replace(/\u001b[^\u001b]*\u001b/g, '') : s)

const PDFDOC_LOW = [0x02d8, 0x02c7, 0x02c6, 0x02d9, 0x02dd, 0x02db, 0x02da, 0x02dc]
const PDFDOC_HIGH = [
  0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039, 0x203a, 0x2212, 0x2030, 0x201e, 0x201c, 0x201d, 0x2018,
  0x2019, 0x201a, 0x2122, 0xfb01, 0xfb02, 0x0141, 0x0152, 0x0160, 0x0178, 0x017d, 0x0131, 0x0142, 0x0153, 0x0161, 0x017e, 0xfffd
]
