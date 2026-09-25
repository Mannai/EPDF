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

/**
 * Reading and maintaining a document's outline (bookmarks) with pdf-lib's low-level objects.
 * Destinations may be explicit arrays, names looked up in the catalog's /Dests dictionary or its /Names
 * name tree, or /GoTo actions; anything else (URI, remote GoToR, JavaScript...) is left alone.
 */

/** A destination inside this document: the page and the rest of the destination array (`XYZ`, 10, 20, null...). */
export interface OutlineDest {
  pageIndex: number
  tail: (string | number | null)[]
}

export interface OutlineNode {
  title: string
  /** Null when the item has no destination we could resolve (an action, a broken link, a heading only). */
  dest: OutlineDest | null
  /** Whether the item was open (children visible) in the source. */
  open: boolean
  children: OutlineNode[]
}

const MAX_NODES = 200_000
const MAX_DEPTH = 64

type Resolved =
  | { type: 'page'; ref: PDFRef; tail: (string | number | null)[] }
  | { type: 'dead' } // points at something that is not (or no longer) a page of this document
  | { type: 'none' } // no destination, or one we do not manage (URI, remote, ...)

const N = (s: string): PDFName => PDFName.of(s)

const textOf = (o: PDFObject | undefined): string | undefined =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : undefined

/** Flattens a name tree (/Names arrays under /Kids nodes) into a map; cycle- and size-safe. */
function readNameTree(ctx: PDFContext, root: PDFObject | undefined): Map<string, PDFObject> {
  const out = new Map<string, PDFObject>()
  const seen = new Set<PDFObject>()
  const walk = (o: PDFObject | undefined, depth: number): void => {
    const node = o instanceof PDFRef ? ctx.lookup(o) : o
    if (!(node instanceof PDFDict) || seen.has(node) || depth > MAX_DEPTH || out.size > MAX_NODES) return
    seen.add(node)
    const names = node.lookupMaybe(N('Names'), PDFArray)
    if (names) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const key = textOf(names.lookup(i))
        if (key !== undefined) out.set(key, names.get(i + 1))
      }
    }
    const kids = node.lookupMaybe(N('Kids'), PDFArray)
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1)
  }
  walk(root, 0)
  return out
}

class DestResolver {
  private named: Map<string, PDFObject> | null = null
  private readonly pageIndex: Map<string, number>

  constructor(
    private readonly pdf: PDFDocument,
    pageRefs: PDFRef[]
  ) {
    this.pageIndex = new Map(pageRefs.map((r, i) => [r.tag, i]))
  }

  indexOf(ref: PDFRef): number | undefined {
    return this.pageIndex.get(ref.tag)
  }

  private lookupNamed(name: string): PDFObject | undefined {
    if (!this.named) {
      const ctx = this.pdf.context
      const map = new Map<string, PDFObject>()
      const catalog = this.pdf.catalog
      const dests = catalog.lookupMaybe(N('Dests'), PDFDict) // PDF 1.1 style: a dictionary keyed by name
      if (dests) for (const [k, v] of dests.entries()) map.set(k.decodeText(), v)
      const names = catalog.lookupMaybe(N('Names'), PDFDict)
      const tree = names?.get(N('Dests'))
      for (const [k, v] of readNameTree(ctx, tree)) if (!map.has(k)) map.set(k, v)
      this.named = map
    }
    return this.named.get(name)
  }

