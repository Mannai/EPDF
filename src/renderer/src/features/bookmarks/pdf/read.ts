import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, type PDFContext, type PDFDocument, type PDFObject } from 'pdf-lib'
import { DestinationResolver } from '@shared/features/destinations'
import { readPdfText } from '@shared/features/pdftext'
import type { BmNode, BmRead, Rgb } from './model'

/**
 * Reads a document's outline into a `BmNode` tree. Never throws on damaged outlines: unreadable items are
 * skipped and described in `warnings`. Cycles and absurd sizes are cut off.
 */

const N = (s: string): PDFName => PDFName.of(s)
export const MAX_ITEMS = 200_000
const MAX_DEPTH = 64

export const refId = (ref: PDFRef): string => `${ref.objectNumber} ${ref.generationNumber}`

export function parseRefId(id: string): PDFRef | null {
  const m = /^(\d+) (\d+)$/.exec(id)
  return m ? PDFRef.of(+m[1], +m[2]) : null
}

export const outlineRootDict = (pdf: PDFDocument): PDFDict | undefined => {
  try {
    return pdf.catalog.lookupMaybe(N('Outlines'), PDFDict)
  } catch {
    return undefined
  }
}

/** The /First → /Next chain under `parent`: (ref, dict) pairs, each dictionary at most once. */
export function childItems(ctx: PDFContext, parent: PDFDict, budget: { left: number }): { ref: PDFRef; dict: PDFDict }[] {
  const out: { ref: PDFRef; dict: PDFDict }[] = []
  const seen = new Set<PDFDict>()
  let cur: PDFObject | undefined = parent.get(N('First'))
  while (cur instanceof PDFRef && budget.left-- > 0) {
    const dict: PDFObject | undefined = ctx.lookup(cur)
    if (!(dict instanceof PDFDict) || seen.has(dict)) break
    seen.add(dict)
    out.push({ ref: cur, dict })
    cur = dict.get(N('Next'))
  }
  return out
}

function readColor(dict: PDFDict): Rgb | null {
  const c = dict.lookupMaybe(N('C'), PDFArray)
  if (!c || c.size() !== 3) return null
  const v: number[] = []
  for (let i = 0; i < 3; i++) {
    const n = c.lookup(i)
    if (!(n instanceof PDFNumber)) return null
    v.push(Math.min(1, Math.max(0, n.asNumber())))
  }
  return v as Rgb
}

export function readBookmarks(pdf: PDFDocument): BmRead {
  const warnings: string[] = []
  const root = outlineRootDict(pdf)
  if (!root) return { roots: [], warnings, count: 0, hasOutline: false }
  const ctx = pdf.context
  const resolver = new DestinationResolver(pdf)
  const budget = { left: MAX_ITEMS }
  let count = 0
  let unresolved = 0

  const build = (parent: PDFDict, depth: number): BmNode[] => {
    if (depth > MAX_DEPTH) return []
    const nodes: BmNode[] = []
    for (const { ref, dict } of childItems(ctx, parent, budget)) {
      try {
        const title = (readPdfText(dict.lookup(N('Title'))) ?? '').replace(/[\r\n\t]+/g, ' ')
        const target = resolver.resolveItem(dict)
        const flags = dict.lookupMaybe(N('F'), PDFNumber)?.asNumber() ?? 0
        const cnt = dict.lookupMaybe(N('Count'), PDFNumber)?.asNumber() ?? 0
        count++
        const node: BmNode = {
          id: refId(ref),
          title,
          target,
          targetChanged: false,
          open: cnt > 0,
          bold: (flags & 2) !== 0,
          italic: (flags & 1) !== 0,
          color: readColor(dict),
          children: []
        }
        nodes.push(node)
        node.children = build(dict, depth + 1)
        // A heading-only item that has children is normal; a leaf that leads nowhere is not.
        if (target.kind === 'dead' || (target.kind === 'none' && node.children.length === 0)) unresolved++
      } catch {
        warnings.push('One bookmark was damaged and was skipped.')
      }
    }
    return nodes
  }

  const roots = build(root, 0)
  if (budget.left <= 0) warnings.push('The bookmarks were cut short because the outline is unusually large or circular.')
  if (unresolved > 0) warnings.push(`${unresolved} bookmark${unresolved === 1 ? '' : 's'} ${unresolved === 1 ? 'has' : 'have'} no usable page destination.`)
  return { roots, warnings, count, hasOutline: true }
}
