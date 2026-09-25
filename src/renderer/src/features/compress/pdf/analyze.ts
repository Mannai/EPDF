import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFContext, type PDFDocument } from 'pdf-lib'
import { loadForCompression } from './compress'
import { reachable, trailerRoots } from './graph'
import { describeImage, downsampleTarget } from './images'
import { subsettableFontBytes } from './fonts'
import { convertInlineImages } from './inline'
import { sanitizeOptions, type CompressOptions } from './options'
import { scanImageUsage } from './scan'
import { computeAliases, pageContentRefs, unreachableBytes } from './structure'
import { N, encodedBytes, filterNames, nameOf, refKey, resolve } from './streams'
import { estimateJpegQuality, parseJpegInfo } from './jpegInfo'


/** A quick, read-only look at a document: where its bytes are, so the dialog can estimate savings before running anything. */

export interface ImageFact {
  bytes: number
  w: number
  h: number
  ncomp: number
  coding: 'jpeg' | 'flate' | 'other'
  mono: boolean
  soft: boolean
  /** Resolution at the largest placement (pixels per inch); null when unknown. */
  dpiX: number | null
  dpiY: number | null
  /** Estimated JPEG quality for JPEG images. */
  quality: number
  lossy: boolean
}

export interface Analysis {
  fileBytes: number
  pages: number
  objects: number
  images: ImageFact[]
  imageBytes: number
  /** Non-image stream bytes stored without compression. */
  rawStreamBytes: number
  /** Non-image stream bytes stored with Flate. */
  flateStreamBytes: number
  xmpBytes: number
  thumbnailBytes: number
  pieceInfoBytes: number
  unreachable: { objects: number; bytes: number }
  /** Objects that are exact copies of another one (`imageBytes` = the part of `bytes` that is image data). */
  duplicates: { objects: number; bytes: number; imageBytes: number }
  looseObjects: number
  signed: boolean
  hasJavaScript: boolean
  inlineImages: number
  /** Embedded TrueType font programs large enough to be worth trimming. */
  fontBytes: number
}

