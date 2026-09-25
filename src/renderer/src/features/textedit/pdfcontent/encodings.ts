import { Encodings } from '@pdf-lib/standard-fonts'

/**
 * Simple-font encodings (code → Unicode) and the Adobe glyph-name → Unicode mapping needed to read
 * `/Encoding` dictionaries with `/Differences`. Codes without a character are `''`.
 */

const CP1252_HIGH = [
  0x20ac, 0x2022, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x2022, 0x017d, 0x2022,
  0x2022, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x2022, 0x017e, 0x0178
]

function ascii(): string[] {
  const t = new Array<string>(256).fill('')
  for (let c = 0x20; c < 0x7f; c++) t[c] = String.fromCharCode(c)
  return t
}

function makeWinAnsi(): string[] {
  const t = ascii()
  t[0x7f] = '•'
  CP1252_HIGH.forEach((u, i) => (t[0x80 + i] = String.fromCharCode(u)))
  for (let c = 0xa0; c <= 0xff; c++) t[c] = String.fromCharCode(c)
  t[0xa0] = ' '
  t[0xad] = '-'
  return t
}

const MAC_HIGH = [
  0xc4, 0xc5, 0xc7, 0xc9, 0xd1, 0xd6, 0xdc, 0xe1, 0xe0, 0xe2, 0xe4, 0xe3, 0xe5, 0xe7, 0xe9, 0xe8,
  0xea, 0xeb, 0xed, 0xec, 0xee, 0xef, 0xf1, 0xf3, 0xf2, 0xf4, 0xf6, 0xf5, 0xfa, 0xf9, 0xfb, 0xfc,
  0x2020, 0xb0, 0xa2, 0xa3, 0xa7, 0x2022, 0xb6, 0xdf, 0xae, 0xa9, 0x2122, 0xb4, 0xa8, 0x2260, 0xc6, 0xd8,
  0x221e, 0xb1, 0x2264, 0x2265, 0xa5, 0xb5, 0x2202, 0x2211, 0x220f, 0x3c0, 0x222b, 0xaa, 0xba, 0x3a9, 0xe6, 0xf8,
  0xbf, 0xa1, 0xac, 0x221a, 0x192, 0x2248, 0x2206, 0xab, 0xbb, 0x2026, 0x20, 0xc0, 0xc3, 0xd5, 0x152, 0x153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0xf7, 0x25ca, 0xff, 0x178, 0x2044, 0xa4, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0xb7, 0x201a, 0x201e, 0x2030, 0xc2, 0xca, 0xc1, 0xcb, 0xc8, 0xcd, 0xce, 0xcf, 0xcc, 0xd3, 0xd4,
  0, 0xd2, 0xda, 0xdb, 0xd9, 0x131, 0x2c6, 0x2dc, 0xaf, 0x2d8, 0x2d9, 0x2da, 0xb8, 0x2dd, 0x2db, 0x2c7
]

function makeMacRoman(): string[] {
  const t = ascii()
  MAC_HIGH.forEach((u, i) => (t[0x80 + i] = u ? String.fromCharCode(u) : ''))
  return t
}

const STANDARD_HIGH: Record<number, number> = {
  0xa1: 0xa1, 0xa2: 0xa2, 0xa3: 0xa3, 0xa4: 0x2044, 0xa5: 0xa5, 0xa6: 0x192, 0xa7: 0xa7, 0xa8: 0xa4, 0xa9: 0x27, 0xaa: 0x201c,
  0xab: 0xab, 0xac: 0x2039, 0xad: 0x203a, 0xae: 0xfb01, 0xaf: 0xfb02, 0xb1: 0x2013, 0xb2: 0x2020, 0xb3: 0x2021, 0xb4: 0xb7,
  0xb6: 0xb6, 0xb7: 0x2022, 0xb8: 0x201a, 0xb9: 0x201e, 0xba: 0x201d, 0xbb: 0xbb, 0xbc: 0x2026, 0xbd: 0x2030, 0xbf: 0xbf,
  0xc1: 0x60, 0xc2: 0xb4, 0xc3: 0x2c6, 0xc4: 0x2dc, 0xc5: 0xaf, 0xc6: 0x2d8, 0xc7: 0x2d9, 0xc8: 0xa8, 0xca: 0x2da, 0xcb: 0xb8,
  0xcd: 0x2dd, 0xce: 0x2db, 0xcf: 0x2c7, 0xd0: 0x2014, 0xe1: 0xc6, 0xe3: 0xaa, 0xe8: 0x141, 0xe9: 0xd8, 0xea: 0x152, 0xeb: 0xba,
  0xf1: 0xe6, 0xf5: 0x131, 0xf8: 0x142, 0xf9: 0xf8, 0xfa: 0x153, 0xfb: 0xdf
}

