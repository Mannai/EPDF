import { zlibSync } from 'fflate'
import { PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState, rgb } from 'pdf-lib'
import { encodeJpeg } from '../../src/renderer/src/features/compress/pdf/jpegEncode'

/** Deterministic pseudo-random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A photograph-like RGB raster: smooth gradients, blobs and sensor noise (thousands of distinct colours, compresses like a photo). */
export function photoRGB(w: number, h: number, seed = 1, noise = 10): Uint8Array {
  const r = rng(seed)
  const out = new Uint8Array(w * h * 3)
  const blobs = Array.from({ length: 6 }, () => ({ x: r() * w, y: r() * h, rad: (0.1 + r() * 0.25) * Math.max(w, h), c: [r() * 255, r() * 255, r() * 255] }))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      let cr = (x / w) * 200 + 20
      let cg = (y / h) * 180 + 30
      let cb = ((x + y) / (w + h)) * 150 + 50
      for (const b of blobs) {
        const d = Math.hypot(x - b.x, y - b.y) / b.rad
        if (d < 1) {
          const k = (1 - d) * (1 - d)
          cr += (b.c[0] - cr) * k
          cg += (b.c[1] - cg) * k
          cb += (b.c[2] - cb) * k
        }
      }
      const n = (r() - 0.5) * noise * 2
      out[i] = Math.max(0, Math.min(255, Math.round(cr + n)))
      out[i + 1] = Math.max(0, Math.min(255, Math.round(cg + n)))
      out[i + 2] = Math.max(0, Math.min(255, Math.round(cb + n)))
    }
  }
  return out
}

export const grayFromRgb = (rgbData: Uint8Array): Uint8Array => {
  const out = new Uint8Array(rgbData.length / 3)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * rgbData[i * 3] + 0.587 * rgbData[i * 3 + 1] + 0.114 * rgbData[i * 3 + 2])
  return out
}

export interface RawImageSpec {
  w: number
  h: number
  /** Interleaved samples (8 bit) or packed rows when bpc < 8. */
  data: Uint8Array
  cs: unknown
  bpc?: number
  flate?: boolean
  extra?: Record<string, unknown>
  decodeParms?: unknown
}

/** Registers an image XObject. Flate by default. */
export function addRawImage(doc: PDFDocument, spec: RawImageSpec): PDFRef {
  const ctx = doc.context
  const flate = spec.flate ?? true
  const bytes = flate ? zlibSync(spec.data) : spec.data
  const dict: Record<string, unknown> = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: spec.w,
    Height: spec.h,
    ColorSpace: spec.cs,
    BitsPerComponent: spec.bpc ?? 8,
    ...(flate ? { Filter: 'FlateDecode' } : {}),
    ...(spec.decodeParms ? { DecodeParms: spec.decodeParms } : {}),
    ...(spec.extra ?? {})
  }
  return ctx.register(ctx.stream(bytes, dict as never))
}

export function addJpegImage(doc: PDFDocument, w: number, h: number, ncomp: 1 | 3 | 4, jpeg: Uint8Array, cs: unknown, extra: Record<string, unknown> = {}): PDFRef {
  const ctx = doc.context
  return ctx.register(
    ctx.stream(jpeg, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: cs, BitsPerComponent: 8, Filter: 'DCTDecode', ...extra } as never)
  )
}

export function jpegOf(rgbData: Uint8Array, w: number, h: number, ncomp: 1 | 3 | 4, quality: number): Uint8Array {
  return encodeJpeg(w, h, ncomp, rgbData, { quality })
}

let counter = 0
/** Draws image `ref` on `page` with the matrix [a b c d e f] (unit square mapped into page space). */
export function placeImage(page: ReturnType<PDFDocument['addPage']>, ref: PDFRef, m: [number, number, number, number, number, number]): string {
  const name = `Im${++counter}`
  const key = page.node.newXObject(name, ref)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(key), popGraphicsState())
  return name
}

/** Places the image `wPt` x `hPt` points at (x, y), unrotated. */
export const placeAt = (page: ReturnType<PDFDocument['addPage']>, ref: PDFRef, x: number, y: number, wPt: number, hPt: number): string =>
  placeImage(page, ref, [wPt, 0, 0, hPt, x, y])

export async function baseDoc(): Promise<{ doc: PDFDocument; page: ReturnType<PDFDocument['addPage']> }> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.drawText('Compression sample text', { x: 40, y: 750, size: 18, font, color: rgb(0, 0, 0) })
  return { doc, page }
}

export const N = (s: string): PDFName => PDFName.of(s)

/** Streams of a document that are images: [ref, dict]. */
export function imagesOf(doc: PDFDocument): { ref: PDFRef; dict: PDFDict }[] {
  const out: { ref: PDFRef; dict: PDFDict }[] = []
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const d = (obj as { dict?: PDFDict }).dict
    if (d && d.get(N('Subtype')) === N('Image')) out.push({ ref, dict: d })
  }
  return out
}
