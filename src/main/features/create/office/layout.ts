import type { BorderSpec, Block, Cell, FloatSpec, Inline, ParaProps, Paragraph, Table, TabStop, TextStyle } from './flow'
import { complexStyleOf, splitByScript } from './flow'
import type { Face, FontCatalog } from './fonts'
import type { Op, Stroke, Warnings } from './ops'
import { joinSegments, shapeLine, type DrawStyle, type LineItem, type ShapedLine } from './textline'

/**
 * Layout primitives shared by all converters: a `Fragment` is a laid-out block (paragraph, table, image band)
 * measured in points with its display-list ops relative to its own top-left corner, plus the offsets where it
 * may legally be split across pages. The paginator (paginate.ts) stacks fragments onto pages.
 */

export interface Fragment {
  height: number
  ops: Op[]
  /** Preferred split offsets (line / row boundaries), ascending, strictly inside (0, height). */
  breaks: number[]
  /** Fallback split offsets used only when nothing fits otherwise (inside very tall table rows). */
  softBreaks?: number[]
  keepNext?: boolean
  /** Start this fragment on a new page. */
  breakBefore?: boolean
  /** Images anchored to the page or margin rather than to the flow. */
  floats?: FloatSpec[]
  /** Table header rows, repeated at the top of every continuation slice. */
  repeat?: { height: number; ops: Op[] }
  /** Space above the first line / below the last line that is part of `height` (paragraphs). Trailing space need not fit on the page. */
  spaceBefore?: number
  spaceAfter?: number
}

export interface LayoutContext {
  catalog: FontCatalog
  warnings: Warnings
  defaultTabStop: number
  /** Available height for a single block (used to scale images that would not fit on any page). */
  maxBlockHeight: number
  page?: number
  pages?: number
}

// ---------------------------------------------------------------------------------------------------
// Op helpers
// ---------------------------------------------------------------------------------------------------

export function shiftOps(ops: Op[], dx: number, dy: number): Op[] {
  if (!dx && !dy) return ops
  return ops.map((o): Op => {
    switch (o.t) {
      case 'text':
      case 'glyphs':
        return { ...o, x: o.x + dx, y: o.y + dy }
      case 'rect':
      case 'image':
      case 'link':
        return { ...o, x: o.x + dx, y: o.y + dy }
      case 'line':
        return { ...o, x1: o.x1 + dx, x2: o.x2 + dx, y1: o.y1 + dy, y2: o.y2 + dy }
      case 'path':
        return {
          ...o,
          d: o.d.map((s) => {
            if (s[0] === 'M' || s[0] === 'L') return [s[0], s[1] + dx, s[2] + dy] as typeof s
            if (s[0] === 'C') return ['C', s[1] + dx, s[2] + dy, s[3] + dx, s[4] + dy, s[5] + dx, s[6] + dy] as typeof s
            return s
          })
        }
      default:
        return o
    }
  })
}

const EPS = 0.01

/** The ops that fall in the vertical range [from, to), shifted so `from` becomes 0. */
export function sliceOps(ops: Op[], from: number, to: number): Op[] {
  const out: Op[] = []
  for (const o of ops) {
    switch (o.t) {
      case 'text':
      case 'glyphs':
        if (o.y >= from - EPS && o.y < to - EPS) out.push({ ...o, y: o.y - from })
        break
      case 'rect': {
        if (o.stroke) {
          if (o.y >= from - EPS && o.y < to - EPS) out.push({ ...o, y: o.y - from })
          break
        }
        const a = Math.max(o.y, from)
        const b = Math.min(o.y + o.h, to)
        if (b - a > EPS) out.push({ ...o, y: a - from, h: b - a })
        break
      }
      case 'line': {
        if (Math.abs(o.y1 - o.y2) < EPS) {
          const y = o.y1
          if (y >= from - EPS && y <= to + EPS) out.push({ ...o, y1: y - from, y2: y - from })
        } else {
          const lo = Math.min(o.y1, o.y2)
          const hi = Math.max(o.y1, o.y2)
          const a = Math.max(lo, from)
          const b = Math.min(hi, to)
          if (b - a > EPS) out.push({ ...o, y1: a - from, y2: b - from })
        }
        break
      }
      case 'image':
      case 'link':
        if (o.y >= from - EPS && o.y < to - EPS) out.push({ ...o, y: o.y - from })
        break
      case 'path':
        out.push(...shiftOps([o], 0, -from))
        break
      default:
        break
    }
  }
  return out
}

/** Splits a fragment at `at`: the part above stays, the rest (shifted up) is returned. */
export function splitFragment(f: Fragment, at: number): [Fragment, Fragment] {
  const head: Fragment = {
    height: at,
    ops: sliceOps(f.ops, 0, at),
    breaks: f.breaks.filter((b) => b < at - EPS),
    softBreaks: f.softBreaks?.filter((b) => b < at - EPS),
    floats: f.floats,
    keepNext: false,
    breakBefore: f.breakBefore,
    repeat: f.repeat,
    spaceBefore: f.spaceBefore,
    spaceAfter: 0
  }
  const tail: Fragment = {
    height: f.height - at,
    ops: sliceOps(f.ops, at, f.height + 1),
    breaks: f.breaks.filter((b) => b > at + EPS).map((b) => b - at),
    softBreaks: f.softBreaks?.filter((b) => b > at + EPS).map((b) => b - at),
    keepNext: f.keepNext,
    repeat: f.repeat,
    spaceBefore: 0,
    spaceAfter: f.spaceAfter
  }
  return [head, tail]
}