export function analyzeDocument(pdf: PDFDocument, fileBytes: number): Analysis {
  const ctx = pdf.context
  convertInlineImages(pdf) // the loaded copy is thrown away; large inline images then count as images, as they will when reducing
  const { root, info } = trailerRoots(ctx)
  const list = reachable(ctx, [root, info])
  const images: ImageFact[] = []
  const smasks = new Set<string>()
  let hasImages = false
  for (const { obj } of list) {
    if (obj instanceof PDFStream && nameOf(ctx, obj.dict.get(N('Subtype'))) === 'Image') {
      hasImages = true
      const sm = obj.dict.get(N('SMask'))
      if (sm instanceof PDFRef) smasks.add(refKey(sm))
    }
  }
  // Text-only documents have nothing to measure: skip parsing every content stream.
  const scan = hasImages ? scanImageUsage(pdf) : { uses: new Map(), unknown: new Set<string>(), truncated: false, inlineImages: 0 }
  let imageBytes = 0
  let raw = 0
  let flate = 0
  let xmp = 0
  let thumbs = 0
  let piece = 0
  let js = false
  let signed = false
  let loose = 0
  for (const { ref, obj } of list) {
    if (!(obj instanceof PDFStream)) {
      loose++
      if (obj instanceof PDFDict) {
        if (nameOf(ctx, obj.get(N('S'))) === 'JavaScript') js = true
        if (obj.has(N('ByteRange')) || nameOf(ctx, obj.get(N('Type'))) === 'Sig') signed = true
      }
      continue
    }
    const d = obj.dict
    if (nameOf(ctx, d.get(N('S'))) === 'JavaScript') js = true
    if (d.has(N('ByteRange'))) signed = true
    const len = encodedBytes(obj).length
    const type = nameOf(ctx, d.get(N('Type')))
    if (type === 'Metadata') {
      xmp += len
      continue
    }
    if (nameOf(ctx, d.get(N('Subtype'))) === 'Image') {
      const desc = describeImage(ctx, obj)
      imageBytes += len
      if (!desc) continue
      const k = refKey(ref)
      const use = scan.truncated || scan.unknown.has(k) ? null : (scan.uses.get(k) ?? null)
      const coding = desc.filters.length === 1 && desc.filters[0] === 'DCTDecode' ? 'jpeg' : desc.filters.length === 1 && desc.filters[0] === 'FlateDecode' ? 'flate' : desc.filters.length === 0 ? 'flate' : 'other'
      const info2 = coding === 'jpeg' ? parseJpegInfo(encodedBytes(obj)) : null
      const soft = smasks.has(k)
      images.push({
        bytes: len,
        w: desc.w,
        h: desc.h,
        ncomp: desc.cs?.kind === 'indexed' ? (desc.cs.base?.ncomp ?? 3) : (desc.cs?.ncomp ?? 1),
        coding,
        mono: desc.isMask || (desc.bpc === 1 && desc.cs?.kind === 'gray'),
        soft,
        dpiX: use?.dpiX ?? null,
        dpiY: use?.dpiY ?? null,
        quality: info2 ? estimateJpegQuality(info2.quant0) : 100,
        lossy: !soft && !desc.colorKey && (desc.cs?.kind === 'gray' || desc.cs?.kind === 'rgb' || desc.cs?.kind === 'cmyk')
      })
      continue
    }
    const f = filterNames(ctx, d)
    if (f.length === 0) raw += len
    else flate += len
  }
  // Thumbnails and piece-info are found on dictionaries (they may hang off objects outside `list` after stripping).
  for (const { obj } of list) {
    const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null
    if (!d) continue
    const th = resolve(ctx, d.get(N('Thumb')))
    if (th instanceof PDFStream) thumbs += encodedBytes(th).length
    if (d.has(N('PieceInfo'))) piece += approxSize(ctx, d.get(N('PieceInfo')))
  }
  const dedupe = computeAliases(ctx, list, pageContentRefs(ctx, pdf))
  let dupImages = 0
  for (const [k] of dedupe.alias) {
    const [n, g] = k.split(' ').map(Number)
    const o = ctx.lookup(PDFRef.of(n, g))
    if (o instanceof PDFStream && nameOf(ctx, o.dict.get(N('Subtype'))) === 'Image') dupImages += encodedBytes(o).length
  }
  const un = unreachableBytes(ctx, [root, info])
  return {
    fileBytes,
    pages: pdf.getPageCount(),
    objects: ctx.enumerateIndirectObjects().length,
    images,
    imageBytes,
    rawStreamBytes: raw,
    flateStreamBytes: flate,
    xmpBytes: xmp,
    thumbnailBytes: thumbs,
    pieceInfoBytes: piece,
    unreachable: { objects: un.count, bytes: un.bytes },
    duplicates: { objects: dedupe.report.merged, bytes: dedupe.report.savedBytes, imageBytes: dupImages },
    looseObjects: loose,
    signed,
    hasJavaScript: js,
    inlineImages: scan.inlineImages,
    fontBytes: subsettableFontBytes(pdf)
  }
}

function approxSize(ctx: PDFContext, o: unknown, depth = 0): number {
  const v = resolve(ctx, o as never)
  if (depth > 6) return 0
  if (v instanceof PDFStream) return encodedBytes(v).length
  if (v instanceof PDFDict) {
    let n = 20
    for (const [, x] of v.entries()) n += approxSize(ctx, x, depth + 1)
    return n
  }
  if (v instanceof PDFArray) {
    let n = 4
    for (const x of v.asArray()) n += approxSize(ctx, x, depth + 1)
    return n
  }
  return 8
}

export async function analyzePdf(input: Uint8Array): Promise<Analysis> {
  const pdf = await loadForCompression(input)
  return analyzeDocument(pdf, input.length)
}

// ---------------------------------------------------------------------------------------------------------
// Estimate

/** Typical JPEG size in bits per pixel at a quality setting, for photographs with 3 colour components at 4:2:0. */
const BPP_TABLE: [number, number][] = [
  [10, 0.3],
  [30, 0.5],
  [50, 0.7],
  [70, 0.98],
  [85, 1.5],
  [95, 2.8],
  [100, 5]
]

