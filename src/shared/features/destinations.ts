import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFDocument,
  type PDFObject
} from 'pdf-lib'
import { readAsciiString, readPdfText } from './pdftext'

/**
 * Destinations for links and bookmarks: explicit arrays, named destinations (catalog /Dests dictionary or
 * /Names name tree), /GoTo actions, and the other action types (URI, remote GoToR, Launch, ...) which are
 * recognised so they can be shown and preserved but never rewritten. Pure pdf-lib; runs in Node.
 */

export type DestTail = (string | number | null)[]

/** A location in this document: the page (0-based) and the rest of the destination array (`XYZ`, null, 700, null). */
export interface PageDest {
  pageIndex: number
  tail: DestTail
}

/** What a link annotation or outline item points at. */
export type ItemTarget =
  /** A page of this document, reached through an explicit array, a name, or a /GoTo action. */
  | { kind: 'page'; dest: PageDest; named?: string; via: 'dest' | 'action' }
  /** Points at something that is not (or no longer) in the document: a missing page or an unknown name. */
  | { kind: 'dead'; named?: string; via: 'dest' | 'action' }
  | { kind: 'uri'; uri: string }
  /** GoToR, Launch, JavaScript, Named, SubmitForm, ...: shown read-only and left untouched. */
  | { kind: 'other'; action: string; detail: string }
  | { kind: 'none' }

const N = (s: string): PDFName => PDFName.of(s)
const MAX_NODES = 200_000
const MAX_DEPTH = 64

/** Destination types and how many numbers follow each. */
const ARITY: Record<string, number> = { XYZ: 3, Fit: 0, FitH: 1, FitV: 1, FitR: 4, FitB: 0, FitBH: 1, FitBV: 1 }

/** Cleans a destination tail: known type, right number of parameters (numbers or null). Anything else becomes `['Fit']`. */
export function normalizeTail(tail: readonly (string | number | null | undefined)[] | undefined): DestTail {
  const type = tail?.[0]
  if (typeof type !== 'string' || !(type in ARITY)) return ['Fit']
  const out: DestTail = [type]
  for (let i = 1; i <= ARITY[type]; i++) {
    const v = tail![i]
    out.push(typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)
  }
  return out
}

/** The y coordinate (PDF user space, from the bottom) a destination scrolls to, or null for "top of the page". */
export function destTop(tail: DestTail): number | null {
  const [type, a, b, , d] = tail
  const pick = type === 'XYZ' ? b : type === 'FitH' || type === 'FitBH' ? a : type === 'FitR' ? d : null
  return typeof pick === 'number' ? pick : null
}

export function readTail(arr: PDFArray): DestTail {
  const tail: DestTail = []
  for (let i = 1; i < arr.size(); i++) {
    const el = arr.lookup(i)
    if (el instanceof PDFName) tail.push(el.decodeText())
    else if (el instanceof PDFNumber) tail.push(el.asNumber())
    else tail.push(null)
  }
  return tail
}

/** Flattens a name tree (/Names arrays under /Kids nodes) into a map; cycle- and size-safe. */
export function readNameTree(ctx: PDFContext, root: PDFObject | undefined): Map<string, PDFObject> {
  const out = new Map<string, PDFObject>()
  const seen = new Set<PDFObject>()
  const walk = (o: PDFObject | undefined, depth: number): void => {
    const node = o instanceof PDFRef ? ctx.lookup(o) : o
    if (!(node instanceof PDFDict) || seen.has(node) || depth > MAX_DEPTH || out.size > MAX_NODES) return
    seen.add(node)
    const names = node.lookupMaybe(N('Names'), PDFArray)
    if (names) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const key = readPdfText(names.lookup(i))
        if (key !== undefined) out.set(key, names.get(i + 1))
      }
    }
    const kids = node.lookupMaybe(N('Kids'), PDFArray)
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1)
  }
  walk(root, 0)
  return out
}

const nameOrText = (o: PDFObject | undefined): string | undefined =>
  o instanceof PDFName ? o.decodeText() : o instanceof PDFString || o instanceof PDFHexString ? readPdfText(o) : undefined

export class DestinationResolver {
  private named: Map<string, PDFObject> | null = null
  private inDestsDict: Set<string> | null = null
  private readonly pageIndex: Map<string, number>
  readonly pageRefs: PDFRef[]

  constructor(private readonly pdf: PDFDocument) {
    this.pageRefs = pdf.getPages().map((p) => p.ref)
    this.pageIndex = new Map(this.pageRefs.map((r, i) => [r.tag, i]))
  }

  indexOf(ref: PDFRef): number | undefined {
    return this.pageIndex.get(ref.tag)
  }

