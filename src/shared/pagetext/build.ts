import type { PDFDocument } from 'pdf-lib'
import { analyzeBidi, lineLevels, reorderVisual } from '../text/bidi'
import { interpretPage, type Glyph, type Interpretation } from './interpret'
import type { PageTextLine, PageTextModel, PageTextStats } from './types'
import { MARK_RE, isPreBaseMatra, isRtlMark, isSpaceText, strongCounts } from './unicode'
import { mirrorText, visualToLogicalOrder, type VisualUnit } from './visual'

/**
 * Builds the page text model from glyphs:
 *
 *   glyphs -> base glyphs ("anchors") grouped into lines by baseline direction and offset, split at column gaps
 *          -> combining marks attached to the base glyph they overlap (geometry, not stream order)
 *          -> units: one per base glyph (+ its marks), or one per /ActualText span (its text replaces the glyphs')
 *          -> spaces inserted where the gap between units is wide enough
 *          -> logical order per line (visual.ts), with the paragraph direction of the line/block
 *          -> blocks (paragraphs/columns) and reading order (XY cut; right-to-left pages read columns right to left)
 *          -> text + one quad per character.
 */

// ---- tunables (fractions of the font size) ------------------------------------------------------------------
/** Two base glyphs belong to one line when their baselines are this close. */
const SAME_LINE = 0.4
/** A gap wider than this (without any glyph in it) separates two lines on the same baseline (columns, table cells). */
const COLUMN_GAP = 1.25
/** ... or wider than this when the glyphs on both sides were drawn far apart in the content stream. */
const COLUMN_GAP_STREAM = 0.5
const STREAM_JUMP = 20
/** A gap wider than this becomes a space. */
const SPACE_GAP = 0.16
/** How far above/below its line a mark may sit. */
const MARK_REACH = 1.3

interface Frame {
  key: number
  ex: number
  ey: number
  /** n = (-ey, ex) */
  nx: number
  ny: number
  angle: number
}

interface Anchor {
  g: number
  s: number
  t: number
  len: number
  top: number
  bottom: number
  size: number
  marks: number[]
}

interface Piece {
  s0: number
  s1: number
  t0: number
  t1: number
}

interface Unit {
  text: string
  /** Boxes (in the line frame) of the glyphs the unit covers, in visual order. */
  boxes: Piece[]
  /** Box index for every UTF-16 unit of `text`, or null = divide the union among the base characters. */
  charBox: number[] | null
  /** For a unit made from an /ActualText span over several glyphs: the glyphs' own texts (for alignment). */
  glyphTexts?: string[]
  seq: number
  synthetic: boolean
  /** Font key of the unit's (first) glyph. */
  font: number
}

interface LineRec {
  frame: Frame
  t: number
  size: number
  anchors: Anchor[]
  units: Unit[]
  s0: number
  s1: number
  strong: { r: number; l: number }
  dir: 0 | 1
  /** Direction decided by the line's own letters (false = tie/none; the block decides). */
  ownDir: boolean
  block: number
  // results
  text: string
  /** per char: piece in the line frame */
  pieces: Piece[]
  exact: boolean
  /** Dominant font key (most characters). */
  font: number
}

const deg = (r: number): number => (r * 180) / Math.PI

function frameOf(g: Glyph, frames: Map<number, Frame>): Frame {
  const angle = deg(Math.atan2(g.ey, g.ex))
  const key = Math.round(angle)
  let f = frames.get(key)
  if (!f) {
    const a = (key * Math.PI) / 180
    const ex = Math.abs(key) === 90 ? 0 : Math.cos(a)
    const ey = key === 0 || Math.abs(key) === 180 ? 0 : Math.sin(a)
    f = { key, ex, ey, nx: -ey, ny: ex, angle: key }
    frames.set(key, f)
  }
  return f
}

const isAnchorGlyph = (g: Glyph): boolean => g.len > 0.02 * g.size || (g.text !== '' && !g.mark)

// eslint-disable-next-line no-control-regex
const ASCII = /^[\u0000-\u007f]*$/
/** NFC, skipped for ASCII (the common case: nothing to compose). */
const nfc = (s: string): string => (ASCII.test(s) ? s : s.normalize('NFC'))

