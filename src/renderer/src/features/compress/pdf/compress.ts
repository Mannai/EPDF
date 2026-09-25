import { PDFDict, PDFDocument, PDFRef, PDFStream, type PDFContext } from 'pdf-lib'
import type { ImageCodec } from './codec'
import { reachable, trailerRoots } from './graph'
import { describeImage, optimizeImage, type ImageRole } from './images'
import { subsetFonts } from './fonts'
import { convertInlineImages } from './inline'
import { sanitizeOptions, type CompressOptions } from './options'
import { scanImageUsage } from './scan'
import { applyStrips, computeAliases, pageContentRefs, redeflateStreams, unreachableBytes, type StripReport } from './structure'
import { N, nameOf, refKey } from './streams'
import { writePdf } from './writer'

export interface CompressStats {
  originalSize: number
  newSize: number
  pages: number
  objectsBefore: number
  objectsAfter: number
  images: {
    total: number
    replaced: number
    downsampled: number
    jpeg: number
    flate: number
    bytesBefore: number
    bytesAfter: number
    /** Large inline images turned into image objects so they could be reduced like any other. */
    inlineConverted: number
    skipped: Record<string, number>
  }
  streams: { redeflated: number; savedBytes: number }
  /** Fully embedded TrueType fonts found, and how many were trimmed to the glyphs in use. */
  fonts: { candidates: number; subsetted: number; savedBytes: number }
  dedupe: { merged: number; savedBytes: number }
  unreachable: { objects: number; bytes: number }
  strips: StripReport
}

export interface CompressResult {
  /** The compressed file, or the untouched input when `kept` is 'original'. */
  bytes: Uint8Array
  kept: 'result' | 'original'
  /** Why the original was kept (only then). */
  reason?: string
  stats: CompressStats
}

export interface CompressDeps {
  codec: ImageCodec
  /** fraction 0..1 and a short label. */
  onProgress?: (fraction: number, label: string) => void
  /** Called between units of work so a host can stay responsive / check for cancellation (throw to abort). */
  yieldNow?: () => Promise<void>
}

export class CompressError extends Error {}

const emptyStats = (size: number): CompressStats => ({
  originalSize: size,
  newSize: size,
  pages: 0,
  objectsBefore: 0,
  objectsAfter: 0,
  images: { total: 0, replaced: 0, downsampled: 0, jpeg: 0, flate: 0, bytesBefore: 0, bytesAfter: 0, inlineConverted: 0, skipped: {} },
  streams: { redeflated: 0, savedBytes: 0 },
  fonts: { candidates: 0, subsetted: 0, savedBytes: 0 },
  dedupe: { merged: 0, savedBytes: 0 },
  unreachable: { objects: 0, bytes: 0 },
  strips: { metadata: 0, thumbnails: 0, pieceInfo: 0, javascript: 0, destinations: 0, extras: 0, infoRemoved: false }
})

export async function loadForCompression(input: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: false })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/encrypt/i.test(msg)) throw new CompressError('This document is password protected. Unlock it first.')
    throw new CompressError(`This document could not be read: ${msg}`)
  }
}

/** Streams that are images among the reachable objects, with their role (soft masks are handled differently). */
function imageList(ctx: PDFContext, list: ReturnType<typeof reachable>): { ref: PDFRef; st: PDFStream; role: ImageRole }[] {
  const smasks = new Set<string>()
  const images: { ref: PDFRef; st: PDFStream }[] = []
  for (const { ref, obj } of list) {
    if (!(obj instanceof PDFStream) || nameOf(ctx, obj.dict.get(N('Subtype'))) !== 'Image') continue
    images.push({ ref, st: obj })
    const sm = obj.dict.get(N('SMask'))
    if (sm instanceof PDFRef) smasks.add(refKey(sm))
  }
  return images.map((i) => ({ ...i, role: smasks.has(refKey(i.ref)) ? 'smask' : 'image' }))
}

/**
 * The whole "Reduce File Size" pipeline on PDF bytes. Pure: no DOM, no pdf.js. Guarantees: the result is never larger than
 * the input (the input is returned untouched otherwise), and it is reloaded and checked before being handed back.
 */
