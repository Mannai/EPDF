import { PDFDict, PDFRef, PDFStream, type PDFDocument } from 'pdf-lib'
import { analyzePage, refCountsFor, type ImageItem, type PageAnalysis } from './analyze'
import { mkOp, num, name as nameObj, type Op } from './content'
import { det, invert, mul, type Matrix, type Rect } from './matrix'
import { N, dget, refTag } from './pdfutil'
import { EditRefusedError, PlanSet, addResource, commitSources, slotOf } from './write'

/**
 * Image editing on the page content: move/resize (edit the `cm` in front of the image so nothing else is
 * affected), delete, replace and add. All pure pdf-lib + content-stream operations.
 */

export interface Picture {
  kind: 'png' | 'jpg'
  bytes: Uint8Array
}

export interface ImageEditInfo {
  message: string
}

const refuse = (m: string): EditRefusedError => new EditRefusedError(m)
const MIN_SIZE = 1

function locate(pdf: PDFDocument, pageIndex: number, id: string): { analysis: PageAnalysis; image: ImageItem; op: Op; slotIndex: number } {
  let analysis: PageAnalysis
  try {
    analysis = analyzePage(pdf, pageIndex)
  } catch (e) {
    throw refuse(`This page's content could not be read safely, so nothing was changed (${e instanceof Error ? e.message : String(e)}).`)
  }
  const image = analysis.images.find((i) => i.id === id)
  if (!image) throw refuse('That image is no longer on the page. Select it again.')
  if (image.shared) throw refuse('This image is part of a shared element (a form drawn more than once), so changing it would change every copy.')
  const slot = slotOf(analysis, image.addr.source, image.addr.slot)
  const op = slot.ops[image.addr.index]
  const ok = image.kind === 'inline' ? op?.op === 'BI' : op?.op === 'Do' && op.args[0]?.t === 'name' && op.args[0].v === image.name
  if (!op || !ok) throw refuse('The page content changed. Select the image again.')
  return { analysis, image, op, slotIndex: image.addr.index }
}

/** `q <cm> Do Q` wrapper around the image operation at `index`, if it is exactly that shape. */
function wrapperOf(ops: Op[], index: number): { cm: Op } | null {
  const q = ops[index - 2]
  const cm = ops[index - 1]
  const Q = ops[index + 1]
  if (q?.op === 'q' && cm?.op === 'cm' && cm.args.length === 6 && cm.args.every((a) => a.t === 'num') && Q?.op === 'Q') return { cm }
  return null
}

const args6 = (op: Op): Matrix => op.args.map((a) => (a.t === 'num' ? a.v : NaN)) as Matrix

/** User-space transform A that maps the old bounding box onto the new one. */
export function boxMap(old: Rect, next: Rect): Matrix {
  const w = old.x1 - old.x0
  const h = old.y1 - old.y0
  if (!(w > 0 && h > 0)) throw refuse('The image has no size on the page.')
  const sx = (next.x1 - next.x0) / w
  const sy = (next.y1 - next.y0) / h
  return [sx, 0, 0, sy, next.x0 - old.x0 * sx, next.y0 - old.y0 * sy]
}

const rightAngled = (m: readonly number[]): boolean => {
  const eps = 1e-6 * (Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3]) + 1)
  return (Math.abs(m[1]) < eps && Math.abs(m[2]) < eps) || (Math.abs(m[0]) < eps && Math.abs(m[3]) < eps)
}

