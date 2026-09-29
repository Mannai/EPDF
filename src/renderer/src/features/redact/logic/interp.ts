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
import { GLYPH_COVERAGE, coverage, intersect, quadCoverage, rectQuad, touches, type Quad, type Rect } from './geom'
import { redactImage } from './imageRedact'
import { fromPdfLib, toPdfLib } from './pdfconv'
import { rewriteShow, type GlyphSpan } from './textRewrite'
import { convexHull, hullMeetsRect, maxStretch, miterRatio, polyArea, subtractMarks, type Pt } from './vector'

/**
 * The redaction interpreter. It walks a page's content (and the Form XObjects, soft-mask groups and inline images
 * it reaches) with a full graphics/text state, and — when editing — rewrites everything that lies under the
 * marks: glyphs are cut out of text-showing operators (advance-preserving), images lose the covered pixels,
 * drawn shapes (subpaths) that reach a mark are removed with their operators (filled rectangles are cut along the
 * marks instead), shadings and pattern paints that reach a mark are removed, marked-content replacement text is
 * stripped.
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
  /** Drawn shapes (subpaths) removed or cut that lay under the marks. */
  paths: number
  /** Drawn shapes that crossed the edge of a mark and were removed entirely (also outside the marks). */
  pathsCollateral: number
  /** Shadings removed that were painted only under the marks. */
  shadings: number
  /** Shadings removed that were also painted outside the marks. */
  shadingsCollateral: number
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
  pathsCollateral: 0,
  shadings: 0,
  shadingsCollateral: 0,
  patterns: 0,
  forms: 0,
  marked: 0
})

export interface GlyphRec {
  text: string
  /** Bounding box in user space. */
  rect: Rect
  known: boolean
  /** Extent along the baseline in text space (from the run origin). */
  x0: number
  x1: number
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
  /** Text space -> user space, and the vertical band of the glyph boxes in text space. */
  m: Matrix
  y0: number
  y1: number
}

/** The exact (possibly rotated) box of a stretch of glyphs of a run. */
export function runQuad(run: Pick<RunRec, 'm' | 'y0' | 'y1'>, x0: number, x1: number): Quad {
  const c = [apply(run.m, x0, run.y0), apply(run.m, x1, run.y0), apply(run.m, x1, run.y1), apply(run.m, x0, run.y1)]
  return [c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]]
}

export interface RemovedRec {
  text: string
  /** Index (in the original mark list) of the first mark covering the removed text. */
  mark: number
}

export interface WalkCfg {
  /** Disjoint rects (user space): bounding boxes of the marks, used for everything except glyph coverage. */
  marks: Rect[]
  /** The exact shapes of the marks (rects or rotated quads), possibly overlapping, in mark order. */
  shapes?: Quad[]
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

  /** The private copy of a category dictionary (created on first use). */
  own(category: string): PDFDict {
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
    return cat
  }

  /** Adds `ref` to a category (XObject, ExtGState, Font, ...) under a fresh name; returns the name. */
  add(category: string, prefix: string, ref: PDFObject): string {
    const cat = this.own(category)
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
  fillPat?: PatSel
  strokePat?: PatSel
  clip: Rect | null
  lw: number
  /** Line join (0 miter, 1 round, 2 bevel), line cap (0 butt, 1 round, 2 square) and miter limit. */
  lj: number
  lc: number
  ml: number
}

/**
 * A `/Name scn` that selected a pattern. If every paint that used it was dropped (it reached a mark), the
 * selection is neutralised so the pattern can be deleted.
 */
interface PatSel {
  name: string
  stroke: boolean
  target: Op[]
  index: number
  keeps: number
  drops: number
  /** The pattern object (reference tag, or the object itself), to find other uses of the same pattern. */
  key: unknown
  /** A paint with this selection was dropped and the pattern can carry text or pictures. */
  danger: boolean
}

/**
 * One subpath of the path being built: the operators that make it (so it can be removed on its own) and its
 * geometry. A subpath starts at `m` or `re`; `l`/`c`/`h` that follow a closed subpath without a new `m` continue
 * it, so a subpath that is kept never starts without a current point.
 */
interface SubPath {
  refs: { arr: Op[]; idx: number }[]
  /** Every point in user space, control points included (the shape lies in their convex hull). */
  pts: Pt[]
  /** User-space pieces of the outline: lines (2 points) and curves (4 control points). */
  segs: Pt[][]
  startL: Pt
  startU: Pt
  lastL: Pt
  lastU: Pt
  /** The last operator closed it (`h` or `re`). */
  closed: boolean
  /** A lone `re` (local x, y, w, h): it can be cut along the marks instead of being removed. */
  rect?: [number, number, number, number]
  /** Miter length / line width at its corners (local space). */
  ratios: number[]
  /** It has zero-length pieces or unusable numbers: the reach of its joins cannot be bounded exactly. */
  odd: boolean
  firstDir?: Pt
  lastDir?: Pt
}

const cloneG = (g: GS): GS => ({ ...g, text: { ...g.text } })

export const initialState = (): GS => ({
  ctm: IDENTITY,
  text: { font: undefined, fontName: '', size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0 },
  clip: null,
  lw: 1,
  lj: 0,
  lc: 0,
  ml: 10
})

const bboxOf = (pts: readonly Pt[]): Rect => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return { x0, y0, x1, y1 }
}

