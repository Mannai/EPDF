import { dirname } from 'node:path'
import { isTextEngineConfigured } from '../../../../shared/text/env'
import { Coverage, getCatalog, loadBundledFont, pickFace, type Catalog, type FaceInfo, type FamilyInfo, type TextFont } from '../../../../shared/text/fonts'
import { loadHarfBuzz } from '../../../../shared/text/hb'
import { isDefaultIgnorable, resolveScripts, SCRIPT_TAGS } from '../../../../shared/text/script'
import { shapeText } from '../../../../shared/text/shape'
import { useNodeResources } from '../../textengine/nodeResources'

/**
 * Fonts for the built-in Office converter, on top of the text engine (src/shared/text, docs/text-engine.md).
 *
 * Only permissively licensed fonts are bundled (SIL Open Font License): Liberation Sans/Serif/Mono (metric-compatible
 * with Arial/Times New Roman/Courier New), Carlito (Calibri), Caladea (Cambria), Noto Sans, and the engine's script
 * fonts: Noto Naskh Arabic, Noto Sans Arabic, Noto Nastaliq Urdu, Hebrew, Indic, Thai, CJK, symbols, emoji.
 *
 * A document font name maps to a `Face`: a font STACK. The Latin family comes first (or the Arabic one for Arabic font
 * names such as "Simplified Arabic"), then the Arabic font chosen for that name (see ARABIC_FONTS: Office's Arabic fonts
 * map to Noto Naskh / Noto Sans Arabic, with a size factor measured against the Microsoft fonts), then the engine's
 * bundled fallbacks. Every character is drawn from the first font of the stack that has it (CSS semantics), and text is
 * measured with HarfBuzz shaping in exactly the fonts it is drawn with, so line breaks match the PDF.
 *
 * Line heights come from the document font's metric-compatible face (Liberation for Arial, ...), not from the Noto
 * fallback, as in Word, where an Arabic run in "Arial" gets Arial's line height.
 *
 * The layout code is synchronous. `prepare()` (async) loads HarfBuzz, the catalogue and the common fonts; a font that
 * turns out to be needed later (a CJK or Indic fallback) is recorded in `pending`, the conversion pass is finished
 * with approximate widths and then re-run once the fonts are loaded (see convertOffice).
 */

export type BundledFamily = 'LiberationSans' | 'LiberationSerif' | 'LiberationMono' | 'Carlito' | 'Caladea' | 'NotoSans'
export type ComplexFamily = 'NotoNaskhArabic' | 'NotoSansArabic' | 'NotoNastaliqUrdu'

const ENGINE_ID: Record<BundledFamily | ComplexFamily, string> = {
  LiberationSans: 'liberation-sans',
  LiberationSerif: 'liberation-serif',
  LiberationMono: 'liberation-mono',
  Carlito: 'carlito',
  Caladea: 'caladea',
  NotoSans: 'noto-sans',
  NotoNaskhArabic: 'noto-naskh-arabic',
  NotoSansArabic: 'noto-sans-arabic',
  NotoNastaliqUrdu: 'noto-nastaliq-urdu'
}

export interface Face {
  /** Unique per stack + style (used for caches and grouping). */
  key: string
  /** The Latin (metric-compatible) family of the document font. */
  family: BundledFamily
  /** The font used for Arabic-script text of this document font. */
  complex: ComplexFamily
  /** Size factor for the Arabic font (matches the Microsoft font's measured width/ink height). */
  complexScale: number
  /** True when the document font is an Arabic font: the Arabic face comes first and gives the line metrics. */
  complexFirst: boolean
  bold: boolean
  italic: boolean
}

