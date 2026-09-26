import { Font, FontNames } from '@pdf-lib/standard-fonts'
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFStream } from 'pdf-lib'
import { cmapCid, cmapUnicode, parseCMap, splitCodes, type CMap, type CodeSpaceRange } from '../../renderer/src/features/textedit/pdfcontent/cmap'
import { STANDARD, WIN_ANSI, baseEncoding, glyphNameForChar, symbolEncoding } from '../../renderer/src/features/textedit/pdfcontent/encodings'
import { standardFontFor } from '../../renderer/src/features/textedit/pdfcontent/fonts'
import { darr, ddict, dget, dname, dnum, dstream, nameText, numbers, streamBytes } from '../../renderer/src/features/textedit/pdfcontent/pdfutil'
import { unicodeForGlyphName } from './glyphnames'
import { readSfnt, type Sfnt } from './sfnt'
import { normalizeGlyphText } from './unicode'

/**
 * Font decoding for text extraction: character codes -> Unicode text, advance widths and (for zero-width glyphs such as
 * combining marks) ink extents. Unicode comes from, in order:
 *   1. /ToUnicode;
 *   2. the font encoding: /Encoding base table + /Differences glyph names (extended glyph list incl. Arabic/Hebrew),
 *      predefined Unicode CMaps (Uni*-UCS2/UTF16);
 *   3. the embedded font program: its Unicode cmap (reverse) and post-table glyph names.
 * Unlike the content editor's font reader this never refuses: unknown codes are reported as `known: false`.
 */

export interface DecodedGlyph {
  code: number
  n: number
  /** Unicode text ('' when unknown or when the glyph has no text, e.g. a mark piece without a mapping). */
  text: string
  known: boolean
  /** Horizontal advance in text space per unit font size (i.e. /W / 1000, Type 3 scaled by its FontMatrix). */
  w: number
  /** Vertical advance per unit font size (vertical writing only; negative = downwards). */
  w1: number
  /** Position vector for vertical writing (per unit font size). */
  vx: number
  vy: number
  /** Single-byte code 32 (the only code word spacing applies to). */
  space: boolean
  gid: number | undefined
}

export interface TextFont {
  key: number
  name: string
  vertical: boolean
  type3: boolean
  /** Ascent/descent per unit font size (descent negative). */
  ascent: number
  descent: number
  decode(bytes: Uint8Array): DecodedGlyph[]
  /** Ink extent along the baseline [x0, x1] per unit font size, relative to the glyph origin, if the font program is available. */
  ink(gid: number | undefined): [number, number] | undefined
  /** Why text in this font may be unreliable (e.g. predefined CMap that cannot be decoded). */
  problem?: string
}

let fontKeys = 0
const cache = new WeakMap<PDFDict, TextFont>()

export function textFontFor(d: PDFDict): TextFont {
  let f = cache.get(d)
  if (!f) {
    try {
      f = dname(d, 'Subtype') === 'Type0' ? loadType0(d) : loadSimple(d)
    } catch (e) {
      f = brokenFont(dname(d, 'BaseFont') ?? 'Unknown', e instanceof Error ? e.message : String(e))
    }
    cache.set(d, f)
  }
  return f
}

export function brokenFont(name: string, why: string): TextFont {
  return {
    key: ++fontKeys,
    name,
    vertical: false,
    type3: false,
    ascent: 0.8,
    descent: -0.2,
    problem: why,
    decode: (bytes) => Array.from(bytes, (code) => ({ code, n: 1, text: '', known: false, w: 0.5, w1: -1, vx: 0.25, vy: 0.88, space: code === 32, gid: undefined })),
    ink: () => undefined
  }
}

// ---------------------------------------------------------------------------------------------------------
// shared helpers

function readToUnicode(d: PDFDict): CMap | undefined {
  const s = dstream(d, 'ToUnicode')
  if (!s) return undefined
  try {
    return parseCMap(streamBytes(s))
  } catch {
    return undefined
  }
}

