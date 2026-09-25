import { exportValueFor, nameFor } from './names'
import type { HLine, PageContent, Phrase, ShapeCircle, ShapeRect, VLine } from './pageContent'
import type { Box } from './frame'

/**
 * Automatic field detection on flat (non-fillable) pages. Works only from what the page really contains:
 * text phrases, rules, rectangles and circles (see `pageContent.ts`). Every proposal carries a confidence
 * (0..1) that says how sure the heuristics are, the printed label it was derived from, and a reason. Scanned
 * pages (a picture with no text or lines to analyse) are reported as such; nothing is guessed there.
 * Pure TypeScript, unit-tested on generated flat forms with precision/recall assertions.
 */

export type DetectKind = 'text' | 'checkbox' | 'radio' | 'comb' | 'date' | 'signature'

export interface RadioButton {
  /** Visual-frame rectangle of the button. */
  rect: Box
  value: string
  label?: string
}

export interface Proposal {
  id: string
  pageIndex: number
  kind: DetectKind
  /** Visual-frame rectangle (y up). For radio groups: the union of the buttons. */
  rect: Box
  confidence: number
  label?: string
  /** Suggested (valid, unique) field name; for radio groups the group name. */
  name: string
  reason: string
  multiline?: boolean
  /** Comb fields: number of cells. */
  cells?: number
  /** Date fields: the format the label hints at, or a default. */
  dateFormat?: string
  buttons?: RadioButton[]
}

export type PageStatus = 'ok' | 'scanned' | 'empty'

export interface DetectResult {
  pageIndex: number
  status: PageStatus
  /** A sentence for the user when the page could not be analysed (or was only partly readable). */
  note?: string
  proposals: Proposal[]
}

// ---------------------------------------------------------------------------------------------------------
// geometry helpers

const w = (b: Box): number => b.x1 - b.x0
const h = (b: Box): number => b.y1 - b.y0
const area = (b: Box): number => Math.max(0, w(b)) * Math.max(0, h(b))
const inter = (a: Box, b: Box): number => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
const iou = (a: Box, b: Box): number => {
  const i = inter(a, b)
  return i / (area(a) + area(b) - i || 1)
}
const union = (bs: Box[]): Box => ({
  x0: Math.min(...bs.map((b) => b.x0)),
  y0: Math.min(...bs.map((b) => b.y0)),
  x1: Math.max(...bs.map((b) => b.x1)),
  y1: Math.max(...bs.map((b) => b.y1))
})
const cx = (b: Box): number => (b.x0 + b.x1) / 2
const cy = (b: Box): number => (b.y0 + b.y1) / 2
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const round = (n: number): number => Math.round(n * 100) / 100

// ---------------------------------------------------------------------------------------------------------
// label semantics

const DATE_RE = /\b(date|dob|d\.o\.b\.?|birth\s?day|born|expir(?:y|es|ation)|issued|dd\s*[/.-]\s*mm|mm\s*[/.-]\s*dd|yyyy)\b/i
const SIGNATURE_RE = /\b(signature|sign\s+here|signed\s+by|signed:|signatory)\b/i
const YES_NO_RE = /^(yes|no|n\/a|male|female|other|m|f)$/i

export function dateFormatHint(text: string): string | undefined {
  const t = text.toLowerCase()
  if (/mm\s*[/.-]\s*dd\s*[/.-]\s*yy/.test(t)) return /yyyy/.test(t) ? 'mm/dd/yyyy' : 'mm/dd/yy'
  if (/dd\s*[/.-]\s*mm\s*[/.-]\s*yy/.test(t)) return /yyyy/.test(t) ? 'dd/mm/yyyy' : 'dd/mm/yy'
  if (/yyyy\s*[/.-]\s*mm\s*[/.-]\s*dd/.test(t)) return 'yyyy-mm-dd'
  return undefined
}

// ---------------------------------------------------------------------------------------------------------
// grid faces: rectangles bounded by rules

interface Seg {
  at: number
  a0: number
  a1: number
}

function cluster(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  let group: number[] = []
  for (const v of sorted) {
    if (group.length && v - group[group.length - 1] > tol) {
      out.push(group.reduce((s, x) => s + x, 0) / group.length)
      group = []
    }
    group.push(v)
  }
  if (group.length) out.push(group.reduce((s, x) => s + x, 0) / group.length)
  return out
}

function nearestIndex(sorted: number[], v: number, tol: number): number {
  let best = -1
  let bd = tol
  for (let i = 0; i < sorted.length; i++) {
    const d = Math.abs(sorted[i] - v)
    if (d <= bd) {
      bd = d
      best = i
    }
  }
  return best
}

/** Is [from, to] covered (>= 92%) by the union of these intervals? */
function covered(intervals: [number, number][] | undefined, from: number, to: number): boolean {
  if (!intervals || to - from <= 0) return false
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let cov = 0
  let cur = from
  for (const [a, b] of sorted) {
    const lo = Math.max(a, cur, from)
    const hi = Math.min(b, to)
    if (hi > lo) {
      cov += hi - lo
      cur = hi
    }
  }
  return cov >= 0.92 * (to - from)
}

