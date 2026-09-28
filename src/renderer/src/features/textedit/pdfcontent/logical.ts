import type { PDFDocument } from 'pdf-lib'
import { hasComplexScript, interpretPage, modelFromInterpretation, type Interpretation, type PageTextModel } from '@shared/pagetext'
import { addrKey, type Color, type PageAnalysis, type TextRun } from './analyze'
import type { BlockSet, TextBlock, TextLine } from './blocks'
import type { PdfFont } from './fonts'
import { apply, invert, transformRect, type Matrix, type Rect } from './matrix'

/**
 * Logical (reading-order) text blocks for right-to-left and complex-script lines.
 *
 * The editor's own line builder (blocks.ts) reads text in the order it is stored in the content stream and groups runs
 * by baseline, which is fine for Latin text but not for Arabic, Hebrew or Indic text: producers store it in visual
 * order, draw vowel marks on displaced baselines, split words into many runs and often use glyphs whose Unicode value
 * only the font program or an /ActualText span knows. The page text model (src/shared/pagetext, docs/page-text.md)
 * already reads such pages in logical order; this module maps each of its lines back to the content-stream glyphs
 * that draw it, so the whole line (or a paragraph of such lines) can be edited as the text a person reads:
 *
 *   interpretation glyphs  <-- same origin in display space -->  editor glyphs (run + glyph index = stream location)
 *   model.glyphLine[glyph] = the logical line a glyph (or the base glyph a mark was attached to) belongs to
 *
 * A line qualifies when its text has a right-to-left or complex-script character; lines that share a text-showing
 * operation with such a line join it (an operation must be edited as a whole or by glyph). The editor's own blocks
 * that contain any of those operations are replaced by the logical ones.
 */

export type LogicalAlign = 'left' | 'right' | 'center' | 'justify'

export interface LogicalLine {
  /** Index of the line in the page text model. */
  index: number
  text: string
  dir: 'ltr' | 'rtl'
  /** Horizontal extent (advance boxes of its glyphs) and baseline, user space. */
  left: number
  right: number
  baseline: number
  /** Font size in user space. */
  size: number
}

export interface LogicalInfo {
  dir: 'ltr' | 'rtl'
  lines: LogicalLine[]
  /** For every run involved: which of its glyphs belong to the block (true = remove when the block is replaced). */
  cover: Map<TextRun, boolean[]>
  /** Alignment of the block (single lines: the start side of their direction). */
  align: LogicalAlign
  /** Font of most of the block's letters (the document font a replacement should look like). */
  mainFont: PdfFont
  /** Resource name of that font in the block's content source ('(ExtGState font)' when set by `gs`). */
  mainFontName: string
  /** BaseFont of the runs with Latin letters or digits in the block, if any. */
  latinFont?: string
  bold: boolean
  italic: boolean
  renderMode: number
}

const EPS_MATCH = 0.12
const userSize = (r: TextRun): number => r.size * Math.abs(r.matrix[3])
const baselineOf = (r: TextRun): number => r.matrix[5] + r.matrix[3] * r.rise

/** Is building logical blocks worth it for this page (it has text the editor's own reader may not order correctly)? */
export function pageNeedsLogical(analysis: PageAnalysis): boolean {
  for (const r of analysis.runs) {
    if (!r.visible) continue
    if (hasComplexScript(r.text)) return true
    if (r.marked.some((m) => m.hasActualText)) return true
    // eslint-disable-next-line no-control-regex
    if (r.glyphs.some((g) => !g.known || /[\u0000-\u001f]/.test(g.text))) return true
  }
  return false
}

/** Display-space origin of an editor glyph (the interpreter's glyph origin is computed the same way). */
function originOf(run: TextRun, gi: number, display: Matrix): [number, number] {
  const u = apply(run.matrix, run.glyphs[gi].x0, run.rise)
  return apply(display, u[0], u[1])
}

/**
 * For every editor glyph the interpretation glyph at the same origin (or -1). Glyphs at the same point (a mark on its
 * base, fake bold) are told apart by stream order.
 */
