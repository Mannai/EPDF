import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { drawParagraph } from '../../src/shared/text/pdf/draw'
import { visualToLogical } from '../../src/shared/text/search'
import { CORPUS, type CorpusItem } from '../support/textCorpus'
import { actualTexts, contentOf, fontDicts, fontParts, shownCodes } from '../support/pdfContent'
import { pdfjsLines, setupText } from './helpers/text'

/**
 * Text extraction: what other readers and PDF.js get back from what the engine draws. The strings below are what a
 * user would search for and copy, in LOGICAL order, for every corpus script.
 *
 * PDF.js normalises text with NFKC (ligatures, presentation forms, Thai sara am), so both sides are NFKC-normalised.
 * Vocalised text (Arabic tashkeel, Hebrew points) hits a documented PDF.js quirk (docs/text-engine.md, "PDF.js quirks"):
 * it treats glyphs whose text contains a combining mark as zero width and may glue a text-run-initial mark to the
 * previous run. For those items the check is: same letters in the same order, same multiset of marks.
 */
setupText()

const collapse = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim()
const marks = (s: string): string => Array.from(s.normalize('NFKC').replace(/[^\p{Mn}]/gu, '')).sort().join('')
const letters = (s: string): string => s.normalize('NFKC').replace(/[\p{Mn}\s]/gu, '')

async function build(item: CorpusItem): Promise<{ pdf: PDFDocument; bytes: Uint8Array }> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([Math.max(item.width ?? 700, 200) + 40, 700])
  await drawParagraph(page, item.text, { x: 20, y: 680, size: item.size ?? 20, fontStack: item.fonts, lang: item.lang, direction: item.direction, width: item.width, align: item.align, weight: item.weight })
  return { pdf, bytes: await pdf.save() }
}

describe('PDF.js text extraction returns the logical-order Unicode text of every corpus item', () => {
  for (const item of CORPUS) {
    it(`${item.label} [${item.id}]`, async () => {
      const { bytes } = await build(item)
      const got = (await pdfjsLines(bytes)).join(' ')
      if (item.pdfjsQuirk === 'neutral-bidi') {
        // PDF.js reorders only the right-to-left letters back: the neutrals and numbers around them stay visual.
        expect(Array.from(collapse(got)).sort().join('')).toBe(Array.from(collapse(item.text)).sort().join(''))
      } else if (item.pdfjsQuirk === 'angle-brackets') {
        // PDF.js deletes < and > from every right-to-left text run (deliberately, in its bidi code); the PDF has them.
        expect(collapse(got)).toBe(collapse(item.text.replace(/[<>]/g, '')))
      } else if (item.pdfjsQuirk === 'combining-marks') {
        expect(letters(got), 'letters in order').toBe(letters(item.text))
        expect(marks(got), 'no mark lost or invented').toBe(marks(item.text))
      } else {
        expect(collapse(got)).toBe(collapse(item.text))
      }
    })
  }
})

describe('/ActualText carries the logical text for readers that honour it', () => {
  it('right-to-left paragraphs: the ActualText of the lines is the source text, line by line', async () => {
    for (const item of CORPUS.filter((c) => ['ar-plain', 'ar-tashkeel', 'ar-wrap-220', 'he', 'he-niqqud', 'fa', 'ur'].includes(c.id))) {
      const { pdf } = await build(item)
      const spans = actualTexts(contentOf(pdf, pdf.getPage(0)))
      expect(spans.join(''), item.id).toBe(item.text)
    }
  })

  it('mixed-direction lines: every ActualText span is an exact slice of the source, in order', async () => {
    for (const id of ['mixed-rtl', 'mixed-ltr', 'mixed-auto', 'emoji', 'ar-mirroring', 'ar-mixed-wrap', 'he-mixed-wrap', 'ar-indic-digits']) {
      const item = CORPUS.find((c) => c.id === id)!
      const { pdf } = await build(item)
      const spans = actualTexts(contentOf(pdf, pdf.getPage(0)))
      expect(spans.length, id).toBeGreaterThan(0)
      let from = 0
      for (const s of spans) {
        const at = item.text.indexOf(s, from)
        expect(at, `${id}: ${JSON.stringify(s)}`).toBeGreaterThanOrEqual(0)
        from = at + s.length
      }
      expect(spans.join(''), id).toBe(item.text)
    }
  })
})

describe('visualToLogical repairs text read in visual order (best effort)', () => {
  it('inverts what a reader sees when it maps glyphs to characters left to right', async () => {
    const hebrew: CorpusItem = { id: 'he-plain', label: 'Hebrew, single font', text: 'שלום עולם זהו טקסט בעברית', fonts: ['Noto Sans Hebrew'], size: 20 }
    for (const item of [...CORPUS.filter((c) => ['ar-plain', 'ar-lamalef', 'fa'].includes(c.id)), hebrew]) {
      const id = item.id
      const { pdf } = await build(item)
      const pg = pdf.getPage(0)
      const parts = fontParts(pdf, [...fontDicts(pdf, pg.node.Resources()).values()][0]!)
      // A visual-order extractor with a per-glyph ToUnicode map (multi-char glyph texts are stored reversed for RTL).
      const visual = shownCodes(contentOf(pdf, pg)).map((c) => parts.toUnicode.get(c) ?? '').join('')
      expect(collapse(visualToLogical(visual, { direction: 'rtl' })), id).toBe(collapse(item.text))
    }
  })

  it('reorders reversed Hebrew and Arabic, numbers and Latin words inside them', () => {
    expect(visualToLogical('םולש םלוע')).toBe('עולם שלום')
    expect(visualToLogical('םולש abc 123 םלוע', { direction: 'rtl' })).toBe('עולם abc 123 שלום')
    expect(visualToLogical('plain english')).toBe('plain english')
  })

  it('expands presentation forms and ligatures found in legacy Arabic PDFs', () => {
    const presentation = 'ﻣﺮﺣﺒﺎ' // ﻣﺮﺣﺒﺎ as isolated/medial presentation forms (visual: reversed)
    expect(visualToLogical(Array.from(presentation).reverse().join(''), { direction: 'rtl' })).toBe('مرحبا')
    expect(visualToLogical('ﷲ')).toBe('الله') // ﷲ
    expect(visualToLogical('ﻻ')).toBe('لا') // ﻻ
  })

  it('handles each line separately', () => {
    expect(visualToLogical('םולש\nhello\nםלוע')).toBe('שלום\nhello\nעולם')
  })
})
