import { loadResource } from './env'
import { loadHarfBuzz, hbSync } from './hb'
import type * as HB from './vendor/harfbuzz/index.mjs'

/**
 * Fonts: the catalogue of bundled fonts, loaded fonts (`TextFont`), and font stacks with per-character fallback
 * candidates. Bundled font files are read on demand; their Unicode coverage comes from the catalogue
 * (resources/fonts/text-fonts.json), so choosing a fallback font never requires loading the candidates.
 */

// ---------------------------------------------------------------------------------------------------------------
// Catalogue

export interface FaceInfo {
  file: string
  style: string
  weight: number
  italic: boolean
  upem: number
  ascent: number
  descent: number
  lineGap: number
  numGlyphs: number
  outline: 'glyf' | 'cff'
  bytes: number
  license: string
  /** Flat [start, end, start, end, ...] inclusive Unicode ranges. */
  ranges: number[]
}
export type FontCategory = 'sans' | 'serif' | 'mono' | 'script' | 'symbol' | 'emoji' | 'cjk'
export interface FamilyInfo {
  id: string
  name: string
  category: FontCategory
  /** ISO 15924 scripts the family is meant for. */
  scripts: string[]
  faces: FaceInfo[]
}
export interface Catalog {
  version: number
  families: FamilyInfo[]
}

let catalogPromise: Promise<Catalog> | null = null
let catalogSync: Catalog | null = null

export function getCatalog(): Promise<Catalog> {
  catalogPromise ??= loadResource('fonts/text-fonts.json').then((b) => {
    catalogSync = JSON.parse(new TextDecoder().decode(b)) as Catalog
    return catalogSync
  })
  catalogPromise.catch(() => (catalogPromise = null))
  return catalogPromise
}

export function catalogSyncOrThrow(): Catalog {
  if (!catalogSync) throw new Error('Font catalogue not loaded yet (await getCatalog())')
  return catalogSync
}

// ---------------------------------------------------------------------------------------------------------------
// Coverage

/** Set of code points as sorted inclusive ranges with binary search lookup. */
export class Coverage {
  constructor(readonly ranges: ArrayLike<number>) {}