function matchGlyphs(runs: TextRun[], ip: Interpretation, display: Matrix): Map<TextRun, Int32Array> {
  const cell = 0.5
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  ip.glyphs.forEach((g, i) => {
    if (g.hidden) return
    const k = key(g.ox, g.oy)
    const l = grid.get(k)
    if (l) l.push(i)
    else grid.set(k, [i])
  })
  const used = new Uint8Array(ip.glyphs.length)
  const out = new Map<TextRun, Int32Array>()
  let last = -1
  for (const run of runs) {
    const m = new Int32Array(run.glyphs.length).fill(-1)
    out.set(run, m)
    if (!run.visible) continue
    for (let gi = 0; gi < run.glyphs.length; gi++) {
      const [x, y] = originOf(run, gi, display)
      const cx = Math.floor(x / cell)
      const cy = Math.floor(y / cell)
      let best = -1
      let bestScore = Infinity
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (used[i]) continue
            const g = ip.glyphs[i]
            const d = Math.hypot(g.ox - x, g.oy - y)
            if (d > EPS_MATCH) continue
            // prefer the next glyph in stream order among glyphs drawn at the same point
            const score = d + (i > last ? (i - last) * 1e-7 : 1 + (last - i) * 1e-7)
            if (score < bestScore) {
              bestScore = score
              best = i
            }
          }
        }
      }
      if (best >= 0) {
        used[best] = 1
        m[gi] = best
        last = best
      }
    }
  }
  return out
}

interface LineBox {
  x0: number
  y0: number
  x1: number
  y1: number
  size: number
}

function modelLineBox(model: PageTextModel, li: number): LineBox {
  const l = model.lines[li]
  return { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, size: l.size }
}

/** Weighted majority. */
function majority<T>(items: Iterable<[T, number]>): T | undefined {
  const m = new Map<T, number>()
  for (const [k, w] of items) m.set(k, (m.get(k) ?? 0) + w)
  let best: T | undefined
  let bw = -Infinity
  for (const [k, w] of m) if (w > bw) [best, bw] = [k, w]
  return best
}

const RTL_OR_COMPLEX = (s: string): boolean => hasComplexScript(s)

export interface LogicalBuild {
  model: PageTextModel
  blocks: BlockSet
}

/**
 * The page's blocks with logical blocks in place of the editor's own ones wherever a line needs them. `blocks` is what
 * `buildBlocks(analysis)` returned; it is not modified.
 */
export function withLogicalBlocks(pdf: PDFDocument, analysis: PageAnalysis, blocks: BlockSet): BlockSet {
  if (!pageNeedsLogical(analysis)) return blocks
  try {
    return buildLogical(pdf, analysis, blocks)
  } catch {
    // Never offer right-to-left text in stored (visual) order: without the logical reading it can't be edited.
    const off = (b: TextBlock): TextBlock =>
      hasComplexScript(b.text) ? { ...b, editable: false, reason: 'its right-to-left or complex-script text could not be read in order' } : b
    return { lines: blocks.lines.map(off), paragraphs: blocks.paragraphs.map(off) }
  }
}

