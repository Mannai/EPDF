import { PDFDict, PDFRef, PDFStream, type PDFDocument } from 'pdf-lib'
import { loadPageSource } from '../../textedit/pdfcontent/analyze'
import { parseContent, type Op, type PdfObj } from '../../textedit/pdfcontent/content'
import { IDENTITY, apply, mul, transformRect, type Matrix } from '../../textedit/pdfcontent/matrix'
import { N, darr, ddict, dname, numbers, refTag, streamBytes } from '../../textedit/pdfcontent/pdfutil'

/**
 * Vector geometry of a page: the straight lines, rectangles and circles that its content draws, and the
 * images it paints, all in PDF user space. A small content-stream interpreter (graphics state, `cm`, paths,
 * paint operators, Form XObjects); it never renders anything and never throws on odd content (bad streams
 * are skipped and reported as warnings). Pure `pdf-lib` + TypeScript, so it runs in Node.
 */

export interface RawLine {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Stroke thickness in points. */
  width: number
  dashed: boolean
}

export interface RawRect {
  /** Normalised: x0 < x1, y0 < y1. */
  x0: number
  y0: number
  x1: number
  y1: number
  stroke: boolean
  fill: boolean
  /** 0 = black, 1 = white (0.5 when unknown). */
  fillLuma: number
  strokeLuma: number
  width: number
  dashed: boolean
}

export interface RawCircle {
  cx: number
  cy: number
  r: number
  stroke: boolean
  fill: boolean
  fillLuma: number
  strokeLuma: number
}

export interface RawImage {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface VectorContent {
  lines: RawLine[]
  rects: RawRect[]
  circles: RawCircle[]
  images: RawImage[]
  warnings: string[]
}

const MAX_OPS = 2_000_000
const MAX_SHAPES = 80_000
const MAX_FORM_DEPTH = 8
const THIN = 1.6

interface GState {
  ctm: Matrix
  lw: number
  dashed: boolean
  fillLuma: number
  strokeLuma: number
}

type Pt = [number, number]
interface SubPath {
  pts: Pt[]
  /** Control points of curves (used only for the bounding box of circles). */
  ctrl: Pt[]
  curves: number
  closed: boolean
  fromRe: boolean
}

const num = (a: PdfObj | undefined): number => (a?.t === 'num' ? a.v : NaN)
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)

/** Luminance (0 dark .. 1 light) of a colour operand list. */
function luma(nums: number[]): number {
  if (nums.length === 1) return clamp01(nums[0])
  if (nums.length === 3) return clamp01(0.299 * nums[0] + 0.587 * nums[1] + 0.114 * nums[2])
  if (nums.length === 4) {
    const [c, m, y, k] = nums
    return clamp01(0.299 * (1 - c) * (1 - k) + 0.587 * (1 - m) * (1 - k) + 0.114 * (1 - y) * (1 - k))
  }
  return 0.5
}

const near = (a: number, b: number, eps = 0.05): boolean => Math.abs(a - b) <= eps

