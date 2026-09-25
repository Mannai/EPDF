import type { LineItem, RectItem } from './model'

/**
 * Walks a PDF.js operator list (`page.getOperatorList()`), tracking the current transformation matrix and
 * fill colour, and reports what the exporters need: ruling lines, rectangles, where images are painted, and
 * the fill colour in force for every piece of shown text. Pure: no PDF.js import; the `OPS` table is passed in.
 */

export type OpsTable = Record<string, number>
export type Matrix = [number, number, number, number, number, number]

export interface PaintedImage {
  /** Name to look up in `page.objs` (null for inline images). */
  name: string | null
  /** Inline image data, when the image lives in the content stream. */
  inline?: unknown
  /** Bounding box in page coordinates (top-left origin). */
  x: number
  y: number
  width: number
  height: number
}

export interface TextColorRun {
  text: string
  color: string
}

export interface GraphicsResult {
  rects: RectItem[]
  lines: LineItem[]
  images: PaintedImage[]
  textColors: TextColorRun[]
  /** Number of image masks / repeated images that were skipped. */
  skippedImages: number
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** Matrix that applies `first`, then `then` (PDF `cm` semantics: CTM' = M x CTM is compose(M, CTM)). */
export function compose(first: ArrayLike<number>, then: ArrayLike<number>): Matrix {
  return [
    first[0] * then[0] + first[1] * then[2],
    first[0] * then[1] + first[1] * then[3],
    first[2] * then[0] + first[3] * then[2],
    first[2] * then[1] + first[3] * then[3],
    first[4] * then[0] + first[5] * then[2] + then[4],
    first[4] * then[1] + first[5] * then[3] + then[5]
  ]
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

const h2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase()

/** Reads a colour operand list into RRGGBB. Accepts `['#rrggbb']`, `[r,g,b]` (0-255) and `[gray]`. */
export function colorFromArgs(args: unknown): string | null {
  if (!Array.isArray(args)) return null
  const a0 = args[0]
  if (typeof a0 === 'string') {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(a0)
    return m ? m[1].toUpperCase() : null
  }
  if (typeof a0 === 'number') {
    if (args.length >= 3) return h2(args[0]) + h2(args[1]) + h2(args[2])
    if (args.length === 1) return h2(a0 <= 1 ? a0 * 255 : a0).repeat(3)
    if (args.length === 4) {
      const [c, m, y, k] = args as number[]
      return h2(255 * (1 - c) * (1 - k)) + h2(255 * (1 - m) * (1 - k)) + h2(255 * (1 - y) * (1 - k))
    }
  }
  return null
}

interface Sub {
  pts: [number, number][]
  closed: boolean
  curved: boolean
}

const EPS = 0.05

function parsePath(data: ArrayLike<number>, ctm: Matrix, toPage: (x: number, y: number) => [number, number]): Sub[] {
  const subs: Sub[] = []
  let cur: Sub | null = null
  const pt = (x: number, y: number): [number, number] => {
    const [ux, uy] = apply(ctm, x, y)
    return toPage(ux, uy)
  }
  for (let i = 0; i < data.length; ) {
    const op = data[i++]
    if (op === 0) {
      cur = { pts: [pt(data[i], data[i + 1])], closed: false, curved: false }
      subs.push(cur)
      i += 2
    } else if (op === 1) {
      if (!cur) {
        cur = { pts: [], closed: false, curved: false }
        subs.push(cur)
      }
      cur.pts.push(pt(data[i], data[i + 1]))
      i += 2
    } else if (op === 2) {
      if (cur) {
        cur.pts.push(pt(data[i + 4], data[i + 5]))
        cur.curved = true
      }
      i += 6
    } else if (op === 3) {
      if (cur) {
        cur.pts.push(pt(data[i + 2], data[i + 3]))
        cur.curved = true
      }
      i += 4
    } else if (op === 4) {
      if (cur) cur.closed = true
    } else {
      break // unknown opcode: stop rather than misparse
    }
  }
  return subs
}

/** Bounding box of a subpath that is an axis-aligned rectangle, or null. */
function asRect(s: Sub): { x: number; y: number; width: number; height: number } | null {
  if (s.curved) return null
  const p = s.pts.slice()
  if (p.length === 5 && Math.abs(p[0][0] - p[4][0]) < EPS && Math.abs(p[0][1] - p[4][1]) < EPS) p.pop()
  if (p.length !== 4) return null
  for (let i = 0; i < 4; i++) {
    const a = p[i]
    const b = p[(i + 1) % 4]
    const horiz = Math.abs(a[1] - b[1]) < EPS
    const vert = Math.abs(a[0] - b[0]) < EPS
    if (!horiz && !vert) return null
  }
  const xs = p.map((q) => q[0])
  const ys = p.map((q) => q[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

export function interpretOperators(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  OPS: OpsTable,
  toPage: (x: number, y: number) => [number, number]
): GraphicsResult {
  const res: GraphicsResult = { rects: [], lines: [], images: [], textColors: [], skippedImages: 0 }
  let ctm: Matrix = IDENTITY
  let fill = '000000'
  const stack: { ctm: Matrix; fill: string }[] = []

  const FILL = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
  const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])

  const addLine = (x1: number, y1: number, x2: number, y2: number): void => {
    if (Math.abs(y1 - y2) < EPS && Math.abs(x1 - x2) >= 3) res.lines.push({ x1: Math.min(x1, x2), y1, x2: Math.max(x1, x2), y2 })
    else if (Math.abs(x1 - x2) < EPS && Math.abs(y1 - y2) >= 3) res.lines.push({ x1, y1: Math.min(y1, y2), x2, y2: Math.max(y1, y2) })
  }

  const paintPath = (drawOp: number, data: ArrayLike<number>): void => {
    const doFill = FILL.has(drawOp)
    const doStroke = STROKE.has(drawOp)
    if (!doFill && !doStroke) return
    for (const s of parsePath(data, ctm, toPage)) {
      const r = asRect(s)
      if (r) {
        const thin = Math.min(r.width, r.height) <= 1.5
        if (thin && doFill && Math.max(r.width, r.height) >= 3) {
          // A filled hairline rectangle is how most producers draw table rules.
          if (r.width >= r.height) addLine(r.x, r.y + r.height / 2, r.x + r.width, r.y + r.height / 2)
          else addLine(r.x + r.width / 2, r.y, r.x + r.width / 2, r.y + r.height)
          continue
        }
        res.rects.push({ x: r.x, y: r.y, width: r.width, height: r.height, fill: doFill ? fill : null, stroke: doStroke })
        if (doStroke) {
          addLine(r.x, r.y, r.x + r.width, r.y)
          addLine(r.x, r.y + r.height, r.x + r.width, r.y + r.height)
          addLine(r.x, r.y, r.x, r.y + r.height)
          addLine(r.x + r.width, r.y, r.x + r.width, r.y + r.height)
        }
      } else if (doStroke && !s.curved) {
        for (let i = 0; i + 1 < s.pts.length; i++) addLine(s.pts[i][0], s.pts[i][1], s.pts[i + 1][0], s.pts[i + 1][1])
        if (s.closed && s.pts.length > 2) addLine(s.pts[s.pts.length - 1][0], s.pts[s.pts.length - 1][1], s.pts[0][0], s.pts[0][1])
      }
    }
  }

  const imageBox = (): { x: number; y: number; width: number; height: number } => {
    const cs = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)].map(([x, y]) => toPage(x, y))
    const xs = cs.map((c) => c[0])
    const ys = cs.map((c) => c[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  }

  const glyphString = (glyphs: unknown): string => {
    if (!Array.isArray(glyphs)) return ''
    let s = ''
    for (const g of glyphs) if (g && typeof g === 'object' && typeof (g as { unicode?: unknown }).unicode === 'string') s += (g as { unicode: string }).unicode
    return s
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i] as unknown[] | null | undefined
    switch (fn) {
      case OPS.save:
        stack.push({ ctm, fill })
        break
      case OPS.restore: {
        const s = stack.pop()
        if (s) {
          ctm = s.ctm
          fill = s.fill
        }
        break
      }
      case OPS.transform:
        if (args && args.length >= 6) ctm = compose(args as number[], ctm)
        break
      case OPS.paintFormXObjectBegin:
        stack.push({ ctm, fill })
        if (args && Array.isArray(args[0]) && args[0].length >= 6) ctm = compose(args[0] as number[], ctm)
        break
      case OPS.paintFormXObjectEnd: {
        const s = stack.pop()
        if (s) {
          ctm = s.ctm
          fill = s.fill
        }
        break
      }
      case OPS.setFillRGBColor:
      case OPS.setFillGray:
      case OPS.setFillCMYKColor: {
        const c = colorFromArgs(args)
        if (c) fill = c
        break
      }
      case OPS.constructPath: {
        if (!args) break
        const drawOp = args[0] as number
        const raw = args[1] as unknown
        const data = (Array.isArray(raw) && raw.length === 1 && raw[0] && typeof raw[0] === 'object' ? raw[0] : raw) as ArrayLike<number>
        if (data && typeof data.length === 'number') paintPath(drawOp, data)
        break
      }
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText: {
        const t = glyphString(args?.[0])
        if (t) res.textColors.push({ text: t, color: fill })
        break
      }
      case OPS.nextLineSetSpacingShowText: {
        const t = glyphString(args?.[2])
        if (t) res.textColors.push({ text: t, color: fill })
        break
      }
      case OPS.paintImageXObject:
        if (args && typeof args[0] === 'string') res.images.push({ name: args[0], ...imageBox() })
        break
      case OPS.paintInlineImageXObject:
        if (args) res.images.push({ name: null, inline: args[0], ...imageBox() })
        break
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObjectRepeat:
      case OPS.paintImageMaskXObjectGroup:
        res.skippedImages++
        break
      default:
        break
    }
  }
  return res
}

/**
 * Assigns a fill colour to every text item by aligning the strings PDF.js reports (`items`) with the glyph
 * strings the content stream showed (`runs`), character by character (whitespace ignored), so it survives
 * PDF.js merging or splitting show operations. Items that cannot be matched get null.
 */
export function assignTextColors(items: { str: string }[], runs: TextColorRun[]): (string | null)[] {
  const chars: string[] = []
  const colors: string[] = []
  for (const r of runs) {
    for (const ch of r.text) {
      if (/\s/.test(ch)) continue
      chars.push(ch)
      colors.push(r.color)
    }
  }
  const out: (string | null)[] = []
  let pos = 0
  for (const it of items) {
    const cs = [...it.str].filter((c) => !/\s/.test(c))
    if (cs.length === 0) {
      out.push(null)
      continue
    }
    if (chars[pos] !== cs[0]) {
      // resync: look ahead for this item's first characters
      const probe = cs.slice(0, Math.min(3, cs.length))
      let found = -1
      for (let k = pos; k < Math.min(chars.length, pos + 400); k++) {
        if (probe.every((c, j) => chars[k + j] === c)) {
          found = k
          break
        }
      }
      if (found >= 0) pos = found
    }
    out.push(pos < colors.length ? colors[pos] : null)
    pos += cs.length
  }
  return out
}
