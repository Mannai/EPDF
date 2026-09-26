import { analyzeBidi, lineLevels, reorderVisual, type BidiInfo } from './bidi'
import { loadHarfBuzz } from './hb'
import { resolveStack, type FontCandidate, type TextFont } from './fonts'
import { BREAK_ALLOWED, BREAK_MANDATORY, lineBreakOpportunities } from './linebreak'
import { CURSIVE_SCRIPTS, guessCjkLang, isDefaultIgnorable, isCommonCodePoint, prefersEmoji, resolveScripts } from './script'
import { shapeText, type FeatureSettings } from './shape'
import type { Align, GlyphRun, Line, LayoutGlyph, MissingChar, ParagraphLayout, ParagraphOptions, ResolvedStyle, Span, TextStyle } from './types'
import { kashidaJustify } from './kashida'

/**
 * Paragraph layout: itemization (bidi levels, scripts, fonts with per-cluster fallback, styles) -> shaping ->
 * line breaking -> bidi line reordering -> alignment/justification -> positioned glyph runs.
 *
 * Coordinates: layout units are PDF points; x grows to the right and y DOWN from the top of the paragraph.
 * Glyph `x` is the glyph origin relative to the line start; `y` is relative to the baseline (positive = down).
 */

const DEFAULT_SIZE = 12
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

interface StyleInfo {
  style: ResolvedStyle
  features: FeatureSettings | undefined
  lang: string | undefined
  cands: FontCandidate[]
  strutFont?: TextFont
}

interface PlanRun {
  /** Paragraph-relative UTF-16 range. */
  s: number
  e: number
  level: number
  script: string
  styleIdx: number
  cand: FontCandidate
  font: TextFont
  synthBold: boolean
  synthItalic: boolean
}

interface LGlyph {
  gid: number
  /** Paragraph-relative cluster start. */
  cluster: number
  chars: number
  advance: number
  natural: number
  dx: number
  dy: number
  tab: boolean
  space: boolean
}

interface LRun {
  plan: PlanRun
  info: StyleInfo
  style: ResolvedStyle
  /** Glyphs in visual (left-to-right) order for the run. */
  glyphs: LGlyph[]
  lang?: string
}

interface ParaPlan {
  start: number
  end: number
  info: BidiInfo
  level: number
  runs: PlanRun[]
}

const TERMINATORS = new RegExp('\\r\\n|[\\n\\r' + String.fromCharCode(0x2028, 0x2029) + '\\u000b\\u000c\\u0085]', 'g')

/** Split text into paragraphs [start, end) at newline characters. */
export function splitParagraphs(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let start = 0
  TERMINATORS.lastIndex = 0
  for (let m = TERMINATORS.exec(text); m; m = TERMINATORS.exec(text)) {
    out.push({ start, end: m.index })
    start = m.index + m[0].length
  }
  out.push({ start, end: text.length })
  return out
}

function isControl(cp: number): boolean {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)
}

function flatten(input: string | Span[], base: ParagraphOptions): { text: string; ranges: { start: number; end: number; style: TextStyle }[] } {
  if (typeof input === 'string') return { text: input, ranges: [{ start: 0, end: input.length, style: base }] }
  let text = ''
  const ranges: { start: number; end: number; style: TextStyle }[] = []
  for (const span of input) {
    const start = text.length
    text += span.text
    ranges.push({ start, end: text.length, style: { ...base, ...definedOnly(span) } })
  }
  if (ranges.length === 0) ranges.push({ start: 0, end: 0, style: base })
  return { text, ranges }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'text') out[k] = v
  return out as Partial<T>
}

/** Approximate check whether a font stack entry list changed between two style objects. */
async function buildStyleInfo(style: TextStyle, paraLang: string | undefined): Promise<StyleInfo> {
  const size = style.size ?? DEFAULT_SIZE
  const lang = style.lang ?? paraLang
  const cands = await resolveStack({ fontStack: style.fontStack, weight: style.weight, italic: style.italic, lang })
  const resolved: ResolvedStyle = {
    size,
    color: style.color ?? 0,
    opacity: style.opacity ?? 1,
    letterSpacing: style.letterSpacing ?? 0,
    wordSpacing: style.wordSpacing ?? 0,
    underline: style.underline ?? false,
    strike: style.strike ?? false,
    rise: style.rise ?? 0,
    synthBold: false,
    synthItalic: false
  }
  return { style: resolved, features: style.features, lang: style.lang, cands }
}

