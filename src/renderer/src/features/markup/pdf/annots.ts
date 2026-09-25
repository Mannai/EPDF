import { PDFArray, PDFDict, PDFName, PDFRef, type PDFDocument, type PDFPage } from 'pdf-lib'
import { get } from './pdfobj'

/**
 * Page /Annots management. The array may be direct or an indirect object, entries may be references or
 * direct dictionaries, and pages may have none: all of that is handled here, and other annotations
 * (links, form widgets, things we do not understand) are never touched.
 */

export interface Located {
  /** "<obj> <gen>" for indirect annotations, "p<page>.<index>" for direct ones. */
  id: string
  dict: PDFDict
  /** Undefined for a direct dictionary embedded in the /Annots array. */
  ref?: PDFRef
  page: PDFPage
  pageIndex: number
  array: PDFArray
  index: number
}

export const refId = (ref: PDFRef): string => `${ref.objectNumber} ${ref.generationNumber}`

export function parseRefId(id: string): PDFRef | null {
  const m = /^(\d+) (\d+)$/.exec(id)
  return m ? PDFRef.of(+m[1], +m[2]) : null
}

/** The page's /Annots array (direct or resolved from an indirect reference), if it has a valid one. */
export function pageAnnots(page: PDFPage): PDFArray | undefined {
  const a = get(page.node, 'Annots')
  return a instanceof PDFArray ? a : undefined
}

/** Appends an annotation reference to the page, creating /Annots when missing; keeps an indirect array indirect. */
export function addAnnotToPage(pdf: PDFDocument, page: PDFPage, ref: PDFRef): void {
  const existing = pageAnnots(page)
  if (existing) existing.push(ref)
  else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]))
}

/** Every annotation dictionary in the document, in page order then array order. */
export function listLocated(pdf: PDFDocument): Located[] {
  const out: Located[] = []
  const pages = pdf.getPages()
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]
    const array = pageAnnots(page)
    if (!array) continue
    for (let index = 0; index < array.size(); index++) {
      const entry = array.get(index)
      let dict: PDFDict | undefined
      let ref: PDFRef | undefined
      if (entry instanceof PDFRef) {
        ref = entry
        const resolved = pdf.context.lookup(entry)
        if (resolved instanceof PDFDict) dict = resolved
      } else if (entry instanceof PDFDict) dict = entry
      if (!dict) continue
      out.push({ id: ref ? refId(ref) : `p${pageIndex}.${index}`, dict, ref, page, pageIndex, array, index })
    }
  }
  return out
}

export function locate(pdf: PDFDocument, id: string): Located | undefined {
  return listLocated(pdf).find((l) => l.id === id)
}

/** Ids of annotations that reply (directly or indirectly, via /IRT) to `id`. */
export function descendantIds(all: Located[], id: string): string[] {
  const irtOf = new Map<string, string>()
  for (const l of all) {
    const irt = l.dict.get(PDFName.of('IRT'))
    if (irt instanceof PDFRef) irtOf.set(l.id, refId(irt))
  }
  const found: string[] = []
  const queue = [id]
  while (queue.length) {
    const cur = queue.pop()!
    for (const [child, parent] of irtOf) {
      if (parent === cur && !found.includes(child) && child !== id) {
        found.push(child)
        queue.push(child)
      }
    }
  }
  return found
}

/**
 * Removes annotations from their pages (and their objects from the file). Indices are removed from the
 * highest to the lowest so earlier removals do not shift later ones.
 */
export function removeLocated(pdf: PDFDocument, targets: Located[]): void {
  const byArray = new Map<PDFArray, Located[]>()
  for (const t of targets) byArray.set(t.array, [...(byArray.get(t.array) ?? []), t])
  for (const [array, list] of byArray) {
    for (const t of list.sort((a, b) => b.index - a.index)) array.remove(t.index)
  }
  for (const t of targets) {
    if (t.ref) pdf.context.delete(t.ref)
  }
}
