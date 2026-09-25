import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFObjectCopier,
  PDFRef,
  PDFString,
  type PDFPage
} from 'pdf-lib'
import { parsePageRange } from '../../../shared/features/combine'

/**
 * Merges PDFs with pdf-lib: page sizes/rotation are preserved (pages are copied, never redrawn), each source's
 * bookmarks are rebuilt as nested bookmarks under one bookmark per file, internal links are re-pointed at the
 * copied pages, and form fields are merged into one AcroForm with clashing field names renamed.
 *
 * Not carried over (documented in docs/features/create-export.md): document JavaScript, named destinations,
 * page labels, the tag structure tree, XFA forms, and attachments.
 */

export class MergeError extends Error {
  constructor(
    readonly file: string,
    message: string
  ) {
    super(message)
  }
}

export interface MergeInput {
  name: string
  bytes: Uint8Array
  /** 0-based page indexes to take, in order. Default: every page. */
  pages?: number[]
  /** Page range text such as `1-3, 5` (used when `pages` is not given); resolved once the page count is known. */
  rangeText?: string
}

export interface MergeOptions {
  /** One bookmark per input file (with that file's own bookmarks nested below it). */
  bookmarks: boolean
}

export interface MergeResult {
  bytes: Uint8Array
  pageCount: number
  renamedFields: { file: string; from: string; to: string }[]
}

const N = (s: string): PDFName => PDFName.of(s)

export async function loadSource(name: string, bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/encrypt/i.test(msg)) {
      throw new MergeError(name, `“${name}” is password protected or restricted, so it cannot be merged. Remove the protection first (open it, enter the password and save an unprotected copy), then add that copy.`)
    }
    throw new MergeError(name, `“${name}” is damaged or is not a valid PDF, so it cannot be merged (${msg}).`)
  }
}

const textOf = (o: PDFObject | undefined): string | null => {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText()
  if (o instanceof PDFName) return o.decodeText()
  return null
}

const fileTitle = (name: string): string => name.replace(/\.pdf$/i, '')

// ---------------------------------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------------------------------

/** Finds a value in a name tree (`/Names` leaf arrays, `/Kids` intermediate nodes). */
function lookupNameTree(node: PDFDict | undefined, key: string, depth = 0): PDFObject | undefined {
  if (!node || depth > 32) return undefined
  const names = node.lookupMaybe(N('Names'), PDFArray)
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      if (textOf(names.lookup(i)) === key) return names.get(i + 1)
    }
  }
  const kids = node.lookupMaybe(N('Kids'), PDFArray)
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const hit = lookupNameTree(kids.lookupMaybe(i, PDFDict), key, depth + 1)
      if (hit) return hit
    }
  }
  return undefined
}

/** Resolves a /Dest value (explicit array, or a named destination) to an explicit destination array. */
function explicitDest(doc: PDFDocument, dest: PDFObject | undefined): PDFArray | null {
  const ctx = doc.context
  let d: PDFObject | undefined = dest ? ctx.lookup(dest) : undefined
  if (d instanceof PDFName || d instanceof PDFString || d instanceof PDFHexString) {
    const key = textOf(d)!
    const legacy = doc.catalog.lookupMaybe(N('Dests'), PDFDict)?.get(N(key))
    const tree = lookupNameTree(doc.catalog.lookupMaybe(N('Names'), PDFDict)?.lookupMaybe(N('Dests'), PDFDict), key)
    d = ctx.lookup(legacy ?? tree)
  }
  if (d instanceof PDFDict) d = d.lookup(N('D'))
  return d instanceof PDFArray && d.size() > 0 && d.get(0) instanceof PDFRef ? d : null
}

const tag = (r: PDFRef): string => r.tag

/** Rebuilds `[newPageRef, ...rest]` from an explicit destination whose page is `page`. */
function retarget(ctx: PDFContext, dest: PDFArray, page: PDFRef): PDFArray {
  const items: PDFObject[] = [page]
  for (let i = 1; i < dest.size(); i++) items.push(dest.get(i))
  return ctx.obj(items)
}

// ---------------------------------------------------------------------------------------------------
// Outlines
// ---------------------------------------------------------------------------------------------------

interface Bookmark {
  title: string
  /** Index into the OUTPUT document, or null when the source target is not part of the output. */
  page: number | null
  rest: PDFObject[]
  open: boolean
  color?: PDFObject
  flags?: number
  children: Bookmark[]
}

