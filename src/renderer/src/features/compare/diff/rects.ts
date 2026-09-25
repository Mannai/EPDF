import type { Mark } from './charDiff'
import { charWeight } from './normalize'
import type { Box, PageModel } from './types'
import { wordBoxes } from './words'

/** Highlight rectangles (PDF points, top-left origin) computed from the words' real geometry. */

export type Rect = Box

const sameLine = (a: Box, b: Box): boolean => {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return overlap > 0.5 * Math.min(a.h, b.h)
}

/**
 * One rectangle per run of adjacent changed words on a line (the spaces between them are covered), so a
 * changed phrase is a single highlight and a changed word a tight one. `pad` grows every rectangle a little.
 */
export function highlightRects(page: PageModel, parts: [number, number][], pad = 1): Rect[] {
  const out: Rect[] = []
  for (const [s, e] of parts) {
    let cur: Box | null = null
    for (let i = s; i < e; i++) {
      for (const b of wordBoxes(page, i)) {
        if (cur && sameLine(cur, b) && b.x - (cur.x + cur.w) < Math.max(b.h, 6) && b.x >= cur.x - 1) {
          const x0 = Math.min(cur.x, b.x)
          const y0 = Math.min(cur.y, b.y)
          cur = { x: x0, y: y0, w: Math.max(cur.x + cur.w, b.x + b.w) - x0, h: Math.max(cur.y + cur.h, b.y + b.h) - y0 }
        } else {
          if (cur) out.push(cur)
          cur = { ...b }
        }
      }
    }
    if (cur) out.push(cur)
  }
  return out.map((r) => ({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }))
}

/**
 * Rectangles for the marked characters of one word: the word's box is split in proportion to the characters'
 * typical widths, so the changed digit of "1,234" is highlighted rather than the whole number.
 */
export function charRects(text: string, box: Box, marks: Mark[], pad = 0.5): Rect[] {
  const chars = Array.from(text)
  const cum: number[] = [0]
  for (const ch of chars) cum.push(cum[cum.length - 1] + charWeight(ch))
  const total = cum[cum.length - 1] || 1
  // marks are UTF-16 offsets; translate to character indices
  const idx: number[] = []
  let at = 0
  for (const ch of chars) {
    idx.push(at)
    at += ch.length
  }
  idx.push(at)
  const charAt = (offset: number): number => {
    let i = 0
    while (i < chars.length && idx[i + 1] <= offset) i++
    return i
  }
  return marks
    .filter(([s, e]) => e > s)
    .map(([s, e]) => {
      const from = cum[charAt(s)] / total
      const to = cum[Math.min(chars.length, charAt(e - 1) + 1)] / total
      return { x: box.x + box.w * from - pad, y: box.y - pad, w: Math.max(0.5, box.w * (to - from)) + 2 * pad, h: box.h + 2 * pad }
    })
}