export async function compressPdf(input: Uint8Array, optionsIn: Partial<CompressOptions>, deps: CompressDeps): Promise<CompressResult> {
  const opts = sanitizeOptions(optionsIn)
  const progress = deps.onProgress ?? (() => undefined)
  const stats = emptyStats(input.length)

  progress(0, 'Reading the document')
  const pdf = await loadForCompression(input)
  const ctx = pdf.context
  stats.pages = pdf.getPageCount()
  stats.objectsBefore = ctx.enumerateIndirectObjects().length
  await deps.yieldNow?.()

  progress(0.08, 'Applying removals')
  stats.strips = applyStrips(pdf, opts)
  // A direct (not indirect) Info dictionary would be lost by a writer that follows references: give it an object number.
  if (ctx.trailerInfo.Info instanceof PDFDict) ctx.trailerInfo.Info = ctx.register(ctx.trailerInfo.Info)
  const { root, info } = trailerRoots(ctx)
  let reach = reachable(ctx, [root, info])

  // ---- images ----
  const doneImages = new Set<string>()
  if (opts.images) {
    progress(0.1, 'Looking for inline images')
    stats.images.inlineConverted = convertInlineImages(pdf)
    reach = reachable(ctx, [root, info])
    const imgs = imageList(ctx, reach)
    stats.images.total = imgs.length
    progress(0.12, 'Measuring image resolution')
    // Text-only documents have nothing to measure: skip parsing every content stream.
    const scan = imgs.length ? scanImageUsage(pdf) : { uses: new Map(), unknown: new Set<string>(), truncated: false, inlineImages: 0 }
    const smaskWithMatte = new Set<string>()
    for (const i of imgs) if (i.role === 'smask' && i.st.dict.has(N('Matte'))) smaskWithMatte.add(refKey(i.ref))
    for (let k = 0; k < imgs.length; k++) {
      const { ref, st, role } = imgs[k]
      progress(0.15 + (0.6 * k) / Math.max(1, imgs.length), `Compressing image ${k + 1} of ${imgs.length}`)
      const key = refKey(ref)
      const desc = describeImage(ctx, st)
      if (!desc) continue
      const skipTo = (why: string): void => void (stats.images.skipped[why] = (stats.images.skipped[why] ?? 0) + 1)
      if (desc.smaskRef && smaskWithMatte.has(refKey(desc.smaskRef))) {
        skipTo('matte')
        continue
      }
      const use = scan.truncated || scan.unknown.has(key) ? null : (scan.uses.get(key) ?? null)
      const out = await optimizeImage(ctx, st, desc, use, role, opts, deps.codec)
      if (out.kind === 'skipped') {
        skipTo(out.reason.startsWith('error') ? 'error' : out.reason)
        continue
      }
      ctx.assign(ref, out.stream)
      doneImages.add(key)
      stats.images.replaced++
      if (out.downsampled) stats.images.downsampled++
      if (out.coding === 'jpeg') stats.images.jpeg++
      else stats.images.flate++
      stats.images.bytesBefore += out.before
      stats.images.bytesAfter += out.after
      await deps.yieldNow?.()
    }
  }

  // ---- fonts ----
  if (opts.subsetFonts) {
    progress(0.74, 'Trimming fonts')
    const f = subsetFonts(pdf)
    stats.fonts = { candidates: f.candidates, subsetted: f.subsetted, savedBytes: f.savedBytes }
    for (const k of f.replaced) doneImages.add(k) // already stored at maximum compression
    await deps.yieldNow?.()
  }

  // ---- streams ----
  if (opts.recompressStreams) {
    progress(0.76, 'Compressing data')
    const list = reachable(ctx, [root, info])
    const rep = await redeflateStreams(ctx, list, doneImages, (d, t) => progress(0.76 + (0.12 * d) / Math.max(1, t), 'Compressing data'), deps.yieldNow)
    stats.streams = { redeflated: rep.streams, savedBytes: rep.savedBytes }
  }

  // ---- dedupe ----
  let alias
  if (opts.dedupe) {
    progress(0.89, 'Merging duplicates')
    const list = reachable(ctx, [root, info])
    const r = computeAliases(ctx, list, pageContentRefs(ctx, pdf))
    alias = r.alias
    stats.dedupe = r.report
  }
  const un = unreachableBytes(ctx, [root, info])
  stats.unreachable = { objects: un.count, bytes: un.bytes }

  // ---- write ----
  progress(0.92, 'Writing the file')
  await deps.yieldNow?.()
  let written
  try {
    written = writePdf(ctx, { objectStreams: opts.objectStreams, alias })
  } catch (err) {
    throw new CompressError(`Could not write the reduced file: ${err instanceof Error ? err.message : String(err)}`)
  }
  stats.objectsAfter = written.objects
  stats.newSize = written.bytes.length

  // ---- verify ----
  progress(0.96, 'Checking the result')
  await deps.yieldNow?.()
  if (written.bytes.length >= input.length) {
    stats.newSize = input.length
    return { bytes: input, kept: 'original', reason: 'This document is already as small as it can be made with these settings.', stats }
  }
  try {
    const check = await PDFDocument.load(written.bytes, { updateMetadata: false })
    if (check.getPageCount() !== stats.pages) throw new Error(`page count changed (${stats.pages} to ${check.getPageCount()})`)
  } catch (err) {
    stats.newSize = input.length
    return { bytes: input, kept: 'original', reason: `The reduced file failed its safety check (${err instanceof Error ? err.message : String(err)}), so the original was kept.`, stats }
  }
  progress(1, 'Done')
  return { bytes: written.bytes, kept: 'result', stats }
}
