import { analyzeBidi, lineLevels, reorderVisual } from '../../../../shared/text/bidi'
import { kashidaJustify } from '../../../../shared/text/kashida'
import { CURSIVE_SCRIPTS, isDefaultIgnorable, resolveScripts } from '../../../../shared/text/script'
import { shapeText } from '../../../../shared/text/shape'
import type { GlyphRun, LayoutGlyph, Line, ResolvedStyle } from '../../../../shared/text/types'
import type { Face, FontCatalog } from './fonts'
import type { Hex } from './ops'

/**
 * One line of text for the Office converter: logical-order items (text in a style, or fixed-width gaps for inline
 * pictures) become positioned glyph runs, the way the text engine lays out a line (docs/text-engine.md):
 *
 *  1. bidi levels for the line (UAX #9 with the paragraph direction, rule L1 for trailing white space);
 *  2. runs of one font (first font of the face's stack that covers the cluster), one script and one level;
 *  3. HarfBuzz shaping; an Arabic word split across two styles (a bold letter) is shaped with a joiner on each side so
 *     the letters keep their joined forms;
 *  4. visual order (rule L2), optional justification (Arabic kashida first, then spaces), glyph positions.
 *
 * The result is drawn by the PDF writer through the engine's emitter (ops.ts), which writes ToUnicode and, for
 * right-to-left and mixed lines, an /ActualText span with the logical text of the whole line.
 */

export interface DrawStyle {
  face: Face
  size: number
  color: Hex
  /** Baseline shift in points, positive = up (superscript). */
  rise?: number
  /** Extra space after every character (not applied to cursive scripts). */
  letterSpacing?: number
}

export interface LineItem {
  text: string
  style: DrawStyle
  /** A fixed-width object (inline picture): drawn by the caller, takes part in the bidi reordering as a neutral. */
  gap?: number
}

export interface ShapedLine {
  /** Logical text of the line (item texts concatenated; gaps are U+FFFC). Glyph clusters index into it. */
  text: string
  /** Glyph runs in visual order, x relative to the line's left edge. */
  runs: GlyphRun[]
  width: number
  /** Per item: its visual pieces (x from the line's left edge, width). */
  items: { pieces: { x: number; w: number }[] }[]
  rtl: boolean
}

/** A line of shaped glyphs placed on a page: `x` is the left edge, `y` the baseline (display list, y down). */
export interface GlyphOp {
  t: 'glyphs'
  x: number
  y: number
  /** Width of the line (for mirroring). */
  w: number
  text: string
  runs: GlyphRun[]
  rtl: boolean
}

const OBJ = '￼'
const ZWJ = '‍'

interface Piece {
  item: number
  s: number
  e: number
  level: number
  run: GlyphRun | null
  width: number
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0')
  return [parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255]
}

/** Arabic letters that join to the following letter (dual-joining) / to the preceding one. */
const isArabicLetter = (cp: number): boolean => (cp >= 0x0620 && cp <= 0x064a) || (cp >= 0x066e && cp <= 0x06d3) || cp === 0x06d5 || (cp >= 0x06fa && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0x08a0 && cp <= 0x08c7) || cp === 0x0640
const joinsContext = (cp: number | undefined): boolean => cp !== undefined && (isArabicLetter(cp) || cp === 0x200d || /\p{Mn}/u.test(String.fromCodePoint(cp)))

/** Paragraph direction from the first strong character (UAX #9 P2/P3). */
export function firstStrongRtl(text: string): boolean | null {
  const m = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-ࣿיִ-﷿ﹰ-ﻼ]|[ऀ-෿฀-໿぀-鿿가-힯]/.exec(text)
  if (!m) return null
  const cp = m[0].codePointAt(0)!
  return (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfefc)
}

