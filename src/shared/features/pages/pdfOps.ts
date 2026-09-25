import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  degrees,
  type PDFObject,
  type PDFPage
} from 'pdf-lib'
import { EMPTY_LABEL, readPageLabels, writePageLabels, type PageLabel } from './labels'
import { dropDanglingLinks, dropDanglingOutline } from './outline'
import type { PageSpec } from './order'

/**
 * The one primitive behind every page-organizer edit: "make the document consist of exactly these pages,
 * in this order". Deleting, reordering, duplicating, inserting blank pages, inserting pages from another
 * PDF, rotating, extracting and splitting are all expressed as a list of `PageSpec`s, so they share the
 * same handling of page trees, bookmarks, links, form fields, page labels and orphaned objects.
 */

const N = (s: string): PDFName => PDFName.of(s)
const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const
const MARKER = N('EpdfTmp')

export const LETTER: { width: number; height: number } = { width: 612, height: 792 }

const normAngle = (a: number): number => ((a % 360) + 360) % 360
const subtypeOf = (d: PDFDict): string | undefined => d.lookupMaybe(N('Subtype'), PDFName)?.decodeText()

/** A page's displayed size in points (MediaBox with /Rotate applied). */
export function displayedSize(pdf: PDFDocument, index: number): { width: number; height: number } {
  const page = pdf.getPage(index)
  const { width, height } = page.getSize()
  const rot = normAngle(page.getRotation().angle)
  return rot === 90 || rot === 270 ? { width: height, height: width } : { width, height }
}

/**
 * Copies attributes a page inherits from its ancestors (Resources, MediaBox, CropBox, Rotate) onto the page
 * itself, so pages survive being moved to a different parent. Direct (non-reference) inherited objects are
 * registered once and shared by reference.
 */
export function materializeInherited(pdf: PDFDocument): void {
  const shared = new Map<PDFObject, PDFRef>()
  for (const page of pdf.getPages()) {
    const leaf = page.node
    for (const key of INHERITABLE) {
      const k = N(key)
      if (leaf.has(k)) continue
      const v = leaf.getInheritableAttribute(k)
      if (!v) continue
      if (v instanceof PDFDict || v instanceof PDFArray) {
        let ref = shared.get(v)
        if (!ref) shared.set(v, (ref = pdf.context.register(v)))
        leaf.set(k, ref)
      } else leaf.set(k, v)
    }
  }
}

/** Forces pdf-lib to re-read the page tree (it caches `getPages()`; we rewrite the tree directly). */
function invalidatePageCache(pdf: PDFDocument): void {
  ;(pdf as unknown as { pageCache: { invalidate(): void } }).pageCache.invalidate()
}

/** Deletes every indirect object that cannot be reached from the trailer; refs in `barrier` are treated as gone. */
export function pruneUnreachable(pdf: PDFDocument, barrier: Set<string> = new Set()): number {
  const ctx = pdf.context
  const seen = new Set<string>()
  const stack: PDFObject[] = []
  for (const v of [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt, ctx.trailerInfo.ID]) if (v) stack.push(v)
  while (stack.length) {
    const o = stack.pop()!
    if (o instanceof PDFRef) {
      if (seen.has(o.tag) || barrier.has(o.tag)) continue
      seen.add(o.tag)
      const target = ctx.lookup(o)
      if (target) stack.push(target)
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v)
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i))
    } else if (o instanceof PDFStream || o instanceof PDFRawStream) {
      for (const [, v] of o.dict.entries()) stack.push(v)
    }
  }
  let removed = 0
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) {
      ctx.delete(ref)
      removed++
    }
  }
  return removed
}

/** Removes form fields whose widgets lived only on removed pages, so their values do not linger in the file. */
function dropFieldsOfRemovedPages(pdf: PDFDocument, removedAnnots: Set<string>): void {
  if (removedAnnots.size === 0) return
  const ctx = pdf.context
  const fields = pdf.catalog.lookupMaybe(N('AcroForm'), PDFDict)?.lookupMaybe(N('Fields'), PDFArray)
  if (!fields) return
  const seen = new Set<string>()
  const filter = (list: PDFArray, depth: number): void => {
    for (let i = list.size() - 1; i >= 0; i--) {
      const item = list.get(i)
      if (item instanceof PDFRef) {
        if (removedAnnots.has(item.tag)) {
          list.remove(i)
          continue
        }
        if (seen.has(item.tag) || depth > 32) continue
        seen.add(item.tag)
      }
      const dict = item instanceof PDFRef ? ctx.lookup(item) : item
      if (!(dict instanceof PDFDict)) continue
      const kids = dict.lookupMaybe(N('Kids'), PDFArray)
      if (kids) {
        filter(kids, depth + 1)
        if (kids.size() === 0) list.remove(i)
      }
    }
  }
  filter(fields, 0)
}

