import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFObject
} from 'pdf-lib'

/** Tolerant accessors over pdf-lib objects: wrong or missing types give `undefined`, never exceptions. */

export const N = (s: string): PDFName => PDFName.of(s)

export function dget(d: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!d) return undefined
  try {
    return d.lookup(N(key))
  } catch {
    return undefined
  }
}

export function dnum(d: PDFDict | undefined, key: string): number | undefined {
  const o = dget(d, key)
  return o instanceof PDFNumber ? o.asNumber() : undefined
}

export function dname(d: PDFDict | undefined, key: string): string | undefined {
  const o = dget(d, key)
  return o instanceof PDFName ? nameText(o) : undefined
}

export function ddict(d: PDFDict | undefined, key: string): PDFDict | undefined {
  const o = dget(d, key)
  if (o instanceof PDFDict) return o
  return undefined
}

export function darr(d: PDFDict | undefined, key: string): PDFArray | undefined {
  const o = dget(d, key)
  return o instanceof PDFArray ? o : undefined
}

export function dstream(d: PDFDict | undefined, key: string): PDFStream | undefined {
  const o = dget(d, key)
  return o instanceof PDFStream ? o : undefined
}

export function nameText(n: PDFName): string {
  try {
    return n.decodeText()
  } catch {
    return n.asString().slice(1)
  }
}

/** Numbers of a PDF array (resolving references); non-numbers become NaN. */
export function numbers(a: PDFArray | undefined, ctxLookup = true): number[] {
  if (!a) return []
  const out: number[] = []
  for (let i = 0; i < a.size(); i++) {
    const o = ctxLookup ? a.lookup(i) : a.get(i)
    out.push(o instanceof PDFNumber ? o.asNumber() : NaN)
  }
  return out
}

/** Decoded bytes of a stream (Flate, LZW, ASCII85, ... via pdf-lib); throws for unsupported filters. */
export function streamBytes(s: PDFStream): Uint8Array {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode()
  const c = (s as unknown as { getContents(): Uint8Array }).getContents()
  return c
}

export const refTag = (r: PDFRef): string => `${r.objectNumber} ${r.generationNumber}`