function makeStandard(): string[] {
  const t = ascii()
  t[0x27] = '’'
  t[0x60] = '‘'
  for (const [c, u] of Object.entries(STANDARD_HIGH)) t[Number(c)] = String.fromCharCode(u)
  return t
}

export const WIN_ANSI: readonly string[] = makeWinAnsi()
export const MAC_ROMAN: readonly string[] = makeMacRoman()
export const STANDARD: readonly string[] = makeStandard()

export type BaseEncodingName = 'WinAnsiEncoding' | 'MacRomanEncoding' | 'StandardEncoding' | 'MacExpertEncoding'

export function baseEncoding(name: string): readonly string[] | undefined {
  switch (name) {
    case 'WinAnsiEncoding':
      return WIN_ANSI
    case 'MacRomanEncoding':
      return MAC_ROMAN
    case 'StandardEncoding':
    case 'MacExpertEncoding': // expert glyphs are not decodable to plain text; Standard is the closest usable guess
      return STANDARD
  }
  return undefined
}

// ---- glyph names ----------------------------------------------------------------------------------------

/** Adobe Glyph List entries beyond the WinAnsi set (Latin Extended-A, punctuation, math, Greek). */
const EXTRA_GLYPHS =
  'Amacron:100 amacron:101 Abreve:102 abreve:103 Aogonek:104 aogonek:105 Cacute:106 cacute:107 Ccircumflex:108 ccircumflex:109 ' +
  'Cdotaccent:10A cdotaccent:10B Ccaron:10C ccaron:10D Dcaron:10E dcaron:10F Dcroat:110 dcroat:111 Emacron:112 emacron:113 ' +
  'Ebreve:114 ebreve:115 Edotaccent:116 edotaccent:117 Eogonek:118 eogonek:119 Ecaron:11A ecaron:11B Gcircumflex:11C gcircumflex:11D ' +
  'Gbreve:11E gbreve:11F Gdotaccent:120 gdotaccent:121 Gcommaaccent:122 gcommaaccent:123 Hcircumflex:124 hcircumflex:125 Hbar:126 hbar:127 ' +
  'Itilde:128 itilde:129 Imacron:12A imacron:12B Ibreve:12C ibreve:12D Iogonek:12E iogonek:12F Idotaccent:130 dotlessi:131 IJ:132 ij:133 ' +
  'Jcircumflex:134 jcircumflex:135 Kcommaaccent:136 kcommaaccent:137 kgreenlandic:138 Lacute:139 lacute:13A Lcommaaccent:13B lcommaaccent:13C ' +
  'Lcaron:13D lcaron:13E Ldot:13F ldot:140 Lslash:141 lslash:142 Nacute:143 nacute:144 Ncommaaccent:145 ncommaaccent:146 Ncaron:147 ncaron:148 ' +
  'napostrophe:149 Eng:14A eng:14B Omacron:14C omacron:14D Obreve:14E obreve:14F Ohungarumlaut:150 ohungarumlaut:151 OE:152 oe:153 ' +
  'Racute:154 racute:155 Rcommaaccent:156 rcommaaccent:157 Rcaron:158 rcaron:159 Sacute:15A sacute:15B Scircumflex:15C scircumflex:15D ' +
  'Scedilla:15E scedilla:15F Scaron:160 scaron:161 Tcommaaccent:162 Tcedilla:162 tcommaaccent:163 tcedilla:163 Tcaron:164 tcaron:165 Tbar:166 tbar:167 ' +
  'Utilde:168 utilde:169 Umacron:16A umacron:16B Ubreve:16C ubreve:16D Uring:16E uring:16F Uhungarumlaut:170 uhungarumlaut:171 Uogonek:172 uogonek:173 ' +
  'Wcircumflex:174 wcircumflex:175 Ycircumflex:176 ycircumflex:177 Ydieresis:178 Zacute:179 zacute:17A Zdotaccent:17B zdotaccent:17C Zcaron:17D zcaron:17E ' +
  'longs:17F florin:192 circumflex:2C6 caron:2C7 breve:2D8 dotaccent:2D9 ring:2DA ogonek:2DB tilde:2DC hungarumlaut:2DD ' +
  'quoteleft:2018 quoteright:2019 quotesinglbase:201A quotedblleft:201C quotedblright:201D quotedblbase:201E dagger:2020 daggerdbl:2021 ' +
  'bullet:2022 ellipsis:2026 perthousand:2030 guilsinglleft:2039 guilsinglright:203A fraction:2044 Euro:20AC trademark:2122 endash:2013 emdash:2014 ' +
  'minus:2212 fi:FB01 fl:FB02 ff:FB00 ffi:FB03 ffl:FB04 nbspace:A0 nonbreakingspace:A0 sfthyphen:AD softhyphen:AD hyphen:2D space:20 ' +
  'macron:AF periodcentered:B7 multiply:D7 divide:F7 plusminus:B1 mu:B5 degree:B0 lessequal:2264 greaterequal:2265 notequal:2260 approxequal:2248 ' +
  'infinity:221E summation:2211 product:220F partialdiff:2202 integral:222B radical:221A lozenge:25CA arrowleft:2190 arrowup:2191 arrowright:2192 ' +
  'arrowdown:2193 arrowboth:2194 checkmark:2713 asciicircum:5E asciitilde:7E underscore:5F ' +
  'Alpha:391 Beta:392 Gamma:393 Delta:394 Epsilon:395 Zeta:396 Eta:397 Theta:398 Iota:399 Kappa:39A Lambda:39B Mu:39C Nu:39D Xi:39E Omicron:39F ' +
  'Pi:3A0 Rho:3A1 Sigma:3A3 Tau:3A4 Upsilon:3A5 Phi:3A6 Chi:3A7 Psi:3A8 Omega:3A9 alpha:3B1 beta:3B2 gamma:3B3 delta:3B4 epsilon:3B5 zeta:3B6 eta:3B7 ' +
  'theta:3B8 iota:3B9 kappa:3BA lambda:3BB nu:3BD xi:3BE omicron:3BF pi:3C0 rho:3C1 sigma1:3C2 sigma:3C3 tau:3C4 upsilon:3C5 phi:3C6 chi:3C7 psi:3C8 omega:3C9'

