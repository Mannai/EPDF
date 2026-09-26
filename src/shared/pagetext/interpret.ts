import { PDFArray, PDFDict, PDFHexString, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocument, type PDFObject } from 'pdf-lib'
import { ContentParseError, parseContent, type Op, type PdfObj } from '../../renderer/src/features/textedit/pdfcontent/content'
import { IDENTITY, apply, mul, type Matrix } from '../../renderer/src/features/textedit/pdfcontent/matrix'
import { N, darr, ddict, dget, dname, numbers, refTag, streamBytes } from '../../renderer/src/features/textedit/pdfcontent/pdfutil'
import { brokenFont, textFontFor, type DecodedGlyph, type TextFont } from './fonts'
import { decodePdfString, isOnlyMarks, normalizeGlyphText } from './unicode'

/**
 * Walks a page's content (and the Form XObjects it draws) with a graphics/text state and reports every glyph with its
 * Unicode text and exact geometry, in DISPLAY space: PDF points with the origin at the top-left of the page as shown
 * (CropBox, /Rotate applied, y down), the same space as a PDF.js viewport at scale 1.
 *
 * It records marked content with /ActualText (BDC ... EMC, nested; the outermost span wins, as the standard says) and
 * /ReversedChars. Tolerant by design: unreadable operators or streams are skipped (and reported), never fatal.
 */

/**
 * A glyph's box is described in its line frame: `e` is the unit vector along the baseline (the direction glyphs advance
 * in), `n = (-ey, ex)` is perpendicular to it pointing "down" (towards the next line). The box spans [0, len] along `e`
 * from the origin and [-top, bottom] along `n`. For vertical writing the origin is the pen position (top centre).
 */
export interface Glyph {
  /** Unicode text of the glyph ('' = none known). */
  text: string
  known: boolean
  /** The text consists of combining marks only. */
  mark: boolean
  /** Origin on the baseline. */
  ox: number
  oy: number
  /** Unit vector along the baseline. */
  ex: number
  ey: number
  /** Advance length along `e` (0 for marks). */
  len: number
  /** Extent above (towards -n) and below (towards +n) the baseline. */
  top: number
  bottom: number
  /** Em size in display units. */
  size: number
  /** Ink extent along `e` relative to the origin (display units), when the font program gives it (zero-width glyphs). */
  ink?: [number, number]
  /** Outermost ActualText span containing the glyph, or -1. */
  span: number
  /** Stream order. */
  seq: number
  font: number
  vertical: boolean
  /** Invisible text (render mode 3 or 7, e.g. an OCR layer). Still selectable text. */
  hidden: boolean
  /** Inside /ReversedChars marked content. */
  reversed: boolean
  /** The font could not be decoded reliably. */
  unreliable: boolean
}

export interface Span {
  text: string
  glyphs: number[]
}

export interface PageGeometry {
  /** Visible area in user space [x0, y0, x1, y1] (CropBox ∩ MediaBox). */
  view: [number, number, number, number]
  rotation: number
  width: number
  height: number
  /** User space -> display space. */
  transform: Matrix
}

export interface Interpretation extends PageGeometry {
  glyphs: Glyph[]
  spans: Span[]
  warnings: string[]
}

const MAX_OPS = 4_000_000
const MAX_DEPTH = 12
const MAX_GLYPHS = 400_000

/** User space -> display space, exactly as PDF.js' PageViewport at scale 1. */
export function pageGeometry(pdf: PDFDocument, pageIndex: number): PageGeometry {
  const page = pdf.getPage(pageIndex)
  const mb = page.getMediaBox()
  const cb = page.getCropBox()
  const m = [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height]
  const c = [cb.x, cb.y, cb.x + cb.width, cb.y + cb.height]
  const norm = (r: number[]): number[] => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
  const mm = norm(m)
  const cc = norm(c)
  let view = [Math.max(mm[0], cc[0]), Math.max(mm[1], cc[1]), Math.min(mm[2], cc[2]), Math.min(mm[3], cc[3])]
  if (!(view[2] > view[0] && view[3] > view[1])) view = mm
  let rotation = page.getRotation().angle % 360
  if (rotation < 0) rotation += 360
  rotation = Math.round(rotation / 90) * 90 % 360
  const cx = (view[0] + view[2]) / 2
  const cy = (view[1] + view[3]) / 2
  let a: number, b: number, c2: number, d: number
  switch (rotation) {
    case 90:
      ;[a, b, c2, d] = [0, 1, 1, 0]
      break
    case 180:
      ;[a, b, c2, d] = [-1, 0, 0, 1]
      break
    case 270:
      ;[a, b, c2, d] = [0, -1, -1, 0]
      break
    default:
      ;[a, b, c2, d] = [1, 0, 0, -1]
  }
  let offX: number, offY: number, width: number, height: number
  if (a === 0) {
    offX = Math.abs(cy - view[1])
    offY = Math.abs(cx - view[0])
    width = view[3] - view[1]
    height = view[2] - view[0]
  } else {
    offX = Math.abs(cx - view[0])
    offY = Math.abs(cy - view[1])
    width = view[2] - view[0]
    height = view[3] - view[1]
  }
  const transform: Matrix = [a, b, c2, d, offX - a * cx - c2 * cy, offY - b * cx - d * cy]
  return { view: view as [number, number, number, number], rotation, width, height, transform }
}