/** True if the text contains right-to-left characters. */
export const hasRtlText = (s: string): boolean => /[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(s)

/**
 * Shape one line. `dir`: the paragraph direction (`auto` = first strong character). With `justify`, the line is
 * stretched to that width (kashida in Arabic words first, then the spaces).
 */
export function shapeLine(cat: FontCatalog, items: LineItem[], dir: 'ltr' | 'rtl' | 'auto', justify?: number): ShapedLine {
  let text = ''
  const starts: number[] = []
  for (const it of items) {
    starts.push(text.length)
    text += it.gap !== undefined ? OBJ : it.text
  }
  const n = text.length
  const direction = dir === 'auto' ? (firstStrongRtl(text) ? 'rtl' : 'ltr') : dir
  const info = analyzeBidi(text, direction)
  const paraLevel = direction === 'rtl' ? 1 : 0
  const levels = n ? lineLevels(info, 0, n, paraLevel) : new Uint8Array(0)
  const scripts = resolveScripts(text)
  const pieces: Piece[] = []

  items.forEach((it, idx) => {
    const s0 = starts[idx]!
    if (it.gap !== undefined) {
      pieces.push({ item: idx, s: s0, e: s0 + 1, level: levels[s0] ?? paraLevel, run: null, width: it.gap })
      return
    }
    const e0 = s0 + it.text.length
    if (e0 <= s0) return
    // font/script runs, further split at level changes
    const segs: { s: number; e: number; entry: ReturnType<FontCatalog['fontRuns']>[number]['entry']; script: string; level: number }[] = []
    for (const fr of cat.fontRuns(it.style.face, text, s0, e0, scripts)) {
      let a = fr.s
      while (a < fr.e) {
        const lv = levels[a]!
        let b = a + 1
        while (b < fr.e && levels[b] === lv) b++
        segs.push({ s: a, e: b, entry: fr.entry, script: fr.script, level: lv })
        a = b
      }
    }
    for (const sg of segs) pieces.push(shapePiece(cat, it, idx, text, sg))
  })

  // visual order and positions
  const order = reorderVisual(pieces.map((p) => p.level))
  const visual = order.map((i) => pieces[i]!)
  const runs = visual.filter((p) => p.run).map((p) => p.run!)
  if (justify !== undefined) {
    const contentW = visual.reduce((s, p) => s + p.width, 0)
    let extra = justify - contentW
    if (extra > 0.01) {
      const line: Line = { runs, y: 0, x: 0, width: contentW, height: 0, baseline: 0, ascent: 0, descent: 0, textStart: 0, textEnd: n, rtl: direction === 'rtl', last: false, paragraph: 0 }
      extra -= kashidaJustify(line, extra, text)
      const spaces: LayoutGlyph[] = []
      for (const r of runs) for (const g of r.glyphs) if (g.space) spaces.push(g)
      if (extra > 0.01 && spaces.length) for (const g of spaces) g.advance += extra / spaces.length
      for (const p of visual) if (p.run) p.width = p.run.glyphs.reduce((s, g) => s + g.advance, 0)
    }
  }
  const outItems: ShapedLine['items'] = items.map(() => ({ pieces: [] }))
  let pen = 0
  for (const p of visual) {
    if (p.run) {
      p.run.x = pen
      let gx = pen
      for (const g of p.run.glyphs) {
        g.x = gx + g.dx
        gx += g.advance
      }
      p.run.width = gx - pen
      p.width = p.run.width
    }
    outItems[p.item]!.pieces.push({ x: pen, w: p.width })
    pen += p.width
  }
  return { text, runs, width: pen, items: outItems, rtl: direction === 'rtl' }
}

function shapePiece(cat: FontCatalog, it: LineItem, idx: number, text: string, sg: { s: number; e: number; entry: Parameters<FontCatalog['fontOf']>[0]; script: string; level: number }): Piece {
  const st = it.style
  const size = st.size * sg.entry.scale
  const rtl = (sg.level & 1) === 1
  const font = cat.fontOf(sg.entry)
  const style: ResolvedStyle = {
    size,
    color: hexRgb(st.color),
    opacity: 1,
    letterSpacing: 0,
    wordSpacing: 0,
    underline: false,
    strike: false,
    rise: st.rise ?? 0,
    synthBold: sg.entry.synthBold,
    synthItalic: sg.entry.synthItalic
  }
  if (!font) {
    // provisional (font not loaded yet; the pass is re-run): width only
    return { item: idx, s: sg.s, e: sg.e, level: sg.level, run: null, width: (sg.e - sg.s) * 0.55 * size }
  }
  const scale = size / font.upem
  // Joining context across a style boundary inside an Arabic word (the text is otherwise shaped word by word).
  const before = sg.s > 0 ? text.codePointAt(sg.s - 1) : undefined
  const after = sg.e < text.length ? text.codePointAt(sg.e) : undefined
  const arabic = sg.script === 'Arab'
  const pre = arabic && joinsContext(before) && isArabicLetter(text.codePointAt(sg.s) ?? 0)
  const post = arabic && joinsContext(after) && sg.e > sg.s && isArabicLetter(lastCp(text, sg.s, sg.e))
  const ls = CURSIVE_SCRIPTS.has(sg.script) ? 0 : (st.letterSpacing ?? 0)
  const glyphs: LayoutGlyph[] = []
  // shape word by word (spaces separately), like the engine: cache-friendly, no false kerning across spaces
  const words: { s: number; e: number; space: boolean }[] = []
  for (let i = sg.s; i < sg.e; ) {
    let j = i + 1
    const sp = text.charCodeAt(i) === 0x20
    while (j < sg.e && (text.charCodeAt(j) === 0x20) === sp) j++
    words.push({ s: i, e: j, space: sp })
    i = j
  }
  const ordered = rtl ? words.slice().reverse() : words
  for (const w of ordered) {
    const first = w === words[0]
    const last = w === words[words.length - 1]
    const lead = first && pre ? ZWJ : ''
    const trail = last && post ? ZWJ : ''
    const src = lead + text.slice(w.s, w.e) + trail
    const sr = shapeText({ font, rtl, script: sg.script, lang: arabic ? 'ar' : undefined, features: ls ? { liga: false, clig: false } : undefined }, src)
    const base = glyphs.length
    for (let k = 0; k < sr.length; k++) {
      const local = sr.cluster[k]! - lead.length
      if (local < 0 || local >= w.e - w.s) continue // a context joiner
      const cluster = w.s + local
      const cp = text.codePointAt(cluster)!
      if (isDefaultIgnorable(cp)) continue // joiners, bidi marks: shaping only, nothing to draw
      let adv = sr.ax[k]! * scale
      if (adv !== 0 && ls) adv += ls
      glyphs.push({ gid: sr.gid[k]!, cluster, chars: 0, advance: adv, natural: sr.ax[k]! * scale, x: 0, y: -(sr.dy[k]! * scale) - (st.rise ?? 0), dx: sr.dx[k]! * scale, dy: -(sr.dy[k]! * scale), ...(w.space ? { space: true } : {}) })
    }
    // characters per glyph: the first glyph (in logical order) of each cluster carries the text up to the next cluster
    const seg = glyphs.slice(base)
    const clusters = [...new Set(seg.map((g) => g.cluster))].sort((a, b) => a - b)
    const next = new Map<number, number>()
    clusters.forEach((c, i) => next.set(c, i + 1 < clusters.length ? clusters[i + 1]! : w.e))
    const seen = new Set<number>()
    for (const g of rtl ? seg.slice().reverse() : seg) {
      if (!seen.has(g.cluster)) {
        seen.add(g.cluster)
        g.chars = next.get(g.cluster)! - g.cluster
      }
    }
  }
  const width = glyphs.reduce((s, g) => s + g.advance, 0)
  const run: GlyphRun = { font, size, glyphs, x: 0, width, level: sg.level, rtl, script: sg.script, lang: arabic ? 'ar' : undefined, textStart: sg.s, textEnd: sg.e, style, hanging: false }
  return { item: idx, s: sg.s, e: sg.e, level: sg.level, run: glyphs.length ? run : null, width }
}

function lastCp(text: string, s: number, e: number): number {
  const c = text.charCodeAt(e - 1)
  if (c >= 0xdc00 && c <= 0xdfff && e - 2 >= s) return text.codePointAt(e - 2)!
  return c
}

/** A glyph op for a shaped line whose left edge is at `x` and baseline at `y`. */
export function glyphOp(line: ShapedLine, x: number, y: number): GlyphOp {
  return { t: 'glyphs', x, y, w: line.width, text: line.text, runs: line.runs, rtl: line.rtl }
}

/** Joins shaped segments of one line (tab-separated parts placed by the caller) into one op: one ActualText per line. */
export function joinSegments(parts: { line: ShapedLine; x: number }[], y: number, rtl: boolean): GlyphOp | null {
  if (!parts.length) return null
  if (parts.length === 1) return glyphOp(parts[0]!.line, parts[0]!.x, y)
  let text = ''
  const runs: GlyphRun[] = []
  const minX = Math.min(...parts.map((p) => p.x))
  const maxX = Math.max(...parts.map((p) => p.x + p.line.width))
  // logical order of the parts is the order given; the text gets a space between parts (the tab)
  parts.forEach((p, i) => {
    if (i > 0) text += ' '
    const off = text.length
    text += p.line.text
    const dx = p.x - minX
    for (const r of p.line.runs) {
      runs.push({ ...r, x: r.x + dx, textStart: r.textStart + off, textEnd: r.textEnd + off, glyphs: r.glyphs.map((g) => ({ ...g, x: g.x + dx, cluster: g.cluster + off })) })
    }
  })
  runs.sort((a, b) => a.x - b.x)
  return { t: 'glyphs', x: minX, y, w: maxX - minX, text, runs, rtl }
}
