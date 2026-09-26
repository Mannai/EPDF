/**
 * Epdf text engine: correct text in any script, in PDFs and in previews.
 *
 * Environment setup (once per process; the engine reads its WebAssembly and fonts through it):
 *   - Node, Electron main, worker threads:  `import { useNodeResources } from '<main>/features/textengine/nodeResources'` then `useNodeResources()`
 *   - sandboxed renderer:                    `import { useRendererResources } from '@shared/text/renderer'` then `useRendererResources()`
 *
 * Then, instead of pdf-lib's `page.drawText(...)`:  `await drawText(page, text, { x, y, size })`.
 * See docs/text-engine.md.
 */
export { configureTextEngine, isTextEngineConfigured, type ResourceLoader } from './env'

// Drawing into PDFs
export {
  drawText,
  drawParagraph,
  makeTextXObject,
  measureText,
  measureParagraph,
  textContent,
  renameContentResources,
  type DrawOptions,
  type DrawResult,
  type TextContent,
  type TextXObject,
  type XObjectOptions
} from './pdf/draw'
export { isWinAnsiText, nonWinAnsiChars, ensureTextEngine, uncoveredChars } from './retrofit'
export { embeddedFontsFor, flushTextFonts, DocText, EmbeddedFont } from './pdf/embed'
export type { Extraction, RenderMode } from './pdf/emit'

// Layout
export { layoutParagraph, splitParagraphs } from './layout'
export type {
  Align,
  Direction,
  GlyphRun,
  LayoutGlyph,
  Line,
  MissingChar,
  ParagraphLayout,
  ParagraphOptions,
  ResolvedStyle,
  Span,
  TextColor,
  TextStyle
} from './types'
export { caretAt, hitTest, selectionRects, type CaretPosition, type SelectionRect } from './query'

// Fonts, shaping, itemization, line breaking, bidi
export { getCatalog, resolveStack, loadFontFromBytes, loadBundledFont, TextFont, type FamilyInfo, type FontCandidate, type FontRef, type FontStackOptions } from './fonts'
export { shapeText, normalizeFeatures, shapingCacheStats, clearShapingCache, type FeatureSettings, type ShapeParams, type ShapedRun } from './shape'
export { resolveScripts, scriptOfCodePoint, guessCjkLang } from './script'
export { lineBreakOpportunities, BREAK_ALLOWED, BREAK_MANDATORY, BREAK_NONE, type WordBreak } from './linebreak'
export { analyzeBidi, lineLevels, reorderVisual, mirroredCodePoint, detectParagraphLevel, hasRtl, type BidiInfo, type ParagraphDirection } from './bidi'

// Search, normalisation and text repair
export { normalizeForSearch, findNormalized, visualToLogical, type Match, type NormalizeOptions, type NormalizedText, type VisualToLogicalOptions } from './search'