/** Stacks fragments vertically (used for table cells and headers/footers). */
export function stackFragments(frags: Fragment[]): Fragment {
  let y = 0
  const ops: Op[] = []
  const breaks: number[] = []
  const soft: number[] = []
  const floats: FloatSpec[] = []
  frags.forEach((f, i) => {
    if (i > 0 && y > 0) breaks.push(y)
    ops.push(...shiftOps(f.ops, 0, y))
    breaks.push(...f.breaks.map((b) => b + y))
    if (f.softBreaks) soft.push(...f.softBreaks.map((b) => b + y))
    if (f.floats) floats.push(...f.floats.map((fl) => ({ ...fl, vOffset: fl.vRel === 'paragraph' || fl.vRel === 'line' ? fl.vOffset + y : fl.vOffset })))
    y += f.height
  })
  return { height: y, ops, breaks, softBreaks: soft.length ? soft : undefined, floats: floats.length ? floats : undefined }
}

// ---------------------------------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------------------------------

interface Part {
  face: Face
  text: string
  /** Width in points. */
  w: number
}

interface Atom {
  k: 'word' | 'space' | 'tab' | 'br' | 'image'
  w: number
  style: TextStyle
  size: number
  asc: number
  desc: number
  parts?: Part[]
  link?: string
  brType?: 'line' | 'page' | 'column'
  image?: Extract<Inline, { k: 'image' }>
  /** x within the line (before alignment), set during line breaking. */
  x?: number
  /** Tab: leader character and target column. */
  leader?: TabStop['leader']
  /** Can a line break after this atom (words ending in a hyphen, CJK...). */
  breakAfter?: boolean
  /** Continues the previous atom without a break opportunity in between. */
  glue?: boolean
}

interface Line {
  atoms: Atom[]
  width: number
  asc: number
  desc: number
  /** Ended by a forced break (last line of paragraph or explicit line break): not justified. */
  hard: boolean
  /** x of the first atom (indent) */
  x0: number
  avail: number
  first: boolean
}

const CJK = /[⺀-鿿豈-﫿＀-￯぀-ヿ가-힯]/
const SUP_SCALE = 0.65

const strokeOf = (b: BorderSpec): Stroke => ({ color: b.color, width: b.width, dash: b.style === 'dashed' ? [b.width * 3, b.width * 2] : b.style === 'dotted' ? [b.width, b.width * 1.5] : undefined })

function effectiveSize(s: TextStyle): number {
  let size = s.size
  if (s.vertAlign) size *= SUP_SCALE
  if (s.smallCaps) size *= 0.85
  return size
}

function makeParts(ctx: LayoutContext, style: TextStyle, text: string): { parts: Part[]; w: number; size: number } {
  const size = effectiveSize(style)
  let t = text
  if (style.caps || style.smallCaps) t = t.toUpperCase()
  const face = ctx.catalog.face(style.family, style.bold, style.italic)
  const parts: Part[] = []
  let w = 0
  for (const seg of ctx.catalog.segment(face, t)) {
    const pw = ctx.catalog.measure(seg.face, seg.text) * size + (style.spacing ?? 0) * seg.text.length
    parts.push({ face: seg.face, text: seg.text, w: pw })
    w += pw
  }
  return { parts, w, size }
}

function metricsOf(ctx: LayoutContext, style: TextStyle): { asc: number; desc: number } {
  const size = effectiveSize(style)
  const m = ctx.catalog.metrics(ctx.catalog.face(style.family, style.bold, style.italic))
  return { asc: (m.ascent + m.lineGap) * size, desc: m.descent * size }
}

function toAtoms(ctx: LayoutContext, inlines: Inline[], atoms: Atom[], floats: FloatSpec[]): void {
  for (const il0 of inlines) {
    if (il0.k === 'text' && il0.style.cs) {
      // complex-script characters take the style's complex font/size/weight/posture
      const pieces = splitByScript(il0.text, { ...il0.style, cs: undefined }, complexStyleOf(il0.style))
      if (pieces.length > 1 || pieces[0]?.style !== il0.style) {
        toAtoms(ctx, pieces.map((p) => ({ ...il0, text: p.text, style: p.style })), atoms, floats)
        continue
      }
    }
    const il = il0
    switch (il.k) {
      case 'text': {
        const { asc, desc } = metricsOf(ctx, il.style)
        const size = effectiveSize(il.style)
        // Explicit tabs/newlines inside text become their own atoms.
        const pieces = il.text.split(/(\t|\r\n|\n|\r|\v|\f)/)
        for (const piece of pieces) {
          if (piece === '\t') atoms.push({ k: 'tab', w: 0, style: il.style, size, asc, desc })
          else if (piece === '\n' || piece === '\r\n' || piece === '\r' || piece === '\v') atoms.push({ k: 'br', w: 0, style: il.style, size, asc, desc, brType: 'line' })
          else if (piece === '\f') atoms.push({ k: 'br', w: 0, style: il.style, size, asc, desc, brType: 'page' })
          else if (piece) {
            for (const tok of piece.match(/ +|[^ ]+/g) ?? []) {
              if (tok[0] === ' ') {
                const sp = makeParts(ctx, il.style, ' ')
                for (let i = 0; i < tok.length; i++) atoms.push({ k: 'space', w: sp.w, style: il.style, size, asc, desc, parts: sp.parts, link: il.link })
              } else {
                // Break opportunities after hyphens and between CJK characters.
                const chunks: string[] = []
                let cur = ''
                const chars = Array.from(tok)
                for (let i = 0; i < chars.length; i++) {
                  const ch = chars[i]
                  cur += ch
                  const next = chars[i + 1]
                  if (next !== undefined && (CJK.test(ch) || (/[-–—]/.test(ch) && !/[-–—\s]/.test(next) && cur.length > 1))) {
                    chunks.push(cur)
                    cur = ''
                  }
                }
                if (cur) chunks.push(cur)
                chunks.forEach((c, ci) => {
                  const wp = makeParts(ctx, il.style, c)
                  const prev = atoms[atoms.length - 1]
                  // a word that continues the previous run without a space (bold "Hel" + plain "lo") must not be broken there
                  const glue = ci === 0 && !!prev && prev.k === 'word' && !prev.breakAfter
                  atoms.push({ k: 'word', w: wp.w, style: il.style, size: wp.size, asc, desc, parts: wp.parts, link: il.link, breakAfter: ci < chunks.length - 1, glue })
                })
              }
            }
          }
        }
        break
      }
      case 'tab': {
        const { asc, desc } = metricsOf(ctx, il.style)
        atoms.push({ k: 'tab', w: 0, style: il.style, size: effectiveSize(il.style), asc, desc })
        break
      }
      case 'br': {
        const { asc, desc } = metricsOf(ctx, il.style)
        atoms.push({ k: 'br', w: 0, style: il.style, size: effectiveSize(il.style), asc, desc, brType: il.type })
        break
      }
      case 'field': {
        const txt = String(il.field === 'page' ? (ctx.page ?? 1) : (ctx.pages ?? 1))
        toAtoms(ctx, [{ k: 'text', text: txt, style: il.style }], atoms, floats)
        break
      }
      case 'image': {
        const maxH = Math.max(20, ctx.maxBlockHeight)
        const k = il.h > maxH ? maxH / il.h : 1
        atoms.push({ k: 'image', w: il.w * k, style: il.style, size: il.h * k, asc: il.h * k, desc: 0, image: { ...il, w: il.w * k, h: il.h * k }, link: il.link })
        break
      }
      case 'float':
        floats.push(il.spec)
        break
    }
  }
}

