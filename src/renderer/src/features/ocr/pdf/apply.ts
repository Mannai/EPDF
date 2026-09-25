import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, PDFString, type PDFDocument, type PDFPage } from 'pdf-lib'
import { MIN_WORD_CONFIDENCE, type OcrLine } from '@shared/features/ocr'
import { Charset, buildToUnicode } from './charset'
import { buildGlyphlessFont } from './glyphlessFont'
import { normalizeRotation, placeWord, type LayoutOptions, type PageGeometry } from './layout'
import { LAYER_MARKER, buildLayerStream, collectChars, type LayerLine } from './textLayer'

/** The recognized text of one page, with the geometry of the picture it was recognized in. */
export interface PageOcr {
  /** 0-based page index in the document. */
  pageIndex: number
  geometry: PageGeometry
  lines: OcrLine[]
  deskew?: LayoutOptions['deskew']
}

export interface ApplyResult {
  /** Pages that received a text layer. */
  pages: number[]
  words: number
  /** Pages left untouched because the document no longer matched what was recognized (with the reason). */
  skipped: { pageIndex: number; reason: string }[]
  /** Mean confidence (0-100) of the words that were kept. */
  confidence: number
}

const LAYER_KEY = PDFName.of('EpdfOcrLayer')

const intersect = (a: number[], b: number[]): [number, number, number, number] => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3])
]

/** The visible box PDF.js uses for a page: CropBox clipped to MediaBox (user space). */
export function visibleBox(page: PDFPage): [number, number, number, number] {
  const m = page.getMediaBox()
  const c = page.getCropBox()
  const r = intersect([c.x, c.y, c.x + c.width, c.y + c.height], [m.x, m.y, m.x + m.width, m.y + m.height])
  return r[2] > r[0] && r[3] > r[1] ? r : [m.x, m.y, m.x + m.width, m.y + m.height]
}

/** Why the page in the document no longer matches what was recognized, or null if it still does. */
export function geometryMismatch(page: PDFPage, g: PageGeometry): string | null {
  const box = visibleBox(page)
  if (normalizeRotation(page.getRotation().angle) !== g.rotate) return 'the page was rotated after it was scanned for text'
  if (box.some((v, i) => Math.abs(v - g.view[i]) > 0.75)) return 'the page size changed after it was scanned for text'
  return null
}

/** Embeds the glyphless Type0 font for `charset`; returns its reference. */
export function embedGlyphlessFont(pdf: PDFDocument, charset: Charset): PDFRef {
  const ctx = pdf.context
  const program = buildGlyphlessFont(charset.widths())
  const fontFile = ctx.register(ctx.flateStream(program, { Length1: program.length }))
  const descriptor = ctx.register(
    ctx.obj({
      Type: 'FontDescriptor',
      FontName: 'EpdfGlyphless',
      Flags: 4,
      FontBBox: [0, -200, 1000, 800],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 700,
      StemV: 80,
      FontFile2: fontFile
    })
  )
  const cidFont = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'EpdfGlyphless',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: 1000,
      W: [1, charset.widths()],
      CIDToGIDMap: 'Identity'
    })
  )
  const toUnicode = ctx.register(ctx.flateStream(new TextEncoder().encode(buildToUnicode(charset))))
  return ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'EpdfGlyphless', Encoding: 'Identity-H', DescendantFonts: [cidFont], ToUnicode: toUnicode })
  )
}

/** Removes text layers written by an earlier OCR run from the page (and frees their streams). */
function removeOwnLayers(pdf: PDFDocument, page: PDFPage): void {
  const contents = page.node.get(PDFName.of('Contents'))
  const arr = contents instanceof PDFArray ? contents : contents ? pdf.context.lookup(contents) : undefined
  if (!(arr instanceof PDFArray)) return
  for (let i = arr.size() - 1; i >= 0; i--) {
    const ref = arr.get(i)
    const s = ref instanceof PDFRef ? pdf.context.lookup(ref) : ref
    if (s instanceof PDFStream && s.dict.has(LAYER_KEY)) {
      arr.remove(i)
      if (ref instanceof PDFRef) pdf.context.delete(ref)
    }
  }
}

/**
 * Adds the invisible text layers to the document (one undoable edit's worth of pdf-lib work). The page picture is
 * never touched: the layer is a new content stream appended after the page's own contents.
 */
export function applyOcrLayers(pdf: PDFDocument, results: PageOcr[], minConfidence = MIN_WORD_CONFIDENCE): ApplyResult {
  const pdfPages = pdf.getPages()
  const skipped: ApplyResult['skipped'] = []
  const charset = new Charset()
  const prepared: { page: PDFPage; pageIndex: number; lines: LayerLine[] }[] = []
  let confSum = 0
  let words = 0

  for (const r of results) {
    const page = pdfPages[r.pageIndex]
    if (!page) {
      skipped.push({ pageIndex: r.pageIndex, reason: 'the page no longer exists' })
      continue
    }
    const why = geometryMismatch(page, r.geometry)
    if (why) {
      skipped.push({ pageIndex: r.pageIndex, reason: why })
      continue
    }
    const lines: LayerLine[] = []
    for (const line of r.lines) {
      const kept = line.words.filter((w) => w.conf >= minConfidence)
      if (!kept.length) continue
      const placed = kept.map((w) => placeWord(r.geometry, line, w, { deskew: r.deskew }))
      lines.push({ words: placed })
      for (const w of kept) {
        confSum += w.conf
        words++
      }
    }
    const usable = collectChars(lines, charset)
    if (usable.length) prepared.push({ page, pageIndex: r.pageIndex, lines: usable })
  }

  if (prepared.length === 0) return { pages: [], words: 0, skipped, confidence: 0 }

  const fontRef = embedGlyphlessFont(pdf, charset)
  const fontName = `EpdfOcr${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`
  let usedWords = 0
  for (const p of prepared) {
    p.page.node.normalize() // wraps the page's own content in q/Q so our stream starts from a clean state
    removeOwnLayers(pdf, p.page)
    const stream = pdf.context.flateStream(new TextEncoder().encode(buildLayerStream(fontName, charset, p.lines)), { EpdfOcrLayer: true })
    p.page.node.addContentStream(pdf.context.register(stream))
    const resources = p.page.node.Resources() as PDFDict
    const fonts = resources.lookup(PDFName.of('Font'), PDFDict)
    fonts.set(PDFName.of(fontName), fontRef)
    usedWords += p.lines.reduce((n, l) => n + l.words.length, 0)
  }
  return { pages: prepared.map((p) => p.pageIndex), words: usedWords, skipped, confidence: words ? confSum / words : 0 }
}

export { LAYER_MARKER }