/** Faces of every connected group of rules (a page may hold several unrelated tables and boxes). */
function findFaces(hs: Seg[], vs: Seg[]): Box[] {
  const n = hs.length + vs.length
  if (n === 0) return []
  if (n > 4000) return []
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const T = 2
  hs.forEach((a, i) => {
    vs.forEach((b, j) => {
      if (b.at >= a.a0 - T && b.at <= a.a1 + T && a.at >= b.a0 - T && a.at <= b.a1 + T) parent[find(i)] = find(hs.length + j)
    })
  })
  const groups = new Map<number, { hs: Seg[]; vs: Seg[] }>()
  hs.forEach((s, i) => {
    const k = find(i)
    const g = groups.get(k) ?? { hs: [], vs: [] }
    g.hs.push(s)
    groups.set(k, g)
  })
  vs.forEach((s, j) => {
    const k = find(hs.length + j)
    const g = groups.get(k) ?? { hs: [], vs: [] }
    g.vs.push(s)
    groups.set(k, g)
  })
  const out: Box[] = []
  for (const g of groups.values()) if (g.hs.length >= 2 && g.vs.length >= 2) out.push(...facesOf(g.hs, g.vs))
  return out
}

function facesOf(hs: Seg[], vs: Seg[]): Box[] {
  const ys = cluster(hs.map((s) => s.at), 1.2)
  const xs = cluster(vs.map((s) => s.at), 1.2)
  if (ys.length < 2 || xs.length < 2 || ys.length > 160 || xs.length > 160) return []
  const hBy: [number, number][][] = ys.map(() => [])
  const vBy: [number, number][][] = xs.map(() => [])
  for (const s of hs) {
    const i = nearestIndex(ys, s.at, 1.5)
    if (i >= 0) hBy[i].push([s.a0 - 0.8, s.a1 + 0.8])
  }
  for (const s of vs) {
    const i = nearestIndex(xs, s.at, 1.5)
    if (i >= 0) vBy[i].push([s.a0 - 0.8, s.a1 + 0.8])
  }
  const faces: Box[] = []
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const x0 = xs[i]
      const x1 = xs[i + 1]
      const y0 = ys[j]
      const y1 = ys[j + 1]
      if (x1 - x0 < 5 || y1 - y0 < 5) continue
      if (covered(hBy[j], x0, x1) && covered(hBy[j + 1], x0, x1) && covered(vBy[i], y0, y1) && covered(vBy[i + 1], y0, y1)) faces.push({ x0, y0, x1, y1 })
    }
  }
  return faces
}

// ---------------------------------------------------------------------------------------------------------

interface Cell extends Box {
  blank: boolean
  texts: Phrase[]
}

interface Label {
  text: string
  dir: 'left' | 'above' | 'below' | 'inside' | 'cell' | 'header'
  phrase?: Phrase
}

const centerIn = (p: Box, b: Box, inset = 0.5): boolean => cx(p) > b.x0 + inset && cx(p) < b.x1 - inset && cy(p) > b.y0 + inset && cy(p) < b.y1 - inset

class Detector {
  private seq = 0
  readonly proposals: Proposal[] = []

  constructor(private readonly pc: PageContent) {}

  private id(): string {
    return `p${this.pc.pageIndex}-${++this.seq}`
  }

  private add(p: Omit<Proposal, 'id' | 'pageIndex' | 'name'> & { name?: string }): void {
    this.proposals.push({ ...p, id: this.id(), pageIndex: this.pc.pageIndex, name: p.name ?? '', confidence: round(clamp(p.confidence, 0, 1)) })
  }

  // ----- label search

  /** Phrases whose centre is inside `b`. */
  private phrasesIn(b: Box): Phrase[] {
    return this.pc.phrases.filter((p) => centerIn(p, b, 0.3))
  }

  private leaderIn(b: Box): boolean {
    return this.pc.leaders.some((l) => centerIn({ x0: l.x0, x1: l.x1, y0: l.y0, y1: l.y1 }, b, 0.3))
  }

  private separatedByRule(x0: number, x1: number, y0: number, y1: number): boolean {
    return this.pc.vlines.some((v) => v.x > x0 + 1 && v.x < x1 - 1 && Math.min(v.y1, y1) - Math.max(v.y0, y0) > 0.5 * (y1 - y0))
  }

  private labelLeft(r: Box, maxGap = 70): Phrase | undefined {
    let best: Phrase | undefined
    let bestGap = Infinity
    for (const p of this.pc.phrases) {
      if (p.x1 > r.x0 + 3) continue
      const gap = r.x0 - p.x1
      if (gap > maxGap) continue
      const ov = Math.min(p.y1, r.y1) - Math.max(p.y0, r.y0)
      if (ov < 0.45 * (p.y1 - p.y0)) continue
      if (this.separatedByRule(p.x1, r.x0, r.y0, r.y1)) continue
      if (gap < bestGap) {
        best = p
        bestGap = gap
      }
    }
    return best
  }

  private labelAbove(r: Box, maxGap = 16): Phrase | undefined {
    let best: Phrase | undefined
    let bestGap = Infinity
    for (const p of this.pc.phrases) {
      const gap = p.y0 - r.y1
      if (gap < -1.5 || gap > maxGap) continue
      // Aligned with the field: it starts within the field's width (or just left of it).
      if (p.x0 < r.x0 - 12 || p.x0 > r.x1 - 4) continue
      if (gap < bestGap) {
        best = p
        bestGap = gap
      }
    }
    return best
  }