  /** Resolves a /Dest value (array, name, string, or dict with /D). */
  resolveDest(obj: PDFObject | undefined, depth = 0): Resolved {
    if (obj === undefined || depth > 4) return { type: 'none' }
    const ctx = this.pdf.context
    const value = obj instanceof PDFRef ? ctx.lookup(obj) : obj
    if (value instanceof PDFArray) {
      const first = value.get(0)
      if (first instanceof PDFRef) {
        if (!this.pageIndex.has(first.tag)) return { type: 'dead' }
        const tail: (string | number | null)[] = []
        for (let i = 1; i < value.size(); i++) {
          const el = value.lookup(i)
          if (el instanceof PDFName) tail.push(el.decodeText())
          else if (el instanceof PDFNumber) tail.push(el.asNumber())
          else tail.push(null)
        }
        return { type: 'page', ref: first, tail }
      }
      return { type: 'none' } // a page *number* is only used by remote destinations
    }
    if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
      const key = textOf(value)
      const target = key === undefined ? undefined : this.lookupNamed(key)
      // A name that leads nowhere is a broken link, not something we should preserve.
      return target === undefined ? { type: 'dead' } : this.resolveDest(target, depth + 1)
    }
    if (value instanceof PDFDict) return this.resolveDest(value.get(N('D')), depth + 1)
    return { type: 'none' }
  }

  /** Destination of an outline item or link: /Dest, else a /GoTo action's /D. */
  resolveItem(item: PDFDict): Resolved {
    if (item.has(N('Dest'))) return this.resolveDest(item.get(N('Dest')))
    const action = item.lookupMaybe(N('A'), PDFDict)
    if (action) {
      const s = action.lookupMaybe(N('S'), PDFName)
      if (s?.decodeText() === 'GoTo') return this.resolveDest(action.get(N('D')))
    }
    return { type: 'none' }
  }
}

/** Direct children of an outline/bookmark node via the /First → /Next chain (cycle-safe). */
function childrenOf(ctx: PDFContext, parent: PDFDict, budget: { left: number }): { dict: PDFDict; ref: PDFRef | undefined }[] {
  const out: { dict: PDFDict; ref: PDFRef | undefined }[] = []
  const seen = new Set<PDFDict>()
  let cur: PDFObject | undefined = parent.get(N('First'))
  while (cur && budget.left-- > 0) {
    const ref: PDFRef | undefined = cur instanceof PDFRef ? cur : undefined
    const dict: PDFObject | undefined = cur instanceof PDFRef ? ctx.lookup(cur) : cur
    if (!(dict instanceof PDFDict) || seen.has(dict)) break
    seen.add(dict)
    out.push({ dict, ref })
    cur = dict.get(N('Next'))
  }
  return out
}

const outlineRoot = (pdf: PDFDocument): PDFDict | undefined => pdf.catalog.lookupMaybe(N('Outlines'), PDFDict)

/**
 * Reads the outline. Never throws on damaged outlines: unreadable parts are skipped and described in
 * `warnings`. Items whose destination cannot be resolved come back with `dest: null`.
 */
export function readOutline(pdf: PDFDocument): { nodes: OutlineNode[]; warnings: string[] } {
  const warnings: string[] = []
  let root: PDFDict | undefined
  try {
    root = outlineRoot(pdf)
  } catch {
    warnings.push('The bookmarks structure is damaged and was ignored.')
    return { nodes: [], warnings }
  }
  if (!root) return { nodes: [], warnings }
  const resolver = new DestResolver(pdf, pdf.getPages().map((p) => p.ref))
  const ctx = pdf.context
  const budget = { left: MAX_NODES }
  let unresolved = 0

  const build = (parent: PDFDict, depth: number): OutlineNode[] => {
    if (depth > MAX_DEPTH) return []
    const nodes: OutlineNode[] = []
    for (const { dict } of childrenOf(ctx, parent, budget)) {
      try {
        const titleObj = dict.lookup(N('Title'))
        const title = textOf(titleObj)?.replace(/\s+/g, ' ').trim() || 'Untitled'
        const r = resolver.resolveItem(dict)
        let dest: OutlineDest | null = null
        if (r.type === 'page') dest = { pageIndex: resolver.indexOf(r.ref)!, tail: r.tail }
        else unresolved++
        const count = dict.lookupMaybe(N('Count'), PDFNumber)?.asNumber() ?? 0
        nodes.push({ title, dest, open: count > 0, children: build(dict, depth + 1) })
      } catch {
        warnings.push('One bookmark was damaged and was skipped.')
      }
    }
    return nodes
  }
  const nodes = build(root, 0)
  if (budget.left <= 0) warnings.push('The bookmarks were cut short because the outline is unusually large or circular.')
  if (unresolved > 0) warnings.push(`${unresolved} bookmark${unresolved === 1 ? '' : 's'} had no usable page destination.`)
  return { nodes, warnings }
}

