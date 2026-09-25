import { PDFDict, PDFName, PDFRef, PDFStream, type PDFDocument, type PDFFont } from 'pdf-lib'
import { clampOpacity, isOurName, sanitizeColor, type Color } from './basics'
import { stdFont, sanitizeText, wrapLines } from './fonts'
import {
  padRect,
  rectHeight,
  rectWidth,
  rotationOfMatrix,
  unionRects,
  uprightMatrix,
  uprightSize,
  type Pt,
  type Rect
} from './geometry'
import type { AnnotInfo } from './model'
import { formStream, fmt, get, getDict, getNumbers, getString, setNumbers } from './pdfobj'
import { quadCorners, quadsBounds } from './quads'
import { readAnnotation } from './read'
import { stampByName, type StampDef } from './stamps'
import type { Located } from './annots'

/**
 * Appearance streams (/AP /N). Every annotation type Epdf creates is drawn here as a vector form
 * XObject so it renders identically in Acrobat, Preview, Chrome and PDF.js. Builders are driven by the
 * annotation dictionary itself (via `readAnnotation`), so creating and re-styling share one code path.
 */

export interface Built {
  ops: string
  bbox: Rect
  matrix?: number[]
  resources: Record<string, unknown>
  /** New /Rect when the builder derives it from geometry (markup, ink, line). */
  rect?: Rect
}

// ---------------------------------------------------------------- content-stream helpers

export function colorOp(c: Color, stroke: boolean): string {
  const v = c.map(fmt).join(' ')
  const op = c.length === 1 ? 'g' : c.length === 4 ? 'k' : 'rg'
  return `${v} ${stroke ? op.toUpperCase() : op}`
}

const gsResource = (opacity: number, multiply = false): Record<string, unknown> => ({
  ExtGState: {
    GS0: { Type: 'ExtGState', CA: clampOpacity(opacity), ca: clampOpacity(opacity), BM: multiply ? 'Multiply' : undefined }
  }
})

const dashOp = (dashed: boolean, w: number): string => (dashed ? `[${fmt(Math.max(3, w * 3))} ${fmt(Math.max(2, w * 2))}] 0 d` : '[] 0 d')

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]]
const len = (a: Pt): number => Math.hypot(a[0], a[1])
const unit = (a: Pt): Pt => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l]
}
const add = (a: Pt, b: Pt, k = 1): Pt => [a[0] + b[0] * k, a[1] + b[1] * k]

// ---------------------------------------------------------------- text markup

export function buildTextMarkup(a: AnnotInfo): Built | null {
  if (a.quads.length === 0) return null
  const color = sanitizeColor(a.color, a.subtype === 'Highlight' ? [1, 0.92, 0.23] : [0.85, 0.1, 0.1])
  const b = quadsBounds(a.quads)!
  const rect = a.subtype === 'Highlight' ? b : padRect(b, 1.5)
  let ops = '/GS0 gs\n'
  if (a.subtype === 'Highlight') {
    ops += colorOp(color, false) + '\n'
    for (const q of a.quads) {
      const { tl, tr, bl, br } = quadCorners(q)
      ops += `${fmt(tl[0])} ${fmt(tl[1])} m ${fmt(tr[0])} ${fmt(tr[1])} l ${fmt(br[0])} ${fmt(br[1])} l ${fmt(bl[0])} ${fmt(bl[1])} l h f\n`
    }
  } else {
    ops += colorOp(color, true) + ' 1 J 1 j\n'
    for (const q of a.quads) {
      const { tl, bl, br } = quadCorners(q)
      const up = sub(tl, bl)
      const h = len(up) || 1
      const u = unit(up)
      const lw = Math.min(2, Math.max(0.6, h * 0.07))
      ops += `${fmt(lw)} w\n`
      if (a.subtype === 'Underline') {
        const o = lw / 2 + h * 0.04
        const p1 = add(bl, u, o)
        const p2 = add(br, u, o)
        ops += `${fmt(p1[0])} ${fmt(p1[1])} m ${fmt(p2[0])} ${fmt(p2[1])} l S\n`
      } else if (a.subtype === 'StrikeOut') {
        const p1 = add(bl, up, 0.5)
        const p2 = add(br, up, 0.5)
        ops += `${fmt(p1[0])} ${fmt(p1[1])} m ${fmt(p2[0])} ${fmt(p2[1])} l S\n`
      } else {
        // Squiggly: a zig-zag along the bottom edge.
        const along = sub(br, bl)
        const total = len(along)
        const dir = unit(along)
        const amp = Math.max(0.6, h * 0.06)
        const step = Math.max(1.5, h * 0.18)
        const base = add(bl, u, amp + lw / 2 + h * 0.02)
        const first = add(base, u, -amp)
        let s = `${fmt(first[0])} ${fmt(first[1])} m `
        for (let d = step, i = 0; ; d += step, i++) {
          const dd = Math.min(d, total)
          const p = add(add(base, dir, dd), u, i % 2 === 0 ? amp : -amp)
          s += `${fmt(p[0])} ${fmt(p[1])} l `
          if (dd >= total) break
        }
        ops += s + 'S\n'
      }
    }
  }
  return { ops, bbox: rect, resources: gsResource(a.opacity, a.subtype === 'Highlight'), rect }
}

