import { PDFDict, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from 'pdf-lib'
import { fontFromDict } from '../../textedit/pdfcontent/analyze'
import {
  mkOp,
  name as nameObj,
  num as numObj,
  parseContent,
  serializeContent,
  type InlineImage,
  type Op,
  type PdfObj
} from '../../textedit/pdfcontent/content'
import { unreadableFont, type PdfFont } from '../../textedit/pdfcontent/fonts'
import { IDENTITY, apply, invert, mul, transformRect, type Matrix } from '../../textedit/pdfcontent/matrix'
import { N, darr, ddict, dget, dname, dnum, nameText, numbers, refTag, streamBytes } from '../../textedit/pdfcontent/pdfutil'
import { GLYPH_COVERAGE, coverage, intersect, touches, type Rect } from './geom'
import { redactImage } from './imageRedact'
import { fromPdfLib, toPdfLib } from './pdfconv'
import { rewriteShow, type GlyphSpan } from './textRewrite'

/**
 * The redaction interpreter. It walks a page's content (and the Form XObjects, soft-mask groups and inline images
 * it reaches) with a full graphics/text state, and — when editing — rewrites everything that lies under the
 * marks: glyphs are cut out of text-showing operators (advance-preserving), images lose the covered pixels,
 * paths/shadings/patterns under a mark are removed or clipped, marked-content replacement text is stripped.
 *
 * Nothing shared is ever modified in place: forms, images and graphics states that change are COPIED and the use
 * site is pointed at the copy (through a private copy of the resource dictionary), so other pages and unmarked
 * uses keep their content. Objects that become unreferenced are removed by the garbage collector afterwards.
 *
 * With no marks (`edit: false`) the same walk is used to extract text with per-glyph geometry.
 */

export class RedactRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RedactRefused'
  }
}

export type Rgb = [number, number, number]

export interface Stats {
  textRuns: number
  wholeRuns: number
  glyphs: number
  images: number
  imagePixels: number
  imagesRemoved: number
  paths: number
  pathsClipped: number
  shadings: number
  patterns: number
  forms: number
  marked: number
}

export const newStats = (): Stats => ({
  textRuns: 0,
  wholeRuns: 0,
  glyphs: 0,
  images: 0,
  imagePixels: 0,
  imagesRemoved: 0,
  paths: 0,
  pathsClipped: 0,
  shadings: 0,
  patterns: 0,
  forms: 0,
  marked: 0
})

export interface GlyphRec {
  text: string
  rect: Rect
  known: boolean
}

export interface RunRec {
  glyphs: GlyphRec[]
  fontSize: number
  /** User-space position of the run origin (baseline). */
  x: number
  y: number
  visible: boolean
  /** Text direction is horizontal in user space. */
  upright: boolean
  sourceId: string
}

export interface RemovedRec {
  text: string
  /** Index (in the original mark list) of the first mark covering the removed text. */
  mark: number
}

export interface WalkCfg {
  /** Disjoint rects (user space). Empty = nothing to redact. */
  marks: Rect[]
  /** The original, possibly overlapping marks (used to attribute removed text to a mark). */
  origMarks?: Rect[]
  edit: boolean
  /** Colour of the boxes that replace images that cannot be edited. */
  fill: Rgb
}

const MAX_DEPTH = 12
const MAX_OPS = 4_000_000

// ---------------------------------------------------------------------------------------------------------
// Resources (copy on write)

/** A resource dictionary that is copied the first time something is added, so shared dictionaries stay intact. */
export class ResEdit {
  private priv?: PDFDict
  private cats = new Map<string, PDFDict>()
  constructor(
    private ctx: PDFContext,
    readonly base: PDFDict | undefined,
    /** Every dictionary this editor creates is recorded here (only those may be pruned later). */
    private owned?: Set<PDFDict>
  ) {}

  get effective(): PDFDict | undefined {
    return this.priv ?? this.base
  }
  /** The private copy, if anything was added. */
  get override(): PDFDict | undefined {
    return this.priv
  }

  private ensure(): PDFDict {
    if (!this.priv) {
      const d = PDFDict.withContext(this.ctx)
      if (this.base) for (const [k, v] of this.base.entries()) d.set(k, v)
      this.priv = d
      this.owned?.add(d)
    }
    return this.priv
  }

  /** Adds `ref` to a category (XObject, ExtGState, Font, ...) under a fresh name; returns the name. */
  add(category: string, prefix: string, ref: PDFObject): string {
    const res = this.ensure()
    let cat = this.cats.get(category)
    if (!cat) {
      cat = PDFDict.withContext(this.ctx)
      this.owned?.add(cat)
      const existing = res.lookup(N(category))
      if (existing instanceof PDFDict) for (const [k, v] of existing.entries()) cat.set(k, v)
      this.cats.set(category, cat)
      res.set(N(category), cat)
    }
    let i = 1
    let nm = `${prefix}${i}`
    while (cat.has(N(nm))) nm = `${prefix}${++i}`
    cat.set(N(nm), ref)
    return nm
  }
}

