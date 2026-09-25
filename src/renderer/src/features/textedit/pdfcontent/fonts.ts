import { Font, FontNames } from '@pdf-lib/standard-fonts'
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFStream } from 'pdf-lib'
import { cmapCid, cmapEntries, cmapUnicode, parseCMap, splitCodes, type CMap } from './cmap'
import { ContentParseError } from './content'
import { STANDARD, WIN_ANSI, baseEncoding, glyphNameForChar, glyphNameToUnicode, symbolEncoding } from './encodings'
import { dget, darr, ddict, dname, dnum, dstream, nameText, numbers, streamBytes } from './pdfutil'

/**
 * Font information needed to read and rewrite text: decoding strings into Unicode, glyph widths (for bounding
 * boxes and repositioning), and whether/how a character can be encoded with the same font.
 */

export interface GlyphInfo {
  code: number
  /** Number of bytes the code occupies in the string. */
  n: number
  text: string
  /** Advance width in 1/1000 of text space. */
  width: number
  /** False when no Unicode mapping is known for the code. */
  known: boolean
  /** Single-byte code 32: the only code word spacing (Tw) applies to. */
  space: boolean
}

export interface FontStyle {
  bold: boolean
  italic: boolean
  serif: boolean
  mono: boolean
}

export interface PdfFont {
  baseFont: string
  /** BaseFont without the `ABCDEF+` subset prefix. */
  displayName: string
  subtype: string
  style: FontStyle
  isSubset: boolean
  embedded: boolean
  standard: FontNames | undefined
  /** False when text in this font must not be rewritten; `reason` says why (shown to the user). */
  editable: boolean
  reason?: string
  /** Font ascent/descent as fractions of the font size (descent is negative). */
  ascent: number
  descent: number
  glyphs(bytes: Uint8Array): GlyphInfo[]
  /** Bytes of the code that shows `ch` (one code point) with this font, or null if it cannot. */
  encode(ch: string, used: ReadonlySet<number>): number[] | null
  /** Width in 1/1000 em of a code (used for re-measuring after edits). */
  widthOf(code: number): number
}

const SUBSET_RE = /^[A-Z]{6}\+/

export function stripSubset(name: string): string {
  return name.replace(SUBSET_RE, '')
}

/** Maps a BaseFont name (or alias like Arial, TimesNewRoman, CourierNew) to a PDF standard-14 font. */
export function standardFontFor(baseFont: string): FontNames | undefined {
  const n = stripSubset(baseFont).replace(/[\s_]/g, '').toLowerCase()
  const bold = /bold|black|heavy|demi/.test(n)
  const italic = /italic|oblique|ital\b|it$/.test(n) || /(-|,)(bi|bolditalic|boldoblique)/.test(n)
  if (/^symbol(mt)?($|,|-)/.test(n)) return FontNames.Symbol
  if (/^zapfdingbats/.test(n)) return FontNames.ZapfDingbats
  if (/^(helvetica|arial)(mt)?($|[,-])/.test(n) && !/narrow|black|rounded|unicode|light|condensed/.test(n)) {
    return bold ? (italic ? FontNames.HelveticaBoldOblique : FontNames.HelveticaBold) : italic ? FontNames.HelveticaOblique : FontNames.Helvetica
  }
  if (/^(times|timesnewroman)(psmt|ps)?($|[,-])/.test(n) && !/small|bookman/.test(n)) {
    return bold ? (italic ? FontNames.TimesRomanBoldItalic : FontNames.TimesRomanBold) : italic ? FontNames.TimesRomanItalic : FontNames.TimesRoman
  }
  if (/^(courier|couriernew)(psmt|ps)?($|[,-])/.test(n)) {
    return bold ? (italic ? FontNames.CourierBoldOblique : FontNames.CourierBold) : italic ? FontNames.CourierOblique : FontNames.Courier
  }
  return undefined
}