/** The part of convex polygon `p` inside convex polygon `q` (both counter-clockwise). */
function convexIntersection(p: Pt[], q: Pt[]): Pt[] {
  let out = p
  for (let i = 0; i < q.length && out.length; i++) {
    const a = q[i]
    const b = q[(i + 1) % q.length]
    const input = out
    out = []
    const side = (s: Pt): number => (b[0] - a[0]) * (s[1] - a[1]) - (b[1] - a[1]) * (s[0] - a[0])
    for (let k = 0; k < input.length; k++) {
      const s = input[k]
      const e = input[(k + 1) % input.length]
      const ss = side(s)
      const se = side(e)
      if (ss >= 0) out.push(s)
      if ((ss >= 0) !== (se >= 0)) {
        const t = ss / (ss - se)
        out.push([s[0] + t * (e[0] - s[0]), s[1] + t * (e[1] - s[1])])
      }
    }
  }
  return out
}

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
  /** Every pattern selection seen on the page (forms and soft masks included). */
  private allSels: PatSel[] = []
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

    const patSels: PatSel[] = []
    let out: Op[] = []
    let slotChanged = false
    const changed = (): void => {
      slotChanged = true
      anyChange = true
      for (const e of mc) e.dirty = true
    }

    // Path state. Operators are never spliced out while walking (other bookkeeping holds indices into `out`):
    // a removed or rewritten operator is swapped for a placeholder that `expand` maps to its replacement, and every
    // output list is compacted at the end. A path may span content streams, so each operator is referenced by
    // (list, index).
    let inPath = false
    let subs: SubPath[] = []
    let cur: Pt | null = null
    let pendingClip: string | null = null
    const expand = new Map<Op, Op[]>()
    const dirty = new Set<Op[]>()

    const resetPath = (): void => {
      inPath = false
      subs = []
      cur = null
      pendingClip = null
    }
    const toU = (p: Pt): Pt => apply(g.ctm, p[0], p[1])
    const openSub = (start: Pt): SubPath => {
      const u = toU(start)
      const s: SubPath = { refs: [], pts: [u], segs: [], startL: start, startU: u, lastL: start, lastU: u, closed: false, ratios: [], odd: false }
      subs.push(s)
      return s
    }
    /** Adds an outline piece (local points: a line or a curve's four control points) and the join before it. */
    const segment = (s: SubPath, L: Pt[]): void => {
      const U = L.map(toU)
      s.segs.push(U)
      for (const u of U) s.pts.push(u)
      s.lastL = L[L.length - 1]
      s.lastU = U[U.length - 1]
      const a = L[0]
      const b = L[L.length - 1]
      let din: Pt | undefined
      let dout: Pt | undefined
      for (let k = 1; k < L.length && !din; k++) {
        const d: Pt = [L[k][0] - a[0], L[k][1] - a[1]]
        if (d[0] || d[1]) din = d
      }
      for (let k = L.length - 2; k >= 0 && !dout; k--) {
        const d: Pt = [b[0] - L[k][0], b[1] - L[k][1]]
        if (d[0] || d[1]) dout = d
      }
      if (!din || !dout) {
        s.odd = true
        return
      }
      if (s.lastDir) s.ratios.push(miterRatio(s.lastDir, din))
      else s.firstDir = din
      s.lastDir = dout
    }
    const closeJoin = (s: SubPath): void => {
      if (s.lastDir && s.firstDir) s.ratios.push(miterRatio(s.lastDir, s.firstDir))
    }
    const buildPath = (op: Op): void => {
      const a = op.args
      const ref = { arr: out, idx: out.length }
      const P = (i: number): Pt => [numOf(a[i]), numOf(a[i + 1])]
      switch (op.op) {
        case 'm': {
          const p = P(0)
          openSub(p).refs.push(ref)
          cur = p
          return
        }
        case 're': {
          const [x, y, w, h] = [numOf(a[0]), numOf(a[1]), numOf(a[2]), numOf(a[3])]
          const s = openSub([x, y])
          s.refs.push(ref)
          const c: Pt[] = [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h]
          ]
          for (let k = 0; k < 4; k++) segment(s, [c[k], c[(k + 1) % 4]])
          closeJoin(s)
          s.closed = true
          s.rect = [x, y, w, h]
          s.lastL = s.startL
          s.lastU = s.startU
          s.firstDir = s.lastDir = undefined
          cur = [x, y]
          return
        }
        case 'h': {
          const s = subs[subs.length - 1] ?? openSub(cur ?? [0, 0])
          s.refs.push(ref)
          s.rect = undefined
          if (!s.closed && cur) {
            if (cur[0] !== s.startL[0] || cur[1] !== s.startL[1]) segment(s, [cur, s.startL])
            closeJoin(s)
          }
          s.closed = true
          s.lastL = s.startL
          s.lastU = s.startU
          s.firstDir = s.lastDir = undefined
          cur = s.startL
          return
        }
        default: {
          const pts: Pt[] = op.op === 'l' ? [P(0)] : op.op === 'c' ? [P(0), P(2), P(4)] : op.op === 'v' ? [cur ?? P(0), P(0), P(2)] : [P(0), P(2), P(2)]
          const end = pts[pts.length - 1]
          const s = subs[subs.length - 1]
          if (!s || !cur) {
            // no current point (malformed): the operator still belongs to a subpath of its own
            openSub(end).refs.push(ref)
            cur = end
            return
          }
          s.refs.push(ref)
          s.rect = undefined
          if (s.closed) s.closed = false // continues from the start point after `h` / `re`
          segment(s, [cur, ...pts])
          cur = end
        }
      }
    }
    /** Removes an operator of the path (it is dropped from the output list when the lists are compacted). */
    const kill = (ref: { arr: Op[]; idx: number }, replacement: Op[] = []): void => {
      const ph: Op = { op: '', args: [], pre: new Uint8Array(0), raw: null }
      expand.set(ph, replacement)
      ref.arr[ref.idx] = ph
      dirty.add(ref.arr)
    }

    const setFont = (fontName: string, size: number): void => {
      const fonts = ddict(res.effective, 'Font')
      const fd = fonts ? dget(fonts, fontName) : undefined
      const font = fd instanceof PDFDict ? fontFromDict(fd) : unreadableFont('Unknown', fontName, 'the font is missing from the page resources')
      g = { ...g, text: { ...g.text, font, fontName, size } }
    }

    /** The box that replaces a removed image: the image's area outside the marks (the overlay covers the rest). */
    const boxOps = (): Op[] => {
      const inv = invert(g.ctm)
      if (!inv) return []
      const pieces = subtractMarks([toU([0, 0]), toU([1, 0]), toU([1, 1]), toU([0, 1])], this.cfg.marks)
      if (!pieces.length) return []
      const [r, gr, b] = this.cfg.fill
      return [mkOp('q'), mkOp('rg', numObj(r), numObj(gr), numObj(b)), ...pieces.flatMap((p) => polygonOps(p, inv)), mkOp('f'), mkOp('Q')]
    }

    const show = (op: Op, strArg: number, spacing?: { tw: number; tc: number }): void => {
      const ts = g.text
      const font = ts.font
      if (!font) throw new RedactRefused('A page shows text before selecting a font, so it cannot be redacted safely.')
      const th = ts.th
      const tc = spacing?.tc ?? ts.tc
      const tw = spacing?.tw ?? ts.tw
      const band = glyphBand(font)
      // text painted with a pattern keeps that pattern selection alive
      if (g.fillPat) g.fillPat.keeps++
      if (g.strokePat && (ts.mode === 1 || ts.mode === 2 || ts.mode === 5 || ts.mode === 6)) g.strokePat.keeps++
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
      const y0 = ts.rise + band.desc * ts.size
      const y1 = ts.rise + band.asc * ts.size
      const rects = glyphs.map((gl) => transformRect(m, gl.x0, y0, gl.x1, y1))
      const upright = Math.abs(m[1]) < 1e-3 * Math.abs(m[0]) + 1e-9 && Math.abs(m[2]) < 1e-3 * Math.abs(m[3]) + 1e-9 && m[0] > 0 && m[3] > 0
      if (!this.editing) {
        this.runs.push({
          glyphs: glyphs.map((gl, i) => ({ text: gl.text, rect: rects[i], known: gl.known, x0: gl.x0, x1: gl.x1 })),
          fontSize: ts.size,
          x: m[4],
          y: m[5],
          visible: ts.mode !== 3 && ts.mode !== 7 && ts.size !== 0,
          upright,
          sourceId,
          m,
          y0,
          y1
        })
      }
      let replaced = false
      const shapes = this.cfg.shapes ?? this.cfg.marks.map(rectQuad)
      if (this.editing && glyphs.length && rects.some((r) => this.hits(r))) {
        const quads = glyphs.map((gl) => runQuad({ m, y0, y1 }, gl.x0, gl.x1))
        const covered = quads.map((q) => quadCoverage(q, shapes) >= GLYPH_COVERAGE)
        if (covered.some(Boolean)) {
          const unreliable = !font.editable || glyphs.some((gl, i) => covered[i] && !gl.known) || !(Math.abs(ts.size * th) > 1e-9)
          let ops: Op[]
          if (unreliable) {
            ops = rewriteShow({ op, strArg, glyphs: glyphs as GlyphSpan[], covered: covered.map(() => true), size: ts.size, hScale: th, wholeAdvance: u })
            this.stats.wholeRuns++
          } else {
            ops = rewriteShow({ op, strArg, glyphs: glyphs as GlyphSpan[], covered, size: ts.size, hScale: th })
          }
          this.record(glyphs.map((gl) => gl.text), unreliable ? glyphs.map(() => true) : covered, quads)
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
      res.own('XObject') // so the original entry can be dropped from a private copy
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
      res.own('XObject')
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
      // Every form is examined, not only those whose BBox meets a mark: content outside its BBox is clipped away
      // on screen but is still text a reader can extract (and the self-check would rightly refuse to leave it).
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
      const sels = [PAINT_FILL.has(op.op) ? g.fillPat : undefined, PAINT_STROKE.has(op.op) ? g.strokePat : undefined].filter((s): s is PatSel => !!s)
      const keep = (): void => {
        for (const s of sels) s.keeps++
      }
      if (!inPath || !this.editing || subs.length === 0) {
        keep()
        finishPath(op)
        return
      }
      const marks = this.cfg.marks
      const fills = PAINT_FILL.has(op.op)
      const strokes = PAINT_STROKE.has(op.op)
      const clip = pendingClip
      // the shape paints (or clips to) an area: its subpaths are closed implicitly and act on each other's winding
      const area = fills || clip !== null
      const closes = area || op.op === 's' || op.op === 'b' || op.op === 'b*'
      const base = strokes ? (Math.max(0, g.lw) / 2) * maxStretch(g.ctm) : 0
      // (an unknown cap style counts as square, an unknown join style as miter: the farthest reaching)
      const capFactor = g.lc === 0 || g.lc === 1 ? 1 : Math.SQRT2
      const radius = (s: SubPath): number => (strokes ? base * Math.max(capFactor, joinFactor(s, closes)) + 1e-9 : 0)
      const meets = (pts: readonly Pt[], r: number): boolean => marks.some((m) => hullMeetsRect(pts, m, r))
      const count = (s: SubPath): void => {
        if (coverage(bboxOf(s.pts), marks) >= 0.999) this.stats.paths++
        else this.stats.pathsCollateral++
      }
      const dropAll = (): void => {
        for (const s of subs) for (const r of s.refs) kill(r)
        changed()
        endEmpty(op, clip)
      }

      if (op.op === 'n' && !clip) {
        // an unpainted, unclipping path: nothing is visible, and its geometry may carry information
        if (!subs.some((s) => meets(s.pts, 0))) {
          finishPath(op)
          return
        }
        this.stats.paths += subs.length
        dropAll()
        return
      }

      if (sels.length) {
        // Painted with a pattern: what the pattern draws under the mark cannot be cut out, so a pattern paint that
        // reaches a mark is removed whole.
        if (!subs.some((s) => meets(s.pts, radius(s)))) {
          keep()
          finishPath(op)
          return
        }
        for (const s of subs) count(s)
        for (const sel of sels) {
          sel.drops++
          if (this.patternDangerous(res.effective, sel.name)) {
            sel.danger = true
            this.stats.patterns++
          }
          res.own('Pattern')
          const raw = ddict(res.effective, 'Pattern')?.get(N(sel.name))
          if (raw) this.replaced.add(raw instanceof PDFRef ? refTag(raw) : raw)
        }
        dropAll()
        return
      }

      // Each subpath whose outline (or stroke) reaches a mark goes; a lone filled rectangle is cut along the marks.
      const state: ('keep' | 'split' | 'drop')[] = subs.map((s) => {
        const segs = s.segs.length ? s.segs : [[s.startU, s.startU]]
        const r = radius(s)
        if (segs.some((seg) => meets(seg, r))) return 'drop'
        if (closes && !s.closed && meets([s.lastU, s.startU], r)) return 'drop'
        return 'keep'
      })
      if (state.every((x) => x === 'keep')) {
        keep()
        finishPath(op)
        return
      }
      const inv = invert(g.ctm)
      const pieces = new Map<number, Pt[][]>()
      if (area && !strokes && inv) {
        subs.forEach((s, i) => {
          if (state[i] !== 'drop' || !s.rect || s.odd || !s.rect.every(Number.isFinite) || s.rect[2] === 0 || s.rect[3] === 0) return
          const [x, y, w, h] = s.rect
          const p = subtractMarks([toU([x, y]), toU([x + w, y]), toU([x + w, y + h]), toU([x, y + h])], marks)
          if (p.length) {
            pieces.set(i, p)
            state[i] = 'split'
          }
        })
      }
      if (area) {
        // A removed subpath changes the winding of the others where they overlap: anything whose hull meets the
        // hull of a removed one outside the marks goes too, so what remains paints (or clips to) a subset of the
        // original — a removed outline can never turn a hole into a filled area.
        const hulls = subs.map((s) => {
          const h = convexHull(s.pts)
          return h.length >= 3 && polyArea(h) > 0 ? h : null
        })
        const boxes = subs.map((s) => bboxOf(s.pts))
        const queue = state.flatMap((st, i) => (st === 'drop' ? [i] : []))
        while (queue.length) {
          const d = queue.pop()!
          const hd = hulls[d]
          if (!hd) continue
          for (let k = 0; k < subs.length; k++) {
            if (state[k] === 'drop' || !hulls[k] || !intersect(boxes[k], boxes[d])) continue
            const both = convexIntersection(hulls[k]!, hd)
            if (both.length < 3 || !(Math.abs(polyArea(both)) > 1e-9)) continue
            if (!subtractMarks(both, marks).length) continue
            state[k] = 'drop'
            pieces.delete(k)
            queue.push(k)
          }
        }
      }
      let survivors = 0
      subs.forEach((s, i) => {
        if (state[i] === 'keep') {
          survivors++
          return
        }
        if (state[i] === 'split') {
          survivors++
          this.stats.paths++
          const [, , w, h] = s.rect!
          kill(s.refs[0], pieces.get(i)!.flatMap((p) => (axisAligned(g.ctm) ? [rectOp(p, inv!, w, h)] : polygonOps(p, inv!))))
          return
        }
        count(s)
        for (const r of s.refs) kill(r)
      })
      changed()
      if (!survivors) {
        endEmpty(op, clip)
        return
      }
      keep()
      finishPath(op)
    }
    /** Miter length / line width that bounds the joins of a subpath (1 when joins are round or bevelled). */
    const joinFactor = (s: SubPath, closes: boolean): number => {
      if (g.lj === 1 || g.lj === 2) return 1
      const ml = Math.max(1, Number.isFinite(g.ml) ? g.ml : 10)
      if (s.odd) return ml
      const ratios = [...s.ratios]
      if (closes && !s.closed && s.lastDir && s.firstDir) {
        const d: Pt = [s.startL[0] - s.lastL[0], s.startL[1] - s.lastL[1]]
        if (d[0] || d[1]) ratios.push(miterRatio(s.lastDir, d), miterRatio(d, s.firstDir))
        else ratios.push(miterRatio(s.lastDir, s.firstDir))
      }
      let f = 1
      for (const r of ratios) if (r <= ml) f = Math.max(f, r) // longer miters are drawn bevelled
      return f
    }
    /**
     * Nothing of the path is left: a clip becomes an empty clip (a zero-size rectangle placed outside every mark,
     * where its first operator was); any other path is dropped with its painting operator.
     */
    const endEmpty = (op: Op, clip: string | null): void => {
      void op
      if (clip) {
        const far = { x: Math.min(...this.cfg.marks.map((m) => m.x0)) - 16, y: Math.min(...this.cfg.marks.map((m) => m.y0)) - 16 }
        const inv = invert(g.ctm)
        const [lx, ly] = inv ? apply(inv, far.x, far.y) : [0, 0]
        const first = subs[0]?.refs[0]
        const empty = mkOp('re', numObj(lx), numObj(ly), numObj(0), numObj(0))
        if (first) expand.set(first.arr[first.idx], [empty])
        else out.push(empty)
        out.push(mkOp('n'))
        g = { ...g, clip: { x0: far.x, y0: far.y, x1: far.x, y1: far.y } }
      }
      resetPath()
    }
    const finishPath = (op: Op): void => {
      out.push(op)
      afterPaint(op)
    }
    const afterPaint = (op: Op): void => {
      void op
      if (pendingClip && subs.length) {
        const b = bboxOf(subs.flatMap((s) => s.pts))
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
          inPath = true
          if (this.editing) buildPath(op)
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
          case 'j':
            g = { ...g, lj: numOf(a[0]) || 0 }
            out.push(op)
            break
          case 'J':
            g = { ...g, lc: numOf(a[0]) || 0 }
            out.push(op)
            break
          case 'M':
            g = { ...g, ml: Number.isFinite(numOf(a[0])) ? numOf(a[0]) : 10 }
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
          case 'SCN': {
            const last = a[a.length - 1]
            let sel: PatSel | undefined
            if (last?.t === 'name') {
              const raw = ddict(res.effective, 'Pattern')?.get(N(last.v))
              sel = { name: last.v, stroke: op.op === 'SCN', target: out, index: out.length, keeps: 0, drops: 0, key: raw instanceof PDFRef ? refTag(raw) : (raw ?? `missing:${last.v}`), danger: false }
              patSels.push(sel)
              this.allSels.push(sel)
            }
            g = op.op === 'scn' ? { ...g, fillPat: sel } : { ...g, strokePat: sel }
            out.push(op)
            break
          }
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
            const lj = dnum(gsd, 'LJ')
            if (lj !== undefined) g = { ...g, lj }
            const lc = dnum(gsd, 'LC')
            if (lc !== undefined) g = { ...g, lc }
            const ml = dnum(gsd, 'ML')
            if (ml !== undefined) g = { ...g, ml }
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
            const shDict = sh instanceof PDFStream ? sh.dict : sh instanceof PDFDict ? sh : undefined
            // where it can paint: the clip, narrowed by the shading's own BBox
            let region = g.clip
            const bb = numbers(darr(shDict, 'BBox'))
            if (bb.length === 4 && bb.every(Number.isFinite)) {
              const r = transformRect(g.ctm, Math.min(bb[0], bb[2]), Math.min(bb[1], bb[3]), Math.max(bb[0], bb[2]), Math.max(bb[1], bb[3]))
              region = region ? (intersect(region, r) ?? { x0: region.x0, y0: region.y0, x1: region.x0, y1: region.y0 }) : r
            }
            // (a shading clipped to nothing, e.g. by a clip that lay under a mark, paints nothing and goes too)
            const empty = !!region && (region.x1 - region.x0 <= 0 || region.y1 - region.y0 <= 0)
            if (!this.editing || !sh || (region && !empty && !this.hits(region))) {
              out.push(op)
              break
            }
            // Its colours are data (a sampled function can hold anything along the axis), so a shading that reaches
            // a mark is removed from this use, not clipped.
            changed()
            if (empty || (region && coverage(region, this.cfg.marks) >= 0.999)) this.stats.shadings++
            else this.stats.shadingsCollateral++
            if (shName) {
              res.own('Shading')
              const raw = ddict(res.effective, 'Shading')?.get(N(shName))
              this.replaced.add(raw instanceof PDFRef ? refTag(raw) : raw)
            }
            break
          }
          case 'Do': {
            if (g.fillPat) g.fillPat.keeps++ // an image mask is painted with the current colour
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
    // pattern selections whose every paint was dropped become plain black selections
    for (const s of patSels) {
      if (s.drops > 0 && s.keeps === 0) s.target[s.index] = mkOp(s.stroke ? 'G' : 'g', numObj(0))
    }
    // removed and rewritten path operators are dropped / expanded now that no index into the lists is needed
    const slots = outSlots.map((o) => (dirty.has(o.ops) ? { ...o, ops: o.ops.flatMap((x) => expand.get(x) ?? [x]), changed: true } : o))
    if (depth === 0 && this.editing) this.checkPatterns()
    return { slots, changed: anyChange, endDepth: stack.length }
  }

  /**
   * A pattern that can draw text or pictures must not stay in the file after a paint with it was removed under a
   * mark: if the same pattern is still painted elsewhere on the page, the page is refused.
   */
  private checkPatterns(): void {
    const kept = new Set(this.allSels.filter((s) => s.keeps > 0).map((s) => s.key))
    for (const s of this.allSels) {
      if (s.danger && s.drops > 0 && kept.has(s.key))
        throw new RedactRefused('A pattern that draws text or pictures is painted both under a mark and elsewhere on the page, so it cannot be removed safely.')
    }
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
    const newG = this.ctx.register(copyStream(this.ctx, gObj, bytes, childRes.override))
    const newSmask = PDFDict.withContext(this.ctx)
    for (const [k, v] of smask.entries()) newSmask.set(k, v)
    newSmask.set(N('G'), newG)
    const newGs = PDFDict.withContext(this.ctx)
    for (const [k, v] of gsd.entries()) newGs.set(k, v)
    newGs.set(N('SMask'), newSmask)
    return res.add('ExtGState', 'EpdfRdGs', newGs)
  }

  private record(texts: string[], covered: boolean[], quads: Quad[]): void {
    const orig = this.cfg.shapes ?? this.cfg.marks.map(rectQuad)
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
          const c = quadCoverage(quads[i], [m])
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

/** A user-space polygon as a closed subpath in the local coordinates given by `inv` (the inverse CTM). */
function polygonOps(poly: readonly Pt[], inv: Matrix): Op[] {
  const loc = poly.map((p) => apply(inv, p[0], p[1]))
  return [mkOp('m', numObj(loc[0][0]), numObj(loc[0][1])), ...loc.slice(1).map((q) => mkOp('l', numObj(q[0]), numObj(q[1]))), mkOp('h')]
}

/** True when the matrix maps axis-aligned rectangles to axis-aligned rectangles. */
function axisAligned(m: Matrix): boolean {
  const tol = 1e-9 * (Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3]))
  return (Math.abs(m[1]) <= tol && Math.abs(m[2]) <= tol) || (Math.abs(m[0]) <= tol && Math.abs(m[3]) <= tol)
}

/** A piece of a cut rectangle (user space) as an `re` in local coordinates, drawn in the original's direction. */
function rectOp(poly: readonly Pt[], inv: Matrix, w: number, h: number): Op {
  const loc = poly.map((p) => apply(inv, p[0], p[1]))
  const b = bboxOf(loc)
  const x = w > 0 ? b.x0 : b.x1
  const y = h > 0 ? b.y0 : b.y1
  return mkOp('re', numObj(x), numObj(y), numObj(w > 0 ? b.x1 - b.x0 : b.x0 - b.x1), numObj(h > 0 ? b.y1 - b.y0 : b.y0 - b.y1))
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

