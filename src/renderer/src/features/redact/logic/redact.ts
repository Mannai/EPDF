import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import { N } from '../../textedit/pdfcontent/pdfutil'
import {
  collectGarbage,
  markNeedAppearances,
  newScrubReport,
  scrubAllStrings,
  scrubAnnotations,
  scrubHidden,
  scrubJavaScript,
  scrubMetadata,
  scrubNamedDests,
  secretRegex,
  type ScrubReport
} from './docScrub'
import { rectQuad, type Quad, type Rect } from './geom'
import { RedactRefused, newStats, type RemovedRec, type Rgb, type Stats } from './interp'
import { redactPage, type EngineOverlayText, type MarkShape } from './pageRedact'
import { ensureTextEngine, isWinAnsiText, textContent } from '@shared/text'
import { usableSecrets } from './verify'

export { RedactRefused }
export type { MarkShape }

/** A mark as the engine needs it: one or more boxes on one page, in PDF user space. */
export interface MarkInput {
  id: string
  pageIndex: number
  rects: Rect[]
  /** Exact shapes for rotated text: parallel to `rects`, null = the rect itself. */
  quads?: (Quad | null)[]
  /** The exact text this mark stands for (search hits, text selections), when known. */
  text?: string
}

export interface RedactOptions {
  fill: Rgb
  /** Text drawn in each mark ("REDACTED", custom, or empty for none). */
  overlayText: string
  removeMetadata: boolean
  removeHidden: boolean
}

export const DEFAULT_OPTIONS: RedactOptions = { fill: [0, 0, 0], overlayText: '', removeMetadata: false, removeHidden: false }

export interface RedactReport extends Stats {
  pages: number
  marks: number
  scrub: ScrubReport
  warnings: string[]
}

export interface RedactOutcome {
  report: RedactReport
  /** The text that was removed (normalised, >= 3 characters): what the self-check searches for. */
  secrets: string[]
  /** The bounding boxes of the marks per page. */
  marksByPage: Map<number, Rect[]>
  /** The exact shapes of the marks per page (what text coverage is decided by). */
  shapesByPage: Map<number, Quad[]>
}

const fontCache = new WeakMap<PDFDocument, PDFFont>()

function overlayFont(pdf: PDFDocument): PDFFont {
  let f = fontCache.get(pdf)
  if (!f) fontCache.set(pdf, (f = pdf.embedStandardFont(StandardFonts.Helvetica)))
  return f
}

const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim()

/** Removed text spans plus the exact texts of the marks, as scanning strings. */
export function deriveSecrets(marksOfPage: ReadonlyMap<number, MarkInput[]>, removed: ReadonlyMap<number, RemovedRec[]>): string[] {
  const out = new Set<string>()
  const add = (s: string | undefined): void => {
    if (!s) return
    const n = norm(s)
    if (n.length >= 3) out.add(n)
  }
  for (const [page, marks] of marksOfPage) {
    for (const m of marks) add(m.text)
    const recs = removed.get(page) ?? []
    // the original shape list of a page is the concatenation of its marks' rects, in order
    const owner: number[] = []
    marks.forEach((m, mi) => m.rects.forEach(() => owner.push(mi)))
    const perMark = new Map<number, string[]>()
    for (const r of recs) {
      add(r.text)
      const mi = owner[r.mark] ?? -1
      if (mi >= 0) perMark.set(mi, [...(perMark.get(mi) ?? []), r.text])
    }
    for (const parts of perMark.values()) add(parts.join(' '))
  }
  return [...out]
}

/**
 * The redaction as a sequence of steps (one per page, then the document-wide scrub) so callers can keep the UI
 * responsive: each `yield` is a good place to let the event loop run. Returns the outcome.
 */
/**
 * Lays out overlay text Helvetica cannot encode ("محجوب", "חסוי", "已删除" ...) with the text engine, once per
 * redaction, in the colour the marks need (white on dark fills). Returns undefined for WinAnsi text (Helvetica keeps
 * drawing it as before) or when the engine is not available (then only the characters Helvetica has are drawn).
 */
export async function prepareOverlayText(pdf: PDFDocument, text: string, fill: Rgb): Promise<EngineOverlayText | undefined> {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t === '' || isWinAnsiText(t)) return undefined
  try {
    ensureTextEngine()
    const white = 0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2] < 0.5
    const c = await textContent(pdf, t, { size: 1, fontStack: ['Helvetica'], color: white ? [1, 1, 1] : [0, 0, 0], origin: 'baseline' })
    return { content: c.content, fonts: c.fonts, width: c.width }
  } catch (err) {
    console.warn('Redaction: the overlay text could not be laid out with the text engine', err)
    return undefined
  }
}

type StepOptions = RedactOptions & { engineText?: EngineOverlayText }