function nextTabStop(curX: number, tabs: TabStop[], defaultTab: number, hanging: number | null): TabStop {
  const stops = [...tabs]
  if (hanging !== null) stops.push({ pos: hanging, align: 'left' })
  stops.sort((a, b) => a.pos - b.pos)
  for (const s of stops) if (s.pos > curX + 0.5) return s
  const last = stops.length ? stops[stops.length - 1].pos : 0
  const step = defaultTab > 1 ? defaultTab : 36
  const from = Math.max(curX, last)
  return { pos: (Math.floor(from / step + 1e-9) + 1) * step, align: 'left' }
}

interface ParaLayout {
  lines: Line[]
  /** Atom index at which a page/column break occurred (paragraph is split there), or -1. */
  pageBreakAfterLine: number[]
}

function breakLines(ctx: LayoutContext, atoms: Atom[], props: ParaProps, width: number): ParaLayout {
  const left = props.indentLeft
  const avail = Math.max(20, width - left - props.indentRight)
  const lines: Line[] = []
  const pageBreakAfterLine: number[] = []
  const hangingStop = props.firstLine < 0 ? 0 : null // text start when hanging (relative to `left`)
  let line: Line = { atoms: [], width: 0, asc: 0, desc: 0, hard: false, x0: 0, avail, first: true }
  let x = 0
  let pendingSpaces: Atom[] = []
  let pendingW = 0

  const newLine = (first: boolean): void => {
    const x0 = first ? props.firstLine : 0
    line = { atoms: [], width: 0, asc: 0, desc: 0, hard: false, x0, avail: avail - x0, first }
    x = 0
    pendingSpaces = []
    pendingW = 0
  }
  const finish = (hard: boolean): void => {
    line.hard = hard
    lines.push(line)
    newLine(false)
  }
  const place = (a: Atom): void => {
    a.x = x
    line.atoms.push(a)
    x += a.w
    line.width = x
    line.asc = Math.max(line.asc, a.asc)
    line.desc = Math.max(line.desc, a.desc)
  }
  newLine(true)

  let idx = 0
  while (idx < atoms.length) {
    const a = atoms[idx]
    if (a.k === 'br') {
      // keep the line's height for empty lines produced by breaks
      line.asc = Math.max(line.asc, a.asc)
      line.desc = Math.max(line.desc, a.desc)
      pendingSpaces = []
      pendingW = 0
      if (a.brType === 'line') finish(true)
      else {
        finish(true)
        pageBreakAfterLine.push(lines.length)
      }
      idx++
      continue
    }
    if (a.k === 'space') {
      if (line.atoms.length === 0 && !line.first) {
        idx++ // spaces at the start of a wrapped line vanish
        continue
      }
      pendingSpaces.push(a)
      pendingW += a.w
      idx++
      continue
    }
    if (a.k === 'tab') {
      // flush pending spaces first (they count before a tab)
      for (const s of pendingSpaces) place(s)
      pendingSpaces = []
      pendingW = 0
      const absX = left + line.x0 + x // container coordinates
      const stop = nextTabStop(absX, props.tabs, ctx.defaultTabStop, hangingStop === null ? null : left)
      // measure what follows up to the next tab/break for centre/right stops
      let segW = 0
      if (stop.align !== 'left') {
        for (let j = idx + 1; j < atoms.length; j++) {
          const b = atoms[j]
          if (b.k === 'tab' || b.k === 'br') break
          segW += b.w
        }
        if (stop.align === 'decimal') {
          // align the decimal point: measure up to the first '.' or ','
          segW = 0
          for (let j = idx + 1; j < atoms.length; j++) {
            const b = atoms[j]
            if (b.k === 'tab' || b.k === 'br') break
            const t = (b.parts ?? []).map((p) => p.text).join('')
            const dot = t.search(/[.,]/)
            if (dot >= 0) {
              segW += ctx.catalog.measure(b.parts![0].face, t.slice(0, dot)) * b.size
              break
            }
            segW += b.w
          }
        }
      }
      let target = stop.pos - left - line.x0 // relative to line start
      if (stop.align === 'center') target -= segW / 2
      else if (stop.align === 'right' || stop.align === 'decimal') target -= segW
      if (target < x) target = x
      if (target > line.avail + 0.5 && line.atoms.length > 0) {
        // tab beyond the right margin: continue on a new line
        finish(false)
        idx++
        continue
      }
      a.w = Math.max(0, target - x)
      a.leader = stop.leader
      place(a)
      idx++
      continue
    }
    // word or image; consecutive glued atoms form one unbreakable cluster
    let clusterEnd = idx + 1
    let clusterW = a.w
    while (clusterEnd < atoms.length && atoms[clusterEnd].glue && (atoms[clusterEnd].k === 'word' || atoms[clusterEnd].k === 'image')) {
      clusterW += atoms[clusterEnd].w
      clusterEnd++
    }
    if (x + clusterW + pendingW <= line.avail + 0.01) {
      for (const s of pendingSpaces) place(s)
      pendingSpaces = []
      pendingW = 0
      for (let j = idx; j < clusterEnd; j++) place(atoms[j])
      idx = clusterEnd
      continue
    }
    if (line.atoms.length > 0) {
      // wrap: the pending spaces are dropped at the end of this line
      finish(false)
      continue // retry the same atom on the fresh line
    }
    // A word wider than an empty line: split it by characters so no text is lost.
    if (a.k === 'word' && a.parts) {
      for (const s of pendingSpaces) place(s)
      pendingSpaces = []
      pendingW = 0
      const room = Math.max(line.avail - x, 1)
      const pieces = splitWord(ctx, a, room)
      if (pieces.length <= 1) {
        place(a)
        idx++
        continue
      }
      atoms.splice(idx, 1, ...pieces)
      continue
    }
    place(a) // an oversized image: place anyway
    idx++
  }
  // final line (may be empty for an empty paragraph)
  if (line.atoms.length > 0 || lines.length === 0 || pendingSpaces.length) {
    for (const s of pendingSpaces) place(s)
    finish(true)
  }
  return { lines, pageBreakAfterLine }
}

