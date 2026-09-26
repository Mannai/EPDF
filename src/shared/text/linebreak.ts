/**
 * Line-break opportunities: UAX #14 (Unicode Line Breaking Algorithm) rules on classes derived from the engine's
 * Unicode data, plus dictionary segmentation (`Intl.Segmenter`) for scripts written without spaces
 * (Thai, Lao, Khmer, Myanmar).
 *
 * Differences from a complete UAX #14 implementation (documented, deliberate):
 *  - classes are derived from general category / script (there is no Line_Break property in JavaScript), so a few
 *    rare characters may get a neighbouring class;
 *  - Hangul syllables break like ideographs (Chrome's default for `word-break: normal`);
 *  - East Asian width variants of OP/CP are treated like their non-EA versions.
 * Chinese/Japanese break between any two ideographs except where kinsoku rules forbid it (no break before closing
 * punctuation, small kana, prolonged sound mark, no break after opening brackets); `wordBreak: 'phrase'` keeps
 * dictionary words together (like CSS `word-break: auto-phrase`).
 */

export type WordBreak = 'normal' | 'phrase'

export const BREAK_NONE = 0
export const BREAK_ALLOWED = 1
export const BREAK_MANDATORY = 2

type LB =
  | 'BK' | 'CR' | 'LF' | 'NL' | 'SP' | 'ZW' | 'ZWJ' | 'WJ' | 'GL' | 'CM' | 'OP' | 'CL' | 'CP' | 'QU' | 'EX' | 'IS'
  | 'SY' | 'NS' | 'BA' | 'BB' | 'HY' | 'B2' | 'IN' | 'NU' | 'PR' | 'PO' | 'ID' | 'AL' | 'SA' | 'RI' | 'EM' | 'CJ'

const RE = {
  mark: /^\p{M}$/u,
  ps: /^\p{Ps}$/u,
  pe: /^\p{Pe}$/u,
  pi: /^[\p{Pi}\p{Pf}]$/u,
  nd: /^\p{Nd}$/u,
  sc: /^\p{Sc}$/u,
  zs: /^\p{Zs}$/u,
  cc: /^\p{Cc}$/u,
  han: /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Yi}\p{Script_Extensions=Hani}]$/u,
  hangulSyl: /^[가-힣]$/u,
  sa: /^[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u,
  pict: /^\p{Extended_Pictographic}$/u,
  letter: /^\p{L}$/u
}

const NS_SET = new Set<number>([
  0x203c, 0x203d, 0x2047, 0x2048, 0x2049, 0x3005, 0x301c, 0x30fb, 0x309b, 0x309c, 0x309d, 0x309e, 0x30fd, 0x30fe, 0xff65,
  0xff9e, 0xff9f
])
const CJ_SET = new Set<number>([
  0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063, 0x3083, 0x3085, 0x3087, 0x308e, 0x3095, 0x3096, 0x30a1, 0x30a3, 0x30a5,
  0x30a7, 0x30a9, 0x30c3, 0x30e3, 0x30e5, 0x30e7, 0x30ee, 0x30f5, 0x30f6, 0x30fc, 0x31f0, 0x31f1, 0x31f2, 0x31f3, 0x31f4,
  0x31f5, 0x31f6, 0x31f7, 0x31f8, 0x31f9, 0x31fa, 0x31fb, 0x31fc, 0x31fd, 0x31fe, 0x31ff, 0xff67, 0xff68, 0xff69, 0xff6a,
  0xff6b, 0xff6c, 0xff6d, 0xff6e, 0xff6f, 0xff70
])
const CL_EXTRA = new Set<number>([0x3001, 0x3002, 0xff0c, 0xff0e, 0xfe50, 0xfe52, 0xff61, 0xff64, 0x060c, 0x0f0d])
const EX_SET = new Set<number>([0x21, 0x3f, 0x061b, 0x061e, 0x061f, 0x06d4, 0x0f14, 0x2762, 0x2763, 0xff01, 0xff1f, 0x05c6])
const IS_SET = new Set<number>([0x2c, 0x2e, 0x3a, 0x3b, 0x037e, 0x0589, 0x060d, 0x07f8, 0x2044, 0xfe10, 0xfe13, 0xfe14])
const BA_SET = new Set<number>([0x09, 0x7c, 0xad, 0x058a, 0x1680, 0x2010, 0x2012, 0x2013, 0x205f, 0x3000, 0x0f0b, 0x1361, 0x17d8, 0x17da])
const GL_SET = new Set<number>([0xa0, 0x202f, 0x2007, 0x2011, 0x0f08, 0x0f0c, 0x180e, 0x034f])
const PR_SET = new Set<number>([0x2b, 0x5c, 0xb1, 0x2116, 0x2212, 0x2213, 0x2035, 0x2036, 0x2037])
const PO_SET = new Set<number>([0x25, 0xa2, 0xb0, 0x2030, 0x2031, 0x2032, 0x2033, 0x2034, 0x2103, 0x2109, 0x066a, 0xff05, 0xfe6a])
const QU_SET = new Set<number>([0x22, 0x27, 0xab, 0xbb])

