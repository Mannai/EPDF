import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFDocument, type PDFObject } from 'pdf-lib'
import { bytesToLatin1, parseContent, type Op } from '../../textedit/pdfcontent/content'
import { N, darr, ddict, dname, dnum, numbers, streamBytes } from '../../textedit/pdfcontent/pdfutil'
import type { Rect } from './geom'

/**
 * The self-check's geometry test for drawn shapes. It re-reads a page's content from the finished file (its own
 * walk, its own transformation and line-width bookkeeping; forms and soft-mask groups followed) and reports every
 * subpath with geometry under a mark: a point inside a mark, an outline piece (a line, or the control polygon of a
 * curve) crossing a mark, or a stroke whose band (half the line width, stretched by the transformation as much as
 * it can be) reaches a mark. Unpainted paths and clipping paths are checked like painted ones.
 *
 * Only the redaction's own overlay (the last content stream, starting with `q /EpdfRdGS… gs`) is skipped. The
 * marks are shrunk by a hundredth of a point so that shapes the redaction cut exactly along a mark's edge pass.
 */

type P = [number, number]
type M6 = [number, number, number, number, number, number]

const EDGE = 0.01
const MAX_FORM_DEPTH = 12
const OVERLAY = /^\s*q\s+\/EpdfRdGS\d*\s+gs\b/

export interface VectorCheck {
  /** Subpaths with geometry under a mark. */
  leaks: number
  /** Set when the page could not be read (the check then cannot confirm anything). */
  error?: string
}

const times = (m: M6, n: M6): M6 => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5]
]
const map = (m: M6, x: number, y: number): P => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** Largest factor by which the matrix lengthens a vector (spectral norm of its linear part). */
function norm2(m: M6): number {
  const [a, b, c, d] = m
  const h = (a * a + b * b - c * c - d * d) / 2
  const k = a * c + b * d
  return Math.sqrt((a * a + b * b + c * c + d * d) / 2 + Math.sqrt(h * h + k * k))
}

function pointToRect(p: P, r: Rect): number {
  const dx = Math.max(r.x0 - p[0], 0, p[0] - r.x1)
  const dy = Math.max(r.y0 - p[1], 0, p[1] - r.y1)
  return Math.hypot(dx, dy)
}

function pointToSegment(p: P, a: P, b: P): number {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const len = vx * vx + vy * vy
  const t = len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len)) : 0
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy))
}

/** The segment meets the closed rectangle (Liang-Barsky). */
function segmentMeetsRect(a: P, b: P, r: Rect): boolean {
  let t0 = 0
  let t1 = 1
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const tests: [number, number][] = [
    [-dx, a[0] - r.x0],
    [dx, r.x1 - a[0]],
    [-dy, a[1] - r.y0],
    [dy, r.y1 - a[1]]
  ]
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const t = q / p
      if (p < 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
      if (t0 > t1) return false
    }
  }
  return true
}

function segmentToRect(a: P, b: P, r: Rect): number {
  if (segmentMeetsRect(a, b, r)) return 0
  const corners: P[] = [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x1, r.y1],
    [r.x0, r.y1]
  ]
  return Math.min(pointToRect(a, r), pointToRect(b, r), ...corners.map((c) => pointToSegment(c, a, b)))
}

function inTriangle(p: P, a: P, b: P, c: P): boolean {
  const s = (u: P, v: P): number => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0])
  const d1 = s(a, b)
  const d2 = s(b, c)
  const d3 = s(c, a)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

/** The convex hull of the points (a line, or a curve's control points) comes within `r` of the rectangle. */
function piecenear(pts: readonly P[], r: Rect, reach: number): boolean {
  for (const p of pts) if (pointToRect(p, r) <= reach) return true
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (segmentToRect(pts[i], pts[j], r) <= reach) return true
  if (pts.length >= 3) {
    const corners: P[] = [
      [r.x0, r.y0],
      [r.x1, r.y0],
      [r.x1, r.y1],
      [r.x0, r.y1]
    ]
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) if (corners.some((c) => inTriangle(c, pts[i], pts[j], pts[k]))) return true
  }
  return false
}