interface TState {
  font: TextFont | undefined
  size: number
  tc: number
  tw: number
  th: number
  tl: number
  rise: number
  mode: number
}

interface GState {
  ctm: Matrix
  text: TState
}

const num = (a: PdfObj | undefined): number => (a?.t === 'num' ? a.v : NaN)

/** Parses content leniently: on a syntax error, keeps every operation before it. */
function parseLenient(bytes: Uint8Array, warnings: string[]): Op[] {
  try {
    return parseContent(bytes).ops
  } catch (e) {
    let end = e instanceof ContentParseError && e.offset !== undefined ? e.offset : bytes.length
    for (let tries = 0; tries < 4 && end > 0; tries++) {
      try {
        const ops = parseContent(bytes.subarray(0, end)).ops
        warnings.push(`Part of a content stream could not be read (${e instanceof Error ? e.message : String(e)}).`)
        return ops
      } catch (e2) {
        end = e2 instanceof ContentParseError && e2.offset !== undefined && e2.offset < end ? e2.offset : Math.floor(end * 0.9)
      }
    }
    warnings.push('A content stream could not be read.')
    return []
  }
}

function pdfObjText(o: PDFObject | undefined): string | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) {
    try {
      return o.decodeText()
    } catch {
      return undefined
    }
  }
  return undefined
}

class Walker {
  glyphs: Glyph[] = []
  spans: Span[] = []
  warnings: string[] = []
  private ops = 0
  private seq = 0
  private formStack: string[] = []
  private formId = 0
  /** Open marked-content entries (shared across forms, as marked content may enclose a Do). */
  private mc: { span: number; reversed: boolean }[] = []

  constructor(
    readonly pdf: PDFDocument,
    readonly display: Matrix
  ) {}

  private currentSpan(): number {
    for (const e of this.mc) if (e.span >= 0) return e.span // outermost wins
    return -1
  }
  private reversed(): boolean {
    return this.mc.some((e) => e.reversed)
  }