/** Splits an over-wide word into pieces that each fit `room` (except a single character that cannot). */
function splitWord(ctx: LayoutContext, a: Atom, room: number): Atom[] {
  const out: Atom[] = []
  let curParts: Part[] = []
  let curW = 0
  const flush = (): void => {
    if (curParts.length) out.push({ ...a, parts: curParts, w: curW, breakAfter: true })
    curParts = []
    curW = 0
  }
  for (const p of a.parts!) {
    for (const ch of Array.from(p.text)) {
      const cw = ctx.catalog.measure(p.face, ch) * a.size + (a.style.spacing ?? 0)
      if (curW + cw > room && curParts.length + curW > 0) flush()
      const last = curParts[curParts.length - 1]
      if (last && last.face.key === p.face.key) {
        last.text += ch
        last.w += cw
      } else curParts.push({ face: p.face, text: ch, w: cw })
      curW += cw
    }
  }
  if (curParts.length) out.push({ ...a, parts: curParts, w: curW, breakAfter: false })
  return out
}

export function paragraphFragments(ctx: LayoutContext, p: Paragraph, width: number): Fragment[] {
  const props = p.props
  const atoms: Atom[] = []
  const floats: FloatSpec[] = []
  if (props.marker) {
    const mk = props.marker
    const { parts, w, size } = makeParts(ctx, mk.style, mk.text)
    const { asc, desc } = metricsOf(ctx, mk.style)
    atoms.push({ k: 'word', w, style: mk.style, size, asc, desc, parts })
    atoms.push({ k: 'tab', w: 0, style: mk.style, size, asc, desc })
  }
  toAtoms(ctx, p.inlines, atoms, floats)

  const { lines, pageBreakAfterLine } = breakLines(ctx, atoms, props, width)
  const mark = metricsOf(ctx, p.markStyle)

  // Split into fragments at explicit page/column breaks.
  const groups: Line[][] = []
  let start = 0
  for (const at of pageBreakAfterLine) {
    if (at > start || groups.length === 0) groups.push(lines.slice(start, at))
    start = at
  }
  groups.push(lines.slice(start))
  const frags: Fragment[] = []
  const bands: Fragment[] = []
  const behind: FloatSpec[] = []
  for (const f of floats) {
    if (f.wrap === 'none') behind.push(f)
    else bands.push(imageBand(f, width, ctx))
  }
  groups.forEach((g, gi) => {
    if (g.length === 0 && gi > 0 && gi === groups.length - 1 && groups[gi - 1].length > 0) g = [emptyLine(mark)]
    if (g.length === 0) g = [emptyLine(mark)]
    const frag = buildParagraphFragment(ctx, props, g, width, mark, gi === 0, gi === groups.length - 1)
    if (gi > 0) frag.breakBefore = true
    if (gi === 0 && props.pageBreakBefore) frag.breakBefore = true
    frags.push(frag)
  })
  if (behind.length) frags[0].floats = behind
  if (bands.length) {
    const first = frags[0]
    for (const b of bands) b.keepNext = true
    if (first.breakBefore) {
      bands[0].breakBefore = true
      first.breakBefore = false
    }
    return [...bands, ...frags]
  }
  return frags
}