// ---------------------------------------------------------------- ink

export function buildInk(a: AnnotInfo): Built | null {
  const strokes = a.ink.filter((s) => s.length >= 2)
  if (strokes.length === 0) return null
  const w = Math.max(0.1, a.borderWidth || 1)
  const color = sanitizeColor(a.color, [0.1, 0.1, 0.8])
  const pts: Rect[] = strokes.flatMap((s) => {
    const r: Rect[] = []
    for (let i = 0; i + 1 < s.length; i += 2) r.push([s[i], s[i + 1], s[i], s[i + 1]])
    return r
  })
  const rect = padRect(unionRects(pts)!, w / 2 + 1)
  let ops = `/GS0 gs\n${colorOp(color, true)} ${fmt(w)} w 1 J 1 j\n`
  for (const s of strokes) {
    ops += `${fmt(s[0])} ${fmt(s[1])} m `
    for (let i = 2; i + 1 < s.length; i += 2) ops += `${fmt(s[i])} ${fmt(s[i + 1])} l `
    ops += 'S\n'
  }
  return { ops, bbox: rect, resources: gsResource(a.opacity), rect }
}

// ---------------------------------------------------------------- shapes

const KAPPA = 0.5522847498

export function buildSquareCircle(a: AnnotInfo): Built {
  const w = a.borderWidth ?? 1
  const stroke = w > 0
  const color = sanitizeColor(a.color, [0.85, 0.1, 0.1])
  const fill = a.fill && a.fill.length ? sanitizeColor(a.fill) : null
  const r = a.rect
  const inner: Rect = [r[0] + w / 2, r[1] + w / 2, r[2] - w / 2, r[3] - w / 2]
  let ops = '/GS0 gs\n'
  if (fill) ops += colorOp(fill, false) + '\n'
  if (stroke) ops += `${colorOp(color, true)} ${fmt(w)} w ${dashOp(a.dashed, w)}\n`
  if (a.subtype === 'Square') {
    ops += `${fmt(inner[0])} ${fmt(inner[1])} ${fmt(rectWidth(inner))} ${fmt(rectHeight(inner))} re\n`
  } else {
    const cx = (inner[0] + inner[2]) / 2
    const cy = (inner[1] + inner[3]) / 2
    const rx = rectWidth(inner) / 2
    const ry = rectHeight(inner) / 2
    const kx = rx * KAPPA
    const ky = ry * KAPPA
    ops +=
      `${fmt(cx + rx)} ${fmt(cy)} m ` +
      `${fmt(cx + rx)} ${fmt(cy + ky)} ${fmt(cx + kx)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c ` +
      `${fmt(cx - kx)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ky)} ${fmt(cx - rx)} ${fmt(cy)} c ` +
      `${fmt(cx - rx)} ${fmt(cy - ky)} ${fmt(cx - kx)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c ` +
      `${fmt(cx + kx)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - ky)} ${fmt(cx + rx)} ${fmt(cy)} c h\n`
  }
  ops += fill && stroke ? 'B\n' : fill ? 'f\n' : stroke ? 'S\n' : 'n\n'
  return { ops, bbox: r, resources: gsResource(a.opacity) }
}

export const SUPPORTED_LINE_ENDS = ['None', 'OpenArrow', 'ClosedArrow']

