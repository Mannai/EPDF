import { mkdirSync, writeFileSync } from 'node:fs'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import type { OcrLine, OcrWord } from '../../src/shared/features/ocr'
import { buildPageText, rangeBoxes, type PageTextModel } from '../../src/shared/pagetext'
import { findNormalized } from '../../src/shared/text/search'
import { applyOcrLayers, dropMarginSpecks, embedGlyphlessFont, harmonizeSizes, keptWords, visibleBox } from '../../src/renderer/src/features/ocr/pdf/apply'
import { visualLine } from '../../src/renderer/src/features/ocr/pdf/bidi'
import { Charset } from '../../src/renderer/src/features/ocr/pdf/charset'
import { normalizeRotation, pageSlopes, pixelToUser, type PageGeometry, type PlacedLine } from '../../src/renderer/src/features/ocr/pdf/layout'
import { collectChars, separateWords } from '../../src/renderer/src/features/ocr/pdf/textLayer'
import { interpretOsd } from '../../src/main/features/ocr/orientation'
import { searchDocument } from '../../src/renderer/src/features/redact/logic/search'
import { DEFAULT_OPTIONS, redactDocument } from '../../src/renderer/src/features/redact/logic/redact'
import { createScan1, createScanRotated } from '../fixtures/ocr.mjs'
import { scannedLine, scannedPage } from './helpers/ocrLines'
import { pdfjsText } from './helpers/pagetext'
import { pdfiumPages } from './helpers/pdfium'
import { windowsText } from './helpers/windowsText'

/**
 * The invisible text layer for right-to-left and mixed lines: Tesseract reports words in logical order with their boxes;
 * the layer draws every line in visual order (bidi.ts) so that readers get the logical text back. Checked with Epdf's
 * page text model (what the viewer, search, copy and redaction use), PDF.js, PDFium (Chrome's and Edge's engine, as
 * WebAssembly) and Windows' own PDF engine (its search filter), on synthetic recognition results placed where a scan of
 * the text would have its words.
 */

const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim()

/** Lines as typed (logical order), one per scanned line. */
const SAMPLES = [
  'مرحبا بالعالم',
  'رقم الفاتورة 2026-48 بتاريخ 15/03/2026',
  'تم تحويل مبلغ 45.500 دينار إلى حساب BHD',
  'هذا ملف PDF 42 للاختبار',
  'السعر (٤٥) درهماً فقط.',
  'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
  'می‌خواهم کتاب بخوانم',
  'یہ ایک امتحان ہے',
  'שלום עולם 2026',
  'Invoice رقم الفاتورة 48213 total'
]

const geometryOf = (page: ReturnType<PDFDocument['getPage']>, w: number, h: number): PageGeometry => ({
  view: visibleBox(page),
  rotate: normalizeRotation(page.getRotation().angle),
  width: w,
  height: h
})

async function ocrPdf(lines: OcrLine[], src?: Uint8Array, size: [number, number] = [1700, 2200]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(src ?? (await createScan1()))
  applyOcrLayers(pdf, [{ pageIndex: 0, geometry: geometryOf(pdf.getPage(0), size[0], size[1]), lines }])
  return pdf.save()
}

const modelOf = async (bytes: Uint8Array): Promise<PageTextModel> => buildPageText(await PDFDocument.load(bytes), 0)
const linesOf = (m: PageTextModel): string[] => m.lines.map((l) => norm(m.text.slice(l.start, l.end)))

// ---- visual order ----------------------------------------------------------------------------------------------------

