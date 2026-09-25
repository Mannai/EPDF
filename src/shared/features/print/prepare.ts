import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, type PDFObject } from 'pdf-lib'
import { applyPageSpecs, pruneUnreachable } from '../pages/pdfOps'
import { PAPER_SIZES, scaleFor, sheetFor, type Orientation, type Paper, type ScalingMode } from './options'

/**
 * Builds the "print-ready" PDF from the document's current bytes: only the pages to print, optionally
 * without annotations, optionally scaled onto a sheet. Works on a private copy (loaded from bytes), so
 * the open document is never touched. Everything stays vector: no rasterizing happens here.
 */

const N = (s: string): PDFName => PDFName.of(s)

/** True for annotations that are part of a form (they show field contents and belong on paper). */
const isWidget = (d: PDFDict): boolean => d.lookupMaybe(N('Subtype'), PDFName)?.decodeText() === 'Widget'

/**
 * Removes annotations (comments, highlights, stamps, links...) from every page of a temporary copy. Form
 * widgets are kept: they carry the values a filled-in form is printed with. Returns how many were removed.
 */
export function stripAnnotations(pdf: PDFDocument): number {
  let removed = 0
  for (const page of pdf.getPages()) {
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray)
    if (!annots) continue
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i)
      if (a instanceof PDFDict && isWidget(a)) continue
      annots.remove(i)
      removed++
    }
    if (annots.size() === 0) page.node.delete(N('Annots'))
  }
  if (removed > 0) pruneUnreachable(pdf)
  return removed
}

const numbers = (arr: PDFArray | undefined): number[] | undefined => {
  if (!arr) return undefined
  const out: number[] = []
  for (let i = 0; i < arr.size(); i++) {
    const n = arr.lookupMaybe(i, PDFNumber)
    if (!n) return undefined
    out.push(n.asNumber())
  }
  return out.length === 4 ? out : undefined
}

export interface ScaleOptions {
  scaling: ScalingMode
  percent: number
  paper: Paper
  orientation: Orientation
}

/**
 * Scales every page's content onto its sheet, centred (a page larger than the sheet is cropped evenly).
 * With `paper: 'source'` a page keeps its own size; "fit"/"actual" then leave it unchanged and a custom
 * percentage resizes the page itself. Annotations are moved and scaled with the content (their
 * appearance streams stretch to the new /Rect), and /Rotate is left alone.
 */
export function scalePages(pdf: PDFDocument, opts: ScaleOptions): void {
  const ctx = pdf.context
  for (const page of pdf.getPages()) {
    const leaf = page.node
    const media = numbers(leaf.lookupMaybe(N('MediaBox'), PDFArray)) ?? [0, 0, 612, 792]
    const crop = numbers(leaf.lookupMaybe(N('CropBox'), PDFArray))
    const [x0, y0, x1, y1] = crop
      ? [Math.max(media[0], crop[0]), Math.max(media[1], crop[1]), Math.min(media[2], crop[2]), Math.min(media[3], crop[3])]
      : media
    const bw = Math.abs(x1 - x0)
    const bh = Math.abs(y1 - y0)
    const rot = ((page.getRotation().angle % 360) + 360) % 360
    const swap = rot === 90 || rot === 270
    const shown = { width: swap ? bh : bw, height: swap ? bw : bh }

    const fixed = sheetFor(opts.paper, opts.orientation, shown)
    const s = scaleFor(opts.scaling, opts.percent, shown, fixed ?? shown)
    const sheet = fixed ?? { width: shown.width * (opts.scaling === 'custom' ? s : 1), height: shown.height * (opts.scaling === 'custom' ? s : 1) }
    if (!fixed && s === 1) continue // nothing to do for this page
    // Work in unrotated page space: the sheet's unrotated size, then centre the scaled box in it.
    const sheetU = swap ? { width: sheet.height, height: sheet.width } : sheet
    const tx = (sheetU.width - s * bw) / 2 - s * Math.min(x0, x1)
    const ty = (sheetU.height - s * bh) / 2 - s * Math.min(y0, y1)
    const clip = `${Math.min(x0, x1)} ${Math.min(y0, y1)} ${bw} ${bh} re W n`
    const pre = ctx.register(ctx.stream(`q ${s} 0 0 ${s} ${tx} ${ty} cm ${clip}\n`))
    const post = ctx.register(ctx.stream('\nQ'))
    const existing = leaf.get(N('Contents'))
    const contents = ctx.obj([pre]) as PDFArray
    const existingObj: PDFObject | undefined = existing instanceof PDFRef ? ctx.lookup(existing) : existing
    if (existingObj instanceof PDFArray) for (let i = 0; i < existingObj.size(); i++) contents.push(existingObj.get(i))
    else if (existing) contents.push(existing)
    contents.push(post)
    leaf.set(N('Contents'), contents)

    leaf.set(N('MediaBox'), ctx.obj([0, 0, sheetU.width, sheetU.height]))
    for (const k of ['CropBox', 'TrimBox', 'BleedBox', 'ArtBox']) leaf.delete(N(k))
    leaf.set(N('Rotate'), PDFNumber.of(rot))

    const annots = leaf.lookupMaybe(N('Annots'), PDFArray)
    for (let i = 0; annots && i < annots.size(); i++) {
      const a = annots.lookup(i)
      if (!(a instanceof PDFDict)) continue
      const r = numbers(a.lookupMaybe(N('Rect'), PDFArray))
      if (!r) continue
      const xs = [r[0] * s + tx, r[2] * s + tx]
      const ys = [r[1] * s + ty, r[3] * s + ty]
      a.set(N('Rect'), ctx.obj([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]))
    }
  }
}

export interface PrepareOptions {
  /** 0-based pages to keep, in output order. */
  pages: number[]
  annotations: boolean
  scale?: ScaleOptions
}

export async function preparePrintPdf(bytes: Uint8Array, opts: PrepareOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const identity = opts.pages.length === pdf.getPageCount() && opts.pages.every((p, i) => p === i)
  if (!identity) await applyPageSpecs(pdf, opts.pages.map((index) => ({ kind: 'orig', index })))
  if (!opts.annotations) stripAnnotations(pdf)
  if (opts.scale) scalePages(pdf, opts.scale)
  return pdf.save()
}

export { PAPER_SIZES }