  private load(): Map<string, PDFObject> {
    if (!this.named) {
      const map = new Map<string, PDFObject>()
      const dictKeys = new Set<string>()
      const catalog = this.pdf.catalog
      try {
        const dests = catalog.lookupMaybe(N('Dests'), PDFDict) // PDF 1.1 style: a dictionary keyed by name
        if (dests) {
          for (const [k, v] of dests.entries()) {
            map.set(k.decodeText(), v)
            dictKeys.add(k.decodeText())
          }
        }
        const names = catalog.lookupMaybe(N('Names'), PDFDict)
        for (const [k, v] of readNameTree(this.pdf.context, names?.get(N('Dests')))) if (!map.has(k)) map.set(k, v)
      } catch {
        /* a damaged name tree: whatever was read is enough */
      }
      this.named = map
      this.inDestsDict = dictKeys
    }
    return this.named
  }

  /** Whether `name` lives in the catalog's /Dests dictionary (written as a name object) rather than the name tree. */
  isDictName(name: string): boolean {
    this.load()
    return this.inDestsDict!.has(name)
  }

  /** Every named destination and the page it currently leads to (null if it leads nowhere). */
  namedDestinations(): { name: string; pageIndex: number | null }[] {
    const out: { name: string; pageIndex: number | null }[] = []
    for (const name of this.load().keys()) {
      const r = this.resolveKey(name, 'dest', 0)
      out.push({ name, pageIndex: r.kind === 'page' ? r.dest.pageIndex : null })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  hasName(name: string): boolean {
    return this.load().has(name)
  }

  /** Resolves a /Dest value (array, name, string, or dict with /D) to a page of this document. */
  resolveDest(obj: PDFObject | undefined, via: 'dest' | 'action' = 'dest', depth = 0, named?: string): ItemTarget {
    if (obj === undefined || depth > 4) return { kind: 'none' }
    const ctx = this.pdf.context
    const value = obj instanceof PDFRef ? ctx.lookup(obj) : obj
    if (value instanceof PDFArray) {
      const first = value.get(0)
      if (first instanceof PDFRef) {
        const idx = this.pageIndex.get(first.tag)
        if (idx === undefined) return { kind: 'dead', named, via }
        return { kind: 'page', dest: { pageIndex: idx, tail: readTail(value) }, named, via }
      }
      return { kind: 'none' } // a page *number* is only used by remote destinations
    }
    if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
      const key = nameOrText(value)
      return key === undefined ? { kind: 'none' } : this.resolveKey(key, via, depth)
    }
    if (value instanceof PDFDict) return this.resolveDest(value.get(N('D')), via, depth + 1, named)
    return { kind: 'none' }
  }

  /** Resolves a destination name. A name that leads nowhere is a broken link, not something to preserve silently. */
  private resolveKey(key: string, via: 'dest' | 'action', depth: number): ItemTarget {
    const target = this.load().get(key)
    return target === undefined ? { kind: 'dead', named: key, via } : this.resolveDest(target, via, depth + 1, key)
  }

  /** The target of an outline item or link annotation: /Dest first, else the /A action. */
  resolveItem(item: PDFDict): ItemTarget {
    if (item.has(N('Dest'))) return this.resolveDest(item.get(N('Dest')), 'dest')
    const action = item.lookupMaybe(N('A'), PDFDict)
    if (!action) return { kind: 'none' }
    const type = action.lookupMaybe(N('S'), PDFName)?.decodeText() ?? ''
    if (type === 'GoTo') return this.resolveDest(action.get(N('D')), 'action')
    if (type === 'URI') {
      const uri = readAsciiString(action.lookup(N('URI')))
      return uri !== undefined ? { kind: 'uri', uri } : { kind: 'other', action: 'URI', detail: '' }
    }
    if (!type) return { kind: 'none' }
    let detail = ''
    try {
      const f = action.lookup(N('F'))
      detail = readPdfText(f) ?? (f instanceof PDFDict ? (readPdfText(f.lookup(N('UF'))) ?? readPdfText(f.lookup(N('F'))) ?? '') : '')
      if (!detail && type === 'Named') detail = action.lookupMaybe(N('N'), PDFName)?.decodeText() ?? ''
    } catch {
      /* the label is best effort */
    }
    return { kind: 'other', action: type, detail }
  }
}

/** Builds an explicit destination array `[page /XYZ left top zoom]`. */
export function buildDestArray(ctx: PDFContext, pageRef: PDFRef, tail: DestTail): PDFArray {
  const arr = PDFArray.withContext(ctx)
  arr.push(pageRef)
  const t = normalizeTail(tail)
  arr.push(N(t[0] as string))
  for (let i = 1; i < t.length; i++) {
    const v = t[i]
    arr.push(typeof v === 'number' ? PDFNumber.of(v) : ctx.obj(null))
  }
  return arr
}