interface Descriptor {
  flags: number
  ascent?: number
  descent?: number
  missingWidth?: number
  file?: { bytes: Uint8Array; kind: 'FontFile' | 'FontFile2' | 'FontFile3'; subtype?: string }
}

function readDescriptor(d: PDFDict | undefined): Descriptor {
  const fd = ddict(d, 'FontDescriptor')
  const out: Descriptor = { flags: dnum(fd, 'Flags') ?? 0, ascent: dnum(fd, 'Ascent'), descent: dnum(fd, 'Descent'), missingWidth: dnum(fd, 'MissingWidth') }
  for (const kind of ['FontFile2', 'FontFile3', 'FontFile'] as const) {
    const s = dstream(fd, kind)
    if (!s) continue
    try {
      out.file = { bytes: streamBytes(s), kind, subtype: dname(s.dict, 'Subtype') }
    } catch {
      /* unreadable font program */
    }
    break
  }
  return out
}

function metrics(desc: Descriptor, std: Font | undefined): { ascent: number; descent: number } {
  let a = desc.ascent ? desc.ascent / 1000 : std ? Number(std.Ascender ?? 718) / 1000 : 0.8
  let d = desc.descent ? -Math.abs(desc.descent) / 1000 : std ? -Math.abs(Number(std.Descender ?? -207)) / 1000 : -0.2
  if (!(a >= 0.5 && a <= 1.3)) a = 0.8
  if (!(d <= -0.05 && d >= -0.6)) d = -0.2
  return { ascent: a, descent: d }
}

const stdCache = new Map<string, Font>()
function loadStd(name: FontNames): Font {
  let f = stdCache.get(name)
  if (!f) stdCache.set(name, (f = Font.load(name)))
  return f
}

function sfntOf(desc: Descriptor): Sfnt | undefined {
  const f = desc.file
  if (!f) return undefined
  if (f.kind === 'FontFile2' || (f.kind === 'FontFile3' && f.subtype === 'OpenType')) return readSfnt(f.bytes)
  return undefined
}

function inkFn(sfnt: Sfnt | undefined): (gid: number | undefined) => [number, number] | undefined {
  if (!sfnt) return () => undefined
  const upm = sfnt.unitsPerEm || 1000
  const memo = new Map<number, [number, number] | undefined>()
  return (gid) => {
    if (gid === undefined) return undefined
    if (memo.has(gid)) return memo.get(gid)
    const bb = sfnt.bbox(gid)
    const r: [number, number] | undefined = bb ? [bb[0] / upm, bb[2] / upm] : undefined
    memo.set(gid, r)
    return r
  }
}

/** Unicode from a glyph of the embedded font program: its Unicode cmap first, then its glyph name. */
function programUnicode(sfnt: Sfnt | undefined, gid: number | undefined): string | undefined {
  if (!sfnt || gid === undefined || gid === 0) return undefined
  const u = sfnt.unicodeOf(gid)
  if (u && u !== '�') return u
  const nm = sfnt.nameOf(gid)
  return nm ? unicodeForGlyphName(nm) : undefined
}

const clean = (s: string | undefined): string => (s ? normalizeGlyphText(s) : '')

// ---------------------------------------------------------------------------------------------------------
// simple fonts (Type1, TrueType, Type3, MMType1)