// ---------------------------------------------------------------------------------------------------------
// Graphics state

interface TS {
  font: PdfFont | undefined
  fontName: string
  size: number
  tc: number
  tw: number
  th: number
  tl: number
  rise: number
  mode: number
}

interface GS {
  ctm: Matrix
  text: TS
  fillPat?: string
  strokePat?: string
  clip: Rect | null
  lw: number
}

const cloneG = (g: GS): GS => ({ ...g, text: { ...g.text } })

export const initialState = (): GS => ({
  ctm: IDENTITY,
  text: { font: undefined, fontName: '', size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0 },
  clip: null,
  lw: 1
})

const numOf = (a: PdfObj | undefined): number => (a?.t === 'num' ? a.v : NaN)

interface SrcIn {
  slots: { ops: Op[]; tail: Uint8Array }[]
  res: ResEdit
}

interface SrcOut {
  slots: { ops: Op[]; tail: Uint8Array; changed: boolean }[]
  changed: boolean
  endDepth: number
}

interface McEntry {
  target: Op[]
  index: number
  keys: boolean
  dirty: boolean
  resName?: string
}

const PAINT_FILL = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'])
const PAINT_STROKE = new Set(['S', 's', 'B', 'B*', 'b', 'b*'])
const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])
const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h'])

/** The vertical extent used for a glyph's box: comfortably around ascenders/descenders, independent of odd font metrics. */
export function glyphBand(font: PdfFont): { asc: number; desc: number } {
  return { asc: Math.min(Math.max(font.ascent, 0.6), 0.95), desc: Math.max(Math.min(font.descent, -0.1), -0.3) }
}

export class Walker {
  runs: RunRec[] = []
  removed: RemovedRec[] = []
  warnings: string[] = []
  private opCount = 0
  private formStack: string[] = []
  private formId = 0
  private patternCache = new Map<PDFObject, boolean>()
  /** Resource dictionaries created by the redaction (safe to prune later). */
  readonly owned = new Set<PDFDict>()
  /** Objects whose use sites were replaced by copies: refTag strings for indirect objects, the object itself otherwise. */
  readonly replaced = new Set<unknown>()

  constructor(
    readonly pdf: PDFDocument,
    readonly cfg: WalkCfg,
    readonly stats: Stats
  ) {}

  private get ctx(): PDFContext {
    return this.pdf.context
  }

  private get editing(): boolean {
    return this.cfg.edit && this.cfg.marks.length > 0
  }

  private hits(r: Rect): boolean {
    return touches(r, this.cfg.marks)
  }