/** Corners of an axis-aligned rectangle given as 4 (or 5, closed) points; null if it is not one. */
function rectOfPoints(pts: Pt[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let p = pts
  if (p.length === 5 && near(p[0][0], p[4][0]) && near(p[0][1], p[4][1])) p = p.slice(0, 4)
  if (p.length !== 4) return null
  const [a, b, c, d] = p
  const ok1 = near(a[1], b[1]) && near(b[0], c[0]) && near(c[1], d[1]) && near(d[0], a[0])
  const ok2 = near(a[0], b[0]) && near(b[1], c[1]) && near(c[0], d[0]) && near(d[1], a[1])
  if (!ok1 && !ok2) return null
  const xs = p.map((q) => q[0])
  const ys = p.map((q) => q[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

class Collector {
  lines: RawLine[] = []
  rects: RawRect[] = []
  circles: RawCircle[] = []
  images: RawImage[] = []
  warnings: string[] = []
  ops = 0
  full = false

  constructor(readonly pdf: PDFDocument) {}

  private size(): boolean {
    if (this.lines.length + this.rects.length + this.circles.length > MAX_SHAPES) {
      if (!this.full) this.warnings.push('This page has a very large number of vector shapes; only the first ones were analysed')
      this.full = true
    }
    return this.full
  }

  paint(paths: SubPath[], g: GState, stroke: boolean, fill: boolean): void {
    if (this.size()) return
    const scale = Math.sqrt(Math.abs(g.ctm[0] * g.ctm[3] - g.ctm[1] * g.ctm[2])) || 1
    const width = g.lw * scale
    for (const sp of paths) {
      const box = sp.fromRe || (sp.curves === 0 && sp.pts.length >= 4) ? rectOfPoints(sp.pts) : null
      if (box) {
        const w = box.x1 - box.x0
        const h = box.y1 - box.y0
        if (w < 0.01 && h < 0.01) continue
        if (Math.min(w, h) <= THIN && Math.max(w, h) > 3) {
          // A hairline rectangle (or a thin filled bar) is how many producers draw a rule.
          const horizontal = w >= h
          const thick = Math.max(Math.min(w, h), stroke ? width : 0)
          this.lines.push(
            horizontal
              ? { x0: box.x0, x1: box.x1, y0: (box.y0 + box.y1) / 2, y1: (box.y0 + box.y1) / 2, width: thick, dashed: g.dashed }
              : { x0: (box.x0 + box.x1) / 2, x1: (box.x0 + box.x1) / 2, y0: box.y0, y1: box.y1, width: thick, dashed: g.dashed }
          )
          continue
        }
        this.rects.push({ ...box, stroke, fill, fillLuma: g.fillLuma, strokeLuma: g.strokeLuma, width, dashed: g.dashed })
        continue
      }
      if (sp.curves >= 4 && sp.curves <= 8) {
        const all = [...sp.pts, ...sp.ctrl]
        const xs = all.map((q) => q[0])
        const ys = all.map((q) => q[1])
        const w = Math.max(...xs) - Math.min(...xs)
        const h = Math.max(...ys) - Math.min(...ys)
        if (w > 1 && h > 1 && w / h > 0.85 && w / h < 1 / 0.85 && (sp.closed || near(sp.pts[0][0], sp.pts[sp.pts.length - 1][0], 0.5))) {
          this.circles.push({
            cx: (Math.max(...xs) + Math.min(...xs)) / 2,
            cy: (Math.max(...ys) + Math.min(...ys)) / 2,
            r: (w + h) / 4,
            stroke,
            fill,
            fillLuma: g.fillLuma,
            strokeLuma: g.strokeLuma
          })
        }
        continue
      }
      if (sp.curves === 0 && stroke) {
        const pts = sp.closed ? [...sp.pts, sp.pts[0]] : sp.pts
        for (let i = 0; i + 1 < pts.length; i++) {
          const [a, b] = [pts[i], pts[i + 1]]
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) continue
          this.lines.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], width, dashed: g.dashed })
        }
      }
    }
  }

  walk(ops: Op[], resources: PDFDict | undefined, start: GState, depth: number, stack: string[]): void {
    let g = start
    const gstack: GState[] = []
    let path: SubPath[] = []
    let cur: SubPath | null = null
    let curPt: Pt = [0, 0]

    const toUser = (x: number, y: number): Pt => apply(g.ctm, x, y)
    const begin = (x: number, y: number): void => {
      const p = toUser(x, y)
      cur = { pts: [p], ctrl: [], curves: 0, closed: false, fromRe: false }
      path.push(cur)
      curPt = p
    }
    const ensure = (): SubPath => {
      if (!cur) begin(curPt[0], curPt[1])
      return cur!
    }

    for (const op of ops) {
      if (++this.ops > MAX_OPS) {
        this.warnings.push('This page is too complex to analyse completely')
        return
      }
      const a = op.args
      switch (op.op) {
        case 'q':
          if (gstack.length < 256) gstack.push(g)
          break
        case 'Q': {
          const p = gstack.pop()
          if (p) g = p
          break
        }
        case 'cm':
          if (a.length >= 6 && a.slice(0, 6).every((x) => x.t === 'num')) g = { ...g, ctm: mul(a.slice(0, 6).map(num), g.ctm) }
          break
        case 'w':
          g = { ...g, lw: Number.isFinite(num(a[0])) ? num(a[0]) : g.lw }
          break
        case 'd': {
          const arr = a[0]
          const dashed = arr?.t === 'arr' && arr.v.some((x) => x.t === 'num' && x.v > 0)
          g = { ...g, dashed }
          break
        }
        case 'g':
          g = { ...g, fillLuma: luma([num(a[0])]) }
          break
        case 'rg':
          g = { ...g, fillLuma: luma([num(a[0]), num(a[1]), num(a[2])]) }
          break
        case 'k':
          g = { ...g, fillLuma: luma([num(a[0]), num(a[1]), num(a[2]), num(a[3])]) }
          break
        case 'G':
          g = { ...g, strokeLuma: luma([num(a[0])]) }
          break
        case 'RG':
          g = { ...g, strokeLuma: luma([num(a[0]), num(a[1]), num(a[2])]) }
          break
        case 'K':
          g = { ...g, strokeLuma: luma([num(a[0]), num(a[1]), num(a[2]), num(a[3])]) }
          break
        case 'sc':
        case 'scn': {
          const n = a.filter((x) => x.t === 'num').map(num)
          g = { ...g, fillLuma: n.length ? luma(n) : 0.5 }
          break
        }
        case 'SC':
        case 'SCN': {
          const n = a.filter((x) => x.t === 'num').map(num)
          g = { ...g, strokeLuma: n.length ? luma(n) : 0.5 }
          break
        }
        case 'm':
          begin(num(a[0]), num(a[1]))
          break
        case 'l': {
          const sp = ensure()
          const p = toUser(num(a[0]), num(a[1]))
          sp.pts.push(p)
          curPt = p
          break
        }
        case 'c':
        case 'v':
        case 'y': {
          const sp = ensure()
          const nums = a.map(num)
          const ptsIn: Pt[] = []
          for (let i = 0; i + 1 < nums.length; i += 2) ptsIn.push(toUser(nums[i], nums[i + 1]))
          if (ptsIn.length >= 2) {
            for (let i = 0; i < ptsIn.length - 1; i++) sp.ctrl.push(ptsIn[i])
            const end = ptsIn[ptsIn.length - 1]
            sp.pts.push(end)
            sp.curves++
            curPt = end
          }
          break
        }
        case 'h':
          if (cur) {
            ;(cur as SubPath).closed = true
            curPt = (cur as SubPath).pts[0]
            cur = null
          }
          break
        case 're': {
          const [x, y, w, h] = [num(a[0]), num(a[1]), num(a[2]), num(a[3])]
          if ([x, y, w, h].every(Number.isFinite)) {
            const pts: Pt[] = [toUser(x, y), toUser(x + w, y), toUser(x + w, y + h), toUser(x, y + h)]
            path.push({ pts, ctrl: [], curves: 0, closed: true, fromRe: true })
            curPt = pts[0]
            cur = null
          }
          break
        }
        case 'S':
          this.paint(path, g, true, false)
          path = []
          cur = null
          break
        case 's':
          path.forEach((p) => (p.closed = true))
          this.paint(path, g, true, false)
          path = []
          cur = null
          break
        case 'f':
        case 'F':
        case 'f*':
          this.paint(path, g, false, true)
          path = []
          cur = null
          break
        case 'B':
        case 'B*':
          this.paint(path, g, true, true)
          path = []
          cur = null
          break
        case 'b':
        case 'b*':
          path.forEach((p) => (p.closed = true))
          this.paint(path, g, true, true)
          path = []
          cur = null
          break
        case 'n':
          path = []
          cur = null
          break
        case 'BI': {
          const bb = transformRect(g.ctm, 0, 0, 1, 1)
          this.images.push({ x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 })
          break
        }
        case 'Do':
          if (a[0]?.t === 'name') this.doXObject(resources, a[0].v, g, depth, stack)
          break
      }
    }
  }

  private doXObject(resources: PDFDict | undefined, name: string, g: GState, depth: number, stack: string[]): void {
    const xobjs = ddict(resources, 'XObject')
    const raw = xobjs?.get(N(name))
    const ref = raw instanceof PDFRef ? raw : undefined
    const obj = ref ? this.pdf.context.lookup(ref) : raw
    if (!(obj instanceof PDFStream)) return
    const subtype = dname(obj.dict, 'Subtype')
    if (subtype === 'Image') {
      const bb = transformRect(g.ctm, 0, 0, 1, 1)
      this.images.push({ x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 })
      return
    }
    if (subtype !== 'Form') return
    const tag = ref ? refTag(ref) : `direct:${name}`
    if (depth >= MAX_FORM_DEPTH || stack.includes(tag)) return
    let ops: Op[]
    try {
      ops = parseContent(streamBytes(obj)).ops
    } catch {
      this.warnings.push('A form XObject on this page could not be read')
      return
    }
    const fm = numbers(darr(obj.dict, 'Matrix'))
    const matrix: Matrix = fm.length === 6 && fm.every(Number.isFinite) ? (fm as Matrix) : IDENTITY
    this.walk(ops, ddict(obj.dict, 'Resources') ?? resources, { ...g, ctm: mul(matrix, g.ctm) }, depth + 1, [...stack, tag])
  }
}

/** Reads the lines, rectangles, circles and images a page draws (user space). Never throws. */
export function extractVectors(pdf: PDFDocument, pageIndex: number): VectorContent {
  const c = new Collector(pdf)
  try {
    const src = loadPageSource(pdf, pageIndex)
    const start: GState = { ctm: IDENTITY, lw: 1, dashed: false, fillLuma: 0, strokeLuma: 0 }
    // A page's content streams form one continuous stream (graphics state carries across them).
    c.walk(src.slots.flatMap((s) => s.ops), src.resources, start, 0, [])
  } catch (err) {
    c.warnings.push(`The page content could not be read completely (${err instanceof Error ? err.message : String(err)})`)
  }
  return { lines: c.lines, rects: c.rects, circles: c.circles, images: c.images, warnings: c.warnings }
}