export function buildLine(a: AnnotInfo): Built | null {
  if (!a.line || a.line.length < 4) return null
  const w = Math.max(0.1, a.borderWidth || 1)
  const color = sanitizeColor(a.color, [0.85, 0.1, 0.1])
  const p1: Pt = [a.line[0], a.line[1]]
  const p2: Pt = [a.line[2], a.line[3]]
  const head = Math.max(8, w * 4.5)
  const bounds: Rect[] = [
    [p1[0], p1[1], p1[0], p1[1]],
    [p2[0], p2[1], p2[0], p2[1]]
  ]
  let ops = `/GS0 gs\n${colorOp(color, true)} ${fmt(w)} w 1 J 1 j ${dashOp(a.dashed, w)}\n`
  const fillColor = a.fill && a.fill.length ? sanitizeColor(a.fill) : color
  ops += `${fmt(p1[0])} ${fmt(p1[1])} m ${fmt(p2[0])} ${fmt(p2[1])} l S\n`
  const ends: [string, Pt, Pt][] = [
    [a.lineEnds[0], p1, p2],
    [a.lineEnds[1], p2, p1]
  ]
  for (const [style, tip, from] of ends) {
    if (style !== 'OpenArrow' && style !== 'ClosedArrow') continue
    const back = unit(sub(from, tip)) // from the tip back along the line
    const ang = (25 * Math.PI) / 180
    const rot = (v: Pt, t: number): Pt => [v[0] * Math.cos(t) - v[1] * Math.sin(t), v[0] * Math.sin(t) + v[1] * Math.cos(t)]
    const l1 = add(tip, rot(back, ang), head)
    const l2 = add(tip, rot(back, -ang), head)
    bounds.push([l1[0], l1[1], l1[0], l1[1]], [l2[0], l2[1], l2[0], l2[1]])
    if (style === 'OpenArrow') {
      ops += `${fmt(l1[0])} ${fmt(l1[1])} m ${fmt(tip[0])} ${fmt(tip[1])} l ${fmt(l2[0])} ${fmt(l2[1])} l S\n`
    } else {
      ops +=
        `q ${colorOp(fillColor, false)} ${fmt(tip[0])} ${fmt(tip[1])} m ${fmt(l1[0])} ${fmt(l1[1])} l ${fmt(l2[0])} ${fmt(l2[1])} l h B Q\n`
    }
  }
  const rect = padRect(unionRects(bounds)!, w / 2 + 1)
  return { ops, bbox: rect, resources: gsResource(a.opacity), rect }
}

// ---------------------------------------------------------------- free text

export interface FreeTextLayout {
  lines: string[]
  lead: number
  pad: number
  /** Height (points) needed to show all lines inside the border. */
  neededHeight: number
}

/** Line breaking and metrics of a FreeText box; shared by the appearance builder and the UI (auto-grow). */
export function layoutFreeText(font: PDFFont, textRaw: string, width: number, size: number, borderWidth: number): FreeTextLayout {
  const pad = 2 + borderWidth
  const clean = sanitizeText(font, textRaw)
  const lines = wrapLines(clean, Math.max(1, width - 2 * pad), (t) => font.widthOfTextAtSize(t, size))
  const lead = size * 1.2
  return { lines, lead, pad, neededHeight: lines.length * lead + 2 * pad }
}

export async function buildFreeText(pdf: PDFDocument, a: AnnotInfo, rotation: number): Promise<Built> {
  const font = await stdFont(pdf, 'Helvetica')
  const [w, h] = uprightSize(a.rect, rotation)
  const bw = Math.max(0, a.borderWidth)
  const size = a.fontSize
  const color = sanitizeColor(a.color, [0, 0, 0])
  const fill = a.fill && a.fill.length ? sanitizeColor(a.fill) : null
  const lay = layoutFreeText(font, a.contents, w, size, bw)
  let ops = '/GS0 gs\n'
  if (fill) ops += `${colorOp(fill, false)} 0 0 ${fmt(w)} ${fmt(h)} re f\n`
  if (bw > 0) ops += `${colorOp(color, true)} ${fmt(bw)} w ${dashOp(a.dashed, bw)} ${fmt(bw / 2)} ${fmt(bw / 2)} ${fmt(w - bw)} ${fmt(h - bw)} re S\n`
  ops += `q ${fmt(bw)} ${fmt(bw)} ${fmt(w - 2 * bw)} ${fmt(h - 2 * bw)} re W n\nBT\n/Helv ${fmt(size)} Tf\n${colorOp(color, false)}\n`
  let y = h - lay.pad - size * 0.92
  for (const line of lay.lines) {
    if (line !== '') ops += `1 0 0 1 ${fmt(lay.pad)} ${fmt(y)} Tm ${font.encodeText(line).toString()} Tj\n`
    y -= lay.lead
  }
  ops += 'ET\nQ\n'
  return {
    ops,
    bbox: [0, 0, w, h],
    matrix: uprightMatrix(rotation, w, h),
    resources: { ...gsResource(a.opacity), Font: { Helv: font.ref } }
  }
}

