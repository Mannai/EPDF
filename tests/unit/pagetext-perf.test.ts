import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildPageText } from '../../src/shared/pagetext'
import { buildLines, type RunLike } from '../../src/shared/features/textlines'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { fixtureBytes } from './helpers/pagetext'

/**
 * Cost of the page text model. The viewer only builds it for pages with right-to-left or complex-script text (in a
 * Web Worker); Latin pages keep PDF.js's text. It is built for every page by the links/bookmarks line reader and by
 * the redaction search of such pages, so Latin throughput matters too. Thresholds are generous (shared CI machine);
 * the printed numbers are the measurement.
 */

const WORDS = 'the quick brown fox jumps over the lazy dog while seven wizards quietly judge boxing matches in the old town hall'.split(' ')

async function latinDoc(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.TimesRoman)
  for (let p = 0; p < pages; p++) {
    const page = pdf.addPage([612, 792])
    for (let l = 0; l < 45; l++) {
      const line = Array.from({ length: 13 }, (_, k) => WORDS[(p * 7 + l * 3 + k) % WORDS.length]).join(' ')
      page.drawText(line, { x: 60, y: 740 - l * 15, size: 11, font })
    }
  }
  return pdf.save()
}

async function arabicDoc(pages: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(fixtureBytes('lo-para.pdf'))
  const lines = await PDFDocument.load(fixtureBytes('lo-lines.pdf'))
  const out = await PDFDocument.create()
  for (let p = 0; p < pages; p++) {
    const [pg] = await out.copyPages(p % 2 ? src : lines, [0])
    out.addPage(pg)
  }
  return out.save()
}

const time = (fn: () => void): number => {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

describe('page text model throughput', () => {
  it('500-page Latin document (45 lines x 13 words per page)', async () => {
    const pdf = await PDFDocument.load(await latinDoc(500))
    buildPageText(pdf, 0) // warm up
    let chars = 0
    const ms = time(() => {
      for (let i = 0; i < 500; i++) chars += buildPageText(pdf, i).text.length
    })
    // what the links/bookmarks reader did before (content analysis + its own line builder)
    const before = time(() => {
      for (let i = 0; i < 500; i++) {
        const runs: RunLike[] = analyzePage(pdf, i).runs.map((r) => ({
          glyphs: r.glyphs.map((g) => ({ text: g.text, x0: r.matrix[4] + r.matrix[0] * g.x0, x1: r.matrix[4] + r.matrix[0] * g.x1 })),
          baseline: r.matrix[5],
          y0: r.bbox.y0,
          y1: r.bbox.y1,
          size: r.size,
          bold: false,
          italic: false,
          fontKey: r.font.displayName
        }))
        buildLines(runs)
      }
    })
    console.log(`Latin 500 pages: page text model ${ms.toFixed(0)} ms (${(ms / 500).toFixed(2)} ms/page, ${chars} chars); previous links/bookmarks reader ${before.toFixed(0)} ms`)
    // alone ~4 ms/page; the bound only catches an order-of-magnitude regression under a fully loaded machine
    expect(ms / 500).toBeLessThan(60)
  }, 240_000)
  it('100-page Arabic document (LibreOffice pages: lines and wrapped paragraphs)', async () => {
    const pdf = await PDFDocument.load(await arabicDoc(100))
    buildPageText(pdf, 0)
    const ms = time(() => {
      for (let i = 0; i < 100; i++) buildPageText(pdf, i)
    })
    console.log(`Arabic 100 pages: ${ms.toFixed(0)} ms (${(ms / 100).toFixed(2)} ms/page)`)
    expect(ms / 100).toBeLessThan(300)
  }, 240_000)
})
