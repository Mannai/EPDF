import { bracketPartner } from './bidi'

/**
 * Script itemization: which Unicode script each character of a paragraph belongs to, with Common/Inherited
 * characters resolved from their context (UAX #24 "script runs": punctuation and spaces join the script around
 * them, combining marks follow their base, paired punctuation follows its opener).
 *
 * Uses the JavaScript engine's own Unicode tables through `\p{Script=…}` / `\p{Script_Extensions=…}`, cached per
 * code point, so it costs a few microseconds per *distinct* character and nothing afterwards.
 */

/** ISO 15924 codes of the scripts recognised (everything else is reported as `Zzzz`). Ordered by likelihood. */
const KNOWN_SCRIPTS = [
  'Latn', 'Hani', 'Arab', 'Cyrl', 'Grek', 'Hira', 'Kana', 'Hang', 'Deva', 'Thai', 'Hebr', 'Beng', 'Taml', 'Telu',
  'Gujr', 'Guru', 'Knda', 'Mlym', 'Orya', 'Sinh', 'Thaa', 'Syrc', 'Armn', 'Geor', 'Laoo', 'Khmr', 'Mymr', 'Ethi',
  'Tibt', 'Mong', 'Bopo', 'Cans', 'Cher', 'Copt', 'Goth', 'Glag', 'Nkoo', 'Tfng', 'Vaii', 'Yiii', 'Brai', 'Adlm',
  'Bali', 'Batk', 'Cham', 'Java', 'Kali', 'Lana', 'Lepc', 'Limb', 'Lisu', 'Mand', 'Mtei', 'Olck', 'Osma', 'Rjng',
  'Saur', 'Sund', 'Sylo', 'Tale', 'Talu', 'Tavt', 'Tglg', 'Hano', 'Buhd', 'Tagb', 'Phnx', 'Runr', 'Ogam', 'Ital',
  'Cprt', 'Linb', 'Xpeo', 'Ugar', 'Shaw', 'Dsrt', 'Hmng', 'Newa', 'Modi', 'Sidd', 'Takr', 'Tirh', 'Mahj', 'Khoj',
  'Khar', 'Brah', 'Cakm', 'Sora', 'Shrd', 'Gran', 'Nbat', 'Palm', 'Samr', 'Avst', 'Merc', 'Mero', 'Egyp'
] as const

const SCX = KNOWN_SCRIPTS.map((tag) => ({ tag, re: new RegExp(`^\\p{Script_Extensions=${tag}}$`, 'u') }))
const COMMON = /^\p{Script=Zyyy}$/u
const INHERITED = /^\p{Script=Zinh}$/u

/** Script table: index 0 = Common, 1 = Inherited, 2 = Unknown, 3.. = KNOWN_SCRIPTS. */
export const SCRIPT_TAGS: readonly string[] = ['Zyyy', 'Zinh', 'Zzzz', ...KNOWN_SCRIPTS]
const COMMON_ID = 0
const INHERITED_ID = 1
const UNKNOWN_ID = 2

const cache = new Map<number, number[]>()

/** Script ids a character can belong to (Script_Extensions): [COMMON_ID], [INHERITED_ID], or 1+ specific scripts. */
function scriptSet(cp: number): number[] {
  let r = cache.get(cp)
  if (r) return r
  const ch = String.fromCodePoint(cp)
  if (COMMON.test(ch)) r = [COMMON_ID]
  else if (INHERITED.test(ch)) r = [INHERITED_ID]
  else {
    r = []
    for (let i = 0; i < SCX.length; i++) if (SCX[i]!.re.test(ch)) r.push(i + 3)
    if (r.length === 0) r = [UNKNOWN_ID]
  }
  cache.set(cp, r)
  return r
}

/** True for characters without a script of their own (spaces, punctuation, digits, symbols). */
export function isCommonCodePoint(cp: number): boolean {
  return scriptSet(cp)[0] === COMMON_ID
}

