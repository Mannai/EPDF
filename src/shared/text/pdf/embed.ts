import { PDFDocument, PDFRef, PDFString, type PDFContext } from 'pdf-lib'
import type { TextFont } from '../fonts'
import { appendComposites, type CompositeSpec } from './composite'
import { cffGidToCid, sfntTable, subsetFont } from './subset'
import { buildToUnicode } from './tounicode'

/**
 * Embedding fonts into a pdf-lib document as subsetted Type0 / Identity-H composite fonts, once per document.
 *
 * Glyphs are recorded as they are drawn; the actual subset (only the glyphs used) is built when the document is
 * saved (a hook in `pdf.fonts`, which pdf-lib flushes in `save()`), or on demand with `flushTextFonts(pdf)`.
 * Character codes in content streams are 2 bytes: the glyph id for TrueType and for name-keyed CFF fonts, the CID
 * of the glyph for CID-keyed CFF fonts (Noto CJK), so the codes always match the embedded font program.
 */

export interface EmbeddedGlyph {
  /** Glyph id in the embedded font (for composites: the id of the synthesised glyph). */
  gid: number
  composite?: boolean
  /** Advance in 1/1000 em, as written to /W. */
  width: number
  text: string
}

const cffCidTables = new WeakMap<TextFont, Uint16Array | null>()