const annotsOf = (page: PDFPage): PDFArray | undefined => page.node.lookupMaybe(N('Annots'), PDFArray)

/**
 * A copy of `page` that shares its content and resources (so it costs almost nothing) but has its own
 * annotations. Links keep pointing at the same pages. Form-field widgets are not duplicated (they would
 * need new field names), and structure-tree membership is not shared.
 */
function duplicatePage(pdf: PDFDocument, page: PDFPage): PDFRef {
  const ctx = pdf.context
  const clone = page.node.clone(ctx)
  const ref = ctx.register(clone)
  clone.delete(N('StructParents'))
  clone.delete(N('Thumb'))
  const annots = annotsOf(page)
  if (annots) {
    const list: PDFRef[] = []
    for (let i = 0; i < annots.size(); i++) {
      const d = annots.lookup(i)
      if (!(d instanceof PDFDict)) continue
      const sub = subtypeOf(d)
      if (sub === 'Widget' || sub === 'Popup') continue
      const copy = d.clone(ctx)
      copy.set(N('P'), ref)
      copy.delete(N('StructParent'))
      const popup = d.lookupMaybe(N('Popup'), PDFDict)
      if (popup) {
        const pc = popup.clone(ctx)
        const pref = ctx.register(pc)
        copy.set(N('Popup'), pref)
      }
      const cref = ctx.register(copy)
      const pp = copy.get(N('Popup'))
      if (pp instanceof PDFRef) (ctx.lookup(pp, PDFDict)).set(N('Parent'), cref)
      list.push(cref)
    }
    clone.set(N('Annots'), ctx.obj(list))
  }
  return ref
}

/** Prepares pages of a throwaway source document for `copyPages`: tags them, and drops widgets that would drag in whole field trees. */
function prepareExtSource(ext: PDFDocument, indices: number[]): void {
  const pages = ext.getPages()
  for (const i of indices) {
    const page = pages[i]
    page.node.set(MARKER, PDFNumber.of(i))
    const annots = annotsOf(page)
    for (let k = (annots?.size() ?? 0) - 1; k >= 0; k--) {
      const d = annots!.lookup(k)
      if (d instanceof PDFDict && subtypeOf(d) === 'Widget') annots!.remove(k)
    }
  }
}

/** After copying: annotations belong to the new page, and links to source pages point at the copies of those pages (or are dropped). */
function fixCopiedPage(pdf: PDFDocument, page: PDFPage, markerToRef: Map<number, PDFRef>): void {
  const ctx = pdf.context
  const annots = annotsOf(page)
  for (let i = 0; annots && i < annots.size(); i++) {
    const a = annots.lookup(i)
    if (!(a instanceof PDFDict)) continue
    a.set(N('P'), page.ref)
    if (subtypeOf(a) !== 'Link') continue
    const holder: PDFDict | undefined =
      a.has(N('Dest')) ? a : a.lookupMaybe(N('A'), PDFDict)?.lookupMaybe(N('S'), PDFName)?.decodeText() === 'GoTo' ? a.lookupMaybe(N('A'), PDFDict) : undefined
    const key = holder === a ? N('Dest') : N('D')
    if (!holder) continue
    const dest = holder.lookup(key)
    let ok = false
    if (dest instanceof PDFArray) {
      const first = dest.get(0)
      const target = first instanceof PDFRef ? ctx.lookup(first) : undefined
      const m = target instanceof PDFDict ? target.lookupMaybe(MARKER, PDFNumber)?.asNumber() : undefined
      const to = m === undefined ? undefined : markerToRef.get(m)
      if (to) {
        dest.set(0, to)
        ok = true
      }
    }
    if (!ok) {
      // Named destinations would resolve against *this* document: drop rather than risk a wrong jump.
      a.delete(N('Dest'))
      if (holder !== a) a.delete(N('A'))
    }
  }
  page.node.delete(MARKER)
}

export interface ApplyOptions {
  /** The document `ext` specs copy pages from. It is modified (tagged); pass a throwaway copy. */
  ext?: PDFDocument
}

/**
 * Rewrites the document so it consists of `specs`, in order. Original pages keep their identity (so their
 * annotations, links and form widgets keep working); a page used more than once is copied for the extra
 * uses. Bookmarks, links and form fields that pointed at removed pages are cleaned up, page labels follow
 * their pages, and objects that only removed pages used are dropped from the file.
 */
