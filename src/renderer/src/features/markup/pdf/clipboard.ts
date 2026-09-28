import { PDFDict, PDFDocument, PDFName, PDFObjectCopier, PDFString, type PDFRef } from 'pdf-lib'
import { addAnnotToPage, locate, refId } from './annots'
import { formatPdfDate, isOurName, newAnnotName } from './basics'
import { geomOfPage, type Rect } from './geometry'
import { getNumbers } from './pdfobj'
import { moveAnnotation } from './ops'

/**
 * Copy and paste of placed items (shapes, stamps, text boxes, notes, drawings, Fill & sign text/marks/signatures):
 * the copied annotation, with everything it references (its appearance stream, images, fonts), is kept in a small
 * document of its own, so it survives edits to, or closing of, the document it came from, and can be pasted into any
 * open document. Replies, pop-ups and the page link are not copied: a pasted item starts its own thread.
 */
export interface AnnotClip {
  holder: PDFDocument
  ref: PDFRef
  /** Where it was, in the source page's PDF space. */
  rect: Rect
  subtype: string
}

// Links to things outside the annotation itself.
const DETACH = ['P', 'Popup', 'IRT', 'RT', 'Parent', 'StructParent', 'OC']

export async function copyAnnotation(pdf: PDFDocument, id: string): Promise<AnnotClip> {
  const loc = locate(pdf, id)
  if (!loc) throw new Error('The item no longer exists.')
  const rect = getNumbers(loc.dict, 'Rect')
  if (!rect || rect.length < 4) throw new Error('This item has no position.')
  const subtype = loc.dict.get(PDFName.of('Subtype'))?.toString().replace(/^\//, '') ?? ''
  if (subtype === 'Popup' || subtype === 'Link' || subtype === 'Widget') throw new Error('This item cannot be copied.')
  await pdf.flush() // pictures and fonts embedded since loading are only written out now
  const holder = await PDFDocument.create()
  const d = loc.dict.clone()
  for (const k of DETACH) d.delete(PDFName.of(k))
  const copy = PDFObjectCopier.for(pdf.context, holder.context).copy(d) as PDFDict
  return { holder, ref: holder.context.register(copy), rect: rect.slice(0, 4) as Rect, subtype }
}

/**
 * Adds a copy of `clip` to page `pageIndex`, moved by (dx, dy) in PDF space and kept on the page. Returns the new
 * item's id. The copy gets its own name and dates; one of Epdf's items stays one of Epdf's (so it can be restyled).
 */
export function pasteAnnotation(pdf: PDFDocument, pageIndex: number, clip: AnnotClip, dx: number, dy: number, now = new Date()): string {
  const page = pdf.getPages()[pageIndex]
  if (!page) throw new Error(`Page ${pageIndex + 1} does not exist.`)
  const src = clip.holder.context.lookup(clip.ref, PDFDict)
  const d = PDFObjectCopier.for(clip.holder.context, pdf.context).copy(src) as PDFDict
  const name = d.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText()
  const date = PDFString.of(formatPdfDate(now))
  d.set(PDFName.of('P'), page.ref)
  d.set(PDFName.of('NM'), PDFString.of(isOurName(name) || !name ? newAnnotName() : `${name}-copy-${Date.now().toString(36)}`))
  d.set(PDFName.of('M'), date)
  d.set(PDFName.of('CreationDate'), date)
  const ref = pdf.context.register(d)
  addAnnotToPage(pdf, page, ref)
  const id = refId(ref)
  const [mx, my] = keepOnPage(clip.rect, dx, dy, geomOfPage(page).box)
  if (mx || my) moveAnnotation(pdf, id, mx, my, { now })
  return id
}

/** The offset, reduced where needed so the moved rect stays inside `box` (when it fits at all). */
export function keepOnPage(rect: Rect, dx: number, dy: number, box: Rect): [number, number] {
  const fit = (lo: number, hi: number, d: number, blo: number, bhi: number): number => {
    if (hi - lo > bhi - blo) return d
    if (lo + d < blo) return blo - lo
    if (hi + d > bhi) return bhi - hi
    return d
  }
  const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])]
  return [fit(x0, x1, dx, box[0], box[2]), fit(y0, y1, dy, box[1], box[3])]
}
