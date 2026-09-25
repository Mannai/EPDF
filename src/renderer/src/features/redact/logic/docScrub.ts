import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFRef, PDFStream, PDFString, type PDFContext, type PDFDocument, type PDFObject } from 'pdf-lib'
import { N, darr, ddict, dget, dname, nameText, numbers, refTag, streamBytes } from '../../textedit/pdfcontent/pdfutil'
import { extractStreamText } from './extract'
import { intersect, type Rect } from './geom'
import { decodeTextString, encodeTextString } from './pdfconv'

/**
 * Everything outside the page content that can hold redacted text or hidden data: annotations and form fields,
 * bookmarks, named destinations, document metadata (Info and XMP), thumbnails, attachments, JavaScript, page
 * labels, and finally a garbage collection that drops every object no longer reachable from the trailer (so
 * nothing from replaced streams, earlier revisions or deleted objects survives the rewrite).
 */

export interface ScrubOptions {
  /** Strip all document metadata (Info, XMP, thumbnails, piece info), not only what mentions marked text. */
  removeMetadata: boolean
  /** Also remove attachments, JavaScript, page labels, form tooltips and other hidden data. */
  removeHidden: boolean
}

export interface ScrubReport {
  annotations: number
  formFields: number
  strings: number
  metadata: number
  namedDests: number
  thumbnails: number
  attachments: number
  javascript: number
  hidden: number
  orphans: number
}

export const newScrubReport = (): ScrubReport => ({ annotations: 0, formFields: 0, strings: 0, metadata: 0, namedDests: 0, thumbnails: 0, attachments: 0, javascript: 0, hidden: 0, orphans: 0 })

const REDACTED = '[redacted]'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Case-insensitive matcher for the secrets (longest first), or null when there are none. */
export function secretRegex(secrets: readonly string[]): RegExp | null {
  const list = [...new Set(secrets.map((s) => s.trim()).filter((s) => s.length >= 3))].sort((a, b) => b.length - a.length)
  if (list.length === 0) return null
  return new RegExp(list.map((s) => escapeRe(s).replace(/\s+/g, '\\s+')).join('|'), 'gi')
}

const strText = (o: PDFObject | undefined): string | undefined => (o instanceof PDFString || o instanceof PDFHexString ? decodeTextString(o.asBytes()) : undefined)

const has = (re: RegExp | null, s: string | undefined): boolean => {
  if (!re || !s) return false
  re.lastIndex = 0
  return re.test(s)
}

function* indirect(ctx: PDFContext): Generator<[PDFRef, PDFObject]> {
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) yield [ref, obj]
}

// ---------------------------------------------------------------------------------------------------------
// Annotations and form fields

function rectOf(d: PDFDict): Rect | null {
  const r = numbers(darr(d, 'Rect'))
  if (r.length !== 4 || !r.every(Number.isFinite)) return null
  return { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) }
}

const TEXT_KEYS = ['Contents', 'RC', 'T', 'Subj', 'TU', 'V', 'DV', 'TM', 'Alt', 'ActualText']

/** Does an annotation carry redacted text in its strings, rich text, or in the text drawn by its appearance? */
export function annotationHasSecret(pdf: PDFDocument, d: PDFDict, re: RegExp | null): boolean {
  if (!re) return false
  for (const k of TEXT_KEYS) {
    const v = dget(d, k)
    if (has(re, strText(v))) return true
    if (v instanceof PDFStream) {
      try {
        if (has(re, new TextDecoder().decode(streamBytes(v)))) return true
      } catch {
        /* unreadable: ignore */
      }
    }
  }
  const ap = ddict(d, 'AP')
  if (ap) {
    for (const [, v] of ap.entries()) {
      const target = v instanceof PDFRef ? pdf.context.lookup(v) : v
      const streams: PDFStream[] = []
      if (target instanceof PDFStream) streams.push(target)
      else if (target instanceof PDFDict) {
        for (const [, sv] of target.entries()) {
          const s = sv instanceof PDFRef ? pdf.context.lookup(sv) : sv
          if (s instanceof PDFStream) streams.push(s)
        }
      }
      for (const s of streams) if (has(re, extractStreamText(pdf, s))) return true
    }
  }
  return false
}

