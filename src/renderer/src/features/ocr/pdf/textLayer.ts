import { Charset, cleanWordText, toVisualOrder } from './charset'
import type { PlacedLine } from './layout'

/**
 * Content stream of the invisible text layer. Each line is one text matrix (rotated to the reading direction) and
 * its words are moved along it with `Td`, each stretched with `Tz` to the width measured in the scan, all drawn in
 * text render mode 3 (neither filled nor stroked). Words are followed by a space character (except the last of a
 * line) so copy/paste and phrase search see ordinary text.
 */

/** First bytes of every layer stream. */
export const LAYER_MARKER = '%EPDF-OCR-LAYER'

const num = (v: number, digits = 4): string => {
  const s = v.toFixed(digits)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s
}

/** Cleans every word (dropping those that end up empty), registers the characters, and drops empty lines. */
export function collectChars(lines: PlacedLine[], charset: Charset): PlacedLine[] {
  const kept: PlacedLine[] = []
  for (const line of lines) {
    const words = []
    for (const w of line.words) {
      const text = toVisualOrder(cleanWordText(w.text))
      if (!text) continue
      charset.addText(text)
      words.push({ ...w, text })
    }
    if (words.length) kept.push({ ...line, words })
  }
  return kept
}

/** Smallest / largest horizontal scaling (percent) the layer will use to fit text into its box. */
export const TZ_MIN = 20
export const TZ_MAX = 500

const clampTz = (v: number): number => Math.min(TZ_MAX, Math.max(TZ_MIN, v))

/** Width of `text` at `fontSize` with the layer's font metrics (user units, no scaling). */
export const naturalWidth = (charset: Charset, text: string, fontSize: number): number => (charset.advance(text) / 1000) * fontSize

/**
 * The single horizontal scaling (percent) used for every tilted line of a page: total measured width over total
 * natural width. PDF.js measures positions along a tilted line with the text matrix scaled by `Tz`, so words or
 * lines with different `Tz` would be taken for separate lines (or merged); one value keeps them apart correctly.
 * The words still START exactly where they are in the scan, only their widths are approximate.
 */
export function tiltedScaling(charset: Charset, lines: PlacedLine[]): number {
  let natural = 0
  let width = 0
  for (const line of lines) {
    if (!line.tilted) continue
    for (const w of line.words) {
      natural += naturalWidth(charset, w.text, line.fontSize)
      width += w.width
    }
  }
  return natural > 0 ? clampTz((100 * width) / natural) : 100
}

/**
 * Horizontal scaling (percent) of each word of a line: upright lines stretch every word to exactly its own box;
 * tilted lines use `tilted` (see `tiltedScaling`).
 */
export function lineScaling(charset: Charset, line: PlacedLine, tilted: number): number[] {
  if (line.tilted) return line.words.map(() => tilted)
  return line.words.map((w) => {
    const natural = naturalWidth(charset, w.text, line.fontSize)
    return natural > 0 ? clampTz((100 * w.width) / natural) : 100
  })
}

export function buildLayerStream(fontName: string, charset: Charset, lines: PlacedLine[]): string {
  const out: string[] = [LAYER_MARKER, 'q', 'BT', '3 Tr']
  const tilted = tiltedScaling(charset, lines)
  let lastTz = 0 // Tz persists across text matrices, so it is only written when it changes
  for (const line of lines) {
    // Text matrix [a b c d e f]: x axis = writing direction, y axis = that turned 90 degrees counterclockwise.
    out.push(`${num(line.ux, 5)} ${num(line.uy, 5)} ${num(-line.uy, 5)} ${num(line.ux, 5)} ${num(line.x)} ${num(line.y)} Tm`)
    out.push(`/${fontName} ${num(line.fontSize, 3)} Tf`)
    const tz = lineScaling(charset, line, tilted)
    let prev = 0
    line.words.forEach((w, i) => {
      const trailing = i < line.words.length - 1 ? ' ' : ''
      if (i > 0) out.push(`${num(w.offset - prev)} 0 Td`)
      prev = w.offset
      if (tz[i] !== lastTz) out.push(`${num(tz[i], 2)} Tz`)
      lastTz = tz[i]
      out.push(`${charset.hex(w.text + trailing)} Tj`)
    })
  }
  out.push('ET', 'Q')
  return out.join('\n') + '\n'
}
