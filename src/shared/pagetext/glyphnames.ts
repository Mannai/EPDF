import { glyphNameToUnicode } from '../../renderer/src/features/textedit/pdfcontent/encodings'

/**
 * Glyph name -> Unicode for fonts without /ToUnicode. Extends the Latin/Greek Adobe Glyph List table of the content
 * engine with what legacy Arabic and Hebrew producers write: the AGL `afii57xxx` names, the AGL descriptive names
 * (`alefarabic`, `lamfinalarabic`, `shinhebrew`), and the naming used by most OpenType fonts (`alef-ar`, `beh.init`,
 * `lam_alef-ar.fina`, `uniFEDF`). Positional variants map to the base letter (that is what gets searched and copied).
 */

const AFII: Record<number, number> = {
  57388: 0x060c, 57403: 0x061b, 57407: 0x061f, 57409: 0x0621, 57410: 0x0622, 57411: 0x0623, 57412: 0x0624, 57413: 0x0625,
  57414: 0x0626, 57415: 0x0627, 57416: 0x0628, 57417: 0x0629, 57418: 0x062a, 57419: 0x062b, 57420: 0x062c, 57421: 0x062d,
  57422: 0x062e, 57423: 0x062f, 57424: 0x0630, 57425: 0x0631, 57426: 0x0632, 57427: 0x0633, 57428: 0x0634, 57429: 0x0635,
  57430: 0x0636, 57431: 0x0637, 57432: 0x0638, 57433: 0x0639, 57434: 0x063a, 57440: 0x0640, 57441: 0x0641, 57442: 0x0642,
  57443: 0x0643, 57444: 0x0644, 57445: 0x0645, 57446: 0x0646, 57470: 0x0647, 57448: 0x0648, 57449: 0x0649, 57450: 0x064a,
  57451: 0x064b, 57452: 0x064c, 57453: 0x064d, 57454: 0x064e, 57455: 0x064f, 57456: 0x0650, 57457: 0x0651, 57458: 0x0652,
  57392: 0x0660, 57393: 0x0661, 57394: 0x0662, 57395: 0x0663, 57396: 0x0664, 57397: 0x0665, 57398: 0x0666, 57399: 0x0667,
  57400: 0x0668, 57401: 0x0669, 57381: 0x066a, 57511: 0x0679, 57506: 0x067e, 57507: 0x0686, 57508: 0x0698, 57509: 0x06af,
  57512: 0x0688, 57513: 0x0691, 57514: 0x06ba, 57519: 0x06d2, 57534: 0x06d5, 57505: 0x06a4,
  // Hebrew points and punctuation
  57799: 0x05b0, 57800: 0x05b1, 57801: 0x05b2, 57802: 0x05b3, 57793: 0x05b4, 57794: 0x05b5, 57795: 0x05b6, 57798: 0x05b7,
  57797: 0x05b8, 57806: 0x05b9, 57796: 0x05bb, 57807: 0x05bc, 57839: 0x05bd, 57645: 0x05be, 57841: 0x05bf, 57842: 0x05c0,
  57804: 0x05c1, 57803: 0x05c2, 57658: 0x05c3, 57716: 0x05f0, 57717: 0x05f1, 57718: 0x05f2, 57636: 0x20aa,
  // other AGL afii names that appear in legacy fonts
  61664: 0x200c, 301: 0x200d, 299: 0x200e, 300: 0x200f, 57596: 0x200e, 57597: 0x200f
}
// Hebrew letters: afii57664..57690 = U+05D0..U+05EA
for (let i = 0; i <= 26; i++) AFII[57664 + i] = 0x05d0 + i

const ARABIC_BASE: Record<string, string> = {
  hamza: 'ء', alefmadda: 'آ', alefmaddaabove: 'آ', alefhamza: 'أ', alefhamzaabove: 'أ', wawhamza: 'ؤ', wawhamzaabove: 'ؤ',
  alefhamzabelow: 'إ', yehhamza: 'ئ', yehhamzaabove: 'ئ', alef: 'ا', beh: 'ب', ba: 'ب', tehmarbuta: 'ة', teh: 'ت', ta: 'ت',
  theh: 'ث', tha: 'ث', jeem: 'ج', jim: 'ج', hah: 'ح', ha: 'ح', khah: 'خ', kha: 'خ', dal: 'د', thal: 'ذ', dhal: 'ذ', reh: 'ر',
  ra: 'ر', zain: 'ز', zay: 'ز', seen: 'س', sin: 'س', sheen: 'ش', shin: 'ش', sad: 'ص', dad: 'ض', tah: 'ط', zah: 'ظ', ain: 'ع',
  ghain: 'غ', tatweel: 'ـ', kashida: 'ـ', feh: 'ف', fa: 'ف', qaf: 'ق', kaf: 'ك', lam: 'ل', meem: 'م', mim: 'م', noon: 'ن',
  nun: 'ن', heh: 'ه', waw: 'و', alefmaksura: 'ى', yeh: 'ي', ya: 'ي', fathatan: 'ً', dammatan: 'ٌ', kasratan: 'ٍ', fatha: 'َ',
  damma: 'ُ', kasra: 'ِ', shadda: 'ّ', sukun: 'ْ', superscriptalef: 'ٰ', alefwasla: 'ٱ', peh: 'پ', tcheh: 'چ', jeh: 'ژ',
  gaf: 'گ', keheh: 'ک', farsiyeh: 'ی', yehfarsi: 'ی', veh: 'ڤ', tteh: 'ٹ', ddal: 'ڈ', rreh: 'ڑ', noonghunna: 'ں',
  hehgoal: 'ہ', hehdoachashmee: 'ھ', yehbarree: 'ے', comma: '،', semicolon: '؛', question: '؟', percent: '٪',
  decimalseparator: '٫', thousandsseparator: '٬', zero: '٠', one: '١', two: '٢', three: '٣', four: '٤', five: '٥', six: '٦',
  seven: '٧', eight: '٨', nine: '٩', lamalef: 'لا', allah: 'الله'
}

