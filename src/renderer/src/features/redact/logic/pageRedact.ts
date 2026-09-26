import type { PDFDocument, PDFFont, PDFRef } from 'pdf-lib'
import { renameContentResources } from '@shared/text'
import { loadPageSource } from '../../textedit/pdfcontent/analyze'
import { ContentParseError, serializeContent } from '../../textedit/pdfcontent/content'
import { N } from '../../textedit/pdfcontent/pdfutil'
import { disjointRects, rectQuad, type Quad, type Rect } from './geom'
import { pruneReplaced } from './prune'
import { ResEdit, RedactRefused, Walker, initialState, newStats, type RemovedRec, type Rgb, type Stats } from './interp'

/**
 * Overlay text laid out by the text engine (for text Helvetica cannot encode: Arabic "محجوب", Hebrew, CJK ...), at
 * size 1 with its baseline start at the origin; each mark scales it with `cm`. See `prepareOverlayText` in redact.ts.
 */
export interface EngineOverlayText {
  content: string
  fonts: { name: string; ref: PDFRef }[]
  /** Width at size 1. */
  width: number
}

/** What the redaction paints where the content was removed. */
export interface OverlayOptions {
  fill: Rgb
  /** Text centred in each mark; empty = none. */
  text: string
  /** Helvetica embedded once per document (see redact.ts). */
  font: PDFFont
  /** The text drawn by the engine instead of Helvetica (when the text needs it and it was prepared). */
  engineText?: EngineOverlayText
}

export interface PageResult {
  removed: RemovedRec[]
  warnings: string[]
}

/** Resource name prefix of everything the overlay adds (the verifier ignores text drawn with this font). */
export const OVERLAY_FONT_PREFIX = 'EpdfRdFont'

/** One mark on a page: its bounding rect and, for rotated text, its exact quad. */
export interface MarkShape {
  rect: Rect
  quad: Quad | null
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const f = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))

/** Overlay content: filled boxes plus optional text, drawn in a clean graphics state. */
/** Centre, reading direction and size of each mark as the reader sees it. */
function markFrames(shapes: readonly MarkShape[], rotation: number): { cx: number; cy: number; dispW: number; dispH: number; c: number; sn: number }[] {
  const rot = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360
  return shapes.map((s) => {
    if (s.quad) {
      const q = s.quad
      const dispW = Math.hypot(q[2] - q[0], q[3] - q[1])
      const len = dispW || 1
      return { cx: (q[0] + q[2] + q[4] + q[6]) / 4, cy: (q[1] + q[3] + q[5] + q[7]) / 4, dispW, dispH: Math.hypot(q[4] - q[2], q[5] - q[3]), c: (q[2] - q[0]) / len, sn: (q[3] - q[1]) / len }
    }
    const m = s.rect
    const w = m.x1 - m.x0
    const h = m.y1 - m.y0
    const th = (rot * Math.PI) / 180
    return { cx: (m.x0 + m.x1) / 2, cy: (m.y0 + m.y1) / 2, dispW: rot === 90 || rot === 270 ? h : w, dispH: rot === 90 || rot === 270 ? w : h, c: Math.round(Math.cos(th)), sn: Math.round(Math.sin(th)) }
  })
}

export function overlayBytes(shapes: readonly MarkShape[], opts: OverlayOptions, rotation: number, names: { gs: string; font: string; engineFonts?: Map<string, string> }): Uint8Array {
  const [r, g, b] = opts.fill
  const lines: string[] = ['q', `/${names.gs} gs`, `${f(r)} ${f(g)} ${f(b)} rg`]
  for (const m of disjointRects(shapes.filter((s) => !s.quad).map((s) => s.rect))) lines.push(`${f(m.x0)} ${f(m.y0)} ${f(m.x1 - m.x0)} ${f(m.y1 - m.y0)} re f`)
  for (const s of shapes) {
    const q = s.quad
    if (q) lines.push(`${f(q[0])} ${f(q[1])} m ${f(q[2])} ${f(q[3])} l ${f(q[4])} ${f(q[5])} l ${f(q[6])} ${f(q[7])} l h f`)
  }
  const et = opts.engineText
  if (et && opts.text.trim() !== '' && et.width > 0) {
    // Engine text (shaped, right-to-left where needed), scaled into every mark like the Helvetica text below.
    const content = renameContentResources(et.content, names.engineFonts ?? new Map())
    for (const fr of markFrames(shapes, rotation)) {
      const size = Math.min(fr.dispH * 0.72, (fr.dispW * 0.94) / et.width)
      if (!(size >= 4)) continue
      const ox = (-et.width * size) / 2
      const oy = -size * 0.32
      const e = fr.cx + ox * fr.c - oy * fr.sn
      const fy = fr.cy + ox * fr.sn + oy * fr.c
      lines.push(`q ${f(fr.c * size)} ${f(fr.sn * size)} ${f(-fr.sn * size)} ${f(fr.c * size)} ${f(e)} ${f(fy)} cm`, content, 'Q')
    }
    lines.push('Q', '')
    return enc(lines.join('\n'))
  }
  const text = opts.text
    .split('')
    .filter((ch) => {
      try {
        opts.font.encodeText(ch)
        return true
      } catch {
        return false
      }
    })
    .join('')
  if (text) {
    const white = luminance(opts.fill) < 0.5
    const rot = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360
    const unit = opts.font.widthOfTextAtSize(text, 1)
    const hex = opts.font.encodeText(text).toString()
    lines.push('BT', white ? '1 1 1 rg' : '0 0 0 rg')
    for (const s of shapes) {
      let cx: number
      let cy: number
      let dispW: number
      let dispH: number
      let c: number
      let sn: number
      if (s.quad) {
        const q = s.quad
        cx = (q[0] + q[2] + q[4] + q[6]) / 4
        cy = (q[1] + q[3] + q[5] + q[7]) / 4
        dispW = Math.hypot(q[2] - q[0], q[3] - q[1])
        dispH = Math.hypot(q[4] - q[2], q[5] - q[3])
        const len = dispW || 1
        c = (q[2] - q[0]) / len
        sn = (q[3] - q[1]) / len
      } else {
        const m = s.rect
        const w = m.x1 - m.x0
        const h = m.y1 - m.y0
        cx = (m.x0 + m.x1) / 2
        cy = (m.y0 + m.y1) / 2
        dispW = rot === 90 || rot === 270 ? h : w
        dispH = rot === 90 || rot === 270 ? w : h
        const th = (rot * Math.PI) / 180
        c = Math.round(Math.cos(th))
        sn = Math.round(Math.sin(th))
      }
      const size = Math.min(dispH * 0.72, (dispW * 0.94) / unit)
      if (!(size >= 4) || unit <= 0) continue
      const ox = (-unit * size) / 2
      const oy = -size * 0.32
      const e = cx + ox * c - oy * sn
      const fy = cy + ox * sn + oy * c
      lines.push(`/${names.font} ${f(size)} Tf ${f(c)} ${f(sn)} ${f(-sn)} ${f(c)} ${f(e)} ${f(fy)} Tm ${hex} Tj`)
    }
    lines.push('ET')
  }
  lines.push('Q', '')
  return enc(lines.join('\n'))
}