function loadSimple(d: PDFDict): TextFont {
  const subtype = dname(d, 'Subtype') ?? 'Type1'
  const baseFont = dname(d, 'BaseFont') ?? (subtype === 'Type3' ? 'Type3' : 'Unknown')
  const desc = readDescriptor(d)
  const std = standardFontFor(baseFont)
  const stdFont = std ? loadStd(std) : undefined
  const toUni = readToUnicode(d)
  const symbolic = (desc.flags & 4) !== 0 && (desc.flags & 32) === 0
  const sfnt = sfntOf(desc)

  // encoding table (code -> text) and glyph names
  const enc = dget(d, 'Encoding')
  let baseName: string | undefined
  let differences: PDFArray | undefined
  if (enc instanceof PDFName) baseName = nameText(enc)
  else if (enc instanceof PDFDict) {
    baseName = dname(enc, 'BaseEncoding')
    differences = darr(enc, 'Differences')
  }
  const known = baseName ? baseEncoding(baseName) : undefined
  let table: string[]
  if (known) table = [...known]
  else if (std === FontNames.Symbol || std === FontNames.ZapfDingbats) table = symbolEncoding(std === FontNames.Symbol ? 'Symbol' : 'ZapfDingbats')
  else if (symbolic && desc.file) table = new Array<string>(256).fill('')
  else if (subtype === 'TrueType') table = [...WIN_ANSI]
  else table = [...STANDARD]
  const names: (string | undefined)[] = new Array<string | undefined>(256).fill(undefined)
  if (differences) {
    let code = 0
    for (let i = 0; i < differences.size(); i++) {
      const o = differences.lookup(i)
      if (o instanceof PDFNumber) code = o.asNumber()
      else if (o instanceof PDFName) {
        if (code >= 0 && code < 256) {
          const g = nameText(o)
          names[code] = g
          table[code] = unicodeForGlyphName(g) ?? ''
        }
        code++
      }
    }
  }

  // code -> glyph id in the embedded TrueType program (PDF 1.7 §9.6.6.4)
  const gidOf = (code: number): number | undefined => {
    if (!sfnt) return undefined
    if (sfnt.hasCmap(3, 0)) return sfnt.lookup(3, 0, 0xf000 + code) ?? sfnt.lookup(3, 0, code)
    if (sfnt.hasCmap(1, 0) && (symbolic || !sfnt.hasCmap(3, 1))) return sfnt.lookup(1, 0, code)
    const t = table[code] || (names[code] ? unicodeForGlyphName(names[code]!) : undefined)
    if (t && sfnt.hasCmap(3, 1)) return sfnt.lookup(3, 1, t.codePointAt(0)!)
    return sfnt.lookup(1, 0, code)
  }

  // widths
  const firstChar = dnum(d, 'FirstChar') ?? 0
  const widths = numbers(darr(d, 'Widths'))
  let unitScale = 1 / 1000
  let vScale = 1
  let t3asc: number | undefined
  let t3desc: number | undefined
  if (subtype === 'Type3') {
    const fm = numbers(darr(d, 'FontMatrix'))
    if (fm.length === 6 && Number.isFinite(fm[0]) && fm[0] !== 0) unitScale = fm[0]
    else unitScale = 0.001
    vScale = fm.length === 6 && Number.isFinite(fm[3]) && fm[3] !== 0 ? fm[3] : 0.001
    const bb = numbers(darr(d, 'FontBBox'))
    if (bb.length === 4 && bb.every(Number.isFinite) && bb[3] > bb[1]) {
      t3asc = bb[3] * vScale
      t3desc = bb[1] * vScale
    }
  }
  const widthOf = (code: number): number => {
    const i = code - firstChar
    if (widths.length && i >= 0 && i < widths.length && Number.isFinite(widths[i])) return widths[i] * unitScale
    if (stdFont) {
      const g = names[code] ?? (table[code] ? glyphNameForChar(table[code]) : undefined)
      const w = g ? stdFont.getWidthOfGlyph(g) : undefined
      if (typeof w === 'number') return w / 1000
    }
    return (desc.missingWidth ?? 0) * unitScale
  }

  const memo = new Map<number, { text: string; known: boolean; gid: number | undefined }>()
  const textOf = (code: number): { text: string; known: boolean; gid: number | undefined } => {
    let r = memo.get(code)
    if (r) return r
    const gid = gidOf(code)
    let t: string | undefined
    if (toUni) t = cmapUnicode(toUni, code, 1) ?? cmapUnicode(toUni, code, 2)
    if (t === undefined || t === '') t = table[code] || undefined
    if (t === undefined && names[code]) t = unicodeForGlyphName(names[code]!)
    if (t === undefined) t = programUnicode(sfnt, gid)
    const text = clean(t)
    r = { text, known: t !== undefined && text !== '', gid }
    memo.set(code, r)
    return r
  }

  let ascent: number
  let descent: number
  if (subtype === 'Type3') {
    ascent = t3asc !== undefined && t3asc > 0.3 && t3asc < 1.5 ? t3asc : 0.8
    descent = t3desc !== undefined && t3desc < 0 && t3desc > -0.6 ? t3desc : -0.2
  } else ({ ascent, descent } = metrics(desc, stdFont))
  const ink = inkFn(sfnt)
  return {
    key: ++fontKeys,
    name: baseFont,
    vertical: false,
    type3: subtype === 'Type3',
    ascent,
    descent,
    decode(bytes) {
      const out: DecodedGlyph[] = []
      for (const code of bytes) {
        const t = textOf(code)
        out.push({ code, n: 1, text: t.text, known: t.known, w: widthOf(code), w1: -1, vx: 0, vy: 0, space: code === 32, gid: t.gid })
      }
      return out
    },
    ink
  }
}

