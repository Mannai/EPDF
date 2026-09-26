import { PDFDict, PDFName, PDFOperator, PDFRef, type PDFDocument, type PDFPage } from 'pdf-lib'
import { layoutParagraph } from '../layout'
import type { MissingChar, ParagraphLayout, ParagraphOptions, Span } from '../types'
import { embeddedFontsFor } from './embed'
import { emitLayout, type Extraction, type RenderMode, type EmitResult } from './emit'
import type { TextColor } from '../types'

/**
 * The drawing API: correct Arabic (and every other script) in PDFs.
 *
 *   await drawText(page, 'مرحبا بالعالم', { x: 72, y: 700, size: 18 })          // instead of page.drawText(...)
 *   await drawParagraph(page, longText, { x: 72, y: 720, width: 300, size: 11, align: 'justify' })
 *   const xo = await makeTextXObject(pdf, 'الاسم', { size: 12, width: 120, height: 20 })  // for /AP streams
 */

export interface DrawOptions extends ParagraphOptions {
  x: number
  y: number
  /** Alias of `width` (pdf-lib's name). */
  maxWidth?: number
  /** `drawText` without a width: which point of the text `x` names. Default 'left'. Use 'right' to draw Arabic ending at `x`. */
  anchor?: 'left' | 'center' | 'right'
  /** Rotation in degrees counter-clockwise about (x, y) (also accepts pdf-lib's `degrees(n)`). */
  rotate?: number | { type: 'degrees'; angle: number } | { type: 'radians'; angle: number }
  xSkew?: number | { type: 'degrees'; angle: number }
  ySkew?: number | { type: 'degrees'; angle: number }
  renderMode?: RenderMode
  strokeColor?: TextColor
  strokeWidth?: number
  /** Clip drawing to this rectangle (page coordinates, before rotation). */
  clip?: { x: number; y: number; width: number; height: number }
  /** Text extraction strategy, see `Extraction`. Default 'auto'. */
  extraction?: Extraction
}

export interface DrawResult {
  layout: ParagraphLayout
  width: number
  height: number
  lineCount: number
  /** Characters no font covers (drawn as .notdef). */
  missing: MissingChar[]
  /** Bounding box of the box that was drawn (page coordinates, unrotated). */
  bbox: { x: number; y: number; width: number; height: number }
}

const deg = (v: DrawOptions['rotate']): number => (v === undefined ? 0 : typeof v === 'number' ? v : v.type === 'radians' ? (v.angle * 180) / Math.PI : v.angle)

type M = [number, number, number, number, number, number]
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[1] * q[2],
  p[0] * q[1] + p[1] * q[3],
  p[2] * q[0] + p[3] * q[2],
  p[2] * q[1] + p[3] * q[3],
  p[4] * q[0] + p[5] * q[2] + q[4],
  p[4] * q[1] + p[5] * q[3] + q[5]
]
const f = (v: number): string => String(Math.round(v * 100000) / 100000)

function transformOf(o: DrawOptions): M {
  const r = (deg(o.rotate) * Math.PI) / 180
  const xs = Math.tan((deg(o.xSkew) * Math.PI) / 180)
  const ys = Math.tan((deg(o.ySkew) * Math.PI) / 180)
  const K: M = [1, ys, xs, 1, 0, 0]
  const R: M = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]
  const T: M = [1, 0, 0, 1, o.x, o.y]
  return mul(mul(K, R), T)
}

const DRAW_ONLY = new Set(['x', 'y', 'maxWidth', 'anchor', 'rotate', 'xSkew', 'ySkew', 'renderMode', 'strokeColor', 'strokeWidth', 'clip', 'extraction'])

/** The layout options inside draw options (everything that is not about placing the result on the page). */
function layoutOptions(o: DrawOptions): ParagraphOptions {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (!DRAW_ONLY.has(k) && v !== undefined) out[k] = v
  return { ...(out as ParagraphOptions), width: o.width ?? o.maxWidth }
}

/**
 * A resource name in `dict` for `ref`: `wanted` when it is free or already names `ref`, otherwise `wanted_2`, `_3` ...
 * (Each `editPdf` step works on a new PDFDocument whose engine fonts are again called EpdfF1, EpdfF2 ...: text drawn on
 * the same page in an earlier step must keep its own font, so an existing name is never overwritten.)
 */
function freeName(dict: PDFDict | undefined, wanted: string, ref: PDFRef): string {
  if (!dict) return wanted
  let name = wanted
  for (let i = 2; ; i++) {
    const cur = dict.get(PDFName.of(name))
    if (cur === undefined || (cur instanceof PDFRef && cur === ref)) return name
    name = `${wanted}_${i}`
  }
}

