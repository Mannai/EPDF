import type { PDFDocument, PDFFont, PDFRef } from 'pdf-lib'
import { loadPageSource } from '../../textedit/pdfcontent/analyze'
import { ContentParseError, serializeContent } from '../../textedit/pdfcontent/content'
import { N } from '../../textedit/pdfcontent/pdfutil'
import { disjointRects, type Rect } from './geom'
import { pruneReplaced } from './prune'
import { ResEdit, RedactRefused, Walker, initialState, newStats, type RemovedRec, type Rgb, type Stats } from './interp'

/** What the redaction paints where the content was removed. */
export interface OverlayOptions {
  fill: Rgb
  /** Text centred in each mark; empty = none. */
  text: string
  /** Helvetica embedded once per document (see redact.ts). */
  font: PDFFont
}

export interface PageResult {
  removed: RemovedRec[]
  warnings: string[]
}

/** Resource name prefix of everything the overlay adds (the verifier ignores text drawn with this font). */
export const OVERLAY_FONT_PREFIX = 'EpdfRdFont'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const f = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))

/** Overlay content: filled boxes plus optional text, drawn in a clean graphics state. */
export function overlayBytes(rects: readonly Rect[], marks: readonly Rect[], opts: OverlayOptions, rotation: number, names: { gs: string; font: string }): Uint8Array {
  const [r, g, b] = opts.fill
  const lines: string[] = ['q', `/${names.gs} gs`, `${f(r)} ${f(g)} ${f(b)} rg`]
  for (const m of rects) lines.push(`${f(m.x0)} ${f(m.y0)} ${f(m.x1 - m.x0)} ${f(m.y1 - m.y0)} re f`)
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
    const th = (rot * Math.PI) / 180
    const c = Math.round(Math.cos(th))
    const s = Math.round(Math.sin(th))
    const unit = opts.font.widthOfTextAtSize(text, 1)
    const hex = opts.font.encodeText(text).toString()
    lines.push('BT', white ? '1 1 1 rg' : '0 0 0 rg')
    for (const m of marks) {
      const w = m.x1 - m.x0
      const h = m.y1 - m.y0
      const dispW = rot === 90 || rot === 270 ? h : w
      const dispH = rot === 90 || rot === 270 ? w : h
      const size = Math.min(dispH * 0.72, (dispW * 0.94) / unit)
      if (!(size >= 4) || unit <= 0) continue
      const ox = (-unit * size) / 2
      const oy = -size * 0.32
      const cx = (m.x0 + m.x1) / 2
      const cy = (m.y0 + m.y1) / 2
      const e = cx + ox * c - oy * s
      const fy = cy + ox * s + oy * c
      lines.push(`/${names.font} ${f(size)} Tf ${c} ${s} ${-s} ${c} ${f(e)} ${f(fy)} Tm ${hex} Tj`)
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
export function redactPage(pdf: PDFDocument, pageIndex: number, marks: readonly Rect[], opts: OverlayOptions, stats: Stats = newStats()): PageResult {
  const ctx = pdf.context
  const page = pdf.getPage(pageIndex)
  let src: ReturnType<typeof loadPageSource>
  try {
    src = loadPageSource(pdf, pageIndex)
  } catch (e) {
    if (e instanceof ContentParseError) throw new RedactRefused(`Page ${pageIndex + 1} has content that cannot be read safely (${e.message}), so it was not redacted.`)
    throw e
  }
  const disjoint = disjointRects(marks)
  const walker = new Walker(pdf, { marks: disjoint, origMarks: [...marks], edit: true, fill: opts.fill }, stats)
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
  const rotation = page.getRotation().angle
  const overlay = overlayBytes(disjoint, marks, opts, rotation, { gs: gsName, font: fontName })

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
