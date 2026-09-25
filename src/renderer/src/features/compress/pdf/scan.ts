import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from 'pdf-lib'
import { parseContent, type PdfObj } from '../../textedit/pdfcontent/content'
import { IDENTITY, mul, transformRect, type Matrix } from '../../textedit/pdfcontent/matrix'
import { N, decodeStream, nameOf, numArray, numOf, refKey, resolve } from './streams'

/**
 * Finds where every image is drawn and at what size, by walking page content streams (and the forms and annotation
 * appearances they call) with the pure content-stream engine from the text-editing feature (used read-only).
 * The result is the *effective* resolution of each image: pixels per inch of its placed size, from the current
 * transformation matrix, so rotation and skew are handled (we measure the length of the transformed unit vectors).
 */

export interface ImageUse {
  /** Highest resolution demanded across all placements (pixels per inch along the image's x and y axes). */
  dpiX: number
  dpiY: number
  placements: number
}

export interface ScanResult {
  /** Images drawn where the resolution could be determined. */
  uses: Map<string, ImageUse>
  /** Images used somewhere the resolution is unknown (patterns, Type 3 glyphs, unparseable content): never downsample. */
  unknown: Set<string>
  /** Set when the walk gave up (budget) and nothing may be downsampled. */
  truncated: boolean
  inlineImages: number
}

/** Effective resolution of an image with `w`x`h` samples drawn under `ctm` (PDF user space, `unit` points per unit). */
export function effectiveDpi(w: number, h: number, ctm: readonly number[], unit = 1): { dpiX: number; dpiY: number } | null {
  const sx = Math.hypot(ctm[0], ctm[1]) * unit
  const sy = Math.hypot(ctm[2], ctm[3]) * unit
  if (!(sx > 1e-6) || !(sy > 1e-6) || !Number.isFinite(sx + sy)) return null
  return { dpiX: w / (sx / 72), dpiY: h / (sy / 72) }
}

const MAX_OPS = 4_000_000
const MAX_DEPTH = 12

interface Ctx {
  pdf: PDFDocument
  ctx: PDFContext
  res: ScanResult
  ops: number
  seenForms: Set<string>
  unit: number
}

function markUnknown(s: Ctx, ref: PDFRef): void {
  s.res.unknown.add(refKey(ref))
}

function imageDims(ctx: PDFContext, st: PDFStream): { w: number; h: number } | null {
  const w = numOf(ctx, st.dict.get(N('Width')))
  const h = numOf(ctx, st.dict.get(N('Height')))
  return w && h && w > 0 && h > 0 ? { w, h } : null
}

function addUse(s: Ctx, ref: PDFRef, st: PDFStream, ctm: readonly number[]): void {
  const key = refKey(ref)
  const d = imageDims(s.ctx, st)
  const dpi = d ? effectiveDpi(d.w, d.h, ctm, s.unit) : null
  if (!d || !dpi) return markUnknown(s, ref)
  const cur = s.res.uses.get(key)
  if (!cur) s.res.uses.set(key, { dpiX: dpi.dpiX, dpiY: dpi.dpiY, placements: 1 })
  else {
    cur.dpiX = Math.max(cur.dpiX, dpi.dpiX)
    cur.dpiY = Math.max(cur.dpiY, dpi.dpiY)
    cur.placements++
  }
  // A soft mask / explicit mask fills the same unit square, so it is placed exactly like its image.
  for (const k of ['SMask', 'Mask']) {
    const ent = st.dict.get(N(k))
    if (ent instanceof PDFRef) {
      const m = resolve(s.ctx, ent)
      if (m instanceof PDFStream) addUse(s, ent, m, ctm)
    }
  }
}

function contentOf(ctx: PDFContext, o: PDFObject | undefined): Uint8Array | null {
  const v = resolve(ctx, o)
  if (v instanceof PDFStream) return decodeStream(ctx, v)
  if (v instanceof PDFArray) {
    const parts: Uint8Array[] = []
    for (let i = 0; i < v.size(); i++) {
      const s = resolve(ctx, v.get(i))
      if (!(s instanceof PDFStream)) continue
      const d = decodeStream(ctx, s)
      if (!d) return null
      parts.push(d, new Uint8Array([10]))
    }
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
    let o2 = 0
    for (const p of parts) (out.set(p, o2), (o2 += p.length))
    return out
  }
  return new Uint8Array(0)
}

