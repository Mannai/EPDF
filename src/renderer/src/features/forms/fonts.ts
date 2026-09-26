import fontkit from '@pdf-lib/fontkit'
import { StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib'

/**
 * Standard fonts and coverage checks. Standard Helvetica only covers WinAnsi (Western European): text it can encode
 * is drawn with it as it always was. Everything else is drawn by the text engine (`@shared/text`, see
 * appearance.ts and draw.ts), which shapes and orders every script and embeds subset fonts; only characters no
 * bundled font has are refused (`UnsupportedCharactersError`).
 *
 * `unicodeFont` / `fontForText` are the older pdf-lib + fontkit path (Noto Sans, no shaping); the drawing code no
 * longer uses them and they are kept for callers outside this feature.
 */

/** Supplies the bundled Unicode font file (the renderer fetches it; tests read it from disk). */
export type UnicodeFontProvider = () => Promise<Uint8Array>

export class UnsupportedCharactersError extends Error {
  constructor(readonly chars: string[]) {
    super(
      `These characters can’t be written with the fonts built into Epdf: ${chars.slice(0, 8).join(' ')}${chars.length > 8 ? ' …' : ''}. ` +
        'Remove them or replace them with characters of a supported script.'
    )
  }
}

/** Newlines and tabs are layout, not glyphs. */
export const stripLayoutChars = (s: string): string => s.replace(/[\r\n]+/g, ' ').replace(/\t/g, ' ')

/** Code points of `text` that `font` cannot represent (each listed once). */
export function unsupportedChars(font: PDFFont, text: string): string[] {
  const have = new Set(font.getCharacterSet())
  const bad = new Set<string>()
  for (const ch of stripLayoutChars(text)) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 || cp === 0x7f) continue // control characters are dropped when drawing
    if (!have.has(cp)) bad.add(ch)
  }
  return [...bad]
}

const helveticas = new WeakMap<PDFDocument, Promise<PDFFont>>()
const unicodes = new WeakMap<PDFDocument, Promise<PDFFont>>()

/** Helvetica (standard font, no embedding), created once per document object. */
export function helvetica(pdf: PDFDocument): Promise<PDFFont> {
  let p = helveticas.get(pdf)
  if (!p) helveticas.set(pdf, (p = pdf.embedFont(StandardFonts.Helvetica)))
  return p
}

/** The bundled Unicode font embedded (subset) once per document object. */
export function unicodeFont(pdf: PDFDocument, provider: UnicodeFontProvider): Promise<PDFFont> {
  let p = unicodes.get(pdf)
  if (!p) {
    p = provider().then((bytes) => {
      pdf.registerFontkit(fontkit)
      return pdf.embedFont(bytes, { subset: true })
    })
    unicodes.set(pdf, p)
  }
  return p
}

/**
 * The font to draw `texts` with: Helvetica when it can encode all of them, otherwise the embedded Unicode
 * font. Throws `UnsupportedCharactersError` if not even that covers them.
 */
export async function fontForText(pdf: PDFDocument, texts: string | string[], provider: UnicodeFontProvider): Promise<PDFFont> {
  const all = (Array.isArray(texts) ? texts : [texts]).join('\n')
  const h = await helvetica(pdf)
  if (unsupportedChars(h, all).length === 0) return h
  const u = await unicodeFont(pdf, provider)
  const bad = unsupportedChars(u, all)
  if (bad.length > 0) throw new UnsupportedCharactersError(bad)
  return u
}
