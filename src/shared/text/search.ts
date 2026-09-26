import { analyzeBidi, hasRtl, reorderedString } from './bidi'

/**
 * Text normalisation for search, comparison, redaction and library indexing, with an exact mapping from
 * normalised offsets back to the original string (so highlights and redaction boxes cover the right characters).
 *
 * The defaults are "find what the user means": Arabic marks (tashkeel), tatweel and joiners are ignored, alef/ya/kaf
 * variants and Arabic/Persian digits are unified, presentation forms and ligatures (ﷲ, ﻻ, ﬁ) are expanded to base
 * letters, Hebrew points are dropped, full-width forms become ASCII and case is folded. Every rule is an option.
 */

export interface NormalizeOptions {
  /** Case folding (default true). */
  foldCase?: boolean
  /** Remove Arabic tashkeel / Quranic marks (default true). */
  removeArabicMarks?: boolean
  /** Alef with hamza or madda, alef wasla -> plain alef (default true). */
  unifyAlef?: boolean
  /** Alef maqsura ى and Persian ی -> ي (default true). */
  unifyYa?: boolean
  /** Persian/Urdu kaf ک and heh variants ھ ہ -> Arabic ك ه, ے -> ي (default true). */
  unifyPersianUrdu?: boolean
  /** Ta marbuta ة -> ه (default false: the letters differ in meaning). */
  taMarbuta?: boolean
  /** Hamza carriers ؤ -> و, ئ -> ي and remove the standalone hamza ء (default false). */
  hamza?: boolean
  /** Remove tatweel/kashida U+0640 (default true). */
  removeTatweel?: boolean
  /** NFKC-style expansion of presentation forms, ligatures and compatibility characters (default true). */
  compatibility?: boolean
  /** Arabic-Indic (٠-٩) and Persian (۰-۹) digits -> 0-9, Arabic punctuation -> ASCII (default true). */
  digits?: boolean
  /** Remove Hebrew niqqud and cantillation marks (default true). */
  removeHebrewPoints?: boolean
  /** Strip Latin/other diacritics via decomposition (é -> e) (default false). */
  stripDiacritics?: boolean
  /** Remove zero-width and directional format characters (ZWSP, ZWNJ, ZWJ, LRM, RLM, ALM, BOM, WJ); NBSP -> space (default true). */
  removeInvisibles?: boolean
}

export interface NormalizedText {
  /** The normalised string. */
  text: string
  /** For each UTF-16 index of `text`: [start, end) in the original string that produced it. */
  starts: Int32Array
  ends: Int32Array
  /** Length of the original string. */
  originalLength: number
  /** Map a range of the normalised text back to the original string. */
  toOriginal(start: number, end: number): [number, number]
}

const ARABIC_MARKS = /[ً-ٰٟۖ-ۜ۟-۪ۨ-ۭ࣓-ࣿ]/u
const HEBREW_POINTS = /[֑-ׇֽֿׁׂׅׄ]/u
const INVISIBLES = /[​-‏؜﻿⁠‪-‮⁦-⁩]/u
const MARK = /\p{M}/u
const UNIT = /\P{M}\p{M}*|\p{M}+/gu

const SPECIAL_LOWER: Record<string, string> = { ß: 'ss', ς: 'σ', ſ: 's', ẞ: 'ss', ı: 'i' }

function mapChar(ch: string, cp: number, o: Required<NormalizeOptions>): string {
  if (o.removeInvisibles) {
    if (INVISIBLES.test(ch)) return ''
    if (cp === 0xa0 || cp === 0x202f || cp === 0x2007) return ' '
  }
  if (o.removeArabicMarks && ARABIC_MARKS.test(ch)) return ''
  if (o.removeHebrewPoints && HEBREW_POINTS.test(ch)) return ''
  if (o.removeTatweel && cp === 0x0640) return ''
  if (o.digits) {
    if (cp >= 0x0660 && cp <= 0x0669) return String.fromCharCode(0x30 + cp - 0x0660)
    if (cp >= 0x06f0 && cp <= 0x06f9) return String.fromCharCode(0x30 + cp - 0x06f0)
    if (cp === 0x060c) return ','
    if (cp === 0x061b) return ';'
    if (cp === 0x061f) return '?'
    if (cp === 0x066b) return '.'
    if (cp === 0x066c) return ','
    if (cp === 0x066a) return '%'
  }
  if (o.unifyAlef && (cp === 0x0622 || cp === 0x0623 || cp === 0x0625 || cp === 0x0671)) return 'ا'
  if (o.unifyYa && (cp === 0x0649 || cp === 0x06cc)) return 'ي'
  if (o.unifyPersianUrdu) {
    if (cp === 0x06a9) return 'ك'
    if (cp === 0x06be || cp === 0x06c1) return 'ه'
    if (cp === 0x06d2) return 'ي'
    if (cp === 0x06c3) return 'ة'
  }
  if (o.taMarbuta && cp === 0x0629) return 'ه'
  if (o.hamza) {
    if (cp === 0x0624) return 'و'
    if (cp === 0x0626) return 'ي'
    if (cp === 0x0621) return ''
  }
  return ch
}