function cidTableFor(font: TextFont): Uint16Array | null {
  if (font.outline !== 'cff') return null
  let t = cffCidTables.get(font)
  if (t === undefined) {
    const cff = font.hbFace.referenceTable('CFF ')
    t = cff ? cffGidToCid(cff) : null
    cffCidTables.set(font, t)
  }
  return t
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export class EmbeddedFont {
  readonly ref: PDFRef
  private readonly pdf: PDFDocument
  private readonly descendantRef: PDFRef
  private readonly descriptorRef: PDFRef
  private readonly fileRef: PDFRef
  private readonly toUnicodeRef: PDFRef
  /** code -> glyph */
  readonly glyphs = new Map<number, EmbeddedGlyph>()
  private readonly cidTable: Uint16Array | null
  private version = 0
  private written = -1
  private readonly composites = new Map<string, { code: number; spec: CompositeSpec }>()
  /** Codes whose ToUnicode text disagreed with an earlier mapping (same glyph used for different characters). */
  conflicts = 0

  constructor(
    private readonly doc: DocText,
    readonly font: TextFont,
    readonly resourceName: string
  ) {
    const pdf = doc.pdf
    this.pdf = pdf
    const ctx = pdf.context
    this.ref = ctx.nextRef()
    this.descendantRef = ctx.nextRef()
    this.descriptorRef = ctx.nextRef()
    this.fileRef = ctx.nextRef()
    this.toUnicodeRef = ctx.nextRef()
    this.cidTable = cidTableFor(font)
  }

  /** True when glyph ids are preserved in the embedded subset (character code = glyph id). */
  private get retainGids(): boolean {
    return this.cidTable === null
  }

  /** The 2-byte character code for a glyph; records the glyph (and its Unicode text) for the subset. */
  code(gid: number, text?: string, natural?: number): number {
    const code = this.cidTable ? (this.cidTable[gid] ?? gid) : gid
    let g = this.glyphs.get(code)
    if (g && text && g.text && g.text !== text) {
      // The same glyph stands for different characters (Persian/Arabic yeh, kaf, digits ...): give this use its own
      // code (an alias glyph) so /ToUnicode stays exact.
      const alias = this.compositeCode([{ gid, dx: 0, dy: 0 }], text, natural ?? this.font.advanceOf(gid))
      if (alias !== null) return alias
      this.conflicts++
      return code
    }
    if (!g) {
      // /W = the shaper's own advance for this glyph (0 for marks), so a reader that adds glyph widths lands exactly
      // where the layout put the next glyph.
      const width = round2(((natural ?? this.font.advanceOf(gid)) * 1000) / this.font.upem)
      this.glyphs.set(code, { gid, width, text: text ?? '' })
      this.version++
    } else if (text) {
      if (!g.text) {
        g.text = text
        this.version++
      } else if (g.text !== text) this.conflicts++
    }
    return code
  }

  /**
   * Code for a synthesised cluster glyph (base + marks, conjunct pieces) made of `components` (font units, y up).
   * Returns null when the font cannot take composites (CFF outlines) or is out of glyph ids: the caller then draws
   * the glyphs one by one.
   */
  compositeCode(components: { gid: number; dx: number; dy: number }[], text: string, advance: number): number | null {
    if (this.font.outline !== 'glyf') return null
    const key = components.map((c) => `${c.gid}:${Math.round(c.dx)}:${Math.round(c.dy)}`).join('|') + '#' + Math.round(advance) + '@' + text
    const hit = this.composites.get(key)
    if (hit) {
      const g = this.glyphs.get(hit.code)!
      if (text && !g.text) g.text = text
      else if (text && g.text !== text) this.conflicts++
      return hit.code
    }
    const code = this.font.numGlyphs + this.composites.size
    if (code > 0xfffe) return null
    const spec: CompositeSpec = { components: components.map((c) => ({ gid: c.gid, dx: Math.round(c.dx), dy: Math.round(c.dy) })), advance }
    this.composites.set(key, { code, spec })
    this.glyphs.set(code, { gid: code, composite: true, width: round2((advance * 1000) / this.font.upem), text })
    this.version++
    return code
  }

  /** Width (1/1000 em) recorded for a code. */
  widthOf(code: number): number {
    return this.glyphs.get(code)?.width ?? 0
  }

  /** Write (or rewrite) the font objects for the glyphs used so far. Cheap when nothing changed. */
  async flush(): Promise<void> {
    if (this.written === this.version) return
    const version = this.version
    const ctx: PDFContext = this.pdf.context
    const font = this.font
    const gidSet = new Set<number>()
    for (const g of this.glyphs.values()) if (!g.composite) gidSet.add(g.gid)
    for (const c of this.composites.values()) for (const comp of c.spec.components) gidSet.add(comp.gid)
    let sub = await subsetFont(font.bytes, { glyphs: gidSet, retainGids: this.retainGids })
    if (this.composites.size) {
      const ordered = [...this.composites.values()].sort((a, b) => a.code - b.code)
      sub = appendComposites(sub, ordered.map((c) => c.spec), font.numGlyphs)
    }
    const isCff = font.outline === 'cff'
    const program = isCff ? (sfntTable(sub, 'CFF ') ?? sub) : sub
    // Font names. PDF.js starts a new text run whenever the font's BaseFont changes, and then reads right-to-left lines
    // run by run in visual order: an Arabic sentence with an English word comes out in the wrong order. Giving every
    // embedded font of a document the same BaseFont keeps such a line one run, and PDF.js's own visual-to-logical
    // reordering then returns the text in reading order. Readers identify fonts by their object, not their name, so this
    // is harmless; `uniformNames = false` restores descriptive names (subset tag + PostScript name).
    let baseFont = 'EPDFTX+EpdfText'
    if (!this.doc.uniformNames) {
      let h = 0
      for (const c of [...this.glyphs.keys()].sort((a, b) => a - b)) h = (Math.imul(h, 31) + c + 7) | 0
      h = (Math.imul(h, 31) + font.postScriptName.length) >>> 0
      let tag = ''
      for (let i = 0; i < 6; i++) {
        tag += String.fromCharCode(65 + (h % 26))
        h = Math.floor(h / 26) + i * 7919
      }
      baseFont = `${tag}+${font.postScriptName}`
    }

    const streamDict = isCff ? { Subtype: 'CIDFontType0C' } : { Length1: program.length }
    ctx.assign(this.fileRef, ctx.flateStream(program, streamDict))
    const k = 1000 / font.upem
    const bb = font.descriptor.bbox
    ctx.assign(
      this.descriptorRef,
      ctx.obj({
        Type: 'FontDescriptor',
        FontName: baseFont,
        Flags: 4 | (font.descriptor.italic ? 64 : 0),
        FontBBox: [round2(bb[0] * k), round2(bb[1] * k), round2(bb[2] * k), round2(bb[3] * k)],
        ItalicAngle: font.descriptor.italicAngle,
        Ascent: Math.round(font.ascent * k),
        Descent: -Math.round(font.descent * k),
        CapHeight: Math.round(font.descriptor.capHeight * k),
        StemV: Math.round(50 + Math.pow(font.descriptor.weight / 65, 2)),
        [isCff ? 'FontFile3' : 'FontFile2']: this.fileRef
      })
    )
    // /W: consecutive codes grouped as `first [w1 w2 ...]`
    const codes = [...this.glyphs.keys()].sort((a, b) => a - b)
    const w: (number | number[])[] = []
    let i = 0
    while (i < codes.length) {
      let j = i
      while (j + 1 < codes.length && codes[j + 1] === codes[j]! + 1) j++
      w.push(codes[i]!, codes.slice(i, j + 1).map((c) => this.glyphs.get(c)!.width))
      i = j + 1
    }
    const cid: Record<string, unknown> = {
      Type: 'Font',
      Subtype: isCff ? 'CIDFontType0' : 'CIDFontType2',
      BaseFont: baseFont,
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: this.descriptorRef,
      DW: 1000,
      W: w
    }
    if (!isCff) cid.CIDToGIDMap = 'Identity'
    ctx.assign(this.descendantRef, ctx.obj(cid as never))
    const toUni = new Map<number, string>()
    for (const [code, g] of this.glyphs) if (g.text) toUni.set(code, g.text)
    ctx.assign(this.toUnicodeRef, ctx.flateStream(buildToUnicode(toUni)))
    ctx.assign(
      this.ref,
      ctx.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: baseFont,
        Encoding: 'Identity-H',
        DescendantFonts: [this.descendantRef],
        ToUnicode: this.toUnicodeRef
      })
    )
    this.written = version
  }
}

