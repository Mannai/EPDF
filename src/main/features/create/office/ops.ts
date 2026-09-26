import {
  PDFDocument,
  PDFImage,
  PDFName,
  PDFPage,
  PDFString,
  appendBezierCurve,
  clip,
  closePath,
  concatTransformationMatrix,
  endPath,
  fill,
  fillAndStroke,
  PDFOperator,
  PDFOperatorNames,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setDashPattern,
  setFillingRgbColor,
  setGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  stroke as strokeOp,
  drawObject
} from 'pdf-lib'
import { embeddedFontsFor } from '../../../../shared/text/pdf/embed'
import { emitLayout } from '../../../../shared/text/pdf/emit'
import type { ParagraphLayout } from '../../../../shared/text/types'
import type { Face, FontCatalog } from './fonts'
import { hasRtlText, shapeLine, type GlyphOp } from './textline'

/**
 * The display list every converter produces and the single PDF writer consumes. Coordinates are in points
 * with the origin at the TOP-LEFT of the page and y growing downwards; the writer flips them.
 *
 * Text is written by the text engine (src/shared/text): `glyphs` ops are lines already shaped and ordered by
 * textline.ts; a `text` op is a single string in one face whose left edge is `x` (shaped and bidi-ordered here).
 * Both carry a BASELINE y.
 */

export type Hex = string // '#rrggbb'

export interface Stroke {
  color: Hex
  width: number
  dash?: number[]
}

export interface ImageData {
  bytes: Uint8Array
  format: 'png' | 'jpeg'
}

export type PathSeg = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z']

export type Op =
  | { t: 'text'; x: number; y: number; text: string; face: Face; size: number; color: Hex }
  | GlyphOp
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: Hex; stroke?: Stroke; opacity?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: Stroke }
  | { t: 'image'; x: number; y: number; w: number; h: number; image: ImageData; crop?: { l: number; t: number; r: number; b: number }; opacity?: number }
  | { t: 'path'; d: PathSeg[]; fill?: Hex; stroke?: Stroke; opacity?: number; evenOdd?: boolean }
  | { t: 'link'; x: number; y: number; w: number; h: number; url: string }
  | { t: 'push'; rotate?: { deg: number; cx: number; cy: number }; clip?: { x: number; y: number; w: number; h: number } }
  | { t: 'pop' }

export interface Page {
  width: number
  height: number
  ops: Op[]
  background?: Hex
}

/** Collects user-facing notes about content that could not be reproduced exactly. Identical notes are merged. */
export class Warnings {
  private counts = new Map<string, number>()
  add(message: string): void {
    this.counts.set(message, (this.counts.get(message) ?? 0) + 1)
  }
  list(): string[] {
    return [...this.counts.entries()].map(([m, n]) => (n > 1 ? `${m} (×${n})` : m))
  }
  get size(): number {
    return this.counts.size
  }
}

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0')
  return [parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255]
}
const fillColor = (hex: string): ReturnType<typeof setFillingRgbColor> => setFillingRgbColor(...hexToRgb(hex))
const strokeColor = (hex: string): ReturnType<typeof setStrokingRgbColor> => setStrokingRgbColor(...hexToRgb(hex))

const SAFE_URL = /^(https?:\/\/|mailto:)/i
const num = (v: number): string => String(Math.round(v * 1000) / 1000)

export interface RenderOptions {
  title?: string
  author?: string
  onPage?: (done: number, total: number) => void
  signal?: AbortSignal
  warnings?: Warnings
}