// ---- word segmentation -------------------------------------------------------------------------------------
let segmenter: Intl.Segmenter | null | undefined
function wordsOf(text: string, offset: number): number[] {
  if (ASCII.test(text)) {
    // what the word segmenter gives for ASCII: runs of letters/digits (with inner apostrophes and periods between digits)
    const out: number[] = []
    for (const m of text.matchAll(/[A-Za-z0-9_]+(?:['.,][A-Za-z0-9_]+)*/g)) out.push(offset + m.index!, offset + m.index! + m[0].length)
    return out
  }
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
    } catch {
      segmenter = null
    }
  }
  const out: number[] = []
  if (segmenter) {
    for (const s of segmenter.segment(text)) if (s.isWordLike) out.push(offset + s.index, offset + s.index + s.segment.length)
  } else {
    const re = /[\p{L}\p{M}\p{N}_]+/gu
    for (let m = re.exec(text); m; m = re.exec(text)) out.push(offset + m.index, offset + m.index + m[0].length)
  }
  return out
}

// ---- alignment of /ActualText with the glyphs it covers ------------------------------------------------------
/** Alignment key: compatibility-folded, lower case, without non-spacing marks (spacing vowel signs are kept: they have glyphs of their own). */
const baseKey = (s: string): string => s.normalize('NFKC').replace(/[\p{Mn}\p{Me}]/gu, '').toLowerCase()

/**
 * Maps every character of an ActualText string to one of the span's glyph boxes: the ActualText is displayed with the
 * bidi algorithm (it is logical text), its visual character sequence is aligned (LCS) with the glyphs' texts in visual
 * order; characters without a partner take the box of their neighbour.
 */
function alignSpan(actual: string, glyphTexts: string[], para: 0 | 1): number[] {
  const n = actual.length
  const out = new Array<number>(n).fill(-1)
  if (n === 0) return out
  if (glyphTexts.length === 1) return out.fill(0)
  // visual order of the ActualText's characters
  const info = analyzeBidi(actual, para ? 'rtl' : 'ltr')
  const vis = reorderVisual(lineLevels(info, 0, n, para))
  const a: { key: string; idx: number }[] = []
  for (const i of vis) {
    const c = actual.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) continue // second half of a surrogate pair: follows its first half
    for (const ch of baseKey(String.fromCodePoint(actual.codePointAt(i)!))) a.push({ key: ch, idx: i })
  }
  const b: { key: string; owner: number }[] = []
  glyphTexts.forEach((t, gi) => {
    for (const ch of baseKey(t)) b.push({ key: ch, owner: gi })
  })
  if (a.length * b.length <= 4_000_000 && a.length && b.length) {
    // LCS table (lengths), then walk back
    const w = b.length + 1
    const dp = new Uint16Array((a.length + 1) * w)
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i * w + j] = a[i].key === b[j].key ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
      }
    }
    const usedB = new Uint8Array(b.length)
    const doneA = new Uint8Array(a.length)
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
      if (a[i].key === b[j].key) {
        out[a[i].idx] = b[j].owner
        doneA[i] = 1
        usedB[j] = 1
        i++
        j++
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
      else j++
    }
    // characters drawn out of order (an Indic pre-base vowel sign before its consonant): match what is left by key
    for (let i = 0; i < a.length; i++) {
      if (doneA[i]) continue
      const j = b.findIndex((x, k) => !usedB[k] && x.key === a[i].key)
      if (j >= 0) {
        out[a[i].idx] = b[j].owner
        usedB[j] = 1
      }
    }
  } else if (a.length && b.length) {
    // proportional fallback for very long spans
    a.forEach((x, k) => (out[x.idx] = b[Math.min(b.length - 1, Math.floor((k / a.length) * b.length))].owner))
  }
  // unaligned characters (spaces, marks, low surrogates): the box of the previous character in logical order, else the next
  let last = -1
  for (let i = 0; i < n; i++) {
    if (out[i] >= 0) last = out[i]
    else if (last >= 0) out[i] = last
  }
  let next = -1
  for (let i = n - 1; i >= 0; i--) {
    if (out[i] >= 0) next = out[i]
    else out[i] = next >= 0 ? next : 0
  }
  return out
}