export function jpegBitsPerPixel(quality: number, ncomp: number): number {
  const q = Math.min(100, Math.max(10, quality))
  let bpp = BPP_TABLE[BPP_TABLE.length - 1][1]
  for (let i = 1; i < BPP_TABLE.length; i++) {
    if (q <= BPP_TABLE[i][0]) {
      const [q0, b0] = BPP_TABLE[i - 1]
      const [q1, b1] = BPP_TABLE[i]
      bpp = b0 + ((b1 - b0) * (q - q0)) / (q1 - q0)
      break
    }
  }
  return bpp * (ncomp === 1 ? 0.55 : ncomp === 4 ? 1.3 : 1)
}

export interface Estimate {
  bytes: number
  imageBytes: number
  otherBytes: number
}

/** Predicts the size after compression. Deliberately rough: the dialog labels it as an estimate and shows the real size after a run. */
export function estimateSize(a: Analysis, optsIn: Partial<CompressOptions>): Estimate {
  const o = sanitizeOptions(optsIn)
  let imgAfter = 0
  for (const im of a.images) {
    let est = im.bytes
    if (o.images && im.bytes >= o.minImageBytes) {
      const pixels = im.w * im.h
      const maxDpi = im.mono ? o.monoDpi : o.colorDpi
      const target =
        im.dpiX !== null && im.dpiY !== null
          ? downsampleTarget({ w: im.w, h: im.h } as never, { dpiX: im.dpiX, dpiY: im.dpiY, placements: 1 }, maxDpi, o.downsampleFactor)
          : null
      const newPixels = target ? target.nw * target.nh : pixels
      const ratio = newPixels / pixels
      if (im.mono) {
        if (target) est = Math.max(200, im.bytes * ratio * 1.05)
      } else if (im.coding === 'jpeg') {
        const wantRequant = im.lossy && o.recompressJpeg && im.quality >= o.jpegQuality + 8
        if (im.lossy && (target || wantRequant)) {
          // Scale the image's own bit rate by how much a lower quality saves; a reduced image is denser (x1.1).
          const srcBpp = (im.bytes * 8) / pixels
          const q = jpegBitsPerPixel(o.jpegQuality, im.ncomp) / jpegBitsPerPixel(Math.max(im.quality, o.jpegQuality), im.ncomp)
          est = Math.min(im.bytes, (newPixels * srcBpp * q * (target ? 1.1 : 1)) / 8)
        }
      } else if (im.coding === 'flate') {
        // Flate data that barely compresses is a photograph: it becomes a JPEG. Graphics stay Flate.
        const rawBytes = pixels * im.ncomp
        const photo = im.lossy && im.bytes > rawBytes * 0.3
        if (photo) est = Math.min(im.bytes, (newPixels * jpegBitsPerPixel(o.jpegQuality, im.ncomp)) / 8)
        else if (target) est = Math.min(im.bytes, im.bytes * ratio * 1.15)
      }
    }
    imgAfter += est
  }
  let other = a.fileBytes - a.imageBytes
  if (o.recompressStreams) other -= a.rawStreamBytes * 0.6 + a.flateStreamBytes * 0.03
  if (o.objectStreams) other -= a.looseObjects * 12
  if (o.dedupe) {
    // Duplicate images vanish after being reduced like their original, so scale their saving the same way.
    imgAfter -= a.duplicates.imageBytes * (a.imageBytes > 0 ? imgAfter / a.imageBytes : 1)
    other -= a.duplicates.bytes - a.duplicates.imageBytes
  }
  other -= a.unreachable.bytes
  if (o.subsetFonts) other -= a.fontBytes * 0.8 // a full font program shrinks to a fraction once only the used glyphs remain
  if (o.stripMetadata) other -= a.xmpBytes
  if (o.stripThumbnails) other -= a.thumbnailBytes
  if (o.stripPieceInfo) other -= a.pieceInfoBytes
  other = Math.max(other, 200)
  const bytes = Math.round(Math.min(a.fileBytes, imgAfter + other))
  return { bytes, imageBytes: Math.round(imgAfter), otherBytes: Math.round(other) }
}
