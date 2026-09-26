import { PDFHexString, PDFString, type PDFObject } from 'pdf-lib'

/**
 * PDF "text strings" (bookmark titles, annotation contents, ...): PDFDocEncoding or UTF-16 (with a BOM),
 * plus UTF-8 with a BOM (PDF 2.0). Pure TypeScript on top of pdf-lib's string objects, so it runs in Node.
 *
 * Writing picks PDFDocEncoding when every character is representable (the most compatible form, and what
 * other readers expect for plain Latin text) and UTF-16BE with a BOM otherwise. Reading accepts every form.
 */

/** PDFDocEncoding bytes 0x18-0x1F and 0x80-0xA0 that differ from Latin-1 (PDF 32000-1, Annex D). */
const SPECIAL: Record<number, number> = {
  0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
  0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
  0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
  0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac
}
const REVERSE = new Map<number, number>(Object.entries(SPECIAL).map(([b, u]) => [u, Number(b)]))

const REPLACEMENT = 0xfffd

/** The Unicode code point of a PDFDocEncoding byte (undefined bytes map to U+FFFD). */
export function pdfDocToCodePoint(b: number): number {
  if (b in SPECIAL) return SPECIAL[b]
  if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) return b
  if (b >= 0xa1 && b <= 0xff && b !== 0xad) return b
  return REPLACEMENT // 0x00-0x17 (other than TAB/LF/CR), 0x7F, 0x9F, 0xAD
}

/** The PDFDocEncoding byte for a code point, or -1 when it cannot be represented. */
function codePointToPdfDoc(cp: number): number {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0x7e)) return cp
  const special = REVERSE.get(cp)
  if (special !== undefined) return special
  if (cp >= 0xa1 && cp <= 0xff && cp !== 0xad) return cp
  return -1
}

const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff

/** Replaces unpaired UTF-16 surrogates with U+FFFD (they cannot be encoded in any PDF text string). */
export function replaceLoneSurrogates(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i)
    if (isHigh(u) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      out += s[i] + s[i + 1]
      i++
    } else if (isHigh(u) || isLow(u)) out += '�'
    else out += s[i]
  }
  return out
}

export const MAX_TITLE_LENGTH = 1000

const cc = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join('')
/** Tab, CR, LF and the Unicode line/paragraph separators (built from code points so the source stays plain ASCII). */
const LINE_BREAKS = new RegExp(`[${cc(0x09, 0x0a, 0x0d, 0x2028, 0x2029)}]+`, 'g')
/** C0/C1 controls and the U+FFFE/U+FFFF non-characters. Bidi controls (U+200B..U+200F, U+202A..U+202E, U+2066..U+2069) are kept. */
const CONTROLS = new RegExp(`[${cc(0x00)}-${cc(0x1f)}${cc(0x7f)}-${cc(0x9f)}${cc(0xfffe, 0xffff)}]`, 'g')

/**
 * Makes user-entered text safe for a single-line PDF text string (bookmark title, link description):
 * line breaks and tabs become spaces, other control characters and non-characters are dropped, lone
 * surrogates become U+FFFD, and the length is capped. Combining marks, bidi controls and emoji are kept.
 */
export function sanitizeTitle(input: string, max = MAX_TITLE_LENGTH): string {
  let s = replaceLoneSurrogates(input)
  s = s.replace(LINE_BREAKS, ' ')
  s = s.replace(CONTROLS, '')
  if (s.length > max) {
    let cut = s.slice(0, max)
    if (isHigh(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1) // never split a surrogate pair
    s = cut
  }
  return s
}

function utf16beBytes(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2)
  out[0] = 0xfe
  out[1] = 0xff
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i)
    out[2 + i * 2] = u >> 8
    out[3 + i * 2] = u & 0xff
  }
  return out
}

/** The bytes of a PDF text string for `text`: PDFDocEncoding if possible, else UTF-16BE with a BOM. */
export function encodePdfText(text: string): { bytes: Uint8Array; encoding: 'pdfdoc' | 'utf16be' } {
  const s = replaceLoneSurrogates(text)
  const bytes: number[] = []
  let ok = true
  for (const ch of s) {
    const b = codePointToPdfDoc(ch.codePointAt(0)!)
    if (b < 0) {
      ok = false
      break
    }
    bytes.push(b)
  }
  return ok ? { bytes: Uint8Array.from(bytes), encoding: 'pdfdoc' } : { bytes: utf16beBytes(s), encoding: 'utf16be' }
}

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0').toUpperCase()
  return out
}

/** A PDF string object holding `text` (hex-string form, so every byte value is safe). */
export function pdfTextString(text: string): PDFHexString {
  return PDFHexString.of(toHex(encodePdfText(text).bytes))
}

/** A PDF literal string for a 7-bit ASCII value (e.g. a URI): `( ) \` and line breaks are escaped. */
export function asciiLiteral(value: string): PDFString {
  return PDFString.of(value.replace(/[\\()]/g, (c) => `\\${c}`).replace(/\r/g, '\\r').replace(/\n/g, '\\n'))
}

function decodeUtf16(bytes: Uint8Array, start: number, littleEndian: boolean): string {
  const units: number[] = []
  for (let i = start; i + 1 < bytes.length; i += 2) units.push(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1])
  // PDF 1.7 language escape sequences: U+001B, a language code (and optional country code), U+001B.
  const clean: number[] = []
  for (let i = 0; i < units.length; i++) {
    if (units[i] === 0x1b) {
      let j = i + 1
      while (j < units.length && units[j] !== 0x1b && j - i <= 6) j++
      if (j < units.length && units[j] === 0x1b) {
        i = j
        continue
      }
    }
    clean.push(units[i])
  }
  let out = ''
  for (let i = 0; i < clean.length; i++) {
    const u = clean[i]
    if (isHigh(u) && i + 1 < clean.length && isLow(clean[i + 1])) {
      out += String.fromCharCode(u, clean[i + 1])
      i++
    } else if (isHigh(u) || isLow(u)) out += '�'
    else out += String.fromCharCode(u)
  }
  return out
}

/** Decodes the bytes of a PDF text string: UTF-16BE/LE with BOM, UTF-8 with BOM, or PDFDocEncoding. */
export function decodePdfText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes, 2, false)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes, 2, true)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  let out = ''
  for (const b of bytes) out += String.fromCodePoint(pdfDocToCodePoint(b))
  return out
}

/** Text of a PDF string object (literal or hex); undefined for anything else. Never throws. */
export function readPdfText(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      return decodePdfText(obj.asBytes())
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The raw bytes of a string object as a Latin-1 string (for ASCII values such as URIs). */
export function readAsciiString(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      let out = ''
      for (const b of obj.asBytes()) out += String.fromCharCode(b)
      return out
    } catch {
      return undefined
    }
  }
  return undefined
}
