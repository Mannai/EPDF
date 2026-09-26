import type { GlyphRun, Line, ParagraphLayout, TextColor } from '../types'
import type { DocText, EmbeddedFont } from './embed'
import { utf16beHex } from './tounicode'

/**
 * Turns a paragraph layout into PDF content-stream operators.
 *
 *  - Glyphs are shown with 2-byte codes of the embedded subset font; every glyph's exact origin (GPOS offsets,
 *    kerning, justification) is honoured by `TJ` adjustments, and vertical offsets (marks above/below the base,
 *    baseline shifts) start a new positioned text segment.
 *  - Extraction: `/ToUnicode` maps each code to its source characters (ligatures map to several). For lines whose
 *    visual order differs from the logical order (right-to-left and mixed-direction text) the line can be wrapped
 *    in marked content with `/ActualText` holding the logical Unicode text; see `extraction`.
 */

export type RenderMode = 'fill' | 'stroke' | 'fillStroke' | 'invisible'
/**
 * How text extraction should see a line:
 *  - `visual`: nothing extra; readers use /ToUnicode in the order the glyphs are drawn (left to right).
 *  - `actualText`: every line is wrapped in `/Span << /ActualText (logical text) >> BDC ... EMC`.
 *  - `auto`: `actualText` only for lines that need it (right-to-left or reordered text, clusters that a ToUnicode map
 *    cannot express); plain left-to-right lines stay plain.
 */
export type Extraction = 'auto' | 'visual' | 'actualText'

export interface EmitParams {
  docText: DocText
  layout: ParagraphLayout
  /** Local y of the layout's first-line baseline: 0 puts the origin on the first baseline, `-firstBaseline`... see `originBaseline`. */
  originBaseline: boolean
  renderMode?: RenderMode
  strokeColor?: TextColor
  strokeWidth?: number
  extraction?: Extraction
}

export interface EmitResult {
  /** Content stream text (ASCII). */
  content: string
  fonts: Set<EmbeddedFont>
  states: Map<string, { name: string; ref: import('pdf-lib').PDFRef }>
}

const num = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) || r === 0 ? '0' : String(r)
}

export function colorOps(color: TextColor, stroke: boolean): string {
  if (typeof color === 'number') return `${num(color)} ${stroke ? 'G' : 'g'}`
  if (color.length === 3) return `${num(color[0])} ${num(color[1])} ${num(color[2])} ${stroke ? 'RG' : 'rg'}`
  return `${num(color[0])} ${num(color[1])} ${num(color[2])} ${num(color[3]!)} ${stroke ? 'K' : 'k'}`
}

const colorKey = (c: TextColor): string => (typeof c === 'number' ? `g${c}` : c.join(','))

/** ActualText payload: UTF-16BE with byte order mark, as a PDF hex string. */
export function actualTextHex(text: string): string {
  return `<FEFF${utf16beHex(text)}>`
}

function lineNeedsActualText(line: Line, text: string): boolean {
  if (line.rtl) return true
  for (const r of line.runs) if (r.level & 1) return true
  // clusters with more than one glyph per character sequence are fine for ToUnicode; complex scripts still benefit
  return /[ऀ-෿฀-໿က-႟ក-៿]/.test(text)
}

const SKEW = Math.tan((12 * Math.PI) / 180)