// ---------------------------------------------------------------- sticky note icon

export const NOTE_SIZE = 24

export function buildNote(a: AnnotInfo, rotation: number): Built {
  const color = sanitizeColor(a.color, [1, 0.85, 0.2])
  const s = NOTE_SIZE
  let ops = `/GS0 gs\n${colorOp(color, false)} 0.2 0.2 0.2 RG 0.8 w 1 j\n`
  if (a.iconName === 'Comment') {
    ops += '2 8 m 6 8 l 6 3 l 12 8 l 22 8 l 22 22 l 2 22 l h B\n'
    ops += '0.2 0.2 0.2 RG 0.9 w 5.5 17.5 m 18.5 17.5 l S 5.5 13 m 15 13 l S\n'
  } else {
    ops += '2 2 20 20 re B\n'
    ops += '0.2 0.2 0.2 RG 0.9 w 5.5 17 m 18.5 17 l S 5.5 12.5 m 18.5 12.5 l S 5.5 8 m 13 8 l S\n'
  }
  return { ops, bbox: [0, 0, s, s], matrix: uprightMatrix(rotation, s, s), resources: gsResource(a.opacity) }
}

// ---------------------------------------------------------------- stamps

export const STAMP_HEIGHT = 44

/** Natural (upright) size of a built-in stamp in points. */
export async function stampSize(pdf: PDFDocument, def: StampDef): Promise<[number, number]> {
  const bold = await stdFont(pdf, 'Helvetica-Bold')
  const tw = bold.widthOfTextAtSize(def.label, 22)
  return [Math.round(tw + (def.shape === 'arrow' ? 56 : 34)), STAMP_HEIGHT]
}

export async function buildBuiltInStamp(pdf: PDFDocument, a: AnnotInfo, def: StampDef, rotation: number): Promise<Built> {
  const font = await stdFont(pdf, 'Helvetica-Bold')
  const [w, h] = uprightSize(a.rect, rotation)
  const color = sanitizeColor(def.color)
  let ops = '/GS0 gs\n'
  const label = def.label
  const arrow = def.shape === 'arrow'
  const inner = arrow ? w - 30 : w - 16
  let size = Math.min(h * 0.5, 26)
  while (size > 6 && font.widthOfTextAtSize(label, size) > inner) size -= 0.5
  if (arrow) {
    const tip = h / 2
    ops += `1 0.85 0.2 rg ${colorOp(color, true)} 1.6 w 1 j 1.5 1.5 m ${fmt(w - tip - 1)} 1.5 l ${fmt(w - 1.5)} ${fmt(h / 2)} l ${fmt(w - tip - 1)} ${fmt(h - 1.5)} l 1.5 ${fmt(h - 1.5)} l h B\n`
  } else {
    const r = Math.min(8, h / 4)
    const x0 = 1.5
    const y0 = 1.5
    const x1 = w - 1.5
    const y1 = h - 1.5
    const k = r * (1 - KAPPA)
    ops +=
      `${colorOp(color, true)} 2.6 w 1 j\n` +
      `${fmt(x0 + r)} ${fmt(y0)} m ${fmt(x1 - r)} ${fmt(y0)} l ${fmt(x1 - k)} ${fmt(y0)} ${fmt(x1)} ${fmt(y0 + k)} ${fmt(x1)} ${fmt(y0 + r)} c ` +
      `${fmt(x1)} ${fmt(y1 - r)} l ${fmt(x1)} ${fmt(y1 - k)} ${fmt(x1 - k)} ${fmt(y1)} ${fmt(x1 - r)} ${fmt(y1)} c ` +
      `${fmt(x0 + r)} ${fmt(y1)} l ${fmt(x0 + k)} ${fmt(y1)} ${fmt(x0)} ${fmt(y1 - k)} ${fmt(x0)} ${fmt(y1 - r)} c ` +
      `${fmt(x0)} ${fmt(y0 + r)} l ${fmt(x0)} ${fmt(y0 + k)} ${fmt(x0 + k)} ${fmt(y0)} ${fmt(x0 + r)} ${fmt(y0)} c h S\n`
  }
  const tw = font.widthOfTextAtSize(label, size)
  const cx = arrow ? (w - h / 2) / 2 : w / 2
  ops += `BT\n/HelvB ${fmt(size)} Tf\n${colorOp(arrow ? [0.1, 0.1, 0.15] : color, false)}\n1 0 0 1 ${fmt(cx - tw / 2)} ${fmt(h / 2 - size * 0.36)} Tm ${font.encodeText(label).toString()} Tj\nET\n`
  return {
    ops,
    bbox: [0, 0, w, h],
    matrix: uprightMatrix(rotation, w, h),
    resources: { ...gsResource(a.opacity), Font: { HelvB: font.ref } }
  }
}