/** The primary script tag of a code point (first Script_Extensions entry; `Zyyy` for Common, `Zinh` for Inherited). */
export function scriptOfCodePoint(cp: number): string {
  return SCRIPT_TAGS[scriptSet(cp)[0]!]!
}

export interface ScriptRuns {
  /** Resolved script id per UTF-16 code unit (index into `tags`). */
  ids: Uint8Array
  tags: readonly string[]
}

/**
 * Resolve the script of every code unit of `text`.
 * Leading Common characters take the first specific script that follows.
 */
export function resolveScripts(text: string): ScriptRuns {
  const n = text.length
  const ids = new Uint8Array(n)
  let cur = -1
  const stack: { close: number; script: number }[] = []
  for (let i = 0; i < n; ) {
    const cp = text.codePointAt(i)!
    const len = cp > 0xffff ? 2 : 1
    const set = scriptSet(cp)
    let id: number
    const first = set[0]!
    if (first === INHERITED_ID) {
      id = cur >= 0 ? cur : COMMON_ID
    } else if (first === COMMON_ID) {
      const partner = cp <= 0xffff ? bracketPartner(cp) : null
      if (partner && partner.kind === 'open') {
        stack.push({ close: partner.other, script: cur })
        id = cur >= 0 ? cur : COMMON_ID
      } else if (partner && partner.kind === 'close') {
        let k = stack.length - 1
        while (k >= 0 && stack[k]!.close !== cp) k--
        if (k >= 0) {
          const sc = stack[k]!.script
          stack.length = k
          id = sc >= 0 ? sc : cur >= 0 ? cur : COMMON_ID
        } else id = cur >= 0 ? cur : COMMON_ID
      } else id = cur >= 0 ? cur : COMMON_ID
    } else {
      id = cur >= 0 && set.includes(cur) ? cur : first
      if (cur < 0) {
        // Back-fill leading commons with the first specific script.
        for (let j = 0; j < i; j++) ids[j] = id
        for (const s of stack) if (s.script < 0) s.script = id
      }
      cur = id
    }
    for (let j = 0; j < len; j++) ids[i + j] = id
    i += len
  }
  return { ids, tags: SCRIPT_TAGS }
}

/** Scripts written right to left or otherwise joined cursively: letter-spacing must not be applied to them. */
export const CURSIVE_SCRIPTS = new Set(['Arab', 'Syrc', 'Mong', 'Nkoo', 'Adlm', 'Mand', 'Rjng'])

/** Scripts whose text has no spaces between words (line breaking needs dictionary segmentation). */
export const SEGMENTED_SCRIPTS = new Set(['Thai', 'Laoo', 'Khmr', 'Mymr'])

/** Guess a CJK language from the text: kana means Japanese, hangul Korean, otherwise Simplified Chinese. */
export function guessCjkLang(text: string): 'ja' | 'ko' | 'zh-Hans' {
  if (/[぀-ヿㇰ-ㇿ]/.test(text)) return 'ja'
  if (/[가-힯ᄀ-ᇿ㄰-㆏]/.test(text)) return 'ko'
  return 'zh-Hans'
}

// ---- code point classes used by itemization and fallback -----------------------------------------------------

/** Characters that never need a glyph of their own (joiners, variation selectors, bidi controls, ...). */
export function isDefaultIgnorable(cp: number): boolean {
  return (
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x061c ||
    (cp >= 0x115f && cp <= 0x1160) ||
    (cp >= 0x17b4 && cp <= 0x17b5) ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xfff0 && cp <= 0xfff8) ||
    (cp >= 0xe0000 && cp <= 0xe0fff)
  )
}

const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u
const EXT_PICT = /^\p{Extended_Pictographic}$/u

/** Should this character be drawn with the emoji font when a font stack could also cover it as text? */
export function prefersEmoji(cp: number, followedByVs16: boolean): boolean {
  if (cp < 0x203c) return false
  const ch = String.fromCodePoint(cp)
  return EMOJI_PRESENTATION.test(ch) || (followedByVs16 && EXT_PICT.test(ch))
}
