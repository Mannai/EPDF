import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFContext, type PDFObject } from 'pdf-lib'
import { refKey } from './streams'

/** Object-graph helpers: which indirect objects can be reached from the trailer. */

export type Alias = Map<string, PDFRef>

/** Calls `cb` for every reference directly inside `obj` (dictionary values, array items, stream dictionary). */
export function forEachRef(obj: PDFObject | undefined, cb: (r: PDFRef) => void): void {
  // Iterative: nested direct containers can be deep in hostile files.
  const stack: PDFObject[] = obj ? [obj] : []
  while (stack.length) {
    const o = stack.pop()!
    if (o instanceof PDFRef) cb(o)
    else if (o instanceof PDFStream) stack.push(o.dict)
    else if (o instanceof PDFDict) for (const v of o.values()) stack.push(v)
    else if (o instanceof PDFArray) for (const v of o.asArray()) stack.push(v)
  }
}

export interface Reached {
  ref: PDFRef
  obj: PDFObject
}

/**
 * Objects reachable from `roots`, in document (depth-first) order. References listed in `alias` are followed to their
 * replacement. Dangling references are ignored.
 */
export function reachable(ctx: PDFContext, roots: (PDFRef | undefined)[], alias?: Alias): Reached[] {
  const seen = new Set<string>()
  const out: Reached[] = []
  const stack: PDFRef[] = []
  const push = (r: PDFRef): void => {
    stack.push(alias?.get(refKey(r)) ?? r)
  }
  for (let i = roots.length - 1; i >= 0; i--) if (roots[i]) push(roots[i]!)
  while (stack.length) {
    const r = stack.pop()!
    const k = refKey(r)
    if (seen.has(k)) continue
    const obj = ctx.lookup(r)
    if (obj === undefined) continue
    seen.add(k)
    out.push({ ref: r, obj })
    const kids: PDFRef[] = []
    forEachRef(obj, (c) => kids.push(c))
    for (let i = kids.length - 1; i >= 0; i--) push(kids[i])
  }
  return out
}

/** Trailer roots: the catalog and, if present, the Info dictionary. */
export function trailerRoots(ctx: PDFContext): { root: PDFRef | undefined; info: PDFRef | undefined } {
  const t = ctx.trailerInfo
  return { root: t.Root instanceof PDFRef ? t.Root : undefined, info: t.Info instanceof PDFRef ? t.Info : undefined }
}
