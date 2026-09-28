import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { afterAll, describe, expect, it } from 'vitest'
import { buildPageText } from '../../src/shared/pagetext'
import { runCompare } from '../../src/renderer/src/features/compare/diff/engine'
import { extractPage } from '../../src/renderer/src/features/compare/extract'
import { exportDocument } from '../../src/renderer/src/features/export/run'
import { extractText } from '../../src/main/features/library/extract'
import { foldIndexText } from '../../src/shared/features/library/text'
import { searchDocument } from '../../src/renderer/src/features/redact/logic/search'
import { DEFAULT_OPTIONS, redactDocument } from '../../src/renderer/src/features/redact/logic/redact'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { pageLines } from '../../src/renderer/src/features/bookmarks/pdf/pageLines'
import { setPageModelEnabled } from '../../src/renderer/src/pdf/pagetext'
import { openWithPdfjs } from '../support/exportFixtures'
import { TEST_ASSETS } from '../support/libraryEngine'
import { corpus, fixtureBytes, norm } from './helpers/pagetext'

/**
 * The features that read page text, on right-to-left pages from real producers: compare, export (docx), the library
 * indexer, redaction search + apply + self-check, and the links/bookmarks line reader. (In Node the renderer's page
 * text module builds models in-thread; the app uses a Web Worker, see the e2e tests.)
 */

const byId = (id: string): string => corpus.lines.find((l) => l.id === id)!.text
const tmp = mkdtempSync(join(tmpdir(), 'epdf-pagetext-features-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('compare', () => {
  it('the same text printed by LibreOffice and by Chromium compares equal; PDF.js-only reading would report changes', async () => {
    const lo = await openWithPdfjs(fixtureBytes('lo-lines.pdf'))
    const ch = await openWithPdfjs(fixtureBytes('chromium-lines.pdf'))
    const a = await extractPage(lo.doc, 1)
    const b = await extractPage(ch.doc, 1)
    // words in logical order (compare's tokenizer makes punctuation, the hyphens too, tokens of their own)
    expect(a.text.join(' ')).toContain('رقم الطلب 12345 بتاريخ 2026 - 09 - 26 ( Epdf )')
    const result = runCompare([a.keys], [b.keys], { ignoreCase: false, ignorePunctuation: false, ignoreWhitespace: false })
    expect(result.counts.total).toBe(0)

    setPageModelEnabled(false)
    try {
      const lo2 = await openWithPdfjs(fixtureBytes('lo-lines.pdf'))
      const ch2 = await openWithPdfjs(fixtureBytes('chromium-lines.pdf'))
      const r2 = runCompare([(await extractPage(lo2.doc, 1)).keys], [(await extractPage(ch2.doc, 1)).keys], { ignoreCase: false, ignorePunctuation: false, ignoreWhitespace: false })
      console.log(`compare LibreOffice vs Chromium, same text: ${result.counts.total} changes with the page text model, ${r2.counts.total} with PDF.js text only`)
      expect(r2.counts.total).toBeGreaterThan(0)
    } finally {
      setPageModelEnabled(true)
    }
  })
})