  process(src: SrcIn, g0: GS, depth: number, sourceId = 'page'): SrcOut {
    let g = g0
    const stack: GS[] = []
    let tm: Matrix = IDENTITY
    let tlm: Matrix = IDENTITY
    const res = src.res
    const outSlots: { ops: Op[]; tail: Uint8Array; changed: boolean }[] = []
    const mc: McEntry[] = []
    let anyChange = false

    let out: Op[] = []
    let slotChanged = false
    const changed = (): void => {
      slotChanged = true
      anyChange = true
      for (const e of mc) e.dirty = true
    }

    // path state
    let pathStart = -1
    let pathPts: [number, number][] = []
    let pathLocal: Rect | null = null
    let pendingClip: string | null = null

    const noteLocal = (x: number, y: number): void => {
      pathLocal = pathLocal ? { x0: Math.min(pathLocal.x0, x), y0: Math.min(pathLocal.y0, y), x1: Math.max(pathLocal.x1, x), y1: Math.max(pathLocal.y1, y) } : { x0: x, y0: y, x1: x, y1: y }
      pathPts.push(apply(g.ctm, x, y))
    }
    const resetPath = (): void => {
      pathStart = -1
      pathPts = []
      pathLocal = null
      pendingClip = null
    }

    const setFont = (fontName: string, size: number): void => {
      const fonts = ddict(res.effective, 'Font')
      const fd = fonts ? dget(fonts, fontName) : undefined
      const font = fd instanceof PDFDict ? fontFromDict(fd) : unreadableFont('Unknown', fontName, 'the font is missing from the page resources')
      g = { ...g, text: { ...g.text, font, fontName, size } }
    }

    const boxOps = (): Op[] => {
      const [r, gr, b] = this.cfg.fill
      return [mkOp('q'), mkOp('rg', numObj(r), numObj(gr), numObj(b)), mkOp('re', numObj(0), numObj(0), numObj(1), numObj(1)), mkOp('f'), mkOp('Q')]
    }

    const show = (op: Op, strArg: number, spacing?: { tw: number; tc: number }): void => {
      const ts = g.text
      const font = ts.font
      if (!font) throw new RedactRefused('A page shows text before selecting a font, so it cannot be redacted safely.')
      const th = ts.th
      const tc = spacing?.tc ?? ts.tc
      const tw = spacing?.tw ?? ts.tw
      const band = glyphBand(font)
      const a = op.args[strArg]
      const glyphs: { code: number; n: number; text: string; known: boolean; x0: number; x1: number; el: number; off: number; disp: number }[] = []
      let u = 0
      const feed = (bytes: Uint8Array, el: number): void => {
        let off = 0
        for (const gl of font.glyphs(bytes)) {
          const w = (gl.width / 1000) * ts.size * th
          const disp = w + tc * th + (gl.space ? tw * th : 0)
          glyphs.push({ code: gl.code, n: gl.n, text: gl.text, known: gl.known, x0: u, x1: u + w, el, off, disp })
          u += disp
          off += gl.n
        }
      }
      if (op.op === 'TJ') {
        if (a?.t !== 'arr') throw new RedactRefused('A page has a text operator that cannot be read safely.')
        a.v.forEach((el, i) => {
          if (el.t === 'str') feed(el.b, i)
          else if (el.t === 'num') u -= (el.v / 1000) * ts.size * th
        })
      } else {
        if (a?.t !== 'str') throw new RedactRefused('A page has a text operator that cannot be read safely.')
        feed(a.b, -1)
      }
      const m = mul(tm, g.ctm)
      const rects = glyphs.map((gl) => transformRect(m, gl.x0, ts.rise + band.desc * ts.size, gl.x1, ts.rise + band.asc * ts.size))
      const upright = Math.abs(m[1]) < 1e-3 * Math.abs(m[0]) + 1e-9 && Math.abs(m[2]) < 1e-3 * Math.abs(m[3]) + 1e-9 && m[0] > 0 && m[3] > 0
      if (!this.editing) {
        this.runs.push({
          glyphs: glyphs.map((gl, i) => ({ text: gl.text, rect: rects[i], known: gl.known })),
          fontSize: ts.size,
          x: m[4],
          y: m[5],
          visible: ts.mode !== 3 && ts.mode !== 7 && ts.size !== 0,
          upright,
          sourceId
        })
      }
      let replaced = false
      if (this.editing && glyphs.length) {
        const covered = rects.map((r) => coverage(r, this.cfg.marks) >= GLYPH_COVERAGE)
        if (covered.some(Boolean)) {
          const unreliable = !font.editable || glyphs.some((gl, i) => covered[i] && !gl.known) || !(Math.abs(ts.size * th) > 1e-9)
          let ops: Op[]
          if (unreliable) {
            ops = rewriteShow({ op, strArg, glyphs: glyphs as GlyphSpan[], covered: covered.map(() => true), size: ts.size, hScale: th, wholeAdvance: u })
            this.stats.wholeRuns++
          } else {
            ops = rewriteShow({ op, strArg, glyphs: glyphs as GlyphSpan[], covered, size: ts.size, hScale: th })
          }
          this.record(glyphs.map((gl) => gl.text), unreliable ? glyphs.map(() => true) : covered, rects)
          this.stats.textRuns++
          this.stats.glyphs += unreliable ? glyphs.length : covered.filter(Boolean).length
          changed()
          out.push(...ops)
          replaced = true
        }
      }
      if (!replaced) out.push(op)
      tm = mul([1, 0, 0, 1, u, 0], tm)
    }

    const nextLine = (): void => {
      tlm = mul([1, 0, 0, 1, 0, -g.text.tl], tlm)
      tm = tlm
    }

    const finishMc = (e: McEntry): void => {
      if (!e.keys || !e.dirty) return
      const bdc = e.target[e.index]
      if (!bdc || bdc.op !== 'BDC') return
      const props = bdc.args[1]
      let clean: PdfObj
      if (props?.t === 'dict') {
        const m = new Map(props.v)
        for (const k of ['ActualText', 'Alt', 'E']) m.delete(k)
        clean = { t: 'dict', v: m }
      } else if (props?.t === 'name') {
        const pr = ddict(ddict(res.effective, 'Properties'), props.v)
        const m = new Map<string, PdfObj>()
        if (pr) {
          for (const [k, v] of pr.entries()) {
            const key = nameText(k)
            if (key === 'ActualText' || key === 'Alt' || key === 'E' || v instanceof PDFRef) continue
            const x = fromPdfLib(this.ctx, v)
            if (x) m.set(key, x)
          }
        }
        clean = { t: 'dict', v: m }
      } else return
      e.target[e.index] = { op: 'BDC', args: [bdc.args[0], clean], pre: bdc.pre, raw: null }
      this.stats.marked++
    }

    // ---- images and forms at a `Do`
    const doImage = (op: Op, obj: PDFStream, key: unknown): void => {
      const bbox = transformRect(g.ctm, 0, 0, 1, 1)
      if (!this.editing || !this.hits(bbox)) {
        out.push(op)
        return
      }
      const r = redactImage(this.pdf, obj, g.ctm, this.cfg.marks, res.effective)
      this.replaced.add(key)
      changed()
      if ('fail' in r) {
        this.warnings.push(`An image was removed entirely because ${r.fail}.`)
        this.stats.imagesRemoved++
        out.push(...boxOps())
      } else {
        this.stats.images++
        this.stats.imagePixels += r.pixels
        const nm = res.add('XObject', 'EpdfRdIm', r.ref)
        out.push({ op: 'Do', args: [nameObj(nm)], pre: op.pre, raw: null })
      }
    }

    const doInline = (op: Op): void => {
      const inl = op.inline
      if (!inl) {
        out.push(op)
        return
      }
      const bbox = transformRect(g.ctm, 0, 0, 1, 1)
      if (!this.editing || !this.hits(bbox)) {
        out.push(op)
        return
      }
      changed()
      const stream = inlineToStream(this.ctx, inl, res.effective)
      const r = stream ? redactImage(this.pdf, stream, g.ctm, this.cfg.marks, res.effective) : { fail: 'the inline image could not be interpreted' }
      if ('fail' in r) {
        this.warnings.push(`An inline image was removed entirely because ${r.fail}.`)
        this.stats.imagesRemoved++
        out.push(...boxOps())
      } else {
        this.stats.images++
        this.stats.imagePixels += r.pixels
        const nm = res.add('XObject', 'EpdfRdIm', r.ref)
        out.push({ op: 'Do', args: [nameObj(nm)], pre: op.pre, raw: null })
      }
    }

    const doForm = (op: Op, ref: PDFRef | undefined, obj: PDFStream, key: unknown): void => {
      const mat = numbers(darr(obj.dict, 'Matrix'))
      const matrix: Matrix = mat.length === 6 && mat.every(Number.isFinite) ? (mat as Matrix) : IDENTITY
      const ctm2 = mul(matrix, g.ctm)
      const bb = numbers(darr(obj.dict, 'BBox'))
      if (this.editing && bb.length === 4 && bb.every(Number.isFinite)) {
        const box = transformRect(ctm2, Math.min(bb[0], bb[2]), Math.min(bb[1], bb[3]), Math.max(bb[0], bb[2]), Math.max(bb[1], bb[3]))
        if (!this.hits(box)) {
          out.push(op)
          return
        }
      }
      if (depth >= MAX_DEPTH) {
        if (this.editing) throw new RedactRefused('Forms are nested too deeply to redact safely.')
        this.warnings.push('Forms are nested too deeply; some content was not analysed')
        out.push(op)
        return
      }
      const tag = ref ? refTag(ref) : `direct${this.formId++}`
      if (this.formStack.includes(tag)) {
        if (this.editing) throw new RedactRefused('A form draws itself, so the page cannot be redacted safely.')
        out.push(op)
        return
      }
      let parsed: ReturnType<typeof parseContent>
      try {
        parsed = parseContent(streamBytes(obj))
      } catch (e) {
        if (this.editing) throw new RedactRefused(`A form on the page has content that cannot be read safely (${e instanceof Error ? e.message : String(e)}).`)
        out.push(op)
        return
      }
      const childRes = new ResEdit(this.ctx, ddict(obj.dict, 'Resources') ?? res.effective, this.owned)
      this.formStack.push(tag)
      let child: SrcOut
      try {
        child = this.process({ slots: [{ ops: parsed.ops, tail: parsed.tail }], res: childRes }, { ...cloneG(g), ctm: ctm2 }, depth + 1, `form:${tag}`)
      } finally {
        this.formStack.pop()
      }
      if (!child.changed) {
        out.push(op)
        return
      }
      changed()
      this.replaced.add(key)
      this.stats.forms++
      const bytes = serializeContent(child.slots[0].ops, child.slots[0].tail)
      const copy = copyStream(this.ctx, obj, bytes, childRes.override)
      const nm = res.add('XObject', 'EpdfRdFm', this.ctx.register(copy))
      out.push({ op: 'Do', args: [nameObj(nm)], pre: op.pre, raw: null })
    }

    // ---- path painting decisions
    const paint = (op: Op): void => {
      const isPaint = PAINT_OPS.has(op.op)
      void isPaint
      const hadPath = pathStart >= 0 && pathPts.length > 0
      if (!hadPath || !this.editing) {
        finishPath(op)
        return
      }
      const stroke = PAINT_STROKE.has(op.op)
      const scale = Math.sqrt(Math.abs(g.ctm[0] * g.ctm[3] - g.ctm[1] * g.ctm[2]))
      const exp = stroke ? (g.lw * scale) / 2 : 0
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [x, y] of pathPts) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      const bbox: Rect = { x0: x0 - exp, y0: y0 - exp, x1: x1 + exp, y1: y1 + exp }
      if (!this.hits(bbox)) {
        finishPath(op)
        return
      }
      const full = coverage({ x0: bbox.x0, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 }, this.cfg.marks) >= 0.999
      if (pendingClip) {
        if (full && pathLocal) {
          // A clip that lies entirely under a mark: keep its effect but drop its shape.
          const l = pathLocal as Rect
          out.length = pathStart
          out.push(mkOp('re', numObj(l.x0), numObj(l.y0), numObj(l.x1 - l.x0), numObj(l.y1 - l.y0)))
          out.push(mkOp(pendingClip))
          changed()
          this.stats.paths++
        }
        finishPath(op)
        return
      }
      if (op.op === 'n') {
        // an unpainted, unclipping path: nothing visible, and its geometry may carry information
        out.length = pathStart
        changed()
        this.stats.paths++
        resetPath()
        return
      }
      const patName = (PAINT_FILL.has(op.op) ? g.fillPat : undefined) ?? (stroke ? g.strokePat : undefined)
      const dangerous = patName ? this.patternDangerous(res.effective, patName) : false
      if (full || dangerous) {
        out.length = pathStart
        changed()
        this.stats.paths++
        if (dangerous) this.stats.patterns++
        resetPath()
        return
      }
      const clip = clipOutOps(g.ctm, this.cfg.marks)
      if (!clip) {
        out.length = pathStart
        changed()
        this.stats.paths++
        resetPath()
        return
      }
      out.splice(pathStart, 0, ...clip)
      out.push(op)
      out.push(mkOp('Q'))
      changed()
      this.stats.pathsClipped++
      afterPaint(op)
    }
    const finishPath = (op: Op): void => {
      out.push(op)
      afterPaint(op)
    }
    const afterPaint = (op: Op): void => {
      void op
      if (pendingClip && pathPts.length) {
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (const [x, y] of pathPts) {
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x)
          y1 = Math.max(y1, y)
        }
        const b: Rect = { x0, y0, x1, y1 }
        g = { ...g, clip: g.clip ? (intersect(g.clip, b) ?? { x0: 0, y0: 0, x1: 0, y1: 0 }) : b }
      }
      resetPath()
    }

    for (let s = 0; s < src.slots.length; s++) {
      const slot = src.slots[s]
      out = []
      slotChanged = false
      for (let i = 0; i < slot.ops.length; i++) {
        if (++this.opCount > MAX_OPS) throw new RedactRefused('This page is too complex to redact safely.')
        const op = slot.ops[i]
        const a = op.args
        if (PATH_OPS.has(op.op)) {
          if (pathStart < 0) pathStart = out.length
          switch (op.op) {
            case 'm':
            case 'l':
              if (a.length >= 2) noteLocal(numOf(a[0]), numOf(a[1]))
              break
            case 'c':
              if (a.length >= 6) for (let k = 0; k < 6; k += 2) noteLocal(numOf(a[k]), numOf(a[k + 1]))
              break
            case 'v':
            case 'y':
              if (a.length >= 4) for (let k = 0; k < 4; k += 2) noteLocal(numOf(a[k]), numOf(a[k + 1]))
              break
            case 're':
              if (a.length >= 4) {
                const [x, y, w, h] = [numOf(a[0]), numOf(a[1]), numOf(a[2]), numOf(a[3])]
                noteLocal(x, y)
                noteLocal(x + w, y)
                noteLocal(x, y + h)
                noteLocal(x + w, y + h)
              }
              break
          }
          out.push(op)
          continue
        }
        if (PAINT_OPS.has(op.op)) {
          paint(op)
          continue
        }
        switch (op.op) {
          case 'W':
          case 'W*':
            pendingClip = op.op
            out.push(op)
            break
          case 'q':
            if (stack.length < 256) stack.push(cloneG(g))
            out.push(op)
            break
          case 'Q': {
            const p = stack.pop()
            if (p) g = p
            out.push(op)
            break
          }
          case 'cm':
            if (a.length >= 6 && a.slice(0, 6).every((x) => x.t === 'num')) g = { ...g, ctm: mul(a.slice(0, 6).map(numOf), g.ctm) }
            out.push(op)
            break
          case 'w':
            g = { ...g, lw: numOf(a[0]) || 0 }
            out.push(op)
            break
          case 'BT':
            tm = tlm = IDENTITY
            out.push(op)
            break
          case 'Tf':
            if (a[0]?.t === 'name' && a[1]?.t === 'num') setFont(a[0].v, a[1].v)
            out.push(op)
            break
          case 'Tc':
            g = { ...g, text: { ...g.text, tc: numOf(a[0]) || 0 } }
            out.push(op)
            break
          case 'Tw':
            g = { ...g, text: { ...g.text, tw: numOf(a[0]) || 0 } }
            out.push(op)
            break
          case 'Tz':
            g = { ...g, text: { ...g.text, th: (Number.isFinite(numOf(a[0])) ? numOf(a[0]) : 100) / 100 } }
            out.push(op)
            break
          case 'TL':
            g = { ...g, text: { ...g.text, tl: numOf(a[0]) || 0 } }
            out.push(op)
            break
          case 'Ts':
            g = { ...g, text: { ...g.text, rise: numOf(a[0]) || 0 } }
            out.push(op)
            break
          case 'Tr':
            g = { ...g, text: { ...g.text, mode: numOf(a[0]) || 0 } }
            out.push(op)
            break
          case 'Td':
            tlm = mul([1, 0, 0, 1, numOf(a[0]) || 0, numOf(a[1]) || 0], tlm)
            tm = tlm
            out.push(op)
            break
          case 'TD':
            g = { ...g, text: { ...g.text, tl: -(numOf(a[1]) || 0) } }
            tlm = mul([1, 0, 0, 1, numOf(a[0]) || 0, numOf(a[1]) || 0], tlm)
            tm = tlm
            out.push(op)
            break
          case 'Tm':
            if (a.length >= 6 && a.slice(0, 6).every((x) => x.t === 'num')) tlm = tm = a.slice(0, 6).map(numOf) as Matrix
            out.push(op)
            break
          case 'T*':
            nextLine()
            out.push(op)
            break
          case 'Tj':
          case 'TJ':
            show(op, 0)
            break
          case "'":
            nextLine()
            show(op, 0)
            break
          case '"': {
            const aw = numOf(a[0]) || 0
            const ac = numOf(a[1]) || 0
            g = { ...g, text: { ...g.text, tw: aw, tc: ac } }
            nextLine()
            show(op, 2)
            break
          }
          case 'BMC':
            mc.push({ target: out, index: out.length, keys: false, dirty: false })
            out.push(op)
            break
          case 'BDC': {
            const props = a[1]
            let keys = false
            let resName: string | undefined
            if (props?.t === 'dict') keys = props.v.has('ActualText') || props.v.has('Alt') || props.v.has('E')
            else if (props?.t === 'name') {
              const pr = ddict(ddict(res.effective, 'Properties'), props.v)
              if (pr && (dget(pr, 'ActualText') || dget(pr, 'Alt') || dget(pr, 'E'))) {
                keys = true
                resName = props.v
              }
            }
            mc.push({ target: out, index: out.length, keys, dirty: false, resName })
            out.push(op)
            break
          }
          case 'EMC': {
            const e = mc.pop()
            if (e) finishMc(e)
            out.push(op)
            break
          }
          case 'g':
            g = { ...g, fillPat: undefined }
            out.push(op)
            break
          case 'G':
            g = { ...g, strokePat: undefined }
            out.push(op)
            break
          case 'rg':
          case 'k':
            g = { ...g, fillPat: undefined }
            out.push(op)
            break
          case 'RG':
          case 'K':
            g = { ...g, strokePat: undefined }
            out.push(op)
            break
          case 'cs':
          case 'sc':
            g = { ...g, fillPat: undefined }
            out.push(op)
            break
          case 'CS':
          case 'SC':
            g = { ...g, strokePat: undefined }
            out.push(op)
            break
          case 'scn':
            g = { ...g, fillPat: a[a.length - 1]?.t === 'name' ? (a[a.length - 1] as { v: string }).v : undefined }
            out.push(op)
            break
          case 'SCN':
            g = { ...g, strokePat: a[a.length - 1]?.t === 'name' ? (a[a.length - 1] as { v: string }).v : undefined }
            out.push(op)
            break
          case 'gs': {
            const gsName = a[0]?.t === 'name' ? a[0].v : undefined
            const gsd = gsName ? ddict(ddict(res.effective, 'ExtGState'), gsName) : undefined
            const fontEntry = darr(gsd, 'Font')
            if (fontEntry && fontEntry.size() === 2) {
              const fd = fontEntry.lookup(0)
              const sz = fontEntry.lookup(1)
              if (fd instanceof PDFDict && sz instanceof PDFNumber) g = { ...g, text: { ...g.text, font: fontFromDict(fd), fontName: '(ExtGState font)', size: sz.asNumber() } }
            }
            const lw = dnum(gsd, 'LW')
            if (lw !== undefined) g = { ...g, lw }
            const smask = gsd ? ddict(gsd, 'SMask') : undefined
            if (gsName && gsd && smask && this.editing) {
              const rep = this.softMask(gsName, gsd, smask, g, res, depth)
              if (rep) {
                changed()
                out.push({ op: 'gs', args: [nameObj(rep)], pre: op.pre, raw: null })
                break
              }
            }
            out.push(op)
            break
          }
          case 'sh': {
            const shName = a[0]?.t === 'name' ? a[0].v : undefined
            const sh = shName ? dget(ddict(res.effective, 'Shading'), shName) : undefined
            const region = g.clip
            if (!this.editing || !sh || (region && !this.hits(region))) {
              out.push(op)
              break
            }
            const shDict = sh instanceof PDFStream ? sh.dict : sh instanceof PDFDict ? sh : undefined
            const type = dnum(shDict, 'ShadingType') ?? 0
            const full = region ? coverage(region, this.cfg.marks) >= 0.999 : false
            const clip = type === 2 || type === 3 ? clipOutOps(g.ctm, this.cfg.marks) : null
            changed()
            this.stats.shadings++
            if (!full && clip) out.push(...clip, op, mkOp('Q'))
            break
          }
          case 'Do': {
            const nm = a[0]?.t === 'name' ? a[0].v : undefined
            const xobjs = ddict(res.effective, 'XObject')
            const raw = nm && xobjs ? xobjs.get(N(nm)) : undefined
            const ref = raw instanceof PDFRef ? raw : undefined
            const obj = ref ? this.ctx.lookup(ref) : raw
            if (!nm || !(obj instanceof PDFStream)) {
              out.push(op)
              break
            }
            const sub = dname(obj.dict, 'Subtype')
            const key: unknown = ref ? refTag(ref) : obj
            if (sub === 'Image') doImage(op, obj, key)
            else if (sub === 'Form') doForm(op, ref, obj, key)
            else out.push(op)
            break
          }
          case 'BI':
            doInline(op)
            break
          default:
            out.push(op)
        }
      }
      outSlots.push({ ops: out, tail: slot.tail, changed: slotChanged })
    }
    // marked content left open at the end (unbalanced BDC) is finished too
    for (const e of mc) finishMc(e)
    return { slots: outSlots, changed: anyChange, endDepth: stack.length }
  }

  /** Soft-mask group under a mark: process the mask's own content and point a copy of the graphics state at it. */
  private softMask(gsName: string, gsd: PDFDict, smask: PDFDict, g: GS, res: ResEdit, depth: number): string | null {
    const gRaw = smask.get(N('G'))
    const gRef = gRaw instanceof PDFRef ? gRaw : undefined
    const gObj = gRef ? this.ctx.lookup(gRef) : gRaw
    if (!(gObj instanceof PDFStream)) return null
    if (depth >= MAX_DEPTH) throw new RedactRefused('Forms are nested too deeply to redact safely.')
    let parsed: ReturnType<typeof parseContent>
    try {
      parsed = parseContent(streamBytes(gObj))
    } catch (e) {
      throw new RedactRefused(`A soft-mask group on the page has content that cannot be read safely (${e instanceof Error ? e.message : String(e)}).`)
    }
    const mat = numbers(darr(gObj.dict, 'Matrix'))
    const matrix: Matrix = mat.length === 6 && mat.every(Number.isFinite) ? (mat as Matrix) : IDENTITY
    const childRes = new ResEdit(this.ctx, ddict(gObj.dict, 'Resources') ?? res.effective, this.owned)
    const child = this.process({ slots: [{ ops: parsed.ops, tail: parsed.tail }], res: childRes }, { ...cloneG(g), ctm: mul(matrix, g.ctm) }, depth + 1, 'softmask')
    if (!child.changed) return null
    // the original graphics state (and through it the original group) is replaced at this use site
    const gsRaw = ddict(res.effective, 'ExtGState')?.get(N(gsName))
    this.replaced.add(gsRaw instanceof PDFRef ? refTag(gsRaw) : gsd)
    const bytes = serializeContent(child.slots[0].ops, child.slots[0].tail)
    const newG =this.ctx.register(copyStream(this.ctx, gObj, bytes, childRes.override))
    const newSmask = PDFDict.withContext(this.ctx)
    for (const [k, v] of smask.entries()) newSmask.set(k, v)
    newSmask.set(N('G'), newG)
    const newGs = PDFDict.withContext(this.ctx)
    for (const [k, v] of gsd.entries()) newGs.set(k, v)
    newGs.set(N('SMask'), newSmask)
    return res.add('ExtGState', 'EpdfRdGs', newGs)
  }

  private record(texts: string[], covered: boolean[], rects: Rect[]): void {
    const orig = this.cfg.origMarks ?? this.cfg.marks
    let cur = ''
    let mark = -1
    const flush = (): void => {
      if (cur) this.removed.push({ text: cur, mark })
      cur = ''
      mark = -1
    }
    for (let i = 0; i < texts.length; i++) {
      if (!covered[i]) {
        flush()
        continue
      }
      if (mark < 0) {
        let best = 0
        let bestCov = -1
        orig.forEach((m, k) => {
          const c = coverage(rects[i], [m])
          if (c > bestCov) {
            bestCov = c
            best = k
          }
        })
        mark = best
      }
      cur += texts[i] === '�' ? '' : texts[i]
    }
    flush()
  }

  /** A pattern whose content can carry text or pictures (or whose data cannot be trusted): its paint is dropped under a mark. */
  private patternDangerous(res: PDFDict | undefined, name: string): boolean {
    const pat = dget(ddict(res, 'Pattern'), name)
    if (!pat) return false
    const cached = this.patternCache.get(pat)
    if (cached !== undefined) return cached
    let danger = false
    try {
      if (pat instanceof PDFStream) {
        const ops = parseContent(streamBytes(pat)).ops
        danger = ops.some((o) => ['Tj', 'TJ', "'", '"', 'BI', 'Do', 'sh'].includes(o.op))
      } else if (pat instanceof PDFDict) {
        const sh = dget(pat, 'Shading')
        const d = sh instanceof PDFStream ? sh.dict : sh instanceof PDFDict ? sh : undefined
        const t = dnum(d, 'ShadingType') ?? 0
        danger = t !== 2 && t !== 3
      }
    } catch {
      danger = true
    }
    this.patternCache.set(pat, danger)
    return danger
  }
}

