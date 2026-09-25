import { PDFArray, PDFDict, PDFName, PDFRef, type PDFDocument, type PDFObject } from 'pdf-lib'
import type { ContentSource, PageAnalysis, StreamSlot } from './analyze'
import { refCountsFor } from './analyze'
import { serializeContent, type Op } from './content'
import { N, refTag } from './pdfutil'

/** Errors whose message is shown to the user as-is: the edit was refused and the document is unchanged. */
export class EditRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditRefusedError'
  }
}

/** A batch of changes to one stream's operations, keyed by the ORIGINAL operation index. */
export interface SlotPlan {
  /** Replace the operation at this index by these operations (empty array = delete it). */
  replace: Map<number, Op[]>
  /** Insert these operations right after the operation at this index (index -1 = before the first). */
  insertAfter: Map<number, Op[]>
}

export const newPlan = (): SlotPlan => ({ replace: new Map(), insertAfter: new Map() })

export function applyPlan(slot: StreamSlot, plan: SlotPlan): void {
  const out: Op[] = []
  const before = plan.insertAfter.get(-1)
  if (before) out.push(...before)
  slot.ops.forEach((op, i) => {
    const r = plan.replace.get(i)
    if (r) out.push(...r)
    else out.push(op)
    const ins = plan.insertAfter.get(i)
    if (ins) out.push(...ins)
  })
  slot.ops = out
  slot.dirty = true
}

/** Collects plans per stream and applies them all at once. */
export class PlanSet {
  private plans = new Map<StreamSlot, SlotPlan>()
  planFor(slot: StreamSlot): SlotPlan {
    let p = this.plans.get(slot)
    if (!p) this.plans.set(slot, (p = newPlan()))
    return p
  }
  replace(slot: StreamSlot, index: number, ops: Op[]): void {
    this.planFor(slot).replace.set(index, ops)
  }
  insertAfter(slot: StreamSlot, index: number, ops: Op[]): void {
    const p = this.planFor(slot)
    p.insertAfter.set(index, [...(p.insertAfter.get(index) ?? []), ...ops])
  }
  apply(): void {
    for (const [slot, plan] of this.plans) applyPlan(slot, plan)
  }
}

export const slotOf = (analysis: PageAnalysis, source: string, slot: number): StreamSlot => {
  const s = analysis.sources.get(source)?.slots[slot]
  if (!s) throw new EditRefusedError('The page content changed; select the item again.')
  return s
}

// ---------------------------------------------------------------------------------------------------------
// Resources

/**
 * Adds an entry to a resource category (Font, XObject, ...) of a content source without touching any
 * dictionary that other pages may share: the source gets its own copy of its resources.
 * Returns the (unique) resource name that was assigned.
 */
export function addResource(pdf: PDFDocument, src: ContentSource, category: 'Font' | 'XObject', prefix: string, ref: PDFRef): string {
  const context = pdf.context
  let res = src.resourcesOverride
  if (!res) {
    res = context.obj({}) as PDFDict
    if (src.resources) for (const [k, v] of src.resources.entries()) res.set(k, v)
    src.resourcesOverride = res
  }
  const existing = res.lookup(N(category))
  const cat = context.obj({}) as PDFDict
  if (existing instanceof PDFDict) for (const [k, v] of existing.entries()) cat.set(k, v)
  let i = 1
  let name = `${prefix}${i}`
  while (cat.has(N(name))) name = `${prefix}${++i}`
  cat.set(N(name), ref)
  res.set(N(category), cat)
  return name
}

// ---------------------------------------------------------------------------------------------------------
// Write-back

const DROP_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms'])

function makeStream(pdf: PDFDocument, template: PDFDict | undefined, bytes: Uint8Array, resources?: PDFDict) {
  const lit: Record<string, PDFObject> = {}
  if (template) {
    for (const [k, v] of template.entries()) {
      const key = k instanceof PDFName ? k.decodeText() : String(k)
      if (!DROP_KEYS.has(key)) lit[key] = v
    }
  }
  if (resources) lit['Resources'] = resources
  return pdf.context.flateStream(bytes, lit)
}

/**
 * Writes every modified stream of the analysis back into the document. Page streams shared with another
 * page get a fresh copy for this page; forms are edited in place (the analysis refuses shared forms).
 */
export function commitSources(pdf: PDFDocument, analysis: PageAnalysis): void {
  const page = pdf.getPage(analysis.pageIndex)
  const context = pdf.context
  const counts = refCountsFor(context)
  const contentsRef = page.node.get(N('Contents'))
  let pageStreamsChanged = false
  const finalRefs: PDFRef[] = []

  const pageSrc = analysis.sources.get('page')
  if (pageSrc) {
    for (const slot of pageSrc.slots) {
      if (!slot.dirty) {
        if (slot.ref) finalRefs.push(slot.ref)
        continue
      }
      const bytes = serializeContent(slot.ops, slot.tail)
      const stream = makeStream(pdf, slot.stream?.dict, bytes)
      const shared = slot.ref ? (counts.get(refTag(slot.ref)) ?? 0) > 1 : false
      if (slot.ref && !shared) {
        context.assign(slot.ref, stream)
        finalRefs.push(slot.ref)
      } else {
        finalRefs.push(context.register(stream))
        pageStreamsChanged = true
      }
    }
    if (pageSrc.resourcesOverride) page.node.set(N('Resources'), pageSrc.resourcesOverride)
    const arrayShared = contentsRef instanceof PDFRef && (counts.get(refTag(contentsRef)) ?? 0) > 1
    const hadArray = contentsRef instanceof PDFArray || (contentsRef instanceof PDFRef && context.lookup(contentsRef) instanceof PDFArray)
    const sameLength = pageSrc.slots.length === finalRefs.length
    if (pageStreamsChanged || arrayShared || (hadArray && !sameLength)) {
      page.node.set(N('Contents'), context.obj(finalRefs))
    } else if (!hadArray && finalRefs.length === 1 && !(contentsRef instanceof PDFRef)) {
      page.node.set(N('Contents'), finalRefs[0])
    } else if (!contentsRef && finalRefs.length) {
      page.node.set(N('Contents'), context.obj(finalRefs))
    }
  }

  for (const src of analysis.sources.values()) {
    if (src.kind !== 'form') continue
    const slot = src.slots[0]
    if (!slot.dirty && !src.resourcesOverride) continue
    if (!slot.ref) throw new EditRefusedError('This text is inside a form that cannot be edited safely.')
    if (slot.dirty || src.resourcesOverride) {
      const bytes = serializeContent(slot.ops, slot.tail)
      context.assign(slot.ref, makeStream(pdf, slot.stream?.dict, bytes, src.resourcesOverride))
    }
  }
}