// ---- per-character geometry ---------------------------------------------------------------------------------
const unionPiece = (ps: Piece[]): Piece => {
  let s0 = Infinity
  let s1 = -Infinity
  let t0 = Infinity
  let t1 = -Infinity
  for (const p of ps) {
    if (p.s0 < s0) s0 = p.s0
    if (p.s1 > s1) s1 = p.s1
    if (p.t0 < t0) t0 = p.t0
    if (p.t1 > t1) t1 = p.t1
  }
  return { s0, s1, t0, t1 }
}

/** Splits `box` among the base characters of `text` (marks share their base's part); `rtl` puts the first at the end. */
function divide(text: string, box: Piece, rtl: boolean): Piece[] {
  const n = text.length
  const baseIdx: number[] = []
  let k = -1
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    const low = c >= 0xdc00 && c <= 0xdfff
    if (!low && (k < 0 || !MARK_RE.test(text[i]))) k++
    baseIdx.push(Math.max(0, k))
  }
  const parts = k + 1 || 1
  const w = (box.s1 - box.s0) / parts
  return baseIdx.map((b) => {
    const p = rtl ? parts - 1 - b : b
    return { s0: box.s0 + p * w, s1: box.s0 + (p + 1) * w, t0: box.t0, t1: box.t1 }
  })
}

function unitPieces(u: Unit, text: string, rtl: boolean): Piece[] {
  if (text.length === 1 && u.boxes.length === 1) return [u.boxes[0]]
  if (!u.charBox || u.boxes.length <= 1) return divide(text, unionPiece(u.boxes), rtl)
  // characters mapped to boxes; several characters on one box share it
  const out = new Array<Piece>(text.length)
  const groups = new Map<number, number[]>()
  u.charBox.forEach((b, i) => {
    const l = groups.get(b)
    if (l) l.push(i)
    else groups.set(b, [i])
  })
  for (const [b, idxs] of groups) {
    const box = u.boxes[b] ?? unionPiece(u.boxes)
    const sub = idxs.map((i) => text[i]).join('')
    const parts = divide(sub, box, rtl)
    idxs.forEach((i, k) => (out[i] = parts[k]))
  }
  return out
}

