import { StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib'

/** Standard-14 fonts for appearance streams: no font files are embedded, every reader has them. */

const cache = new WeakMap<PDFDocument, Map<string, PDFFont>>()

export type StdFontName = 'Helvetica' | 'Helvetica-Bold'

/** Embeds (once per document instance) a standard font. The font dict is written when the document is saved. */
export async function stdFont(pdf: PDFDocument, name: StdFontName = 'Helvetica'): Promise<PDFFont> {
  let m = cache.get(pdf)
  if (!m) cache.set(pdf, (m = new Map()))
  let f = m.get(name)
  if (!f) {
    f = await pdf.embedFont(name === 'Helvetica-Bold' ? StandardFonts.HelveticaBold : StandardFonts.Helvetica)
    m.set(name, f)
  }
  return f
}

/** Replaces characters the font's WinAnsi encoding cannot represent with "?" (newlines are kept). */
export function sanitizeText(font: Pick<PDFFont, 'getCharacterSet'>, s: string): string {
  const supported = new Set(font.getCharacterSet())
  let out = ''
  for (const ch of s.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')) {
    const cp = ch.codePointAt(0)!
    out += ch === '\n' || supported.has(cp) ? ch : '?'
  }
  return out
}

/** Greedy word wrap. Explicit newlines are honoured; words longer than a line are broken by character. */
export function wrapLines(s: string, maxWidth: number, measure: (t: string) => number): string[] {
  const out: string[] = []
  for (const para of s.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    for (const word of para.split(/(?<= )/)) {
      // `word` keeps its trailing space; lines are measured and stored without trailing spaces.
      const candidate = line + word
      if (measure(candidate.trimEnd()) <= maxWidth) {
        line = candidate
        continue
      }
      if (line !== '') {
        out.push(line.trimEnd())
        line = ''
      }
      if (measure(word.trimEnd()) <= maxWidth) {
        line = word
        continue
      }
      // A single word wider than the box: break it by character.
      let piece = ''
      for (const ch of word.trimEnd()) {
        if (piece !== '' && measure(piece + ch) > maxWidth) {
          out.push(piece)
          piece = ch
        } else piece += ch
      }
      line = piece + (word.endsWith(' ') ? ' ' : '')
    }
    out.push(line.trimEnd())
  }
  return out
}
