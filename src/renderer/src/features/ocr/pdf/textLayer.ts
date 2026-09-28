import { visualLine } from './bidi'
import { Charset, cleanWordText } from './charset'
import type { PlacedLine } from './layout'

/**
 * Content stream of the invisible text layer. Each line is one text matrix (rotated to the reading direction) and
 * its words are moved along it with `Td`, each stretched with `Tz` to the width measured in the scan, all drawn in
 * text render mode 3 (neither filled nor stroked). Words are followed by a space character (except the last of a
 * line) so copy/paste and phrase search see ordinary text.
 *
 * Every line is drawn in VISUAL order, from left to right as the scan shows it (see `bidi.ts`): readers turn that
 * back into the logical order the words were recognized in, for right-to-left and mixed lines too.
 */

/** First bytes of every layer stream. */
export const LAYER_MARKER = '%EPDF-OCR-LAYER'

const num = (v: number, digits = 4): string => {
  const s = v.toFixed(digits)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s
}

const BIDI_CONTROLS = /[‎‏؜‪-‮⁦-⁩]/g

/** Smallest gap kept between two words of a line, and smallest width of a word (fractions of the font size). */
export const MIN_WORD_GAP = 0.12
export const MIN_WORD_WIDTH = 0.1

/**
 * Word boxes of a line, from left to right, made disjoint: Tesseract's boxes of neighbouring words often overlap
 * (Arabic final letters and descenders reach under the next word, noise gets its own box inside a word). Readers put
 * a line's glyphs in order by position, so an overlap would interleave the letters of two words; each word is
 * shortened to end a little before the next one starts (and a word squeezed to nothing pushes the next one on).
 */
export function separateWords<W extends { offset: number; width: number }>(words: W[], fontSize: number, minWidth: (w: W) => number = () => 0): void {
  const gap = MIN_WORD_GAP * fontSize
  for (let i = 0; i + 1 < words.length; i++) {
    const w = words[i]
    const next = words[i + 1]
    const room = next.offset - w.offset - gap
    if (w.width > room) w.width = Math.max(MIN_WORD_WIDTH * fontSize, minWidth(w), room)
    if (next.offset < w.offset + w.width + gap) next.offset = w.offset + w.width + gap
  }
}

/**
 * Cleans every word (dropping those that end up empty), puts the words of each line in visual order (left to right,
 * each word's characters as displayed), registers the characters, and drops empty lines. The line origin moves to
 * its leftmost word, so every move along a line goes forwards.
 */
export function collectChars(lines: PlacedLine[], charset: Charset): PlacedLine[] {
  const kept: PlacedLine[] = []
  for (const line of lines) {
    const words: PlacedLine['words'] = []
    for (const w of line.words) {
      const text = cleanWordText(w.text)
      if (text) words.push({ ...w, text })
    }
    if (!words.length) continue
    const vis = visualLine(
      words.map((w) => w.text),
      words.map((w) => w.offset)
    )
    // Bidi controls (Tesseract puts LRM/RLM around left-to-right runs in right-to-left lines) have done their job once
    // the line is in visual order: drawn, they would only be invisible extra "letters" for readers to reorder.
    const ordered = vis.order.map((i) => ({ ...words[i], text: vis.words[i].replace(BIDI_CONTROLS, '') })).filter((w) => w.text !== '')
    if (!ordered.length) continue
    // (a word is never squeezed below the narrowest the layer can draw it, see TZ_MIN)
    if (line.tilted) charset.addSpaceLadder()
    else separateWords(ordered, line.fontSize, (w) => (naturalWidth(charset, w.text, line.fontSize) * TZ_MIN) / 100)
    const o0 = ordered[0].offset
    for (const w of ordered) {
      charset.addText(w.text)
      w.offset -= o0
    }
    kept.push({ ...line, x: line.x + o0 * line.ux, y: line.y + o0 * line.uy, rtl: vis.rtl, words: ordered })
  }
  return kept
}

/** Smallest / largest horizontal scaling (percent) the layer will use to fit text into its box. */
export const TZ_MIN = 20
export const TZ_MAX = 500

const clampTz = (v: number): number => Math.min(TZ_MAX, Math.max(TZ_MIN, v))

/** Scaling range of the space between two words (it spans the gap; a whole table row can be one recognized line). */
export const SPACE_TZ_MIN = 2
export const SPACE_TZ_MAX = 20000

/** Width of `text` at `fontSize` with the layer's font metrics (user units, no scaling). */
export const naturalWidth = (charset: Charset, text: string, fontSize: number): number => (charset.advance(text) / 1000) * fontSize

/** Share of the words of tilted lines drawn at most as wide as their box (see `tiltedScaling`). */
export const TILTED_FIT = 0.8

/**
 * The single horizontal scaling (percent) used for every tilted line of a page. PDF.js measures positions along a
 * tilted line with the text matrix scaled by `Tz`, so words or lines with different `Tz` would be taken for separate
 * lines (or merged); one value keeps them apart correctly. The words START where they are in the scan, only their
 * widths are approximate: the scaling is chosen so that most words (TILTED_FIT) fit inside their box. A mean would let
 * one oversized box (a speck read as a word, a wrong font size) make every word longer than its box, pushing the
 * words of long lines along and eventually off the page.
 */
