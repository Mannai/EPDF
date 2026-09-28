import { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream, type PDFContext, type PDFDocument, type PDFObject } from 'pdf-lib'
import { ContentParseError, parseContent, type Op, type PdfObj } from './content'
import { loadFont, unreadableFont, type PdfFont } from './fonts'
import { IDENTITY, mul, transformRect, type Matrix, type Rect } from './matrix'
import { N, darr, ddict, dget, dname, dnum, numbers, refTag, streamBytes } from './pdfutil'

/**
 * Walks a page's content streams (including Form XObjects reached through `Do`) with a graphics/text state
 * tracker and reports every text-showing operation and every image, with geometry in PDF user space.
 * Pure `pdf-lib` + TypeScript: no PDF.js, so it runs in Node for unit tests.
 */

export interface StreamSlot {
  ref?: PDFRef
  stream?: PDFStream
  ops: Op[]
  tail: Uint8Array
  dirty: boolean
}

export interface ContentSource {
  id: string
  kind: 'page' | 'form'
  slots: StreamSlot[]
  /** Effective resources (own or inherited). */
  resources: PDFDict | undefined
  /** The XObject entry this form was reached through (for forms). */
  formRef?: PDFRef
  /** Resource dictionary that holds the entry and the name used (for forms). */
  viaName?: string
  /** How many times this source was executed while walking the page (a form drawn twice counts 2). */
  visits: number
  /** A private copy of the resources with additions (fonts, images), written back on commit. */
  resourcesOverride?: PDFDict
}

export interface OpAddr {
  source: string
  slot: number
  index: number
}

export const addrKey = (a: OpAddr): string => `${a.source}:${a.slot}:${a.index}`

export interface Color {
  /** Operations that recreate this color (empty = the initial black). */
  ops: Op[]
  css: string
}

export interface RunGlyph {
  code: number
  n: number
  text: string
  known: boolean
  /** Extent along the baseline in text-space units from the start of the run. */
  x0: number
  x1: number
  /** How far the glyph moves the text position (width + Tc, + Tw for a single-byte space), in the same units. */
  adv: number
  /** Which operand element holds the code: -1 = the string operand itself, otherwise the index inside the TJ array. */
  el: number
  /** Byte offset of the code inside that string. */
  off: number
}

export interface MarkedContent {
  addr: OpAddr
  hasActualText: boolean
  /** ActualText/Alt lives in a Properties resource we cannot rewrite. */
  external: boolean
}

export interface TextRun {
  id: string
  addr: OpAddr
  op: string
  /** Operand index of the string (Tj/TJ/'), or 2 for the `"` operator. */
  strArg: number
  fontName: string
  font: PdfFont
  size: number
  hScale: number
  rise: number
  charSpace: number
  wordSpace: number
  renderMode: number
  /** Text space → user space (Tm × CTM) at the start of the run. */
  matrix: Matrix
  ctm: Matrix
  glyphs: RunGlyph[]
  text: string
  /** Total advance in text-space units (including character/word spacing and TJ adjustments). */
  advance: number
  bbox: Rect
  color: Color
  marked: MarkedContent[]
  /** Address of the ET that closes the text object this run is in (and the CTM there); absent if the stream ends first. */
  et?: { addr: OpAddr; ctm: Matrix }
  bt?: OpAddr
  /** The text object's stream has a text-position dependency on this run (next op is another show without repositioning). */
  visible: boolean
  /** In a Form XObject that is used more than once (this page or elsewhere): editing would change every use. */
  shared: boolean
  /** Axis-aligned, unmirrored horizontal text. */
  upright: boolean
}

export interface ImageItem {
  id: string
  addr: OpAddr
  kind: 'xobject' | 'inline'
  /** XObject name in the resources (xobject only). */
  name?: string
  /** Reference of the image object (xobject only). */
  ref?: PDFRef
  ctm: Matrix
  bbox: Rect
  width: number
  height: number
  shared: boolean
  /** Number of q operators still open here (used to know how far the CTM may deviate). */
  depth: number
}

export interface PageAnalysis {
  pageIndex: number
  rotation: number
  sources: Map<string, ContentSource>
  runs: TextRun[]
  images: ImageItem[]
  /** Codes of each font seen on this page (glyphs known to exist in a subset font). */
  fontUsage: Map<PdfFont, Set<number>>
  hiddenRuns: number
  /** Unmatched `q` operators at the end of the page content (needed to append content safely). */
  endDepth: number
  endCtm: Matrix
  warnings: string[]
}