/** Rewrites the engine's font / graphics-state resource names in emitted content (`/EpdfF1 12 Tf`, `/EpdfGS500 gs`). */
export function renameContentResources(content: string, names: Map<string, string>): string {
  if (![...names].some(([a, b]) => a !== b)) return content
  return content.replace(/\/(EpdfF\d+|EpdfGS\d+)(?= )/g, (_m, n: string) => `/${names.get(n) ?? n}`)
}

function registerResources(page: PDFPage, res: EmitResult): Map<string, string> {
  const names = new Map<string, string>()
  const resources = page.node.Resources()
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)
  const states = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict)
  for (const ef of res.fonts) {
    const n = freeName(fonts, ef.resourceName, ef.ref)
    names.set(ef.resourceName, n)
    page.node.setFontDictionary(PDFName.of(n), ef.ref)
  }
  for (const st of res.states.values()) {
    const n = freeName(states, st.name, st.ref)
    names.set(st.name, n)
    page.node.setExtGState(PDFName.of(n), st.ref)
  }
  return names
}

/**
 * Draw text at (x, y) = the baseline start of the first line (pdf-lib's convention). Newlines start new lines;
 * with `width` the text wraps and aligns inside [x, x + width]. Fully shaped, bidirectional, with font fallback.
 */
export async function drawText(page: PDFPage, text: string | Span[], options: DrawOptions): Promise<DrawResult> {
  const layout = await layoutParagraph(text, layoutOptions(options))
  const doc = page.doc
  const dt = embeddedFontsFor(doc)
  const emitted = emitLayout({ docText: dt, layout, originBaseline: true, renderMode: options.renderMode, strokeColor: options.strokeColor, strokeWidth: options.strokeWidth, extraction: options.extraction })
  const boxW = layout.boxWidth ?? layout.width
  const ax = layout.boxWidth === undefined ? (options.anchor === 'right' ? -boxW : options.anchor === 'center' ? -boxW / 2 : 0) : 0
  const names = registerResources(page, emitted)
  pushDrawing(page, { ...emitted, content: renameContentResources(emitted.content, names) }, options, ax)
  const first = layout.lines[0]
  const top = first ? first.baseline : 0
  return {
    layout,
    width: boxW,
    height: layout.height,
    lineCount: layout.lines.length,
    missing: layout.missing,
    bbox: { x: options.x + ax, y: options.y + top - layout.height, width: boxW, height: layout.height }
  }
}

/** Draw a paragraph inside a box whose TOP-left corner is (x, y). `width` is required for wrapping. */
export async function drawParagraph(page: PDFPage, text: string | Span[], options: DrawOptions): Promise<DrawResult> {
  const layout = await layoutParagraph(text, layoutOptions(options))
  const dt = embeddedFontsFor(page.doc)
  const emitted = emitLayout({ docText: dt, layout, originBaseline: false, renderMode: options.renderMode, strokeColor: options.strokeColor, strokeWidth: options.strokeWidth, extraction: options.extraction })
  const names = registerResources(page, emitted)
  pushDrawing(page, { ...emitted, content: renameContentResources(emitted.content, names) }, options, 0)
  const boxW = layout.boxWidth ?? layout.width
  return {
    layout,
    width: boxW,
    height: layout.height,
    lineCount: layout.lines.length,
    missing: layout.missing,
    bbox: { x: options.x, y: options.y - layout.height, width: boxW, height: layout.height }
  }
}

function pushDrawing(page: PDFPage, emitted: EmitResult, o: DrawOptions, ax: number): void {
  const m = transformOf(o)
  const lines: string[] = ['q']
  if (o.clip) lines.push(`${f(o.clip.x)} ${f(o.clip.y)} ${f(o.clip.width)} ${f(o.clip.height)} re W n`)
  const withAnchor: M = ax === 0 ? m : mul([1, 0, 0, 1, ax, 0], m)
  lines.push(`${withAnchor.map(f).join(' ')} cm`)
  lines.push(emitted.content)
  lines.push('Q')
  // pdf-lib writes an operator as `<args> <name>`; a name-only operator is a verbatim (ASCII) content chunk.
  page.pushOperators(PDFOperator.of(lines.join('\n') as never))
}

export interface TextXObject {
  ref: PDFRef
  /** Form BBox and content size in points. */
  width: number
  height: number
  bbox: [number, number, number, number]
  layout: ParagraphLayout
  missing: MissingChar[]
}

export interface XObjectOptions extends ParagraphOptions {
  /** Height of the form. Default: the height of the laid-out text. */
  height?: number
  /** Inner padding (points) on the left/right and top/bottom. Default 0. */
  padding?: number | { x: number; y: number }
  /** Vertical position of the text block inside `height`: 'top' (default), 'middle' or 'bottom'. */
  valign?: 'top' | 'middle' | 'bottom'
  renderMode?: RenderMode
  strokeColor?: TextColor
  strokeWidth?: number
  extraction?: Extraction
  /** Add extra resource entries or matrix (advanced). */
  matrix?: [number, number, number, number, number, number]
}