/** Per-document text state: the embedded fonts and shared graphics states. */
export class DocText {
  private readonly fonts = new Map<TextFont, EmbeddedFont>()
  private readonly gstates = new Map<number, { name: string; ref: PDFRef }>()
  private counter = 0
  /** Give all fonts of the document one BaseFont name (default, see EmbeddedFont.flush); false = descriptive names. */
  uniformNames = true

  constructor(readonly pdf: PDFDocument) {
    // pdf-lib calls `embed()` on everything in `pdf.fonts` when saving.
    ;(pdf as unknown as { fonts: { embed(): Promise<void> }[] }).fonts.push({ embed: () => this.flush() })
  }

  /** The embedded font (created on first use) for a loaded font. */
  fontFor(font: TextFont): EmbeddedFont {
    let e = this.fonts.get(font)
    if (!e) {
      e = new EmbeddedFont(this, font, `EpdfF${++this.counter}`)
      this.fonts.set(font, e)
    }
    return e
  }

  all(): EmbeddedFont[] {
    return [...this.fonts.values()]
  }

  /** ExtGState for constant opacity (resource name + object ref), shared by every page and form of the document. */
  opacityState(opacity: number): { name: string; ref: PDFRef } {
    const key = Math.round(opacity * 1000)
    let g = this.gstates.get(key)
    if (!g) {
      const ref = this.pdf.context.register(this.pdf.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }))
      g = { name: `EpdfGS${key}`, ref }
      this.gstates.set(key, g)
    }
    return g
  }

  async flush(): Promise<void> {
    for (const f of this.fonts.values()) await f.flush()
  }
}

const docs = new WeakMap<PDFDocument, DocText>()

/** The text-engine state of a document: its embedded fonts (one subset per font, shared by all drawing calls). */
export function embeddedFontsFor(pdf: PDFDocument): DocText {
  let d = docs.get(pdf)
  if (!d) {
    d = new DocText(pdf)
    docs.set(pdf, d)
  }
  return d
}

/** Write all pending font subsets now. `pdf.save()` does this itself; call it only if you serialise the context another way. */
export function flushTextFonts(pdf: PDFDocument): Promise<void> {
  return embeddedFontsFor(pdf).flush()
}
