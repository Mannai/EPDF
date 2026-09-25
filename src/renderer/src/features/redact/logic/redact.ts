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
import type { Rect } from './geom'
import { RedactRefused, newStats, type RemovedRec, type Rgb, type Stats } from './interp'
import { redactPage } from './pageRedact'
import { usableSecrets } from './verify'

export { RedactRefused }

/** A mark as the engine needs it: one or more boxes on one page, in PDF user space. */
export interface MarkInput {
  id: string
  pageIndex: number
  rects: Rect[]
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
  marksByPage: Map<number, Rect[]>
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
    // the original mark list of a page is the concatenation of its marks' rects, in order
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
 * Permanently removes everything under the marks from `pdf` (in place) and scrubs the rest of the document.
 * Throws `RedactRefused` (with a message for the user) when a page cannot be redacted safely; the document
 * must then be discarded, not saved.
 */
export function redactDocument(pdf: PDFDocument, marks: readonly MarkInput[], options: RedactOptions): RedactOutcome {
  const stats = newStats()
  const warnings: string[] = []
  const pageCount = pdf.getPageCount()
  const byPage = new Map<number, MarkInput[]>()
  for (const m of marks) {
    if (m.pageIndex < 0 || m.pageIndex >= pageCount) throw new RedactRefused(`A mark refers to page ${m.pageIndex + 1}, which does not exist any more.`)
    const rects = m.rects.filter((r) => [r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) && r.x1 > r.x0 && r.y1 > r.y0)
    if (rects.length === 0) continue
    byPage.set(m.pageIndex, [...(byPage.get(m.pageIndex) ?? []), { ...m, rects }])
  }
  if (byPage.size === 0) throw new RedactRefused('There is nothing marked for redaction.')

  const font = overlayFont(pdf)
  const marksByPage = new Map<number, Rect[]>()
  const removed = new Map<number, RemovedRec[]>()
  for (const pi of [...byPage.keys()].sort((a, b) => a - b)) {
    const rects = byPage.get(pi)!.flatMap((m) => m.rects)
    marksByPage.set(pi, rects)
    const r = redactPage(pdf, pi, rects, { fill: options.fill, text: options.overlayText, font }, stats)
    removed.set(pi, r.removed)
    warnings.push(...r.warnings.map((w) => `Page ${pi + 1}: ${w}`))
  }

  const secrets = deriveSecrets(byPage, removed)
  const re = secretRegex(secrets)
  const scrub = newScrubReport()
  const needAppearances = scrubAnnotations(pdf, marksByPage, re, scrub)
  scrubNamedDests(pdf, re, scrub)
  const touched = scrubAllStrings(pdf, re, scrub)
  for (const d of touched) d.delete(N('AP')) // a field's stale appearance still shows the old value
  if (needAppearances || touched.length) markNeedAppearances(pdf)
  scrubMetadata(pdf, re, new Set(marksByPage.keys()), options, scrub)
  scrubJavaScript(pdf, re, options.removeHidden, scrub)
  if (options.removeHidden) scrubHidden(pdf, scrub)
  scrub.orphans = collectGarbage(pdf)

  return {
    report: { ...stats, pages: marksByPage.size, marks: marks.length, scrub, warnings },
    secrets: usableSecrets(secrets),
    marksByPage
  }
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