describe('visual order of a recognized line', () => {
  const vis = (text: string): ReturnType<typeof visualLine> => {
    const l = scannedLine({ text, y: 300, edge: /^[A-Za-z]/.test(text) ? 200 : 1500 })
    return visualLine(
      l.words.map((w) => w.text),
      l.words.map((w) => w.x0)
    )
  }

  it('a right-to-left line: words from left to right on the page, letters of each word reversed', () => {
    const v = vis('مرحبا بالعالم')
    expect(v.rtl).toBe(true)
    expect(v.order).toEqual([1, 0])
    expect(v.words).toEqual(['ابحرم', 'ملاعلاب'])
  })

  it('numbers after Arabic letters are Arabic numbers: "2026-48" is displayed, and drawn, as 48-2026', () => {
    const v = vis('رقم 2026-48 بتاريخ 15/03/2026')
    expect(v.words[1]).toBe('48-2026')
    expect(v.words[3]).toBe('15/03/2026') // one number (the slashes join Arabic numbers)
  })

  it('Latin words and numbers inside an Arabic line keep their own order', () => {
    const v = vis('هذا ملف PDF 42 للاختبار')
    expect(v.words.slice(2, 4)).toEqual(['PDF', '42'])
    expect(v.order).toEqual([4, 2, 3, 1, 0]) // left to right: للاختبار, PDF, 42, ملف, هذا
  })

  it('the paragraph direction is the one that puts the words where the scan has them', () => {
    const ltr = vis('Invoice رقم الفاتورة 48213 total')
    expect(ltr.rtl).toBe(false)
    expect(ltr.words[1]).toBe('مقر')
    // the same words, but placed right to left on the page: a right-to-left line
    const words = ['Invoice', 'رقم', 'total']
    expect(visualLine(words, [300, 200, 100]).rtl).toBe(true)
    expect(visualLine(words, [100, 200, 300]).rtl).toBe(false)
  })

  it('brackets in a right-to-left run are stored as the shape seen on the page (mirrored)', () => {
    expect(vis('السعر (٤٥) فقط').words[1]).toBe('(٤٥)')
    expect(vis('هذا (مثال) فقط').words[1]).toBe('(لاثم)')
  })

  it('combining marks come before their letter in a right-to-left run (every reader reverses the run as a whole)', () => {
    expect(vis('بِسْمِ').words[0]).toBe('ِمْسِب')
  })

  it('a single word takes the direction of its letters', () => {
    expect(visualLine(['שלום'], [0])).toEqual({ rtl: true, words: ['םולש'], order: [0] })
    expect(visualLine(['Hello'], [0])).toEqual({ rtl: false, words: ['Hello'], order: [0] })
  })
})

describe('placing the words of a line', () => {
  const place = (words: [string, number, number][]): PlacedLine => ({
    x: 72,
    y: 700,
    ux: 1,
    uy: 0,
    fontSize: 10,
    tilted: false,
    words: words.map(([text, offset, width]) => ({ text, offset, width, conf: 90 }))
  })

  it('collectChars puts the words in visual order, moves the origin to the leftmost word and drops bidi controls', () => {
    const cs = new Charset()
    // logical order, right to left on the page (offsets negative from the first word), with Tesseract's LRM/RLM
    const [l] = collectChars([place([['مرحبا', 0, 30], ['‎PDF‏', -40, 20], ['بالعالم', -80, 35]])], cs)
    expect(l.rtl).toBe(true)
    expect(l.words.map((w) => w.text)).toEqual(['ملاعلاب', 'PDF', 'ابحرم'])
    expect(l.words.map((w) => w.offset)).toEqual([0, 40, 80])
    expect(l.x).toBe(72 - 80)
    expect(cs.codePoints).not.toContain(0x200e)
  })

  it('separateWords shortens overlapping boxes and pushes on a word squeezed to nothing', () => {
    const ws = [
      { offset: 0, width: 50 },
      { offset: 40, width: 20 },
      { offset: 41, width: 5 }
    ]
    separateWords(ws, 10, () => 2)
    expect(ws[0].width).toBeCloseTo(40 - 1.2, 9)
    expect(ws[1].width).toBe(2)
    expect(ws[2].offset).toBeCloseTo(40 + 2 + 1.2, 9)
  })

  it('keeps real words and drops recognition noise', () => {
    const w = (text: string, conf: number, h = 60): OcrWord => ({ text, conf, x0: 0, x1: 40, y0: 100, y1: 100 + h })
    const line: OcrLine = {
      words: [w('شركة', 85), w('ْ', 70), w("'", 30), w('0', 40, 5), w('0', 40, 55), w('.', 79, 5), w('ش', 20)],
      baseline: null,
      rowHeight: 60,
      bbox: { x0: 0, y0: 100, x1: 40, y1: 160 }
    }
    expect(keptWords(line).map((x) => x.text)).toEqual(['شركة', '0', '.', 'ش'])
  })

  it('specks in the margin read as "0" or "." are dropped; numbers in the text stay', () => {
    const w = (text: string, x0: number, x1: number, conf = 70): OcrWord => ({ text, conf, x0, x1, y0: 100, y1: 150 })
    // an Arabic line from x 600 to 1500, with a "0" of dust far to its left and a real number inside it
    const words = [w('0', 90, 110), w('.', 150, 160), w('شكرا', 600, 700, 90), w('10', 720, 760, 80), w('لكم', 780, 900, 90), w('جميعا', 920, 1500, 90)]
    expect(dropMarginSpecks(words, 50).map((x) => x.text)).toEqual(['شكرا', '10', 'لكم', 'جميعا'])
    // close to the text, or confidently read, or long: kept
    expect(dropMarginSpecks([w('0', 540, 560), ...words.slice(2)], 50)).toHaveLength(5)
    expect(dropMarginSpecks([w('7', 90, 110, 97), ...words.slice(2)], 50)).toHaveLength(5)
    expect(dropMarginSpecks([w('2026', 90, 190), ...words.slice(2)], 50)).toHaveLength(5)
  })

  it('lines of the body text share one size; headings keep theirs', () => {
    const l = (fontSize: number, n = 4): PlacedLine => ({ ...place([]), fontSize, words: Array.from({ length: n }, (_, i) => ({ text: 'x', offset: i * 10, width: 5, conf: 90 })) })
    const lines = [l(24, 2), l(13), l(16), l(12.5), l(20)]
    harmonizeSizes(lines)
    // body size: the median of the lines with three or more words (13, 16, 12.5, 20 -> 16); 24 is too far from it
    expect(lines.map((x) => x.fontSize)).toEqual([24, 16, 16, 16, 16])
  })

  it('lines of a page share its tilt: slopes near the median are replaced by it', () => {
    const mk = (slope: number): OcrLine => ({ words: [], baseline: { x0: 0, y0: 100, x1: 1000, y1: 100 + 1000 * slope }, rowHeight: 40, bbox: { x0: 0, y0: 80, x1: 1000, y1: 110 } })
    const words = [1, 2, 3].map(() => [{ text: 'a', x0: 0, x1: 1, y0: 0, y1: 1, conf: 90 }, { text: 'b', x0: 0, x1: 1, y0: 0, y1: 1, conf: 90 }])
    expect(pageSlopes([mk(0.012), mk(0.006), mk(0.015)], words)).toEqual([0.012, 0.012, 0.012])
    // a page that is straight: all lines straight (noise below the threshold), a clearly tilted line keeps its own
    expect(pageSlopes([mk(0.002), mk(-0.003), mk(0.2)], words)).toEqual([0, 0, 0.2])
  })
})