function buildLogical(pdf: PDFDocument, analysis: PageAnalysis, blocks: BlockSet): BlockSet {
  const ip: Interpretation = interpretPage(pdf, analysis.pageIndex)
  const model: PageTextModel = modelFromInterpretation(ip, analysis.pageIndex, { includeHidden: false, glyphLines: true })
  const glyphLine = model.glyphLine
  if (!glyphLine || !model.lines.length) return blocks
  const display = ip.transform as Matrix
  const toUser = invert(display)
  if (!toUser) return blocks

  const runs = analysis.runs.filter((r) => r.visible && r.glyphs.length > 0)
  const matches = matchGlyphs(runs, ip, display)

  // line of every editor glyph (-1 = none yet)
  const lineOf = new Map<TextRun, Int32Array>()
  for (const run of runs) {
    const m = matches.get(run)!
    const l = new Int32Array(run.glyphs.length).fill(-1)
    for (let gi = 0; gi < m.length; gi++) if (m[gi] >= 0) l[gi] = glyphLine[m[gi]]
    lineOf.set(run, l)
  }

  // Candidate lines: right-to-left / complex text, horizontal; then every line sharing an operation with one of them.
  const cand = new Set<number>()
  model.lines.forEach((l, i) => {
    if (l.angle === 0 && RTL_OR_COMPLEX(model.text.slice(l.start, l.end))) cand.add(i)
  })
  if (!cand.size) return blocks
  const boxes = model.lines.map((_, i) => modelLineBox(model, i))
  const unknownIn = new Map<number, number>()
  // the line most glyphs of each /ActualText span belong to
  const spanLine = ip.spans.map((sp) => majority(sp.glyphs.filter((g) => glyphLine[g] >= 0).map((g) => [glyphLine[g], 1] as [number, number])) ?? -1)

  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    // Glyphs the model did not place (pieces of letters drawn separately, undecodable glyphs, orphan marks, duplicates
    // of fake bold): with the rest of their /ActualText span, else by geometry (nearest baseline).
    for (const run of runs) {
      const l = lineOf.get(run)!
      const m = matches.get(run)!
      for (let gi = 0; gi < l.length; gi++) {
        if (l[gi] >= 0) continue
        const ig = m[gi] >= 0 ? ip.glyphs[m[gi]] : undefined
        const g = run.glyphs[gi]
        let best = ig && ig.span >= 0 && spanLine[ig.span] >= 0 && cand.has(spanLine[ig.span]) ? spanLine[ig.span] : -1
        if (best < 0) {
          const [x, y] = originOf(run, gi, display)
          const mid = x + ((g.x1 - g.x0) * Math.abs(run.matrix[0])) / 2
          let bestD = Infinity
          for (const li of cand) {
            const b = boxes[li]
            const tx = 0.3 * b.size
            const ty = 0.6 * b.size
            if (mid < b.x0 - tx || mid > b.x1 + tx || y < b.y0 - ty || y > b.y1 + ty) continue
            const d = Math.abs(y - model.lines[li].baseline)
            if (d < bestD) {
              bestD = d
              best = li
            }
          }
        }
        if (best >= 0) {
          l[gi] = best
          const unreadable = ig ? ig.text === '' && ig.span < 0 : !g.known || g.text === ''
          const wide = (g.x1 - g.x0) * Math.abs(run.matrix[0]) > 0.02 * boxes[best].size
          if (unreadable && wide) unknownIn.set(best, (unknownIn.get(best) ?? 0) + 1)
          changed = true
        }
      }
    }
    // an operation that draws part of a candidate line makes every line it draws a candidate
    for (const run of runs) {
      const l = lineOf.get(run)!
      if (!Array.from(l).some((x) => cand.has(x))) continue
      for (const x of l) {
        if (x >= 0 && !cand.has(x) && model.lines[x].angle === 0) {
          cand.add(x)
          changed = true
        }
      }
    }
    if (!changed) break
  }

  // runs whose marked content carries /ActualText: which runs each span encloses
  const markRuns = new Map<string, Set<TextRun>>()
  for (const run of analysis.runs) {
    for (const mk of run.marked) {
      if (!mk.hasActualText) continue
      const k = addrKey(mk.addr)
      const s = markRuns.get(k)
      if (s) s.add(run)
      else markRuns.set(k, new Set([run]))
    }
  }

  const lineBlocks = new Map<number, TextBlock>()
  for (const li of [...cand].sort((a, b) => a - b)) {
    const cover = new Map<TextRun, boolean[]>()
    for (const run of runs) {
      const l = lineOf.get(run)!
      let any = false
      const flags = Array.from(l, (x) => {
        const hit = x === li
        any ||= hit
        return hit
      })
      if (any) cover.set(run, flags)
    }
    if (!cover.size) continue
    const b = makeBlock(analysis, model, li, cover, toUser, unknownIn.get(li) ?? 0, markRuns)
    if (b) lineBlocks.set(li, b)
  }
  if (!lineBlocks.size) return blocks

  const claimed = new Set<TextRun>()
  for (const b of lineBlocks.values()) for (const r of b.runs) claimed.add(r)
  const keep = (b: TextBlock): boolean => !b.runs.some((r) => claimed.has(r))
  const paragraphs = logicalParagraphs(model, lineBlocks, markRuns)
  return {
    lines: [...blocks.lines.filter(keep), ...lineBlocks.values()],
    paragraphs: [...blocks.paragraphs.filter(keep), ...paragraphs]
  }
}