const HEBREW_BASE: Record<string, string> = {
  alef: 'א', bet: 'ב', gimel: 'ג', dalet: 'ד', he: 'ה', vav: 'ו', zayin: 'ז', het: 'ח', tet: 'ט', yod: 'י', finalkaf: 'ך',
  kaf: 'כ', lamed: 'ל', finalmem: 'ם', mem: 'מ', finalnun: 'ן', nun: 'נ', samekh: 'ס', ayin: 'ע', finalpe: 'ף', pe: 'פ',
  finaltsadi: 'ץ', tsadi: 'צ', qof: 'ק', resh: 'ר', shin: 'ש', tav: 'ת', sheva: 'ְ', hatafsegol: 'ֱ', hatafpatah: 'ֲ',
  hatafqamats: 'ֳ', hiriq: 'ִ', tsere: 'ֵ', segol: 'ֶ', patah: 'ַ', qamats: 'ָ', holam: 'ֹ', qubuts: 'ֻ', dagesh: 'ּ',
  meteg: 'ֽ', maqaf: '־', rafe: 'ֿ', paseq: '׀', shindot: 'ׁ', sindot: 'ׂ', sofpasuq: '׃'
}

const POSITIONAL = /(initial|medial|final|isolated|init|medi|fina|isol|ini|med|fin|iso)$/

function descriptive(nameIn: string): string | undefined {
  let n = nameIn.toLowerCase().replace(/[-_ ]/g, '')
  let script: 'ar' | 'he' | null = null
  for (const [suffix, s] of [['arabic', 'ar'], ['arab', 'ar'], ['ar', 'ar'], ['hebrew', 'he'], ['hebr', 'he'], ['he', 'he']] as const) {
    if (n.endsWith(suffix) && n.length > suffix.length + 1) {
      n = n.slice(0, -suffix.length)
      script = s
      break
    }
  }
  const tryTables = (base: string): string | undefined => {
    if (script !== 'he' && ARABIC_BASE[base] !== undefined) return ARABIC_BASE[base]
    if (script !== 'ar' && HEBREW_BASE[base] !== undefined) return HEBREW_BASE[base]
    return undefined
  }
  if (!script) return undefined // plain names like "alef" are ambiguous without a script suffix; the AGL table handles Latin
  const direct = tryTables(n)
  if (direct !== undefined) return direct
  const stripped = n.replace(POSITIONAL, '')
  if (stripped !== n) return tryTables(stripped)
  return undefined
}

/** Unicode for one glyph name component (no '_' ligature separators, no '.' suffix). */
function component(part: string, scriptHint: string): string | undefined {
  if (!part) return undefined
  const m = /^afii(\d{3,5})$/.exec(part)
  if (m) {
    const cp = AFII[Number(m[1])]
    if (cp !== undefined) return String.fromCodePoint(cp)
  }
  const agl = glyphNameToUnicode(part)
  if (agl !== undefined) return agl
  return descriptive(part + scriptHint) ?? descriptive(part)
}

/**
 * Unicode for a glyph name, or undefined. Handles `uniXXXX`, `uXXXXX`, AGL names, afii names, ligatures joined by `_`
 * (`lam_alef-ar` -> لا) and suffixes after `.` (`.init`, `.sc`, `.alt1`).
 */
export function unicodeForGlyphName(name: string): string | undefined {
  if (!name || name === '.notdef') return undefined
  const base = name.split('.')[0]
  if (!base) return undefined
  // a script suffix written after the ligature (`lam_alef-ar`) applies to every component
  const sm = /[-_](ar|arab|arabic|he|hebr|hebrew)$/i.exec(base)
  const hint = sm ? sm[1] : ''
  const body = sm ? base.slice(0, sm.index) : base
  const whole = component(base, '')
  if (whole !== undefined) return whole
  const parts = body.split('_')
  let out = ''
  for (const p of parts) {
    const u = component(p, hint)
    if (u === undefined) return undefined
    out += u
  }
  return out
}