/** Content for the whole layout. Coordinates are local: x right, y up, origin at the layout's top-left (or first baseline). */
export function emitLayout(p: EmitParams): EmitResult {
  const { docText, layout } = p
  const out: string[] = []
  const fonts = new Set<EmbeddedFont>()
  const states = new Map<string, { name: string; ref: import('pdf-lib').PDFRef }>()
  const mode = p.renderMode ?? 'fill'
  const extraction = p.extraction ?? 'auto'
  const first = layout.lines[0]
  const shift = p.originBaseline && first ? first.baseline : 0
  let curColor = ''
  let curStroke = ''
  let curOpacity = 1
  let curLineWidth = -1
  const usedDecor: string[] = []

  for (const line of layout.lines) {
    const baselineY = shift - (line.y + line.baseline)
    const lineText = layout.text.slice(line.textStart, line.textEnd)
    const wrap = lineText.length > 0 && (extraction === 'actualText' || (extraction === 'auto' && lineNeedsActualText(line, lineText)))
    let opened = false
    for (const run of line.runs) {
      if (run.glyphs.length === 0) continue
      const st = run.style
      const ef = docText.fontFor(run.font)
      fonts.add(ef)
      const hasInk = run.glyphs.some((g) => !g.tab)
      if (!hasInk) continue
      // graphics state: colour, opacity
      const ck = colorKey(st.color)
      if (mode !== 'invisible') {
        if (ck !== curColor) {
          out.push(colorOps(st.color, false))
          curColor = ck
        }
      }
      if (st.opacity !== curOpacity) {
        const gs = docText.opacityState(st.opacity)
        states.set(gs.name, gs)
        out.push(`/${gs.name} gs`)
        curOpacity = st.opacity
      }
      let tr: number
      const strokeColor = p.strokeColor ?? st.color
      switch (mode) {
        case 'stroke':
          tr = 1
          break
        case 'fillStroke':
          tr = 2
          break
        case 'invisible':
          tr = 3
          break
        default:
          tr = st.synthBold ? 2 : 0
      }
      if (tr === 1 || tr === 2) {
        const sk = colorKey(strokeColor)
        if (sk !== curStroke) {
          out.push(colorOps(strokeColor, true))
          curStroke = sk
        }
        const lw = p.strokeWidth ?? (st.synthBold ? Math.max(0.2, st.size * 0.03) : 1)
        if (lw !== curLineWidth) {
          out.push(`${num(lw)} w`)
          curLineWidth = lw
        }
      }
      if (wrap && !opened) {
        out.push(`/Span <</ActualText ${actualTextHex(lineText)}>> BDC`)
        opened = true
      }
      out.push('BT')
      if (tr !== 0) out.push(`${tr} Tr`)
      out.push(`/${ef.resourceName} ${num(st.size)} Tf`)
      emitRun(out, run, ef, layout.text, baselineY, st.size)
      if (tr !== 0) out.push('0 Tr')
      out.push('ET')

      // decorations are drawn after the text
      if ((st.underline || st.strike) && !run.hanging && mode !== 'invisible') {
        const f = run.font
        const k = st.size / f.upem
        const x0 = run.x
        const w = run.width
        if (st.underline) usedDecor.push(rect(x0, baselineY - (f.descriptor.underlinePosition * k) - (f.descriptor.underlineThickness * k) / 2 - st.rise, w, f.descriptor.underlineThickness * k, st.color))
        if (st.strike) usedDecor.push(rect(x0, baselineY + f.descriptor.strikePosition * k - (f.descriptor.strikeThickness * k) / 2 + st.rise, w, f.descriptor.strikeThickness * k, st.color))
      }
    }
    if (opened) out.push('EMC')
    if (usedDecor.length) {
      out.push('/Artifact BMC')
      out.push(...usedDecor)
      out.push('EMC')
      usedDecor.length = 0
      curColor = '' // decorations change the fill colour
    }
  }
  // Leave the caller's graphics state as we found it (opacity is restored by the caller's q/Q).
  return { content: out.join('\n'), fonts, states }
}

function rect(x: number, y: number, w: number, h: number, color: TextColor): string {
  return `${colorOps(color, false)} ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`
}

/**
 * Glyph placement for one run: one `Tm` at the first glyph's pen position, then `TJ` arrays whose numbers correct
 * the pen wherever the layout differs from the font's own advances (kerning, justification).
 *
 * Every drawing unit sits exactly on the pen. A glyph that the shaper displaced (a mark above or below its base, a
 * conjunct's pieces, a cursive attachment) is baked into a synthesised composite glyph together with its offset (see
 * composite.ts), instead of being repositioned in the content stream: text extractors read a moved text matrix, a
 * vertical rise or a backward pen movement as a new text run and insert spaces into words.
 */
