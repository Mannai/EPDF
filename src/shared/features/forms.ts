import { z } from 'zod'

/**
 * Fonts bundled with Epdf (`resources/fonts`, licenses next to them; see docs/features/forms-signing.md).
 * The renderer asks main for the bytes by *name*; it can never name a path.
 */
export const BUNDLED_FONT_FILES = {
  NotoSans: 'NotoSans-Regular.ttf',
  GreatVibes: 'GreatVibes-Regular.ttf',
  Allura: 'Allura-Regular.ttf',
  HomemadeApple: 'HomemadeApple-Regular.ttf',
  Sacramento: 'Sacramento-Regular.ttf',
  /** Arabic handwriting (Ruqaa) for typed signatures; SIL OFL 1.1 (OFL-ArefRuqaa.txt). */
  ArefRuqaa: 'ArefRuqaa-Regular.ttf'
} as const

export type BundledFontName = keyof typeof BUNDLED_FONT_FILES

export const BundledFontNameSchema = z.enum(Object.keys(BUNDLED_FONT_FILES) as [BundledFontName, ...BundledFontName[]])
export const FontRequestSchema = z.object({ name: BundledFontNameSchema })
