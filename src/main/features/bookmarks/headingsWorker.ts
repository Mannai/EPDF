import { PDFDocument } from 'pdf-lib'
import { detectHeadings, type PageText } from '../../../shared/features/bookmarks/headings'
import type { DetectJob, DetectJobResult } from '../../../shared/features/bookmarks'
import { pageLines } from '../../../renderer/src/features/bookmarks/pdf/pageLines'
import { serveJob } from '../../jobs/serveJob'

/**
 * Worker thread for "Generate bookmarks from headings": reads the text lines of every page (font size, weight,
 * position) with the content-stream engine and runs the heading detector. It reports progress page by page;
 * cancelling the job terminates the thread, so a 500-page document never blocks the app.
 */
serveJob<DetectJob, DetectJobResult>(async (payload, report) => {
  report(0.02, 'Opening the document')
  const pdf = await PDFDocument.load(payload.bytes, { updateMetadata: false, throwOnInvalidObject: false })
  const total = pdf.getPageCount()
  const pages: PageText[] = []
  let withText = 0
  for (let i = 0; i < total; i++) {
    const p = pageLines(pdf, i, { includeInvisible: true })
    if (p.lines.length) withText++
    pages.push({ pageIndex: i, box: p.box, lines: p.lines })
    if (i % 5 === 0 || i === total - 1) {
      report(0.05 + 0.85 * ((i + 1) / total), `Reading page ${i + 1} of ${total}`)
      // Let the worker's event loop breathe so a terminate() request is honoured promptly.
      await new Promise((r) => setImmediate(r))
    }
  }
  report(0.93, 'Finding headings')
  const { candidates, stats } = detectHeadings(pages, { minConfidence: payload.minConfidence })
  return { candidates, stats, pagesWithText: withText, pagesTotal: total }
})
