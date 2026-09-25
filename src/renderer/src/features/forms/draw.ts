import { LineCapStyle, degrees, rgb, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib'
import { fontForText, stripLayoutChars, type UnicodeFontProvider } from './fonts'
import { frameToUser, hexToRgb01, type Frame } from './geometry'

/**
 * Drawing permanent content (text, check marks, dates) onto a page in PDF user space. Everything is
 * positioned in a `Frame`: a point on the page plus the page's rotation, so what the reader sees on screen
 * is upright on rotated pages too. Pure pdf-lib: no DOM.
 */

export interface TextStyle {
  /** Points. */
  size: number
  /** "#rrggbb". */
  color: string
}

/** The HTML editing box and the PDF output share these numbers so the preview matches what is written. */
export const LINE_HEIGHT = 1.2
/** Arial/Helvetica-like metrics of the preview font: distance from the top of a line box to its baseline. */
export const BASELINE_FROM_TOP = (LINE_HEIGHT - (0.905 + 0.212)) / 2 + 0.905

export const DEFAULT_TEXT_SIZE = 12

/** Greedy word wrap of `text` to `maxWidth` points (explicit newlines kept; over-long words are split). */
export function wrapText(text: string, font: Pick<PDFFont, 'widthOfTextAtSize'>, size: number, maxWidth: number): string[] {
  const out: string[] = []
  const width = (s: string): number => font.widthOfTextAtSize(s, size)
  for (const para of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let line = ''
    for (const word of para.split(/(?<= )/)) {
      if (width((line + word).trimEnd()) <= maxWidth) {
        line += word
        continue
      }
      if (line !== '') {
        out.push(line.trimEnd())
        line = ''
      }
      // A single word wider than the box is broken by characters.
      let rest = word
      while (width(rest.trimEnd()) > maxWidth && [...rest].length > 1) {
        const chars = [...rest]
        let cut = 1
        while (cut < chars.length && width(chars.slice(0, cut + 1).join('')) <= maxWidth) cut++
        out.push(chars.slice(0, cut).join(''))
        rest = chars.slice(cut).join('')
      }
      line = rest
    }
    out.push(line.trimEnd())
  }
  return out
}

function pageAt(pdf: PDFDocument, index: number): PDFPage {
  if (index < 0 || index >= pdf.getPageCount()) throw new Error('That page no longer exists.')
  return pdf.getPage(index)
}

/**
 * Draws a block of text whose top-left corner is the top-left of `frame` (visual space) and which wraps at
 * the frame's width. Returns the number of lines drawn.
 */
export async function drawTextBlock(
  pdf: PDFDocument,
  pageIndex: number,
  frame: Frame,
  content: string,
  style: TextStyle,
  provider: UnicodeFontProvider
): Promise<number> {
  const text = content.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (text.trim() === '') throw new Error('There is no text to add.')
  const page = pageAt(pdf, pageIndex)
  const font = await fontForText(pdf, text.replace(/\n/g, ' '), provider)
  const lines = wrapText(text, font, style.size, Math.max(frame.width, style.size))
  const c = hexToRgb01(style.color)
  const color = rgb(c.r, c.g, c.b)
  lines.forEach((line, i) => {
    const l = stripLayoutChars(line)
    if (l.trim() === '') return
    const dy = frame.height - (BASELINE_FROM_TOP + i * LINE_HEIGHT) * style.size
    const [x, y] = frameToUser(frame, 0, dy)
    page.drawText(l, { x, y, size: style.size, font, color, rotate: degrees(frame.rotation) })
  })
  return lines.length
}

export type StampKind = 'check' | 'cross' | 'dot' | 'date'

/** "Sep 25, 2026"-style label for today (or `date`), in the user's locale. */
export function dateLabel(date = new Date(), locale?: string): string {
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * Stamps a check mark, cross, dot or the date centered on `center` (a user-space point). Marks are drawn as
 * vector paths, so they stay sharp at any zoom and need no font. `size` is in points.
 */
export async function drawStamp(
  pdf: PDFDocument,
  pageIndex: number,
  kind: StampKind,
  center: [number, number],
  rotation: number,
  style: TextStyle,
  provider: UnicodeFontProvider,
  label = dateLabel()
): Promise<void> {
  const page = pageAt(pdf, pageIndex)
  const c = hexToRgb01(style.color)
  const color = rgb(c.r, c.g, c.b)
  const s = style.size
  const at = (dx: number, dy: number): { x: number; y: number } => {
    const [x, y] = frameToUser({ origin: center, rotation }, dx, dy)
    return { x, y }
  }
  const thickness = Math.max(0.8, s * 0.13)
  if (kind === 'check') {
    page.drawLine({ start: at(-0.45 * s, 0.02 * s), end: at(-0.12 * s, -0.34 * s), thickness, color, lineCap: LineCapStyle.Round })
    page.drawLine({ start: at(-0.12 * s, -0.34 * s), end: at(0.5 * s, 0.42 * s), thickness, color, lineCap: LineCapStyle.Round })
  } else if (kind === 'cross') {
    page.drawLine({ start: at(-0.4 * s, -0.4 * s), end: at(0.4 * s, 0.4 * s), thickness, color, lineCap: LineCapStyle.Round })
    page.drawLine({ start: at(-0.4 * s, 0.4 * s), end: at(0.4 * s, -0.4 * s), thickness, color, lineCap: LineCapStyle.Round })
  } else if (kind === 'dot') {
    const p = at(0, 0)
    page.drawCircle({ x: p.x, y: p.y, size: Math.max(1.2, s * 0.28), color })
  } else {
    const font = await fontForText(pdf, label, provider)
    const w = font.widthOfTextAtSize(label, s)
    const p = at(-w / 2, -0.3 * s)
    page.drawText(label, { x: p.x, y: p.y, size: s, font, color, rotate: degrees(rotation) })
  }
}

/**
 * Draws a date label whose visual left edge / baseline start at `frame` offset (dx, dy) from the frame's
 * bottom-left corner. Used to put the date next to a placed signature.
 */
export async function drawDateAt(
  pdf: PDFDocument,
  pageIndex: number,
  frame: Pick<Frame, 'origin' | 'rotation'>,
  dx: number,
  dy: number,
  size: number,
  color: string,
  provider: UnicodeFontProvider,
  label = dateLabel()
): Promise<void> {
  const page = pageAt(pdf, pageIndex)
  const font = await fontForText(pdf, label, provider)
  const col = hexToRgb01(color)
  const [x, y] = frameToUser(frame, dx, dy)
  page.drawText(label, { x, y, size, font, color: rgb(col.r, col.g, col.b), rotate: degrees(frame.rotation) })
}
