import { alignOfBox, buildLines, joinLines, lineText, runsOf, textOfRuns, type Line } from './lines'
import type { Align, Block, ImageItem, PageLayout, PageModel, ParagraphBlock, PdfModel, TableBlock, TextItem } from './model'
import { detectAlignedTables, detectRulingTables } from './tables'

/**
 * Turns the raw items of each page into reading-ordered blocks (paragraphs, tables, images): lines are
 * built from baselines, lines become paragraphs by vertical gaps / indents / line ends, headings come from
 * relative font size, alignment from line extents, and two-column pages are read column by column.
 */

export interface DocStats {
  /** Most common (character-weighted) font size. */
  bodySize: number
  /** Distinct heading sizes, largest first (index 0 = Heading 1). */
  headingSizes: number[]
}

export function documentStats(pages: PageModel[]): DocStats {
  const weight = new Map<number, number>()
  let total = 0
  for (const p of pages) {
    for (const it of p.items) {
      const s = Math.round(it.size * 2) / 2
      weight.set(s, (weight.get(s) ?? 0) + it.text.length)
      total += it.text.length
    }
  }
  let bodySize = 11
  let best = -1
  for (const [s, w] of weight) {
    if (w > best) {
      best = w
      bodySize = s
    }
  }
  const big = [...weight.entries()].filter(([s]) => s >= bodySize * 1.25).sort((a, b) => b[0] - a[0])
  const bigChars = big.reduce((n, [, w]) => n + w, 0)
  const headingSizes: number[] = []
  if (total > 0 && bigChars <= 0.3 * total) {
    for (const [s] of big) if (!headingSizes.some((h) => Math.abs(h - s) < 0.6)) headingSizes.push(s)
  }
  return { bodySize, headingSizes }
}

export function headingLevel(size: number, stats: DocStats): number {
  const i = stats.headingSizes.findIndex((h) => Math.abs(h - size) < 0.6)
  return i < 0 ? 0 : Math.min(i + 1, 3)
}

// ---------------------------------------------------------------------------------------------------
// Two-column detection
// ---------------------------------------------------------------------------------------------------

export interface Gutter {
  x0: number
  x1: number
}

export function findGutter(items: TextItem[]): Gutter | null {
  if (items.length < 12) return null
  const minX = Math.min(...items.map((i) => i.x))
  const maxX = Math.max(...items.map((i) => i.x + i.width))
  const W = maxX - minX
  if (W < 200) return null
  const nb = Math.ceil(W) + 2
  const cover = new Int32Array(nb)
  for (const it of items) for (let x = Math.floor(it.x - minX); x <= Math.ceil(it.x + it.width - minX); x++) if (x >= 0 && x < nb) cover[x]++
  const tol = Math.floor(0.08 * items.length)
  const lo = Math.floor(0.3 * W)
  const hi = Math.ceil(0.7 * W)
  let best: Gutter | null = null
  let x = lo
  while (x <= hi) {
    if (cover[x] > tol) {
      x++
      continue
    }
    let e = x
    while (e <= hi && cover[e] <= tol) e++
    if (e - x >= 9 && (!best || e - x > best.x1 - best.x0)) best = { x0: x + minX, x1: e - 1 + minX }
    x = e
  }
  if (!best) return null
  const g = best
  const mid = (g.x0 + g.x1) / 2
  const isSpan = (i: TextItem): boolean => i.x < g.x0 && i.x + i.width > g.x1
  const left = items.filter((i) => !isSpan(i) && i.x + i.width / 2 < mid)
  const right = items.filter((i) => !isSpan(i) && i.x + i.width / 2 >= mid)
  if (left.length < 6 || right.length < 6) return null
  const ll = buildLines(left)
  const rl = buildLines(right)
  if (ll.length < 4 || rl.length < 4) return null
  const avg = (ls: Line[]): number => ls.reduce((n, l) => n + lineText(l).length, 0) / ls.length
  if (avg(ll) < 25 || avg(rl) < 25) return null
  const yr = (ls: Line[]): [number, number] => [Math.min(...ls.map((l) => l.top)), Math.max(...ls.map((l) => l.bottom))]
  const [a0, a1] = yr(ll)
  const [b0, b1] = yr(rl)
  const overlap = Math.min(a1, b1) - Math.max(a0, b0)
  if (overlap < 0.5 * Math.min(a1 - a0, b1 - b0)) return null
  return g
}

// ---------------------------------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------------------------------

const BULLET = /^(?:[•●◦▪■⁃∙·*–—-]\s|\(?\d{1,3}[.)]\s|\(?[a-zA-Z][.)]\s|\(?[ivxlcdm]{1,6}[.)]\s)/

interface Area {
  left: number
  right: number
}

function areaOf(lines: Line[]): Area {
  const long = lines.filter((l) => lineText(l).length >= 30)
  const use = long.length ? long : lines
  return { left: Math.min(...use.map((l) => l.x0)), right: Math.max(...use.map((l) => l.x1)) }
}