/**
 * Build a Form XObject with the text, sized `width` x `height` with its origin at the bottom-left, for annotation
 * appearance streams (`/AP << /N ref >>`) and form-field appearances. Text is aligned inside the box per `align`.
 * The content is self-contained: fonts and opacity states are in the form's own /Resources.
 */
export async function makeTextXObject(pdf: PDFDocument, text: string | Span[], options: XObjectOptions = {}): Promise<TextXObject> {
  const pad = typeof options.padding === 'number' ? { x: options.padding, y: options.padding } : (options.padding ?? { x: 0, y: 0 })
  const innerW = options.width !== undefined ? Math.max(0, options.width - 2 * pad.x) : undefined
  const layout = await layoutParagraph(text, { ...options, width: innerW })
  const dt = embeddedFontsFor(pdf)
  const emitted = emitLayout({ docText: dt, layout, originBaseline: false, renderMode: options.renderMode, strokeColor: options.strokeColor, strokeWidth: options.strokeWidth, extraction: options.extraction })
  const contentW = layout.boxWidth ?? layout.width
  const width = options.width ?? contentW + 2 * pad.x
  const height = options.height ?? layout.height + 2 * pad.y
  const free = height - 2 * pad.y - layout.height
  const top = options.valign === 'bottom' ? height - pad.y - free : options.valign === 'middle' ? height - pad.y - free / 2 : height - pad.y
  const fonts: Record<string, PDFRef> = {}
  for (const ef of emitted.fonts) fonts[ef.resourceName] = ef.ref
  const states: Record<string, PDFRef> = {}
  for (const st of emitted.states.values()) states[st.name] = st.ref
  const bbox: [number, number, number, number] = [0, 0, width, height]
  const content = `q\n1 0 0 1 ${f(pad.x)} ${f(top)} cm\n${emitted.content}\nQ`
  const ref = pdf.context.register(
    pdf.context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: bbox,
      Resources: { Font: fonts, ...(emitted.states.size ? { ExtGState: states } : {}) },
      ...(options.matrix ? { Matrix: options.matrix } : {})
    })
  )
  return { ref, width, height, bbox, layout, missing: layout.missing }
}

export interface TextContent {
  layout: ParagraphLayout
  /**
   * Content-stream operators (ASCII) drawing the text. Local coordinates: x right, y up; the origin is the start of the
   * first baseline (`origin: 'baseline'`) or the top-left of the layout box (`origin: 'top'`).
   */
  content: string
  /** Resources the content uses, by the names it uses them under (rename with `renameContentResources`). */
  fonts: { name: string; ref: PDFRef }[]
  states: { name: string; ref: PDFRef }[]
  /** Width of the box the text is laid out in (`width` option, else the widest line) and total height. */
  width: number
  height: number
  missing: MissingChar[]
}

/**
 * The drawing operators for text without putting them anywhere: for callers that insert text into a content stream
 * or form they build themselves (a redaction overlay, a text edit inside an existing stream). The fonts are embedded
 * in `pdf` as with every other drawing call; the caller must add `fonts`/`states` to the resources of the stream the
 * content ends up in.
 */
export async function textContent(pdf: PDFDocument, text: string | Span[], options: XObjectOptions & { origin?: 'baseline' | 'top' } = {}): Promise<TextContent> {
  const layout = await layoutParagraph(text, options)
  const emitted = emitLayout({ docText: embeddedFontsFor(pdf), layout, originBaseline: options.origin !== 'top', renderMode: options.renderMode, strokeColor: options.strokeColor, strokeWidth: options.strokeWidth, extraction: options.extraction })
  return {
    layout,
    content: emitted.content,
    fonts: [...emitted.fonts].map((ef) => ({ name: ef.resourceName, ref: ef.ref })),
    states: [...emitted.states.values()].map((s) => ({ name: s.name, ref: s.ref })),
    width: layout.boxWidth ?? layout.width,
    height: layout.height,
    missing: layout.missing
  }
}

/** Measure text without drawing (needs the same fonts as drawing). */
export async function measureParagraph(text: string | Span[], options: ParagraphOptions = {}): Promise<{ width: number; height: number; lineCount: number; layout: ParagraphLayout; missing: MissingChar[] }> {
  const layout = await layoutParagraph(text, options)
  return { width: layout.width, height: layout.height, lineCount: layout.lines.length, layout, missing: layout.missing }
}

/** Width and height of `text` in one style, wrapped only at newlines (or at `width`). */
export function measureText(text: string | Span[], options: ParagraphOptions = {}): ReturnType<typeof measureParagraph> {
  return measureParagraph(text, options)
}
