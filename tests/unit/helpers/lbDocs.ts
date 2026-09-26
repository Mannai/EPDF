import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  PDFRef,
  StandardFonts,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  type PDFFont,
  type PDFPage
} from 'pdf-lib'

/**
 * Deterministic PDF fixtures for heading/link detection. Latin text uses the standard fonts; Arabic, Hebrew
 * and CJK text uses a synthetic Type0 font (Identity-H) whose /ToUnicode maps each code to the real character,
 * so a reader extracts the true text even though there is no font program to draw glyphs.
 */

export const LETTER: [number, number] = [612, 792]

/** A tiny seeded generator so fixtures are identical on every run. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// ---------------------------------------------------------------- synthetic Unicode font

export class UniFont {
  readonly key: string
  readonly ref: PDFRef
  private readonly codes = new Map<string, number>()
  private readonly toUni: PDFRef

  constructor(
    private readonly doc: PDFDocument,
    key: string,
    baseFont: string
  ) {
    this.key = key
    const ctx = doc.context
    this.toUni = ctx.nextRef()
    const desc = ctx.register(
      ctx.obj({ Type: 'FontDescriptor', FontName: baseFont, Flags: 4, FontBBox: [0, -200, 1000, 800], ItalicAngle: 0, Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80 })
    )
    const cid = ctx.register(
      ctx.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: baseFont,
        CIDSystemInfo: { Registry: 'Adobe', Ordering: 'Identity', Supplement: 0 },
        FontDescriptor: desc,
        DW: 550,
        CIDToGIDMap: 'Identity'
      })
    )
    this.ref = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: baseFont, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: this.toUni }))
  }

  /** Hex string of the 2-byte codes for `text` (codes are assigned on first use). */
  hex(text: string): string {
    let out = ''
    for (const ch of text) {
      let code = this.codes.get(ch)
      if (code === undefined) {
        code = this.codes.size + 1
        this.codes.set(ch, code)
      }
      out += code.toString(16).padStart(4, '0')
    }
    return out
  }

  width(text: string, size: number): number {
    return Array.from(text).length * size * 0.55
  }

  /** Writes the /ToUnicode CMap; call once, after all text was drawn and before saving. */
  finalize(): void {
    const entries = [...this.codes.entries()]
    const utf16 = (ch: string): string => {
      let s = ''
      for (let i = 0; i < ch.length; i++) s += ch.charCodeAt(i).toString(16).padStart(4, '0')
      return s
    }
    let body = ''
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100)
      body += `${chunk.length} beginbfchar\n${chunk.map(([ch, code]) => `<${code.toString(16).padStart(4, '0')}> <${utf16(ch)}>`).join('\n')}\nendbfchar\n`
    }
    const cmap =
      '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      body +
      'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'
    const ctx = this.doc.context
    ctx.assign(this.toUni, ctx.stream(cmap, {}))
  }
}

// ---------------------------------------------------------------- drawing

export interface Ink {
  /** Draws `text` with its left edge at x and baseline at y. */
  text(text: string, x: number, y: number, size: number, opts?: { bold?: boolean; serif?: boolean; uni?: UniFont }): number
}

export class Fixture {
  readonly doc: PDFDocument
  fonts!: { sans: PDFFont; sansBold: PDFFont; serif: PDFFont; serifBold: PDFFont; mono: PDFFont }
  readonly unis: UniFont[] = []
  private fontKeys = new Map<PDFRef, string>()

  private constructor(doc: PDFDocument) {
    this.doc = doc
  }

  static async create(): Promise<Fixture> {
    const f = new Fixture(await PDFDocument.create())
    const d = f.doc
    f.fonts = {
      sans: await d.embedFont(StandardFonts.Helvetica),
      sansBold: await d.embedFont(StandardFonts.HelveticaBold),
      serif: await d.embedFont(StandardFonts.TimesRoman),
      serifBold: await d.embedFont(StandardFonts.TimesRomanBold),
      mono: await d.embedFont(StandardFonts.Courier)
    }
    return f
  }

  uni(baseFont: string): UniFont {
    const u = new UniFont(this.doc, `U${this.unis.length + 1}`, baseFont)
    this.unis.push(u)
    return u
  }

  page(size: [number, number] = LETTER): PDFPage {
    return this.doc.addPage(size)
  }

  /** Width of Latin text in a standard font. */
  width(font: PDFFont, text: string, size: number): number {
    return font.widthOfTextAtSize(text, size)
  }

  latin(page: PDFPage, font: PDFFont, text: string, x: number, y: number, size: number): number {
    page.drawText(text, { x, y, size, font })
    return font.widthOfTextAtSize(text, size)
  }

  drawUni(page: PDFPage, font: UniFont, text: string, x: number, y: number, size: number): number {
    if (!this.fontKeys.has(font.ref)) this.fontKeys.set(font.ref, font.key)
    page.node.setFontDictionary(PDFName.of(font.key), font.ref)
    page.pushOperators(
      beginText(),
      setFontAndSize(font.key, size),
      setTextMatrix(1, 0, 0, 1, x, y),
      PDFOperator.of(PDFOperatorNames.ShowText, [PDFHexString.of(font.hex(text))]),
      endText()
    )
    return font.width(text, size)
  }

  async save(): Promise<Uint8Array> {
    for (const u of this.unis) u.finalize()
    return this.doc.save()
  }
}

// ---------------------------------------------------------------- text helpers

export const LOREM_EN =
  'the system uses a modular design where each component communicates through well defined interfaces and every request is validated before it is processed by the service layer which then stores the result and notifies the interested parties about changes in state'.split(
    ' '
  )

export const LOREM_AR = 'يقوم النظام على تصميم متعدد الوحدات حيث تتواصل كل وحدة عبر واجهات محددة ويتم التحقق من كل طلب قبل معالجته ثم تخزين النتيجة وإبلاغ الأطراف المعنية بالتغييرات'.split(' ')

/** Greedy line wrapping of a word list to `maxWidth` using a measuring function. */
export function wrap(words: string[], maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (cur && measure(next) > maxWidth) {
      lines.push(cur)
      cur = w
    } else cur = next
  }
  if (cur) lines.push(cur)
  return lines
}

export function words(rand: () => number, count: number, source: string[]): string[] {
  return Array.from({ length: count }, () => source[Math.floor(rand() * source.length)])
}

/** Independent implementation of "logical → visual" for right-to-left strings (reverse, then restore LTR runs). */
export function toVisual(logical: string): string {
  const chars = Array.from(logical).reverse()
  const mirror: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[' }
  const ltr = (c: string): boolean => /[A-Za-z0-9٠-٩]/.test(c)
  const out: string[] = []
  for (let i = 0; i < chars.length; ) {
    if (ltr(chars[i])) {
      let j = i
      while (j < chars.length && (ltr(chars[j]) || ('.,:/-'.includes(chars[j]) && j > i && j + 1 < chars.length && ltr(chars[j + 1])))) j++
      out.push(...chars.slice(i, j).reverse())
      i = j
    } else {
      out.push(mirror[chars[i]] ?? chars[i])
      i++
    }
  }
  return out.join('')
}

// ---------------------------------------------------------------- ground truth

export interface Truth {
  pageIndex: number
  text: string
  level: number
}

export interface Doc {
  name: string
  bytes: Uint8Array
  truth: Truth[]
  /** Text that must NOT come out as a heading (title-page subtitles, captions, ...), for precision. */
  decoys: string[]
}