const cache = new Map<number, LB>()

function classify(cp: number): LB {
  if (cp === 0x0a) return 'LF'
  if (cp === 0x0d) return 'CR'
  if (cp === 0x85) return 'NL'
  if (cp === 0x0b || cp === 0x0c || cp === 0x2028 || cp === 0x2029) return 'BK'
  if (cp === 0x20) return 'SP'
  if (cp === 0x200b) return 'ZW'
  if (cp === 0x200d) return 'ZWJ'
  if (cp === 0x2060 || cp === 0xfeff) return 'WJ'
  if (cp === 0x2014) return 'B2'
  if (cp === 0xb4) return 'BB'
  if (cp === 0x2d) return 'HY'
  if (cp === 0x2f) return 'SY'
  if (GL_SET.has(cp)) return 'GL'
  if (BA_SET.has(cp)) return 'BA'
  if (cp >= 0x2000 && cp <= 0x200a && cp !== 0x2007) return 'BA'
  if (cp >= 0x2024 && cp <= 0x2026) return 'IN'
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 'RI'
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return 'EM'
  if (cp === 0x29 || cp === 0x5d) return 'CP'
  if (QU_SET.has(cp)) return 'QU'
  if (EX_SET.has(cp)) return 'EX'
  if (IS_SET.has(cp)) return 'IS'
  if (CL_EXTRA.has(cp)) return 'CL'
  if (CJ_SET.has(cp)) return 'CJ'
  if (NS_SET.has(cp)) return 'NS'
  if (PR_SET.has(cp)) return 'PR'
  if (PO_SET.has(cp)) return 'PO'
  const ch = String.fromCodePoint(cp)
  if (cp === 0x200c || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || RE.cc.test(ch)) return 'CM'
  if (RE.mark.test(ch)) return 'CM'
  if (RE.sa.test(ch)) return 'SA'
  if (RE.ps.test(ch)) return 'OP'
  if (RE.pe.test(ch)) return 'CL'
  if (RE.pi.test(ch)) return 'QU'
  if (RE.nd.test(ch)) return cp >= 0xff10 && cp <= 0xff19 ? 'ID' : 'NU'
  if (RE.sc.test(ch)) return 'PR'
  if (RE.zs.test(ch)) return 'BA'
  if (RE.hangulSyl.test(ch)) return 'ID'
  if (RE.han.test(ch) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x3ffff)) {
    if (cp === 0x3000) return 'BA'
    return 'ID'
  }
  if (RE.pict.test(ch)) return 'ID'
  return 'AL'
}

function lbClass(cp: number): LB {
  let c = cache.get(cp)
  if (!c) {
    c = classify(cp)
    cache.set(cp, c)
  }
  return c
}

