import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, type PDFDocument } from 'pdf-lib'
import { buildDestArray } from '@shared/features/destinations'
import { pdfTextString, readPdfText, sanitizeTitle } from '@shared/features/pdftext'
import { visibleCount, type BmNode } from './model'
import { MAX_ITEMS, childItems, outlineRootDict, parseRefId, refId } from './read'

/**
 * Writes a `BmNode` tree back as the document's /Outlines. Items that already exist keep their dictionary
 * (so keys this code does not manage, such as an /A action or a structure element, survive), new items get
 * new dictionaries, removed items are deleted from the file. Every /Parent, /Prev, /Next, /First, /Last and
 * /Count is recomputed, so the result is a strictly valid outline tree.
 */

const N = (s: string): PDFName => PDFName.of(s)

/** All item references currently reachable from the outline root. */
function existingRefs(pdf: PDFDocument): Set<string> {
  const out = new Set<string>()
  const root = outlineRootDict(pdf)
  if (!root) return out
  const budget = { left: MAX_ITEMS }
  const walk = (parent: PDFDict, depth: number): void => {
    for (const { ref, dict } of childItems(pdf.context, parent, budget)) {
      if (out.has(refId(ref))) continue
      out.add(refId(ref))
      if (depth < 64) walk(dict, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/**
 * Replaces the outline with `roots`. Returns a map from the temporary ids of new items to the ids they got in
 * the file (items that already had an id are not in the map).
 */
export function writeBookmarks(pdf: PDFDocument, roots: BmNode[]): Map<string, string> {
  const ctx = pdf.context
  const oldRefs = existingRefs(pdf)
  const catalogEntry = pdf.catalog.get(N('Outlines'))
  const oldRootRef = catalogEntry instanceof PDFRef ? catalogEntry : undefined
  const created = new Map<string, string>()
  const used = new Set<string>()

  if (roots.length === 0) {
    pdf.catalog.delete(N('Outlines'))
    for (const id of oldRefs) {
      const r = parseRefId(id)
      if (r) ctx.delete(r)
    }
    if (oldRootRef) ctx.delete(oldRootRef)
    return created
  }

  const pageRefs = pdf.getPages().map((p) => p.ref)

  const claim = (node: BmNode): { ref: PDFRef; dict: PDFDict } => {
    const existing = oldRefs.has(node.id) && !used.has(node.id) ? parseRefId(node.id) : null
    if (existing) {
      const d = ctx.lookup(existing)
      if (d instanceof PDFDict) {
        used.add(node.id)
        return { ref: existing, dict: d }
      }
    }
    const dict = ctx.obj({}) as PDFDict
    const ref = ctx.register(dict)
    created.set(node.id, refId(ref))
    used.add(refId(ref))
    return { ref, dict }
  }

  const applyTarget = (dict: PDFDict, node: BmNode): void => {
    const t = node.target
    if (t.kind === 'page') {
      const pageRef = pageRefs[t.dest.pageIndex]
      if (!pageRef) return
      dict.delete(N('A'))
      dict.set(N('Dest'), buildDestArray(ctx, pageRef, t.dest.tail))
    } else if (t.kind === 'none' || t.kind === 'dead') {
      dict.delete(N('A'))
      dict.delete(N('Dest'))
    }
    // uri / other actions are preserved exactly as they are.
  }

  const emit = (list: BmNode[], parentRef: PDFRef): { first: PDFRef; last: PDFRef } => {
    const made = list.map(claim)
    list.forEach((node, i) => {
      const { ref, dict } = made[i]
      dict.set(N('Parent'), parentRef)
      if (i > 0) dict.set(N('Prev'), made[i - 1].ref)
      else dict.delete(N('Prev'))
      if (i < list.length - 1) dict.set(N('Next'), made[i + 1].ref)
      else dict.delete(N('Next'))

      const title = sanitizeTitle(node.title)
      let current: string | undefined
      try {
        current = readPdfText(dict.lookup(N('Title')))
      } catch {
        current = undefined
      }
      if (current !== title) dict.set(N('Title'), pdfTextString(title))

      const flags = (node.italic ? 1 : 0) | (node.bold ? 2 : 0)
      if (flags) dict.set(N('F'), PDFNumber.of(flags))
      else dict.delete(N('F'))
      if (node.color) dict.set(N('C'), ctx.obj(node.color.map((v) => PDFNumber.of(Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000))) as PDFArray)
      else dict.delete(N('C'))

      if (node.targetChanged) applyTarget(dict, node)

      if (node.children.length) {
        const { first, last } = emit(node.children, ref)
        dict.set(N('First'), first)
        dict.set(N('Last'), last)
        const v = visibleCount(node)
        dict.set(N('Count'), PDFNumber.of(node.open ? v : -v))
      } else {
        dict.delete(N('First'))
        dict.delete(N('Last'))
        dict.delete(N('Count'))
      }
    })
    return { first: made[0].ref, last: made[made.length - 1].ref }
  }

  const rootDict = outlineRootDict(pdf) ?? (ctx.obj({ Type: 'Outlines' }) as PDFDict)
  const rootRef = oldRootRef && outlineRootDict(pdf) ? oldRootRef : ctx.register(rootDict)
  rootDict.set(N('Type'), N('Outlines'))
  const { first, last } = emit(roots, rootRef)
  rootDict.set(N('First'), first)
  rootDict.set(N('Last'), last)
  rootDict.set(N('Count'), PDFNumber.of(visibleCount({ id: '', title: '', target: { kind: 'none' }, targetChanged: false, open: true, bold: false, italic: false, color: null, children: roots })))
  pdf.catalog.set(N('Outlines'), rootRef)

  for (const id of oldRefs) {
    if (used.has(id)) continue
    const r = parseRefId(id)
    if (r) ctx.delete(r)
  }
  return created
}