function emitRun(out: string[], run: GlyphRun, ef: EmbeddedFont, text: string, baselineY: number, tfSize: number): void {
  const size = tfSize
  const skew = run.style.synthItalic ? SKEW : 0
  const font = run.font
  const k = font.upem / run.size
  let arr: string[] = []
  let started = false
  let pdfPenX = 0 // where the PDF pen will be after the last glyph shown
  let rise = run.style.rise
  const flush = (): void => {
    if (arr.length) out.push(`[${arr.join('')}] TJ`)
    arr = []
  }
  const show = (code: number, x: number, up: number): void => {
    if (!started) {
      out.push(`1 0 ${num(skew)} 1 ${num(x)} ${num(baselineY)} Tm`)
      if (rise !== 0) out.push(`${num(rise)} Ts`)
      started = true
      pdfPenX = x
    }
    if (Math.abs(up - rise) > 0.0005) {
      flush()
      out.push(`${num(up)} Ts`)
      rise = up
    }
    const adj = ((pdfPenX - x) * 1000) / size
    if (Math.abs(adj) > 0.0005) arr.push(String(Math.round(adj * 1000) / 1000) + ' ')
    arr.push(`<${code.toString(16).toUpperCase().padStart(4, '0')}>`)
    pdfPenX = x + (ef.widthOf(code) * size) / 1000
  }

  // Drawing units. First: consecutive glyphs of one character cluster (a letter and its dot components; a ligature).
  // Then units whose characters are out of logical order relative to the drawing direction (Indic vowel signs drawn
  // before their consonant) are merged with their neighbours, so a unit's text is always a logical-order slice.
  const gs = run.glyphs
  interface Unit {
    i: number
    j: number
    start: number
    end: number
  }
  const units: Unit[] = []
  for (let i = 0; i < gs.length; ) {
    const g = gs[i]!
    if (g.tab) {
      i++
      continue
    }
    let j = i + 1
    while (j < gs.length && !gs[j]!.tab && gs[j]!.cluster === g.cluster) j++
    let chars = 0
    for (let m = i; m < j; m++) chars += gs[m]!.chars
    const u: Unit = { i, j, start: g.cluster, end: g.cluster + Math.max(chars, 1) }
    const prev = units[units.length - 1]
    const contiguous = prev !== undefined && prev.j === i
    const outOfOrder = prev !== undefined && contiguous && (run.rtl ? u.end > prev.start : u.start < prev.end)
    if (outOfOrder) {
      prev.j = j
      prev.start = Math.min(prev.start, u.start)
      prev.end = Math.max(prev.end, u.end)
    } else units.push(u)
    i = j
  }
  const unitTexts = units.map((u) => {
    let hasText = false
    for (let m = u.i; m < u.j; m++) if (gs[m]!.chars > 0) hasText = true
    return hasText ? text.slice(u.start, u.end) : ''
  })
  // PDF.js quirk (documented in docs/text-engine.md): a glyph whose text contains a combining mark (Mn) counts as
  // zero width for its gap detection, so a word that starts with one right after a space gets a second, spurious space.
  // We keep the pen model consistent by giving that space no advance in the PDF and moving the drawn units onto
  // their real position inside the next glyph instead (composite glyphs make this free).
  let carry = 0 // width (layout units) of a space folded into the next unit
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui]!
    const g = gs[u.i]!
    const logicalText = unitTexts[ui]!
    // Extractors (PDF.js, pdfium, poppler) reorder right-to-left glyph strings from visual to logical order character
    // by character, so the text of a multi-character glyph in an RTL run is stored reversed: their reversal then
    // restores the logical order. (Readers that honour /ActualText never look at it.)
    const unitText = run.rtl && logicalText.length > 1 ? Array.from(logicalText).reverse().join('') : logicalText
    const ox = g.x - g.dx // the pen position at the start of the unit
    const baseRise = run.style.rise
    // A space directly followed by a unit with a combining mark: fold the space into that unit.
    const next = units[ui + 1]
    if (u.j - u.i === 1 && g.space && next && next.i === u.j && /\p{Mn}/u.test(unitTexts[ui + 1]!)) {
      const zero = ef.compositeCode([{ gid: g.gid, dx: 0, dy: 0 }], unitText, 0)
      if (zero !== null) {
        show(zero, ox, baseRise)
        carry = g.advance
        continue
      }
    }
    const shift = carry
    carry = 0
    let displaced = u.j - u.i > 1 || shift !== 0
    const comps: { gid: number; dx: number; dy: number }[] = []
    let advance = shift * k
    for (let m = u.i; m < u.j; m++) {
      const c = gs[m]!
      const cdx = (c.x - ox + shift) * k
      const cdy = -c.dy * k
      if (Math.abs(cdx) > 0.5 || Math.abs(cdy) > 0.5) displaced = true
      comps.push({ gid: c.gid, dx: cdx, dy: cdy })
      advance += c.natural * k
    }
    let code: number | null = null
    if (displaced) code = ef.compositeCode(comps, unitText, advance)
    if (code !== null) show(code, ox - shift, baseRise)
    else if (!displaced) show(ef.code(g.gid, unitText, g.natural * k), g.x, baseRise)
    else {
      // No composite possible (CFF outlines): glyph by glyph at their own origins.
      for (let m = u.i; m < u.j; m++) {
        const c = gs[m]!
        show(ef.code(c.gid, c.chars > 0 ? text.slice(c.cluster, c.cluster + c.chars) : undefined, c.natural * k), c.x, -c.y)
      }
    }
  }
  flush()
  if (rise !== 0) out.push('0 Ts')
}