const STYLE_SUFFIX = (bold: boolean, italic: boolean): string => (bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular')

const CARLITO = /^(calibri|carlito|aptos|candara|corbel|calibri light)/
const CALADEA = /^(cambria|caladea)/
const MONO = /(courier|consolas|lucida ?console|monaco|menlo|andale ?mono|dejavu ?sans ?mono|mono|typewriter|source ?code|fira ?code|cascadia|inconsolata|terminal)/
const SERIF = /^(times|georgia|garamond|palatino|book ?antiqua|bookman|century ?schoolbook|constantia|baskerville|minion|liberation ?serif|tinos|serif|ms ?serif|cambria math|didot|sylfaen|perpetua|rockwell|footlight|goudy|hoefler|new ?york|charter|iowan|lora|merriweather|playfair|noto ?serif|dejavu ?serif|source ?serif|pt ?serif)/

const normName = (name: string | undefined | null): string => {
  let n = (name ?? '').toLowerCase().replace(/^[a-z]{6}\+/, '').replace(/[-,_](regular|bold|italic|oblique|bolditalic|light|medium|semibold)$/g, '').trim()
  n = n.replace(/\s+(regular|bold|italic|oblique)$/g, '')
  return n
}

/**
 * Arabic-script fonts named by Office documents, and how Epdf draws them. `latin`: the family for the Latin characters
 * of a font that is itself an Arabic font. `scale`: size factor of the bundled Arabic face, the geometric mean of the
 * width ratio and the letter-height ratio measured against the Microsoft font (tests/unit/officeArabicFontMetrics.test.ts;
 * table in docs/features/office-rtl.md). 1 where the Microsoft font was not available to measure.
 */
interface ArabicMapping {
  re: RegExp
  complex: ComplexFamily
  scale: number
  /** The font name is an Arabic font (its Arabic glyphs define the style and the line metrics). */
  arabicFont: boolean
  latin?: BundledFamily
}
const ARABIC_FONTS: ArabicMapping[] = [
  // Latin fonts that contain Arabic glyphs (Word uses them as the complex-script font: w:rFonts w:cs="Arial")
  { re: /^(arial|helvetica|liberation ?sans|arimo)/, complex: 'NotoNaskhArabic', scale: 0.975, arabicFont: false },
  { re: /^(times|liberation ?serif|tinos)/, complex: 'NotoNaskhArabic', scale: 0.964, arabicFont: false },
  { re: /^(calibri|carlito)/, complex: 'NotoNaskhArabic', scale: 0.996, arabicFont: false },
  { re: /^(tahoma|verdana|microsoft sans serif|ms sans serif)/, complex: 'NotoSansArabic', scale: 1.063, arabicFont: false },
  { re: /^(segoe ui)/, complex: 'NotoSansArabic', scale: 1.065, arabicFont: false },
  { re: /^(courier)/, complex: 'NotoNaskhArabic', scale: 1, arabicFont: false },
  // Arabic fonts
  { re: /^(simplified arabic|traditional arabic|arabic typesetting|sakkal majalla|arabic transparent|andalus|aldhabi|microsoft uighur|urdu typesetting|noto naskh|amiri|scheherazade|lateef|kfgqpc|uthman|me quran|al qalam|lotus|mitra|nazanin|b nazanin|b lotus|b mitra|zar|b zar|yagut|badr|traditional naskh|naskh|al bayan|geeza pro|baghdad|nadeem|damascus|mishafi|diwani|decotype|arabic)/, complex: 'NotoNaskhArabic', scale: 1, arabicFont: true, latin: 'LiberationSerif' },
  { re: /^(dubai|noto sans arabic|noto kufi|cairo|tajawal|almarai|ibm plex sans arabic|vazir|sahel|shabnam|samim|tanha|droid arabic|droid sans arabic|kufi|kufam|el messiri|harmattan|markazi|changa|mada|lalezar|rubik arabic|b koodak|koodak|b titr|titr|b yekan|yekan|b traffic|traffic|b roya|roya|sultan)/, complex: 'NotoSansArabic', scale: 1, arabicFont: true, latin: 'LiberationSans' },
  { re: /(nastaliq|nastaleeq|nasta'liq)/, complex: 'NotoNastaliqUrdu', scale: 1, arabicFont: true, latin: 'LiberationSerif' }
]

/** Maps a document font name (Word, ODF, RTF, PDF PostScript name...) to the closest bundled Latin family. */
export function mapFontFamily(name: string | undefined | null): BundledFamily {
  const n = normName(name)
  if (!n) return 'LiberationSans'
  if (n === 'noto sans') return 'NotoSans'
  const ar = ARABIC_FONTS.find((m) => m.arabicFont && m.re.test(n))
  if (ar) return ar.latin ?? 'LiberationSerif'
  if (CARLITO.test(n)) return 'Carlito'
  if (CALADEA.test(n)) return 'Caladea'
  if (MONO.test(n)) return 'LiberationMono'
  if (SERIF.test(n) || (/serif/.test(n) && !/sans/.test(n))) return 'LiberationSerif'
  return 'LiberationSans'
}

/** How Arabic-script text set in a document font is drawn: the bundled Arabic family and its size factor. */
export function mapComplexFamily(name: string | undefined | null): { family: ComplexFamily; scale: number; arabicFont: boolean } {
  const n = normName(name)
  const m = ARABIC_FONTS.find((a) => a.re.test(n))
  if (m) return { family: m.complex, scale: m.scale, arabicFont: m.arabicFont }
  return { family: 'NotoNaskhArabic', scale: 1, arabicFont: false }
}

/**
 * Control characters and invisible characters that must not reach the PDF are dropped; NBSP and friends become plain
 * spaces. Joiners (ZWJ/ZWNJ: Arabic and Persian shaping) and the bidi marks and controls are KEPT: the line builder
 * gives them to the bidi algorithm and to HarfBuzz, and draws no glyph for them.
 */
export function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​⁠﻿­]/g, '').replace(/[    -  - ]/g, ' ')
}