  walk(ops: Op[], res: PDFDict | undefined, g0: GState, depth: number): void {
    let g = g0
    const stack: GState[] = []
    let tm: Matrix = IDENTITY
    let tlm: Matrix = IDENTITY
    const mcBase = this.mc.length

    const setFont = (name: string, size: number): void => {
      const fd = dget(ddict(res, 'Font'), name)
      const font = fd instanceof PDFDict ? textFontFor(fd) : brokenFont(name, 'the font is missing from the page resources')
      g = { ...g, text: { ...g.text, font, size } }
    }

    const show = (arg: PdfObj | undefined, spacing?: { tw: number; tc: number }): void => {
      const ts = g.text
      const font = ts.font ?? brokenFont('(none)', 'text is shown before a font is selected')
      const th = ts.th
      const tc = spacing?.tc ?? ts.tc
      const tw = spacing?.tw ?? ts.tw
      const size = ts.size
      // Text rendering matrix without the per-glyph translation: text space -> display space.
      const trm = mul(mul(tm, g.ctm), this.display)
      const span = this.currentSpan()
      const reversed = this.reversed()
      const hidden = ts.mode === 3 || ts.mode === 7
      let u = 0 // advance along the baseline (text space, horizontal writing)
      let v = 0 // advance for vertical writing
      // scale of text-space x and y in display space
      const sx = Math.hypot(trm[0], trm[1])
      const sy = Math.hypot(trm[2], trm[3])
      const em = sy * size
      const feed = (bytes: Uint8Array): void => {
        for (const gl of font.decode(bytes)) {
          if (this.glyphs.length >= MAX_GLYPHS) return
          if (font.vertical) {
            // pen position (top centre of the glyph); glyphs advance downwards (PDF 32000 §9.7.4.3)
            const [ox, oy] = apply(trm, u, v)
            const ex = -trm[2] / (sy || 1)
            const ey = -trm[3] / (sy || 1)
            const half = (gl.w * size * sx) / 2
            this.push(gl, font, ox, oy, ex, ey, Math.abs(gl.w1) * em, half, half, em, span, hidden, reversed)
            v += gl.w1 * size + tc + (gl.space ? tw : 0)
          } else {
            const w = gl.w * size * th
            const [ox, oy] = apply(trm, u, ts.rise)
            const ex = trm[0] / (sx || 1)
            const ey = trm[1] / (sx || 1)
            // the up vector (text +y) projected on the frame normal n = (-ey, ex); negative for normal text
            const k = -((trm[2] * -ey + trm[3] * ex) * size)
            const kk = Math.abs(k)
            this.push(gl, font, ox, oy, ex, ey, Math.abs(w) * sx, font.ascent * kk, -font.descent * kk, em, span, hidden, reversed)
            u += w + (tc + (gl.space ? tw : 0)) * th
          }
        }
      }
      if (arg?.t === 'arr') {
        for (const el of arg.v) {
          if (el.t === 'str') feed(el.b)
          else if (el.t === 'num') {
            if (font.vertical) v -= (el.v / 1000) * size
            else u -= (el.v / 1000) * size * th
          }
        }
      } else if (arg?.t === 'str') feed(arg.b)
      tm = font.vertical ? mul([1, 0, 0, 1, 0, v], tm) : mul([1, 0, 0, 1, u, 0], tm)
    }

    const nextLine = (): void => {
      tlm = mul([1, 0, 0, 1, 0, -g.text.tl], tlm)
      tm = tlm
    }

    for (const op of ops) {
      if (++this.ops > MAX_OPS) {
        this.warnings.push('The page is too complex; only part of its text was read.')
        break
      }
      const a = op.args
      switch (op.op) {
        case 'q':
          if (stack.length < 512) stack.push({ ctm: g.ctm, text: { ...g.text } })
          break
        case 'Q': {
          const p = stack.pop()
          if (p) g = p
          break
        }
        case 'cm':
          if (a.length >= 6 && a.slice(0, 6).every((x) => x.t === 'num')) g = { ...g, ctm: mul(a.slice(0, 6).map(num) as Matrix, g.ctm) }
          break
        case 'BT':
          tm = tlm = IDENTITY
          break
        case 'Tf':
          if (a[0]?.t === 'name' && a[1]?.t === 'num') setFont(a[0].v, a[1].v)
          break
        case 'Tc':
          g = { ...g, text: { ...g.text, tc: num(a[0]) || 0 } }
          break
        case 'Tw':
          g = { ...g, text: { ...g.text, tw: num(a[0]) || 0 } }
          break
        case 'Tz':
          g = { ...g, text: { ...g.text, th: (Number.isFinite(num(a[0])) ? num(a[0]) : 100) / 100 } }
          break
        case 'TL':
          g = { ...g, text: { ...g.text, tl: num(a[0]) || 0 } }
          break
        case 'Ts':
          g = { ...g, text: { ...g.text, rise: num(a[0]) || 0 } }
          break
        case 'Tr':
          g = { ...g, text: { ...g.text, mode: num(a[0]) || 0 } }
          break
        case 'Td':
          tlm = mul([1, 0, 0, 1, num(a[0]) || 0, num(a[1]) || 0], tlm)
          tm = tlm
          break
        case 'TD':
          g = { ...g, text: { ...g.text, tl: -(num(a[1]) || 0) } }
          tlm = mul([1, 0, 0, 1, num(a[0]) || 0, num(a[1]) || 0], tlm)
          tm = tlm
          break
        case 'Tm':
          if (a.length >= 6 && a.slice(0, 6).every((x) => x.t === 'num')) tlm = tm = a.slice(0, 6).map(num) as Matrix
          break
        case 'T*':
          nextLine()
          break
        case 'Tj':
        case 'TJ':
          show(a[0])
          break
        case "'":
          nextLine()
          show(a[0])
          break
        case '"': {
          const aw = num(a[0]) || 0
          const ac = num(a[1]) || 0
          g = { ...g, text: { ...g.text, tw: aw, tc: ac } }
          nextLine()
          show(a[2])
          break
        }
        case 'BMC':
          this.mc.push({ span: -1, reversed: a[0]?.t === 'name' && a[0].v === 'ReversedChars' })
          break
        case 'BDC': {
          let actual: string | undefined
          const props = a[1]
          if (props?.t === 'dict') {
            const at = props.v.get('ActualText')
            if (at?.t === 'str') actual = decodePdfString(at.b)
          } else if (props?.t === 'name') {
            const pr = ddict(ddict(res, 'Properties'), props.v)
            actual = pdfObjText(dget(pr, 'ActualText'))
          }
          let span = -1
          // an ActualText inside another one is replaced by the outer text
          if (actual !== undefined && this.currentSpan() < 0) {
            span = this.spans.length
            this.spans.push({ text: normalizeGlyphText(actual), glyphs: [] })
          }
          this.mc.push({ span, reversed: a[0]?.t === 'name' && a[0].v === 'ReversedChars' })
          break
        }
        case 'EMC':
          if (this.mc.length > mcBase) this.mc.pop()
          break
        case 'gs': {
          const gsd = a[0]?.t === 'name' ? ddict(ddict(res, 'ExtGState'), a[0].v) : undefined
          const fe = darr(gsd, 'Font')
          if (fe && fe.size() === 2) {
            const fd = fe.lookup(0)
            const sz = fe.lookup(1)
            if (fd instanceof PDFDict && sz instanceof PDFNumber) g = { ...g, text: { ...g.text, font: textFontFor(fd), size: sz.asNumber() } }
          }
          break
        }
        case 'Do':
          if (a[0]?.t === 'name') this.doXObject(a[0].v, res, g, depth)
          break
      }
    }
    // marked content left open inside a form does not leak out of it
    if (depth > 0) this.mc.length = mcBase
  }