// ---------------------------------------------------------------------------------------------------------
// Helpers

/** `q`, an even-odd clip that excludes the marks (in the local coordinate system of `ctm`), ready for the paint that follows (closed by `Q` by the caller). */
export function clipOutOps(ctm: Matrix, marks: readonly Rect[]): Op[] | null {
  const inv = invert(ctm)
  if (!inv) return null
  const ops: Op[] = [mkOp('q')]
  const poly = (r: Rect): void => {
    const pts = [apply(inv, r.x0, r.y0), apply(inv, r.x1, r.y0), apply(inv, r.x1, r.y1), apply(inv, r.x0, r.y1)]
    ops.push(mkOp('m', numObj(pts[0][0]), numObj(pts[0][1])))
    for (let i = 1; i < 4; i++) ops.push(mkOp('l', numObj(pts[i][0]), numObj(pts[i][1])))
    ops.push(mkOp('h'))
  }
  poly({ x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 })
  for (const m of marks) poly(m)
  ops.push(mkOp('W*'), mkOp('n'))
  return ops
}

const INLINE_KEYS: Record<string, string> = { BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms', F: 'Filter', H: 'Height', IM: 'ImageMask', I: 'Interpolate', W: 'Width' }
const INLINE_CS: Record<string, string> = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' }
const INLINE_FILTERS: Record<string, string> = { AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode' }

function expandNames(o: PdfObj, table: Record<string, string>): PdfObj {
  if (o.t === 'name') return { t: 'name', v: table[o.v] ?? o.v }
  if (o.t === 'arr') return { t: 'arr', v: o.v.map((x) => expandNames(x, table)) }
  return o
}

/** An inline image as a stand-alone image stream (abbreviations expanded), or null if it cannot be represented. */
export function inlineToStream(ctx: PDFContext, inl: InlineImage, resources: PDFDict | undefined): PDFStream | null {
  void resources
  const d = PDFDict.withContext(ctx)
  for (const [k, v] of inl.dict) {
    const key = INLINE_KEYS[k] ?? k
    let val = v
    if (key === 'ColorSpace') {
      val = expandNames(v, INLINE_CS)
      if (val.t === 'arr' && val.v[1]) val = { t: 'arr', v: [val.v[0], expandNames(val.v[1], INLINE_CS), ...val.v.slice(2)] }
    } else if (key === 'Filter') val = expandNames(v, INLINE_FILTERS)
    try {
      d.set(N(key), toPdfLib(ctx, val))
    } catch {
      return null
    }
  }
  d.set(N('Type'), N('XObject'))
  d.set(N('Subtype'), N('Image'))
  return PDFRawStream.of(d, inl.data)
}

const DROP = new Set(['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms', 'Metadata', 'PieceInfo', 'LastModified'])

/** A new Flate stream with `obj`'s dictionary (minus encoding keys) and the given content. */
export function copyStream(ctx: PDFContext, obj: PDFStream, bytes: Uint8Array, resources?: PDFDict): PDFRawStream {
  const lit: Record<string, PDFObject> = {}
  for (const [k, v] of obj.dict.entries()) {
    const key = nameText(k)
    if (!DROP.has(key)) lit[key] = v
  }
  if (resources) lit['Resources'] = resources
  return ctx.flateStream(bytes, lit as never)
}