const segmenters = new Map<string, Intl.Segmenter>()
function wordSegmenter(lang: string): Intl.Segmenter {
  let s = segmenters.get(lang)
  if (!s) {
    s = new Intl.Segmenter(lang, { granularity: 'word' })
    segmenters.set(lang, s)
  }
  return s
}

const isHardBreakClass = (c: LB): boolean => c === 'BK' || c === 'CR' || c === 'LF' || c === 'NL'

/**
 * Break opportunities of `text`: result[i] (0..text.length) says whether a line may/must break *before* UTF-16
 * index i. result[0] is always 0; result[text.length] is MANDATORY (end of text).
 */
export function lineBreakOpportunities(text: string, opts: { lang?: string; wordBreak?: WordBreak } = {}): Uint8Array {
  const n = text.length
  const out = new Uint8Array(n + 1)
  if (n === 0) return out
  // Code points with their unit index; effective classes after LB9/LB10.
  const idx: number[] = []
  const cls: LB[] = []
  const raw: LB[] = []
  for (let i = 0; i < n; ) {
    const cp = text.codePointAt(i)!
    idx.push(i)
    raw.push(lbClass(cp))
    i += cp > 0xffff ? 2 : 1
  }
  const m = idx.length
  for (let k = 0; k < m; k++) {
    let c = raw[k]!
    if (c === 'CM' || c === 'ZWJ') {
      const p = k > 0 ? cls[k - 1]! : null
      if (p !== null && p !== 'BK' && p !== 'CR' && p !== 'LF' && p !== 'NL' && p !== 'SP' && p !== 'ZW') c = p
      else c = c === 'ZWJ' ? 'ZWJ' : 'AL'
    }
    cls[k] = c
  }
  const attached = (k: number): boolean => {
    const r = raw[k]!
    if (r !== 'CM' && r !== 'ZWJ') return false
    const p = k > 0 ? cls[k - 1]! : null
    return p !== null && p !== 'BK' && p !== 'CR' && p !== 'LF' && p !== 'NL' && p !== 'SP' && p !== 'ZW'
  }

  let riRun = 0
  for (let k = 1; k < m; k++) {
    const L = cls[k - 1]!
    const R = cls[k]!
    // count of regional indicators immediately before k (for LB30a)
    riRun = L === 'RI' ? (k >= 2 && cls[k - 2] === 'RI' ? riRun + 1 : 1) : 0
    // class before any run of spaces immediately preceding k
    let j = k - 1
    while (j >= 0 && cls[j] === 'SP') j--
    const Lns: LB | null = j >= 0 ? cls[j]! : null
    let v: number
    const i = idx[k]!
    if (L === 'CR' && R === 'LF') v = BREAK_NONE
    else if (L === 'BK' || L === 'LF' || L === 'NL' || L === 'CR') v = BREAK_MANDATORY
    else if (isHardBreakClass(R)) v = BREAK_NONE
    else if (R === 'SP' || R === 'ZW') v = BREAK_NONE
    else if (Lns === 'ZW') v = BREAK_ALLOWED
    else if (attached(k)) v = BREAK_NONE
    else if (L === 'ZWJ') v = BREAK_NONE
    else if (R === 'WJ' || L === 'WJ') v = BREAK_NONE
    else if (L === 'GL') v = BREAK_NONE
    else if (R === 'GL' && L !== 'SP' && L !== 'BA' && L !== 'HY') v = BREAK_NONE
    else if (R === 'CL' || R === 'CP' || R === 'EX' || R === 'IS' || R === 'SY') v = BREAK_NONE
    else if (Lns === 'OP') v = BREAK_NONE
    else if (Lns === 'QU' && R === 'OP') v = BREAK_NONE
    else if ((Lns === 'CL' || Lns === 'CP') && R === 'NS') v = BREAK_NONE
    else if (Lns === 'B2' && R === 'B2') v = BREAK_NONE
    else if (L === 'SP') v = BREAK_ALLOWED
    else if (R === 'QU' || L === 'QU') v = BREAK_NONE
    else if (R === 'BA' || R === 'HY' || R === 'NS' || R === 'CJ' || L === 'BB') v = BREAK_NONE
    else if (R === 'IN') v = BREAK_NONE
    else if ((L === 'AL' || L === 'SA') && R === 'NU') v = BREAK_NONE
    else if (L === 'NU' && (R === 'AL' || R === 'SA')) v = BREAK_NONE
    else if (L === 'PR' && (R === 'ID' || R === 'EM')) v = BREAK_NONE
    else if ((L === 'ID' || L === 'EM') && R === 'PO') v = BREAK_NONE
    else if ((L === 'PR' || L === 'PO') && (R === 'AL' || R === 'SA')) v = BREAK_NONE
    else if ((L === 'AL' || L === 'SA') && (R === 'PR' || R === 'PO')) v = BREAK_NONE
    else if ((L === 'CL' || L === 'CP') && (R === 'PO' || R === 'PR')) v = BREAK_NONE
    else if (L === 'NU' && (R === 'PO' || R === 'PR' || R === 'NU')) v = BREAK_NONE
    else if ((L === 'PO' || L === 'PR') && (R === 'OP' || R === 'NU')) v = BREAK_NONE
    else if ((L === 'HY' || L === 'IS' || L === 'SY') && R === 'NU') v = BREAK_NONE
    else if ((L === 'AL' || L === 'SA') && (R === 'AL' || R === 'SA')) v = BREAK_NONE
    else if (L === 'IS' && (R === 'AL' || R === 'SA')) v = BREAK_NONE
    else if ((L === 'AL' || L === 'SA' || L === 'NU') && R === 'OP') v = BREAK_NONE
    else if (L === 'CP' && (R === 'AL' || R === 'SA' || R === 'NU')) v = BREAK_NONE
    else if (L === 'RI' && R === 'RI' && riRun % 2 === 1) v = BREAK_NONE
    else v = BREAK_ALLOWED
    out[i] = v
  }
  out[n] = BREAK_MANDATORY

  // Dictionary segmentation for scripts without spaces: allowed only at word boundaries within an SA run.
  let k = 0
  while (k < m) {
    if (raw[k] === 'SA' || (attached(k) && cls[k] === 'SA')) {
      let e = k
      while (e < m && (raw[e] === 'SA' || (attached(e) && cls[e] === 'SA'))) e++
      const s = idx[k]!
      const end = e < m ? idx[e]! : n
      const seg = text.slice(s, end)
      const lang = opts.lang && /^(th|lo|km|my)/i.test(opts.lang) ? opts.lang.slice(0, 2) : /[฀-๿]/.test(seg) ? 'th' : /[຀-໿]/.test(seg) ? 'lo' : /[ក-៿]/.test(seg) ? 'km' : 'my'
      for (const part of wordSegmenter(lang).segment(seg)) {
        if (part.index > 0 && out[s + part.index] === BREAK_NONE) {
          // never inside a cluster the earlier rules protected (attached marks) or between GL/WJ
          const p = s + part.index
          const cpAt = text.codePointAt(p)!
          if (lbClass(cpAt) !== 'CM') out[p] = BREAK_ALLOWED
        }
      }
      k = e
    } else k++
  }

  if (opts.wordBreak === 'phrase') {
    // Keep dictionary words together inside runs of ideographs.
    let a = 0
    while (a < m) {
      if (cls[a] === 'ID' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String.fromCodePoint(text.codePointAt(idx[a]!)!))) {
        let e = a
        while (e < m && cls[e] === 'ID') e++
        const s = idx[a]!
        const end = e < m ? idx[e]! : n
        const seg = text.slice(s, end)
        const allowed = new Set<number>()
        for (const part of wordSegmenter(opts.lang ?? 'zh').segment(seg)) allowed.add(s + part.index)
        for (let p = s + 1; p < end; p++) if (out[p] === BREAK_ALLOWED && !allowed.has(p)) out[p] = BREAK_NONE
        a = e
      } else a++
    }
  }
  return out
}
