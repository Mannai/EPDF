import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFDocument, type PDFObject } from 'pdf-lib'
import { parseGroupSettings, type GroupSettings, type MarkGroup } from '../../../../../shared/features/headerfooter'
import { mkOp, parseContent, serializeContent, type Op } from '../../textedit/pdfcontent/content'
import { streamBytes } from '../../textedit/pdfcontent/pdfutil'
import { GROUP_NAME, MARK_KEY, classifyXObject, contentRefs, findMarks, ownXObjects, pruneOcgs, readSettings, setContents, streamMark, xobjectsOf, type FoundMark } from './marks'

/**
 * Finding, listing and removing marks — Epdf's own (recognised by their /PieceInfo EpdfPageMarks entry) and, when
 * asked, Acrobat-style ones (PieceInfo ADBE_CompoundType /Private /Header, /Footer, /Watermark, /Background).
 *
 * Removal works on the content itself, so it also works after other software merged Epdf's small content streams into
 * the page's own: every marked-content sequence tagged /Artifact that draws one of the mark XObjects is cut out
 * (keeping the q/Q nesting of the rest of the stream intact), a stray `Do` of a mark outside such a sequence is
 * dropped, the resource names are deleted, and the objects that only the marks used (their forms, fonts, pictures,
 * settings, optional content groups) are deleted from the file, so nothing of a removed watermark stays behind.
 */

export interface GroupSummary {
  /** Pages with an Epdf mark of this group. */
  pages: number
  /** Pages with an Acrobat-style mark of this group (other software). */
  foreignPages: number
  /** The settings of the most recent Epdf application of this group, if readable. */
  settings?: GroupSettings
  /** Source XObject (picture/PDF page) of that application, reusable by an update. */
  source?: PDFRef
  appliedAt?: string
}

export type MarkSummary = Record<MarkGroup, GroupSummary>

export function summarizeMarks(pdf: PDFDocument): MarkSummary {
  const out: MarkSummary = {
    headerfooter: { pages: 0, foreignPages: 0 },
    bates: { pages: 0, foreignPages: 0 },
    watermark: { pages: 0, foreignPages: 0 },
    background: { pages: 0, foreignPages: 0 }
  }
  const seenSettings = new Set<string>()
  for (const page of pdf.getPages()) {
    const marks = findMarks(pdf, page)
    const ours = new Set<MarkGroup>()
    const foreign = new Set<MarkGroup>()
    for (const m of marks) {
      ;(m.foreign ? foreign : ours).add(m.group)
      if (!m.foreign && m.settings && !seenSettings.has(m.settings.toString())) {
        seenSettings.add(m.settings.toString())
        const raw = readSettings(pdf, m.settings)
        const parsed = raw ? parseGroupSettings(m.group, raw.settings) : null
        const g = out[m.group]
        if (parsed && (!g.appliedAt || (raw?.appliedAt ?? '') > g.appliedAt)) {
          g.settings = parsed
          g.appliedAt = raw?.appliedAt ?? ''
          g.source = m.source
        }
      }
    }
    for (const g of ours) out[g].pages++
    for (const g of foreign) out[g].foreignPages++
  }
  return out
}

export interface RemoveOptions {
  groups: MarkGroup[]
  /** Also remove Acrobat-style marks of these groups (default true). */
  foreign?: boolean
  /** Objects to keep even if nothing uses them any more (a Source XObject an update reuses). */
  keep?: PDFRef[]
  isCancelled?(): boolean
  yieldEvery?: number
}

export interface RemoveResult {
  /** Pages that had something removed. */
  pages: number
  /** Marks removed (one per mark per page). */
  marks: number
  foreign: number
  /** Content streams that could not be parsed (their marks were unlinked, the drawing call may remain). */
  unparsed: number
  /** Objects deleted from the file. */
  deleted: number
}

const N = (s: string): PDFName => PDFName.of(s)
const latin1 = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192))
  return s
}
const ourStreamMarks = new Set([...Object.values(GROUP_NAME)])

/** Cuts the artifact sequences drawing any of `names` out of a parsed stream. Returns null if nothing changed. */
export function cutMarks(ops: Op[], names: Set<string>): Op[] | null {
  interface Frame {
    start: number
    artifact: boolean
    hit: boolean
  }
  const stack: Frame[] = []
  const cuts: [number, number][] = []
  const strayDo = new Set<number>()
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.op === 'BDC' || op.op === 'BMC') {
      const tag = op.args[0]
      stack.push({ start: i, artifact: tag?.t === 'name' && tag.v === 'Artifact', hit: false })
    } else if (op.op === 'EMC') {
      const f = stack.pop()
      if (f && f.hit) cuts.push([f.start, i])
    } else if (op.op === 'Do') {
      const a = op.args[0]
      if (a?.t === 'name' && names.has(a.v)) {
        let hit = false
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k]!.artifact) {
            stack[k]!.hit = true
            hit = true
            break
          }
        }
        if (!hit) strayDo.add(i)
      }
    }
  }
  // A sequence left open at the end of the stream (its EMC is in the next stream) is cut to the end.
  for (const f of stack) if (f.hit) cuts.push([f.start, ops.length - 1])
  if (cuts.length === 0 && strayDo.size === 0) return null
  // Keep only outermost cuts.
  cuts.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: [number, number][] = []
  for (const c of cuts) {
    const last = merged[merged.length - 1]
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1])
    else merged.push([...c])
  }
  const out: Op[] = []
  let ci = 0
  for (let i = 0; i < ops.length; i++) {
    const c = merged[ci]
    if (c && i === c[0]) {
      // Preserve the graphics-state nesting of everything around the cut (Acrobat writes `q BDC … Q EMC`).
      let bal = 0
      for (let k = c[0]; k <= c[1]; k++) {
        if (ops[k]!.op === 'q') bal++
        else if (ops[k]!.op === 'Q') bal--
      }
      for (let k = 0; k < Math.abs(bal); k++) out.push(mkOp(bal > 0 ? 'q' : 'Q'))
      i = c[1]
      ci++
      continue
    }
    if (strayDo.has(i)) continue
    out.push(ops[i]!)
  }
  return out
}

