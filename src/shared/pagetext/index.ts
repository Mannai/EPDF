/**
 * The page text model (see docs/page-text.md): logical-order text of PDF pages from ANY producer, with
 * per-character geometry, reading direction per line and word boundaries. Pure TypeScript on pdf-lib: runs in the
 * renderer (a worker), in Electron main / worker threads and in Node tests.
 */
export { buildPageText, modelFromInterpretation, type BuildOptions } from './build'
export { interpretPage, pageGeometry, type Glyph, type Interpretation, type PageGeometry } from './interpret'
export { hasComplexScript, hasRtlChar, normalizeGlyphText } from './unicode'
export { visualToLogicalOrder, visualToLogicalText } from './visual'
export * from './query'
export type { Box, PageTextLine, PageTextModel, PageTextStats } from './types'
