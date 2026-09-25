export interface FontInfo {
  family: string
  bold: boolean
  italic: boolean
  mono: boolean
  serif: boolean
}

/** Well-known PostScript / PDF base names (lower-case, no spaces or hyphens) -> Office family names. */
const KNOWN: [RegExp, string, { mono?: boolean; serif?: boolean }][] = [
  [/^(arial|arialmt|arialnarrow|helvetica|helveticaneue|liberationsans|nimbussans|dejavusans)/, 'Arial', {}],
  [/^(timesnewroman|timesroman|times|liberationserif|nimbusroman|tinos|timesnewromanps)/, 'Times New Roman', { serif: true }],
  [/^(couriernew|courier|liberationmono|nimbusmono|cousine)/, 'Courier New', { mono: true }],
  [/^calibri/, 'Calibri', {}],
  [/^cambria/, 'Cambria', { serif: true }],
  [/^verdana/, 'Verdana', {}],
  [/^tahoma/, 'Tahoma', {}],
  [/^trebuchet/, 'Trebuchet MS', {}],
  [/^georgia/, 'Georgia', { serif: true }],
  [/^(segoeui|segoe)/, 'Segoe UI', {}],
  [/^comicsans/, 'Comic Sans MS', {}],
  [/^consolas/, 'Consolas', { mono: true }],
  [/^(garamond|eb ?garamond)/, 'Garamond', { serif: true }],
  [/^(palatino|bookantiqua)/, 'Palatino Linotype', { serif: true }],
  [/^(centuryschoolbook|century)/, 'Century Schoolbook', { serif: true }],
  [/^(lucidaconsole|lucidasanstypewriter)/, 'Lucida Console', { mono: true }],
  [/^(symbol)/, 'Symbol', {}],
  [/^(opensans)/, 'Open Sans', {}],
  [/^(roboto)/, 'Roboto', {}],
  [/^(lato)/, 'Lato', {}],
  [/^(arimo)/, 'Arial', {}]
]

const STYLE_WORDS = /(bolditalic|boldoblique|semibold|demibold|extrabold|ultrabold|bold|black|heavy|italic|oblique|regular|roman|normal|medium|light|thin|condensed|narrow|mt|psmt|std|pro)$/i

const isBold = (n: string): boolean => /bold|black|heavy|semibold|demibold|(^|[-,_ ])bd($|[-,_ ])|-b($|[-,_ ])/i.test(n)
const isItalic = (n: string): boolean => /italic|oblique|(^|[-,_ ])(it|obl)($|[-,_ ])|-i($|[-,_ ])/i.test(n)

/**
 * Turns a raw PDF font name (e.g. `ABCDEF+TimesNewRomanPS-BoldItalicMT`, `Helvetica-Bold`) into what Office
 * needs: a family name plus bold/italic flags. `generic` is PDF.js' CSS family guess for the font
 * (`sans-serif`, `serif`, `monospace`) used when the name says nothing useful.
 */
export function describeFont(rawName: string | undefined, generic?: string): FontInfo {
  const name = (rawName ?? '').replace(/^[A-Z]{6}\+/, '')
  const bold = isBold(name)
  const italic = isItalic(name)
  const flat = name.toLowerCase().replace(/[\s_-]+/g, '')
  for (const [re, family, flags] of KNOWN) {
    if (re.test(flat)) return { family, bold, italic, mono: !!flags.mono, serif: !!flags.serif }
  }
  const byGeneric = (): FontInfo => {
    if (generic === 'monospace') return { family: 'Courier New', bold, italic, mono: true, serif: false }
    if (generic === 'serif') return { family: 'Times New Roman', bold, italic, mono: false, serif: true }
    return { family: 'Arial', bold, italic, mono: false, serif: false }
  }
  // Derive a family from the name: drop style words after a comma/hyphen, split CamelCase.
  let base = name.split(/[,-]/)[0]
  for (let i = 0; i < 3; i++) base = base.replace(STYLE_WORDS, '')
  base = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_]+/g, ' ').trim()
  if (!/[A-Za-z]{4,}/.test(base) || /^(f|g|tt|font|type|t)\d/i.test(base)) return byGeneric()
  return { family: base, bold, italic, mono: generic === 'monospace', serif: generic === 'serif' }
}
