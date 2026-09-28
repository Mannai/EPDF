import { PDFName, PDFRef, PDFStream, type PDFDocument } from 'pdf-lib'
import { listLocated, removeLocated, type Located } from './annots'
import { getDict, getNumbers } from './pdfobj'
import { FILL_KEY } from './ops'

/**
 * Locking Fill & sign items into the page ("flattening"): each item's appearance is drawn into the page content where
 * the annotation showed it, and the annotation is removed. The result looks the same in every reader and can no longer
 * be selected, moved or changed as an object. Returns how many items were locked.
 */

export const isFillItem = (l: Located): boolean => l.dict.get(PDFName.of(FILL_KEY)) !== undefined

export function flattenFillItems(pdf: PDFDocument): number {
  const items = listLocated(pdf).filter(isFillItem)
  let n = 0
  for (const l of items) if (flattenOne(pdf, l)) n++
  removeLocated(pdf, items)
  return n
}

let seq = 0

/** Draws the annotation's normal appearance into its page (PDF 12.5.5: the form's BBox, transformed by its Matrix, fitted to /Rect). */
function flattenOne(pdf: PDFDocument, l: Located): boolean {
  const ap = getDict(l.dict, 'AP')
  const n = ap?.get(PDFName.of('N'))
  const stream = n instanceof PDFRef ? pdf.context.lookup(n) : n
  if (!(stream instanceof PDFStream)) return false
  const ref = n instanceof PDFRef ? n : pdf.context.register(stream)
  const bbox = getNumbers(stream.dict, 'BBox')
  const rect = getNumbers(l.dict, 'Rect')
  if (!bbox || bbox.length < 4 || !rect || rect.length < 4) return false
  const m = getNumbers(stream.dict, 'Matrix') ?? [1, 0, 0, 1, 0, 0]
  const pts = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[0], bbox[3]],
    [bbox[2], bbox[3]]
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
  const bx0 = Math.min(...pts.map((p) => p[0]))
  const by0 = Math.min(...pts.map((p) => p[1]))
  const bx1 = Math.max(...pts.map((p) => p[0]))
  const by1 = Math.max(...pts.map((p) => p[1]))
  const rx0 = Math.min(rect[0], rect[2])
  const ry0 = Math.min(rect[1], rect[3])
  const rx1 = Math.max(rect[0], rect[2])
  const ry1 = Math.max(rect[1], rect[3])
  if (bx1 - bx0 <= 0 || by1 - by0 <= 0) return false
  const sx = (rx1 - rx0) / (bx1 - bx0)
  const sy = (ry1 - ry0) / (by1 - by0)
  const f = (v: number): string => (Math.round(v * 10000) / 10000).toString()
  const page = pdf.getPages()[l.pageIndex]
  if (!page) return false
  // The page's own content is wrapped in q/Q first, so whatever state it leaves doesn't shift the drawing.
  page.node.normalize()
  const name = page.node.newXObject(`EpdfFl${(seq++).toString(36)}`, ref)
  const ops = `q ${f(sx)} 0 0 ${f(sy)} ${f(rx0 - bx0 * sx)} ${f(ry0 - by0 * sy)} cm ${name.toString()} Do Q\n`
  page.node.addContentStream(pdf.context.register(pdf.context.flateStream(new TextEncoder().encode(ops))))
  return true
}