export function tiltedScaling(charset: Charset, lines: PlacedLine[]): number {
  const ratios: number[] = []
  const all: number[] = []
  for (const line of lines) {
    if (!line.tilted) continue
    for (const w of line.words) {
      const natural = naturalWidth(charset, w.text, line.fontSize)
      if (natural <= 0) continue
      const r = (100 * w.width) / natural
      all.push(r)
      if ([...w.text].filter((c) => charset.advance(c) > 0).length >= 2) ratios.push(r)
    }
  }
  const pick = ratios.length ? ratios : all
  if (!pick.length) return 100
  pick.sort((a, b) => a - b)
  return clampTz(pick[Math.min(pick.length - 1, Math.floor((1 - TILTED_FIT) * pick.length))])
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

const RTL_MARK = /[֐-ࣿיִ-﷿ﹰ-﻿]/u

/** Largest move between two letters of a word on a tilted line, in em (PDF.js reads 0.1 em and more as a space). */
export const TILTED_SPREAD = 0.08
/** ... and at most this share of the word's mean letter width as drawn. */
export const TILTED_SPREAD_OF_LETTER = 0.12

/**
 * TJ operands drawing `text` (the charset's hex codes) over `target` user units when its letters are `unit` user
 * units per font unit: moves between advancing letters (never after the last one, never more than TILTED_SPREAD em).
 * Returns the operands and the width drawn.
 */
export function spreadWord(charset: Charset, text: string, target: number, unit: number, fontSize: number): { tj: string[]; width: number } {
  const chars = [...text]
  const natural = charset.advance(text) * unit
  const bases = chars.map((c, k) => (charset.advance(c) > 0 ? k : -1)).filter((k) => k >= 0)
  const extra = target - natural
  if (extra <= 0 || bases.length < 2 || unit <= 0) return { tj: [charset.hex(text)], width: natural }
  // PDFium (Chrome, Edge) also reads a gap of a good part of a letter's width as a space: stay well below that
  const letter = natural / bases.length
  const k = Math.min(extra / (bases.length - 1), TILTED_SPREAD * fontSize, TILTED_SPREAD_OF_LETTER * letter)
  const kern = num(-k / unit, 2)
  const tj: string[] = []
  let run = ''
  let moves = 0
  const lastBase = bases[bases.length - 1]
  // a mark of a left-to-right script sits on the letter BEFORE it (in a right-to-left run marks come before their
  // letter, see bidi.ts): never separate it from that letter
  const trailingMark = (c: string | undefined): boolean => !!c && /\p{M}/u.test(c) && !RTL_MARK.test(c)
  chars.forEach((c, idx) => {
    run += c
    if (idx < lastBase && charset.advance(c) > 0 && !trailingMark(chars[idx + 1])) {
      tj.push(charset.hex(run), kern)
      run = ''
      moves++
    }
  })
  if (run) tj.push(charset.hex(run))
  return { tj, width: natural + k * moves }
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
    const setTz = (v: number): void => {
      if (v !== lastTz) out.push(`${num(v, 2)} Tz`)
      lastTz = v
    }
    const space = naturalWidth(charset, ' ', line.fontSize)
    let prev = 0
    let free = -Infinity // where the previous word and its space end as drawn
    line.words.forEach((w, i) => {
      const last = i === line.words.length - 1
      // A word drawn longer than its box (the scaling limits, or the page's shared scaling on tilted lines) pushes the
      // next one on, so the glyphs of a line always come in order along it.
      const offset = Math.max(w.offset, free)
      if (i > 0) out.push(`${num(offset - prev)} 0 Td`)
      prev = offset
      setTz(tz[i])
      if (line.tilted) {
        // Tilted lines keep ONE scaling for everything (see tiltedScaling). A word drawn shorter than its box is
        // spread over it by small moves between its letters (at most TILTED_SPREAD em each: readers take larger ones
        // for spaces), and the space is the sized space glyph that fits the gap best (at least 80 % of it).
        const unit = (line.fontSize * tz[i]) / 100000 // user units per font unit
        const { tj, width } = spreadWord(charset, w.text, w.width, unit, line.fontSize)
        if (!last) {
          const s = charset.sizedSpace((line.words[i + 1].offset - offset - width) / unit)
          if (!s) throw new Error('The sized spaces of tilted lines were not registered')
          tj.push(`<${s.hex}>`)
          free = offset + width + s.advance * unit + 0.02 * line.fontSize
        }
        out.push(`[${tj.join(' ')}] TJ`)
        return
      }
      if (last) {
        out.push(`${charset.hex(w.text)} Tj`)
        return
      }
      const drawn = (naturalWidth(charset, w.text, line.fontSize) * tz[i]) / 100
      const gap = line.words[i + 1].offset - offset - drawn
      // The space between two words fills the gap between them: never reaching into the next word (readers order a
      // line's glyphs by position) and leaving no hole (the page text model, like other readers, takes a wide empty
      // gap for a column break, and a dropped low-confidence word would otherwise split the line in two).
      out.push(`${charset.hex(w.text)} Tj`)
      const spaceTz = space > 0 ? Math.min(SPACE_TZ_MAX, Math.max(SPACE_TZ_MIN, (100 * gap) / space)) : 100
      setTz(spaceTz)
      out.push(`${charset.hex(' ')} Tj`)
      free = offset + drawn + (space * spaceTz) / 100
    })
  }
  out.push('ET', 'Q')
  return out.join('\n') + '\n'
}
