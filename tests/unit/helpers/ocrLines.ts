import bidiFactory from 'bidi-js'
import type { OcrLine, OcrWord } from '../../../src/shared/features/ocr'

/**
 * Synthetic Tesseract output for a line of text as a scan would show it: the words in LOGICAL order (what Tesseract
 * reports, also for right-to-left lines) with the boxes the Unicode bidi algorithm gives them on the page. So a test
 * can say "this Arabic sentence was scanned" without running recognition.
 */

const bidi = bidiFactory()

export interface LineSpec {
  text: string
  /** Paragraph direction (default: from the first strong character). */
  dir?: 'ltr' | 'rtl'
  /** Baseline y in picture pixels. */
  y: number
  /** Left edge for LTR lines, right edge for RTL lines (picture pixels). */
  edge: number
  /** Advance per character in pixels. */
  charW?: number
  /** Line height in pixels. */
  height?: number
  conf?: number
}

const firstStrong = (s: string): 'ltr' | 'rtl' => {
  for (const ch of s) {
    const t = bidi.getBidiCharTypeName(ch)
    if (t === 'L') return 'ltr'
    if (t === 'R' || t === 'AL') return 'rtl'
  }
  return 'ltr'
}

export function scannedLine(spec: LineSpec): OcrLine {
  const { text } = spec
  const dir = spec.dir ?? firstStrong(text)
  const charW = spec.charW ?? 20
  const height = spec.height ?? 40
  const chars = [...text]
  // work on UTF-16 indices (bidi-js), then map back to code points
  const levels = bidi.getEmbeddingLevels(text, dir)
  const order: number[] = bidi.getReorderedIndices(text, levels)
  const cpOfUnit: number[] = []
  {
    let u = 0
    chars.forEach((c, i) => {
      for (let k = 0; k < c.length; k++) cpOfUnit[u++] = i
    })
  }
  const visualCp: number[] = []
  for (const u of order) {
    const cp = cpOfUnit[u]
    if (visualCp[visualCp.length - 1] !== cp) visualCp.push(cp)
  }
  const isMark = (c: string): boolean => /^\p{M}+$/u.test(c)
  // x of every character (marks sit on their base: no advance of their own)
  const xOf = new Map<number, [number, number]>()
  let advanceCount = chars.filter((c) => !isMark(c)).length
  let x = dir === 'rtl' ? spec.edge - advanceCount * charW : spec.edge
  for (const cp of visualCp) {
    if (isMark(chars[cp])) continue
    xOf.set(cp, [x, x + charW])
    x += charW
  }
  advanceCount = 0
  chars.forEach((c, i) => {
    if (!isMark(c)) return
    let b = i - 1
    while (b >= 0 && isMark(chars[b])) b--
    xOf.set(i, xOf.get(b) ?? [spec.edge, spec.edge])
  })
  const words: OcrWord[] = []
  let i = 0
  while (i < chars.length) {
    if (chars[i] === ' ') {
      i++
      continue
    }
    let j = i
    while (j < chars.length && chars[j] !== ' ') j++
    let x0 = Infinity
    let x1 = -Infinity
    for (let k = i; k < j; k++) {
      const b = xOf.get(k)!
      x0 = Math.min(x0, b[0])
      x1 = Math.max(x1, b[1])
    }
    words.push({ text: chars.slice(i, j).join(''), x0, y0: spec.y - height * 0.8, x1, y1: spec.y + height * 0.2, conf: spec.conf ?? 92 })
    i = j
  }
  const bx0 = Math.min(...words.map((w) => w.x0))
  const bx1 = Math.max(...words.map((w) => w.x1))
  return {
    words,
    baseline: { x0: bx0, y0: spec.y, x1: bx1, y1: spec.y },
    rowHeight: height,
    bbox: { x0: bx0, y0: spec.y - height * 0.8, x1: bx1, y1: spec.y + height * 0.2 }
  }
}

/** Lines stacked down the page, RTL lines right-aligned at `right`, LTR lines left-aligned at `left`. */
export function scannedPage(texts: string[], o: { top?: number; step?: number; left?: number; right?: number; charW?: number } = {}): OcrLine[] {
  const top = o.top ?? 300
  const step = o.step ?? 90
  return texts.map((text, k) => {
    const dir = firstStrong(text)
    return scannedLine({ text, dir, y: top + k * step, edge: dir === 'rtl' ? (o.right ?? 1500) : (o.left ?? 200), charW: o.charW })
  })
}