function readOutline(doc: PDFDocument, pageMap: Map<string, number>): Bookmark[] {
  const root = doc.catalog.lookupMaybe(N('Outlines'), PDFDict)
  if (!root) return []
  const seen = new Set<PDFDict>()
  const walk = (first: PDFObject | undefined, depth: number): Bookmark[] => {
    const out: Bookmark[] = []
    let cur = first ? doc.context.lookupMaybe(first, PDFDict) : undefined
    let guard = 0
    while (cur && !seen.has(cur) && guard++ < 100000) {
      seen.add(cur)
      const title = textOf(cur.lookup(N('Title'))) ?? 'Untitled'
      let dest: PDFArray | null = explicitDest(doc, cur.get(N('Dest')))
      if (!dest) {
        const a = cur.lookupMaybe(N('A'), PDFDict)
        if (a && a.lookupMaybe(N('S'), PDFName)?.decodeText() === 'GoTo') dest = explicitDest(doc, a.get(N('D')))
      }
      const srcRef = dest ? (dest.get(0) as PDFRef) : null
      const page = srcRef ? (pageMap.get(tag(srcRef)) ?? null) : null
      const children = depth < 64 ? walk(cur.get(N('First')), depth + 1) : []
      const count = cur.lookupMaybe(N('Count'), PDFNumber)?.asNumber() ?? 0
      const keep = page !== null || children.length > 0
      if (keep) {
        const rest: PDFObject[] = []
        if (dest) for (let i = 1; i < dest.size(); i++) rest.push(dest.get(i))
        out.push({
          title,
          page,
          rest,
          open: count > 0,
          color: cur.get(N('C')),
          flags: cur.lookupMaybe(N('F'), PDFNumber)?.asNumber(),
          children
        })
      }
      cur = cur.get(N('Next')) ? doc.context.lookupMaybe(cur.get(N('Next')) as PDFObject, PDFDict) : undefined
    }
    return out
  }
  return walk(root.get(N('First')), 0)
}

const visible = (items: Bookmark[]): number => items.reduce((n, b) => n + 1 + (b.open ? visible(b.children) : 0), 0)
const descendants = (items: Bookmark[]): number => items.reduce((n, b) => n + 1 + descendants(b.children), 0)

function writeOutline(out: PDFDocument, items: Bookmark[], pageRefs: PDFRef[]): void {
  if (items.length === 0) return
  const ctx = out.context
  const rootRef = ctx.nextRef()
  const build = (level: Bookmark[], parent: PDFRef): PDFRef[] => {
    const refs = level.map(() => ctx.nextRef())
    level.forEach((b, i) => {
      const dict = ctx.obj({}) as PDFDict
      dict.set(N('Title'), PDFHexString.fromText(b.title))
      dict.set(N('Parent'), parent)
      if (i > 0) dict.set(N('Prev'), refs[i - 1])
      if (i < level.length - 1) dict.set(N('Next'), refs[i + 1])
      if (b.page !== null && pageRefs[b.page]) {
        dict.set(N('Dest'), b.rest.length ? retarget(ctx, ctx.obj([pageRefs[b.page], ...b.rest]) as PDFArray, pageRefs[b.page]) : ctx.obj([pageRefs[b.page], N('Fit')]))
      }
      if (b.color) dict.set(N('C'), b.color)
      if (b.flags) dict.set(N('F'), PDFNumber.of(b.flags))
      if (b.children.length) {
        const kids = build(b.children, refs[i])
        dict.set(N('First'), kids[0])
        dict.set(N('Last'), kids[kids.length - 1])
        const n = b.open ? visible(b.children) : descendants(b.children)
        dict.set(N('Count'), PDFNumber.of(b.open ? n : -n))
      }
      ctx.assign(refs[i], dict)
    })
    return refs
  }
  const tops = build(items, rootRef)
  const root = ctx.obj({ Type: 'Outlines', First: tops[0], Last: tops[tops.length - 1], Count: visible(items) })
  ctx.assign(rootRef, root)
  out.catalog.set(N('Outlines'), rootRef)
}

// ---------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------

interface FormState {
  acro: PDFDict | null
  fields: PDFArray | null
  /** Fully-qualified names already used by earlier files. */
  used: Set<string>
  needAppearances: boolean
  renamed: { file: string; from: string; to: string }[]
}