export interface FaceMetrics {
  /** All in em (fractions of the font size). */
  ascent: number
  descent: number
  lineGap: number
  xHeight: number
}

/** One font of a stack: a bundled face file, its coverage, the size factor and synthetic styles. */
export interface StackEntry {
  file: string
  dir: string
  coverage: Coverage
  scale: number
  synthBold: boolean
  synthItalic: boolean
  category: string
}

/** A piece of text in one font, one script and one direction (for shaping). */
export interface FontRun {
  s: number
  e: number
  entry: StackEntry
  script: string
}

/** Scripts HarfBuzz shapes right to left. */
const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm', 'Mand', 'Samr', 'Phnx', 'Khar', 'Nbat', 'Palm', 'Avst'])
export const isRtlScript = (s: string): boolean => RTL_SCRIPTS.has(s)

const SCRIPT_FAMILIES = [
  'noto-sans-arabic', 'noto-naskh-arabic', 'noto-sans-hebrew', 'noto-sans-thai', 'noto-sans-devanagari', 'noto-sans-bengali', 'noto-sans-tamil',
  'noto-sans-telugu', 'noto-sans-gujarati', 'noto-sans-gurmukhi', 'noto-sans-kannada', 'noto-sans-malayalam', 'noto-sans-oriya', 'noto-sans-sinhala',
  'noto-sans-thaana', 'noto-sans-syriac', 'noto-sans-armenian', 'noto-sans-georgian', 'noto-sans-lao', 'noto-sans-khmer', 'noto-sans-myanmar',
  'noto-sans-ethiopic'
]
const CJK_FAMILIES = ['noto-sans-sc', 'noto-sans-jp', 'noto-sans-tc', 'noto-sans-kr']
const SYMBOL_FAMILIES = ['noto-sans-symbols', 'noto-sans-symbols-2', 'noto-sans-math', 'noto-emoji']

/** Fonts loaded up front (the Latin families in every style, Noto Sans, the Arabic faces). */
const PRELOAD = ['liberation-sans', 'liberation-serif', 'liberation-mono', 'carlito', 'caladea', 'noto-sans', 'noto-naskh-arabic', 'noto-sans-arabic']

/** Do not keep shaping results for more than this many distinct words per face (memory bound on huge documents). */
const WIDTH_CACHE_LIMIT = 200_000

export class FontCatalog {
  /** Characters no bundled font could draw (reported to the user as a warning). */
  readonly missing = new Set<string>()
  /** Font files needed but not loaded yet (the pass must be re-run after `loadPending`). */
  readonly pending = new Set<string>()
  private catalog: Catalog | null = null
  private fonts = new Map<string, TextFont>()
  private stacks = new Map<string, StackEntry[]>()
  private widths = new Map<string, Map<string, number>>()
  private faceInfo = new Map<string, FaceInfo>()

  constructor(private readonly fontsDir: string) {}

  /** Loads HarfBuzz, the font catalogue and the common fonts. Must be awaited once before any layout. */
  async prepare(): Promise<void> {
    if (!isTextEngineConfigured()) useNodeResources(dirname(this.fontsDir))
    await loadHarfBuzz()
    this.catalog = await getCatalog()
    for (const fam of this.catalog.families) for (const f of fam.faces) this.faceInfo.set(f.file, f)
    const files: string[] = []
    for (const id of PRELOAD) {
      const fam = this.family(id)
      if (fam) for (const f of fam.faces) files.push(f.file)
    }
    await Promise.all(files.map(async (f) => this.fonts.set(f, await loadBundledFont(f))))
  }