// ---- what readers extract --------------------------------------------------------------------------------------------

type Reader = 'model' | 'pdfjs' | 'pdfium' | 'windows'

describe('what each reader extracts from the layer of right-to-left lines', () => {
  let bytes: Uint8Array
  const texts = new Map<Reader, string | null>()
  const found = (r: Reader): number[] => SAMPLES.map((s, i) => (norm(texts.get(r) ?? '').includes(norm(s)) ? i : -1)).filter((i) => i >= 0)

  beforeAll(async () => {
    bytes = await ocrPdf(scannedPage(SAMPLES))
    const model = await modelOf(bytes)
    texts.set('model', model.text)
    texts.set('pdfjs', await pdfjsText(bytes))
    texts.set('pdfium', (await pdfiumPages(bytes))[0].text)
    texts.set('windows', windowsText(bytes))
    mkdirSync('test-results', { recursive: true })
    const report = (['model', 'pdfjs', 'pdfium', 'windows'] as Reader[]).map((r) => `== ${r}: ${texts.get(r) === null ? 'not available' : `${found(r).length}/${SAMPLES.length} lines verbatim (${found(r).join(',')})`}\n${texts.get(r) ?? ''}`)
    writeFileSync('test-results/ocr-rtl-readers.txt', report.join('\n\n'))
  }, 60_000)

  it("Epdf's page text model reads every line in logical order", async () => {
    const lines = linesOf(await modelOf(bytes))
    expect(lines.slice(0, 9)).toEqual(SAMPLES.slice(0, 9).map(norm))
    // An Arabic phrase with a number inside a left-to-right sentence is displayed the same for two logical orders
    // (the number is part of the right-to-left run); the model returns the one a reader sees (docs/page-text.md).
    expect(lines[9]).toBe('Invoice 48213 رقم الفاتورة total')
  })

  it('PDF.js reads right-to-left lines (marks at word ends, ZWNJ and Arabic inside English are its limits)', () => {
    expect(found('pdfjs')).toEqual([0, 1, 2, 3, 7, 8])
  })

  it("PDFium (Chrome, Edge) reads right-to-left lines, vowel marks and ZWNJ included (its own number rules aside)", () => {
    expect(found('pdfium')).toEqual([0, 2, 4, 5, 6, 7, 8])
  })

  it("Windows' own PDF engine finds the words; lines without numbers or Latin come out in order", () => {
    const t = texts.get('windows')
    if (t === null) return // not on Windows / no PDF filter
    for (const i of [0, 5, 6, 7]) expect(norm(t!), SAMPLES[i]).toContain(norm(SAMPLES[i]))
    // every word of letters is found as it is typed (numbers with separators are read as displayed: 48-2026)
    const words = SAMPLES.join(' ').split(/\s+/).filter((w) => /^\p{L}[\p{L}\p{M}‌]*[.]?$/u.test(w))
    expect(words.length).toBeGreaterThan(30)
    for (const w of words) expect(t!.normalize('NFC'), w).toContain(w.replace(/[.]$/, '').normalize('NFC'))
  })

  it('search (tashkeel-insensitive) finds every word, and the hit is drawn over the word in the scan', async () => {
    const model = await modelOf(bytes)
    const page = (await PDFDocument.load(bytes)).getPage(0)
    const g = geometryOf(page, 1700, 2200)
    const lines = scannedPage(SAMPLES)
    const toDisplay = (px: number, py: number): [number, number] => {
      const u = pixelToUser(g, px, py)
      const t = model.transform
      return [t[0] * u.x + t[2] * u.y + t[4], t[1] * u.x + t[3] * u.y + t[5]]
    }
    let checked = 0
    for (const line of lines.slice(0, 9)) {
      for (const w of line.words) {
        const hits = findNormalized(model.text, w.text.replace(/[.،,]$/, ''), {})
        expect(hits.length, w.text).toBeGreaterThan(0)
        // the hit whose boxes lie inside this word's box in the scan
        const [ax, ay] = toDisplay(w.x0, w.y0)
        const [bx, by] = toDisplay(w.x1, w.y1)
        const inside = hits.some((h) =>
          rangeBoxes(model, h.start, h.end).every((b) => b.x0 >= Math.min(ax, bx) - 1 && b.x1 <= Math.max(ax, bx) + 1 && b.y1 >= Math.min(ay, by) && b.y0 <= Math.max(ay, by))
        )
        expect(inside, w.text).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(35)
    // without the vowel marks, as people type a search
    expect(findNormalized(model.text, 'بسم الله', {}).length).toBe(1)
  })

  it('redaction finds an Arabic word of the layer and removes exactly its glyphs', async () => {
    const pdf = await PDFDocument.load(bytes)
    const hits = await searchDocument(pdf, { kind: 'literal', query: 'بالعالم', caseSensitive: false, wholeWord: true })
    expect(hits).toHaveLength(1)
    redactDocument(pdf, hits.map((h, i) => ({ id: `m${i}`, pageIndex: h.pageIndex, rects: h.rects, quads: h.quads, text: h.text })), DEFAULT_OPTIONS)
    const after = linesOf(await modelOf(await pdf.save()))
    expect(after[0]).toBe('مرحبا')
    expect(after.slice(1, 9)).toEqual(SAMPLES.slice(1, 9).map(norm))
  })
})

describe('right-to-left layers on rotated and tilted pages', () => {
  it.each([90, 180, 270])('a page with /Rotate %i', async (rot) => {
    const src = await createScanRotated(rot)
    const sideways = rot % 180 !== 0
    const bytes = await ocrPdf(scannedPage(SAMPLES.slice(0, 3)), src, sideways ? [2200, 1700] : [1700, 2200])
    expect(linesOf(await modelOf(bytes))).toEqual(SAMPLES.slice(0, 3).map(norm))
  })

  it.each([0.8, -1.5, 3])('lines tilted by %f degrees (a crooked scan that was not straightened)', async (deg) => {
    const slope = Math.tan((deg * Math.PI) / 180)
    const lines = scannedPage(SAMPLES.slice(0, 4)).map((l) => {
      const tilt = (x: number): number => (x - 200) * slope
      const words = l.words.map((w) => ({ ...w, y0: w.y0 + tilt(w.x0), y1: w.y1 + tilt(w.x0) }))
      return { ...l, words, baseline: { ...l.baseline!, y0: l.baseline!.y0 + tilt(l.baseline!.x0), y1: l.baseline!.y1 + tilt(l.baseline!.x1) } }
    })
    const bytes = await ocrPdf(lines)
    expect(linesOf(await modelOf(bytes))).toEqual(SAMPLES.slice(0, 4).map(norm))
    // PDF.js keeps each tilted line together too
    const pj = (await pdfjsText(bytes)).split('\n').map(norm).filter(Boolean)
    expect(pj.slice(0, 4)).toEqual(SAMPLES.slice(0, 4).map(norm))
  })

  it('a dropped (low-confidence) word does not split its line', async () => {
    const [l] = scannedPage(['تم تحويل مبلغ كبير إلى حساب الشركة'])
    l.words[3].conf = 5 // "كبير" is dropped: a gap of a whole word
    const bytes = await ocrPdf([l])
    expect(linesOf(await modelOf(bytes))).toEqual(['تم تحويل مبلغ إلى حساب الشركة'])
  })
})

describe('page orientation', () => {
  it("reads Tesseract's answer: the clockwise turn that makes the page upright, only when confident", () => {
    expect(interpretOsd({ orientation_degrees: 270, orientation_confidence: 6.8 })).toEqual({ degrees: 270, confidence: 6.8 })
    expect(interpretOsd({ orientation_degrees: 90, orientation_confidence: 1.2 })).toBeNull() // not sure: leave the page alone
    expect(interpretOsd({ orientation_degrees: 0, orientation_confidence: 0.4 })).toEqual({ degrees: 0, confidence: 0.4 })
    expect(interpretOsd({ orientation_degrees: null, orientation_confidence: null })).toBeNull() // too little text
    expect(interpretOsd(undefined)).toBeNull()
  })

  it('a picture drawn turned maps back like a page with that much more /Rotate', () => {
    const a = pixelToUser({ view: [0, 0, 612, 792], rotate: 90, turn: 180, width: 1700, height: 2200 }, 100, 200)
    const b = pixelToUser({ view: [0, 0, 612, 792], rotate: 270, width: 1700, height: 2200 }, 100, 200)
    expect(a).toEqual(b)
  })

  it.each([90, 180, 270] as const)('a page scanned turned by %i degrees, recognized the right way up: the layer reads in order', async (turn) => {
    // the picture was drawn turned so the text is upright in it; the page itself is still the sideways scan
    const size: [number, number] = turn % 180 ? [2200, 1700] : [1700, 2200]
    const pdf = await PDFDocument.load(await createScan1())
    const page = pdf.getPage(0)
    applyOcrLayers(pdf, [{ pageIndex: 0, geometry: { ...geometryOf(page, size[0], size[1]), turn }, lines: scannedPage(SAMPLES.slice(0, 4), { right: size[0] - 200 }) }])
    expect(geometryOf(page, 1, 1).rotate).toBe(0) // the page is not rotated by recognition
    expect(linesOf(await modelOf(await pdf.save()))).toEqual(SAMPLES.slice(0, 4).map(norm))
  })
})

describe('hidden OCR text of other tools', () => {
  /**
   * The pattern of the Internet Archive's OCR PDFs ("Internet Archive PDF 1.4.25; including mupdf"): each right-to-left
   * line is one text object with a MIRRORED text matrix (-1 0 0 1 x y Tm), so the pen moves leftwards, and every word is
   * drawn in logical order (first letter rightmost) with a trailing space, stretched with Tz and moved on with Td.
   */
  async function mirroredLayer(lines: string[]): Promise<Uint8Array> {
    const pdf = await PDFDocument.load(await createScan1())
    const cs = new Charset()
    for (const l of lines) cs.addText(l.replace(/ /g, '') + ' ')
    const font = embedGlyphlessFont(pdf, cs)
    const ops: string[] = []
    lines.forEach((line, k) => {
      const size = 12
      ops.push('BT', '3 Tr', `-1 0 0 1 ${500 - k * 3} ${700 - k * 30} Tm`, `/FIA ${size} Tf`)
      const words = line.split(' ')
      words.forEach((w, i) => {
        const tz = 70 + ((i * 13) % 20) // like the original: a different stretch per word
        const text = w + ' '
        ops.push(`${tz} Tz`, `[ ${cs.hex(text)} ] TJ`)
        // the next word starts where this one (and its space) ends, plus a little gap: Td runs leftwards on the page
        if (i < words.length - 1) ops.push(`${((cs.advance(text) / 1000) * size * tz) / 100 + 1.5} 0 Td`)
      })
      ops.push('ET')
    })
    const page = pdf.getPage(0)
    page.node.normalize()
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream(new TextEncoder().encode(ops.join('\n')))))
    const res = page.node.Resources()!
    res.lookup(PDFName.of('Font'), PDFDict).set(PDFName.of('FIA'), font)
    return pdf.save()
  }

  it('a mirrored text matrix with lines in logical order (Internet Archive / mupdf OCR) reads in logical order', async () => {
    const lines = ['رابطة الأدب الإسلامي العالمية', 'مكتب البلاد العربية', 'محمد رشيد عبيد', 'שלום עולם']
    const model = await modelOf(await mirroredLayer(lines))
    expect(linesOf(model)).toEqual(lines)
    // search finds the words as typed
    expect(findNormalized(model.text, 'الإسلامي', {}).length).toBe(1)
  })
})
