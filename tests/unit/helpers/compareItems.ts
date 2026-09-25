import { charWeight } from '../../../src/renderer/src/features/compare/diff/normalize'
import { DEFAULT_OPTIONS, type CompareOptions, type RawItem } from '../../../src/renderer/src/features/compare/diff/types'
import { buildPageModel } from '../../../src/renderer/src/features/compare/diff/words'

/** Width of `text` in points at `size` using Helvetica's advance widths (what pdf-lib's standard font produces). */
export const helvWidth = (text: string, size: number): number => (Array.from(text).reduce((s, ch) => s + charWeight(ch), 0) * size) / 1000

/**
 * A text run as PDF.js would report it, in displayed page coordinates: `y` is the BASELINE measured from the top
 * of the page; the box spans 0.85 em above and 0.22 em below it (what the extractor computes).
 */
export function run(text: string, x: number, baselineFromTop: number, size = 12): RawItem {
  return { str: text, x0: x, x1: x + helvWidth(text, size), y0: baselineFromTop - size * 0.85, y1: baselineFromTop + size * 0.22, size }
}

/** Lines of text laid out one per row: `lines[i]` at baseline `top + i * lead`. */
export function paragraph(lines: string[], x: number, top: number, size = 12, lead = size * 1.25): RawItem[] {
  return lines.map((t, i) => run(t, x, top + i * lead, size))
}

export const opts = (o: Partial<CompareOptions> = {}): CompareOptions => ({ ...DEFAULT_OPTIONS, ...o })

/** Keys of the words of a page built from `items`. */
export const keysOf = (items: RawItem[], o: Partial<CompareOptions> = {}): string[] => buildPageModel(items, 612, 792, opts(o)).keys

/** A one-line page of text, words as keys. */
export const pageOf = (text: string, o: Partial<CompareOptions> = {}): string[] => keysOf([run(text, 72, 100)], o)

/** Deterministic PRNG for property tests. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