// ---- Indic pre-base vowel signs ------------------------------------------------------------------------------
const INDIC = /[ऀ-෿က-႟ក-៿]/u
const VIRAMA_END = /[्্੍્୍்్್്්္្]$/u
/** A pre-base matra drawn (and so found) before its consonant cluster moves after it. */
function fixPreBase(order: number[], units: Unit[]): number[] {
  const out = order.slice()
  for (let i = 0; i < out.length; i++) {
    const t = units[out[i]].text
    if (!isPreBaseMatra(t) || !/^\p{M}+$/u.test(t)) continue
    let j = i + 1
    while (j < out.length && VIRAMA_END.test(units[out[j]].text)) j++
    if (j < out.length && /^\p{L}/u.test(units[out[j]].text)) {
      const m = out[i]
      out.splice(i, 1)
      out.splice(j, 0, m)
      i = j
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------

export interface BuildOptions {
  /** Keep text in render mode 3/7 (invisible, e.g. OCR layers). Default true: it is selectable in every reader. */
  includeHidden?: boolean
  /**
   * Also report which output line every glyph of the interpretation ended up in (`PageTextModel.glyphLine`): base glyphs
   * and the marks attached to them. Used by the text editor to find the content-stream glyphs of a logical line.
   */
  glyphLines?: boolean
}

export function buildPageText(pdf: PDFDocument, pageIndex: number, opts: BuildOptions = {}): PageTextModel {
  return modelFromInterpretation(interpretPage(pdf, pageIndex), pageIndex, opts)
}

export function modelFromInterpretation(ip: Interpretation, pageIndex: number, opts: BuildOptions = {}): PageTextModel {
  const glyphs = ip.glyphs
  const stats: PageTextStats = { glyphs: glyphs.length, unknown: 0, unreliable: 0, actualText: 0, inexactLines: 0, marks: 0, orphanMarks: 0 }
  const frames = new Map<number, Frame>()
  const margin = 2
  const onPage = (g: Glyph): boolean => g.ox > -margin * g.size && g.ox < ip.width + margin * g.size && g.oy > -margin * g.size && g.oy < ip.height + margin * g.size
  const use = glyphs.map((g) => (opts.includeHidden !== false || !g.hidden) && onPage(g))

  // 1. anchors per frame
  const byFrame = new Map<number, Anchor[]>()
  const markList: number[] = []
  const anchorOf = new Int32Array(glyphs.length).fill(-1)
  const anchors: Anchor[] = []
  glyphs.forEach((g, i) => {
    if (!use[i]) return
    if (g.unreliable) stats.unreliable++
    if (isAnchorGlyph(g)) {
      if (g.text === '' && g.span < 0) {
        if (g.len > 0.02 * g.size) stats.unknown++
        return
      }
      const f = frameOf(g, frames)
      const a: Anchor = { g: i, s: g.ox * f.ex + g.oy * f.ey, t: g.ox * f.nx + g.oy * f.ny, len: g.len, top: g.top, bottom: g.bottom, size: g.size, marks: [] }
      anchorOf[i] = anchors.length
      anchors.push(a)
      const l = byFrame.get(f.key)
      if (l) l.push(a)
      else byFrame.set(f.key, [a])
    } else if (g.text !== '' && g.mark) markList.push(i)
  })

  // 2. lines: group by baseline offset, then split at column gaps
  const lines: LineRec[] = []
  const linesByFrame = new Map<number, LineRec[]>()
  for (const [key, list] of byFrame) {
    const f = frames.get(key)!
    list.sort((a, b) => a.t - b.t || a.s - b.s)
    const groups: { t: number; n: number; size: number; items: Anchor[] }[] = []
    for (const a of list) {
      const cur = groups[groups.length - 1]
      if (cur && Math.abs(a.t - cur.t) <= SAME_LINE * Math.max(Math.min(a.size, cur.size), 0.5 * Math.max(a.size, cur.size))) {
        cur.t = (cur.t * cur.n + a.t) / (cur.n + 1)
        cur.n++
        cur.size = Math.max(cur.size, a.size)
        cur.items.push(a)
      } else groups.push({ t: a.t, n: 1, size: a.size, items: [a] })
    }
    const fl: LineRec[] = []
    for (const gr of groups) {
      const items = gr.items.sort((a, b) => a.s - b.s || glyphs[a.g].seq - glyphs[b.g].seq)
      // drop exact duplicates (text drawn twice for a bold or shadow effect)
      const dedup: Anchor[] = []
      for (const a of items) {
        const p = dedup[dedup.length - 1]
        if (p && glyphs[p.g].text === glyphs[a.g].text && Math.abs(p.s - a.s) < 0.12 * a.size && Math.abs(p.t - a.t) < 0.12 * a.size && glyphs[p.g].span === glyphs[a.g].span) continue
        dedup.push(a)
      }
      let seg: Anchor[] = []
      let end = -Infinity
      const flush = (): void => {
        if (!seg.length) return
        const size = Math.max(...seg.map((x) => x.size))
        const t = seg.reduce((acc, x) => acc + x.t, 0) / seg.length
        const rec: LineRec = {
          frame: f,
          t,
          size,
          anchors: seg,
          units: [],
          s0: seg[0].s,
          s1: Math.max(...seg.map((x) => x.s + x.len)),
          strong: { r: 0, l: 0 },
          dir: 0,
          ownDir: false,
          block: -1,
          text: '',
          pieces: [],
          exact: true,
          font: -1
        }
        fl.push(rec)
        seg = []
      }
      for (const a of dedup) {
        if (seg.length) {
          const prev = seg[seg.length - 1]
          const gap = a.s - end
          const sz = Math.max(a.size, prev.size)
          // a wide gap, or a medium one between glyphs drawn far apart in the content stream (another column)
          const far = Math.abs(glyphs[a.g].seq - glyphs[prev.g].seq) > STREAM_JUMP
          if (gap > COLUMN_GAP * sz || (gap > COLUMN_GAP_STREAM * sz && far)) flush()
        }
        seg.push(a)
        end = Math.max(end, a.s + a.len)
      }
      flush()
    }
    fl.sort((a, b) => a.t - b.t || a.s0 - b.s0)
    linesByFrame.set(key, fl)
    lines.push(...fl)
  }
  const lineOfAnchor = new Map<Anchor, LineRec>()
  for (const l of lines) for (const a of l.anchors) lineOfAnchor.set(a, l)

  // 3. marks -> the base glyph they sit on. A mark inside an /ActualText span whose only base glyph is known belongs to
  // that glyph (the producer said so; marks are often drawn over a neighbour, e.g. a Hebrew holam); others by geometry.
  const spanBases = ip.spans.map((sp) => sp.glyphs.filter((gi) => anchorOf[gi] >= 0).map((gi) => anchors[anchorOf[gi]]))
  for (const mi of markList) {
    const m = glyphs[mi]
    stats.marks++
    if (m.span >= 0 && spanBases[m.span].length === 1) {
      spanBases[m.span][0].marks.push(mi)
      continue
    }
    const allowed = m.span >= 0 && spanBases[m.span].length > 1 ? new Set(spanBases[m.span]) : null
    const f = frameOf(m, frames)
    const fl = linesByFrame.get(f.key)
    const s = m.ox * f.ex + m.oy * f.ey
    const t = m.ox * f.nx + m.oy * f.ny
    const center = m.ink ? s + (m.ink[0] + m.ink[1]) / 2 : s
    let best: Anchor | null = null
    let bestScore = Infinity
    for (const l of fl ?? []) {
      if (Math.abs(t - l.t) > MARK_REACH * l.size) continue
      if (center < l.s0 - l.size || center > l.s1 + l.size) continue
      for (let k = 0; k < l.anchors.length; k++) {
        const a = l.anchors[k]
        if (allowed && !allowed.has(a)) continue
        const eps = 0.02 * a.size
        let d: number
        if (center >= a.s + eps && center <= a.s + a.len - eps) d = 0
        else if (Math.abs(center - a.s) <= eps) {
          // exactly on the left edge: a right-to-left mark drawn before its base belongs to this glyph
          d = isRtlMark(m.text) || m.ink ? 0.001 : 0.01
        } else if (Math.abs(center - (a.s + a.len)) <= eps) {
          d = isRtlMark(m.text) && !m.ink ? 0.01 : 0.001
        } else d = Math.min(Math.abs(center - a.s), Math.abs(center - a.s - a.len)) / a.size + 0.02
        if (glyphs[a.g].text === ' ' || isSpaceText(glyphs[a.g].text)) d += 0.5
        const score = d + Math.abs(t - l.t) / (10 * l.size)
        if (score < bestScore) {
          bestScore = score
          best = a
        }
      }
    }
    if (best && bestScore < 0.8) best.marks.push(mi)
    else stats.orphanMarks++
  }

  // 4. /ActualText spans: which anchors (directly, or through their marks) each span covers
  const spanAnchors = ip.spans.map(() => new Set<Anchor>())
  const markOwner = new Map<number, Anchor>()
  for (const a of anchors) for (const mi of a.marks) markOwner.set(mi, a)
  ip.spans.forEach((sp, si) => {
    for (const gi of sp.glyphs) {
      const ai = anchorOf[gi]
      if (ai >= 0) spanAnchors[si].add(anchors[ai])
      else {
        const owner = markOwner.get(gi)
        if (owner) spanAnchors[si].add(owner)
      }
    }
  })
  /** The span an anchor belongs to: its own glyph's, or the span of marks sitting on it (when that span covers only it). */
  const spanOfAnchor = (a: Anchor): number => {
    const own = glyphs[a.g].span
    if (own >= 0) return own
    for (const mi of a.marks) {
      const s = glyphs[mi].span
      if (s >= 0 && spanAnchors[s].size === 1) return s
    }
    return -1
  }

  // 5. units per line
  const spanUsed = new Set<number>()
  for (const l of lines) {
    const units: Unit[] = []
    const piece = (a: Anchor): Piece => ({ s0: a.s, s1: a.s + a.len, t0: a.t - a.top, t1: a.t + a.bottom })
    const glyphUnitText = (a: Anchor): string => {
      const g = glyphs[a.g]
      if (!a.marks.length) return g.text
      let t = g.text
      // marks not inside another span keep their own text
      const ms = a.marks.slice().sort((x, y) => glyphs[x].seq - glyphs[y].seq)
      for (const mi of ms) if (glyphs[mi].span < 0 || glyphs[mi].span === g.span) t += glyphs[mi].text
      return t
    }
    for (let k = 0; k < l.anchors.length; ) {
      const a = l.anchors[k]
      const g = glyphs[a.g]
      const si = spanOfAnchor(a)
      if (si >= 0 && !spanUsed.has(si)) {
        const cover = spanAnchors[si]
        // the span's anchors must all be in this line and contiguous here
        let j = k
        while (j < l.anchors.length && cover.has(l.anchors[j])) j++
        const inLine = [...cover].every((x) => lineOfAnchor.get(x) === l)
        if (inLine && j - k === cover.size) {
          spanUsed.add(si)
          stats.actualText++
          const covered = l.anchors.slice(k, j)
          const text = nfc(ip.spans[si].text)
          const u: Unit = { text, boxes: covered.map(piece), charBox: null, seq: Math.min(...covered.map((x) => glyphs[x.g].seq)), synthetic: false, font: g.font }
          if (covered.length > 1) {
            u.charBox = [] // aligned once the direction is known
            u.glyphTexts = covered.map((x) => glyphUnitText(x))
          }
          units.push(u)
          k = j
          continue
        }
      }
      if (si >= 0 && spanUsed.has(si) && spanAnchors[si].has(a)) {
        k++
        continue
      }
      // a glyph of a span we could not use keeps its own text
      const text = nfc(glyphUnitText(a))
      units.push({ text, boxes: [piece(a)], charBox: null, seq: g.seq, synthetic: false, font: g.font })
      k++
    }
    // A space glyph lying mostly on top of a letter draws no gap: it is not a word break. (Word 365 writes the space
    // after a right-to-left word at the word's left edge, over its last letter: "المتحد ة" otherwise.)
    const extent = (u: Unit): [number, number] => {
      let s0 = Infinity
      let s1 = -Infinity
      for (const b of u.boxes) {
        if (b.s0 < s0) s0 = b.s0
        if (b.s1 > s1) s1 = b.s1
      }
      return [s0, s1]
    }
    const hidden = new Set<Unit>()
    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      if (u.synthetic || u.glyphTexts || !isSpaceText(u.text)) continue
      const [a0, a1] = extent(u)
      const w = a1 - a0
      if (!(w > 0)) continue
      for (const j of [i - 1, i + 1]) {
        const v = units[j]
        if (!v || isSpaceText(v.text) || v.text === '') continue
        const [b0, b1] = extent(v)
        if (Math.min(a1, b1) - Math.max(a0, b0) > 0.5 * w) {
          hidden.add(u)
          break
        }
      }
    }
    if (hidden.size) {
      const keep = units.filter((u) => !hidden.has(u))
      units.length = 0
      units.push(...keep)
    }

    // spaces
    const out: Unit[] = []
    for (const u of units) {
      const prev = out[out.length - 1]
      if (prev) {
        let pe = -Infinity
        for (const b of prev.boxes) if (b.s1 > pe) pe = b.s1
        let us = Infinity
        for (const b of u.boxes) if (b.s0 < us) us = b.s0
        const gap = us - pe
        const sz = l.size
        const prevSpace = /\s$/u.test(prev.text)
        const curSpace = /^\s/u.test(u.text)
        if (gap > SPACE_GAP * sz && !prevSpace && !curSpace) {
          const t0 = Math.min(prev.boxes[0].t0, u.boxes[0].t0)
          const t1 = Math.max(prev.boxes[0].t1, u.boxes[0].t1)
          out.push({ text: ' ', boxes: [{ s0: pe, s1: us, t0, t1 }], charBox: null, seq: prev.seq, synthetic: true, font: prev.font })
        } else if (prevSpace && curSpace && isSpaceText(u.text) && isSpaceText(prev.text)) {
          prev.boxes.push(...u.boxes)
          continue
        }
      }
      out.push(u)
    }
    l.units = out.filter((u) => u.text !== '')
    const fontWeight = new Map<number, number>()
    for (const u of l.units) {
      const c = strongCounts(u.text)
      l.strong.r += c.r
      l.strong.l += c.l
      if (!u.synthetic) fontWeight.set(u.font, (fontWeight.get(u.font) ?? 0) + u.text.length)
    }
    let fw = -1
    for (const [k, w] of fontWeight) if (w > fw) [fw, l.font] = [w, k]
    l.ownDir = l.strong.r !== l.strong.l
    l.dir = l.strong.r > l.strong.l ? 1 : 0
  }

  // 6. blocks (per frame): consecutive lines close in baseline and overlapping along the baseline
  let blockCount = 0
  const blocks: LineRec[][] = []
  for (const fl of linesByFrame.values()) {
    const open: { lines: LineRec[]; last: LineRec }[] = []
    for (const l of fl) {
      if (!l.units.length) continue
      let pick: { lines: LineRec[]; last: LineRec } | null = null
      let bestOv = -Infinity
      for (const b of open) {
        const p = b.last
        const dt = l.t - p.t
        const sz = Math.max(l.size, p.size)
        if (dt <= 0.3 * sz || dt > 2.4 * sz) continue
        if (Math.max(l.size, p.size) > 1.35 * Math.min(l.size, p.size)) continue
        const ov = Math.min(l.s1, p.s1) - Math.max(l.s0, p.s0)
        if (ov > bestOv && ov > -0.5 * sz) {
          bestOv = ov
          pick = b
        }
      }
      if (pick) {
        pick.lines.push(l)
        pick.last = l
      } else {
        const b = { lines: [l], last: l }
        open.push(b)
        blocks.push(b.lines)
      }
    }
  }
  // block direction: the majority of strong letters; lines with no majority of their own follow it
  for (const b of blocks) {
    const id = blockCount++
    let r = 0
    let lt = 0
    for (const l of b) {
      l.block = id
      r += l.strong.r
      lt += l.strong.l
    }
    const bd: 0 | 1 = r > lt ? 1 : 0
    for (const l of b) if (!l.ownDir) l.dir = bd
  }

  // 7. logical order per line
  for (const l of lines) {
    if (!l.units.length) continue
    const units = l.units
    const vu: VisualUnit[] = units.map((u) => ({ text: u.text, seq: u.seq }))
    const res = visualToLogicalOrder(vu, l.dir)
    if (!res.exact) stats.inexactLines++
    l.exact = res.exact
    let order = res.order
    if (units.some((u) => INDIC.test(u.text))) order = fixPreBase(order, units)
    // trim whitespace at both ends
    let a = 0
    let z = order.length
    while (a < z && isSpaceText(units[order[a]].text)) a++
    while (z > a && isSpaceText(units[order[z - 1]].text)) z--
    let text = ''
    const pieces: Piece[] = []
    for (let k = a; k < z; k++) {
      const vi = order[k]
      const u = units[vi]
      const rtl = (res.levels[vi] & 1) === 1
      const t = res.mirror[vi] ? mirrorText(u.text) : u.text
      if (u.charBox && u.boxes.length > 1) u.charBox = alignSpan(t, u.glyphTexts ?? [], l.dir)
      text += t
      pieces.push(...unitPieces(u, t, rtl))
    }
    // whitespace inside /ActualText at the ends of the line
    const lead = text.length - text.trimStart().length
    const trail = text.length - text.trimEnd().length
    if (lead || trail) {
      pieces.splice(text.length - trail, trail)
      pieces.splice(0, lead)
      text = text.slice(lead, text.length - trail)
    }
    l.text = text
    l.pieces = pieces
  }

  // 8. reading order of blocks: XY cut in the frame of each direction group, main group first
  const pageR = lines.reduce((acc, l) => acc + l.strong.r, 0)
  const pageL = lines.reduce((acc, l) => acc + l.strong.l, 0)
  const pageRtl = pageR > pageL
  const byBlock = new Map<number, LineRec[]>()
  for (const l of lines) {
    if (!l.text) continue
    const list = byBlock.get(l.block)
    if (list) list.push(l)
    else byBlock.set(l.block, [l])
  }
  interface BlockBox {
    id: number
    frame: Frame
    s0: number
    s1: number
    t0: number
    t1: number
    weight: number
  }
  const bboxes: BlockBox[] = []
  for (const [id, ls] of byBlock) {
    ls.sort((a, b) => a.t - b.t)
    bboxes.push({
      id,
      frame: ls[0].frame,
      s0: Math.min(...ls.map((l) => l.s0)),
      s1: Math.max(...ls.map((l) => l.s1)),
      t0: Math.min(...ls.map((l) => l.t - l.size)),
      t1: Math.max(...ls.map((l) => l.t + 0.3 * l.size)),
      weight: ls.reduce((acc, l) => acc + l.text.length, 0)
    })
  }
  const groupsByFrame = new Map<number, BlockBox[]>()
  for (const b of bboxes) {
    const list = groupsByFrame.get(b.frame.key)
    if (list) list.push(b)
    else groupsByFrame.set(b.frame.key, [b])
  }
  const frameOrder = [...groupsByFrame.entries()].sort((a, b) => b[1].reduce((s, x) => s + x.weight, 0) - a[1].reduce((s, x) => s + x.weight, 0))
  const orderedBlocks: number[] = []
  for (const [, list] of frameOrder) orderedBlocks.push(...xyCut(list, pageRtl).map((b) => b.id))

  // 9. assemble
  let text = ''
  const charQuad: number[] = []
  let totalPieces = 0
  for (const l of lines) if (l.text) totalPieces += l.pieces.length
  const quads = new Float32Array(totalPieces * 8)
  let qn = 0
  const outLines: PageTextLine[] = []
  const glyphLine = opts.glyphLines ? new Int32Array(glyphs.length).fill(-1) : undefined
  let blockIndex = -1
  let lastBlock = -1
  for (const bid of orderedBlocks) {
    const ls = byBlock.get(bid)!
    for (const l of ls) {
      if (text) {
        text += '\n'
        charQuad.push(-1)
      }
      if (bid !== lastBlock) {
        blockIndex++
        lastBlock = bid
      }
      const start = text.length
      const f = l.frame
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const p of l.pieces) {
        charQuad.push(qn / 8)
        // corners: start-bottom, end-bottom, end-top, start-top
        for (let k = 0; k < 4; k++) {
          const s = k === 1 || k === 2 ? p.s1 : p.s0
          const t = k < 2 ? p.t1 : p.t0
          const x = s * f.ex + t * f.nx
          const y = s * f.ey + t * f.ny
          quads[qn++] = x
          quads[qn++] = y
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
      text += l.text
      if (glyphLine) {
        for (const a of l.anchors) {
          glyphLine[a.g] = outLines.length
          for (const mi of a.marks) glyphLine[mi] = outLines.length
        }
      }
      const fi = ip.fonts.get(l.font)
      outLines.push({
        start,
        end: text.length,
        dir: l.dir ? 'rtl' : 'ltr',
        angle: f.angle,
        size: l.size,
        baseline: l.t,
        font: fi?.name ?? '',
        bold: fi?.bold ?? false,
        italic: fi?.italic ?? false,
        x0,
        y0,
        x1,
        y1,
        block: blockIndex,
        exact: l.exact,
        words: wordsOf(l.text, start)
      })
    }
  }
  return {
    pageIndex,
    width: ip.width,
    height: ip.height,
    rotation: ip.rotation,
    transform: [...ip.transform],
    text,
    lines: outLines,
    charQuad: Int32Array.from(charQuad),
    quads: qn === quads.length ? quads : quads.slice(0, qn),
    stats,
    warnings: ip.warnings,
    ...(glyphLine ? { glyphLine } : {})
  }
}

interface XyBox {
  s0: number
  s1: number
  t0: number
  t1: number
}

/** Recursive XY cut: horizontal bands top to bottom, then columns (right to left on right-to-left pages). */
function xyCut<T extends XyBox>(items: T[], rtl: boolean, depth = 0): T[] {
  if (items.length <= 1 || depth > 40) return items
  // horizontal cuts (gaps across the t axis)
  const byT = [...items].sort((a, b) => a.t0 - b.t0)
  const bands: T[][] = []
  let cur: T[] = []
  let maxT = -Infinity
  for (const it of byT) {
    if (cur.length && it.t0 > maxT) {
      bands.push(cur)
      cur = []
    }
    cur.push(it)
    maxT = Math.max(maxT, it.t1)
  }
  bands.push(cur)
  if (bands.length > 1) return bands.flatMap((b) => xyCut(b, rtl, depth + 1))
  // vertical cuts (gaps across the s axis)
  const byS = [...items].sort((a, b) => a.s0 - b.s0)
  const cols: T[][] = []
  cur = []
  let maxS = -Infinity
  for (const it of byS) {
    if (cur.length && it.s0 > maxS) {
      cols.push(cur)
      cur = []
    }
    cur.push(it)
    maxS = Math.max(maxS, it.s1)
  }
  cols.push(cur)
  if (cols.length > 1) {
    if (rtl) cols.reverse()
    return cols.flatMap((c) => xyCut(c, rtl, depth + 1))
  }
  // overlapping boxes: top to bottom, then along the reading direction
  return byT.sort((a, b) => a.t0 - b.t0 || (rtl ? b.s1 - a.s1 : a.s0 - b.s0))
}