export class UnsupportedContentError extends Error {}

const MAX_FORM_DEPTH = 12
const MAX_OPS = 3_000_000

// ---------------------------------------------------------------------------------------------------------

const fontCache = new WeakMap<PDFDict, PdfFont>()

export function fontFromDict(d: PDFDict): PdfFont {
  let f = fontCache.get(d)
  if (!f) fontCache.set(d, (f = loadFont(d)))
  return f
}

/** Counts how often each indirect object is referenced (for detecting shared streams and images). */
export function buildRefCounts(context: PDFContext): Map<string, number> {
  const counts = new Map<string, number>()
  const seen = new Set<object>()
  const visit = (o: PDFObject | undefined, depth: number): void => {
    if (!o || depth > 40) return
    if (o instanceof PDFRef) {
      const t = refTag(o)
      counts.set(t, (counts.get(t) ?? 0) + 1)
    } else if (o instanceof PDFDict) {
      if (seen.has(o)) return
      seen.add(o)
      for (const [, v] of o.entries()) visit(v, depth + 1)
    } else if (o instanceof PDFArray) {
      if (seen.has(o)) return
      seen.add(o)
      for (let i = 0; i < o.size(); i++) visit(o.get(i), depth + 1)
    } else if (o instanceof PDFStream) {
      visit(o.dict, depth + 1)
    }
  }
  for (const [, obj] of context.enumerateIndirectObjects()) visit(obj, 0)
  visit(context.trailerInfo.Root, 0)
  return counts
}

const refCountCache = new WeakMap<PDFContext, { objects: number; counts: Map<string, number> }>()
export function refCountsFor(context: PDFContext): Map<string, number> {
  const n = context.largestObjectNumber
  const c = refCountCache.get(context)
  if (c && c.objects === n) return c.counts
  const counts = buildRefCounts(context)
  refCountCache.set(context, { objects: n, counts })
  return counts
}

// ---------------------------------------------------------------------------------------------------------
// Sources

function loadSlot(context: PDFContext, ref: PDFRef | undefined, obj: PDFObject | undefined): StreamSlot | undefined {
  const s = obj instanceof PDFStream ? obj : undefined
  if (!s) return undefined
  const bytes = streamBytes(s)
  const parsed = parseContent(bytes)
  void context
  return { ref, stream: s, ops: parsed.ops, tail: parsed.tail, dirty: false }
}

export function pageResources(page: { node: { Resources(): PDFDict | undefined } }): PDFDict | undefined {
  try {
    return page.node.Resources()
  } catch {
    return undefined
  }
}

export function loadPageSource(pdf: PDFDocument, pageIndex: number): ContentSource {
  const page = pdf.getPage(pageIndex)
  const context = pdf.context
  const slots: StreamSlot[] = []
  const contentsRaw = page.node.get(N('Contents'))
  const contents = contentsRaw instanceof PDFRef ? context.lookup(contentsRaw) : contentsRaw
  if (contents instanceof PDFStream) {
    const slot = loadSlot(context, contentsRaw instanceof PDFRef ? contentsRaw : undefined, contents)
    if (slot) slots.push(slot)
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const raw = contents.get(i)
      const ref = raw instanceof PDFRef ? raw : undefined
      const slot = loadSlot(context, ref, raw instanceof PDFRef ? context.lookup(raw) : raw)
      if (slot) slots.push(slot)
    }
  }
  return { id: 'page', kind: 'page', slots, resources: pageResources(page), visits: 1 }
}

// ---------------------------------------------------------------------------------------------------------
// Interpreter