function makeBlock(
  analysis: PageAnalysis,
  model: PageTextModel,
  li: number,
  cover: Map<TextRun, boolean[]>,
  toUser: Matrix,
  unknown: number,
  markRuns: Map<string, Set<TextRun>>
): TextBlock | null {
  const ml = model.lines[li]
  const text = model.text.slice(ml.start, ml.end)
  if (text.trim() === '') return null
  const runs = [...cover.keys()] // stream order (the map was filled in stream order)
  let left = Infinity
  let right = -Infinity
  const weightOf = (run: TextRun): number => cover.get(run)!.reduce((n, c, gi) => n + (c && run.glyphs[gi].x1 > run.glyphs[gi].x0 ? 1 : 0), 0)
  for (const run of runs) {
    const flags = cover.get(run)!
    run.glyphs.forEach((g, gi) => {
      if (!flags[gi]) return
      const a = run.matrix[4] + run.matrix[0] * g.x0
      const z = run.matrix[4] + run.matrix[0] * g.x1
      left = Math.min(left, a, z)
      right = Math.max(right, a, z)
    })
  }
  // the run drawing most of the line's (non-mark) glyphs sets baseline, size, font and colour
  const main = majority(runs.map((r) => [r, weightOf(r) + 1e-6] as [TextRun, number]))!
  const complexRuns = runs.filter((r) => hasComplexScript(r.text))
  const fontRun = majority((complexRuns.length ? complexRuns : runs).map((r) => [r, weightOf(r) + 1e-6] as [TextRun, number]))!
  const latinRuns = runs.filter((r) => /[A-Za-z0-9]/.test(r.text) && !hasComplexScript(r.text))
  const latinRun = latinRuns.length ? majority(latinRuns.map((r) => [r, weightOf(r) + 1e-6] as [TextRun, number])) : undefined
  const baseline = baselineOf(main)
  const size = userSize(main)
  const color: Color = majority(runs.map((r) => [r.color, weightOf(r) + 1e-6] as [Color, number]))!

  const quadBox = transformRect(toUser, ml.x0, ml.y0, ml.x1, ml.y1)
  const bbox: Rect = { x0: Math.min(quadBox.x0, left), y0: quadBox.y0, x1: Math.max(quadBox.x1, right), y1: quadBox.y1 }

  const line: TextLine = { runs, baseline, x0: left, x1: right, atoms: [], text, bbox, size }
  const reason = refusal(analysis, runs, cover, unknown, markRuns, ml.angle)
  const first = runs[0]
  const firstGlyph = cover.get(first)!.indexOf(true)
  const logical: LogicalInfo = {
    dir: ml.dir,
    lines: [{ index: li, text, dir: ml.dir, left, right, baseline, size }],
    cover,
    align: ml.dir === 'rtl' ? 'right' : 'left',
    mainFont: fontRun.font,
    mainFontName: fontRun.fontName,
    ...(latinRun ? { latinFont: latinRun.font.baseFont } : {}),
    bold: fontRun.font.style.bold,
    italic: fontRun.font.style.italic,
    renderMode: main.renderMode
  }
  return {
    id: `B:${first.id}.${firstGlyph}#${runs.length}`,
    level: 'line',
    source: first.addr.source,
    lines: [line],
    runs,
    atoms: [],
    text,
    bbox,
    size,
    font: fontRun.font,
    color,
    leading: 0,
    editable: reason === undefined,
    reason,
    logical
  }
}

const SPAN_REASON = 'its replacement text (/ActualText) also covers text around it'

function refusal(
  analysis: PageAnalysis,
  runs: TextRun[],
  cover: Map<TextRun, boolean[]>,
  unknown: number,
  markRuns: Map<string, Set<TextRun>>,
  angle: number
): string | undefined {
  if (analysis.rotation !== 0) return 'text editing on rotated pages is not supported yet (rotate the page back to 0° first)'
  if (angle !== 0) return 'the text is rotated, mirrored or skewed'
  if (new Set(runs.map((r) => r.addr.source)).size > 1) return 'the line is drawn partly inside a form and partly on the page'
  for (const r of runs) {
    if (!r.upright) return 'the text is rotated, mirrored or skewed'
    if (r.shared) return 'it is part of a shared element (a form drawn more than once), so editing it would change every copy'
    if (r.marked.some((m) => m.external)) return 'it is tagged with alternative text stored outside the page content'
    if (!r.et) return 'it is in a text object that is not closed (BT without ET), so it cannot be replaced safely'
  }
  if (unknown > 0) return 'some of its characters could not be read (the font has no usable character mapping)'
  // /ActualText spans must not reach text that stays: removing them would change how the rest reads, keeping them
  // would keep the old words extractable
  const all = (r: TextRun): boolean => cover.get(r)?.every(Boolean) ?? false
  for (const r of runs) {
    for (const mk of r.marked) {
      if (!mk.hasActualText) continue
      const enclosed = markRuns.get(addrKey(mk.addr)) ?? new Set()
      for (const o of enclosed) if (!all(o)) return SPAN_REASON
    }
  }
  return undefined
}

