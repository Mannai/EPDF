import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, decodePDFRawStream, type PDFDocument, type PDFPage } from 'pdf-lib'
import { parseToUnicode } from '../../src/shared/text/pdf/tounicode'

/** Helpers to look inside PDFs written by the text engine (tests only). */

export function contentOf(pdf: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents()
  const parts: string[] = []
  const push = (obj: unknown): void => {
    const o = obj instanceof PDFRef ? pdf.context.lookup(obj) : obj
    if (o instanceof PDFRawStream) parts.push(new TextDecoder('latin1').decode(decodePDFRawStream(o).decode()))
    else if (o && typeof (o as { getContentsString?: () => string }).getContentsString === 'function') parts.push((o as { getContentsString: () => string }).getContentsString())
  }
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) push(contents.get(i))
  else if (contents) push(contents)
  return parts.join('\n')
}

export function fontDicts(pdf: PDFDocument, res: PDFDict | undefined): Map<string, PDFDict> {
  const out = new Map<string, PDFDict>()
  const fonts = res?.lookup(PDFName.of('Font'))
  if (fonts instanceof PDFDict) for (const [k, v] of fonts.entries()) out.set(k.asString().slice(1), pdf.context.lookup(v, PDFDict))
  return out
}

export function streamBytes(pdf: PDFDocument, ref: unknown): Uint8Array {
  const s = ref instanceof PDFRef ? pdf.context.lookup(ref) : ref
  if (!(s instanceof PDFRawStream)) throw new Error('not a stream')
  return decodePDFRawStream(s).decode()
}

export interface FontParts {
  type0: PDFDict
  cid: PDFDict
  descriptor: PDFDict
  program: Uint8Array
  programKey: 'FontFile2' | 'FontFile3'
  toUnicode: Map<number, string>
}

export function fontParts(pdf: PDFDocument, type0: PDFDict): FontParts {
  const desc = pdf.context.lookup((type0.get(PDFName.of('DescendantFonts')) as PDFArray).get(0), PDFDict)
  const fd = pdf.context.lookup(desc.get(PDFName.of('FontDescriptor')), PDFDict)
  const key = fd.has(PDFName.of('FontFile2')) ? 'FontFile2' : 'FontFile3'
  return {
    type0,
    cid: desc,
    descriptor: fd,
    program: streamBytes(pdf, fd.get(PDFName.of(key))),
    programKey: key,
    toUnicode: parseToUnicode(new TextDecoder().decode(streamBytes(pdf, type0.get(PDFName.of('ToUnicode')))))
  }
}

/** The 2-byte codes shown by every TJ/Tj in `content`, in stream order. */
export function shownCodes(content: string): number[] {
  const out: number[] = []
  for (const m of content.matchAll(/<([0-9A-F]+)>/g)) {
    const h = m[1]!
    if (h.startsWith('FEFF') && h.length > 4) continue // ActualText payloads are not shown text
    for (let i = 0; i < h.length; i += 4) out.push(parseInt(h.slice(i, i + 4), 16))
  }
  return out
}

/** ActualText spans (decoded) in stream order. */
export function actualTexts(content: string): string[] {
  const out: string[] = []
  for (const m of content.matchAll(/\/ActualText <FEFF([0-9A-F]*)>/g)) {
    const h = m[1]!
    let s = ''
    for (let i = 0; i < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16))
    out.push(s)
  }
  return out
}