function detachField(pdf: PDFDocument, widgetRef: PDFRef | undefined, widget: PDFDict): void {
  const ctx = pdf.context
  const parentRaw = widget.get(N('Parent'))
  const parent = parentRaw instanceof PDFRef ? ctx.lookup(parentRaw) : undefined
  const acro = ddict(pdf.catalog, 'AcroForm')
  const removeFrom = (arr: PDFArray | undefined, ref: PDFRef | undefined): boolean => {
    if (!arr || !ref) return false
    for (let i = arr.size() - 1; i >= 0; i--) {
      const it = arr.get(i)
      if (it instanceof PDFRef && it.objectNumber === ref.objectNumber) {
        arr.remove(i)
        return true
      }
    }
    return false
  }
  if (parent instanceof PDFDict && parentRaw instanceof PDFRef) {
    const kids = darr(parent, 'Kids')
    removeFrom(kids, widgetRef)
    if (kids && kids.size() === 0) detachField(pdf, parentRaw, parent)
  } else if (acro) removeFrom(darr(acro, 'Fields'), widgetRef)
}

/** Removes the annotations under the marks (and those carrying redacted text) from every page. */
export function scrubAnnotations(pdf: PDFDocument, marksByPage: ReadonlyMap<number, readonly Rect[]>, re: RegExp | null, report: ScrubReport): boolean {
  const ctx = pdf.context
  let needAppearances = false
  const pages = pdf.getPages()
  pages.forEach((page, pi) => {
    const arr = page.node.Annots()
    if (!arr) return
    const marks = marksByPage.get(pi) ?? []
    const entries: { raw: PDFObject; ref: PDFRef | undefined; dict: PDFDict | undefined }[] = []
    for (let i = 0; i < arr.size(); i++) {
      const raw = arr.get(i)
      const obj = raw instanceof PDFRef ? ctx.lookup(raw) : raw
      entries.push({ raw, ref: raw instanceof PDFRef ? raw : undefined, dict: obj instanceof PDFDict ? obj : undefined })
    }
    const removed = new Set<number>()
    entries.forEach((e, idx) => {
      if (!e.dict) return
      const r = rectOf(e.dict)
      const under = !!r && marks.some((m) => intersect(r, m) !== null)
      const isWidget = dname(e.dict, 'Subtype') === 'Widget'
      const secret = annotationHasSecret(pdf, e.dict, re)
      if (under || (secret && !isWidget)) removed.add(idx)
      else if (secret && isWidget) {
        // a field elsewhere shows redacted text: clear what it displays and let the viewer redraw it
        e.dict.delete(N('AP'))
        for (const k of ['V', 'DV']) {
          const t = strText(dget(e.dict, k))
          if (has(re, t)) e.dict.set(N(k), encodeTextString(t!.replace(re!, REDACTED)))
        }
        needAppearances = true
        report.formFields++
      }
    })
    // popups and replies of removed annotations go too
    const refKey = (o: PDFObject | undefined): string | undefined => (o instanceof PDFRef ? refTag(o) : undefined)
    let grew = true
    while (grew) {
      grew = false
      const gone = new Set<string>()
      removed.forEach((i) => {
        const k = entries[i].ref ? refTag(entries[i].ref!) : undefined
        if (k) gone.add(k)
      })
      entries.forEach((e, idx) => {
        if (removed.has(idx) || !e.dict) return
        const parent = refKey(e.dict.get(N('Parent')))
        const irt = refKey(e.dict.get(N('IRT')))
        const isPopup = dname(e.dict, 'Subtype') === 'Popup'
        if ((isPopup && parent && gone.has(parent)) || (irt && gone.has(irt))) {
          removed.add(idx)
          grew = true
        }
      })
    }
    if (removed.size === 0) return
    const keep: PDFObject[] = []
    entries.forEach((e, idx) => {
      if (!removed.has(idx)) keep.push(e.raw)
      else {
        report.annotations++
        if (e.dict && dname(e.dict, 'Subtype') === 'Widget') {
          detachField(pdf, e.ref, e.dict)
          report.formFields++
        }
      }
    })
    page.node.set(N('Annots'), ctx.obj(keep as never))
  })
  return needAppearances
}

