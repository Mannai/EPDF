import type { PDFDocument } from 'pdf-lib'
import { buildLines, type RunLike, type TextLine } from '@shared/features/textlines'
import { analyzePage } from '../../textedit/pdfcontent/analyze'
import { geomOfPage } from '../../markup/pdf/geometry'

/**
 * Text lines of a page, from the read-only content-stream engine (`textedit/pdfcontent`): exact glyph
 * positions in PDF user space, font size and boldness. Pure pdf-lib, so it runs in a worker and in Node.
 * Pages whose content the engine cannot analyse (or that have no upright text) yield no lines.
 */

export interface PageLines {
  pageIndex: number
  box: [number, number, number, number]
  rotation: number
  lines: TextLine[]
}

export function pageLines(pdf: PDFDocument, pageIndex: number, opts: { includeInvisible?: boolean } = {}): PageLines {
  const geom = geomOfPage(pdf.getPage(pageIndex))
  const empty: PageLines = { pageIndex, box: geom.box, rotation: geom.rotation, lines: [] }
  let analysis
  try {
    analysis = analyzePage(pdf, pageIndex)
  } catch {
    return empty // unsupported or damaged content: no headings/links from this page, never an error
  }
  const runs: RunLike[] = []
  for (const r of analysis.runs) {
    if (!r.upright || r.glyphs.length === 0) continue
    if (!r.visible && !opts.includeInvisible) continue
    const m = r.matrix
    const size = r.size * Math.abs(m[3])
    if (!(size > 0.5) || !Number.isFinite(size)) continue
    runs.push({
      glyphs: r.glyphs.map((g) => ({ text: g.text, x0: m[4] + m[0] * g.x0, x1: m[4] + m[0] * g.x1 })),
      baseline: m[5] + m[3] * r.rise,
      y0: r.bbox.y0,
      y1: r.bbox.y1,
      size,
      bold: r.font.style.bold,
      italic: r.font.style.italic,
      fontKey: r.font.displayName
    })
  }
  return { pageIndex, box: geom.box, rotation: geom.rotation, lines: buildLines(runs) }
}
