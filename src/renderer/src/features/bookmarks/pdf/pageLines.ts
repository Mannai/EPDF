import type { PDFDocument } from 'pdf-lib'
import { buildPageText } from '@shared/pagetext'
import { linesFromModel, type TextLine } from '@shared/features/textlines'
import { geomOfPage } from '../../markup/pdf/geometry'

/**
 * Text lines of a page, from the shared page text model (`src/shared/pagetext`): exact glyph positions in PDF user
 * space, logical reading order for right-to-left and mixed text from any producer, font size and boldness. Pure
 * pdf-lib, so it runs in a worker and in Node. Pages whose content cannot be read (or that have no upright text)
 * yield no lines.
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
  try {
    const model = buildPageText(pdf, pageIndex, { includeHidden: opts.includeInvisible ?? false })
    return { pageIndex, box: geom.box, rotation: geom.rotation, lines: linesFromModel(model).filter((l) => l.size > 0.5) }
  } catch {
    return empty // unsupported or damaged content: no headings/links from this page, never an error
  }
}
