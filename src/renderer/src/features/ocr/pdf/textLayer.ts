import { Charset, cleanWordText, toVisualOrder } from './charset'
import type { PlacedWord } from './layout'

/**
 * Content stream of the invisible text layer. Every word is its own text object positioned with a text matrix
 * (rotated to the page's reading direction) and stretched with `Tz` to the width measured in the scan, drawn in
 * text render mode 3 (neither filled nor stroked). Words in one line are followed by a space character so
 * copy/paste and phrase search see ordinary text.
 */

/** First bytes of every layer stream: lets a later "force" run recognize (and replace) its own earlier output. */
export const LAYER_MARKER = '%EPDF-OCR-LAYER'

const num = (v: number, digits = 4): string => {
  const s = v.toFixed(digits)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s
}

export interface LayerLine {
  words: PlacedWord[]
}

/** Prepares `lines` (drops words that are empty after cleaning) and registers their characters. */
export function collectChars(lines: LayerLine[], charset: Charset): LayerLine[] {
  const kept: LayerLine[] = []
  for (const line of lines) {
    const words: PlacedWord[] = []
    for (const w of line.words) {
      const text = toVisualOrder(cleanWordText(w.text))
      if (!text) continue
      charset.addText(text)
      words.push({ ...w, text })
    }
    if (words.length) kept.push({ words })
  }
  return kept
}

/** Smallest / largest horizontal scaling (percent) the layer will use to fit a word into its box. */
export const TZ_MIN = 20
export const TZ_MAX = 500

export function buildLayerStream(fontName: string, charset: Charset, lines: LayerLine[]): string {
  const out: string[] = [LAYER_MARKER, 'q', 'BT', '3 Tr']
  for (const line of lines) {
    line.words.forEach((w, i) => {
      const trailing = i < line.words.length - 1 ? ' ' : ''
      const natural = (charset.advance(w.text) / 1000) * w.fontSize
      const tz = natural > 0 ? Math.min(TZ_MAX, Math.max(TZ_MIN, (100 * w.width) / natural)) : 100
      // Text matrix [a b c d e f]: x axis = writing direction, y axis = that turned 90 degrees counterclockwise.
      out.push(`/${fontName} ${num(w.fontSize, 3)} Tf`)
      out.push(`${num(tz, 2)} Tz`)
      out.push(`${num(w.ux, 5)} ${num(w.uy, 5)} ${num(-w.uy, 5)} ${num(w.ux, 5)} ${num(w.x)} ${num(w.y)} Tm`)
      out.push(`${charset.hex(w.text + trailing)} Tj`)
    })
  }
  out.push('ET', 'Q')
  return out.join('\n') + '\n'
}