interface Sub {
  pieces: P[][]
  first: P
  last: P
  closed: boolean
}

interface State {
  ctm: M6
  lw: number
}

const FILLING = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'])
const STROKING = new Set(['S', 's', 'B', 'B*', 'b', 'b*'])
const CLOSING = new Set(['s', 'b', 'b*'])
const PAINTING = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])

const num = (op: Op, i: number): number => {
  const a = op.args[i]
  return a?.t === 'num' ? a.v : NaN
}

function lookupDict(o: PDFObject | undefined, doc: PDFDocument): PDFDict | undefined {
  const v = o instanceof PDFRef ? doc.context.lookup(o) : o
  return v instanceof PDFDict ? v : undefined
}

/** Checks one page of the finished file against its marks (bounding boxes in user space). */
export function checkPageVectors(pdf: PDFDocument, pageIndex: number, marks: readonly Rect[]): VectorCheck {
  const shrunk = marks.map((m) => ({ x0: m.x0 + EDGE, y0: m.y0 + EDGE, x1: m.x1 - EDGE, y1: m.y1 - EDGE })).filter((m) => m.x1 >= m.x0 && m.y1 >= m.y0)
  if (!shrunk.length) return { leaks: 0 }
  const page = pdf.getPage(pageIndex)
  const raw = page.node.get(N('Contents'))
  const contents = raw instanceof PDFRef ? pdf.context.lookup(raw) : raw
  const list: PDFStream[] = []
  if (contents instanceof PDFStream) list.push(contents)
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i)
      if (s instanceof PDFStream) list.push(s)
    }
  }
  let leaks = 0
  try {
    const parts = list.map((s) => streamBytes(s))
    if (parts.length && OVERLAY.test(bytesToLatin1(parts[parts.length - 1].subarray(0, 64)))) parts.pop()
    const total = parts.reduce((n, b) => n + b.length + 1, 0)
    const joined = new Uint8Array(total)
    let at = 0
    for (const b of parts) {
      joined.set(b, at)
      at += b.length
      joined[at++] = 10
    }
    let resources: PDFDict | undefined
    try {
      resources = page.node.Resources()
    } catch {
      resources = undefined
    }
    const onStack = new Set<PDFStream>()
    const walk = (ops: readonly Op[], res: PDFDict | undefined, start: State, depth: number): void => {
      if (depth > MAX_FORM_DEPTH) throw new Error('forms are nested too deeply')
      let st: State = { ...start }
      const saved: State[] = []
      let subs: Sub[] = []
      let clip = false
      const current = (): Sub | undefined => subs[subs.length - 1]
      const begin = (p: P): Sub => {
        const s: Sub = { pieces: [], first: p, last: p, closed: false }
        subs.push(s)
        return s
      }
      const extend = (local: P[]): void => {
        const pts = local.map((q) => map(st.ctm, q[0], q[1]))
        let s = current()
        if (!s) s = begin(pts[pts.length - 1])
        else {
          s.pieces.push([s.last, ...pts])
          s.closed = false
        }
        s.last = pts[pts.length - 1]
      }
      const paint = (op: string): void => {
        const area = FILLING.has(op) || clip
        const reach = STROKING.has(op) ? (Math.max(0, st.lw) / 2) * norm2(st.ctm) : 0
        for (const s of subs) {
          const pieces = s.pieces.length ? [...s.pieces] : [[s.first, s.first]]
          if ((area || CLOSING.has(op)) && !s.closed) pieces.push([s.last, s.first])
          if (pieces.some((pc) => shrunk.some((m) => piecenear(pc, m, reach)))) leaks++
        }
        subs = []
        clip = false
      }
      const subForm = (form: PDFStream, ctm: M6, fallback: PDFDict | undefined): void => {
        if (onStack.has(form)) throw new Error('a form draws itself')
        const m = numbers(darr(form.dict, 'Matrix'))
        const matrix: M6 = m.length === 6 && m.every(Number.isFinite) ? (m as M6) : [1, 0, 0, 1, 0, 0]
        onStack.add(form)
        try {
          walk(parseContent(streamBytes(form)).ops, ddict(form.dict, 'Resources') ?? fallback, { ...st, ctm: times(matrix, ctm) }, depth + 1)
        } finally {
          onStack.delete(form)
        }
      }
      for (const op of ops) {
        switch (op.op) {
          case 'q':
            saved.push({ ...st })
            break
          case 'Q':
            st = saved.pop() ?? st
            break
          case 'cm':
            if (op.args.length >= 6) st = { ...st, ctm: times([0, 1, 2, 3, 4, 5].map((i) => num(op, i)) as M6, st.ctm) }
            break
          case 'w':
            st = { ...st, lw: num(op, 0) }
            break
          case 'gs': {
            const nm = op.args[0]?.t === 'name' ? op.args[0].v : ''
            const gs = ddict(ddict(res, 'ExtGState'), nm)
            const lw = dnum(gs, 'LW')
            if (lw !== undefined) st = { ...st, lw }
            const g = lookupDict(gs?.get(N('SMask')), pdf)?.get(N('G'))
            const group = g instanceof PDFRef ? pdf.context.lookup(g) : g
            if (group instanceof PDFStream) subForm(group, st.ctm, res)
            break
          }
          case 'Do': {
            const nm = op.args[0]?.t === 'name' ? op.args[0].v : ''
            const xo = ddict(res, 'XObject')?.get(N(nm))
            const obj = xo instanceof PDFRef ? pdf.context.lookup(xo) : xo
            if (obj instanceof PDFStream && dname(obj.dict, 'Subtype') === 'Form') subForm(obj, st.ctm, res)
            break
          }
          case 'm':
            begin(map(st.ctm, num(op, 0), num(op, 1)))
            break
          case 'l':
            extend([[num(op, 0), num(op, 1)]])
            break
          case 'c':
            extend([
              [num(op, 0), num(op, 1)],
              [num(op, 2), num(op, 3)],
              [num(op, 4), num(op, 5)]
            ])
            break
          case 'v': {
            const s = current()
            const pts = [map(st.ctm, num(op, 0), num(op, 1)), map(st.ctm, num(op, 2), num(op, 3))]
            if (!s) begin(pts[1])
            else {
              s.pieces.push([s.last, s.last, ...pts])
              s.last = pts[1]
              s.closed = false
            }
            break
          }
          case 'y':
            extend([
              [num(op, 0), num(op, 1)],
              [num(op, 2), num(op, 3)],
              [num(op, 2), num(op, 3)]
            ])
            break
          case 're': {
            const [x, y, w, h] = [num(op, 0), num(op, 1), num(op, 2), num(op, 3)]
            const c = [map(st.ctm, x, y), map(st.ctm, x + w, y), map(st.ctm, x + w, y + h), map(st.ctm, x, y + h)]
            const s = begin(c[0])
            s.pieces.push([c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], c[0]])
            s.closed = true
            break
          }
          case 'h': {
            const s = current()
            if (s && !s.closed) {
              s.pieces.push([s.last, s.first])
              s.last = s.first
              s.closed = true
            }
            break
          }
          case 'W':
          case 'W*':
            clip = true
            break
          default:
            if (PAINTING.has(op.op)) paint(op.op)
        }
      }
    }
    walk(parseContent(joined).ops, resources, { ctm: [1, 0, 0, 1, 0, 0], lw: 1 }, 0)
  } catch (e) {
    return { leaks, error: e instanceof Error ? e.message : String(e) }
  }
  return { leaks }
}