describe('export to Word', () => {
  it('writes the logical Arabic text in right-to-left (bidi) paragraphs', async () => {
    const { doc, OPS } = await openWithPdfjs(fixtureBytes('lo-lines.pdf'))
    const res = await exportDocument(doc, 'docx', { OPS, options: { includeImages: false } })
    const xml = strFromU8(unzipSync(res.bytes)['word/document.xml'])
    const paragraphs = [...xml.matchAll(/<w:p>(.*?)<\/w:p>/g)].map((m) => ({ bidi: m[1].includes('<w:bidi/>'), text: [...m[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join('') }))
    const texts = paragraphs.map((p) => norm(p.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')))
    for (const id of ['ar-hello', 'ar-vocalised', 'ar-date', 'ar-indic-digits', 'fa', 'he']) {
      const want = norm(byId(id))
      const p = paragraphs[texts.findIndex((t) => t.includes(want))]
      expect(p, id).toBeDefined()
      expect(p.bidi, `${id} is a bidi paragraph`).toBe(true)
    }
    const latin = paragraphs[texts.findIndex((t) => t.includes('The quick brown fox'))]
    expect(latin.bidi).toBe(false)
  })
})

describe('library indexing', () => {
  it('indexes the logical text of right-to-left pages', async () => {
    const p = join(tmp, 'lo-lines.pdf')
    writeFileSync(p, fixtureBytes('lo-lines.pdf'))
    const r = await extractText({ path: p, knownHash: null, maxPages: 10, assets: TEST_ASSETS })
    expect(r.kind).toBe('indexed')
    const text = r.kind === 'indexed' ? r.texts[0].text : ''
    // (The index holds the search folding: Arabic-Indic digits as 0-9, no tashkeel, one alef; see foldIndexText.)
    for (const id of ['ar-hello', 'ar-date', 'ar-indic-digits', 'he', 'fa']) expect(text, id).toContain(foldIndexText(norm(byId(id)).normalize('NFKC')))
  })
})

describe('redaction', () => {
  it('search finds an Arabic word in logical order, redaction removes exactly its glyphs, the self-check agrees', async () => {
    const pdf = await PDFDocument.load(fixtureBytes('lo-lines.pdf'))
    const hits = await searchDocument(pdf, { kind: 'literal', query: 'بالعالم', caseSensitive: false, wholeWord: true })
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toBe('بالعالم')
    const marks = hits.map((h, i) => ({ id: `m${i}`, pageIndex: h.pageIndex, rects: h.rects, quads: h.quads, text: h.text }))
    const outcome = redactDocument(pdf, marks, DEFAULT_OPTIONS)
    const bytes = await pdf.save()
    const after = buildPageText(await PDFDocument.load(bytes), 0)
    expect(after.text).not.toContain('بالعالم')
    const first = after.text.split('\n')[0]
    expect(first.trim()).toBe('مرحبا')
    // everything else is untouched
    for (const id of ['ar-date', 'ar-vocalised', 'he', 'latin']) expect(norm(after.text), id).toContain(norm(byId(id)))
    const findings = await verifyRedaction({
      bytes,
      marksByPage: outcome.marksByPage,
      shapesByPage: outcome.shapesByPage,
      secrets: outcome.secrets,
      modelPages: async (b) => {
        const d = await PDFDocument.load(b)
        return d.getPages().map((_, i) => buildPageText(d, i))
      },
      pdfjsPages: async () => ['']
    })
    expect(findings).toEqual([])
  })
  it('the logical-order self-check catches Arabic text left under a mark', async () => {
    const pdf = await PDFDocument.load(fixtureBytes('lo-lines.pdf'))
    const [hit] = await searchDocument(pdf, { kind: 'literal', query: 'بالعالم', caseSensitive: false, wholeWord: true })
    // claim the word was redacted without removing it
    const bytes = await pdf.save()
    const findings = await verifyRedaction({
      bytes,
      marksByPage: new Map([[0, hit.rects]]),
      secrets: ['بالعالم'],
      modelPages: async (b) => {
        const d = await PDFDocument.load(b)
        return d.getPages().map((_, i) => buildPageText(d, i))
      }
    })
    expect(findings.some((f) => /logical order/.test(f.detail))).toBe(true)
  })
})

describe('links and bookmarks line reader', () => {
  it('gives each line in drawn order with its logical reading', async () => {
    const pdf = await PDFDocument.load(fixtureBytes('lo-lines.pdf'))
    const lines = pageLines(pdf, 0).lines
    const date = lines.find((l) => norm(l.logical) === norm(byId('ar-date')))!
    expect(date).toBeDefined()
    expect(date.rtl).toBe(true)
    expect(date.chars).toHaveLength(date.text.length)
    // drawn order, left to right: the date as displayed
    expect(date.text).toContain('26-09-2026')
  })
})