interface TextState {
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

interface GState {
  ctm: Matrix
  fill: Color
  text: TextState
}

const BLACK: Color = { ops: [], css: '#000000' }

const hex2 = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
const rgbCss = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`
const cmykCss = (c: number, m: number, y: number, k: number): string => rgbCss((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))

function cloneG(g: GState): GState {
  return { ctm: g.ctm, fill: g.fill, text: { ...g.text } }
}

const num = (a: PdfObj | undefined): number => (a?.t === 'num' ? a.v : NaN)

class Walker {
  runs: TextRun[] = []
  images: ImageItem[] = []
  sources = new Map<string, ContentSource>()
  fontUsage = new Map<PdfFont, Set<number>>()
  warnings: string[] = []
  opCount = 0
  endDepth = 0
  endCtm: Matrix = IDENTITY
  private formStack: string[] = []
  private formCounter = 0

  constructor(readonly pdf: PDFDocument, readonly pageIndex: number) {}

  walkSource(src: ContentSource, gs0: GState, depth: number): GState {
    this.sources.set(src.id, src)
    let g = gs0
    const stack: GState[] = []
    let tm: Matrix = IDENTITY
    let tlm: Matrix = IDENTITY
    let pendingObject: TextRun[] = []
    let bt: OpAddr | undefined
    const marked: MarkedContent[] = []
    const res = src.resources

    const setFont = (fontName: string, size: number): void => {
      const fonts = ddict(res, 'Font')
      const fd = fonts ? dget(fonts, fontName) : undefined
      const font = fd instanceof PDFDict ? fontFromDict(fd) : unreadableFont('Unknown', fontName, 'the font is missing from the page resources')
      g = { ...g, text: { ...g.text, font, fontName, size } }
    }

    const show = (op: Op, addr: OpAddr, strArg: number, spacing?: { tw: number; tc: number }): void => {
      const ts = g.text
      const font = ts.font
      if (!font) throw new UnsupportedContentError('Text is shown before a font is selected')
      const th = ts.th
      const glyphs: RunGlyph[] = []
      let u = 0
      const tc = spacing?.tc ?? ts.tc
      const tw = spacing?.tw ?? ts.tw
      const used = this.fontUsage.get(font) ?? new Set<number>()
      this.fontUsage.set(font, used)
      const feed = (bytes: Uint8Array, el: number): void => {
        let off = 0
        for (const gl of font.glyphs(bytes)) {
          const w = (gl.width / 1000) * ts.size * th
          const adv = w + tc * th + (gl.space ? tw * th : 0)
          glyphs.push({ code: gl.code, n: gl.n, text: gl.text, known: gl.known, x0: u, x1: u + w, adv, el, off })
          used.add(gl.code)
          u += adv
          off += gl.n
        }
      }
      const a = op.args[strArg]
      if (op.op === 'TJ') {
        if (a?.t !== 'arr') throw new UnsupportedContentError('TJ without an array operand')
        a.v.forEach((el, i) => {
          if (el.t === 'str') feed(el.b, i)
          else if (el.t === 'num') u -= (el.v / 1000) * ts.size * th
        })
      } else {
        if (a?.t !== 'str') throw new UnsupportedContentError(`${op.op} without a string operand`)
        feed(a.b, -1)
      }
      const m = mul(tm, g.ctm)
      const xs = glyphs.length ? [Math.min(...glyphs.map((x) => x.x0)), Math.max(...glyphs.map((x) => x.x1))] : [0, u]
      const bbox = transformRect(m, xs[0], ts.rise + font.descent * ts.size, xs[1], ts.rise + font.ascent * ts.size)
      const upright = Math.abs(m[1]) < 1e-3 * Math.abs(m[0]) + 1e-9 && Math.abs(m[2]) < 1e-3 * Math.abs(m[3]) + 1e-9 && m[0] > 0 && m[3] > 0
      const run: TextRun = {
        id: addrKey(addr),
        addr,
        op: op.op,
        strArg,
        fontName: ts.fontName,
        font,
        size: ts.size,
        hScale: th,
        rise: ts.rise,
        charSpace: tc,
        wordSpace: tw,
        renderMode: ts.mode,
        matrix: m,
        ctm: g.ctm,
        glyphs,
        text: glyphs.map((x) => x.text).join(''),
        advance: u,
        bbox,
        color: g.fill,
        marked: marked.filter((x) => x.hasActualText || x.external),
        bt,
        visible: ts.mode !== 3 && ts.mode !== 7 && ts.size !== 0,
        shared: false,
        upright
      }
      this.runs.push(run)
      pendingObject.push(run)
      tm = mul([1, 0, 0, 1, u, 0], tm)
    }

    const nextLine = (): void => {
      tlm = mul([1, 0, 0, 1, 0, -g.text.tl], tlm)
      tm = tlm
    }

    for (let s = 0; s < src.slots.length; s++) {
      const slot = src.slots[s]
      for (let i = 0; i < slot.ops.length; i++) {
        if (++this.opCount > MAX_OPS) throw new UnsupportedContentError('This page is too complex to edit')
        const op = slot.ops[i]
        const a = op.args
        const addr: OpAddr = { source: src.id, slot: s, index: i }
        switch (op.op) {
          case 'q':
            if (stack.length < 256) stack.push(cloneG(g))
            break
          case 'Q': {
            const p = stack.pop()
            if (p) g = p
            break
          }
          case 'cm':
            if (a.length >= 6 && a.slice(0, 6).every((x) => x.t === 'num')) {
              g = { ...g, ctm: mul(a.slice(0, 6).map(num), g.ctm) }
            }
            break
          case 'BT':
            tm = tlm = IDENTITY
            bt = addr
            pendingObject = []
            break
          case 'ET':
            for (const r of pendingObject) r.et = { addr, ctm: g.ctm }
            pendingObject = []
            bt = undefined
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
            if (a.length >= 6 && a.slice(0, 6).every((x) => x.t === 'num')) {
              tlm = tm = a.slice(0, 6).map(num) as Matrix
            }
            break
          case 'T*':
            nextLine()
            break
          case 'Tj':
          case 'TJ':
            show(op, addr, 0)
            break
          case "'":
            nextLine()
            show(op, addr, 0)
            break
          case '"': {
            const aw = num(a[0]) || 0
            const ac = num(a[1]) || 0
            g = { ...g, text: { ...g.text, tw: aw, tc: ac } }
            nextLine()
            show(op, addr, 2)
            break
          }
          case 'BMC':
            marked.push({ addr, hasActualText: false, external: false })
            break
          case 'BDC': {
            const props = a[1]
            let hasActual = false
            let external = false
            if (props?.t === 'dict') hasActual = props.v.has('ActualText') || props.v.has('Alt') || props.v.has('E')
            else if (props?.t === 'name') {
              const pr = ddict(ddict(res, 'Properties'), props.v)
              if (pr && (dget(pr, 'ActualText') || dget(pr, 'Alt') || dget(pr, 'E'))) external = true
            }
            marked.push({ addr, hasActualText: hasActual, external })
            break
          }
          case 'EMC':
            marked.pop()
            break
          case 'g':
            g = { ...g, fill: { ops: [op], css: rgbCss(num(a[0]), num(a[0]), num(a[0])) } }
            break
          case 'rg':
            g = { ...g, fill: { ops: [op], css: rgbCss(num(a[0]), num(a[1]), num(a[2])) } }
            break
          case 'k':
            g = { ...g, fill: { ops: [op], css: cmykCss(num(a[0]), num(a[1]), num(a[2]), num(a[3])) } }
            break
          case 'cs':
            // A newly selected color space starts out black (or the closest we can show).
            g = { ...g, fill: { ops: [op], css: '#000000' } }
            break
          case 'sc':
          case 'scn': {
            const nums = a.filter((x) => x.t === 'num').map(num)
            let css = g.fill.css
            if (nums.length === 1) css = rgbCss(nums[0], nums[0], nums[0])
            else if (nums.length === 3) css = rgbCss(nums[0], nums[1], nums[2])
            else if (nums.length === 4) css = cmykCss(nums[0], nums[1], nums[2], nums[3])
            const csOp = g.fill.ops.find((o) => o.op === 'cs')
            g = { ...g, fill: { ops: csOp ? [csOp, op] : [op], css } }
            break
          }
          case 'gs': {
            const gsd = a[0]?.t === 'name' ? ddict(ddict(res, 'ExtGState'), a[0].v) : undefined
            const fontEntry = darr(gsd, 'Font')
            if (fontEntry && fontEntry.size() === 2) {
              const fd = fontEntry.lookup(0)
              const sz = fontEntry.lookup(1)
              if (fd instanceof PDFDict && sz instanceof PDFNumber) {
                g = { ...g, text: { ...g.text, font: fontFromDict(fd), fontName: '(ExtGState font)', size: sz.asNumber() } }
              }
            }
            break
          }
          case 'Do':
            if (a[0]?.t === 'name') this.doXObject(src, a[0].v, addr, g, tm, depth, stack.length)
            break
          case 'BI': {
            const inl = op.inline
            if (!inl) break
            const dw = inl.dict.get('W') ?? inl.dict.get('Width')
            const dh = inl.dict.get('H') ?? inl.dict.get('Height')
            this.images.push({
              id: addrKey(addr),
              addr,
              kind: 'inline',
              ctm: g.ctm,
              bbox: transformRect(g.ctm, 0, 0, 1, 1),
              width: dw?.t === 'num' ? dw.v : 0,
              height: dh?.t === 'num' ? dh.v : 0,
              shared: false,
              depth: stack.length
            })
            break
          }
        }
      }
    }
    if (depth === 0) {
      this.endDepth = stack.length
      this.endCtm = g.ctm
    }
    return g
  }

  private doXObject(src: ContentSource, name: string, addr: OpAddr, g: GState, _tm: Matrix, depth: number, qDepth: number): void {
    const xobjs = ddict(src.resources, 'XObject')
    if (!xobjs) return
    const raw = xobjs.get(N(name))
    const ref = raw instanceof PDFRef ? raw : undefined
    const obj = ref ? this.pdf.context.lookup(ref) : raw
    if (!(obj instanceof PDFStream)) return
    const subtype = dname(obj.dict, 'Subtype')
    if (subtype === 'Image') {
      this.images.push({
        id: addrKey(addr),
        addr,
        kind: 'xobject',
        name,
        ref,
        ctm: g.ctm,
        bbox: transformRect(g.ctm, 0, 0, 1, 1),
        width: dnum(obj.dict, 'Width') ?? 0,
        height: dnum(obj.dict, 'Height') ?? 0,
        shared: false,
        depth: qDepth
      })
      return
    }
    if (subtype !== 'Form') return
    if (depth >= MAX_FORM_DEPTH) {
      this.warnings.push('Forms are nested too deeply; some content was not analysed')
      return
    }
    const tag = ref ? refTag(ref) : `direct${this.formCounter++}`
    if (this.formStack.includes(tag)) {
      this.warnings.push('A form draws itself; the recursion was skipped')
      return
    }
    const id = `form:${tag.replace(' ', '_')}`
    const known = this.sources.get(id)
    if (known) {
      // Drawn again: its content is already listed (at the first position); it is now known to be shared.
      known.visits++
      return
    }
    let slot: StreamSlot
    try {
      const parsed = parseContent(streamBytes(obj))
      slot = { ref, stream: obj, ops: parsed.ops, tail: parsed.tail, dirty: false }
    } catch (e) {
      if (e instanceof ContentParseError) throw new UnsupportedContentError(`A form on this page has unreadable content (${e.message})`)
      throw e
    }
    const fsrc: ContentSource = {
      id,
      kind: 'form',
      slots: [slot],
      resources: ddict(obj.dict, 'Resources') ?? src.resources,
      formRef: ref,
      viaName: name,
      visits: 1
    }
    const fm = numbers(darr(obj.dict, 'Matrix'))
    const matrix: Matrix = fm.length === 6 && fm.every(Number.isFinite) ? (fm as Matrix) : IDENTITY
    const inner: GState = { ...cloneG(g), ctm: mul(matrix, g.ctm) }
    this.formStack.push(tag)
    try {
      this.walkSource(fsrc, inner, depth + 1)
    } finally {
      this.formStack.pop()
    }
  }
}

// ---------------------------------------------------------------------------------------------------------

export function analyzePage(pdf: PDFDocument, pageIndex: number): PageAnalysis {
  if (pageIndex < 0 || pageIndex >= pdf.getPageCount()) throw new UnsupportedContentError('Page not found')
  const page = pdf.getPage(pageIndex)
  const w = new Walker(pdf, pageIndex)
  const src = loadPageSource(pdf, pageIndex)
  const gs: GState = {
    ctm: IDENTITY,
    fill: BLACK,
    text: { font: undefined, fontName: '', size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0 }
  }
  w.walkSource(src, gs, 0)

  // Forms drawn more than once, or referenced from elsewhere, are shared: editing them changes every use.
  let counts: Map<string, number> | undefined
  const formShared = new Map<string, boolean>()
  for (const s of w.sources.values()) {
    if (s.kind !== 'form') continue
    let shared = s.visits > 1
    if (!shared && s.formRef) {
      counts ??= refCountsFor(pdf.context)
      shared = (counts.get(refTag(s.formRef)) ?? 0) > 1
    }
    formShared.set(s.id, shared)
  }
  for (const r of w.runs) r.shared = formShared.get(r.addr.source) ?? false
  for (const im of w.images) im.shared = formShared.get(im.addr.source) ?? false

  const hiddenRuns = w.runs.filter((r) => !r.visible && r.text.trim() !== '').length
  return {
    pageIndex,
    rotation: page.getRotation().angle,
    sources: w.sources,
    runs: w.runs,
    images: w.images,
    fontUsage: w.fontUsage,
    hiddenRuns,
    endDepth: w.endDepth,
    endCtm: w.endCtm,
    warnings: w.warnings
  }
}