/** Every image reachable from a resource dictionary, marked as unknown-resolution (used from patterns / Type 3 glyphs). */
function markResources(s: Ctx, res: PDFObject | undefined, seen: Set<string>, depth = 0): void {
  const rd = resolve(s.ctx, res)
  if (!(rd instanceof PDFDict) || depth > MAX_DEPTH) return
  const xo = resolve(s.ctx, rd.get(N('XObject')))
  if (!(xo instanceof PDFDict)) return
  for (const [, v] of xo.entries()) {
    if (!(v instanceof PDFRef)) continue
    const key = refKey(v)
    if (seen.has(key)) continue
    seen.add(key)
    const o = resolve(s.ctx, v)
    if (!(o instanceof PDFStream)) continue
    const sub = nameOf(s.ctx, o.dict.get(N('Subtype')))
    if (sub === 'Image') {
      markUnknown(s, v)
      for (const k of ['SMask', 'Mask']) {
        const m = o.dict.get(N(k))
        if (m instanceof PDFRef) markUnknown(s, m)
      }
    } else if (sub === 'Form') markResources(s, o.dict.get(N('Resources')), seen, depth + 1)
  }
}

function walk(s: Ctx, bytes: Uint8Array, resources: PDFObject | undefined, ctm0: Matrix, depth: number): void {
  let parsed
  try {
    parsed = parseContent(bytes)
  } catch {
    markResources(s, resources, new Set())
    return
  }
  const res = resolve(s.ctx, resources)
  const xobjects = res instanceof PDFDict ? resolve(s.ctx, res.get(N('XObject'))) : undefined
  let ctm = ctm0
  const stack: Matrix[] = []
  for (const op of parsed.ops) {
    if (++s.ops > MAX_OPS) {
      s.res.truncated = true
      return
    }
    switch (op.op) {
      case 'q':
        if (stack.length < 256) stack.push(ctm)
        break
      case 'Q':
        if (stack.length) ctm = stack.pop()!
        break
      case 'cm': {
        const a = op.args.map((x: PdfObj) => (x.t === 'num' ? x.v : NaN))
        if (a.length === 6 && a.every(Number.isFinite)) ctm = mul(a, ctm)
        break
      }
      case 'BI':
        s.res.inlineImages++
        break
      case 'Do': {
        const nm = op.args[0]
        if (nm?.t !== 'name' || !(xobjects instanceof PDFDict)) break
        const ent = xobjects.get(N(nm.v))
        const obj = resolve(s.ctx, ent)
        if (!(obj instanceof PDFStream)) break
        const sub = nameOf(s.ctx, obj.dict.get(N('Subtype')))
        if (sub === 'Image' && ent instanceof PDFRef) addUse(s, ent, obj, ctm)
        else if (sub === 'Form' && ent instanceof PDFRef) {
          if (depth >= MAX_DEPTH) {
            markResources(s, obj.dict.get(N('Resources')), new Set())
            break
          }
          walkForm(s, ent, obj, ctm, resources, depth + 1)
        }
        break
      }
    }
  }
}

function walkForm(s: Ctx, ref: PDFRef | null, form: PDFStream, ctm: Matrix, parentRes: PDFObject | undefined, depth: number): void {
  const m = numArray(s.ctx, form.dict.get(N('Matrix')))
  const matrix: Matrix = m && m.length === 6 && m.every(Number.isFinite) ? (m as Matrix) : IDENTITY
  const full = mul(matrix, ctm)
  if (ref) {
    const key = `${refKey(ref)}|${full.map((v) => v.toFixed(3)).join(',')}`
    if (s.seenForms.has(key)) return
    s.seenForms.add(key)
  }
  const bytes = decodeStream(s.ctx, form)
  const res = form.dict.get(N('Resources')) ?? parentRes
  if (!bytes) return markResources(s, res, new Set())
  walk(s, bytes, res, full, depth)
}