let glyphMap: Map<string, string> | null = null

function glyphTable(): Map<string, string> {
  if (glyphMap) return glyphMap
  const m = new Map<string, string>()
  // Names and code points of the WinAnsi set come from pdf-lib's own metrics tables.
  for (const cp of Encodings.WinAnsi.supportedCodePoints) m.set(Encodings.WinAnsi.encodeUnicodeCodePoint(cp).name, String.fromCodePoint(cp))
  for (const cp of Encodings.Symbol.supportedCodePoints) {
    const n = Encodings.Symbol.encodeUnicodeCodePoint(cp).name
    if (!m.has(n)) m.set(n, String.fromCodePoint(cp))
  }
  for (const cp of Encodings.ZapfDingbats.supportedCodePoints) {
    const n = Encodings.ZapfDingbats.encodeUnicodeCodePoint(cp).name
    if (!m.has(n)) m.set(n, String.fromCodePoint(cp))
  }
  for (const item of EXTRA_GLYPHS.split(' ')) {
    const [n, hex] = item.split(':')
    m.set(n, String.fromCodePoint(parseInt(hex, 16)))
  }
  glyphMap = m
  return m
}

/** Unicode text for a glyph name (`A`, `eacute`, `uni20AC`, `u1F600`, `f_i`, `a.sc`), or undefined if unknown. */
export function glyphNameToUnicode(glyph: string): string | undefined {
  const base = glyph.split('.')[0]
  if (!base) return undefined
  const table = glyphTable()
  const one = (part: string): string | undefined => {
    const hit = table.get(part)
    if (hit !== undefined) return hit
    let m = /^uni((?:[0-9A-F]{4})+)$/.exec(part)
    if (m) {
      let s = ''
      for (let i = 0; i < m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16))
      return s
    }
    m = /^u([0-9A-F]{4,6})$/.exec(part)
    if (m) {
      const cp = parseInt(m[1], 16)
      if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp)
    }
    return undefined
  }
  const parts = base.split('_')
  let out = ''
  for (const p of parts) {
    const u = one(p)
    if (u === undefined) return undefined
    out += u
  }
  return out
}

/** Glyph name in the WinAnsi/Adobe set for a single character (used to look up standard-font metrics). */
export function glyphNameForChar(ch: string): string | undefined {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return undefined
  if (Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) return Encodings.WinAnsi.encodeUnicodeCodePoint(cp).name
  for (const [n, u] of glyphTable()) if (u === ch) return n
  return undefined
}

/** Symbol / ZapfDingbats built-in encodings as code → Unicode tables. */
export function symbolEncoding(kind: 'Symbol' | 'ZapfDingbats'): string[] {
  const enc = Encodings[kind]
  const t = new Array<string>(256).fill('')
  for (const cp of enc.supportedCodePoints) {
    const { code } = enc.encodeUnicodeCodePoint(cp)
    if (code >= 0 && code < 256) t[code] = String.fromCodePoint(cp)
  }
  return t
}