/** Move and/or resize: the new bounding box in user space. Resizing needs an axis-aligned (90°-multiple) image. */
export function transformImage(pdf: PDFDocument, pageIndex: number, id: string, box: Rect): ImageEditInfo {
  const { analysis, image, op, slotIndex } = locate(pdf, pageIndex, id)
  if (![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) throw refuse('The new position is not valid.')
  if (box.x1 - box.x0 < MIN_SIZE || box.y1 - box.y0 < MIN_SIZE) throw refuse('The image would become too small.')
  const A = boxMap(image.bbox, box)
  const resizing = Math.abs(A[0] - 1) > 1e-9 || Math.abs(A[3] - 1) > 1e-9
  if (resizing && !rightAngled(image.ctm)) throw refuse('This image is rotated or skewed at an angle, so it can be moved but not resized.')
  const C = image.ctm
  const slot = slotOf(analysis, image.addr.source, image.addr.slot)
  const plans = new PlanSet()
  const wrap = wrapperOf(slot.ops, slotIndex)
  if (wrap) {
    const K = args6(wrap.cm)
    const Kinv = invert(K)
    if (!Kinv) throw refuse('The image sits in a degenerate coordinate system.')
    const C0 = mul(Kinv, C)
    const C0inv = invert(C0)
    if (!C0inv) throw refuse('The image sits in a degenerate coordinate system.')
    const K2 = mul(mul(C, A), C0inv)
    plans.replace(slot, slotIndex - 1, [mkOp('cm', ...K2.map(num))])
  } else {
    const Cinv = invert(C)
    if (!Cinv) throw refuse('The image sits in a degenerate coordinate system.')
    const M = mul(mul(C, A), Cinv)
    plans.replace(slot, slotIndex, [mkOp('q'), mkOp('cm', ...M.map(num)), op, mkOp('Q')])
  }
  plans.apply()
  commitSources(pdf, analysis)
  return { message: resizing ? 'Image resized' : 'Image moved' }
}

// ---------------------------------------------------------------------------------------------------------
// Delete

function privateDict(owner: PDFDict | undefined, key: string, counts: Map<string, number>): PDFDict | undefined {
  const raw = owner?.get(N(key))
  if (!raw) return undefined
  if (raw instanceof PDFRef) {
    if ((counts.get(refTag(raw)) ?? 0) > 1) return undefined
    const d = owner!.context.lookup(raw)
    return d instanceof PDFDict ? d : undefined
  }
  return raw instanceof PDFDict ? raw : undefined
}

/** Removes the image object (and its masks) when nothing else can reach it. Returns whether data was dropped. */
function dropUnusedImage(pdf: PDFDocument, analysis: PageAnalysis, image: ImageItem): boolean {
  if (image.kind !== 'xobject' || !image.ref || !image.name) return false
  const src = analysis.sources.get(image.addr.source)!
  const stillUsed = src.slots.some((sl) => sl.ops.some((o) => o.op === 'Do' && o.args[0]?.t === 'name' && o.args[0].v === image.name))
  if (stillUsed) return false
  const counts = refCountsFor(pdf.context)
  if ((counts.get(refTag(image.ref)) ?? 0) !== 1) return false
  const owner: PDFDict | undefined = src.kind === 'page' ? pdf.getPage(analysis.pageIndex).node : src.slots[0].stream?.dict
  const resDict = privateDict(owner, 'Resources', counts)
  const xo = privateDict(resDict, 'XObject', counts)
  if (!xo || xo.get(N(image.name)) !== image.ref) return false
  const obj = pdf.context.lookup(image.ref)
  xo.delete(N(image.name))
  const own = src.resourcesOverride?.lookup(N('XObject'))
  if (own instanceof PDFDict) own.delete(N(image.name))
  if (obj instanceof PDFStream) {
    for (const k of ['SMask', 'Mask']) {
      const m = dget(obj.dict, k)
      const raw = obj.dict.get(N(k))
      if (m instanceof PDFStream && raw instanceof PDFRef && (counts.get(refTag(raw)) ?? 0) === 1) pdf.context.delete(raw)
    }
  }
  pdf.context.delete(image.ref)
  return true
}

export function deleteImage(pdf: PDFDocument, pageIndex: number, id: string): ImageEditInfo {
  const { analysis, image, slotIndex } = locate(pdf, pageIndex, id)
  const slot = slotOf(analysis, image.addr.source, image.addr.slot)
  const plans = new PlanSet()
  const wrap = wrapperOf(slot.ops, slotIndex)
  if (wrap) for (const i of [slotIndex - 2, slotIndex - 1, slotIndex, slotIndex + 1]) plans.replace(slot, i, [])
  else plans.replace(slot, slotIndex, [])
  plans.apply()
  const dropped = dropUnusedImage(pdf, analysis, image)
  commitSources(pdf, analysis)
  return { message: dropped ? 'Image deleted' : 'Image removed from the page' }
}

// ---------------------------------------------------------------------------------------------------------
// Replace and add

async function embed(pdf: PDFDocument, pic: Picture): Promise<{ ref: PDFRef; width: number; height: number }> {
  try {
    const img = pic.kind === 'png' ? await pdf.embedPng(pic.bytes) : await pdf.embedJpg(pic.bytes)
    return { ref: img.ref, width: img.width, height: img.height }
  } catch (e) {
    throw refuse(`This ${pic.kind === 'png' ? 'PNG' : 'JPEG'} file could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was changed.`)
  }
}

/** Unit-square placement of an image with pixel aspect `ai` inside a box of user-space aspect `ab`. */
export function fitPlacement(ai: number, ab: number, mode: 'fit' | 'fill'): { ew: number; eh: number; ex: number; ey: number } {
  let ew: number
  let eh: number
  if (mode === 'fit') {
    if (ai > ab) {
      ew = 1
      eh = ab / ai
    } else {
      eh = 1
      ew = ai / ab
    }
  } else if (ai > ab) {
    eh = 1
    ew = ai / ab
  } else {
    ew = 1
    eh = ab / ai
  }
  return { ew, eh, ex: (1 - ew) / 2, ey: (1 - eh) / 2 }
}

export async function replaceImage(pdf: PDFDocument, pageIndex: number, id: string, pic: Picture, mode: 'fit' | 'fill'): Promise<ImageEditInfo> {
  const { analysis, image, slotIndex } = locate(pdf, pageIndex, id)
  const src = analysis.sources.get(image.addr.source)!
  const slot = slotOf(analysis, image.addr.source, image.addr.slot)
  const C = image.ctm
  const bw = Math.hypot(C[0], C[1])
  const bh = Math.hypot(C[2], C[3])
  if (!(bw > 0 && bh > 0)) throw refuse('The image has no size on the page.')
  const emb = await embed(pdf, pic)
  const { ew, eh, ex, ey } = fitPlacement(emb.width / emb.height, bw / bh, mode)
  const flip = det(C) < 0
  const name = addResource(pdf, src, 'XObject', 'EpdfIm', emb.ref)
  const ops: Op[] = [mkOp('q')]
  if (mode === 'fill') ops.push(mkOp('re', num(0), num(0), num(1), num(1)), mkOp('W'), mkOp('n'))
  ops.push(flip ? mkOp('cm', num(ew), num(0), num(0), num(-eh), num(ex), num(ey + eh)) : mkOp('cm', num(ew), num(0), num(0), num(eh), num(ex), num(ey)))
  ops.push(mkOp('Do', nameObj(name)), mkOp('Q'))
  const plans = new PlanSet()
  plans.replace(slot, slotIndex, ops)
  plans.apply()
  dropUnusedImage(pdf, analysis, image)
  commitSources(pdf, analysis)
  return { message: mode === 'fit' ? 'Image replaced (fitted inside the same box)' : 'Image replaced (filling the same box)' }
}

/**
 * Adds an image whose unit square is mapped to user space by `placement` (rows: a b c d e f).
 * The new content is appended as its own stream, after closing any unbalanced `q` of the page content.
 */
export async function addImage(pdf: PDFDocument, pageIndex: number, pic: Picture, placement: Matrix): Promise<ImageEditInfo> {
  if (!placement.every(Number.isFinite) || Math.abs(det(placement)) < 1e-9) throw refuse('The image would have no size.')
  let analysis: PageAnalysis
  try {
    analysis = analyzePage(pdf, pageIndex)
  } catch (e) {
    throw refuse(`This page's content could not be read safely, so nothing was changed (${e instanceof Error ? e.message : String(e)}).`)
  }
  const src = analysis.sources.get('page')!
  const emb = await embed(pdf, pic)
  const name = addResource(pdf, src, 'XObject', 'EpdfIm', emb.ref)
  const ops: Op[] = []
  for (let i = 0; i < analysis.endDepth; i++) ops.push(mkOp('Q'))
  ops.push(mkOp('q'), mkOp('cm', ...placement.map(num)), mkOp('Do', nameObj(name)), mkOp('Q'))
  src.slots.push({ ops, tail: new Uint8Array(0), dirty: true })
  commitSources(pdf, analysis)
  return { message: 'Image added' }
}

/** Placement matrix for an image of `w`×`h` pixels centred at (cx, cy), at most `maxSide` points on its long side. */
export function centeredPlacement(w: number, h: number, cx: number, cy: number, maxSide: number): Matrix {
  const k = Math.min(1, maxSide / Math.max(w, h))
  const pw = w * k
  const ph = h * k
  return [pw, 0, 0, ph, cx - pw / 2, cy - ph / 2]
}