/** The first page a node (or, failing that, one of its descendants) points at. */
export function firstPageOf(node: OutlineNode): number | null {
  if (node.dest) return node.dest.pageIndex
  for (const c of node.children) {
    const p = firstPageOf(c)
    if (p !== null) return p
  }
  return null
}

/**
 * Builds a subset of an outline for a document made of some of the source's pages. `pageMap` maps a
 * source page index to its index in the new document; items whose page is not in the map lose their
 * destination, and items left with neither a destination nor children are dropped.
 */
export function remapOutlineNodes(nodes: OutlineNode[], pageMap: (sourceIndex: number) => number | undefined): OutlineNode[] {
  const out: OutlineNode[] = []
  for (const n of nodes) {
    const children = remapOutlineNodes(n.children, pageMap)
    const mapped = n.dest ? pageMap(n.dest.pageIndex) : undefined
    if (mapped === undefined && children.length === 0) continue
    out.push({ title: n.title, dest: mapped === undefined || !n.dest ? null : { pageIndex: mapped, tail: n.dest.tail }, open: n.open, children })
  }
  return out
}

const visibleCount = (n: OutlineNode): number => n.children.reduce((sum, c) => sum + 1 + (c.open ? visibleCount(c) : 0), 0)

/** Replaces the document's outline with `nodes` (destinations refer to the document's current pages). */
export function writeOutline(pdf: PDFDocument, nodes: OutlineNode[]): void {
  const ctx = pdf.context
  const pageRefs = pdf.getPages().map((p) => p.ref)
  if (nodes.length === 0) {
    pdf.catalog.delete(N('Outlines'))
    return
  }
  const rootRef = ctx.nextRef()
  const rootDict = ctx.obj({ Type: 'Outlines' })
  ctx.assign(rootRef, rootDict)

  const build = (list: OutlineNode[], parentRef: PDFRef): { first: PDFRef; last: PDFRef } => {
    const refs = list.map(() => ctx.nextRef())
    list.forEach((node, i) => {
      const dict = ctx.obj({ Title: PDFHexString.fromText(node.title), Parent: parentRef }) as PDFDict
      if (i > 0) dict.set(N('Prev'), refs[i - 1])
      if (i < list.length - 1) dict.set(N('Next'), refs[i + 1])
      if (node.dest && node.dest.pageIndex >= 0 && node.dest.pageIndex < pageRefs.length) {
        const tail = node.dest.tail.length ? node.dest.tail : ['Fit']
        dict.set(N('Dest'), ctx.obj([pageRefs[node.dest.pageIndex], ...tail]))
      }
      if (node.children.length) {
        const { first, last } = build(node.children, refs[i])
        dict.set(N('First'), first)
        dict.set(N('Last'), last)
        const v = visibleCount(node)
        dict.set(N('Count'), PDFNumber.of(node.open ? v : -v))
      }
      ctx.assign(refs[i], dict)
    })
    return { first: refs[0], last: refs[refs.length - 1] }
  }
  const { first, last } = build(nodes, rootRef)
  rootDict.set(N('First'), first)
  rootDict.set(N('Last'), last)
  rootDict.set(N('Count'), PDFNumber.of(visibleCount({ title: '', dest: null, open: true, children: nodes })))
  pdf.catalog.set(N('Outlines'), rootRef)
}

/**
 * After pages were removed: drops outline destinations that point at pages that no longer exist. Items
 * that lose their destination but still have children keep their title (and children); items left
 * with nothing to go to are removed. Everything else about the items (colors, styles...) is untouched.
 * Returns how many items were removed.
 */