/** Every indirect reference reachable from `start` (including it). */
function reachableFrom(pdf: PDFDocument, start: PDFObject[], into = new Set<string>(), refs?: Map<string, PDFRef>): Set<string> {
  const ctx = pdf.context
  const stack: PDFObject[] = [...start]
  while (stack.length) {
    const o = stack.pop()!
    if (o instanceof PDFRef) {
      const k = o.toString()
      if (into.has(k)) continue
      into.add(k)
      refs?.set(k, o)
      const v = ctx.lookup(o)
      if (v) stack.push(v)
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v)
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i))
    } else if (o instanceof PDFStream) {
      stack.push(o.dict)
    }
  }
  return into
}

/** Deletes the `candidates` that nothing reachable from the trailer uses any more. */
function collectGarbage(pdf: PDFDocument, candidates: Map<string, PDFRef>, keep: PDFRef[]): number {
  if (candidates.size === 0) return 0
  const t = pdf.context.trailerInfo
  const roots = [t.Root, t.Info, t.Encrypt].filter((x): x is PDFObject => !!x)
  const live = reachableFrom(pdf, roots)
  reachableFrom(pdf, keep, live)
  let n = 0
  for (const [k, ref] of candidates) {
    if (live.has(k)) continue
    if (pdf.context.delete(ref)) n++
  }
  return n
}

export async function removeMarks(pdf: PDFDocument, o: RemoveOptions): Promise<RemoveResult> {
  const groups = new Set(o.groups)
  const foreignToo = o.foreign ?? true
  const result: RemoveResult = { pages: 0, marks: 0, foreign: 0, unparsed: 0, deleted: 0 }
  const candidates = new Map<string, PDFRef>()
  const ctx = pdf.context
  const pages = pdf.getPages()
  for (let pi = 0; pi < pages.length; pi++) {
    if (o.isCancelled?.()) throw new Error('Cancelled.')
    if (o.yieldEvery && pi > 0 && pi % o.yieldEvery === 0) await new Promise((r) => setTimeout(r, 0))
    const page = pages[pi]!
    const marks = findMarks(pdf, page).filter((m) => groups.has(m.group) && (foreignToo || !m.foreign))
    if (marks.length === 0) continue
    result.pages++
    for (const m of marks) {
      if (m.foreign) result.foreign++
      else result.marks++
      if (m.ref) reachableFrom(pdf, [m.ref], new Set(), candidates)
    }
    const names = new Set(marks.map((m) => m.name))
    const needles = [...names].map((n) => `/${n}`)
    const refs = contentRefs(page)
    const next: PDFRef[] = []
    let changed = false
    for (const ref of refs) {
      const mark = streamMark(pdf, ref)
      let stream: PDFObject | undefined
      try {
        stream = ctx.lookup(ref)
      } catch {
        stream = undefined
      }
      if (!(stream instanceof PDFStream)) {
        next.push(ref)
        continue
      }
      let bytes: Uint8Array
      try {
        bytes = streamBytes(stream)
      } catch {
        result.unparsed++
        next.push(ref)
        continue
      }
      const text = latin1(bytes)
      if (!needles.some((n) => text.includes(n))) {
        next.push(ref)
        continue
      }
      let cut: Op[] | null
      let tail: Uint8Array = new Uint8Array(0)
      try {
        const parsed = parseContent(bytes)
        tail = parsed.tail
        cut = cutMarks(parsed.ops, names)
      } catch {
        result.unparsed++
        // A stream Epdf wrote itself only draws the mark: drop it whole.
        if (mark && ourStreamMarks.has(mark)) {
          changed = true
          candidates.set(ref.toString(), ref)
        } else next.push(ref)
        continue
      }
      if (!cut) {
        next.push(ref)
        continue
      }
      changed = true
      candidates.set(ref.toString(), ref)
      const out = serializeContent(cut, tail)
      if (mark && ourStreamMarks.has(mark) && latin1(out).trim() === '') continue
      // A new stream for this page only (the old one may be shared with other pages).
      const dict: Record<string, PDFObject> = {}
      if (mark) dict[MARK_KEY] = N(mark)
      next.push(ctx.register(ctx.flateStream(out, dict as never)))
    }
    if (changed) setContents(page, next)
    const xo = ownXObjects(page)
    for (const n of names) xo.delete(N(n))
  }

  // Epdf's own q … Q wrapper streams stay (harmless, and later front marks reuse them instead of wrapping again).

  // Optional content groups no remaining mark uses.
  const usedOcgs = new Set<string>()
  for (const page of pages) {
    const xo = xobjectsOf(page)
    if (!xo) continue
    for (const [, v] of xo.entries()) {
      const c = classifyXObject(pdf, v)
      if (!c || !c.ref) continue
      const s = ctx.lookup(c.ref)
      const oc = s instanceof PDFStream ? s.dict.get(N('OC')) : undefined
      if (oc instanceof PDFRef) usedOcgs.add(oc.toString())
    }
  }
  for (const r of pruneOcgs(pdf, usedOcgs)) candidates.set(r.toString(), r)
  result.deleted = collectGarbage(pdf, candidates, o.keep ?? [])
  return result
}

export type { FoundMark }
