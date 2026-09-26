import type { FontRef, TextFont } from './fonts'
import type { WordBreak } from './linebreak'
import type { FeatureSettings } from './shape'

/** RGB in 0..1, or a single gray value, or CMYK (4 numbers 0..1). */
export type TextColor = [number, number, number] | [number, number, number, number] | number

export type Align = 'start' | 'end' | 'left' | 'right' | 'center' | 'justify'
export type Direction = 'ltr' | 'rtl' | 'auto'

/** Everything that can differ from one piece of text to the next. All lengths are in layout units (PDF points). */
export interface TextStyle {
  /** Preferred fonts (family names/ids, bytes, loaded fonts). Bundled fallbacks are appended automatically. */
  fontStack?: FontRef[]
  /** 100..900, or 'normal' / 'bold'. */
  weight?: number | 'normal' | 'bold'
  italic?: boolean
  size?: number
  color?: TextColor
  /** 0..1 */
  opacity?: number
  /** Extra space after every character (not applied to cursive scripts such as Arabic). */
  letterSpacing?: number
  /** Extra space after every U+0020. */
  wordSpacing?: number
  /** OpenType features: `{ liga: false, smcp: true }` or `'liga=0, ss01'`. */
  features?: FeatureSettings
  /** BCP 47 language ("ar", "fa", "ur", "he", "th", "hi", "ja", "ko", "zh-Hant"): selects language-specific forms. */
  lang?: string
  underline?: boolean
  strike?: boolean
  /** Baseline shift in layout units, positive = up. */
  rise?: number
}

/** A styled piece of text inside a rich paragraph. Unset style fields inherit from the paragraph options. */
export interface Span extends TextStyle {
  text: string
}

export interface ParagraphOptions extends TextStyle {
  /** Maximum line width. Omit for a single unwrapped line per paragraph. */
  width?: number
  direction?: Direction
  align?: Align
  /** Justify the last line too (default false). */
  justifyLast?: boolean
  /** Arabic justification: stretch words with kashida (tatweel) before widening spaces. Default true. */
  kashida?: boolean
  /** Line height in points (same meaning as pdf-lib's `lineHeight`). Default: the font's own (ascent + descent + line gap). */
  lineHeight?: number
  /** Line height as a multiple of the font size (e.g. 1.4); ignored when `lineHeight` is given. */
  lineSpacing?: number
  /** Tab stops every N space-widths (default 8). */
  tabSize?: number
  /** `phrase` keeps Chinese/Japanese words together instead of breaking between any two ideographs. */
  wordBreak?: WordBreak
  /** Break a single word that is wider than `width` (default true). */
  breakLongWords?: boolean
  /** Stop after this many lines (`ParagraphLayout.truncated` reports it); the rest of the text is not laid out. */
  maxLines?: number
  /** What to do with characters no font covers: draw the font's .notdef (default) or throw. They are always reported in `missing`. */
  onMissing?: 'notdef' | 'throw'
}

export interface LayoutGlyph {
  gid: number
  /** UTF-16 index into the paragraph source text of the first character this glyph stands for. */
  cluster: number
  /** Number of UTF-16 units of source text covered by the cluster this glyph starts (>= 1; 0 for glyphs with no own characters). */
  chars: number
  /** Pen advance in layout units (includes letter/word spacing and justification). */
  advance: number
  /** The shaper's advance without letter/word spacing or justification (0 for marks). */
  natural: number
  /** Position of the glyph origin relative to the line start (x) and to the baseline (y, positive = down). */
  x: number
  y: number
  /** GPOS offset already included in x/y (kept for consumers that draw with pen advances). */
  dx: number
  dy: number
  /** True for the invisible glyph standing in for a tab. */
  tab?: boolean
  /** True for a word space (U+0020): justification stretches these. */
  space?: boolean
}

export interface ResolvedStyle {
  size: number
  color: TextColor
  opacity: number
  letterSpacing: number
  wordSpacing: number
  underline: boolean
  strike: boolean
  rise: number
  synthBold: boolean
  synthItalic: boolean
}

/** A run of glyphs in one font, one size and one direction. `glyphs` are in visual (left-to-right) order. */
export interface GlyphRun {
  font: TextFont
  size: number
  glyphs: LayoutGlyph[]
  /** X of the first glyph's pen position, relative to the line start. */
  x: number
  width: number
  level: number
  rtl: boolean
  script: string
  lang?: string
  /** Logical range of source text [textStart, textEnd) this run displays. */
  textStart: number
  textEnd: number
  style: ResolvedStyle
  /** Trailing whitespace hanging outside the line box (not part of the line width). */
  hanging: boolean
}

export interface Line {
  runs: GlyphRun[]
  /** Top of the line box in the layout (y down from the paragraph top). */
  y: number
  /** Left offset of the content (alignment). */
  x: number
  /** Width of the visible content (hanging trailing spaces excluded). */
  width: number
  height: number
  /** Baseline distance from the line's top, and the box's ascent/descent above/below the baseline. */
  baseline: number
  ascent: number
  descent: number
  textStart: number
  textEnd: number
  rtl: boolean
  /** True if the line ends because of an explicit newline or the end of the text (not justified, not wrapped). */
  last: boolean
  paragraph: number
}

export interface MissingChar {
  /** UTF-16 index in the source text. */
  index: number
  char: string
  codePoint: number
}

export interface ParagraphLayout {
  text: string
  lines: Line[]
  /** Widest line (content) and total height. */
  width: number
  height: number
  /** `width` option (the box lines are aligned in), if any. */
  boxWidth?: number
  /** Characters no font in the stack covers (each reported once per occurrence). */
  missing: MissingChar[]
  /** Paragraph directions used (one per paragraph of the source text). */
  directions: ('ltr' | 'rtl')[]
  /** True if `maxLines` cut the text. */
  truncated: boolean
}