export function dropDanglingOutline(pdf: PDFDocument): number {
  const root = outlineRoot(pdf)
  if (!root) return 0
  const ctx = pdf.context
  const resolver = new DestResolver(pdf, pdf.getPages().map((p) => p.ref))
  const budget = { left: MAX_NODES }
  let removed = 0

  /** Fixes the subtree under `parent`; returns the number of items now visible below it. */
  const fix = (parent: PDFDict, depth: number): number => {
    const kids = childrenOf(ctx, parent, budget)
    const keep: { dict: PDFDict; ref: PDFRef | undefined }[] = []
    for (const kid of kids) {
      const before = kid.dict.has(N('First'))
      if (depth < MAX_DEPTH && before) fix(kid.dict, depth + 1)
      const remainingChildren = kid.dict.has(N('First'))
      const r = resolver.resolveItem(kid.dict)
      if (r.type === 'dead') {
        kid.dict.delete(N('Dest'))
        const action = kid.dict.lookupMaybe(N('A'), PDFDict)
        if (action?.lookupMaybe(N('S'), PDFName)?.decodeText() === 'GoTo') kid.dict.delete(N('A'))
        if (!remainingChildren) {
          removed++
          continue
        }
      }
      keep.push(kid)
    }
    relink(parent, keep)
    return keep.length
  }

  const relink = (parent: PDFDict, list: { dict: PDFDict; ref: PDFRef | undefined }[]): void => {
    list.forEach((k, i) => {
      if (i > 0 && list[i - 1].ref) k.dict.set(N('Prev'), list[i - 1].ref!)
      else k.dict.delete(N('Prev'))
      if (i < list.length - 1 && list[i + 1].ref) k.dict.set(N('Next'), list[i + 1].ref!)
      else k.dict.delete(N('Next'))
    })
    if (list.length && list[0].ref && list[list.length - 1].ref) {
      parent.set(N('First'), list[0].ref!)
      parent.set(N('Last'), list[list.length - 1].ref!)
    } else {
      parent.delete(N('First'))
      parent.delete(N('Last'))
      parent.delete(N('Count'))
    }
  }

  fix(root, 0)
  if (root.has(N('First'))) recount(ctx, root, 0)
  else pdf.catalog.delete(N('Outlines')) // nothing left: no empty outline
  return removed
}

/** Recomputes /Count for every node (open nodes positive, closed negative) after the tree changed. */
function recount(ctx: PDFContext, node: PDFDict, depth: number): number {
  const budget = { left: MAX_NODES }
  let visible = 0
  for (const { dict } of childrenOf(ctx, node, budget)) {
    visible += 1
    const below = depth < MAX_DEPTH ? recount(ctx, dict, depth + 1) : 0
    const oldCount = dict.lookupMaybe(N('Count'), PDFNumber)?.asNumber() ?? 0
    if (below === 0) {
      dict.delete(N('Count'))
    } else {
      const open = oldCount > 0
      dict.set(N('Count'), PDFNumber.of(open ? below : -below))
      if (open) visible += below
    }
  }
  if (depth === 0) node.set(N('Count'), PDFNumber.of(visible))
  return visible
}

/** Removes link annotations' (and the document's open action) dead destinations after pages were removed. */
export function dropDanglingLinks(pdf: PDFDocument): number {
  const resolver = new DestResolver(pdf, pdf.getPages().map((p) => p.ref))
  let fixed = 0
  for (const page of pdf.getPages()) {
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray)
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i)
      if (!(a instanceof PDFDict) || a.lookupMaybe(N('Subtype'), PDFName)?.decodeText() !== 'Link') continue
      if (resolver.resolveItem(a).type !== 'dead') continue
      a.delete(N('Dest'))
      const action = a.lookupMaybe(N('A'), PDFDict)
      if (action?.lookupMaybe(N('S'), PDFName)?.decodeText() === 'GoTo') a.delete(N('A'))
      fixed++
    }
  }
  const open = pdf.catalog.get(N('OpenAction'))
  if (open && resolver.resolveDest(open).type === 'dead') {
    pdf.catalog.delete(N('OpenAction'))
    fixed++
  }
  return fixed
}