/**
 * Redacts one page: rewrites its content streams (and the forms/images/soft masks they use) so nothing under the
 * marks survives, then appends the overlay. Throws `RedactRefused` when the page cannot be handled safely.
 */
export function redactPage(pdf: PDFDocument, pageIndex: number, marks: readonly MarkShape[], opts: OverlayOptions, stats: Stats = newStats()): PageResult {
  const ctx = pdf.context
  const page = pdf.getPage(pageIndex)
  let src: ReturnType<typeof loadPageSource>
  try {
    src = loadPageSource(pdf, pageIndex)
  } catch (e) {
    if (e instanceof ContentParseError) throw new RedactRefused(`Page ${pageIndex + 1} has content that cannot be read safely (${e.message}), so it was not redacted.`)
    throw e
  }
  const disjoint = disjointRects(marks.map((m) => m.rect))
  const shapes: Quad[] = marks.map((m) => m.quad ?? rectQuad(m.rect))
  const walker = new Walker(pdf, { marks: disjoint, shapes, edit: true, fill: opts.fill }, stats)
  const res = new ResEdit(ctx, src.resources, walker.owned)
  let out: ReturnType<Walker['process']>
  try {
    out = walker.process({ slots: src.slots.map((s) => ({ ops: s.ops, tail: s.tail })), res }, initialState(), 0)
  } catch (e) {
    if (e instanceof RedactRefused) throw new RedactRefused(`Page ${pageIndex + 1}: ${e.message}`)
    throw e
  }

  const gsDict = ctx.obj({ Type: 'ExtGState', CA: 1, ca: 1, BM: 'Normal', SMask: 'None', AIS: false })
  const gsName = res.add('ExtGState', 'EpdfRdGS', gsDict)
  const fontName = res.add('Font', OVERLAY_FONT_PREFIX, opts.font.ref)
  // Engine fonts of the overlay text get names with the same prefix (the self-check ignores the overlay by it).
  const engineFonts = new Map<string, string>()
  if (opts.engineText && opts.text.trim() !== '') for (const ef of opts.engineText.fonts) engineFonts.set(ef.name, res.add('Font', OVERLAY_FONT_PREFIX, ef.ref))
  const rotation = page.getRotation().angle
  const overlay = overlayBytes(marks, opts, rotation, { gs: gsName, font: fontName, engineFonts })

  const refs: PDFRef[] = []
  refs.push(ctx.register(ctx.flateStream(enc('q\n'))))
  src.slots.forEach((slot, i) => {
    const o = out.slots[i]
    if (o.changed) {
      const template = slot.stream?.dict
      const lit: Record<string, unknown> = {}
      if (template) for (const [k, v] of template.entries()) if (!['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms'].includes(k.decodeText())) lit[k.decodeText()] = v
      refs.push(ctx.register(ctx.flateStream(serializeContent(o.ops, o.tail), lit as never)))
    } else if (slot.ref) refs.push(slot.ref)
    else if (slot.stream) refs.push(ctx.register(slot.stream))
  })
  refs.push(ctx.register(ctx.flateStream(enc('Q\n'.repeat(out.endDepth + 1)))))
  refs.push(ctx.register(ctx.flateStream(overlay)))
  page.node.set(N('Contents'), ctx.obj(refs))
  if (res.override) page.node.set(N('Resources'), res.override)
  pruneReplaced(res.effective, out.slots, walker.owned, walker.replaced)
  return { removed: walker.removed, warnings: walker.warnings }
}