/** Consecutive logical lines of one model block with a regular line spacing and a common edge become a paragraph. */
function logicalParagraphs(model: PageTextModel, lineBlocks: Map<number, TextBlock>, markRuns: Map<string, Set<TextRun>>): TextBlock[] {
  const order = [...lineBlocks.keys()].sort((a, b) => a - b)
  const chains: TextBlock[][] = []
  let cur: TextBlock[] = []
  const flush = (): void => {
    if (cur.length >= 2) chains.push(cur)
    cur = []
  }
  for (const li of order) {
    const b = lineBlocks.get(li)!
    // (a span shared with the next or previous line is fine in a paragraph that contains both: checked again below)
    if (!b.editable && b.reason !== SPAN_REASON) {
      flush()
      continue
    }
    const prev = cur[cur.length - 1]
    if (prev) {
      const p = prev.logical!.lines[0]
      const c = b.logical!.lines[0]
      const ok =
        p.index + 1 === c.index &&
        model.lines[p.index].block === model.lines[c.index].block &&
        p.dir === c.dir &&
        prev.source === b.source &&
        c.size / p.size > 0.92 &&
        c.size / p.size < 1.08 &&
        (() => {
          const dy = p.baseline - c.baseline
          if (dy < 0.85 * c.size || dy > 2.2 * c.size) return false
          if (cur.length >= 2) {
            const lead = cur[0].logical!.lines[0].baseline - cur[1].logical!.lines[0].baseline
            if (Math.abs(dy - lead) > 0.12 * c.size) return false
          }
          const tol = 0.6 * c.size
          const overlap = Math.min(p.right, c.right) - Math.max(p.left, c.left) > 0
          const aligned = Math.abs(p.right - c.right) <= tol || Math.abs(p.left - c.left) <= tol || Math.abs((p.left + p.right) / 2 - (c.left + c.right) / 2) <= tol
          return overlap && aligned
        })()
      if (!ok) flush()
    }
    cur.push(b)
  }
  flush()

  const out: TextBlock[] = []
  for (const chain of chains) {
    const lines = chain.map((b) => b.logical!.lines[0])
    const cover = new Map<TextRun, boolean[]>()
    for (const b of chain) {
      for (const [run, flags] of b.logical!.cover) {
        const had = cover.get(run)
        cover.set(run, had ? had.map((v, i) => v || flags[i]) : [...flags])
      }
    }
    const runs = [...new Set(chain.flatMap((b) => b.runs))]
    const first = chain[0]
    // spans shared between lines of the paragraph are fine now; spans reaching outside are not
    let reason: string | undefined
    const all = (r: TextRun): boolean => cover.get(r)?.every(Boolean) ?? false
    for (const r of runs) {
      for (const mk of r.marked) {
        if (!mk.hasActualText) continue
        for (const o of markRuns.get(addrKey(mk.addr)) ?? []) if (!all(o)) reason = SPAN_REASON
      }
    }
    const union = (rs: Rect[]): Rect => ({
      x0: Math.min(...rs.map((r) => r.x0)),
      y0: Math.min(...rs.map((r) => r.y0)),
      x1: Math.max(...rs.map((r) => r.x1)),
      y1: Math.max(...rs.map((r) => r.y1))
    })
    out.push({
      id: `Q:${first.id}#${chain.length}`,
      level: 'paragraph',
      source: first.source,
      lines: chain.flatMap((b) => b.lines),
      runs,
      atoms: [],
      text: lines.map((l) => l.text).join('\n'),
      bbox: union(chain.map((b) => b.bbox)),
      size: first.size,
      font: first.font,
      color: first.color,
      leading: lines[0].baseline - lines[1].baseline,
      editable: reason === undefined,
      reason,
      logical: { ...first.logical!, lines, cover, align: paragraphAlign(lines) }
    })
  }
  return out
}

/** How the lines of a paragraph are aligned (justified: every line but the last touches both edges). */
export function paragraphAlign(lines: Pick<LogicalLine, 'left' | 'right' | 'size' | 'dir'>[]): LogicalAlign {
  const size = lines[0].size
  const L = Math.min(...lines.map((l) => l.left))
  const R = Math.max(...lines.map((l) => l.right))
  const tol = 0.6 * size
  const allR = lines.every((l) => Math.abs(l.right - R) <= tol)
  const allL = lines.every((l) => Math.abs(l.left - L) <= tol)
  const mid = (L + R) / 2
  const allC = lines.every((l) => Math.abs((l.left + l.right) / 2 - mid) <= tol)
  const body = lines.slice(0, -1)
  const last = lines[lines.length - 1]
  const tight = body.length >= 2 ? 0.25 * size : 0.1 * size
  const full = (l: Pick<LogicalLine, 'left' | 'right'>): boolean => Math.abs(l.left - L) <= tight && Math.abs(l.right - R) <= tight
  if (body.length && body.every(full) && !full(last) && (lines[0].dir === 'rtl' ? Math.abs(last.right - R) <= tol : Math.abs(last.left - L) <= tol)) return 'justify'
  if (lines[0].dir === 'rtl') return allR ? 'right' : allC ? 'center' : allL ? 'left' : 'right'
  return allL ? 'left' : allC ? 'center' : allR ? 'right' : 'left'
}