export function* redactSteps(pdf: PDFDocument, marks: readonly MarkInput[], options: StepOptions): Generator<{ done: number; total: number }, RedactOutcome> {
  const stats = newStats()
  const warnings: string[] = []
  const pageCount = pdf.getPageCount()
  const byPage = new Map<number, MarkInput[]>()
  for (const m of marks) {
    if (m.pageIndex < 0 || m.pageIndex >= pageCount) throw new RedactRefused(`A mark refers to page ${m.pageIndex + 1}, which does not exist any more.`)
    const keep: number[] = []
    m.rects.forEach((r, i) => {
      if ([r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) && r.x1 > r.x0 && r.y1 > r.y0) keep.push(i)
    })
    if (keep.length === 0) continue
    byPage.set(m.pageIndex, [...(byPage.get(m.pageIndex) ?? []), { ...m, rects: keep.map((i) => m.rects[i]), quads: m.quads ? keep.map((i) => m.quads![i] ?? null) : undefined }])
  }
  if (byPage.size === 0) throw new RedactRefused('There is nothing marked for redaction.')

  const font = overlayFont(pdf)
  const marksByPage = new Map<number, Rect[]>()
  const shapesByPage = new Map<number, Quad[]>()
  const removed = new Map<number, RemovedRec[]>()
  const pages = [...byPage.keys()].sort((a, b) => a - b)
  let done = 0
  for (const pi of pages) {
    const list = byPage.get(pi)!
    const shapes: MarkShape[] = list.flatMap((m) => m.rects.map((rect, i) => ({ rect, quad: m.quads?.[i] ?? null })))
    marksByPage.set(pi, shapes.map((s) => s.rect))
    shapesByPage.set(pi, shapes.map((s) => s.quad ?? rectQuad(s.rect)))
    const r = redactPage(pdf, pi, shapes, { fill: options.fill, text: options.overlayText, font, engineText: options.engineText }, stats)
    removed.set(pi, r.removed)
    warnings.push(...r.warnings.map((w) => `Page ${pi + 1}: ${w}`))
    yield { done: ++done, total: pages.length }
  }

  const secrets = deriveSecrets(byPage, removed)
  const re = secretRegex(secrets)
  const scrub = newScrubReport()
  const needAppearances = scrubAnnotations(pdf, marksByPage, re, scrub)
  scrubNamedDests(pdf, re, scrub)
  scrubJavaScript(pdf, re, options.removeHidden, scrub) // before the string scrub: a script that mentions the text is removed, not edited
  const touched = scrubAllStrings(pdf, re, scrub)
  for (const d of touched) d.delete(N('AP')) // a field's stale appearance still shows the old value
  if (needAppearances || touched.length) markNeedAppearances(pdf)
  scrubMetadata(pdf, re, new Set(marksByPage.keys()), options, scrub)
  if (options.removeHidden) scrubHidden(pdf, scrub)
  scrub.orphans = collectGarbage(pdf)

  return {
    report: { ...stats, pages: marksByPage.size, marks: marks.length, scrub, warnings },
    secrets: usableSecrets(secrets),
    marksByPage,
    shapesByPage
  }
}

/**
 * Permanently removes everything under the marks from `pdf` (in place) and scrubs the rest of the document.
 * Throws `RedactRefused` (with a message for the user) when a page cannot be redacted safely; the document
 * must then be discarded, not saved.
 */
export function redactDocument(pdf: PDFDocument, marks: readonly MarkInput[], options: RedactOptions): RedactOutcome {
  const g = redactSteps(pdf, marks, options)
  let r = g.next()
  while (!r.done) r = g.next()
  return r.value
}

/**
 * Like `redactDocument`, letting the event loop run between pages. Overlay text in any script is drawn with the text
 * engine (the synchronous `redactDocument` can only draw what Helvetica encodes).
 */
export async function redactDocumentAsync(pdf: PDFDocument, marks: readonly MarkInput[], options: RedactOptions, onProgress?: (done: number, total: number) => void): Promise<RedactOutcome> {
  const engineText = await prepareOverlayText(pdf, options.overlayText, options.fill)
  const g = redactSteps(pdf, marks, { ...options, engineText })
  let r = g.next()
  while (!r.done) {
    onProgress?.(r.value.done, r.value.total)
    await new Promise((res) => setTimeout(res, 0))
    r = g.next()
  }
  return r.value
}

/** One-line human summary of a report ("Removed 14 text runs, 2 images (regions), ..."). */
export function summarize(r: RedactReport): string {
  const parts: string[] = []
  const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
  if (r.textRuns) parts.push(plural(r.textRuns, 'text run'))
  if (r.images) parts.push(`${plural(r.images, 'image')} (regions)`)
  if (r.imagesRemoved) parts.push(`${plural(r.imagesRemoved, 'image')} (entirely)`)
  if (r.paths || r.pathsClipped || r.shadings) parts.push(plural(r.paths + r.pathsClipped + r.shadings, 'graphic'))
  if (r.scrub.annotations) parts.push(plural(r.scrub.annotations, 'annotation'))
  const meta = r.scrub.metadata + r.scrub.thumbnails + r.scrub.strings + r.scrub.namedDests
  if (meta) parts.push('metadata')
  if (r.scrub.attachments) parts.push(plural(r.scrub.attachments, 'attachment'))
  if (r.scrub.javascript) parts.push('JavaScript')
  return parts.length ? `Removed ${parts.join(', ')}.` : 'Nothing under the marks needed removing; the areas were covered.'
}
