import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFObject
} from 'pdf-lib'
import type { PdfObj } from '../../textedit/pdfcontent/content'
import { bytesToLatin1 } from '../../textedit/pdfcontent/content'

/** Conversions between the content-stream object model (`PdfObj`) and pdf-lib objects. */

export function toPdfLib(ctx: PDFContext, o: PdfObj): PDFObject {
  switch (o.t) {
    case 'num':
      return PDFNumber.of(o.v)
    case 'bool':
      return o.v ? PDFBool.True : PDFBool.False
    case 'null':
      return PDFNull
    case 'name':
      return PDFName.of(o.v)
    case 'str':
      return PDFHexString.of(Array.from(o.b, (b) => b.toString(16).padStart(2, '0')).join(''))
    case 'arr':
      return ctx.obj(o.v.map((x) => toPdfLib(ctx, x)) as never)
    case 'dict': {
      const d = PDFDict.withContext(ctx)
      for (const [k, v] of o.v) d.set(PDFName.of(k), toPdfLib(ctx, v))
      return d
    }
  }
}

/** Simple (direct, stream-free) pdf-lib values as content-stream operands; anything else becomes undefined. */
export function fromPdfLib(ctx: PDFContext, o: PDFObject | undefined, depth = 0): PdfObj | undefined {
  if (!o || depth > 8) return undefined
  if (o instanceof PDFRef) return fromPdfLib(ctx, ctx.lookup(o), depth + 1)
  if (o instanceof PDFNumber) return { t: 'num', v: o.asNumber() }
  if (o instanceof PDFName) return { t: 'name', v: safeName(o) }
  if (o instanceof PDFBool) return { t: 'bool', v: o.asBoolean() }
  if (o === PDFNull) return { t: 'null' }
  if (o instanceof PDFString || o instanceof PDFHexString) return { t: 'str', b: o.asBytes(), hex: o instanceof PDFHexString }
  if (o instanceof PDFArray) {
    const v: PdfObj[] = []
    for (let i = 0; i < o.size(); i++) {
      const x = fromPdfLib(ctx, o.get(i), depth + 1)
      if (x) v.push(x)
    }
    return { t: 'arr', v }
  }
  if (o instanceof PDFDict && !(o instanceof PDFStream)) {
    const m = new Map<string, PdfObj>()
    for (const [k, v] of o.entries()) {
      const x = fromPdfLib(ctx, v, depth + 1)
      if (x) m.set(safeName(k), x)
    }
    return { t: 'dict', v: m }
  }
  return undefined
}

function safeName(n: PDFName): string {
  try {
    return n.decodeText()
  } catch {
    return n.asString().slice(1)
  }
}

/** PDF text string (PDFDocEncoding or UTF-16BE with BOM, also UTF-8 BOM) as JavaScript text. */
export function decodeTextString(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let s = ''
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] * 256 + b[i + 1])
    return s
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    let s = ''
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i + 1] * 256 + b[i])
    return s
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3))
  return bytesToLatin1(b)
}

/** JavaScript text as a PDF text string: Latin-1 when possible, otherwise UTF-16BE with BOM. */
export function encodeTextString(s: string): PDFHexString {
  let plain = true
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) plain = false
  const bytes: number[] = []
  if (plain) for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i))
  else {
    bytes.push(0xfe, 0xff)
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) >> 8, s.charCodeAt(i) & 0xff)
  }
  return PDFHexString.of(bytes.map((b) => b.toString(16).padStart(2, '0')).join(''))
}