const DEFAULTS: Required<NormalizeOptions> = {
  foldCase: true,
  removeArabicMarks: true,
  unifyAlef: true,
  unifyYa: true,
  unifyPersianUrdu: true,
  taMarbuta: false,
  hamza: false,
  removeTatweel: true,
  compatibility: true,
  digits: true,
  removeHebrewPoints: true,
  stripDiacritics: false,
  removeInvisibles: true
}

/** Normalise `text` for matching and keep the offset mapping. */
export function normalizeForSearch(text: string, options: NormalizeOptions = {}): NormalizedText {
  const o = { ...DEFAULTS, ...options }
  let out = ''
  const starts: number[] = []
  const ends: number[] = []
  const push = (s: string, a: number, b: number): void => {
    for (let i = 0; i < s.length; i++) {
      out += s[i]
      starts.push(a)
      ends.push(b)
    }
  }
  UNIT.lastIndex = 0
  for (let m = UNIT.exec(text); m; m = UNIT.exec(text)) {
    const unit = m[0]
    const a = m.index
    const b = a + unit.length
    // compatibility expansion first (ligatures, presentation forms, width variants), per unit
    let u = o.compatibility ? unit.normalize('NFKC') : unit
    if (o.stripDiacritics) u = u.normalize('NFD').replace(/\p{Mn}/gu, '')
    let mapped = ''
    for (const ch of u) mapped += mapChar(ch, ch.codePointAt(0)!, o)
    if (o.foldCase) {
      let f = mapped.toLowerCase()
      let g = ''
      for (const ch of f) g += SPECIAL_LOWER[ch] ?? ch
      f = g
      mapped = f
    }
    if (o.stripDiacritics && MARK.test(mapped)) mapped = mapped.normalize('NFD').replace(/\p{Mn}/gu, '')
    push(mapped, a, b)
  }
  const s = new Int32Array(starts)
  const e = new Int32Array(ends)
  return {
    text: out,
    starts: s,
    ends: e,
    originalLength: text.length,
    toOriginal(start: number, end: number): [number, number] {
      if (end <= start) {
        const p = start < s.length ? s[start]! : text.length
        return [p, p]
      }
      let lo = Infinity
      let hi = -Infinity
      for (let i = start; i < end && i < s.length; i++) {
        if (s[i]! < lo) lo = s[i]!
        if (e[i]! > hi) hi = e[i]!
      }
      return lo === Infinity ? [text.length, text.length] : [lo, hi]
    }
  }
}

export interface Match {
  /** Range in the ORIGINAL text (use it to highlight). */
  start: number
  end: number
}

/** All non-overlapping occurrences of `needle` in `haystack`, matched after normalisation, as ranges of the original text. */
export function findNormalized(haystack: string, needle: string, options: NormalizeOptions = {}): Match[] {
  const h = normalizeForSearch(haystack, options)
  const n = normalizeForSearch(needle, options).text
  if (!n) return []
  const out: Match[] = []
  for (let from = 0; ; ) {
    const i = h.text.indexOf(n, from)
    if (i < 0) break
    const [start, end] = h.toOriginal(i, i + n.length)
    out.push({ start, end })
    from = i + n.length
  }
  return out
}

// ---- repairing text extracted in visual order ---------------------------------------------------------------

export interface VisualToLogicalOptions {
  /** Base direction of each line: 'auto' picks RTL when right-to-left letters are at least as many as left-to-right letters. */
  direction?: 'auto' | 'ltr' | 'rtl'
  /** Expand Arabic presentation forms (ﻣﺮﺣﺒﺎ) to base letters and ligatures to letter sequences (default true). */
  normalizePresentationForms?: boolean
}

/**
 * BEST EFFORT. Many PDFs (especially from older producers and OCR-less legacy Arabic/Hebrew software) store RTL text in
 * visual order: extracting them gives reversed words and presentation-form letters. This reorders each line as a bidi
 * paragraph (the visual string is treated as if it were logical text, which inverts the reordering for the common
 * cases: RTL runs, numbers and Latin words inside RTL text, one level of nesting) and mirrors paired punctuation.
 * It cannot recover text whose visual order lost information (overlapping runs, unusual nesting), so results should be
 * treated as a search aid, never as an authoritative transcript.
 */
export function visualToLogical(visual: string, options: VisualToLogicalOptions = {}): string {
  const normalize = options.normalizePresentationForms !== false
  return visual
    .split(/(\r\n|\n|\r)/)
    .map((line, i) => {
      if (i % 2 === 1 || !hasRtl(line)) return normalize ? line.normalize('NFKC') : line
      const l = line
      let dir = options.direction ?? 'auto'
      if (dir === 'auto') {
        const rtl = (l.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/gu) ?? []).length
        const ltr = (l.match(/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/gu) ?? []).length
        dir = rtl >= ltr ? 'rtl' : 'ltr'
      }
      const info = analyzeBidi(l, dir)
      // Reorder first (each presentation-form character is one visual glyph), expand to base letters afterwards.
      const logical = reorderedString(info)
      return normalize ? logical.normalize('NFKC') : logical
    })
    .join('')
}