/** Layout `input` (a string or styled spans). Loads HarfBuzz and the fonts it needs on first use. */
export async function layoutParagraph(input: string | Span[], options: ParagraphOptions = {}): Promise<ParagraphLayout> {
  await loadHarfBuzz()
  const { text, ranges } = flatten(input, options)
  const paras = splitParagraphs(text)
  const wantLang = options.lang ?? (/[぀-ヿ가-힯一-鿿㐀-䶿]/.test(text) ? guessCjkLang(text) : undefined)

  // ---- styles ---------------------------------------------------------------------------------------------
  const styleInfos: StyleInfo[] = []
  const styleOf = new Map<TextStyle, number>()
  const styleAt = new Uint16Array(text.length + 1)
  for (const r of ranges) {
    let idx = styleOf.get(r.style)
    if (idx === undefined) {
      idx = styleInfos.length
      styleOf.set(r.style, idx)
      styleInfos.push(await buildStyleInfo(r.style, wantLang))
    }
    styleAt.fill(idx, r.start, r.end)
  }
  styleAt[text.length] = styleAt[Math.max(0, text.length - 1)] ?? 0
  const baseInfo = styleInfos[0] ?? (await buildStyleInfo(options, wantLang))
  if (styleInfos.length === 0) styleInfos.push(baseInfo)

  const missing: MissingChar[] = []

  // ---- phase 1 (sync): bidi, scripts, itemization ----------------------------------------------------------
  const plans: ParaPlan[] = paras.map((p) => planParagraph(text, p.start, p.end, options, styleInfos, styleAt, missing))
  if (options.onMissing === 'throw' && missing.length) {
    const chars = [...new Set(missing.map((m) => m.char))]
    throw new Error(`No font covers these characters: ${chars.slice(0, 10).join(' ')}${chars.length > 10 ? ' ...' : ''}`)
  }

  // ---- load the fonts the plans use --------------------------------------------------------------------------
  const wanted = new Map<string, FontCandidate>()
  for (const plan of plans) for (const r of plan.runs) wanted.set(r.cand.id, r.cand)
  for (const si of styleInfos) if (si.cands[0]) wanted.set(si.cands[0].id, si.cands[0])
  const loaded = new Map<string, TextFont>()
  await Promise.all([...wanted].map(async ([id, c]) => loaded.set(id, await c.load())))
  for (const plan of plans) for (const r of plan.runs) r.font = loaded.get(r.cand.id)!
  for (const si of styleInfos) if (si.cands[0]) si.strutFont = loaded.get(si.cands[0].id)

  // ---- phase 2 (sync): shape, break, position --------------------------------------------------------------
  return buildLayout(text, plans, styleInfos, options, missing)
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 1

function planParagraph(text: string, start: number, end: number, options: ParagraphOptions, styleInfos: StyleInfo[], styleAt: Uint16Array, missing: MissingChar[]): ParaPlan {
  const ptext = text.slice(start, end)
  const info = analyzeBidi(ptext, options.direction ?? 'auto')
  const level = info.paragraphs[0]?.level ?? 0
  const runs: PlanRun[] = []
  if (ptext.length === 0) return { start, end, info, level, runs }
  const scripts = resolveScripts(ptext)

  const ascii = /^[\x20-\x7e]*$/.test(ptext)
  let prevStyle = -1
  let prevCand: FontCandidate | undefined
  let cur: PlanRun | null = null

  const handle = (s: number, e: number): void => {
    const styleIdx = styleAt[start + s]!
    const si = styleInfos[styleIdx]!
    const scriptTag = scripts.tags[scripts.ids[s]!]!
    // Collect the code points that need a glyph.
    let cand: FontCandidate | undefined
    const needed: number[] = []
    let hasVs16 = false
    for (let i = s; i < e; ) {
      const cp = ptext.codePointAt(i)!
      i += cp > 0xffff ? 2 : 1
      if (cp === 0xfe0f) hasVs16 = true
      if (!isDefaultIgnorable(cp) && !(isControl(cp) && cp !== 0x09)) needed.push(cp)
    }
    if (needed.length === 0 || (needed.length === 1 && needed[0] === 0x09)) {
      cand = prevStyle === styleIdx && prevCand ? prevCand : si.cands[0]
    } else {
      const common = isCommonCodePoint(needed[0]!)
      const sticky = common && prevStyle === styleIdx && prevCand && needed.every((cp) => prevCand!.covers(cp))
      if (sticky) cand = prevCand
      else {
        const emojiFirst = prefersEmoji(needed[0]!, hasVs16)
        const order = emojiFirst ? [...si.cands.filter((c) => c.category === 'emoji'), ...si.cands.filter((c) => c.category !== 'emoji')] : si.cands
        cand = order.find((c) => needed.every((cp) => c.covers(cp)))
        if (!cand) {
          cand = order.find((c) => c.covers(needed[0]!)) ?? si.cands[0]
          for (const cp of needed) {
            if (!cand || !cand.covers(cp)) missing.push({ index: start + s + ptext.slice(s, e).indexOf(String.fromCodePoint(cp)), char: String.fromCodePoint(cp), codePoint: cp })
          }
        }
      }
    }
    if (!cand) throw new Error('The font stack is empty')
    prevStyle = styleIdx
    prevCand = cand
    const lv = info.levels[s]!
    if (cur && cur.e === s && cur.level === lv && cur.script === scriptTag && cur.styleIdx === styleIdx && cur.cand === cand) {
      cur.e = e
    } else {
      cur = { s, e, level: lv, script: scriptTag, styleIdx, cand, font: undefined as unknown as TextFont, synthBold: cand.synthBold, synthItalic: cand.synthItalic }
      runs.push(cur)
    }
  }

  if (ascii) {
    for (let i = 0; i < ptext.length; i++) handle(i, i + 1)
  } else {
    for (const seg of graphemeSegmenter.segment(ptext)) handle(seg.index, seg.index + seg.segment.length)
  }
  return { start, end, info, level, runs }
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 2

function isHangingSpace(ch: number): boolean {
  return ch === 0x20
}

function shapeRun(plan: PlanRun, info: StyleInfo, ptext: string, paraStart: number, wantLang: string | undefined): LRun {
  void paraStart
  const font = plan.font
  const size = info.style.size
  const scale = size / font.upem
  const rtl = (plan.level & 1) === 1
  const cursive = CURSIVE_SCRIPTS.has(plan.script)
  const ls = cursive ? 0 : info.style.letterSpacing
  const ws = info.style.wordSpacing
  let features = info.features
  if (ls !== 0) {
    const base = typeof features === 'string' ? Object.fromEntries(features.split(',').map((p) => [p.split('=')[0]!.trim(), p.includes('=') ? Number(p.split('=')[1]) : 1])) : { ...(features ?? {}) }
    if (base.liga === undefined) base.liga = false
    if (base.clig === undefined) base.clig = false
    features = base
  }
  const isCjk = plan.script === 'Hani' || plan.script === 'Hira' || plan.script === 'Kana' || plan.script === 'Hang'
  const lang = info.lang ?? (isCjk ? wantLang : undefined)

  // Segments: words, runs of spaces and single tabs (shaped separately: cache-friendly and no false kerning).
  const segs: { s: number; e: number; kind: 'w' | 's' | 't' }[] = []
  let i = plan.s
  while (i < plan.e) {
    const c = ptext.charCodeAt(i)
    let j = i + 1
    if (c === 0x09) segs.push({ s: i, e: j, kind: 't' })
    else if (c === 0x20) {
      while (j < plan.e && ptext.charCodeAt(j) === 0x20) j++
      segs.push({ s: i, e: j, kind: 's' })
    } else {
      while (j < plan.e) {
        const d = ptext.charCodeAt(j)
        if (d === 0x20 || d === 0x09) break
        j++
      }
      segs.push({ s: i, e: j, kind: 'w' })
    }
    i = j
  }
  const ordered = rtl ? segs.slice().reverse() : segs
  const glyphs: LGlyph[] = []
  for (const seg of ordered) {
    if (seg.kind === 't') {
      const gid = font.glyphFor(0x20)
      glyphs.push({ gid, cluster: seg.s, chars: 1, advance: font.advanceOf(gid) * scale, natural: font.advanceOf(gid) * scale, dx: 0, dy: 0, tab: true, space: false })
      continue
    }
    const sr = shapeText({ font, rtl, script: plan.script, lang, features }, ptext.slice(seg.s, seg.e))
    const base = glyphs.length
    for (let k = 0; k < sr.length; k++) {
      const cluster = seg.s + sr.cluster[k]!
      const isSpace = seg.kind === 's'
      let adv = sr.ax[k]! * scale
      if (adv !== 0) {
        adv += ls
        if (isSpace) adv += ws
      }
      glyphs.push({ gid: sr.gid[k]!, cluster, chars: 0, advance: adv, natural: sr.ax[k]! * scale, dx: sr.dx[k]! * scale, dy: sr.dy[k]! * scale, tab: false, space: isSpace })
    }
    // chars per glyph: distance to the next larger cluster within the segment (source order)
    const clusters = new Set<number>()
    for (let k = base; k < glyphs.length; k++) clusters.add(glyphs[k]!.cluster)
    const sorted = [...clusters].sort((a, b) => a - b)
    const next = new Map<number, number>()
    for (let k = 0; k < sorted.length; k++) next.set(sorted[k]!, k + 1 < sorted.length ? sorted[k + 1]! : seg.e)
    const seen = new Set<number>()
    // the first glyph of a cluster in source order carries the characters
    const order = glyphs.slice(base)
    if (rtl) order.reverse()
    for (const g of order) {
      if (!seen.has(g.cluster)) {
        seen.add(g.cluster)
        g.chars = next.get(g.cluster)! - g.cluster
      }
    }
  }
  return { plan, info, style: { ...info.style, synthBold: plan.synthBold, synthItalic: plan.synthItalic }, glyphs, lang }
}

function alignOf(a: Align | undefined, rtl: boolean): 'left' | 'right' | 'center' | 'justify' {
  switch (a) {
    case 'center':
      return 'center'
    case 'justify':
      return 'justify'
    case 'left':
    case 'right':
      return a
    case 'end':
      return rtl ? 'left' : 'right'
    default:
      return rtl ? 'right' : 'left'
  }
}

interface Piece {
  run: LRun
  glyphs: LGlyph[] // visual order
  level: number
  hanging: boolean
  textStart: number
  textEnd: number
  width: number
}

function buildLayout(text: string, plans: ParaPlan[], styleInfos: StyleInfo[], options: ParagraphOptions, missing: MissingChar[]): ParagraphLayout {
  const boxWidth = options.width
  const lines: Line[] = []
  const directions: ('ltr' | 'rtl')[] = []
  const wantLang = options.lang
  const tabSize = options.tabSize ?? 8
  let y = 0
  let maxWidth = 0
  const maxLines = options.maxLines && options.maxLines > 0 ? options.maxLines : Infinity
  let truncated = false

  for (let pi = 0; pi < plans.length; pi++) {
    const plan = plans[pi]!
    const rtl = (plan.level & 1) === 1
    directions.push(rtl ? 'rtl' : 'ltr')
    const ptext = text.slice(plan.start, plan.end)
    const baseInfo = styleInfos[0]!
    const lrunsAll: LRun[] = plan.runs.map((r) => shapeRun(r, styleInfos[r.styleIdx]!, ptext, plan.start, options.lang ?? wantLang))

    // Per-index tables for breaking.
    const n = ptext.length
    const isStart = new Uint8Array(n + 1)
    const adv = new Float64Array(n + 1)
    const tabAt = new Uint8Array(n + 1)
    for (const lr of lrunsAll) {
      for (const g of lr.glyphs) {
        isStart[g.cluster] = 1
        adv[g.cluster]! += g.advance
        if (g.tab) tabAt[g.cluster] = 1
      }
    }
    // Characters without a glyph of their own inside a cluster are not break points; also make sure every
    // character that produced no glyph at all (removed by the shaper) does not become a break point.
    const bo = lineBreakOpportunities(ptext, { lang: options.lang ?? wantLang, wordBreak: options.wordBreak })
    const strutInfo = baseInfo
    const spaceAdv = strutInfo.strutFont ? strutInfo.strutFont.advanceOf(strutInfo.strutFont.glyphFor(0x20)) * (strutInfo.style.size / strutInfo.strutFont.upem) : strutInfo.style.size * 0.25
    const tabStop = Math.max(1, tabSize * spaceAdv)
    const nextTab = (x: number): number => (Math.floor((x + 1e-6) / tabStop) + 1) * tabStop

    // ---- greedy line breaking ------------------------------------------------------------------------------
    const lineRanges: { a: number; b: number; last: boolean }[] = []
    if (n === 0) lineRanges.push({ a: 0, b: 0, last: true })
    else {
      let a = 0
      while (a < n) {
        let x = 0
        let contentEnd = 0
        let cand = -1
        let end = -1
        let last = false
        let i = a
        while (i < n) {
          if (!isStart[i]) {
            i++
            continue
          }
          if (i > a) {
            if (bo[i] === BREAK_MANDATORY) {
              end = i
              break
            }
            if (bo[i] === BREAK_ALLOWED) cand = i
          }
          let w = adv[i]!
          if (tabAt[i]) w = nextTab(x) - x
          const hang = isHangingSpace(ptext.charCodeAt(i))
          const newX = x + w
          const newContent = hang ? contentEnd : newX
          if (boxWidth !== undefined && newContent > boxWidth + 1e-6) {
            if (cand > a) {
              end = cand
              break
            }
            if (i > a && options.breakLongWords !== false && !hang) {
              end = i
              break
            }
          }
          x = newX
          contentEnd = newContent
          i++
        }
        if (end < 0) {
          end = n
          last = true
        }
        lineRanges.push({ a, b: end, last })
        a = end
        if (last) break
      }
    }

    // ---- lines ---------------------------------------------------------------------------------------------
    for (const lr of lineRanges) {
      if (lines.length >= maxLines) {
        truncated = true
        break
      }
      const line = assembleLine(lr.a, lr.b, lr.last, plan, ptext, lrunsAll, styleInfos, options, rtl, nextTab, pi)
      line.y = y
      y += line.height
      lines.push(line)
      if (line.width > maxWidth) maxWidth = line.width
    }
    if (truncated) break
  }

  // Alignment when no box width was given: relative to the widest line.
  const box = boxWidth ?? maxWidth
  for (const line of lines) placeLine(line, box, options)

  const layout: ParagraphLayout = { text, lines, width: maxWidth, height: y, boxWidth, missing, directions, truncated }
  // Translate paragraph-relative indices to global ones.
  return finalizeIndices(layout, plans)
}

/** Convert paragraph-relative cluster/text indices in lines to global source indices. */
function finalizeIndices(layout: ParagraphLayout, plans: ParaPlan[]): ParagraphLayout {
  for (const line of layout.lines) {
    const off = plans[line.paragraph]!.start
    if (off === 0) continue
    line.textStart += off
    line.textEnd += off
    for (const run of line.runs) {
      run.textStart += off
      run.textEnd += off
      for (const g of run.glyphs) g.cluster += off
    }
  }
  return layout
}

function assembleLine(
  a: number,
  b: number,
  last: boolean,
  plan: ParaPlan,
  ptext: string,
  lruns: LRun[],
  styleInfos: StyleInfo[],
  options: ParagraphOptions,
  rtl: boolean,
  nextTab: (x: number) => number,
  paragraph: number
): Line {
  // Hanging trailing spaces.
  let h = b
  while (h > a && isHangingSpace(ptext.charCodeAt(h - 1))) h--
  const levels = lineLevels(plan.info, a, b, plan.level)
  const pieces: Piece[] = []
  for (const lr of lruns) {
    if (lr.plan.e <= a || lr.plan.s >= b) continue
    const rrtl = (lr.plan.level & 1) === 1
    const logical = (rrtl ? lr.glyphs.slice().reverse() : lr.glyphs).filter((g) => g.cluster >= a && g.cluster < b)
    let cur: LGlyph[] = []
    let curLevel = -1
    let curHang = false
    const flush = (): void => {
      if (!cur.length) return
      const gl = curLevel & 1 ? cur.slice().reverse() : cur
      const cl = cur.map((g) => g.cluster)
      pieces.push({ run: lr, glyphs: gl, level: curLevel, hanging: curHang, textStart: Math.min(...cl), textEnd: 0, width: 0 })
      cur = []
    }
    for (const g of logical) {
      const lv = levels[g.cluster - a]!
      const hang = g.cluster >= h
      if (cur.length && (lv !== curLevel || hang !== curHang)) flush()
      curLevel = lv
      curHang = hang
      cur.push(g)
    }
    flush()
  }
  // Text ranges of pieces: from their first cluster to the next piece's first cluster (logical order).
  pieces.forEach((p, i) => {
    p.textEnd = i + 1 < pieces.length ? pieces[i + 1]!.textStart : b
  })
  // Visual order.
  const order = reorderVisual(pieces.map((p) => p.level))
  const visual = order.map((i) => pieces[i]!)

  // Widths (tabs: advance to the next stop measured from the line start).
  let pen = 0
  for (const p of visual) {
    const start = pen
    for (const g of p.glyphs) {
      if (g.tab) g.advance = nextTab(pen) - pen
      pen += g.advance
    }
    p.width = pen - start
  }
  const contentWidth = visual.filter((p) => !p.hanging).reduce((s, p) => s + p.width, 0)

  // Vertical metrics: strut of the paragraph style + every run.
  let ascent = 0
  let descent = 0
  const consider = (font: TextFont, size: number): void => {
    const A = (font.ascent * size) / font.upem
    const D = (font.descent * size) / font.upem
    const G = (font.lineGap * size) / font.upem
    let top: number
    let bottom: number
    if (options.lineHeight === undefined && options.lineSpacing === undefined) {
      top = A + G / 2
      bottom = D + G / 2
    } else {
      const L = options.lineHeight ?? options.lineSpacing! * size
      const half = (L - (A + D)) / 2
      top = A + half
      bottom = D + half
    }
    if (top > ascent) ascent = top
    if (bottom > descent) descent = bottom
  }
  const strut = styleInfos[0]!
  if (strut.strutFont) consider(strut.strutFont, strut.style.size)
  for (const p of visual) consider(p.run.plan.font, p.run.style.size)
  if (ascent + descent === 0) {
    ascent = strut.style.size * 0.9
    descent = strut.style.size * 0.25
  }

  const line: Line = {
    runs: [],
    y: 0,
    x: 0,
    width: contentWidth,
    height: ascent + descent,
    baseline: ascent,
    ascent,
    descent,
    textStart: a,
    textEnd: b,
    rtl,
    last,
    paragraph
  }
  // Materialise runs; positions are filled by placeLine (needs the alignment box).
  for (const p of visual) {
    const size = p.run.style.size
    const glyphs: LayoutGlyph[] = p.glyphs.map((g) => ({
      gid: g.gid,
      cluster: g.cluster,
      chars: g.chars,
      advance: g.advance,
      natural: g.natural,
      x: 0,
      y: -g.dy - p.run.style.rise,
      dx: g.dx,
      dy: -g.dy,
      ...(g.tab ? { tab: true } : {}),
      ...(g.space ? { space: true } : {})
    }))
    const run: GlyphRun = {
      font: p.run.plan.font,
      size,
      glyphs,
      x: 0,
      width: p.width,
      level: p.level,
      rtl: (p.level & 1) === 1,
      script: p.run.plan.script,
      lang: p.run.lang,
      textStart: p.textStart,
      textEnd: p.textEnd,
      style: p.run.style,
      hanging: p.hanging
    }
    line.runs.push(run)
  }
  return line
}

/** Alignment, justification and final glyph x positions of one line inside a box of width `box`. */
function placeLine(line: Line, box: number, options: ParagraphOptions): void {
  const align = alignOf(options.align, line.rtl)
  const hangW = line.runs.filter((r) => r.hanging).reduce((s, r) => s + r.width, 0)
  let extra = 0
  if (align === 'justify' && (!line.last || options.justifyLast) && box > line.width + 0.01) {
    extra = box - line.width
    const used = options.kashida !== false ? kashidaJustify(line, extra) : 0
    extra -= used
    // remaining slack goes to the spaces (or between characters when there are none)
    const spaces: LayoutGlyph[] = []
    for (const run of line.runs) if (!run.hanging) for (const g of run.glyphs) if (g.space) spaces.push(g)
    if (extra > 0.01) {
      if (spaces.length > 0) {
        const per = extra / spaces.length
        for (const g of spaces) g.advance += per
        extra = 0
      } else {
        // scripts without spaces (CJK/Thai): stretch between clusters
        const gs: LayoutGlyph[] = []
        for (const run of line.runs) if (!run.hanging) for (const g of run.glyphs) gs.push(g)
        const gaps = gs.filter((g) => g.advance > 0)
        if (gaps.length > 1) {
          const per = extra / (gaps.length - 1)
          for (let i = 0; i < gaps.length - 1; i++) gaps[i]!.advance += per
          extra = 0
        }
      }
    }
    line.width = box - extra
  }
  // Recompute run widths and positions.
  let contentW = 0
  for (const run of line.runs) {
    let w = 0
    for (const g of run.glyphs) w += g.advance
    run.width = w
    if (!run.hanging) contentW += w
  }
  line.width = contentW
  let startX: number
  const free = box - contentW
  if (align === 'right') startX = free
  else if (align === 'center') startX = free / 2
  else startX = 0
  if (align === 'justify') startX = line.rtl ? free : 0
  // Hanging spaces sit on the end side of the content.
  const firstHang = line.runs.findIndex((r) => r.hanging)
  const hangsFirst = firstHang === 0 && line.runs[0]!.hanging && line.rtl
  line.x = startX
  let pen = startX - (hangsFirst ? hangW : 0)
  for (const run of line.runs) {
    run.x = pen
    let px = pen
    for (const g of run.glyphs) {
      g.x = px + g.dx
      px += g.advance
    }
    pen += run.width
  }
}