  /** Loads the fonts recorded in `pending`. Returns true when something was loaded (the caller re-runs the pass). */
  async loadPending(): Promise<boolean> {
    if (this.pending.size === 0) return false
    const files = [...this.pending]
    this.pending.clear()
    await Promise.all(files.map(async (f) => this.fonts.set(f, await loadBundledFont(f))))
    this.widths.clear()
    return true
  }

  /** Start a fresh conversion pass (keeps loaded fonts and caches). */
  resetPass(): void {
    this.missing.clear()
  }

  private cat(): Catalog {
    if (!this.catalog) throw new Error('FontCatalog.prepare() was not awaited')
    return this.catalog
  }

  private family(id: string): FamilyInfo | undefined {
    return this.cat().families.find((f) => f.id === id)
  }

  /** The loaded font of a stack entry, or null (recorded as pending) when it is not loaded yet. */
  fontOf(entry: StackEntry): TextFont | null {
    const f = this.fonts.get(entry.file)
    if (f) return f
    this.pending.add(entry.file)
    return null
  }

  /** The face for a document font + style. */
  face(family: string | undefined | null, bold: boolean, italic: boolean): Face {
    const fam = mapFontFamily(family)
    const cx = mapComplexFamily(family)
    return this.make(fam, cx.family, cx.scale, cx.arabicFont, bold, italic)
  }

  faceOf(family: BundledFamily, bold: boolean, italic: boolean): Face {
    const cx = mapComplexFamily(family === 'LiberationSerif' ? 'Times New Roman' : family === 'Carlito' ? 'Calibri' : family === 'LiberationMono' ? 'Courier New' : 'Arial')
    return this.make(family, cx.family, cx.scale, false, bold, italic)
  }

  private make(family: BundledFamily, complex: ComplexFamily, complexScale: number, complexFirst: boolean, bold: boolean, italic: boolean): Face {
    // The existing key format (`LiberationSans-Bold`) is kept for Latin faces: it names the face in caches and tests.
    const base = `${family}-${STYLE_SUFFIX(bold, italic)}`
    const key = complexFirst ? `${complex}+${base}` : complex === 'NotoNaskhArabic' && complexScale === defaultScale(family) ? base : `${base}+${complex}@${complexScale}`
    return { key, family, complex, complexScale, complexFirst, bold, italic }
  }

  /** The ordered font stack of a face. */
  stack(face: Face): StackEntry[] {
    let s = this.stacks.get(face.key)
    if (s) return s
    s = []
    const seen = new Set<string>()
    const weight = face.bold ? 700 : 400
    const add = (id: string, scale = 1): void => {
      const fam = this.family(id)
      if (!fam) return
      const { face: fi, synthBold, synthItalic } = pickFace(fam, weight, face.italic)
      if (seen.has(fi.file)) return
      seen.add(fi.file)
      s!.push({ file: fi.file, dir: fi.dir, coverage: new Coverage(fi.ranges), scale, synthBold, synthItalic, category: fam.category })
    }
    const latin = ENGINE_ID[face.family]
    const complex = ENGINE_ID[face.complex]
    if (face.complexFirst) {
      add(complex, face.complexScale)
      add(latin)
    } else {
      add(latin)
      add(complex, face.complexScale)
    }
    add('noto-sans')
    add('liberation-serif')
    add(face.complex === 'NotoSansArabic' ? 'noto-naskh-arabic' : 'noto-sans-arabic')
    for (const id of SCRIPT_FAMILIES) add(id)
    for (const id of CJK_FAMILIES) add(id)
    for (const id of SYMBOL_FAMILIES) add(id)
    this.stacks.set(face.key, s)
    return s
  }

  /** Line metrics of the face (its first font: the document font's metric-compatible face). */
  metrics(face: Face): FaceMetrics {
    const first = this.stack(face)[0]
    const fi = first ? this.faceInfo.get(first.file) : undefined
    if (!fi) return { ascent: 0.9, descent: 0.25, lineGap: 0, xHeight: 0.5 }
    const u = fi.upem || 1000
    const k = first!.scale
    return { ascent: (fi.ascent / u) * k, descent: (Math.abs(fi.descent) / u) * k, lineGap: (Math.max(0, fi.lineGap) / u) * k, xHeight: 0.5 * k }
  }