const emptyLine = (m: { asc: number; desc: number }): Line => ({ atoms: [], width: 0, asc: m.asc, desc: m.desc, hard: true, x0: 0, avail: 0, first: false })

function imageBand(f: FloatSpec, width: number, ctx: LayoutContext): Fragment {
  const k = f.h > ctx.maxBlockHeight ? ctx.maxBlockHeight / f.h : 1
  const w = f.w * k
  const h = f.h * k
  const x = f.hAlign === 'center' ? (width - w) / 2 : f.hAlign === 'right' ? width - w : Math.max(0, Math.min(f.hOffset, width - w))
  return { height: h + 4, ops: [{ t: 'image', x, y: 0, w, h, image: f.image, crop: f.crop }], breaks: [] }
}

function buildParagraphFragment(ctx: LayoutContext, props: ParaProps, lines: Line[], width: number, mark: { asc: number; desc: number }, first: boolean, last: boolean): Fragment {
  const ops: Op[] = []
  const breaks: number[] = []
  const before = first ? props.spaceBefore : 0
  const after = last ? props.spaceAfter : 0
  let y = before
  const left = props.indentLeft
  const rightEdge = width - props.indentRight

  const heights: number[] = []
  for (const ln of lines) {
    const asc = Math.max(ln.asc, ln.atoms.length ? 0 : mark.asc)
    const desc = Math.max(ln.desc, ln.atoms.length ? 0 : mark.desc)
    const natural = asc + desc
    let h: number
    if (props.line.rule === 'exact') h = props.line.value
    else if (props.line.rule === 'atLeast') h = Math.max(props.line.value, natural)
    else h = natural * props.line.value
    heights.push(h)
    ln.asc = asc
    ln.desc = desc
  }

  // shading behind the whole paragraph body
  const bodyTop = before
  const bodyHeight = heights.reduce((s, h) => s + h, 0)
  if (props.shading) ops.push({ t: 'rect', x: left, y: bodyTop, w: Math.max(0, rightEdge - left), h: bodyHeight, fill: props.shading })

  lines.forEach((ln, li) => {
    const h = heights[li]
    const baseline = y + h - ln.desc
    emitLine(ctx, ops, ln, props, left, width, baseline)
    y += h
    if (li < lines.length - 1) breaks.push(y)
  })

  const b = props.borders
  if (b) {
    const x1 = left
    const x2 = rightEdge
    if (b.top) ops.push({ t: 'line', x1, x2, y1: bodyTop, y2: bodyTop, stroke: strokeOf(b.top) })
    if (b.bottom) ops.push({ t: 'line', x1, x2, y1: bodyTop + bodyHeight, y2: bodyTop + bodyHeight, stroke: strokeOf(b.bottom) })
    if (b.left) ops.push({ t: 'line', x1, x2: x1, y1: bodyTop, y2: bodyTop + bodyHeight, stroke: strokeOf(b.left) })
    if (b.right) ops.push({ t: 'line', x1: x2, x2, y1: bodyTop, y2: bodyTop + bodyHeight, stroke: strokeOf(b.right) })
  }

  const n = lines.length
  let allowed = breaks
  if (props.keepLines) allowed = []
  else if (props.widowControl && n >= 2) {
    if (n < 4) allowed = []
    else allowed = breaks.filter((_, i) => i + 1 >= 2 && n - (i + 1) >= 2)
  }
  return { height: y + after, ops, breaks: allowed, keepNext: props.keepNext, spaceBefore: before, spaceAfter: after }
}

const LEADER_CHAR: Record<NonNullable<TabStop['leader']>, string> = { dot: '.', hyphen: '-', underscore: '_', middleDot: '·' }

/**
 * Draws one line. Coordinates are computed from the paragraph's START edge (left for left-to-right paragraphs, right
 * for right-to-left ones: indents, tab stops, the list marker and alignment are logical) and mirrored for
 * right-to-left paragraphs. Each part between two tabs is shaped and reordered as a whole (textline.ts), so runs of
 * different styles, directions and scripts end up in the right visual order; all parts of the line are written as
 * one text object with one /ActualText span.
 */
