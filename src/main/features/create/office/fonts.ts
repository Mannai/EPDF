import fontkit from '@pdf-lib/fontkit'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripHinting } from './fontHinting'

/**
 * Fonts for the built-in Office converter. Only permissively licensed fonts are bundled (resources/fonts,
 * SIL Open Font License): Liberation Sans/Serif/Mono (metric-compatible with Arial/Times New Roman/Courier
 * New), Carlito (Calibri) and Caladea (Cambria), and Noto Sans for characters the others lack. Document
 * font names are mapped to the closest of these; text is measured and written with the SAME font so line
 * breaks match what ends up in the PDF.
 */

export type BundledFamily = 'LiberationSans' | 'LiberationSerif' | 'LiberationMono' | 'Carlito' | 'Caladea' | 'NotoSans'

export interface Face {
  /** File stem, e.g. `LiberationSans-BoldItalic`. Unique per embedded font. */
  key: string
  family: BundledFamily
  bold: boolean
  italic: boolean
}

const STYLE_SUFFIX = (bold: boolean, italic: boolean): string => (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular')

/** Faces that exist per family (Noto is only bundled upright). */
const HAS_ITALIC: Record<BundledFamily, boolean> = {
  LiberationSans: true,
  LiberationSerif: true,
  LiberationMono: true,
  Carlito: true,
  Caladea: true,
  NotoSans: false
}

const CARLITO = /^(calibri|carlito|aptos|candara|corbel|calibri light)/
const CALADEA = /^(cambria|caladea)/
const MONO = /(courier|consolas|lucida ?console|monaco|menlo|andale ?mono|dejavu ?sans ?mono|mono|typewriter|source ?code|fira ?code|cascadia|inconsolata|terminal)/
const SERIF = /^(times|georgia|garamond|palatino|book ?antiqua|bookman|century ?schoolbook|constantia|baskerville|minion|liberation ?serif|tinos|serif|ms ?serif|cambria math|didot|sylfaen|perpetua|rockwell|footlight|goudy|hoefler|new ?york|charter|iowan|lora|merriweather|playfair|noto ?serif|dejavu ?serif|source ?serif|pt ?serif)/

/** Maps a document font name (Word, ODF, RTF, PDF PostScript name...) to the closest bundled family. */
export function mapFontFamily(name: string | undefined | null): BundledFamily {
  let n = (name ?? '').toLowerCase().replace(/^[a-z]{6}\+/, '').replace(/[-,_](regular|bold|italic|oblique|bolditalic|light|medium|semibold)$/g, '').trim()
  n = n.replace(/\s+(regular|bold|italic|oblique)$/g, '')
  if (!n) return 'LiberationSans'
  if (n === 'noto sans') return 'NotoSans'
  if (CARLITO.test(n)) return 'Carlito'
  if (CALADEA.test(n)) return 'Caladea'
  if (MONO.test(n)) return 'LiberationMono'
  if (SERIF.test(n) || (/serif/.test(n) && !/sans/.test(n))) return 'LiberationSerif'
  return 'LiberationSans'
}

/** Control characters and invisible format characters are dropped; NBSP and friends become plain spaces. */
export function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠⁦-⁩﻿­]/g, '').replace(/[       ]/g, ' ')
}

export interface FaceMetrics {
  /** All in em (fractions of the font size). */
  ascent: number
  descent: number
  lineGap: number
  xHeight: number
}

interface Loaded {
  fk: ReturnType<typeof fontkit.create>
  bytes: Uint8Array
  upem: number
  widths: Map<string, number>
  metrics: FaceMetrics
}

export class FontCatalog {
  private loaded = new Map<string, Loaded>()
  /** Characters no bundled font could draw (reported to the user as a warning). */
  readonly missing = new Set<string>()

  constructor(
    private readonly dir: string,
    private readonly read: (path: string) => Uint8Array = (p) => readFileSync(p)
  ) {}

  /** The face for a document font + style. Falls back to the upright face when the family has no italic. */
  face(family: string | undefined | null, bold: boolean, italic: boolean): Face {
    const fam = mapFontFamily(family)
    return this.faceOf(fam, bold, italic && HAS_ITALIC[fam])
  }

  faceOf(family: BundledFamily, bold: boolean, italic: boolean): Face {
    const it = italic && HAS_ITALIC[family]
    return { key: `${family}-${STYLE_SUFFIX(bold, it)}`, family, bold, italic: it }
  }

  private load(face: Face): Loaded {
    let l = this.loaded.get(face.key)
    if (!l) {
      // Hinting is removed: fontkit's subsetter breaks hinted fonts (see fontHinting.ts).
      const bytes = stripHinting(this.read(join(this.dir, `${face.key}.ttf`)))
      const fk = fontkit.create(bytes)
      const upem = fk.unitsPerEm || 1000
      l = {
        fk,
        bytes,
        upem,
        widths: new Map(),
        metrics: { ascent: fk.ascent / upem, descent: -fk.descent / upem, lineGap: Math.max(0, fk.lineGap) / upem, xHeight: (fk.xHeight || upem * 0.5) / upem }
      }
      this.loaded.set(face.key, l)
    }
    return l
  }

  bytes(face: Face): Uint8Array {
    return this.load(face).bytes
  }

  metrics(face: Face): FaceMetrics {
    return this.load(face).metrics
  }

  hasGlyph(face: Face, cp: number): boolean {
    return this.load(face).fk.hasGlyphForCodePoint(cp)
  }

  /** Width of `text` in em units (multiply by the font size). Text must already be sanitized and covered by the face. */
  measure(face: Face, text: string): number {
    if (!text) return 0
    const l = this.load(face)
    let w = l.widths.get(text)
    if (w === undefined) {
      w = l.fk.layout(text).advanceWidth / l.upem
      if (l.widths.size > 50000) l.widths.clear()
      l.widths.set(text, w)
    }
    return w
  }

  /**
   * Splits `text` into pieces that a single bundled face can draw: the requested face where it has the glyph,
   * otherwise Noto Sans, then Liberation Sans. Characters nobody has become `?` and are recorded in `missing`.
   */
  segment(face: Face, text: string): { face: Face; text: string }[] {
    const clean = sanitizeText(text)
    if (!clean) return []
    const chain: Face[] = [face]
    if (face.family !== 'NotoSans') chain.push(this.faceOf('NotoSans', face.bold, false))
    if (face.family !== 'LiberationSans') chain.push(this.faceOf('LiberationSans', face.bold, face.italic))
    const out: { face: Face; text: string }[] = []
    const push = (f: Face, t: string): void => {
      const last = out[out.length - 1]
      if (last && last.face.key === f.key) last.text += t
      else out.push({ face: f, text: t })
    }
    for (const ch of clean) {
      const cp = ch.codePointAt(0)!
      let chosen: Face | null = null
      for (const f of chain) {
        if (this.hasGlyph(f, cp)) {
          chosen = f
          break
        }
      }
      if (chosen) push(chosen, ch)
      else {
        this.missing.add(ch)
        push(face, this.hasGlyph(face, 63) ? '?' : ' ')
      }
    }
    return out
  }
}