  /** Can some font of the face's stack draw this code point? */
  hasGlyph(face: Face, cp: number): boolean {
    return this.stack(face).some((e) => e.coverage.has(cp))
  }

  /** Does the face's FIRST font have the code point (the document font itself, not a fallback)? */
  hasOwnGlyph(face: Face, cp: number): boolean {
    return this.stack(face)[0]?.coverage.has(cp) ?? false
  }

  /**
   * Splits `text` into runs of one font (first font of the stack that covers the whole character cluster) and one
   * script. Characters no font covers are recorded in `missing` and stay in the run of the preceding font (they are
   * drawn as that font's .notdef). `scripts` may be passed when the text is part of a longer line.
   */
  fontRuns(face: Face, text: string, from = 0, to = text.length, scripts?: { ids: Uint8Array; tags: readonly string[] }): FontRun[] {
    const stack = this.stack(face)
    const sc = scripts ?? resolveScripts(text)
    const out: FontRun[] = []
    let cur: FontRun | null = null
    let prevEntry: StackEntry | undefined
    let i = from
    while (i < to) {
      // one cluster: a base character with following combining marks / joiners / variation selectors
      let j = i
      const needed: number[] = []
      const first = text.codePointAt(j)!
      j += first > 0xffff ? 2 : 1
      if (!isDefaultIgnorable(first)) needed.push(first)
      while (j < to) {
        const cp = text.codePointAt(j)!
        if (!/\p{M}/u.test(String.fromCodePoint(cp)) && cp !== 0x200d && !(cp >= 0xfe00 && cp <= 0xfe0f)) break
        if (!isDefaultIgnorable(cp)) needed.push(cp)
        j += cp > 0xffff ? 2 : 1
      }
      let entry: StackEntry | undefined
      if (needed.length === 0) entry = prevEntry ?? stack[0]
      else {
        entry = stack.find((e) => needed.every((cp) => e.coverage.has(cp)))
        if (!entry) {
          entry = stack.find((e) => e.coverage.has(needed[0]!)) ?? prevEntry ?? stack[0]
          for (const cp of needed) if (!entry || !entry.coverage.has(cp)) this.missing.add(String.fromCodePoint(cp))
        }
      }
      prevEntry = entry
      const script = SCRIPT_TAGS[sc.ids[i]!] ?? 'Zyyy'
      if (cur && cur.entry === entry && cur.script === script) cur.e = j
      else {
        cur = { s: i, e: j, entry: entry!, script }
        out.push(cur)
      }
      i = j
    }
    return out
  }

  /** Width of `text` in em units of the style size (multiply by the font size). Shaped with HarfBuzz. */
  measure(face: Face, text: string): number {
    if (!text) return 0
    let cache = this.widths.get(face.key)
    if (!cache) this.widths.set(face.key, (cache = new Map()))
    let w = cache.get(text)
    if (w !== undefined) return w
    w = 0
    let complete = true
    for (const r of this.fontRuns(face, text)) {
      const font = this.fontOf(r.entry)
      if (!font) {
        complete = false
        w += (r.e - r.s) * 0.55 * r.entry.scale // provisional: the pass is re-run once the font is loaded
        continue
      }
      const sr = shapeText({ font, rtl: isRtlScript(r.script), script: r.script, lang: r.script === 'Arab' ? 'ar' : undefined }, text.slice(r.s, r.e))
      let adv = 0
      for (let k = 0; k < sr.length; k++) adv += sr.ax[k]!
      w += (adv / font.upem) * r.entry.scale
    }
    if (complete) {
      if (cache.size > WIDTH_CACHE_LIMIT) cache.clear()
      cache.set(text, w)
    }
    return w
  }

  /**
   * Kept for the callers that split text by font: the text engine handles fallback inside a face's stack, so a face
   * can draw any text. Returns one sanitized segment (none for empty text).
   */
  segment(face: Face, text: string): { face: Face; text: string }[] {
    const clean = sanitizeText(text)
    if (!clean) return []
    // record characters no font covers (the warning lists them)
    this.fontRuns(face, clean)
    return [{ face, text: clean }]
  }
}

function defaultScale(family: BundledFamily): number {
  return family === 'LiberationSerif' ? 0.964 : family === 'Carlito' ? 0.996 : family === 'LiberationMono' || family === 'Caladea' || family === 'NotoSans' ? 1 : 0.975
}