/** Appearance for an image stamp: the image XObject scaled to the (upright) box. */
export function buildImageStamp(a: AnnotInfo, imageRef: PDFRef, rotation: number): Built {
  const [w, h] = uprightSize(a.rect, rotation)
  return {
    ops: `/GS0 gs\nq ${fmt(w)} 0 0 ${fmt(h)} 0 0 cm /Im0 Do Q\n`,
    bbox: [0, 0, w, h],
    matrix: uprightMatrix(rotation, w, h),
    resources: { ...gsResource(a.opacity), XObject: { Im0: imageRef } }
  }
}

// ---------------------------------------------------------------- installing

/** Reads the annotation as the UI sees it, from a bare dictionary. */
export const infoOfDict = (dict: PDFDict): AnnotInfo | null => readAnnotation({ id: '', dict, pageIndex: 0, index: 0 } as unknown as Located)

/** Rotation an existing appearance was authored for (from its /Matrix), else 0. */
export function apRotation(dict: PDFDict): 0 | 90 | 180 | 270 {
  const ap = getDict(dict, 'AP')
  const n = ap ? get(ap, 'N') : undefined
  const sd = n instanceof PDFStream ? n.dict : undefined
  return rotationOfMatrix(sd ? getNumbers(sd, 'Matrix') : undefined)
}

function existingImageRef(dict: PDFDict): PDFRef | undefined {
  const ap = getDict(dict, 'AP')
  const n = ap ? get(ap, 'N') : undefined
  if (!(n instanceof PDFStream)) return undefined
  const res = getDict(n.dict, 'Resources')
  const xo = res ? getDict(res, 'XObject') : undefined
  const im = xo?.get(PDFName.of('Im0'))
  return im instanceof PDFRef ? im : undefined
}

/** Replaces the annotation's /AP /N with a freshly built stream (and drops our own previous one). */
export function installAppearance(pdf: PDFDocument, dict: PDFDict, built: Built): void {
  const ctx = pdf.context
  const ap = getDict(dict, 'AP')
  const oldN = ap?.get(PDFName.of('N'))
  const stream = formStream(ctx, built.ops, built.bbox, built.resources as never, built.matrix)
  const ref = ctx.register(stream)
  if (oldN instanceof PDFRef && isOurName(getString(dict, 'NM'))) ctx.delete(oldN)
  dict.set(PDFName.of('AP'), ctx.obj({ N: ref }))
  if (built.rect) setNumbers(ctx, dict, 'Rect', built.rect)
}

/**
 * (Re)generates the appearance of a supported annotation from its dictionary. Returns false when the
 * annotation is not something Epdf can safely redraw (the existing appearance is then left untouched).
 * `rotation` is the page /Rotate, used only when the annotation has no appearance yet.
 */
export async function regenerateAppearance(pdf: PDFDocument, dict: PDFDict, rotation = 0): Promise<boolean> {
  const a = infoOfDict(dict)
  if (!a || a.complex) return false
  const rot = getDict(dict, 'AP') ? apRotation(dict) : rotation
  let built: Built | null = null
  switch (a.subtype) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly':
      built = buildTextMarkup(a)
      break
    case 'Ink':
      built = buildInk(a)
      break
    case 'Square':
    case 'Circle':
      built = buildSquareCircle(a)
      break
    case 'Line':
      built = buildLine(a)
      break
    case 'FreeText':
      built = await buildFreeText(pdf, a, rot)
      break
    case 'Text':
      built = buildNote(a, rot)
      break
    case 'Stamp': {
      if (!a.ours) return false
      const def = stampByName(a.iconName)
      if (def) built = await buildBuiltInStamp(pdf, a, def, rot)
      else {
        const img = existingImageRef(dict)
        if (img) built = buildImageStamp(a, img, rot)
      }
      break
    }
  }
  if (!built) return false
  installAppearance(pdf, dict, built)
  return true
}