  private labelBelow(r: Box, maxGap = 14): Phrase | undefined {
    let best: Phrase | undefined
    let bestGap = Infinity
    for (const p of this.pc.phrases) {
      const gap = r.y0 - p.y1
      if (gap < -1.5 || gap > maxGap) continue
      if (Math.min(p.x1, r.x1) - Math.max(p.x0, r.x0) < 0.3 * (p.x1 - p.x0)) continue
      if (gap < bestGap) {
        best = p
        bestGap = gap
      }
    }
    return best
  }

  private textLabel(text: string | undefined, kind: DetectKind): { kind: DetectKind; dateFormat?: string } {
    if (text && kind === 'text') {
      if (SIGNATURE_RE.test(text)) return { kind: 'signature' }
      if (DATE_RE.test(text)) return { kind: 'date', dateFormat: dateFormatHint(text) ?? 'dd/mm/yyyy' }
    }
    return { kind }
  }

  // ----- emitting text-like proposals

  private emitText(rect: Box, base: number, label: Label | undefined, reason: string, opts: { multiline?: boolean; dateLike?: boolean; hint?: string } = {}): void {
    const text = label?.text
    let { kind, dateFormat } = this.textLabel(text, 'text')
    if (kind === 'text' && opts.dateLike) {
      kind = 'date'
      dateFormat = 'dd/mm/yyyy'
    }
    if (kind === 'text' && opts.hint) {
      const f = dateFormatHint(opts.hint)
      if (f) {
        kind = 'date'
        dateFormat = f
      }
    }
    let confidence = base
    if (text && text.length > 70) confidence -= 0.2
    if (!text) confidence = Math.min(confidence, 0.4)
    this.add({
      kind,
      rect,
      confidence,
      label: text,
      reason: label ? `${reason}; label “${text}” (${label.dir})` : `${reason}; no label found`,
      multiline: opts.multiline || undefined,
      dateFormat
    })
  }

  // ----- the passes