// ---------------------------------------------------------------------------------------------------------
// Strings everywhere

function scrubValue(v: PDFObject, re: RegExp): PDFObject | null {
  if (!(v instanceof PDFString || v instanceof PDFHexString)) return null
  const t = decodeTextString(v.asBytes())
  re.lastIndex = 0
  if (!re.test(t)) return null
  re.lastIndex = 0
  return encodeTextString(t.replace(re, REDACTED))
}

const SKIP_KEYS = new Set(['ID', 'O', 'U', 'OE', 'UE', 'Perms', 'Contents_'])

/** Replaces marked text inside every text string of every object (Info, bookmarks, fields, structure, ...). */
export function scrubAllStrings(pdf: PDFDocument, re: RegExp | null, report: ScrubReport): PDFDict[] {
  const touched: PDFDict[] = []
  if (!re) return touched
  const walk = (o: PDFObject, depth: number): void => {
    if (depth > 30) return
    if (o instanceof PDFStream) return walk(o.dict, depth + 1)
    if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) {
        const key = nameText(k)
        if (SKIP_KEYS.has(key)) continue
        const rep = scrubValue(v, re)
        if (rep) {
          o.set(k, rep)
          report.strings++
          if (key === 'V' || key === 'DV') touched.push(o)
        } else if (v instanceof PDFDict || v instanceof PDFArray) walk(v, depth + 1)
      }
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i)
        const rep = scrubValue(v, re)
        if (rep) {
          o.set(i, rep)
          report.strings++
        } else if (v instanceof PDFDict || v instanceof PDFArray) walk(v, depth + 1)
      }
    }
  }
  for (const [, obj] of indirect(pdf.context)) walk(obj, 0)
  return touched
}

// ---------------------------------------------------------------------------------------------------------
// Named destinations

function fixNameTree(pdf: PDFDocument, node: PDFDict, re: RegExp, report: ScrubReport): [string, string] | null {
  const names = darr(node, 'Names')
  const kids = darr(node, 'Kids')
  let lo: string | null = null
  let hi: string | null = null
  const bump = (a: string, b: string): void => {
    if (lo === null || a < lo) lo = a
    if (hi === null || b > hi) hi = b
  }
  if (names) {
    const keep: PDFObject[] = []
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const k = strText(names.lookup(i))
      if (k !== undefined && has(re, k)) {
        report.namedDests++
        continue
      }
      keep.push(names.get(i), names.get(i + 1))
      if (k !== undefined) bump(k, k)
    }
    node.set(N('Names'), pdf.context.obj(keep as never))
  }
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookup(i)
      if (kid instanceof PDFDict) {
        const lim = fixNameTree(pdf, kid, re, report)
        if (lim) bump(lim[0], lim[1])
      }
    }
  }
  if (lo !== null && hi !== null && node.has(N('Limits'))) node.set(N('Limits'), pdf.context.obj([encodeTextString(lo), encodeTextString(hi)] as never))
  return lo !== null && hi !== null ? [lo, hi] : null
}