export function styleOf(baseFont: string, flags: number | undefined, italicAngle: number | undefined, weight: number | undefined): FontStyle {
  const n = stripSubset(baseFont)
  const f = flags ?? 0
  const bold = /bold|black|heavy|semibold|demi/i.test(n) || (weight ?? 0) >= 600 || (f & 0x40000) !== 0
  const italic = /italic|oblique|(^|[-,])it$/i.test(n) || (italicAngle ?? 0) !== 0 || (f & 0x40) !== 0
  const mono = (f & 1) !== 0 || /courier|mono|consolas|lucida ?console|typewriter|menlo/i.test(n)
  const serif =
    !mono &&
    ((f & 2) !== 0 && !/sans|arial|helvetica|verdana|tahoma|calibri/i.test(n)
      ? true
      : /times|serif(?!.*sans)|georgia|garamond|palatino|cambria|minion|bookman|century|roman|didot|baskerville/i.test(n) &&
        !/sans/i.test(n))
  return { bold, italic, serif, mono }
}

export function cssFontFamily(font: Pick<PdfFont, 'displayName' | 'style'>): string {
  const generic = font.style.mono
    ? "'Courier New', Courier, monospace"
    : font.style.serif
      ? "'Times New Roman', Times, serif"
      : 'Arial, Helvetica, sans-serif'
  const first = stripSubset(font.displayName).split(/[-,]/)[0].replace(/(MT|PS|PSMT)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  if (/^(arial|calibri|verdana|tahoma|georgia|cambria|consolas|segoe ui|trebuchet ms|helvetica|times new roman|courier new|palatino|garamond|century gothic)$/i.test(first)) {
    return `'${first}', ${generic}`
  }
  return generic
}

interface DescriptorInfo {
  flags?: number
  ascent?: number
  descent?: number
  missingWidth?: number
  italicAngle?: number
  weight?: number
  embedded: boolean
}

function readDescriptor(d: PDFDict | undefined): DescriptorInfo {
  const fd = ddict(d, 'FontDescriptor')
  return {
    flags: dnum(fd, 'Flags'),
    ascent: dnum(fd, 'Ascent'),
    descent: dnum(fd, 'Descent'),
    missingWidth: dnum(fd, 'MissingWidth'),
    italicAngle: dnum(fd, 'ItalicAngle'),
    weight: dnum(fd, 'FontWeight'),
    embedded: !!(dget(fd, 'FontFile') ?? dget(fd, 'FontFile2') ?? dget(fd, 'FontFile3'))
  }
}

function metricsOf(desc: DescriptorInfo, std: Font | undefined): { ascent: number; descent: number } {
  let a = desc.ascent !== undefined && desc.ascent !== 0 ? desc.ascent / 1000 : std ? Number(std.Ascender ?? 718) / 1000 : 0.8
  let d = desc.descent !== undefined && desc.descent !== 0 ? -Math.abs(desc.descent) / 1000 : std ? -Math.abs(Number(std.Descender ?? -207)) / 1000 : -0.2
  if (!(a >= 0.5 && a <= 1.2)) a = 0.8
  if (!(d <= -0.05 && d >= -0.5)) d = -0.2
  return { ascent: a, descent: d }
}

function readToUnicode(d: PDFDict): CMap | undefined {
  const s = dstream(d, 'ToUnicode')
  if (!s) return undefined
  try {
    return parseCMap(streamBytes(s))
  } catch {
    return undefined
  }
}

const stdCache = new Map<string, Font>()
function loadStd(name: FontNames): Font {
  let f = stdCache.get(name)
  if (!f) stdCache.set(name, (f = Font.load(name)))
  return f
}

// ---- simple fonts ---------------------------------------------------------------------------------------

function loadSimple(d: PDFDict, subtype: string, baseFont: string): PdfFont {
  const desc = readDescriptor(d)
  const std = standardFontFor(baseFont)
  const isSubset = SUBSET_RE.test(baseFont)
  const toUni = readToUnicode(d)
  const flags = desc.flags
  const symbolic = flags !== undefined && (flags & 4) !== 0 && (flags & 32) === 0
  const enc = dget(d, 'Encoding')
  let table: string[]
  let names: (string | undefined)[] = new Array<string | undefined>(256).fill(undefined)
  let hasEncoding = false

  // 1. base table
  let baseName: string | undefined
  let differences: PDFArray | undefined
  if (enc instanceof PDFName) {
    baseName = nameText(enc)
    hasEncoding = true
  } else if (enc instanceof PDFDict) {
    baseName = dname(enc, 'BaseEncoding')
    differences = darr(enc, 'Differences')
    hasEncoding = true
  }
  const known = baseName ? baseEncoding(baseName) : undefined
  if (known) table = [...known]
  else if (std === FontNames.Symbol || std === FontNames.ZapfDingbats) table = symbolEncoding(std === FontNames.Symbol ? 'Symbol' : 'ZapfDingbats')
  else if (subtype === 'TrueType' && !symbolic) table = [...WIN_ANSI]
  else if (symbolic && desc.embedded) table = new Array<string>(256).fill('')
  else table = [...(subtype === 'TrueType' ? WIN_ANSI : STANDARD)]

  // 2. /Differences
  if (differences) {
    let code = 0
    for (let i = 0; i < differences.size(); i++) {
      const o = differences.lookup(i)
      if (o instanceof PDFNumber) code = o.asNumber()
      else if (o instanceof PDFName) {
        const g = nameText(o)
        if (code >= 0 && code < 256) {
          names[code] = g
          table[code] = glyphNameToUnicode(g) ?? ''
        }
        code++
      }
    }
  }
  names = names.slice(0, 256)

  // 3. ToUnicode wins over the encoding tables where it has an entry.
  let anyToUni = false
  if (toUni) {
    for (let c = 0; c < 256; c++) {
      const u = cmapUnicode(toUni, c, 1) ?? cmapUnicode(toUni, c, 2)
      if (u !== undefined && u !== '') {
        table[c] = u
        anyToUni = true
      }
    }
  }

  // 4. widths
  const firstChar = dnum(d, 'FirstChar') ?? 0
  const widthsArr = darr(d, 'Widths')
  const widths = widthsArr ? numbers(widthsArr) : undefined
  let unitScale = 1
  if (subtype === 'Type3') {
    const fm = numbers(darr(d, 'FontMatrix'))
    if (fm.length === 6 && Number.isFinite(fm[0])) unitScale = fm[0] * 1000
  }
  const stdFont = std ? loadStd(std) : undefined
  const widthOf = (code: number): number => {
    if (widths && code >= firstChar && code < firstChar + widths.length) {
      const w = widths[code - firstChar]
      return Number.isFinite(w) ? w * unitScale : (desc.missingWidth ?? 0)
    }
    if (!widths && stdFont) {
      const g = names[code] ?? (table[code] ? glyphNameForChar(table[code]) : undefined)
      const w = g ? stdFont.getWidthOfGlyph(g) : undefined
      if (typeof w === 'number') return w
      return 0
    }
    return desc.missingWidth ?? 0
  }
  const hasGlyphNominally = (code: number): boolean => {
    if (!table[code]) return false
    if (widths) return code >= firstChar && code < firstChar + widths.length && (widths[code - firstChar] ?? 0) > 0
    if (stdFont) return widthOf(code) > 0
    return true
  }

  let editable = true
  let reason: string | undefined
  if (subtype === 'Type3') {
    editable = false
    reason = 'it uses a Type 3 font (glyphs drawn as small graphics)'
  } else if (!hasEncoding && !anyToUni && desc.embedded && !std && (isSubset || subtype === 'TrueType' || symbolic)) {
    editable = false
    reason = 'its font has no character mapping, so the letters cannot be read reliably'
  }

  const reverse = new Map<string, number[]>()
  for (let c = 0; c < 256; c++) {
    const u = table[c]
    if (!u) continue
    const l = reverse.get(u)
    if (l) l.push(c)
    else reverse.set(u, [c])
  }

  const style = styleOf(baseFont, flags, desc.italicAngle, desc.weight)
  const { ascent, descent } = metricsOf(desc, stdFont)
  return {
    baseFont,
    displayName: stripSubset(baseFont),
    subtype,
    style,
    isSubset,
    embedded: desc.embedded,
    standard: std,
    editable,
    reason,
    ascent,
    descent,
    widthOf,
    glyphs(bytes) {
      const out: GlyphInfo[] = []
      for (const code of bytes) {
        const u = table[code]
        out.push({ code, n: 1, text: u || '�', width: widthOf(code), known: !!u, space: code === 32 })
      }
      return out
    },
    encode(ch, used) {
      const cands = reverse.get(ch)
      if (!cands) return null
      const seen = cands.find((c) => used.has(c))
      if (seen !== undefined) return [seen]
      // Embedded fonts are assumed to be subsets (their glyphs are only known to exist where already used).
      const free = cands.find((c) => (!(isSubset || desc.embedded) || ch === ' ') && hasGlyphNominally(c))
      return free !== undefined ? [free] : null
    }
  }
}

// ---- Type0 / CID fonts ----------------------------------------------------------------------------------

function loadType0(d: PDFDict, baseFont: string): PdfFont {
  const desc0 = darr(d, 'DescendantFonts')?.lookup(0)
  const cid = desc0 instanceof PDFDict ? desc0 : undefined
  const desc = readDescriptor(cid)
  const toUni = readToUnicode(d)
  const enc = dget(d, 'Encoding')
  let encName: string | undefined
  let encMap: CMap | undefined
  let editable = true
  let reason: string | undefined
  if (enc instanceof PDFName) encName = nameText(enc)
  else if (enc instanceof PDFStream) {
    try {
      encMap = parseCMap(streamBytes(enc))
    } catch {
      editable = false
      reason = 'its font encoding could not be read'
    }
    const useName = encMap?.useCMap
    if (useName) encName = useName
  }
  const identity = encName === undefined ? !encMap : /^Identity-[HV]$/.test(encName)
  const vertical = (encName ? /-V$/.test(encName) : false) || encMap?.wmode === 1
  if (vertical) {
    editable = false
    reason = 'it uses vertical writing'
  } else if (editable && !identity && !(encMap && encMap.cidRanges.length + encMap.cidChars.size > 0)) {
    editable = false
    reason = `it uses the predefined character set “${encName ?? 'unknown'}”, which Epdf cannot read`
  }
  if (editable && !toUni) {
    editable = false
    reason = 'its font has no Unicode mapping (/ToUnicode), so the letters cannot be read reliably'
  }
  const subtypeOfCid = cid ? dname(cid, 'Subtype') : undefined
  const space = encMap && encMap.codespace.length ? encMap.codespace : toUni && toUni.codespace.length ? toUni.codespace : []

  // widths
  const dw = dnum(cid, 'DW') ?? 1000
  const wList = new Map<number, number>()
  const wRanges: { lo: number; hi: number; w: number }[] = []
  const wArr = darr(cid, 'W')
  if (wArr) {
    const items = [...Array(wArr.size()).keys()].map((i) => wArr.lookup(i))
    for (let i = 0; i < items.length; ) {
      const first = items[i]
      const second = items[i + 1]
      if (first instanceof PDFNumber && second instanceof PDFArray) {
        const c0 = first.asNumber()
        numbers(second).forEach((w, k) => wList.set(c0 + k, w))
        i += 2
      } else if (first instanceof PDFNumber && second instanceof PDFNumber && items[i + 2] instanceof PDFNumber) {
        wRanges.push({ lo: first.asNumber(), hi: second.asNumber(), w: (items[i + 2] as PDFNumber).asNumber() })
        i += 3
      } else i++
    }
  }
  const cidOf = (code: number, n: number): number | undefined => {
    if (encMap && (encMap.cidRanges.length || encMap.cidChars.size)) return cmapCid(encMap, code, n)
    return identity ? code : undefined
  }
  const widthOfCode = (code: number, n: number): number => {
    const c = cidOf(code, n)
    if (c === undefined) return dw
    const l = wList.get(c)
    if (l !== undefined) return Number.isFinite(l) ? l : dw
    for (const r of wRanges) if (c >= r.lo && c <= r.hi) return r.w
    return dw
  }
  const hasExplicitWidth = (code: number, n: number): boolean => {
    const c = cidOf(code, n)
    if (c === undefined) return false
    return wList.has(c) || wRanges.some((r) => c >= r.lo && c <= r.hi)
  }

  const reverse = new Map<string, { code: number; n: number }[]>()
  if (toUni) {
    for (const e of cmapEntries(toUni)) {
      if (!e.text) continue
      const l = reverse.get(e.text)
      if (l) l.push({ code: e.code, n: e.n })
      else reverse.set(e.text, [{ code: e.code, n: e.n }])
    }
  }
  const isSubset = SUBSET_RE.test(baseFont)
  const style = styleOf(baseFont, desc.flags, desc.italicAngle, desc.weight)
  const { ascent, descent } = metricsOf(desc, undefined)
  void subtypeOfCid
  return {
    baseFont,
    displayName: stripSubset(baseFont),
    subtype: 'Type0',
    style,
    isSubset,
    embedded: desc.embedded,
    standard: undefined,
    editable,
    reason,
    ascent,
    descent,
    widthOf: (code) => widthOfCode(code, 2),
    glyphs(bytes) {
      const codes = splitCodes(bytes, space.length ? space : [{ n: 2, lo: 0, hi: 0xffff }], 2)
      return codes.map(([code, n]) => {
        const u = toUni ? cmapUnicode(toUni, code, n) : undefined
        return { code, n, text: u && u !== '' ? u : '�', width: widthOfCode(code, n), known: !!u && u !== '', space: false }
      })
    },
    encode(ch, used) {
      const cands = reverse.get(ch)
      if (!cands) return null
      const seen = cands.find((c) => used.has(c.code))
      const hit = seen ?? cands.find((c) => !isSubset && hasExplicitWidth(c.code, c.n))
      if (!hit) return null
      const out: number[] = []
      for (let k = hit.n - 1; k >= 0; k--) out.push(Math.floor(hit.code / 2 ** (8 * k)) % 256)
      return out
    }
  }
}

/** Reads a font dictionary. Never throws for odd fonts: unsupported ones are returned as not editable. */
export function loadFont(d: PDFDict): PdfFont {
  const subtype = dname(d, 'Subtype') ?? 'Type1'
  const baseFont = dname(d, 'BaseFont') ?? 'Unknown'
  try {
    if (subtype === 'Type0') return loadType0(d, baseFont)
    return loadSimple(d, subtype, baseFont)
  } catch (e) {
    if (e instanceof ContentParseError) throw e
    return unreadableFont(subtype, baseFont, e instanceof Error ? e.message : String(e))
  }
}

export function unreadableFont(subtype: string, baseFont: string, why: string): PdfFont {
  return {
    baseFont,
    displayName: stripSubset(baseFont),
    subtype,
    style: styleOf(baseFont, undefined, undefined, undefined),
    isSubset: SUBSET_RE.test(baseFont),
    embedded: false,
    standard: undefined,
    editable: false,
    reason: `its font could not be read (${why})`,
    ascent: 0.8,
    descent: -0.2,
    widthOf: () => 500,
    glyphs: (bytes) => Array.from(bytes, (code) => ({ code, n: 1, text: '�', width: 500, known: false, space: code === 32 })),
    encode: () => null
  }
}