  run(): void {
    const pc = this.pc
    const consumedRects = new Set<ShapeRect>()

    // Rectangles that count as visible boxes: stroked (not white) or lightly shaded.
    const visibleRects = pc.rects.filter((r) => (r.stroke && r.strokeLuma < 0.95 && r.width > 0) || (!r.stroke && r.fill && r.fillLuma >= 0.5 && r.fillLuma < 0.98))

    // 1. Rectangles subdivided by tick marks into equal cells: comb fields.
    const consumedV = new Set<VLine>()
    for (const r of visibleRects) {
      if (!r.stroke || w(r) < 36 || h(r) < 9 || h(r) > 40 || !this.blank(r)) continue
      const inner = pc.vlines.filter((v) => v.x > r.x0 + 1.5 && v.x < r.x1 - 1.5 && v.y0 >= r.y0 - 2 && v.y1 <= r.y1 + 2 && v.y1 - v.y0 >= 0.28 * h(r) && (Math.abs(v.y0 - r.y0) < 2 || Math.abs(v.y1 - r.y1) < 2))
      if (inner.length < 3) continue
      const xs = [r.x0, ...inner.map((v) => v.x).sort((a, b) => a - b), r.x1]
      const widths = xs.slice(1).map((x, i) => x - xs[i])
      const mean = widths.reduce((s, x) => s + x, 0) / widths.length
      if (widths.some((x) => Math.abs(x - mean) > 0.15 * mean)) continue
      consumedRects.add(r)
      inner.forEach((v) => consumedV.add(v))
      const label = this.bestLabel(r)
      this.emitComb(r, widths.length, label, 'a box divided into equal cells')
    }

    // 2. Cells: faces bounded by rules (including the edges of stroked rectangles), plus shaded rectangles.
    const hs: Seg[] = []
    const vs: Seg[] = []
    for (const l of pc.hlines) if (l.width <= 3) hs.push({ at: l.y, a0: l.x0, a1: l.x1 })
    for (const l of pc.vlines) if (l.width <= 3 && !consumedV.has(l)) vs.push({ at: l.x, a0: l.y0, a1: l.y1 })
    for (const r of visibleRects) {
      if (consumedRects.has(r) || !r.stroke) continue
      hs.push({ at: r.y0, a0: r.x0, a1: r.x1 }, { at: r.y1, a0: r.x0, a1: r.x1 })
      vs.push({ at: r.x0, a0: r.y0, a1: r.y1 }, { at: r.x1, a0: r.y0, a1: r.y1 })
    }
    const boxes: Box[] = findFaces(hs, vs)
    for (const r of visibleRects) {
      if (consumedRects.has(r)) continue
      if (!boxes.some((b) => iou(b, r) > 0.6)) boxes.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 })
    }
    // A box that contains two or more other boxes is a frame, not a cell.
    const cells: Cell[] = boxes
      .filter((b) => boxes.filter((o) => o !== b && o.x0 >= b.x0 - 1 && o.x1 <= b.x1 + 1 && o.y0 >= b.y0 - 1 && o.y1 <= b.y1 + 1 && area(o) < 0.95 * area(b)).length < 2)
      .map((b) => {
        const texts = this.phrasesIn(b)
        return { ...b, texts, blank: texts.length === 0 && !this.leaderIn(b) && !this.shapeInside(b) }
      })

    // 3. Combs made of separate/adjacent equal cells.
    const usedCells = new Set<Cell>()
    this.combsFromCells(cells, usedCells)

    // 4. Small squares and circles: checkboxes and radio buttons.
    this.choiceControls(cells, usedCells)

    // 5. Remaining cells: table cells and stand-alone boxes.
    this.cellFields(cells, usedCells)

    // 6. Leaders (`Name: ______`, `.......`) inside text.
    this.leaderFields()

    // 7. Free rules (underlines).
    this.ruleFields(cells)
  }

  private blank(b: Box): boolean {
    return this.phrasesIn(b).length === 0 && !this.leaderIn(b) && !this.shapeInside(b)
  }

  private shapeInside(b: Box): boolean {
    const pc = this.pc
    if (pc.circles.some((c) => centerIn({ x0: c.cx, x1: c.cx, y0: c.cy, y1: c.cy }, b, 1) && c.r < w(b) / 2)) return true
    // A dark filled mark (check, bullet, logo) inside: not empty.
    return pc.rects.some((r) => r.fill && r.fillLuma < 0.5 && area(r) < 0.8 * area(b) && centerIn(r, b, 0.5))
  }

  private bestLabel(r: Box): Label | undefined {
    const left = this.labelLeft(r)
    if (left) return { text: left.text, dir: 'left', phrase: left }
    const above = this.labelAbove(r)
    if (above) return { text: above.text, dir: 'above', phrase: above }
    return undefined
  }

  private emitComb(r: Box, cells: number, label: Label | undefined, reason: string): void {
    const conf = label ? 0.85 : 0.6
    const { kind, dateFormat } = this.textLabel(label?.text, 'text')
    this.add({
      kind: 'comb',
      rect: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 },
      confidence: conf,
      label: label?.text,
      reason: `${reason} (${cells} cells)${label ? `; label “${label.text}” (${label.dir})` : ''}`,
      cells,
      dateFormat: kind === 'date' ? dateFormat : undefined
    })
  }

  private combsFromCells(cells: Cell[], used: Set<Cell>): void {
    const cand = cells.filter((c) => c.blank && w(c) >= 7 && w(c) <= 32 && h(c) >= 9 && h(c) <= 40 && w(c) <= 1.7 * h(c))
    const rows: Cell[][] = []
    for (const c of [...cand].sort((a, b) => cy(b) - cy(a) || a.x0 - b.x0)) {
      const row = rows.find((r) => Math.abs(r[0].y0 - c.y0) <= 1.6 && Math.abs(r[0].y1 - c.y1) <= 1.6)
      if (row) row.push(c)
      else rows.push([c])
    }
    for (const row of rows) {
      row.sort((a, b) => a.x0 - b.x0)
      let chain: Cell[] = []
      const flush = (): void => {
        if (chain.length >= 4) {
          const r = union(chain)
          chain.forEach((c) => used.add(c))
          this.emitComb(r, chain.length, this.bestLabel(r), 'a row of equal empty cells')
        }
        chain = []
      }
      for (const c of row) {
        const last = chain[chain.length - 1]
        if (last && (c.x0 - last.x1 > 4 || Math.abs(w(c) - w(last)) > 1.6)) flush()
        chain.push(c)
      }
      flush()
    }
  }

  /** Checkbox / radio candidates from small squares and circles, with the text that sits next to them. */
  private choiceControls(cells: Cell[], used: Set<Cell>): void {
    interface Ctl {
      box: Box
      circle: boolean
      neighbours: number
      right?: Phrase
      left?: Phrase
    }
    const ctls: Ctl[] = []
    const squareLike = (b: Box): boolean => w(b) >= 6 && w(b) <= 20 && h(b) >= 6 && h(b) <= 20 && Math.abs(w(b) - h(b)) <= 0.25 * Math.max(w(b), h(b))
    for (const c of cells) {
      if (used.has(c) || !c.blank || !squareLike(c)) continue
      const neighbours = cells.filter((o) => o !== c && inter({ x0: o.x0 - 1.2, x1: o.x1 + 1.2, y0: o.y0 - 1.2, y1: o.y1 + 1.2 }, c) > 0).length
      ctls.push({ box: c, circle: false, neighbours })
      used.add(c)
    }
    for (const c of this.pc.circles) {
      if (!c.stroke || c.strokeLuma >= 0.95 || c.r < 3 || c.r > 10) continue
      if (c.fill && c.fillLuma < 0.5) continue
      ctls.push({ box: { x0: c.cx - c.r, x1: c.cx + c.r, y0: c.cy - c.r, y1: c.cy + c.r }, circle: true, neighbours: 0 })
    }
    for (const t of ctls) {
      t.right = this.phraseRightOf(t.box)
      t.left = t.right ? undefined : this.phraseLeftOf(t.box)
    }

    // Radio groups: circles (and Yes/No style square pairs) lined up in a row or a column.
    const groupedIdx = new Set<number>()
    const groups: { members: Ctl[]; axis: 'row' | 'col' }[] = []
    const candidates = ctls.map((t, i) => ({ t, i })).filter(({ t }) => t.circle)
    const chainBy = (pool: { t: Ctl; i: number }[], axis: 'row' | 'col'): void => {
      const remaining = pool.filter(({ i }) => !groupedIdx.has(i))
      const key = (t: Ctl): number => (axis === 'row' ? cy(t.box) : cx(t.box))
      const along = (t: Ctl): number => (axis === 'row' ? cx(t.box) : -cy(t.box))
      const lanes: { t: Ctl; i: number }[][] = []
      for (const m of [...remaining].sort((a, b) => key(a.t) - key(b.t))) {
        const lane = lanes.find((l) => Math.abs(key(l[0].t) - key(m.t)) <= 3)
        if (lane) lane.push(m)
        else lanes.push([m])
      }
      for (const lane of lanes) {
        lane.sort((a, b) => along(a.t) - along(b.t))
        let chain: { t: Ctl; i: number }[] = []
        const flush = (): void => {
          if (chain.length >= 2) {
            groups.push({ members: chain.map((m) => m.t), axis })
            chain.forEach((m) => groupedIdx.add(m.i))
          }
          chain = []
        }
        for (const m of lane) {
          const last = chain[chain.length - 1]
          const maxGap = axis === 'row' ? 230 : 42
          if (last && Math.abs(along(m.t) - along(last.t)) > maxGap) flush()
          chain.push(m)
        }
        flush()
      }
    }
    chainBy(candidates, 'row')
    chainBy(candidates, 'col')

    // Yes/No-style squares in a row: an exclusive choice.
    const yesNo = ctls.map((t, i) => ({ t, i })).filter(({ t }) => !t.circle && t.right && YES_NO_RE.test(t.right.text.trim()))
    const laneMap = new Map<number, { t: Ctl; i: number }[]>()
    for (const m of yesNo) {
      const k = Math.round(cy(m.t.box) / 4)
      laneMap.set(k, [...(laneMap.get(k) ?? []), m])
    }
    const yesNoGroups: Ctl[][] = []
    for (const lane of laneMap.values()) {
      lane.sort((a, b) => a.t.box.x0 - b.t.box.x0)
      if (lane.length >= 2 && lane.length <= 4 && lane[lane.length - 1].t.box.x0 - lane[0].t.box.x0 < 260) {
        yesNoGroups.push(lane.map((m) => m.t))
        lane.forEach((m) => groupedIdx.add(m.i))
      }
    }

    for (const g of groups) this.emitRadio(g.members, g.axis, false)
    for (const g of yesNoGroups) this.emitRadio(g, 'row', true)

    ctls.forEach((t, i) => {
      if (groupedIdx.has(i)) return
      const label = t.right ?? t.left
      const words = label ? label.text.split(/\s+/).length : 0
      let conf = !label ? 0.3 : t.right ? (words <= 8 ? 0.9 : words <= 16 ? 0.72 : 0.5) : 0.7
      if (t.neighbours > 0) conf -= 0.35
      if (t.circle) {
        // A lone circle next to text is most likely a bullet or decoration, not a radio button.
        conf = label && t.neighbours === 0 ? 0.42 : 0.25
      }
      this.add({
        kind: 'checkbox',
        rect: t.box,
        confidence: conf,
        label: label?.text,
        reason: label ? `a small ${t.circle ? 'circle' : 'square'} next to “${label.text}”` : `a small ${t.circle ? 'circle' : 'square'} with no text next to it`
      })
    })
  }

  private phraseRightOf(b: Box): Phrase | undefined {
    let best: Phrase | undefined
    let bestGap = Infinity
    for (const p of this.pc.phrases) {
      const gap = p.x0 - b.x1
      if (gap < -1 || gap > 14) continue
      const ov = Math.min(p.y1, b.y1 + 3) - Math.max(p.y0, b.y0 - 3)
      if (ov < 0.5 * (p.y1 - p.y0)) continue
      if (gap < bestGap) {
        best = p
        bestGap = gap
      }
    }
    return best
  }

  private phraseLeftOf(b: Box): Phrase | undefined {
    let best: Phrase | undefined
    let bestGap = Infinity
    for (const p of this.pc.phrases) {
      const gap = b.x0 - p.x1
      if (gap < -1 || gap > 12) continue
      const ov = Math.min(p.y1, b.y1 + 3) - Math.max(p.y0, b.y0 - 3)
      if (ov < 0.5 * (p.y1 - p.y0)) continue
      if (gap < bestGap) {
        best = p
        bestGap = gap
      }
    }
    return best
  }

  private emitRadio(members: { box: Box; right?: Phrase; left?: Phrase }[], axis: 'row' | 'col', squares: boolean): void {
    const sorted = [...members].sort((a, b) => (axis === 'row' ? a.box.x0 - b.box.x0 : b.box.y1 - a.box.y1))
    const first = sorted[0].box
    // The question: text left of the first button (rows) or above it (columns), when it is not the option label itself.
    let question: Phrase | undefined
    if (axis === 'row') {
      question = this.pc.phrases
        .filter((p) => p.x1 <= first.x0 - 2 && first.x0 - p.x1 <= 260 && Math.min(p.y1, first.y1 + 3) - Math.max(p.y0, first.y0 - 3) >= 0.5 * (p.y1 - p.y0))
        .filter((p) => !sorted.some((m) => m.right === p || m.left === p))
        .sort((a, b) => b.x1 - a.x1)[0]
    }
    if (!question) {
      question = this.pc.phrases
        .filter((p) => p.y0 >= first.y1 - 1 && p.y0 - first.y1 <= 26 && p.x0 <= first.x0 + 40 && p.x1 >= first.x0 - 60)
        .filter((p) => !sorted.some((m) => m.right === p || m.left === p))
        .sort((a, b) => a.y0 - b.y0)[0]
    }
    const taken = new Set<string>()
    const buttons: RadioButton[] = sorted.map((m, i) => {
      const lab = m.right ?? m.left
      return { rect: m.box, label: lab?.text, value: exportValueFor(lab?.text, i, taken) }
    })
    let conf = squares ? 0.62 : 0.86
    if (!question) conf -= 0.12
    if (buttons.some((b) => !b.label)) conf -= 0.1
    this.add({
      kind: 'radio',
      rect: union(sorted.map((m) => m.box)),
      confidence: conf,
      label: question?.text,
      reason: `${sorted.length} ${squares ? 'Yes/No style boxes' : 'circles'} in a ${axis}${question ? `; question “${question.text}”` : '; no question text found'}`,
      buttons
    })
  }

  // ----- boxes and table cells

  private cellFields(cells: Cell[], used: Set<Cell>): void {
    const remaining = cells.filter((c) => !used.has(c))
    // Connected components of touching cells: 4+ cells is a table.
    const comp = new Map<Cell, number>()
    let n = 0
    for (const c of remaining) {
      if (comp.has(c)) continue
      const queue = [c]
      comp.set(c, n)
      while (queue.length) {
        const cur = queue.pop()!
        for (const o of remaining) {
          if (comp.has(o)) continue
          if (inter({ x0: o.x0 - 1.5, x1: o.x1 + 1.5, y0: o.y0 - 1.5, y1: o.y1 + 1.5 }, cur) > 0) {
            comp.set(o, n)
            queue.push(o)
          }
        }
      }
      n++
    }
    const size = new Map<number, number>()
    comp.forEach((k) => size.set(k, (size.get(k) ?? 0) + 1))

    this.labelledBoxes(remaining.filter((c) => (size.get(comp.get(c)!) ?? 0) < 4))

    const stackCandidates: Cell[] = []
    for (const c of remaining) {
      if (!c.blank || w(c) < 24 || h(c) < 9) continue
      const inTable = (size.get(comp.get(c)!) ?? 0) >= 4
      if (!inTable) {
        this.standaloneBox(c)
        continue
      }
      // Table cell: needs a label from the cell on its left, or the column header above.
      const left = remaining.find((o) => !o.blank && o !== c && Math.abs(o.x1 - c.x0) <= 2 && Math.min(o.y1, c.y1) - Math.max(o.y0, c.y0) >= 0.6 * h(c))
      if (left) {
        const text = left.texts.map((p) => p.text).join(' ')
        this.emitText(c, 0.84, { text, dir: 'cell' }, 'an empty table cell', { multiline: h(c) > 44 })
        continue
      }
      const header = this.columnHeader(c, remaining)
      if (header) {
        this.emitText(c, 0.72, { text: header.text, dir: 'header' }, 'an empty table cell under a column header', { multiline: h(c) > 44 })
        continue
      }
      stackCandidates.push(c)
    }
    // Stacked empty cells with no per-cell label (ruled writing area): one multiline field.
    const byColumn = new Map<string, Cell[]>()
    for (const c of stackCandidates) {
      const k = `${Math.round(c.x0)}:${Math.round(c.x1)}`
      byColumn.set(k, [...(byColumn.get(k) ?? []), c])
    }
    for (const col of byColumn.values()) {
      col.sort((a, b) => b.y1 - a.y1)
      const r = union(col)
      const contiguous = col.every((c, i) => i === 0 || Math.abs(col[i - 1].y0 - c.y1) <= 2)
      if (col.length >= 3 && contiguous) {
        const label = this.bestLabel(r)
        if (label) this.emitText(r, 0.7, label, 'a ruled writing area', { multiline: true })
      }
    }
  }

  private columnHeader(c: Cell, all: Cell[]): Phrase | undefined {
    let best: Cell | undefined
    for (const o of all) {
      if (o.blank || o === c || o.y0 < c.y1 - 2) continue
      if (Math.min(o.x1, c.x1) - Math.max(o.x0, c.x0) < 0.6 * w(c)) continue
      if (!best || o.y0 < best.y0) best = o
    }
    return best?.texts[0]
  }

  private standaloneBox(c: Cell): void {
    const r = c
    // A frame around (nearly) the whole page is decoration, not a field.
    if (w(r) > 0.92 * this.pc.width && h(r) > 0.6 * this.pc.height) return
    const label = this.bestLabel(r)
    if (h(r) > 240 && !label) return
    const base = label ? (label.dir === 'left' ? 0.9 : 0.84) : 0.44
    this.emitText(r, base, label, 'an empty box', { multiline: h(r) > 44 })
  }

  /** Boxes with a small label printed in their own top-left corner (`Surname` above an empty area). */
  private labelledBoxes(cells: Cell[]): void {
    for (const c of cells) {
      if (c.blank || c.texts.length !== 1 || h(c) < 22 || w(c) < 60) continue
      const p = c.texts[0]
      const smallLabel = p.size <= 9.5 || p.y1 - p.y0 <= 0.45 * h(c)
      const cornered = p.x0 - c.x0 < 0.35 * w(c) && c.y1 - p.y1 < 0.3 * h(c) && p.x1 - c.x0 < 0.7 * w(c)
      const clear = this.pc.phrases.every((o) => o === p || !centerIn(o, c, 0.3)) && !this.leaderIn(c)
      if (smallLabel && cornered && clear && cells.filter((o) => o !== c && inter(o, c) > 0.5 * area(o)).length === 0) {
        this.emitText(c, 0.56, { text: p.text, dir: 'inside', phrase: p }, 'a box with its label printed inside', { multiline: h(c) > 44 })
      }
    }
  }

  // ----- leaders

  private leaderFields(): void {
    const leaders = [...this.pc.leaders].sort((a, b) => b.baseline - a.baseline || a.x0 - b.x0)
    // `___/___/____`: leaders joined by slashes are one date.
    const merged: { l: (typeof leaders)[number]; dateLike: boolean }[] = []
    for (const l of leaders) {
      const prev = merged[merged.length - 1]
      if (prev && Math.abs(prev.l.baseline - l.baseline) < 2) {
        const between = this.pc.phrases.filter((p) => p.x0 >= prev.l.x1 - 1 && p.x1 <= l.x0 + 1 && Math.abs(p.baseline - l.baseline) < 2)
        if (l.x0 - prev.l.x1 < 22 && between.length <= 1 && between.every((p) => /^[/.\-]$/.test(p.text))) {
          prev.l = { ...prev.l, x1: l.x1, count: prev.l.count + l.count }
          prev.dateLike = prev.dateLike || between.length === 1
          continue
        }
      }
      merged.push({ l, dateLike: false })
    }
    for (const { l, dateLike } of merged) {
      const len = l.x1 - l.x0
      if (len < 24) continue
      const fh = Math.max(12, l.size * 1.35)
      const rect: Box = { x0: l.x0, x1: l.x1, y0: l.baseline - 0.22 * l.size, y1: l.baseline - 0.22 * l.size + fh }
      // Text between the label and the leader belongs to the label too ("Name (print):").
      const left = this.labelLeft({ ...rect, y0: l.baseline - 1, y1: l.baseline + l.size * 0.7 }, 200)
      let label: Label | undefined = left ? { text: left.text, dir: 'left', phrase: left } : undefined
      if (!label) {
        const above = this.labelAbove(rect, 14)
        if (above) label = { text: above.text, dir: 'above', phrase: above }
      }
      if (!label) {
        const right = this.pc.phrases.find((p) => p.x0 >= l.x1 && p.x0 - l.x1 < 12 && Math.abs(p.baseline - l.baseline) < 2)
        if (right && len >= 40) label = { text: right.text, dir: 'left' }
      }
      const known = dateLike || (left ? DATE_RE.test(left.text) : false)
      this.emitText(rect, l.char === '_' ? 0.82 : 0.72, label, `a ${l.char === '_' ? 'blank line' : 'dotted leader'} of ${l.count} characters`, { dateLike: known && dateLike })
    }
  }

  // ----- underline rules

  private ruleFields(cells: Cell[]): void {
    const pc = this.pc
    const structural = (l: HLine): boolean =>
      cells.some((c) => {
        if (Math.abs(c.y0 - l.y) > 1.6 && Math.abs(c.y1 - l.y) > 1.6) return false
        const ov = Math.min(c.x1, l.x1) - Math.max(c.x0, l.x0)
        return ov >= 0.6 * (l.x1 - l.x0) || ov >= 0.8 * (c.x1 - c.x0)
      })
    for (const l of pc.hlines) {
      const len = l.x1 - l.x0
      if (len < 24 || l.width > 3.2 || structural(l)) continue
      const pageWide = len >= 0.85 * pc.width
      const marginal = l.y > pc.height * 0.94 || l.y < pc.height * 0.05
      // Vertical rules ending on the line make it part of a drawing (a bracket, a table): not a blank.
      const touching = pc.vlines.filter((v) => (Math.abs(v.x - l.x0) < 2 || Math.abs(v.x - l.x1) < 2) && (Math.abs(v.y0 - l.y) < 2 || Math.abs(v.y1 - l.y) < 2)).length
      if (touching >= 2) continue

      const probe: Box = { x0: l.x0, x1: l.x1, y0: l.y, y1: l.y + 15 }
      const left = this.labelLeft({ ...probe, y0: l.y - 3, y1: l.y + 8 }, 46)
      // Text sitting right above the line and overlapping it: an underlined heading, unless the line runs on
      // well beyond the text ("Address ____________").
      const over = pc.phrases.find((p) => {
        const gap = p.y0 - l.y
        return gap >= -1.5 && gap <= Math.max(3.2, 0.45 * p.size) && Math.min(p.x1, l.x1) - Math.max(p.x0, l.x0) > 0.3 * Math.min(p.x1 - p.x0, len)
      })
      if (over) {
        const extends_ = l.x1 - over.x1 >= Math.max(30, 1.5 * (over.x1 - over.x0))
        if (!extends_ || pageWide || marginal) continue
        const rect: Box = { x0: over.x1 + 4, x1: l.x1, y0: l.y + 0.5, y1: l.y + 0.5 + clamp(over.size * 1.5, 14, 20) }
        this.emitText(rect, 0.6, { text: over.text, dir: 'left', phrase: over }, 'a rule running on after its label')
        continue
      }
      if (left) {
        if (marginal && pageWide) continue
        const rect: Box = { x0: l.x0, x1: l.x1, y0: l.y + 0.5, y1: l.y + 0.5 + clamp(left.size * 1.5, 14, 20) }
        this.emitText(rect, 0.86, { text: left.text, dir: 'left', phrase: left }, l.dashed ? 'a dotted rule after a label' : 'a rule after a label')
        continue
      }
      // Without a label to its left, a long rule is a separator between sections, not a blank.
      if (pageWide || marginal || len >= 0.72 * pc.width) continue
      const above = this.labelAbove(probe, 22)
      const below = this.labelBelow({ ...probe, y1: l.y }, 12)
      const rect: Box = { x0: l.x0, x1: l.x1, y0: l.y + 0.5, y1: l.y + 0.5 + 16 }
      if (below && below.x1 - below.x0 <= 0.85 * len && below.text.split(/\s+/).length <= 6) {
        this.emitText(rect, 0.66, { text: below.text, dir: 'below', phrase: below }, 'a rule with a caption under it')
      } else if (above) {
        this.emitText(rect, 0.55, { text: above.text, dir: 'above', phrase: above }, 'a rule under a label')
      } else {
        this.emitText(rect, 0.4, undefined, 'a free-standing rule')
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------

/** Removes proposals that mostly cover a stronger one (a box and the rule inside it, ...). */
function suppress(list: Proposal[]): Proposal[] {
  const sorted = [...list].sort((a, b) => b.confidence - a.confidence)
  const kept: Proposal[] = []
  for (const p of sorted) {
    const clash = kept.some((k) => {
      const i = inter(p.rect, k.rect)
      return i > 0 && (i / Math.min(area(p.rect), area(k.rect)) > 0.6 || iou(p.rect, k.rect) > 0.4)
    })
    if (!clash) kept.push(p)
  }
  return kept
}

const shortKind: Record<DetectKind, string> = {
  text: 'Text',
  checkbox: 'Check_Box',
  radio: 'Radio',
  comb: 'Text',
  date: 'Date',
  signature: 'Signature'
}

/** "Full name:" -> "Full name" (labels shown to the user and stored as tooltips). */
export function cleanLabel(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const t = text
    .replace(/[\s:：*._…-]+$/u, '')
    .replace(/^\s*[•▪▫□☐■○●◦·*–—-]+\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t === '' ? undefined : t
}

/** Detects fields on one page. `takenNames` (existing and already proposed names) keeps names unique. */
export function detectPage(pc: PageContent, takenNames: Set<string> = new Set()): DetectResult {
  const shapes = pc.hlines.length + pc.vlines.length + pc.rects.length + pc.circles.length
  const textCount = pc.phrases.length + pc.leaders.length
  if (pc.imageCoverage >= 0.5 && shapes < 5) {
    return {
      pageIndex: pc.pageIndex,
      status: 'scanned',
      note:
        pc.hiddenText > 0
          ? 'This page is a scanned picture with a recognised-text layer. The lines and boxes are part of the picture, so fields cannot be detected reliably. Add the fields by hand.'
          : 'This page looks like a scan: it is a picture with no text or lines Epdf can analyse. Run OCR first (Tools ▸ OCR), or add the fields by hand. Nothing was guessed.',
      proposals: []
    }
  }
  if (textCount === 0 && shapes === 0) {
    return { pageIndex: pc.pageIndex, status: 'empty', note: 'There is no text or line art on this page to analyse.', proposals: [] }
  }
  const d = new Detector(pc)
  d.run()
  const kept = suppress(d.proposals).sort((a, b) => b.rect.y1 - a.rect.y1 || a.rect.x0 - b.rect.x0)
  for (const p of kept) {
    p.label = cleanLabel(p.label)
    p.buttons?.forEach((b) => (b.label = cleanLabel(b.label)))
  }
  // Names, top to bottom.
  for (const p of kept) p.name = nameFor(p.label && !(p.kind === 'radio' && !p.label) ? p.label : undefined, shortKind[p.kind], takenNames)
  let note: string | undefined
  if (pc.sidewaysText > 0 && pc.phrases.length === 0) note = 'The text on this page is turned sideways, so labels could not be read.'
  return { pageIndex: pc.pageIndex, status: 'ok', proposals: kept, note }
}

export type { ShapeCircle }
