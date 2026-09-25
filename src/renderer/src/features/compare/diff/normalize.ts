import type { CompareOptions } from './types'

/** Text normalisation and tokenisation used before two documents are compared. */

/** Helvetica advance widths (1/1000 em) for U+0020..U+007E. Used only to split an item's width between its characters. */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556,
  556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
]

/** Relative advance width of a character; only ratios matter (an item's real width is distributed in proportion). */
export function charWeight(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c >= 32 && c <= 126) return HELV[c - 32]
  if (c >= 0x0300 && c <= 0x036f) return 0 // combining marks take no room
  if (c >= 0x2e80) return 1000 // CJK and other full-width scripts
  return 556
}

// Built from escaped strings on purpose: several of these are invisible characters that must stay reviewable.
const INVISIBLE = new RegExp('[\\u200B-\\u200F\\u2060\\uFEFF\\u202A-\\u202E\\u2066-\\u2069]', 'g')
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000E-\\u001F\\u007F-\\u009F]', 'g')
const SINGLE_QUOTES = new RegExp('[\\u2018\\u2019\\u201A\\u201B\\u2032\\u00B4\\u02BC]', 'g')
const DOUBLE_QUOTES = new RegExp('[\\u201C\\u201D\\u201E\\u201F\\u2033]', 'g')
const DASHES = new RegExp('[\\u00AD\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]', 'g') // a soft hyphen only shows at line ends

/**
 * Folds one character (or a base character with its combining marks) to its comparison form. Ligatures and
 * presentation forms expand (fi-ligature -> fi), every kind of space becomes ' ', typographic quotes and dashes
 * (and the soft hyphen) become their ASCII forms, zero-width and bidi-control characters vanish.
 * The result may be empty or several characters long.
 */
export function foldChar(ch: string): string {
  const visible = ch.replace(INVISIBLE, '').replace(CONTROL, '')
  if (visible.length === 0) return ''
  let n = visible.normalize('NFKC')
  if (n.length === 0) return ''
  if (/^\s+$/u.test(n)) return ' '
  n = n.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(DASHES, '-')
  return n
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}'
const WORD = `[\\p{L}\\p{N}\\p{M}_]`
const NON_CJK_WORD = `(?:(?![${CJK}])${WORD})`
/**
 * A token is a run of letters/digits (joined by an inner . , ' : / so that "1,234.50", "don't", "12/03/2024" and
 * "www.example.com" stay whole), one ideograph, or one other visible character (punctuation).
 */
const TOKEN = new RegExp(`[${CJK}]|${NON_CJK_WORD}+(?:[.,'/:]${NON_CJK_WORD}+)*|\\S`, 'gu')

export interface TokenSpan {
  start: number
  end: number
}

/** Token boundaries within an already folded string. */
export function tokenSpans(folded: string): TokenSpan[] {
  const out: TokenSpan[] = []
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(folded))) out.push({ start: m.index, end: m.index + m[0].length })
  return out
}

const PUNCT_ONLY = /^[^\p{L}\p{N}\p{M}]+$/u
const STRIP_PUNCT = /[^\p{L}\p{N}\p{M}]/gu

export const isPunctuationToken = (t: string): boolean => PUNCT_ONLY.test(t)

/** The comparison key of a (folded) token, or null when the token does not take part in the comparison. */
export function keyOf(token: string, opts: CompareOptions): string | null {
  let k = token
  if (opts.ignoreCase) k = k.toLowerCase()
  if (opts.ignorePunctuation) {
    if (isPunctuationToken(k)) return null
    k = k.replace(STRIP_PUNCT, '')
    if (!k) return null
  }
  return k
}

/** A base character together with the combining marks that follow it (so "e" + U+0301 folds like "é"). */
export const clusters = (s: string): string[] => s.match(/\P{M}\p{M}*|\p{M}+/gu) ?? []

/** Folds a whole string (no geometry) - convenience for tests and for searching the change list. */
export function foldText(s: string): string {
  let out = ''
  for (const ch of clusters(s)) out += foldChar(ch)
  return out.replace(/ +/g, ' ').trim()
}

/** Tokens of a string as comparison keys, e.g. for unit tests of the tokenizer. */
export function tokenize(s: string, opts: CompareOptions): string[] {
  const folded = foldText(s)
  const out: string[] = []
  for (const sp of tokenSpans(folded)) {
    const k = keyOf(folded.slice(sp.start, sp.end), opts)
    if (k !== null) out.push(k)
  }
  return out
}