function ensureAcroForm(out: PDFDocument, st: FormState): { acro: PDFDict; fields: PDFArray } {
  if (!st.acro || !st.fields) {
    st.fields = out.context.obj([])
    st.acro = out.context.obj({ Fields: st.fields }) as PDFDict
    out.catalog.set(N('AcroForm'), out.context.register(st.acro))
  }
  return { acro: st.acro, fields: st.fields }
}

function uniqueName(base: string, used: Set<string>): string {
  for (let i = 2; ; i++) {
    const cand = `${base}_${i}`
    if (!used.has(cand)) return cand
  }
}

/** Adds the fields behind the copied widgets to the output AcroForm, renaming top-level names that clash. */
function mergeForm(out: PDFDocument, src: PDFDocument, copied: PDFPage[], file: string, st: FormState, copier: PDFObjectCopier): void {
  const roots = new Map<string, PDFRef>() // ref tag -> ref (insertion ordered)
  for (const page of copied) {
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray)
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i)
      if (!(ref instanceof PDFRef)) continue
      const d = out.context.lookupMaybe(ref, PDFDict)
      if (!d || d.lookupMaybe(N('Subtype'), PDFName)?.decodeText() !== 'Widget') continue
      let topRef: PDFRef = ref
      let top: PDFDict = d
      for (let hops = 0; hops < 64; hops++) {
        const p = top.get(N('Parent'))
        if (!(p instanceof PDFRef)) break
        const pd = out.context.lookupMaybe(p, PDFDict)
        if (!pd) break
        topRef = p
        top = pd
      }
      roots.set(tag(topRef), topRef)
    }
  }
  const srcAcro = src.catalog.lookupMaybe(N('AcroForm'), PDFDict)
  if (roots.size === 0 && !srcAcro) return
  const { acro, fields } = ensureAcroForm(out, st)
  const myNames = new Set<string>()
  for (const ref of roots.values()) {
    const f = out.context.lookup(ref, PDFDict)
    let name = textOf(f.get(N('T'))) ?? ''
    if (name && st.used.has(name)) {
      const renamed = uniqueName(name, new Set([...st.used, ...myNames]))
      st.renamed.push({ file, from: name, to: renamed })
      f.set(N('T'), PDFHexString.fromText(renamed))
      name = renamed
    }
    if (name) myNames.add(name)
    fields.push(ref)
  }
  for (const n of myNames) st.used.add(n)

  if (srcAcro) {
    if (srcAcro.lookupMaybe(N('NeedAppearances'), PDFBool)?.asBoolean()) st.needAppearances = true
    if (!acro.get(N('DA')) && srcAcro.get(N('DA'))) acro.set(N('DA'), copier.copy(srcAcro.get(N('DA'))!))
    // Default resources: keep the first definition of every named font/xobject/etc.
    const dr = srcAcro.lookupMaybe(N('DR'), PDFDict)
    if (dr) {
      let outDr = acro.lookupMaybe(N('DR'), PDFDict)
      if (!outDr) {
        outDr = out.context.obj({}) as PDFDict
        acro.set(N('DR'), outDr)
      }
      for (const [cat, val] of dr.entries()) {
        const srcCat = src.context.lookupMaybe(val, PDFDict)
        if (!srcCat) continue
        let outCat = outDr.lookupMaybe(cat, PDFDict)
        if (!outCat) {
          outCat = out.context.obj({}) as PDFDict
          outDr.set(cat, outCat)
        }
        for (const [k, v] of srcCat.entries()) if (!outCat.has(k)) outCat.set(k, copier.copy(v))
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Links (kept working across the copy)
// ---------------------------------------------------------------------------------------------------

interface PendingLink {
  outIndex: number
  annotIndex: number
  dest: PDFArray
  viaAction: boolean
}

/**
 * pdf-lib copies a page's annotations with everything they reference, which for link destinations and
 * widget `/P` back-pointers would drag whole other pages along as orphans. So before copying we lift those
 * references out of the source, and afterwards re-attach them to the copied pages.
 */
function liftPageReferences(src: PDFDocument, pageIdx: number, outIndex: number, links: PendingLink[]): void {
  const page = src.getPage(pageIdx)
  const annots = page.node.lookupMaybe(N('Annots'), PDFArray)
  if (!annots) return
  for (let j = 0; j < annots.size(); j++) {
    const a = annots.lookupMaybe(j, PDFDict)
    if (!a) continue
    a.delete(N('P'))
    const direct = a.get(N('Dest'))
    if (direct) {
      const dest = explicitDest(src, direct)
      a.delete(N('Dest'))
      if (dest) links.push({ outIndex, annotIndex: j, dest, viaAction: false })
      continue
    }
    const act = a.lookupMaybe(N('A'), PDFDict)
    if (act && act.lookupMaybe(N('S'), PDFName)?.decodeText() === 'GoTo') {
      const dest = explicitDest(src, act.get(N('D')))
      a.delete(N('A'))
      if (dest) links.push({ outIndex, annotIndex: j, dest, viaAction: true })
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------------------------------

export async function mergePdfs(
  inputs: MergeInput[],
  opts: MergeOptions,
  onProgress?: (fraction: number, message?: string) => void
): Promise<MergeResult> {
  if (inputs.length === 0) throw new Error('There is nothing to combine.')
  const out = await PDFDocument.create()
  const form: FormState = { acro: null, fields: null, used: new Set(), needAppearances: false, renamed: [] }
  const outline: Bookmark[] = []
  const pageRefs: PDFRef[] = []

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]
    onProgress?.(i / inputs.length, `Merging ${input.name}`)
    const src = await loadSource(input.name, input.bytes)
    let indices = input.pages
    if (!indices) {
      const parsed = parsePageRange(input.rangeText, src.getPageCount())
      if (!parsed.ok) throw new MergeError(input.name, `Pages for “${input.name}”: ${parsed.error}`)
      indices = parsed.pages
    }
    for (const idx of indices) if (idx < 0 || idx >= src.getPageCount()) throw new MergeError(input.name, `“${input.name}” has no page ${idx + 1}.`)
    if (indices.length === 0) throw new MergeError(input.name, `No pages were selected from “${input.name}”.`)

    const firstOut = pageRefs.length
    const pageMap = new Map<string, number>() // source page ref tag -> output page index (first use)
    indices.forEach((idx, k) => {
      const t = tag(src.getPage(idx).ref)
      if (!pageMap.has(t)) pageMap.set(t, firstOut + k)
    })
    const bookmarks = readOutline(src, pageMap) // read before lifting anything out of the source

    const links: PendingLink[] = []
    indices.forEach((idx, k) => liftPageReferences(src, idx, k, links))

    const copier = PDFObjectCopier.for(src.context, out.context)
    const copied = await out.copyPages(src, indices)
    for (const p of copied) {
      out.addPage(p)
      pageRefs.push(p.ref)
    }
    // re-attach links and widget back-pointers
    copied.forEach((p, k) => {
      const annots = p.node.lookupMaybe(N('Annots'), PDFArray)
      if (!annots) return
      for (let j = 0; j < annots.size(); j++) {
        const a = annots.lookupMaybe(j, PDFDict)
        if (a) a.set(N('P'), p.ref)
      }
      for (const l of links) {
        if (l.outIndex !== k) continue
        const a = annots.lookupMaybe(l.annotIndex, PDFDict)
        const target = pageMap.get(tag(l.dest.get(0) as PDFRef))
        if (!a || target === undefined) continue // destination page not part of the output: the link is inert
        const d = retarget(out.context, l.dest, pageRefs[target])
        if (l.viaAction) a.set(N('A'), out.context.obj({ Type: 'Action', S: 'GoTo', D: d }))
        else a.set(N('Dest'), d)
      }
    })
    mergeForm(out, src, copied, input.name, form, copier)

    if (opts.bookmarks) {
      outline.push({ title: fileTitle(input.name), page: firstOut, rest: [N('Fit')], open: true, children: bookmarks })
    } else {
      outline.push(...bookmarks)
    }
    await new Promise((r) => setTimeout(r, 0))
  }

  if (form.acro && form.needAppearances) form.acro.set(N('NeedAppearances'), PDFBool.True)
  writeOutline(out, outline, pageRefs)
  out.setProducer('Epdf')
  out.setCreator('Epdf')
  out.setCreationDate(new Date())
  out.setModificationDate(new Date())
  onProgress?.(0.95, 'Saving')
  const bytes = await out.save()
  return { bytes, pageCount: pageRefs.length, renamedFields: form.renamed }
}

/** Reads the page count of a PDF, or explains why it cannot be read (used by the file picker). */
export async function probePdf(name: string, bytes: Uint8Array): Promise<{ pages: number } | { problem: string }> {
  try {
    const d = await loadSource(name, bytes)
    return { pages: d.getPageCount() }
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) }
  }
}