function emitLine(ctx: LayoutContext, ops: Op[], ln: Line, props: ParaProps, left: number, width: number, baseline: number): void {
  const atoms = ln.atoms
  if (atoms.length === 0) return
  let lastIdx = atoms.length - 1
  while (lastIdx >= 0 && atoms[lastIdx].k === 'space') lastIdx-- // trailing spaces hang: no alignment, no drawing
  if (lastIdx < 0) return
  const rtl = !!props.rtl
  const avail = ln.avail

  // parts between tabs, in logical order
  interface Seg {
    from: number
    to: number
    x: number
  }
  const segs: Seg[] = []
  const tabs: Atom[] = []
  let cur: Seg | null = null
  for (let i = 0; i <= lastIdx; i++) {
    const a = atoms[i]
    if (a.k === 'tab') {
      if (cur) segs.push(cur)
      cur = null
      tabs.push(a)
      continue
    }
    if (a.k === 'br') continue
    if (!cur) cur = { from: i, to: i + 1, x: a.x ?? 0 }
    else cur.to = i + 1
  }
  if (cur) segs.push(cur)
  const justify = props.align === 'justify' && !ln.hard

  const styleOf = (a: Atom, face: Face): DrawStyle => {
    const st = a.style
    const rise = st.vertAlign === 'super' ? st.size * 0.33 : st.vertAlign === 'sub' ? -st.size * 0.14 : 0
    return { face, size: a.size, color: st.color, rise, letterSpacing: st.spacing }
  }
  const shaped: { seg: Seg; line: ShapedLine; atomOf: number[]; x: number }[] = []
  let prevEnd = 0
  segs.forEach((seg, si) => {
    const items: LineItem[] = []
    const atomOf: number[] = []
    for (let i = seg.from; i < seg.to; i++) {
      const a = atoms[i]
      if (a.k === 'image') {
        items.push({ text: '', style: styleOf(a, ctx.catalog.face(a.style.family, a.style.bold, a.style.italic)), gap: a.w })
        atomOf.push(i)
      } else if (a.k === 'word' || a.k === 'space') {
        for (const p of a.parts ?? []) {
          items.push({ text: p.text, style: styleOf(a, p.face) })
          atomOf.push(i)
        }
      }
    }
    const x = Math.max(seg.x, prevEnd)
    const target = justify && si === segs.length - 1 ? Math.max(0, avail - x) : undefined
    const line = shapeLine(ctx.catalog, items, rtl ? 'rtl' : 'ltr', target)
    shaped.push({ seg, line, atomOf, x })
    prevEnd = x + line.width
  })
  const contentW = prevEnd
  let shift = 0
  if (props.align === 'center') shift = Math.max(0, (avail - contentW) / 2)
  else if (props.align === 'right') shift = Math.max(0, avail - contentW)
  // start-relative x -> physical x of the left edge of something `w` wide
  const phys = (xs: number, w: number): number => {
    const l = left + ln.x0 + shift + xs
    return rtl ? width - l - w : l
  }

  const behind: Op[] = []
  const front: Op[] = []
  const links: { x: number; w: number; url: string }[] = []
  const parts: { line: ShapedLine; x: number }[] = []
  for (const s of shaped) {
    const segLeft = phys(s.x, s.line.width)
    parts.push({ line: s.line, x: segLeft })
    s.line.items.forEach((it, k) => {
      const a = atoms[s.atomOf[k]!]
      const st = a.style
      for (const pc of it.pieces) {
        const x = segLeft + pc.x
        if (a.k === 'image') {
          const im = a.image!
          front.push({ t: 'image', x, y: baseline - im.h, w: im.w, h: im.h, image: im.image, crop: im.crop })
          if (a.link) front.push({ t: 'link', x, y: baseline - im.h, w: im.w, h: im.h, url: a.link })
          continue
        }
        if (st.highlight) behind.push({ t: 'rect', x, y: baseline - ln.asc, w: pc.w, h: ln.asc + ln.desc, fill: st.highlight })
        if (st.underline) {
          const uy = baseline + a.size * 0.12
          front.push({ t: 'line', x1: x, x2: x + pc.w, y1: uy, y2: uy, stroke: { color: st.color, width: Math.max(0.5, a.size / 18) } })
        }
        if (st.strike) {
          const sy = baseline - a.size * 0.28
          front.push({ t: 'line', x1: x, x2: x + pc.w, y1: sy, y2: sy, stroke: { color: st.color, width: Math.max(0.5, a.size / 20) } })
        }
        if (a.link) links.push({ x, w: pc.w, url: a.link })
      }
    })
  }
  // one link annotation per visually contiguous stretch of the same target
  links.sort((p, q) => p.x - q.x)
  for (let i = 0; i < links.length; ) {
    let j = i + 1
    let x2 = links[i]!.x + links[i]!.w
    while (j < links.length && links[j]!.url === links[i]!.url && links[j]!.x <= x2 + 0.5) {
      x2 = Math.max(x2, links[j]!.x + links[j]!.w)
      j++
    }
    front.push({ t: 'link', x: links[i]!.x, y: baseline - ln.asc, w: x2 - links[i]!.x, h: ln.asc + ln.desc, url: links[i]!.url })
    i = j
  }
  // tab leaders fill the gap before the text that follows the tab
  for (const t of tabs) {
    if (!t.leader || t.w <= 2) continue
    const ch = LEADER_CHAR[t.leader]
    const face = ctx.catalog.face(t.style.family, false, false)
    const cw = ctx.catalog.measure(face, ch) * t.size
    const n = cw > 0 ? Math.floor((t.w - 2) / cw) : 0
    if (n <= 0) continue
    const w = n * cw
    const xs = (t.x ?? 0) + t.w - w
    front.push({ t: 'text', x: phys(xs, w), y: baseline, text: ch.repeat(n), face, size: t.size, color: t.style.color })
  }
  ops.push(...behind)
  const op = joinSegments(parts, baseline, rtl)
  if (op) ops.push(op)
  ops.push(...front)
}

// ---------------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------------

interface CellLayout {
  cell: Cell
  row: number
  col: number
  colSpan: number
  rowSpan: number
  width: number
  frag: Fragment
  pad: { top: number; right: number; bottom: number; left: number }
}

export function blocksToFragments(ctx: LayoutContext, blocks: Block[], width: number): Fragment[] {
  const out: Fragment[] = []
  for (const b of blocks) {
    if (b.k === 'p') out.push(...paragraphFragments(ctx, b, width))
    else out.push(...tableFragments(ctx, b, width))
  }
  return out
}

/** Vertical space of a fragment stack for cell content. Empty cells still get one empty line's height. */
function cellContent(ctx: LayoutContext, cell: Cell, width: number): Fragment {
  const inner = blocksToFragments(ctx, cell.blocks, Math.max(10, width))
  return stackFragments(inner)
}

