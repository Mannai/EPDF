/**
 * The characters used by one OCR run. Each distinct character gets a CID (1, 2, 3, ...), which is also its
 * glyph in the generated font; the ToUnicode CMap maps CIDs back to Unicode so text extraction, search and
 * copy work in any reader.
 */

// Helvetica advance widths (1000 units/em) for U+0020..U+007E: close enough to Latin text that selection
// highlights inside a word are proportioned naturally. The whole word is later stretched to the measured box.
const ASCII_WIDTHS =
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 ' +
  '1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 ' +
  '333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584'
const ASCII = ASCII_WIDTHS.split(' ').map(Number)

const inRanges = (cp: number, ranges: [number, number][]): boolean => ranges.some(([a, b]) => cp >= a && cp <= b)

const WIDE: [number, number][] = [
  [0x1100, 0x11ff], [0x2e80, 0x303f], [0x3040, 0x30ff], [0x3100, 0x312f], [0x3130, 0x318f], [0x3190, 0x31ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa960, 0xa97f], [0xac00, 0xd7ff], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3ffff]
]

/** Advance width (1000 units per em) used for a character. */
export function advanceOf(cp: number): number {
  if (cp >= 0x20 && cp <= 0x7e) return ASCII[cp - 0x20]
  if (cp === 0xa0) return 278
  if (inRanges(cp, WIDE)) return 1000
  if (cp >= 0x0600 && cp <= 0x06ff) return 500 // Arabic
  if (cp >= 0x0900 && cp <= 0x097f) return 550 // Devanagari
  if (cp >= 0x0370 && cp <= 0x04ff) return 600 // Greek, Cyrillic
  if (cp >= 0x0300 && cp <= 0x036f) return 0 // combining marks
  if (cp >= 0xa1 && cp <= 0x24f) {
    // Latin-1 supplement and Latin Extended: use the base letter of the decomposition when there is one.
    const base = String.fromCodePoint(cp).normalize('NFD').codePointAt(0) ?? cp
    if (base !== cp && base >= 0x20 && base <= 0x7e) return ASCII[base - 0x20]
    return 556
  }
  return 550
}

const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' }

/** Text as it is stored in the layer: ligature characters spelled out, control characters and spaces dropped. */
export function cleanWordText(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0xfffd || cp === 0xfeff || (cp >= 0xd800 && cp <= 0xdfff)) continue
    if (/\s/u.test(ch)) continue
    out += LIGATURES[ch] ?? ch
  }
  return out
}

const isRtl = (cp: number): boolean =>
  (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff) || (cp >= 0x10800 && cp <= 0x10fff) || (cp >= 0x1e800 && cp <= 0x1efff)
const isNumberish = (cp: number): boolean => (cp >= 0x30 && cp <= 0x39) || (cp >= 0x660 && cp <= 0x669) || (cp >= 0x6f0 && cp <= 0x6f9)

/**
 * Right-to-left words (Arabic, Hebrew, ...) are stored in visual order, the way real producers write them and
 * the way readers expect to find them: PDF.js, Acrobat and Chrome run the Unicode bidi algorithm over each text
 * run, which turns visual order back into logical order. Tesseract reports logical order. Runs of RTL letters
 * are reversed; digits and Latin letters inside the word keep their internal order.
 */
export function toVisualOrder(text: string): string {
  const chars = [...text]
  if (!chars.some((c) => isRtl(c.codePointAt(0)!))) return text
  const runs: { rtl: boolean; chars: string[] }[] = []
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!
    // digits and marks continue whatever run they are in; they are LTR inside an RTL word
    const rtl = isRtl(cp) && !isNumberish(cp)
    const cont = /\p{M}/u.test(ch)
    const last = runs[runs.length - 1]
    if (last && (cont || last.rtl === rtl)) last.chars.push(ch)
    else runs.push({ rtl, chars: [ch] })
  }
  return runs
    .reverse()
    .map((r) => (r.rtl ? r.chars.reverse().join('') : r.chars.join('')))
    .join('')
}

export class Charset {
  private cidOf = new Map<number, number>()
  private cps: number[] = []

  constructor() {
    this.add(0x20) // the space that separates words is always CID 1
  }

  add(cp: number): number {
    let cid = this.cidOf.get(cp)
    if (cid === undefined) {
      if (this.cps.length >= 65534) throw new Error('Too many distinct characters for one OCR font')
      cid = this.cps.length + 1
      this.cidOf.set(cp, cid)
      this.cps.push(cp)
    }
    return cid
  }

  addText(text: string): void {
    for (const ch of text) this.add(ch.codePointAt(0)!)
  }

  cid(cp: number): number {
    const c = this.cidOf.get(cp)
    if (c === undefined) throw new Error(`Character U+${cp.toString(16)} is not in the character set`)
    return c
  }

  get size(): number {
    return this.cps.length
  }

  /** Code points in CID order (index 0 = CID 1). */
  get codePoints(): readonly number[] {
    return this.cps
  }

  widths(): number[] {
    return this.cps.map(advanceOf)
  }

  /** Total advance of `text` at 1000 units/em. */
  advance(text: string): number {
    let sum = 0
    for (const ch of text) sum += advanceOf(ch.codePointAt(0)!)
    return sum
  }

  /** `<0001 0002>` style hex string for a text run. */
  hex(text: string): string {
    let out = ''
    for (const ch of text) out += this.cid(ch.codePointAt(0)!).toString(16).padStart(4, '0')
    return `<${out}>`
  }
}

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')

/** UTF-16BE hex of one code point (surrogate pair for characters beyond the BMP). */
export function utf16Hex(cp: number): string {
  if (cp < 0x10000) return hex4(cp)
  const v = cp - 0x10000
  return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff))
}

/** The ToUnicode CMap (PDF 32000-1 section 9.10.3) for a character set: CID n -> Unicode. */
export function buildToUnicode(cs: Charset): string {
  const lines: string[] = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange'
  ]
  const cps = cs.codePoints
  for (let i = 0; i < cps.length; i += 100) {
    const chunk = cps.slice(i, i + 100)
    lines.push(`${chunk.length} beginbfchar`)
    chunk.forEach((cp, j) => lines.push(`<${hex4(i + j + 1)}> <${utf16Hex(cp)}>`))
    lines.push('endbfchar')
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end')
  return lines.join('\n') + '\n'
}
