import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { findNormalized } from '../../src/shared/text/search'
import { cer, hasTessdata, languagesOf, realEngine, recognizeLikeApp, RTL_CORPUS, wordRecall, type CorpusPage } from './helpers/ocrReal'
import { pdfjsText } from './helpers/pagetext'
import { pdfiumPages } from './helpers/pdfium'
import { windowsText } from './helpers/windowsText'

/**
 * REAL recognition of the right-to-left scan fixtures (tests/fixtures/ocr-rtl: Edge-printed pages, degraded like a
 * scan) with the real tessdata_fast language data, through the app's own steps: contrast, deskew, the retry on a
 * binarised picture for unsure pages, the text layer, the page text model.
 *
 * The normal suite never downloads language data: this file SKIPS unless EPDF_OCR_TESSDATA points at a folder holding
 * ara/fas/heb(/urd).traineddata (the catalogue's pinned files; docs/features/ocr.md, "Manual test"):
 *   $env:EPDF_OCR_TESSDATA = "$env:LOCALAPPDATA\epdf-tessdata"; npx vitest run tests/unit/ocr-rtl-real.test.ts
 * Urdu is slow on the noisy page (Tesseract reads the grain as text for minutes): EPDF_OCR_SLOW=1 includes it.
 */

/** Word recall (of the page text model's text) measured when this was written, minus a margin. */
const MIN_RECALL: Record<string, number> = {
  'scan-ara-letter': 0.65,
  'scan-ara-article': 0.75,
  'scan-ara-mixed': 0.75,
  'scan-fas': 0.8,
  'scan-heb': 0.9,
  'scan-urd': 0.25
}

const report: string[] = []
afterAll(() => {
  if (!report.length) return
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/ocr-rtl-real.txt', report.join('\n'))
})

const pages = RTL_CORPUS.pages.filter((p) => p.name !== 'scan-urd' || process.env['EPDF_OCR_SLOW'] === '1')

describe.each(pages.map((p) => [p.name, p] as [string, CorpusPage]))('real recognition: %s', (name, page) => {
  const langs = languagesOf(page)
  it.skipIf(!hasTessdata(langs))(
    'recognized text, in logical order in the page text model, found by search and by PDFium',
    async () => {
      const { engine, dispose } = await realEngine(langs, 1)
      try {
        const r = await recognizeLikeApp(engine, name)
        const want = page.lines.join('\n')
        const got = r.model.text
        const tess = r.lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n')
        const recall = wordRecall(want, got)
        report.push(
          `## ${name} (${langs.join('+')}): word recall ${(recall * 100).toFixed(0)}%, CER ${(cer(want, got) * 100).toFixed(1)}%, ` +
            `confidence ${r.confidence.toFixed(0)}%, ${r.retried ? `retried, ${r.usedBinarized ? 'binarised kept' : 'grey kept'}` : 'one pass'}, ${r.ms} ms`,
          '-- expected', want, '-- page text model', got, ''
        )
        expect(recall).toBeGreaterThanOrEqual(MIN_RECALL[name])
        // the layer loses nothing Tesseract found: the model reads at least as many expected words as Tesseract's own
        // word list contains (noise words dropped by the layer only make it better)
        expect(recall).toBeGreaterThanOrEqual(wordRecall(want, tess) - 0.02)
        // search finds most of the longer expected words that Tesseract got right
        const tessWords = new Set(tess.split(/\s+/))
        const probe = page.lines.join(' ').split(/\s+/).filter((w) => [...w].length >= 4 && /^\p{L}+$/u.test(w) && tessWords.has(w))
        for (const w of probe) expect(findNormalized(got, w, {}).length, w).toBeGreaterThan(0)
        // other readers: PDFium (Chrome, Edge) finds the same words
        const [pf] = await pdfiumPages(r.pdf)
        const count = (text: string): number => probe.filter((w) => text.normalize('NFC').includes(w.normalize('NFC'))).length
        const pfFound = count(pf.text)
        const pj = await pdfjsText(r.pdf)
        const win = windowsText(r.pdf)
        report.push(
          `   search: ${probe.length} probe words found by the model; PDFium text contains ${pfFound}, PDF.js ${count(pj)}, Windows ${win === null ? 'n/a' : count(win)}`,
          '-- PDFium', pf.text, '-- PDF.js', pj, ''
        )
        expect(pfFound).toBeGreaterThanOrEqual(Math.floor(0.95 * probe.length))
        expect(count(pj)).toBeGreaterThanOrEqual(Math.floor(0.8 * probe.length))
      } finally {
        await dispose()
      }
    },
    600_000
  )
})