  has(cp: number): boolean {
    const r = this.ranges
    let lo = 0
    let hi = (r.length >> 1) - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (cp < r[mid * 2]!) hi = mid - 1
      else if (cp > r[mid * 2 + 1]!) lo = mid + 1
      else return true
    }
    return false
  }

  static fromCodePoints(sorted: ArrayLike<number>): Coverage {
    const out: number[] = []
    for (let i = 0; i < sorted.length; i++) {
      const cp = sorted[i]!
      const n = out.length
      if (n && cp === out[n - 1]! + 1) out[n - 1] = cp
      else out.push(cp, cp)
    }
    return new Coverage(out)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Loaded fonts

const u16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!
const i16 = (b: Uint8Array, o: number): number => ((u16(b, o) << 16) >> 16)
const i32 = (b: Uint8Array, o: number): number => (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!

export interface FontDescriptorInfo {
  bbox: [number, number, number, number]
  italicAngle: number
  capHeight: number
  xHeight: number
  weight: number
  symbolic: boolean
  serif: boolean
  fixedPitch: boolean
  italic: boolean
  /** In font units: underline position (negative = below the baseline) and thickness, strikeout position and thickness. */
  underlinePosition: number
  underlineThickness: number
  strikePosition: number
  strikeThickness: number
}

/** A font ready for shaping: HarfBuzz face + metrics. Instances are shared (one per font file / byte array). */
export class TextFont {
  readonly key: string
  readonly family: string
  readonly postScriptName: string
  readonly weight: number
  readonly italic: boolean
  readonly upem: number
  /** Vertical metrics in font units (ascent > 0, descent > 0 below the baseline, lineGap >= 0). */
  readonly ascent: number
  readonly descent: number
  readonly lineGap: number
  readonly numGlyphs: number
  readonly outline: 'glyf' | 'cff'
  readonly descriptor: FontDescriptorInfo
  readonly coverage: Coverage
  readonly hasVariations: boolean
  /** hb objects, kept alive as long as the font is. */
  readonly hbFace: HB.Face
  readonly hbFont: HB.Font
  private advances: Float32Array
  private advanceKnown: Uint8Array

  constructor(
    readonly bytes: Uint8Array,
    hb: typeof HB,
    key: string,
    fallback?: { family?: string; weight?: number; italic?: boolean; coverage?: Coverage; index?: number }
  ) {
    this.key = key
    const face = new hb.Face(new hb.Blob(bytes), fallback?.index ?? 0)
    const font = new hb.Font(face)
    this.hbFace = face
    this.hbFont = font
    const tab = (t: string): Uint8Array | undefined => face.referenceTable(t)
    const head = tab('head')
    if (!head) throw new Error('Not a usable font: no head table')
    this.upem = u16(head, 18) || 1000
    font.setScale(this.upem, this.upem)
    const macStyle = u16(head, 44)
    const maxp = tab('maxp')
    this.numGlyphs = maxp ? u16(maxp, 4) : 0
    this.outline = tab('CFF ') || tab('CFF2') ? 'cff' : 'glyf'
    this.hasVariations = !!tab('fvar')
    const os2 = tab('OS/2')
    this.weight = os2 ? u16(os2, 4) : macStyle & 1 ? 700 : 400
    const fsSel = os2 ? u16(os2, 62) : 0
    this.italic = !!(fsSel & 1) || !!(macStyle & 2)
    const ext = font.hExtents()
    this.ascent = ext.ascender
    this.descent = Math.abs(ext.descender)
    this.lineGap = Math.max(0, ext.lineGap)
    if (this.ascent + this.descent <= 0) {
      this.ascent = Math.round(this.upem * 0.9)
      this.descent = Math.round(this.upem * 0.25)
    }
    this.family = face.getName(16, 'en') || face.getName(1, 'en') || fallback?.family || 'Font'
    this.postScriptName = (face.getName(6, 'en') || this.family).replace(/[^A-Za-z0-9-]/g, '') || 'Font'
    const post = tab('post')
    const italicAngle = post ? i32(post, 4) / 65536 : 0
    const capHeight = os2 && u16(os2, 0) >= 2 && os2.length >= 90 ? i16(os2, 88) : Math.round(this.ascent * 0.7)
    const xHeight = os2 && u16(os2, 0) >= 2 && os2.length >= 90 ? i16(os2, 86) : Math.round(this.ascent * 0.5)
    const familyClass = os2 ? os2[30]! : 0
    this.descriptor = {
      bbox: [i16(head, 36), i16(head, 38), i16(head, 40), i16(head, 42)],
      italicAngle,
      capHeight,
      xHeight,
      weight: this.weight,
      symbolic: true,
      serif: familyClass >= 1 && familyClass <= 7,
      fixedPitch: !!(post && i32(post, 12) !== 0),
      italic: this.italic,
      underlinePosition: post && post.length >= 12 ? i16(post, 8) : -Math.round(this.upem * 0.1),
      underlineThickness: post && post.length >= 12 ? Math.max(1, i16(post, 10)) : Math.round(this.upem * 0.05),
      strikePosition: os2 && os2.length >= 30 ? i16(os2, 28) : Math.round(this.upem * 0.3),
      strikeThickness: os2 && os2.length >= 30 ? Math.max(1, i16(os2, 26)) : Math.round(this.upem * 0.05)
    }
    this.coverage = fallback?.coverage ?? Coverage.fromCodePoints(Array.from(face.collectUnicodes()).sort((a, b) => a - b))
    this.advances = new Float32Array(this.numGlyphs + 1)
    this.advanceKnown = new Uint8Array(this.numGlyphs + 1)
  }

  /** Glyph id for a code point (0 = missing). */
  glyphFor(cp: number): number {
    return this.hbFont.nominalGlyph(cp) ?? 0
  }

  hasGlyph(cp: number): boolean {
    return this.coverage.has(cp)
  }

  /** Horizontal advance of a glyph in font units (cached). */
  advanceOf(gid: number): number {
    if (gid < this.advanceKnown.length) {
      if (this.advanceKnown[gid]) return this.advances[gid]!
      const a = this.hbFont.glyphHAdvance(gid)
      this.advances[gid] = a
      this.advanceKnown[gid] = 1
      return a
    }
    return this.hbFont.glyphHAdvance(gid)
  }
}

const fontCache = new Map<string, Promise<TextFont>>()
const byteFonts = new WeakMap<Uint8Array, Promise<TextFont>>()
let byteFontCounter = 0

/** Load (once) a font file bundled with the app by its file name in resources/fonts. */
export function loadBundledFont(file: string): Promise<TextFont> {
  let p = fontCache.get(file)
  if (!p) {
    p = (async () => {
      const [hb, bytes, catalog] = await Promise.all([loadHarfBuzz(), loadResource(`fonts/${file}`), getCatalog()])
      let coverage: Coverage | undefined
      for (const f of catalog.families) for (const face of f.faces) if (face.file === file) coverage = new Coverage(face.ranges)
      return new TextFont(bytes, hb, `bundled:${file}`, { coverage })
    })()
    p.catch(() => fontCache.delete(file))
    fontCache.set(file, p)
  }
  return p
}

/** A font from bytes supplied by the caller (a document's own font, a user font). Cached by array identity. */
export function loadFontFromBytes(bytes: Uint8Array, opts: { name?: string; index?: number } = {}): Promise<TextFont> {
  let p = byteFonts.get(bytes)
  if (!p) {
    p = loadHarfBuzz().then((hb) => new TextFont(bytes, hb, `user:${++byteFontCounter}`, { family: opts.name, index: opts.index }))
    byteFonts.set(bytes, p)
  }
  return p
}

// ---------------------------------------------------------------------------------------------------------------
// Candidates and stacks

/** One entry of a resolved font stack: something that may cover a character, loadable on demand. */
export interface FontCandidate {
  /** Stable identity of the underlying font file/bytes (plus synthetic flags). */
  id: string
  family: string
  category: FontCategory
  /** Does the font have a glyph for this code point? Never loads the font. */
  covers(cp: number): boolean
  load(): Promise<TextFont>
  synthBold: boolean
  synthItalic: boolean
}

export type FontRef =
  | string
  | TextFont
  | { bytes: Uint8Array; name?: string; index?: number; category?: FontCategory }

export interface FontStackOptions {
  /** Preferred fonts, first match wins per character. Family ids/names ("Noto Sans Arabic", "noto-naskh-arabic", "serif"), font bytes or loaded fonts. */
  fontStack?: FontRef[]
  weight?: number | 'normal' | 'bold'
  italic?: boolean
  /** BCP 47 language: chooses the CJK font order (ja, ko, zh-Hant/TW/HK) and language-specific glyph forms. */
  lang?: string
  /** Set false to use only `fontStack` (missing characters are then reported instead of falling back to bundled fonts). */
  fallback?: boolean
}

const ALIASES: Record<string, string> = {
  sans: 'noto-sans',
  'sans-serif': 'noto-sans',
  'system-ui': 'noto-sans',
  serif: 'liberation-serif',
  mono: 'liberation-mono',
  monospace: 'liberation-mono',
  helvetica: 'liberation-sans',
  arial: 'liberation-sans',
  times: 'liberation-serif',
  'times-new-roman': 'liberation-serif',
  courier: 'liberation-mono',
  'courier-new': 'liberation-mono',
  calibri: 'carlito',
  cambria: 'caladea',
  'noto-sans-symbols2': 'noto-sans-symbols-2'
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function findFamily(catalog: Catalog, name: string): FamilyInfo | undefined {
  const id = ALIASES[slug(name)] ?? slug(name)
  return catalog.families.find((f) => f.id === id || slug(f.name) === id)
}

function weightOf(w: FontStackOptions['weight']): number {
  return w === 'bold' ? 700 : w === 'normal' || w === undefined ? 400 : w
}

/** Choose the face of a family closest to the requested weight/italic. */
export function pickFace(family: FamilyInfo, weight: number, italic: boolean): { face: FaceInfo; synthBold: boolean; synthItalic: boolean } {
  let best: FaceInfo | undefined
  let bestScore = Infinity
  for (const f of family.faces) {
    const score = Math.abs(f.weight - weight) + (f.italic === italic ? 0 : 1000)
    if (score < bestScore) {
      bestScore = score
      best = f
    }
  }
  const face = best ?? family.faces[0]!
  return { face, synthBold: weight >= 600 && face.weight < 600, synthItalic: italic && !face.italic }
}

const CJK_ORDER: Record<string, string[]> = {
  ja: ['noto-sans-jp', 'noto-sans-sc', 'noto-sans-tc', 'noto-sans-kr'],
  ko: ['noto-sans-kr', 'noto-sans-jp', 'noto-sans-sc', 'noto-sans-tc'],
  'zh-hant': ['noto-sans-tc', 'noto-sans-sc', 'noto-sans-jp', 'noto-sans-kr'],
  'zh-hans': ['noto-sans-sc', 'noto-sans-jp', 'noto-sans-tc', 'noto-sans-kr']
}

/** Language key for CJK ordering from a BCP 47 tag ('ja', 'ko', 'zh-Hant', 'zh-TW' ...). */
export function cjkLangKey(lang: string | undefined): keyof typeof CJK_ORDER {
  const l = (lang ?? '').toLowerCase()
  if (l.startsWith('ja')) return 'ja'
  if (l.startsWith('ko')) return 'ko'
  if (l.startsWith('zh') && /hant|tw|hk|mo/.test(l)) return 'zh-hant'
  return 'zh-hans'
}

const SCRIPT_FAMILIES = [
  'noto-sans-arabic',
  'noto-naskh-arabic',
  'noto-sans-hebrew',
  'noto-sans-thai',
  'noto-sans-devanagari',
  'noto-sans-bengali',
  'noto-sans-tamil',
  'noto-sans-telugu',
  'noto-sans-gujarati',
  'noto-sans-gurmukhi',
  'noto-sans-kannada',
  'noto-sans-malayalam',
  'noto-sans-oriya',
  'noto-sans-sinhala',
  'noto-sans-thaana',
  'noto-sans-syriac',
  'noto-sans-armenian',
  'noto-sans-georgian',
  'noto-sans-lao',
  'noto-sans-khmer',
  'noto-sans-myanmar',
  'noto-sans-ethiopic'
]
const SYMBOL_FAMILIES = ['noto-sans-symbols', 'noto-sans-symbols-2', 'noto-sans-math', 'noto-emoji']

const candidateCache = new Map<string, FontCandidate>()

function bundledCandidate(family: FamilyInfo, weight: number, italic: boolean): FontCandidate {
  const { face, synthBold, synthItalic } = pickFace(family, weight, italic)
  const id = `${face.file}${synthBold ? '+b' : ''}${synthItalic ? '+i' : ''}`
  let c = candidateCache.get(id)
  if (!c) {
    const cov = new Coverage(face.ranges)
    c = {
      id,
      family: family.name,
      category: family.category,
      covers: (cp) => cov.has(cp),
      load: () => loadBundledFont(face.file),
      synthBold,
      synthItalic
    }
    candidateCache.set(id, c)
  }
  return c
}

const userCandidates = new WeakMap<object, FontCandidate>()

let userCandidateCounter = 0

function userCandidate(ref: TextFont | { bytes: Uint8Array; name?: string; index?: number; category?: FontCategory }): FontCandidate {
  const anchor = ref instanceof TextFont ? ref : ref.bytes
  let c = userCandidates.get(anchor)
  if (!c) {
    let loaded: Promise<TextFont> | undefined
    let font: TextFont | undefined
    const load = (): Promise<TextFont> => {
      loaded ??= ref instanceof TextFont ? Promise.resolve(ref) : loadFontFromBytes(ref.bytes, { name: ref.name, index: ref.index })
      return loaded.then((f) => (font = f))
    }
    c = {
      id: `user#${++userCandidateCounter}`,
      family: ref instanceof TextFont ? ref.family : ref.name ?? 'Font',
      category: ref instanceof TextFont ? 'sans' : ref.category ?? 'sans',
      // User fonts must be loaded to know their coverage; `prepareStack` does that before itemization.
      covers: (cp) => (font ?? (ref instanceof TextFont ? ref : undefined))?.hasGlyph(cp) ?? false,
      load,
      synthBold: false,
      synthItalic: false
    }
    if (ref instanceof TextFont) font = ref
    userCandidates.set(anchor, c)
  }
  return c
}

/**
 * Resolve a stack description into ordered candidates: the caller's fonts first (each in the requested weight/style
 * when the family has it), then the bundled fallbacks (scripts, CJK in the order for `lang`, symbols, emoji).
 * User-supplied fonts are loaded here so their coverage is known.
 */
export async function resolveStack(opts: FontStackOptions = {}): Promise<FontCandidate[]> {
  const catalog = await getCatalog()
  const weight = weightOf(opts.weight)
  const italic = opts.italic ?? false
  const out: FontCandidate[] = []
  const seen = new Set<string>()
  const push = (c: FontCandidate | undefined): void => {
    if (!c) return
    if (seen.has(c.id)) return
    seen.add(c.id)
    out.push(c)
  }
  let firstCategory: FontCategory | undefined
  for (const ref of opts.fontStack ?? []) {
    if (typeof ref === 'string') {
      const fam = findFamily(catalog, ref)
      if (fam) {
        firstCategory ??= fam.category
        push(bundledCandidate(fam, weight, italic))
      }
    } else {
      const c = userCandidate(ref)
      await c.load()
      firstCategory ??= c.category
      push(c)
    }
  }
  if (opts.fallback === false) return out
  const fam = (id: string): FamilyInfo | undefined => catalog.families.find((f) => f.id === id)
  const add = (id: string): void => {
    const f = fam(id)
    if (f) push(bundledCandidate(f, weight, italic))
  }
  const serifFirst = firstCategory === 'serif'
  add(serifFirst ? 'liberation-serif' : 'noto-sans')
  add(serifFirst ? 'noto-sans' : 'liberation-serif')
  if (serifFirst) {
    add('noto-naskh-arabic')
  }
  for (const id of SCRIPT_FAMILIES) add(id)
  for (const id of CJK_ORDER[cjkLangKey(opts.lang)]!) add(id)
  for (const id of SYMBOL_FAMILIES) add(id)
  return out
}

/** Load the font behind a candidate (shared per file). */
export function loadCandidate(c: FontCandidate): Promise<TextFont> {
  return c.load()
}

export function synchronousHb(): typeof HB {
  return hbSync()
}