function startsNewParagraph(g: Line[], l: Line, area: Area, stats: DocStats): boolean {
  const first = g[0]
  const last = g[g.length - 1]
  const h1 = headingLevel(first.size, stats)
  const h2 = headingLevel(l.size, stats)
  const dy = l.y - last.y
  if (h1 !== h2) return true
  if (h1 > 0) return Math.abs(first.size - l.size) > 0.6 || dy > 1.6 * last.size * 1.25
  if (Math.abs(first.size - l.size) > 1) return true
  const ref = g.length >= 2 ? (last.y - first.y) / (g.length - 1) : 1.2 * last.size
  if (dy > Math.max(ref * 1.45, ref + 0.35 * last.size)) return true
  if (dy < 0.4 * last.size) return true
  if (BULLET.test(lineText(l))) return true
  const bodyLeft = g.length > 1 ? Math.min(...g.slice(1).map((x) => x.x0)) : first.x0
  // A line indented past the body's left edge starts a new paragraph, unless it continues a hanging list item.
  const hanging = g.length === 1 && BULLET.test(lineText(first))
  if (!hanging && l.x0 - bodyLeft > 0.9 * last.size) return true
  const width = area.right - area.left
  if (width > 0 && last.x1 < area.right - 0.25 * width && /[.!?:;”"')\]]$/.test(lineText(last))) return true
  const la = alignOfBox(l.x0, l.x1, area.left, area.right)
  const fa = alignOfBox(first.x0, first.x1, area.left, area.right)
  if (la !== fa && (la !== 'left' || fa !== 'left')) return true
  return false
}

export function groupParagraphLines(lines: Line[], area: Area, stats: DocStats): Line[][] {
  const groups: Line[][] = []
  for (const l of lines) {
    const g = groups[groups.length - 1]
    if (!g || startsNewParagraph(g, l, area, stats)) groups.push([l])
    else g.push(l)
  }
  return groups
}

interface Entry {
  block: Block
  top: number
  bottom: number
  firstBase: number
  lastBase: number
  /** 0 = left/only column, 1 = right column, 2 = spans both columns. */
  col: 0 | 1 | 2
  left: number
  /** Intended indent target for paragraphs (page x of the body's left edge). */
  leftEdge: number
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function paragraphFromGroup(g: Line[], area: Area, stats: DocStats): Entry {
  const width = area.right - area.left
  const runs = joinLines(g, (i) => g[i].x1 >= area.right - 0.06 * width)
  const heading = headingLevel(g[0].size, stats)
  const aligns = g.map((l) => alignOfBox(l.x0, l.x1, area.left, area.right))
  let align: Align = 'left'
  if (aligns.every((a) => a === 'center')) align = 'center'
  else if (aligns.every((a) => a === 'right')) align = 'right'
  else if (g.length >= 4 && g.slice(0, -1).every((l) => l.x1 >= area.right - 2.5)) align = 'both'
  const bodyLeft = g.length > 1 ? Math.min(...g.slice(1).map((l) => l.x0)) : g[0].x0
  const dys = g.slice(1).map((l, i) => l.y - g[i].y)
  const x0 = Math.min(...g.map((l) => l.x0))
  const x1 = Math.max(...g.map((l) => l.x1))
  const block: ParagraphBlock = {
    type: 'paragraph',
    runs,
    align,
    indentLeft: 0,
    firstLine: align === 'left' || align === 'both' ? g[0].x0 - bodyLeft : 0,
    spaceBefore: 0,
    pitch: dys.length ? median(dys) : 0,
    heading,
    x: x0,
    y: g[0].top,
    width: x1 - x0,
    height: g[g.length - 1].bottom - g[0].top,
    lineCount: g.length,
    srcLines: g.map((l) => l.segs.map((s) => textOfRuns(runsOf(s.items)).trim()))
  }
  return { block, top: g[0].top, bottom: g[g.length - 1].bottom, firstBase: g[0].y, lastBase: g[g.length - 1].y, col: 0, left: x0, leftEdge: align === 'left' || align === 'both' ? bodyLeft : x0 }
}

function tableEntry(t: TableBlock): Entry {
  return { block: t, top: t.y, bottom: t.y + t.height, firstBase: t.y, lastBase: t.y + t.height, col: 0, left: t.x, leftEdge: t.x }
}

function imageEntry(img: ImageItem): Entry {
  return {
    block: { type: 'image', image: img, spaceBefore: 0 },
    top: img.y,
    bottom: img.y + img.height,
    firstBase: img.y,
    lastBase: img.y + img.height,
    col: 0,
    left: img.x,
    leftEdge: img.x
  }
}

function regionEntries(lines: Line[], stats: DocStats): Entry[] {
  if (lines.length === 0) return []
  const area = areaOf(lines)
  const out: Entry[] = []
  let buf: Line[] = []
  const flush = (): void => {
    if (!buf.length) return
    for (const g of groupParagraphLines(buf, area, stats)) out.push(paragraphFromGroup(g, area, stats))
    buf = []
  }
  for (const s of detectAlignedTables(lines)) {
    if ('segs' in s) buf.push(s)
    else {
      flush()
      out.push(tableEntry(s))
    }
  }
  flush()
  return out
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function layoutPage(page: PageModel, stats: DocStats): PageLayout {
  // 1. ruled tables claim their text first
  const { tables, consumed } = detectRulingTables(page.lines, page.items)
  const rest = page.items.filter((i) => !consumed.has(i))

  // 2. columns
  const gutter = findGutter(rest)
  const entries: Entry[] = []
  if (gutter) {
    const mid = (gutter.x0 + gutter.x1) / 2
    const isSpan = (i: TextItem): boolean => i.x < gutter.x0 && i.x + i.width > gutter.x1
    const spanE = regionEntries(buildLines(rest.filter(isSpan)), stats)
    const leftE = regionEntries(buildLines(rest.filter((i) => !isSpan(i) && i.x + i.width / 2 < mid)), stats)
    const rightE = regionEntries(buildLines(rest.filter((i) => !isSpan(i) && i.x + i.width / 2 >= mid)), stats)
    spanE.forEach((e) => (e.col = 2))
    rightE.forEach((e) => (e.col = 1))
    entries.push(...spanE, ...leftE, ...rightE)
  } else {
    entries.push(...regionEntries(buildLines(rest), stats))
  }
  for (const t of tables) {
    const e = tableEntry(t)
    if (gutter) e.col = t.x < gutter.x0 && t.x + t.width > gutter.x1 ? 2 : t.x + t.width / 2 < (gutter.x0 + gutter.x1) / 2 ? 0 : 1
    entries.push(e)
  }
  for (const img of page.images) {
    const e = imageEntry(img)
    if (gutter) e.col = img.x < gutter.x0 && img.x + img.width > gutter.x1 ? 2 : img.x + img.width / 2 < (gutter.x0 + gutter.x1) / 2 ? 0 : 1
    entries.push(e)
  }

  // 3. reading order: bands separated by column-spanning blocks, then left column, right column
  const spans = entries.filter((e) => e.col === 2).sort((a, b) => a.top - b.top)
  const keyOf = (e: Entry): [number, number] => {
    if (e.col === 2) return [spans.indexOf(e), 2]
    return [spans.filter((s) => s.top < e.top).length, e.col]
  }
  const keyed = entries.map((e) => ({ e, k: keyOf(e) }))
  keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.e.top - b.e.top)
  const ordered = keyed.map((x) => x.e)

  // 4. margins from the content's bounding box
  const boxes = [
    ...page.items.map((i) => ({ x0: i.x, x1: i.x + i.width, y0: i.y - 0.8 * i.size, y1: i.y + 0.2 * i.size })),
    ...page.images.map((i) => ({ x0: i.x, x1: i.x + i.width, y0: i.y, y1: i.y + i.height })),
    ...tables.map((t) => ({ x0: t.x, x1: t.x + t.width, y0: t.y, y1: t.y + t.height }))
  ]
  let margins = { top: 72, right: 72, bottom: 72, left: 72 }
  if (boxes.length) {
    margins = {
      left: clamp(Math.min(...boxes.map((b) => b.x0)), 18, page.width * 0.4),
      right: clamp(page.width - Math.max(...boxes.map((b) => b.x1)), 18, page.width * 0.4),
      top: clamp(Math.min(...boxes.map((b) => b.y0)), 18, page.height * 0.4),
      bottom: clamp(page.height - Math.max(...boxes.map((b) => b.y1)), 18, page.height * 0.4)
    }
  }

  // 5. indents and spacing
  let prev: Entry | null = null
  for (const e of ordered) {
    const b = e.block
    if (b.type === 'paragraph') {
      b.indentLeft = b.align === 'left' || b.align === 'both' ? Math.max(0, e.leftEdge - margins.left) : 0
      if (prev && !(prev.col !== e.col && e.col !== 2)) {
        const pitch = b.pitch || 1.2 * b.runs.reduce((m, r) => Math.max(m, r.size), 0)
        const gap = e.firstBase - prev.lastBase - pitch
        b.spaceBefore = prev.block.type === 'paragraph' ? Math.max(0, gap) : Math.max(0, e.top - prev.bottom)
      }
    } else if (prev && prev.col === e.col) {
      b.spaceBefore = Math.max(0, e.top - prev.bottom)
    }
    prev = e
  }
  // never carry a spacing value that is just noise
  for (const e of ordered) if (e.block.spaceBefore < 0.5) e.block.spaceBefore = 0

  return { number: page.number, width: page.width, height: page.height, blocks: ordered.map((e) => e.block), margins, rects: page.rects }
}

export function layoutDocument(model: PdfModel): PageLayout[] {
  const stats = documentStats(model.pages)
  return model.pages.map((p) => layoutPage(p, stats))
}