export function tableFragments(ctx: LayoutContext, t: Table, avail: number): Fragment[] {
  const nCols = Math.max(1, t.colWidths.length)
  let widths = t.colWidths.length ? [...t.colWidths] : [avail]
  const total = widths.reduce((s, w) => s + w, 0)
  const maxW = Math.max(20, avail - t.indent)
  if (total > maxW + 0.5) widths = widths.map((w) => (w * maxW) / total)
  const colX: number[] = [0]
  for (const w of widths) colX.push(colX[colX.length - 1] + w)
  const tableW = colX[nCols]
  // Right-to-left tables (Word's bidiVisual, ODF rl-tb, RTF \rtlrow): the first column is on the right and the
  // alignment/indent are measured from the right edge. The grid is computed left to right and mirrored by `gx`.
  const rtl = !!t.rtl
  const logicalStart = (t.align === 'center' ? (avail - tableW) / 2 : t.align === 'right' ? avail - tableW : t.indent) || 0
  const startX = rtl ? avail - tableW - logicalStart : logicalStart
  /** Physical x of the grid line at logical offset `x` (from the table's start edge). */
  const gx = (x: number): number => (rtl ? startX + tableW - x : startX + x)
  /** Physical left edge of the logical range [a, b]. */
  const gl = (a: number, b: number): number => (rtl ? gx(b) : gx(a))

  // Lay out every cell.
  const rows = t.rows
  const R = rows.length
  const layouts: CellLayout[] = []
  // grid occupancy for row spans
  const occupied: boolean[][] = Array.from({ length: R }, () => Array<boolean>(nCols).fill(false))
  rows.forEach((row, r) => {
    let c = 0
    for (const cell of row.cells) {
      while (c < nCols && occupied[r][c]) c++
      const span = Math.max(1, Math.min(cell.colSpan, nCols - c))
      const rspan = Math.max(1, Math.min(cell.rowSpan, R - r))
      for (let rr = r; rr < r + rspan; rr++) for (let cc = c; cc < c + span; cc++) if (rr < R && cc < nCols) occupied[rr][cc] = true
      const pad = cell.padding ?? t.padding
      const w = colX[Math.min(nCols, c + span)] - colX[c]
      const frag = cellContent(ctx, cell, w - pad.left - pad.right)
      layouts.push({ cell, row: r, col: c, colSpan: span, rowSpan: rspan, width: w, frag, pad })
      c += span
    }
  })

  // Row heights.
  const rowH = Array<number>(R).fill(0)
  rows.forEach((row, r) => {
    if (row.height) rowH[r] = row.height.value
  })
  for (const cl of layouts) {
    if (cl.rowSpan === 1) {
      const need = cl.frag.height + cl.pad.top + cl.pad.bottom
      const r = rows[cl.row]
      rowH[cl.row] = r.height?.rule === 'exact' ? r.height.value : Math.max(rowH[cl.row], need)
    }
  }
  for (const cl of layouts) {
    if (cl.rowSpan > 1) {
      const need = cl.frag.height + cl.pad.top + cl.pad.bottom
      let have = 0
      for (let r = cl.row; r < cl.row + cl.rowSpan; r++) have += rowH[r]
      if (need > have) rowH[cl.row + cl.rowSpan - 1] += need - have
    }
  }
  const rowY: number[] = [0]
  for (const h of rowH) rowY.push(rowY[rowY.length - 1] + h)

  // Edge grids for borders.
  type Edge = BorderSpec | null | undefined
  const H: Edge[][] = Array.from({ length: R + 1 }, () => Array<Edge>(nCols).fill(undefined))
  const V: Edge[][] = Array.from({ length: R }, () => Array<Edge>(nCols + 1).fill(undefined))
  const setEdge = (arr: Edge[], i: number, b: Edge): void => {
    if (b === undefined) return
    const cur = arr[i]
    if (b === null) {
      if (cur === undefined) arr[i] = null
      return
    }
    if (!cur || b.width >= cur.width) arr[i] = b
  }
  for (let r = 0; r <= R; r++) for (let c = 0; c < nCols; c++) H[r][c] = r === 0 ? t.borders.top : r === R ? t.borders.bottom : t.borders.insideH
  for (let r = 0; r < R; r++) for (let c = 0; c <= nCols; c++) V[r][c] = c === 0 ? t.borders.left : c === nCols ? t.borders.right : t.borders.insideV
  // Cell borders override the table's; where two neighbouring cells both specify the shared edge, the visible /
  // wider one wins (a bottom border of one cell must not be erased by the "none" of the cell below it).
  const hSet = new Set<string>()
  const vSet = new Set<string>()
  const assign = (arr: Edge[], seen: Set<string>, key: string, i: number, b: Edge): void => {
    if (b === undefined) return
    if (!seen.has(key)) {
      seen.add(key)
      arr[i] = b
      return
    }
    setEdge(arr, i, b)
  }
  for (const cl of layouts) {
    const b = cl.cell.borders
    if (!b) continue
    for (let c = cl.col; c < cl.col + cl.colSpan; c++) {
      assign(H[cl.row], hSet, `${cl.row}:${c}`, c, b.top)
      assign(H[cl.row + cl.rowSpan], hSet, `${cl.row + cl.rowSpan}:${c}`, c, b.bottom)
    }
    for (let r = cl.row; r < cl.row + cl.rowSpan; r++) {
      assign(V[r], vSet, `${r}:${cl.col}`, cl.col, b.left)
      assign(V[r], vSet, `${r}:${cl.col + cl.colSpan}`, cl.col + cl.colSpan, b.right)
    }
  }

  // Build ops.
  const ops: Op[] = []
  const breaks: number[] = []
  const soft: number[] = []
  const cellLeft = (cl: CellLayout): number => gl(colX[cl.col], colX[Math.min(nCols, cl.col + cl.colSpan)])
  for (const cl of layouts) {
    const x = cellLeft(cl)
    const y = rowY[cl.row]
    const h = rowY[cl.row + cl.rowSpan] - y
    if (cl.cell.shading) ops.push({ t: 'rect', x, y, w: cl.width, h, fill: cl.cell.shading })
  }
  for (const cl of layouts) {
    // cell margins are logical too: the start margin is on the right in a right-to-left table
    const x = cellLeft(cl) + (rtl ? cl.pad.right : cl.pad.left)
    const y = rowY[cl.row]
    const h = rowY[cl.row + cl.rowSpan] - y
    const inner = h - cl.pad.top - cl.pad.bottom
    const dy = cl.cell.vAlign === 'center' ? Math.max(0, (inner - cl.frag.height) / 2) : cl.cell.vAlign === 'bottom' ? Math.max(0, inner - cl.frag.height) : 0
    ops.push(...shiftOps(cl.frag.ops, x, y + cl.pad.top + dy))
  }
  // A row may be split between two lines of its text (as Word/LibreOffice do), but only where EVERY cell of the
  // row has a line boundary (or has already ended), so no line is cut in half. Rows touched by a row-spanning cell,
  // rows with an exact height and "can't split" rows are never split.
  const spanned = new Set<number>()
  for (const cl of layouts) if (cl.rowSpan > 1) for (let r = cl.row; r < cl.row + cl.rowSpan; r++) spanned.add(r)
  const byRow: CellLayout[][] = Array.from({ length: R }, () => [])
  for (const cl of layouts) byRow[cl.row].push(cl)
  for (let r = 0; r < R; r++) {
    if (spanned.has(r) || rows[r].cantSplit || rows[r].height?.rule === 'exact' || byRow[r].length === 0) continue
    const info = byRow[r].map((cl) => {
      const h = rowY[r + 1] - rowY[r]
      const inner = h - cl.pad.top - cl.pad.bottom
      const dy = cl.cell.vAlign === 'center' ? Math.max(0, (inner - cl.frag.height) / 2) : cl.cell.vAlign === 'bottom' ? Math.max(0, inner - cl.frag.height) : 0
      const top = rowY[r] + cl.pad.top + dy
      return { end: top + cl.frag.height, lines: cl.frag.breaks.map((b) => top + b) }
    })
    const cand = new Set<number>()
    for (const ci of info) for (const y of ci.lines) cand.add(Math.round(y * 100) / 100)
    for (const y of cand) {
      if (y <= rowY[r] + 0.5 || y >= rowY[r + 1] - 0.5) continue
      if (info.every((ci) => y >= ci.end - 0.01 || ci.lines.some((l) => Math.abs(l - y) < 0.02))) soft.push(y)
    }
  }
  // horizontal edges, merged across equal neighbours
  for (let r = 0; r <= R; r++) {
    let c = 0
    while (c < nCols) {
      const e = H[r][c]
      if (!e) {
        c++
        continue
      }
      let c2 = c + 1
      while (c2 < nCols && H[r][c2] && sameBorder(H[r][c2]!, e)) c2++
      pushEdgeLine(ops, e, gl(colX[c], colX[c2]), rowY[r], gl(colX[c], colX[c2]) + colX[c2] - colX[c], rowY[r])
      c = c2
    }
  }
  for (let r = 0; r < R; r++) {
    for (let c = 0; c <= nCols; c++) {
      const e = V[r][c]
      if (e) pushEdgeLine(ops, e, gx(colX[c]), rowY[r], gx(colX[c]), rowY[r + 1])
    }
  }
  for (let r = 1; r < R; r++) breaks.push(rowY[r])

  // Repeating header rows: leading rows flagged as headers.
  let headerRows = 0
  while (headerRows < R && rows[headerRows].header) headerRows++
  const height = rowY[R]
  const frag: Fragment = { height, ops, breaks: breaks.filter((b) => b > EPS && b < height - EPS), softBreaks: soft.filter((b) => b > EPS && b < height - EPS && !breaks.includes(b)) }
  if (frag.softBreaks && frag.softBreaks.length === 0) frag.softBreaks = undefined
  if (headerRows > 0 && headerRows < R) {
    const hh = rowY[headerRows]
    frag.repeat = { height: hh, ops: sliceOps(ops, 0, hh).filter((o) => !(o.t === 'line' && Math.abs(o.y1 - o.y2) < EPS && o.y1 > hh - EPS && false)) }
    frag.breaks = frag.breaks.filter((b) => b > hh + EPS)
  }
  return [frag]
}

const sameBorder = (a: BorderSpec, b: BorderSpec): boolean => a.color === b.color && a.width === b.width && a.style === b.style

function pushEdgeLine(ops: Op[], b: BorderSpec, x1: number, y1: number, x2: number, y2: number): void {
  if (b.style === 'double') {
    const g = Math.max(1.2, b.width * 1.2)
    const w = Math.max(0.4, b.width / 2)
    const horizontal = Math.abs(y1 - y2) < EPS
    const s: Stroke = { color: b.color, width: w }
    if (horizontal) {
      ops.push({ t: 'line', x1, x2, y1: y1 - g / 2, y2: y2 - g / 2, stroke: s }, { t: 'line', x1, x2, y1: y1 + g / 2, y2: y2 + g / 2, stroke: s })
    } else {
      ops.push({ t: 'line', x1: x1 - g / 2, x2: x2 - g / 2, y1, y2, stroke: s }, { t: 'line', x1: x1 + g / 2, x2: x2 + g / 2, y1, y2, stroke: s })
    }
    return
  }
  ops.push({ t: 'line', x1, y1, x2, y2, stroke: strokeOf(b) })
}
