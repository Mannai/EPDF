import { expandRanges, parsePageRanges } from '../pages/ranges'

/**
 * Print options and the math that turns them into concrete decisions: which pages, at what scale, in
 * which orientation. Pure, so the renderer, the main process and the tests all agree.
 */

export type RangeMode = 'all' | 'current' | 'custom'
export type ScalingMode = 'fit' | 'actual' | 'custom'
export type Orientation = 'auto' | 'portrait' | 'landscape'
export type Quality = 'draft' | 'standard' | 'high'
/** Sheet size for "Save as PDF": each page's own size, or a fixed paper. */
export type Paper = 'source' | 'a4' | 'letter'

export interface PrintOptions {
  range: RangeMode
  /** Text for `range: 'custom'`, e.g. "1-3,7". */
  custom: string
  copies: number
  scaling: ScalingMode
  /** Percent for `scaling: 'custom'`. */
  percent: number
  orientation: Orientation
  annotations: boolean
  quality: Quality
  paper: Paper
}

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  range: 'all',
  custom: '',
  copies: 1,
  scaling: 'fit',
  percent: 100,
  orientation: 'auto',
  annotations: true,
  quality: 'standard',
  paper: 'source'
}

export const MIN_PERCENT = 10
export const MAX_PERCENT = 400
export const MAX_COPIES = 99

export const QUALITY_DPI: Record<Quality, number> = { draft: 150, standard: 200, high: 300 }

/** Paper sizes in PDF points (portrait). */
export const PAPER_SIZES: Record<Exclude<Paper, 'source'>, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 }
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string }

/** The 0-based pages to print, in order, or a message explaining what is wrong with the options. */
export function resolvePages(
  opts: Pick<PrintOptions, 'range' | 'custom'>,
  numPages: number,
  currentPage: number
): Resolved<number[]> {
  if (numPages < 1) return { ok: false, error: 'The document has no pages.' }
  if (opts.range === 'all') return { ok: true, value: Array.from({ length: numPages }, (_, i) => i) }
  if (opts.range === 'current') {
    const p = Math.min(Math.max(1, Math.round(currentPage)), numPages)
    return { ok: true, value: [p - 1] }
  }
  const parsed = parsePageRanges(opts.custom, numPages)
  if (!parsed.ok) return parsed
  return { ok: true, value: expandRanges(parsed.ranges, { unique: true }) }
}

export function validateOptions(opts: PrintOptions): string | null {
  if (!Number.isInteger(opts.copies) || opts.copies < 1 || opts.copies > MAX_COPIES) return `Copies must be a whole number from 1 to ${MAX_COPIES}.`
  if (opts.scaling === 'custom' && !(Number.isFinite(opts.percent) && opts.percent >= MIN_PERCENT && opts.percent <= MAX_PERCENT)) {
    return `Scale must be between ${MIN_PERCENT}% and ${MAX_PERCENT}%.`
  }
  return null
}

export interface Size {
  width: number
  height: number
}

/** The scale factor for a page of `page` points on a sheet of `sheet` points. */
export function scaleFor(mode: ScalingMode, percent: number, page: Size, sheet: Size): number {
  if (mode === 'actual') return 1
  if (mode === 'custom') return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent)) / 100
  return Math.min(sheet.width / page.width, sheet.height / page.height)
}

/** Portrait or landscape for a printing job whose pages have the given sizes ("auto" = whichever most pages are). */
export function jobOrientation(pref: Orientation, pages: Size[]): 'portrait' | 'landscape' {
  if (pref !== 'auto') return pref
  const landscape = pages.filter((p) => p.width > p.height).length
  return landscape > pages.length - landscape ? 'landscape' : 'portrait'
}

/** The sheet a page is placed on for "Save as PDF" (null = the page keeps its own size, scaled). */
export function sheetFor(paper: Paper, orientation: Orientation, page: Size): Size | null {
  if (paper === 'source') return null
  const base = PAPER_SIZES[paper]
  const landscape = orientation === 'auto' ? page.width > page.height : orientation === 'landscape'
  return landscape ? { width: base.height, height: base.width } : { ...base }
}

/** A short, human summary for the dialog ("3 pages × 2 copies = 6 sheets"). */
export function summarize(pageCount: number, copies: number): string {
  const pages = `${pageCount} page${pageCount === 1 ? '' : 's'}`
  return copies > 1 ? `${pages} × ${copies} copies = ${pageCount * copies} sheets` : pages
}
