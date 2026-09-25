import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream } from 'pdf-lib'
import { fontFromDict } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { parseContent } from '../../src/renderer/src/features/textedit/pdfcontent/content'

/**
 * Independent residue scanning for the redaction proof tests (unit and end to end). It knows nothing about the
 * redaction code: it looks for a secret in the literal, UTF-16BE, hex and glyph-code spellings, inside every
 * decompressed stream (object streams are already expanded by pdf-lib), every text string of every object, the
 * TJ pieces joined together, and the raw bytes of the file.
 */

const N = (s: string): PDFName => PDFName.of(s)

export function* allObjects(pdf: PDFDocument): Generator<[PDFRef, unknown]> {
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) yield [ref, obj]
}

export function decoded(s: PDFStream): Uint8Array | null {
  try {
    return s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : null
  } catch {
    return null
  }
}

export const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const utf16 = (s: string): Uint8Array => Uint8Array.from(Array.from(s).flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255]))
export const latin = (s: string): Uint8Array => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 255))

export function bytesIncludes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

/** Every spelling of `secret` we can think of: literal, UTF-16BE, hex of both, and the glyph codes of every font. */
export function spellings(pdf: PDFDocument, secret: string): { name: string; bytes: Uint8Array }[] {
  const out: { name: string; bytes: Uint8Array }[] = [
    { name: 'literal', bytes: latin(secret) },
    { name: 'utf16be', bytes: utf16(secret) },
    { name: 'hex', bytes: latin(hexOf(latin(secret))) },
    { name: 'hex-utf16', bytes: latin(hexOf(utf16(secret))) },
    { name: 'HEX', bytes: latin(hexOf(latin(secret)).toUpperCase()) }
  ]
  for (const [ref, obj] of allObjects(pdf)) {
    if (!(obj instanceof PDFDict) || obj.lookup(N('Type')) !== N('Font')) continue
    const font = fontFromDict(obj)
    const used = new Set<number>(Array.from({ length: 0x10000 }, (_, i) => i))
    const codes: number[][] = []
    let ok = true
    for (const ch of secret) {
      const c = font.encode(ch, used)
      if (!c) {
        ok = false
        break
      }
      codes.push(c)
    }
    if (!ok) continue
    const seq = Uint8Array.from(codes.flat())
    out.push({ name: `glyph codes of font ${ref.objectNumber}`, bytes: seq }, { name: `glyph codes (hex) of font ${ref.objectNumber}`, bytes: latin(hexOf(seq)) }, { name: `glyph codes (HEX) of font ${ref.objectNumber}`, bytes: latin(hexOf(seq).toUpperCase()) })
  }
  return out
}

/** Text-showing operand strings of a content stream, TJ pieces joined. */
export function shownStrings(bytes: Uint8Array): Uint8Array[] {
  let ops
  try {
    ops = parseContent(bytes).ops
  } catch {
    return []
  }
  const res: Uint8Array[] = []
  for (const op of ops) {
    if (op.op === 'TJ' && op.args[0]?.t === 'arr') {
      const parts = op.args[0].v.flatMap((x) => (x.t === 'str' ? [...x.b] : []))
      res.push(Uint8Array.from(parts))
    } else if (['Tj', "'", '"'].includes(op.op)) {
      const s = op.args[op.op === '"' ? 2 : 0]
      if (s?.t === 'str') res.push(s.b)
    }
  }
  return res
}

/** Where (if anywhere) `secret` still occurs: decompressed streams, joined show strings, object strings, raw bytes. */
export function residue(bytes: Uint8Array, pdf: PDFDocument, secret: string): string[] {
  const found: string[] = []
  const sp = spellings(pdf, secret)
  for (const { name, bytes: needle } of sp) if (bytesIncludes(bytes, needle) && name !== 'glyph codes of font') found.push(`raw file bytes: ${name}`)
  for (const [ref, obj] of allObjects(pdf)) {
    if (obj instanceof PDFStream) {
      const d = decoded(obj)
      if (!d) continue
      for (const { name, bytes: needle } of sp) {
        if (bytesIncludes(d, needle)) found.push(`stream ${ref.objectNumber}: ${name}`)
        for (const s of shownStrings(d)) if (bytesIncludes(s, needle)) found.push(`stream ${ref.objectNumber} (joined show strings): ${name}`)
      }
    }
    // strings inside dictionaries/arrays
    const visit = (o: unknown, depth = 0): void => {
      if (depth > 20) return
      if (o instanceof PDFStream) return visit(o.dict, depth + 1)
      if (o instanceof PDFString || o instanceof PDFHexString) {
        const b = o.asBytes()
        for (const { name, bytes: needle } of sp.slice(0, 2)) if (bytesIncludes(b, needle)) found.push(`string in object ${ref.objectNumber}: ${name}`)
      } else if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v, depth + 1)
      else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) visit(o.get(i), depth + 1)
    }
    visit(obj)
  }
  return found
}
