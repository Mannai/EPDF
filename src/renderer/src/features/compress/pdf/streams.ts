import { unzlibSync, zlibSync } from 'fflate'
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFContext, type PDFObject } from 'pdf-lib'
import { undoPredictor, type PredictorParams } from './raster'

/** Stream helpers shared by the image, structure and scanning code. All of them are tolerant: bad input gives `null`, not exceptions. */

export const N = (s: string): PDFName => PDFName.of(s)

const ABBREV: Record<string, string> = {
  Fl: 'FlateDecode',
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode'
}

export const refKey = (r: PDFRef): string => `${r.objectNumber} ${r.generationNumber}`

export function resolve(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  let cur = o
  for (let i = 0; i < 16 && cur instanceof PDFRef; i++) cur = ctx.lookup(cur)
  return cur
}

export function numOf(ctx: PDFContext, o: PDFObject | undefined): number | undefined {
  const v = resolve(ctx, o)
  return v instanceof PDFNumber ? v.asNumber() : undefined
}

export function nameOf(ctx: PDFContext, o: PDFObject | undefined): string | undefined {
  const v = resolve(ctx, o)
  if (!(v instanceof PDFName)) return undefined
  try {
    return v.decodeText()
  } catch {
    return v.asString().slice(1)
  }
}

/** Numbers of an array (resolving references); null if it is not an array of numbers. */
export function numArray(ctx: PDFContext, o: PDFObject | undefined): number[] | null {
  const a = resolve(ctx, o)
  if (!(a instanceof PDFArray)) return null
  const out: number[] = []
  for (let i = 0; i < a.size(); i++) {
    const n = numOf(ctx, a.get(i))
    if (n === undefined) return null
    out.push(n)
  }
  return out
}

/** Filter names of a stream dictionary, abbreviations expanded. */
export function filterNames(ctx: PDFContext, dict: PDFDict): string[] {
  const f = resolve(ctx, dict.get(N('Filter')) ?? dict.get(N('F')))
  const list: string[] = []
  const push = (o: PDFObject | undefined): void => {
    const n = nameOf(ctx, o)
    if (n) list.push(ABBREV[n] ?? n)
  }
  if (f instanceof PDFArray) for (let i = 0; i < f.size(); i++) push(f.get(i))
  else push(f)
  return list
}

/** DecodeParms entries aligned with `filterNames` (undefined where absent). */
export function decodeParms(ctx: PDFContext, dict: PDFDict): (PDFDict | undefined)[] {
  const p = resolve(ctx, dict.get(N('DecodeParms')) ?? dict.get(N('DP')))
  const asDict = (o: PDFObject | undefined): PDFDict | undefined => {
    const r = resolve(ctx, o)
    return r instanceof PDFDict ? r : undefined
  }
  if (p instanceof PDFArray) return Array.from({ length: p.size() }, (_, i) => asDict(p.get(i)))
  return [asDict(p)]
}

/** The encoded bytes of a stream as stored in the file. */
export function encodedBytes(s: PDFStream): Uint8Array {
  return s instanceof PDFRawStream ? s.contents : (s as unknown as { getContents(): Uint8Array }).getContents()
}

export function predictorOf(ctx: PDFContext, parms: PDFDict | undefined, fallbackColors = 1, fallbackBpc = 8, fallbackColumns = 1): PredictorParams {
  return {
    predictor: numOf(ctx, parms?.get(N('Predictor'))) ?? 1,
    colors: numOf(ctx, parms?.get(N('Colors'))) ?? fallbackColors,
    bpc: numOf(ctx, parms?.get(N('BitsPerComponent'))) ?? fallbackBpc,
    columns: numOf(ctx, parms?.get(N('Columns'))) ?? fallbackColumns
  }
}

const IMAGE_CODECS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode', 'Crypt'])

/** True if the stream's filters include an image codec (or anything that cannot be reversed to raw bytes in-house). */
export const hasImageCodec = (filters: string[]): boolean => filters.some((f) => IMAGE_CODECS.has(f))

/**
 * Fully decodes a stream to raw bytes (all filters, predictors undone). Returns null if a filter is an image codec or the
 * data is damaged. Flate goes through `fflate` (fast); older filters through pdf-lib.
 */
export function decodeStream(ctx: PDFContext, s: PDFStream): Uint8Array | null {
  const filters = filterNames(ctx, s.dict)
  const raw = encodedBytes(s)
  if (filters.length === 0) return raw
  if (hasImageCodec(filters)) return null
  try {
    if (filters.length === 1 && filters[0] === 'FlateDecode') {
      let out: Uint8Array
      try {
        out = unzlibSync(raw)
      } catch {
        if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode()
        return null
      }
      const parms = decodeParms(ctx, s.dict)[0]
      const pp = predictorOf(ctx, parms)
      if (pp.predictor > 1) return undoPredictor(out, pp)
      return out
    }
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode()
  } catch {
    /* fall through */
  }
  return null
}

/** Best-effort deflate at maximum effort. */
export const deflateMax = (data: Uint8Array): Uint8Array => zlibSync(data, { level: 9, mem: 12 })

export function newStream(ctx: PDFContext, entries: [string, PDFObject | number | string | boolean | null][], bytes: Uint8Array): PDFRawStream {
  const dict = ctx.obj({}) as PDFDict
  for (const [k, v] of entries) dict.set(N(k), v !== null && typeof v === 'object' ? v : (ctx.obj(v as never) as PDFObject))
  dict.set(N('Length'), PDFNumber.of(bytes.length))
  return PDFRawStream.of(dict, bytes)
}