  private push(
    gl: DecodedGlyph,
    font: TextFont,
    ox: number,
    oy: number,
    ex: number,
    ey: number,
    len: number,
    top: number,
    bottom: number,
    em: number,
    span: number,
    hidden: boolean,
    reversed: boolean
  ): void {
    if (!(em > 0) || !Number.isFinite(ox + oy + ex + ey + len + top + bottom)) return
    const g: Glyph = {
      text: gl.text,
      known: gl.known,
      mark: isOnlyMarks(gl.text),
      ox,
      oy,
      ex,
      ey,
      len,
      top,
      bottom,
      size: em,
      span,
      seq: this.seq++,
      font: font.key,
      vertical: font.vertical,
      hidden,
      reversed,
      unreliable: !!font.problem
    }
    if (len < 1e-3 * em || g.mark) {
      const ink = font.ink(gl.gid)
      if (ink) g.ink = [ink[0] * em, ink[1] * em]
    }
    if (span >= 0) this.spans[span].glyphs.push(this.glyphs.length)
    this.glyphs.push(g)
  }

  private doXObject(name: string, res: PDFDict | undefined, g: GState, depth: number): void {
    const xobjs = ddict(res, 'XObject')
    const raw = xobjs?.get(N(name))
    const ref = raw instanceof PDFRef ? raw : undefined
    const obj = ref ? this.pdf.context.lookup(ref) : raw
    if (!(obj instanceof PDFStream) || dname(obj.dict, 'Subtype') !== 'Form') return
    if (depth >= MAX_DEPTH) {
      this.warnings.push('Forms are nested too deeply; some text was not read.')
      return
    }
    const tag = ref ? refTag(ref) : `direct${this.formId++}`
    if (this.formStack.includes(tag)) return
    let bytes: Uint8Array
    try {
      bytes = streamBytes(obj)
    } catch {
      this.warnings.push('A form on the page could not be decoded.')
      return
    }
    const fm = numbers(darr(obj.dict, 'Matrix'))
    const matrix: Matrix = fm.length === 6 && fm.every(Number.isFinite) ? (fm as Matrix) : IDENTITY
    this.formStack.push(tag)
    try {
      this.walk(parseLenient(bytes, this.warnings), ddict(obj.dict, 'Resources') ?? res, { ctm: mul(matrix, g.ctm), text: { ...g.text } }, depth + 1)
    } finally {
      this.formStack.pop()
    }
  }
}

function contentStreams(pdf: PDFDocument, pageIndex: number): PDFStream[] {
  const page = pdf.getPage(pageIndex)
  const raw = page.node.get(N('Contents'))
  const contents = raw instanceof PDFRef ? pdf.context.lookup(raw) : raw
  if (contents instanceof PDFStream) return [contents]
  const out: PDFStream[] = []
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i)
      if (s instanceof PDFStream) out.push(s)
    }
  }
  return out
}

export function interpretPage(pdf: PDFDocument, pageIndex: number): Interpretation {
  const geom = pageGeometry(pdf, pageIndex)
  const w = new Walker(pdf, geom.transform)
  const page = pdf.getPage(pageIndex)
  let res: PDFDict | undefined
  try {
    res = page.node.Resources()
  } catch {
    res = undefined
  }
  // Streams of an array are one content stream split in pieces: concatenate (an operator may straddle two pieces).
  const parts: Uint8Array[] = []
  for (const s of contentStreams(pdf, pageIndex)) {
    try {
      parts.push(streamBytes(s))
    } catch {
      w.warnings.push('A content stream could not be decoded.')
    }
  }
  const total = parts.reduce((n, p) => n + p.length + 1, 0)
  const all = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    all.set(p, o)
    o += p.length
    all[o++] = 10
  }
  const g0: GState = { ctm: IDENTITY, text: { font: undefined, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0 } }
  w.walk(parseLenient(all, w.warnings), res, g0, 0)
  return { ...geom, glyphs: w.glyphs, spans: w.spans, warnings: w.warnings }
}