// ---------------------------------------------------------------------------------------------------------
// Type0 (CID) fonts

const UNICODE_CMAP = /^Uni.*-(UCS2|UTF16)-[HV]$/

function loadType0(d: PDFDict): TextFont {
  const baseFont = dname(d, 'BaseFont') ?? 'Unknown'
  const cidRaw = darr(d, 'DescendantFonts')?.lookup(0)
  const cid = cidRaw instanceof PDFDict ? cidRaw : undefined
  const desc = readDescriptor(cid)
  const toUni = readToUnicode(d)
  const enc = dget(d, 'Encoding')
  let encName: string | undefined
  let encMap: CMap | undefined
  let problem: string | undefined
  if (enc instanceof PDFName) encName = nameText(enc)
  else if (enc instanceof PDFStream) {
    try {
      encMap = parseCMap(streamBytes(enc))
      if (encMap.useCMap) encName = encMap.useCMap
    } catch {
      problem = 'the font encoding could not be read'
    }
  }
  const identity = encName === undefined ? !encMap : /^Identity-[HV]$/.test(encName)
  const unicodeCMap = !!encName && UNICODE_CMAP.test(encName)
  const hasOwnCids = !!encMap && encMap.cidRanges.length + encMap.cidChars.size > 0
  const vertical = (encName ? /-V$/.test(encName) : false) || encMap?.wmode === 1
  // Unicode CMaps (Uni*-UCS2/UTF16) give the text directly; their CIDs (for widths) would need the predefined CMap, so
  // /DW is used for every glyph (right for most CJK text, which is what these CMaps are used for).
  if (!identity && !hasOwnCids && !unicodeCMap) problem = `the predefined character set ${encName ?? '(unknown)'} is not supported`
  const space: CodeSpaceRange[] = encMap && encMap.codespace.length ? encMap.codespace : unicodeCMap ? [{ n: 2, lo: 0, hi: 0xffff }] : toUni && toUni.codespace.length ? toUni.codespace : [{ n: 2, lo: 0, hi: 0xffff }]

  const cidOf = (code: number, n: number): number | undefined => {
    if (hasOwnCids) return cmapCid(encMap!, code, n)
    if (identity) return code
    return undefined
  }
  // CID -> GID for TrueType-based CID fonts
  let cidToGid: Uint8Array | undefined
  const map = cid ? dget(cid, 'CIDToGIDMap') : undefined
  if (map instanceof PDFStream) {
    try {
      cidToGid = streamBytes(map)
    } catch {
      /* identity */
    }
  }
  const sfnt = sfntOf(desc)
  const gidOf = (c: number | undefined): number | undefined => {
    if (c === undefined) return undefined
    if (cidToGid) return c * 2 + 1 < cidToGid.length ? (cidToGid[c * 2] << 8) | cidToGid[c * 2 + 1] : undefined
    return c
  }

  // widths (/W, /DW) and vertical metrics (/W2, /DW2)
  const dw = dnum(cid, 'DW') ?? 1000
  const wList = new Map<number, number>()
  const wRanges: { lo: number; hi: number; w: number }[] = []
  const wArr = darr(cid, 'W')
  if (wArr) {
    const items = [...Array(wArr.size()).keys()].map((i) => wArr.lookup(i))
    for (let i = 0; i < items.length; ) {
      const a = items[i]
      const b = items[i + 1]
      if (a instanceof PDFNumber && b instanceof PDFArray) {
        const c0 = a.asNumber()
        numbers(b).forEach((w, k) => wList.set(c0 + k, w))
        i += 2
      } else if (a instanceof PDFNumber && b instanceof PDFNumber && items[i + 2] instanceof PDFNumber) {
        wRanges.push({ lo: a.asNumber(), hi: b.asNumber(), w: (items[i + 2] as PDFNumber).asNumber() })
        i += 3
      } else i++
    }
  }
  const width = (c: number | undefined): number => {
    if (c === undefined) return dw / 1000
    const l = wList.get(c)
    if (l !== undefined && Number.isFinite(l)) return l / 1000
    for (const r of wRanges) if (c >= r.lo && c <= r.hi) return r.w / 1000
    return dw / 1000
  }
  const dw2 = numbers(darr(cid, 'DW2'))
  const defVy = dw2.length === 2 && Number.isFinite(dw2[0]) ? dw2[0] / 1000 : 0.88
  const defW1 = dw2.length === 2 && Number.isFinite(dw2[1]) ? dw2[1] / 1000 : -1
  const w2 = new Map<number, [number, number, number]>()
  const w2Arr = vertical ? darr(cid, 'W2') : undefined
  if (w2Arr) {
    const items = [...Array(w2Arr.size()).keys()].map((i) => w2Arr.lookup(i))
    for (let i = 0; i < items.length; ) {
      const a = items[i]
      const b = items[i + 1]
      if (a instanceof PDFNumber && b instanceof PDFArray) {
        const v = numbers(b)
        for (let k = 0; k + 2 < v.length; k += 3) w2.set(a.asNumber() + k / 3, [v[k] / 1000, v[k + 1] / 1000, v[k + 2] / 1000])
        i += 2
      } else if (a instanceof PDFNumber && b instanceof PDFNumber && items.length > i + 4) {
        const [w1, vx, vy] = [items[i + 2], items[i + 3], items[i + 4]].map((x) => (x instanceof PDFNumber ? x.asNumber() / 1000 : NaN))
        for (let c = a.asNumber(); c <= b.asNumber() && c - a.asNumber() < 65536; c++) w2.set(c, [w1, vx, vy])
        i += 5
      } else i++
    }
  }

  const memo = new Map<number, { text: string; known: boolean }>()
  const textOf = (code: number, n: number, gid: number | undefined): { text: string; known: boolean } => {
    const k = n * 0x100000000 + code
    let r = memo.get(k)
    if (r) return r
    let t: string | undefined
    if (toUni) t = cmapUnicode(toUni, code, n)
    if ((t === undefined || t === '') && unicodeCMap) t = n === 2 ? String.fromCharCode(code) : undefined
    if (t === undefined || t === '') t = programUnicode(sfnt, gid)
    const text = clean(t)
    r = { text, known: t !== undefined && text !== '' }
    memo.set(k, r)
    return r
  }
  const { ascent, descent } = metrics(desc, undefined)
  const ink = inkFn(sfnt)
  return {
    key: ++fontKeys,
    name: baseFont,
    vertical,
    type3: false,
    ascent,
    descent,
    problem: problem ?? (!toUni && !unicodeCMap && !sfnt ? 'the font has no Unicode mapping' : undefined),
    decode(bytes) {
      return splitCodes(bytes, space, 2).map(([code, n]) => {
        const c = cidOf(code, n)
        const gid = gidOf(c)
        const t = textOf(code, n, gid)
        const v = c !== undefined ? w2.get(c) : undefined
        const w = width(c)
        return {
          code,
          n,
          text: t.text,
          known: t.known,
          w,
          w1: v ? v[0] : defW1,
          vx: v ? v[1] : w / 2,
          vy: v ? v[2] : defVy,
          space: n === 1 && code === 32,
          gid
        }
      })
    },
    ink
  }
}
