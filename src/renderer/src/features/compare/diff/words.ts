import { clusterLines, median, readingGroups } from './layout'
import { charWeight, clusters, foldChar, keyOf, tokenSpans } from './normalize'
import type { Box, CompareOptions, PageModel, RawItem } from './types'

/** Turns the text runs of one page into an ordered list of words with real geometry. */

export interface Word {
  text: string
  /** Comparison key. */
  key: string
  /** One rectangle, or two when the word was split by a hyphen at the end of a line. */
  boxes: Box[]
  line: number
  block: number
}

interface Cells {
  /** Folded text of a line. */
  text: string
  /** Geometry of every UTF-16 unit of `text`. */
  x0: number[]
  x1: number[]
  y0: number[]
  y1: number[]
}

/** Builds the folded text of one visual line together with per-character geometry. */
function lineCells(line: RawItem[]): Cells {
  const cells: Cells = { text: '', x0: [], x1: [], y0: [], y1: [] }
  const push = (s: string, x0: number, x1: number, y0: number, y1: number): void => {
    // A run of spaces collapses into one.
    if (s === ' ' && (cells.text.length === 0 || cells.text.endsWith(' '))) return
    const n = s.length
    for (let i = 0; i < n; i++) {
      cells.text += s[i]
      cells.x0.push(x0 + ((x1 - x0) * i) / n)
      cells.x1.push(x0 + ((x1 - x0) * (i + 1)) / n)
      cells.y0.push(y0)
      cells.y1.push(y1)
    }
  }
  let prev: RawItem | null = null
  for (const it of line) {
    if (prev) {
      const gap = it.x0 - prev.x1
      const size = Math.min(prev.size, it.size)
      if (gap > 0.15 * size) push(' ', prev.x1, it.x0, Math.min(prev.y0, it.y0), Math.max(prev.y1, it.y1))
    }
    const chars = clusters(it.str)
    let total = 0
    for (const ch of chars) total += charWeight(ch)
    const w = it.x1 - it.x0
    let acc = 0
    for (const ch of chars) {
      const cw = total > 0 ? charWeight(ch) / total : 1 / chars.length
      const cx0 = it.x0 + w * acc
      acc += cw
      const folded = foldChar(ch)
      if (folded) push(folded, cx0, it.x0 + w * acc, it.y0, it.y1)
    }
    prev = it
  }
  return cells
}

const boxOf = (c: Cells, start: number, end: number): Box => {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (let i = start; i < end; i++) {
    x0 = Math.min(x0, c.x0[i])
    x1 = Math.max(x1, c.x1[i])
    y0 = Math.min(y0, c.y0[i])
    y1 = Math.max(y1, c.y1[i])
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

const unionBox = (a: Box, b: Box): Box => {
  const x0 = Math.min(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 }
}

const LOWER_START = /^\p{Ll}/u
const LETTER_END = /\p{L}$/u

/** Words of a page in reading order. */
export function pageWords(items: RawItem[], opts: CompareOptions): Word[] {
  const usable = items.filter((i) => typeof i.str === 'string' && /\S/.test(i.str) && [i.x0, i.x1, i.y0, i.y1, i.size].every(Number.isFinite))
  if (usable.length === 0) return []
  const size = median(usable.map((i) => i.size))
  const words: Word[] = []
  let lineId = 0
  let blockId = -1
  let prevBottom = Infinity
  let prevGroup = -1
  /** Set when a line ended in "letters-": the word to be completed by the next line's first token. */
  let pending: { word: Word; tail: Box } | null = null
  /** The hyphen turned out to be a real one: it becomes a token of its own. */
  const flushPending = (): void => {
    if (!pending) return
    const hk = keyOf('-', opts)
    if (hk !== null) words.push({ text: '-', key: hk, boxes: [pending.tail], line: pending.word.line, block: pending.word.block })
    pending = null
  }

  const groups = readingGroups(usable)
  groups.forEach((group, gi) => {
    for (const line of clusterLines(group)) {
      const cells = lineCells(line)
      const spans = tokenSpans(cells.text)
      const y0 = Math.min(...line.map((i) => i.y0))
      const y1 = Math.max(...line.map((i) => i.y1))
      if (gi !== prevGroup || y0 - prevBottom > 0.5 * size) blockId++
      prevGroup = gi
      prevBottom = y1
      lineId++
      let prevWord: Word | null = null
      for (let t = 0; t < spans.length; t++) {
        const { start, end } = spans[t]
        const token = cells.text.slice(start, end)
        if (pending) {
          if (t === 0 && LOWER_START.test(token)) {
            // "exam-" at the end of a line followed by "ple" on the next: one word, "example".
            const p: { word: Word; tail: Box } = pending
            pending = null
            const merged = p.word.text + token
            p.word.text = merged
            p.word.key = keyOf(merged, opts) ?? p.word.key
            p.word.boxes = [unionBox(p.word.boxes[0], p.tail), boxOf(cells, start, end)]
            prevWord = p.word
            continue
          }
          flushPending()
        }
        if (t === spans.length - 1 && token === '-' && prevWord && spans[t - 1].end === start && LETTER_END.test(prevWord.text) && prevWord.text.length >= 2) {
          pending = { word: prevWord, tail: boxOf(cells, start, end) }
          continue
        }
        const key = keyOf(token, opts)
        if (key === null) {
          prevWord = null
          continue
        }
        prevWord = { text: token, key, boxes: [boxOf(cells, start, end)], line: lineId, block: blockId }
        words.push(prevWord)
      }
    }
  })
  flushPending()
  return words
}

/** Compact, typed-array form of a page's words. */
export function toPageModel(words: Word[], width: number, height: number): PageModel {
  const n = words.length
  const box = new Float32Array(n * 4)
  const block = new Int32Array(n)
  const line = new Int32Array(n)
  const extra: number[] = []
  const text: string[] = new Array<string>(n)
  const keys: string[] = new Array<string>(n)
  words.forEach((w, i) => {
    text[i] = w.text
    keys[i] = w.key
    const b = w.boxes[0]
    box[i * 4] = b.x
    box[i * 4 + 1] = b.y
    box[i * 4 + 2] = b.w
    box[i * 4 + 3] = b.h
    block[i] = w.block
    line[i] = w.line
    for (let k = 1; k < w.boxes.length; k++) extra.push(i, w.boxes[k].x, w.boxes[k].y, w.boxes[k].w, w.boxes[k].h)
  })
  return { width, height, text, keys, box, extra: new Float32Array(extra), block, line }
}

/** Convenience: items -> compact model. */
export function buildPageModel(items: RawItem[], width: number, height: number, opts: CompareOptions): PageModel {
  return toPageModel(pageWords(items, opts), width, height)
}

/** All rectangles of word `i` (one, or two for a hyphenated word). */
export function wordBoxes(p: PageModel, i: number): Box[] {
  const out: Box[] = [{ x: p.box[i * 4], y: p.box[i * 4 + 1], w: p.box[i * 4 + 2], h: p.box[i * 4 + 3] }]
  const e = p.extra
  for (let k = 0; k < e.length; k += 5) if (e[k] === i) out.push({ x: e[k + 1], y: e[k + 2], w: e[k + 3], h: e[k + 4] })
  return out
}