/** Writes display-list pages to a PDF with embedded, subset fonts. */
export async function renderPagesToPdf(pages: Page[], catalog: FontCatalog, opts: RenderOptions = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const docText = embeddedFontsFor(pdf)
  // Font names: PDF.js keeps a line together (and reorders it logically) only while the font name stays the same, so
  // documents with right-to-left text get the engine's uniform BaseFont; others keep descriptive names
  // (`ABCDEF+LiberationSans-Bold`), which readers show in their font lists.
  let rtlDoc = false
  for (const p of pages) for (const op of p.ops) if ((op.t === 'glyphs' || op.t === 'text') && hasRtlText(op.text)) rtlDoc = true
  docText.uniformNames = rtlDoc
  const images = new WeakMap<Uint8Array, PDFImage | null>()
  for (const p of pages) {
    for (const op of p.ops) {
      if (op.t !== 'image' || images.has(op.image.bytes)) continue
      try {
        images.set(op.image.bytes, op.image.format === 'png' ? await pdf.embedPng(op.image.bytes) : await pdf.embedJpg(op.image.bytes))
      } catch {
        images.set(op.image.bytes, null)
        opts.warnings?.add('An image in the document is damaged or uses an unsupported encoding and was left out.')
      }
    }
  }

  const gsCache = new Map<string, PDFName>()
  for (let pi = 0; pi < pages.length; pi++) {
    if (opts.signal?.aborted) throw new Error('Cancelled')
    const src = pages[pi]
    const page = pdf.addPage([src.width, src.height])
    const H = src.height
    const drawGlyphs = (g: GlyphOp): void => {
      if (!g.runs.length) return
      const layout: ParagraphLayout = {
        text: g.text,
        lines: [{ runs: g.runs, y: 0, x: 0, width: g.w, height: 0, baseline: 0, ascent: 0, descent: 0, textStart: 0, textEnd: g.text.length, rtl: g.rtl, last: true, paragraph: 0 }],
        width: g.w,
        height: 0,
        missing: [],
        directions: [g.rtl ? 'rtl' : 'ltr'],
        truncated: false
      }
      const em = emitLayout({ docText, layout, originBaseline: true })
      if (!em.content) return
      for (const ef of em.fonts) page.node.setFontDictionary(PDFName.of(ef.resourceName), ef.ref)
      for (const st of em.states.values()) page.node.setExtGState(PDFName.of(st.name), st.ref)
      // y-down display space here: flip back to y-up with the origin on the baseline
      page.pushOperators(PDFOperator.of(`q\n1 0 0 -1 ${num(g.x)} ${num(g.y)} cm\n${em.content}\nQ` as never))
    }
    const alpha = (a: number): PDFName => {
      const key = a.toFixed(3)
      let n = gsCache.get(key)
      if (!n) {
        n = PDFName.of(`GS${gsCache.size + 1}`)
        gsCache.set(key, n)
      }
      // the resource must exist on every page that uses it
      page.node.setExtGState(n, pdf.context.obj({ Type: 'ExtGState', ca: a, CA: a }))
      return n
    }
    if (src.background && src.background.toLowerCase() !== '#ffffff') {
      page.pushOperators(pushGraphicsState(), fillColor(src.background), rectangle(0, 0, src.width, src.height), fill(), popGraphicsState())
    }
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, 0, H)) // y-down from here on
    const strokeSetup = (s: Stroke): ReturnType<typeof setLineWidth>[] => {
      const ops = [strokeColor(s.color), setLineWidth(Math.max(0.05, s.width))]
      ops.push(setDashPattern(s.dash && s.dash.length ? s.dash : [], 0) as never)
      return ops as never
    }
    const stack: number[] = []
    for (const op of src.ops) {
      switch (op.t) {
        case 'text': {
          if (!op.text) break
          const line = shapeLine(catalog, [{ text: op.text, style: { face: op.face, size: op.size, color: op.color } }], 'auto')
          drawGlyphs({ t: 'glyphs', x: op.x, y: op.y, w: line.width, text: line.text, runs: line.runs, rtl: line.rtl })
          break
        }
        case 'glyphs':
          drawGlyphs(op)
          break
        case 'rect': {
          const ops = [pushGraphicsState()]
          if (op.opacity !== undefined && op.opacity < 1) ops.push(setGraphicsState(alpha(op.opacity)))
          if (op.fill) ops.push(fillColor(op.fill))
          if (op.stroke) ops.push(...strokeSetup(op.stroke))
          ops.push(rectangle(op.x, op.y, op.w, op.h))
          ops.push(op.fill && op.stroke ? fillAndStroke() : op.fill ? fill() : op.stroke ? strokeOp() : endPath())
          ops.push(popGraphicsState())
          page.pushOperators(...ops)
          break
        }
        case 'line':
          page.pushOperators(pushGraphicsState(), ...strokeSetup(op.stroke), moveTo(op.x1, op.y1), lineTo(op.x2, op.y2), strokeOp(), popGraphicsState())
          break
        case 'path': {
          const ops = [pushGraphicsState()]
          if (op.opacity !== undefined && op.opacity < 1) ops.push(setGraphicsState(alpha(op.opacity)))
          if (op.fill) ops.push(fillColor(op.fill))
          if (op.stroke) ops.push(...strokeSetup(op.stroke))
          for (const seg of op.d) {
            if (seg[0] === 'M') ops.push(moveTo(seg[1], seg[2]))
            else if (seg[0] === 'L') ops.push(lineTo(seg[1], seg[2]))
            else if (seg[0] === 'C') ops.push(appendBezierCurve(seg[1], seg[2], seg[3], seg[4], seg[5], seg[6]))
            else ops.push(closePath())
          }
          ops.push(op.fill && op.stroke ? fillAndStroke() : op.fill ? (op.evenOdd ? PDFOperator.of(PDFOperatorNames.FillEvenOdd) : fill()) : op.stroke ? strokeOp() : endPath())
          ops.push(popGraphicsState())
          page.pushOperators(...ops)
          break
        }
        case 'image': {
          const img = images.get(op.image.bytes)
          if (!img) break
          const cr = op.crop
          let x = op.x
          let y = op.y
          let w = op.w
          let h = op.h
          const ops = [pushGraphicsState()]
          if (cr && (cr.l || cr.t || cr.r || cr.b)) {
            const fw = w / Math.max(0.01, 1 - cr.l - cr.r)
            const fh = h / Math.max(0.01, 1 - cr.t - cr.b)
            ops.push(rectangle(x, y, w, h), clip(), endPath())
            x = x - cr.l * fw
            y = y - cr.t * fh
            w = fw
            h = fh
          }
          if (op.opacity !== undefined && op.opacity < 1) ops.push(setGraphicsState(alpha(op.opacity)))
          const name = page.node.newXObject('Im', img.ref)
          ops.push(concatTransformationMatrix(w, 0, 0, -h, x, y + h), drawObject(name), popGraphicsState())
          page.pushOperators(...ops)
          break
        }
        case 'push': {
          const ops = [pushGraphicsState()]
          if (op.rotate && op.rotate.deg) {
            const th = (op.rotate.deg * Math.PI) / 180
            const c = Math.cos(th)
            const s = Math.sin(th)
            const { cx, cy } = op.rotate
            ops.push(concatTransformationMatrix(c, s, -s, c, cx - cx * c + cy * s, cy - cx * s - cy * c))
          }
          if (op.clip) ops.push(rectangle(op.clip.x, op.clip.y, op.clip.w, op.clip.h), clip(), endPath())
          page.pushOperators(...ops)
          stack.push(1)
          break
        }
        case 'pop':
          if (stack.pop()) page.pushOperators(popGraphicsState())
          break
        case 'link':
          addLink(pdf, page, op.url, op.x, H - op.y - op.h, op.w, op.h)
          break
      }
    }
    while (stack.pop()) page.pushOperators(popGraphicsState())
    page.pushOperators(popGraphicsState())
    opts.onPage?.(pi + 1, pages.length)
    if (pi % 4 === 3) await new Promise((r) => setTimeout(r, 0))
  }
  if (opts.title) pdf.setTitle(opts.title)
  if (opts.author) pdf.setAuthor(opts.author)
  pdf.setProducer('Epdf')
  pdf.setCreator('Epdf')
  return pdf.save()
}

function addLink(pdf: PDFDocument, page: PDFPage, url: string, x: number, y: number, w: number, h: number): void {
  if (!SAFE_URL.test(url)) return
  const annot = pdf.context.register(
    pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) }
    })
  )
  const annots = page.node.Annots()
  if (annots) annots.push(annot)
  else page.node.set(PDFName.of('Annots'), pdf.context.obj([annot]))
}