export function scrubNamedDests(pdf: PDFDocument, re: RegExp | null, report: ScrubReport): void {
  if (!re) return
  const root = pdf.catalog
  const names = ddict(root, 'Names')
  const dests = names ? ddict(names, 'Dests') : undefined
  if (dests) fixNameTree(pdf, dests, re, report)
  const legacy = ddict(root, 'Dests')
  if (legacy) {
    for (const [k] of legacy.entries()) {
      if (has(re, nameText(k))) {
        legacy.delete(k)
        report.namedDests++
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Metadata, thumbnails, hidden data

function isXmp(o: PDFObject): o is PDFStream {
  return o instanceof PDFStream && dname(o.dict, 'Type') === 'Metadata'
}

export function scrubMetadata(pdf: PDFDocument, re: RegExp | null, redactedPages: ReadonlySet<number>, opts: ScrubOptions, report: ScrubReport): void {
  const ctx = pdf.context
  const catalog = pdf.catalog
  const strip = (dict: PDFDict, key: string): void => {
    if (dict.has(N(key))) {
      dict.delete(N(key))
      report.metadata++
    }
  }
  if (opts.removeMetadata) {
    strip(catalog, 'Metadata')
    strip(catalog, 'PieceInfo')
    for (const p of pdf.getPages()) {
      strip(p.node, 'Metadata')
      strip(p.node, 'PieceInfo')
      strip(p.node, 'LastModified')
    }
    // Info: drop everything (the edit pipeline writes its own Producer/ModDate afterwards)
    const infoRef = ctx.trailerInfo.Info
    if (infoRef) {
      const fresh = ctx.obj({})
      if (infoRef instanceof PDFRef) ctx.assign(infoRef, fresh)
      report.metadata++
    }
    // any other XMP block (fonts, images, forms, ...)
    for (const [ref, obj] of indirect(ctx)) {
      if (isXmp(obj)) {
        ctx.delete(ref)
        report.metadata++
      } else if (obj instanceof PDFStream) {
        if (obj.dict.has(N('Metadata'))) {
          obj.dict.delete(N('Metadata'))
          report.metadata++
        }
      } else if (obj instanceof PDFDict && obj.has(N('Metadata')) && obj !== catalog) {
        obj.delete(N('Metadata'))
        report.metadata++
      }
    }
  } else if (re) {
    // XMP packets that mention marked text: replace the text inside the packet
    for (const [ref, obj] of indirect(ctx)) {
      if (!isXmp(obj)) continue
      let raw: Uint8Array
      try {
        raw = streamBytes(obj)
      } catch {
        ctx.delete(ref)
        report.metadata++
        continue
      }
      const text = new TextDecoder('utf-8').decode(raw)
      re.lastIndex = 0
      if (!re.test(text)) continue
      re.lastIndex = 0
      const clean = text.replace(re, REDACTED)
      const dict: Record<string, PDFObject> = {}
      for (const [k, v] of obj.dict.entries()) {
        const key = nameText(k)
        if (!['Length', 'Filter', 'DecodeParms'].includes(key)) dict[key] = v
      }
      ctx.assign(ref, ctx.flateStream(new TextEncoder().encode(clean), dict as never))
      report.metadata++
    }
  }
  // thumbnails of redacted pages (or of all pages when metadata is stripped) show the old content
  pdf.getPages().forEach((p, i) => {
    if ((opts.removeMetadata || redactedPages.has(i)) && p.node.has(N('Thumb'))) {
      p.node.delete(N('Thumb'))
      report.thumbnails++
    }
    if (redactedPages.has(i)) {
      strip(p.node, 'PieceInfo')
      strip(p.node, 'Metadata')
    }
  })
}

const JS_KEYS = ['JS']

/** JavaScript actions: removed entirely under "remove hidden data", otherwise only those that mention marked text. */
export function scrubJavaScript(pdf: PDFDocument, re: RegExp | null, all: boolean, report: ScrubReport): void {
  const ctx = pdf.context
  const scriptText = (d: PDFDict): string => {
    const js = dget(d, 'JS')
    if (js instanceof PDFStream) {
      try {
        return new TextDecoder().decode(streamBytes(js))
      } catch {
        return ''
      }
    }
    return strText(js) ?? ''
  }
  const visit = (o: PDFObject, depth: number): void => {
    if (depth > 30) return
    if (o instanceof PDFStream) return visit(o.dict, depth + 1)
    if (o instanceof PDFDict) {
      if (dname(o, 'S') === 'JavaScript' && o.has(N('JS'))) {
        if (all || has(re, scriptText(o))) {
          for (const k of JS_KEYS) o.delete(N(k))
          o.set(N('JS'), encodeTextString(''))
          report.javascript++
        }
      }
      for (const [, v] of o.entries()) if (v instanceof PDFDict || v instanceof PDFArray) visit(v, depth + 1)
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i)
        if (v instanceof PDFDict || v instanceof PDFArray) visit(v, depth + 1)
      }
    }
  }
  for (const [, obj] of indirect(ctx)) visit(obj, 0)
  if (all) {
    const names = ddict(pdf.catalog, 'Names')
    if (names && names.has(N('JavaScript'))) {
      names.delete(N('JavaScript'))
      report.javascript++
    }
    const oa = ddict(pdf.catalog, 'OpenAction')
    if (oa && dname(oa, 'S') === 'JavaScript') {
      pdf.catalog.delete(N('OpenAction'))
      report.javascript++
    }
    for (const holder of [pdf.catalog, ...pdf.getPages().map((p) => p.node)]) {
      if (holder.has(N('AA'))) {
        holder.delete(N('AA'))
        report.javascript++
      }
    }
  }
}

/** "Remove hidden data": attachments, page labels, tooltips, XFA, associated files, and the like. */
export function scrubHidden(pdf: PDFDocument, report: ScrubReport): void {
  const ctx = pdf.context
  const catalog = pdf.catalog
  const names = ddict(catalog, 'Names')
  if (names && names.has(N('EmbeddedFiles'))) {
    names.delete(N('EmbeddedFiles'))
    report.attachments++
  }
  for (const key of ['PageLabels', 'AF', 'Collection', 'SpiderInfo', 'Legal']) {
    if (catalog.has(N(key))) {
      catalog.delete(N(key))
      report.hidden++
    }
  }
  if (names && names.has(N('AlternatePresentations'))) names.delete(N('AlternatePresentations'))
  const acro = ddict(catalog, 'AcroForm')
  if (acro && acro.has(N('XFA'))) {
    acro.delete(N('XFA'))
    report.hidden++
  }
  // attachment annotations, tooltips, associated files
  pdf.getPages().forEach((p) => {
    const arr = p.node.Annots()
    if (!arr) return
    const keep: PDFObject[] = []
    for (let i = 0; i < arr.size(); i++) {
      const raw = arr.get(i)
      const d = raw instanceof PDFRef ? ctx.lookup(raw) : raw
      if (d instanceof PDFDict && dname(d, 'Subtype') === 'FileAttachment') {
        report.attachments++
        continue
      }
      keep.push(raw)
    }
    if (keep.length !== arr.size()) p.node.set(N('Annots'), ctx.obj(keep as never))
  })
  for (const [, obj] of indirect(ctx)) {
    const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined
    if (!d) continue
    if (d.has(N('AF'))) {
      d.delete(N('AF'))
      report.hidden++
    }
    if (dname(d, 'Type') === 'Filespec' || d.has(N('EF'))) {
      d.delete(N('EF'))
      report.attachments++
    }
    if (d.has(N('TU')) && (d.has(N('FT')) || d.has(N('Parent')) || dname(d, 'Subtype') === 'Widget')) {
      d.delete(N('TU'))
      report.hidden++
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Garbage collection

/** Tags (`"12 0"`) of every indirect object reachable from the trailer (Root, Info, Encrypt, ID). */
export function reachableTags(pdf: PDFDocument): Set<string> {
  const ctx = pdf.context
  const seen = new Set<string>()
  const stack: PDFObject[] = []
  const t = ctx.trailerInfo
  for (const o of [t.Root, t.Info, t.Encrypt, t.ID]) if (o) stack.push(o)
  while (stack.length) {
    const o = stack.pop()!
    if (o instanceof PDFRef) {
      const tag = refTag(o)
      if (seen.has(tag)) continue
      seen.add(tag)
      const target = ctx.lookup(o)
      if (target) stack.push(target)
    } else if (o instanceof PDFStream) stack.push(o.dict)
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) stack.push(v)
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) stack.push(o.get(i))
  }
  return seen
}

/** Deletes every indirect object that cannot be reached from the trailer. Returns how many. */
export function collectGarbage(pdf: PDFDocument): number {
  const ctx = pdf.context
  const seen = reachableTags(pdf)
  let n = 0
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(refTag(ref))) {
      ctx.delete(ref)
      n++
    }
  }
  return n
}

/** Sets /NeedAppearances so viewers redraw fields whose stale appearance was removed. */
export function markNeedAppearances(pdf: PDFDocument): void {
  const acro = ddict(pdf.catalog, 'AcroForm')
  if (acro) acro.set(N('NeedAppearances'), PDFBool.True)
}