/** Appearance stream -> page mapping of an annotation (PDF 32000-1, 12.5.5). */
function annotationMatrix(ctx: PDFContext, annot: PDFDict, form: PDFStream): Matrix | null {
  const rect = numArray(ctx, annot.get(N('Rect')))
  const bbox = numArray(ctx, form.dict.get(N('BBox')))
  if (!rect || rect.length !== 4 || !bbox || bbox.length !== 4) return null
  const m = numArray(ctx, form.dict.get(N('Matrix')))
  const M: Matrix = m && m.length === 6 ? (m as Matrix) : IDENTITY
  const r = transformRect(M, Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]), Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3]))
  const rx0 = Math.min(rect[0], rect[2])
  const ry0 = Math.min(rect[1], rect[3])
  const rw = Math.abs(rect[2] - rect[0])
  const rh = Math.abs(rect[3] - rect[1])
  const tw = r.x1 - r.x0
  const th = r.y1 - r.y0
  if (!(tw > 1e-9) || !(th > 1e-9)) return null
  const sx = rw / tw
  const sy = rh / th
  return [sx, 0, 0, sy, rx0 - r.x0 * sx, ry0 - r.y0 * sy]
}

function scanAnnotations(s: Ctx, pageNode: PDFDict): void {
  const annots = resolve(s.ctx, pageNode.get(N('Annots')))
  if (!(annots instanceof PDFArray)) return
  for (let i = 0; i < annots.size(); i++) {
    const a = resolve(s.ctx, annots.get(i))
    if (!(a instanceof PDFDict)) continue
    const ap = resolve(s.ctx, a.get(N('AP')))
    if (!(ap instanceof PDFDict)) continue
    const n = ap.get(N('N'))
    const streams: [PDFRef | null, PDFStream][] = []
    const nr = resolve(s.ctx, n)
    if (nr instanceof PDFStream) streams.push([n instanceof PDFRef ? n : null, nr])
    else if (nr instanceof PDFDict) {
      for (const [, v] of nr.entries()) {
        const st = resolve(s.ctx, v)
        if (st instanceof PDFStream) streams.push([v instanceof PDFRef ? v : null, st])
      }
    }
    for (const [ref, st] of streams) {
      const A = annotationMatrix(s.ctx, a, st)
      if (!A) {
        markResources(s, st.dict.get(N('Resources')), new Set())
        continue
      }
      walkForm(s, ref, st, A, undefined, 1)
    }
  }
}

/** Marks images used by tiling patterns and Type 3 fonts (their placement is not knowable from content alone). */
function scanSpecials(s: Ctx): void {
  const seen = new Set<string>()
  for (const [, obj] of s.ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      if (numOf(s.ctx, obj.dict.get(N('PatternType'))) === 1) markResources(s, obj.dict.get(N('Resources')), seen)
    } else if (obj instanceof PDFDict) {
      if (nameOf(s.ctx, obj.get(N('Subtype'))) === 'Type3') {
        markResources(s, obj.get(N('Resources')), seen)
        const cp = resolve(s.ctx, obj.get(N('CharProcs')))
        if (cp instanceof PDFDict) {
          for (const [, v] of cp.entries()) {
            const st = resolve(s.ctx, v)
            if (st instanceof PDFStream) markResources(s, st.dict.get(N('Resources')), seen)
          }
        }
      }
    }
  }
}

export function scanImageUsage(pdf: PDFDocument): ScanResult {
  const res: ScanResult = { uses: new Map(), unknown: new Set(), truncated: false, inlineImages: 0 }
  const s: Ctx = { pdf, ctx: pdf.context, res, ops: 0, seenForms: new Set(), unit: 1 }
  scanSpecials(s)
  let pages: ReturnType<PDFDocument['getPages']> = []
  try {
    pages = pdf.getPages()
  } catch {
    res.truncated = true
  }
  for (const page of pages) {
    const node = page.node
    s.unit = numOf(s.ctx, node.get(N('UserUnit'))) ?? 1
    const resources = node.Resources() as PDFObject | undefined
    const bytes = contentOf(s.ctx, node.get(PDFName.of('Contents')))
    if (!bytes) markResources(s, resources, new Set())
    else walk(s, bytes, resources, IDENTITY, 0)
    scanAnnotations(s, node)
    if (res.truncated) break
  }
  if (res.truncated) res.uses.clear()
  return res
}