export async function applyPageSpecs(pdf: PDFDocument, specs: PageSpec[], opts: ApplyOptions = {}): Promise<void> {
  const oldPages = pdf.getPages()
  const n = oldPages.length
  if (specs.length === 0) throw new Error('A document needs at least one page.')
  for (const s of specs) {
    if (s.kind === 'orig' && !(Number.isInteger(s.index) && s.index >= 0 && s.index < n)) throw new Error(`Page ${s.index + 1} does not exist.`)
    if (s.kind === 'blank' && s.like !== undefined && !(s.like >= 0 && s.like < n)) throw new Error('Cannot size a blank page like a page that does not exist.')
    if (s.kind === 'ext') {
      if (!opts.ext) throw new Error('No source document was given for the inserted pages.')
      if (!(Number.isInteger(s.index) && s.index >= 0 && s.index < opts.ext.getPageCount())) throw new Error(`Source page ${s.index + 1} does not exist.`)
    }
  }

  materializeInherited(pdf)
  if (opts.ext) materializeInherited(opts.ext)
  const oldLabels = readPageLabels(pdf)

  // Copy the pages from the other document in one call so shared fonts and images are copied once.
  const extIndices = [...new Set(specs.flatMap((s) => (s.kind === 'ext' ? [s.index] : [])))].sort((a, b) => a - b)
  const extCopies = new Map<number, PDFPage>()
  if (extIndices.length && opts.ext) {
    prepareExtSource(opts.ext, extIndices)
    const copied = await pdf.copyPages(opts.ext, extIndices)
    extIndices.forEach((idx, i) => extCopies.set(idx, copied[i]))
    const markerToRef = new Map(extIndices.map((idx, i) => [idx, copied[i].ref] as const))
    for (const p of copied) fixCopiedPage(pdf, p, markerToRef)
  }

  const used = new Set<number>()
  const refs: PDFRef[] = []
  const labels: PageLabel[] = []
  const usedExt = new Set<number>()
  for (const s of specs) {
    if (s.kind === 'orig') {
      let ref = oldPages[s.index].ref
      const page = oldPages[s.index]
      if (used.has(s.index)) {
        ref = duplicatePage(pdf, page)
        const dup = pdf.context.lookup(ref, PDFDict)
        if (s.rotate) dup.set(N('Rotate'), PDFNumber.of(normAngle((page.getRotation().angle) + s.rotate)))
      } else if (s.rotate) {
        page.setRotation(degrees(normAngle(page.getRotation().angle + s.rotate)))
      }
      used.add(s.index)
      refs.push(ref)
      labels.push(oldLabels ? oldLabels[s.index] : EMPTY_LABEL)
    } else if (s.kind === 'blank') {
      let w = s.width
      let h = s.height
      if (s.like !== undefined) ({ width: w, height: h } = displayedSize(pdf, s.like))
      const page = pdf.addPage([w ?? LETTER.width, h ?? LETTER.height]) // appended to the old tree; re-parented below
      page.node.set(N('Rotate'), PDFNumber.of(0))
      refs.push(page.ref)
      labels.push(EMPTY_LABEL)
    } else {
      const page = extCopies.get(s.index)
      if (!page) throw new Error('Inserting the same source page twice in one step is not supported.')
      if (usedExt.has(s.index)) throw new Error('Inserting the same source page twice in one step is not supported.')
      usedExt.add(s.index)
      refs.push(page.ref)
      labels.push(EMPTY_LABEL)
    }
  }

  const removed = new Set<string>()
  oldPages.forEach((p, i) => {
    if (!used.has(i)) removed.add(p.ref.tag)
  })
  const removedAnnots = new Set<string>()
  for (const p of oldPages) {
    if (!removed.has(p.ref.tag)) continue
    const annots = annotsOf(p)
    for (let i = 0; annots && i < annots.size(); i++) {
      const a = annots.get(i)
      if (a instanceof PDFRef) removedAnnots.add(a.tag)
    }
  }

  // Flat page tree: one Pages node holding every page. Intermediate nodes become unreachable and are pruned.
  const ctx = pdf.context
  const rootRef = pdf.catalog.get(N('Pages')) as PDFRef
  const root = pdf.catalog.Pages()
  root.set(N('Kids'), ctx.obj(refs))
  root.set(N('Count'), PDFNumber.of(refs.length))
  for (const key of INHERITABLE) root.delete(N(key))
  for (const ref of refs) ctx.lookup(ref, PDFDict).set(N('Parent'), rootRef)
  invalidatePageCache(pdf)

  if (oldLabels) writePageLabels(pdf, labels)
  if (removed.size > 0) {
    dropDanglingOutline(pdf)
    dropDanglingLinks(pdf)
    dropFieldsOfRemovedPages(pdf, removedAnnots)
  }
  // Removed pages, replaced tree nodes and the throwaway orphans left by copyPages.
  if (removed.size > 0 || extIndices.length > 0 || oldPages.length !== refs.length) pruneUnreachable(pdf, removed)
}

/** Builds a new PDF (as bytes) with only `indices` of `srcBytes`, keeping bookmarks, links and labels of those pages. */
export async function extractPages(srcBytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(srcBytes, { updateMetadata: false })
  await applyPageSpecs(pdf, indices.map((index) => ({ kind: 'orig', index })))
  return pdf.save()
}
