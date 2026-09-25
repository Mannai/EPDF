import { PDFArray, PDFDict, PDFDocument, PDFName, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildPrintHtml } from '../../src/shared/features/print/html'
import {
  DEFAULT_PRINT_OPTIONS,
  jobOrientation,
  resolvePages,
  scaleFor,
  sheetFor,
  summarize,
  validateOptions,
  type PrintOptions
} from '../../src/shared/features/print/options'
import { preparePrintPdf, scalePages, stripAnnotations } from '../../src/shared/features/print/prepare'
import { fileContains, makeDoc, pageLabelsOf, reload } from './pdfTestUtils'

const N = (s: string): PDFName => PDFName.of(s)
const opts = (o: Partial<PrintOptions>): PrintOptions => ({ ...DEFAULT_PRINT_OPTIONS, ...o })

/** A page annotation of the given subtype (with a trivial appearance so it is visible when printed). */
function annotate(doc: PDFDocument, pageIndex: number, subtype: string, extra: Record<string, unknown> = {}): void {
  const ctx = doc.context
  const ap = ctx.register(ctx.stream('1 1 0 rg 0 0 100 20 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20] }))
  const a = ctx.register(ctx.obj({ Type: 'Annot', Subtype: subtype, Rect: [100, 500, 200, 520], F: 4, Contents: `note-${subtype}`, AP: { N: ap }, ...extra }))
  const page = doc.getPage(pageIndex)
  const annots = page.node.lookupMaybe(N('Annots'), PDFArray)
  if (annots) annots.push(a)
  else page.node.set(N('Annots'), ctx.obj([a]))
}
const annotCount = (doc: PDFDocument, i: number): number => doc.getPage(i).node.lookupMaybe(N('Annots'), PDFArray)?.size() ?? 0

describe('resolvePages', () => {
  it('all, current and custom ranges', () => {
    expect(resolvePages(opts({ range: 'all' }), 4, 2)).toEqual({ ok: true, value: [0, 1, 2, 3] })
    expect(resolvePages(opts({ range: 'current' }), 4, 3)).toEqual({ ok: true, value: [2] })
    expect(resolvePages(opts({ range: 'current' }), 4, 99)).toEqual({ ok: true, value: [3] })
    expect(resolvePages(opts({ range: 'custom', custom: '1-3,7' }), 8, 1)).toEqual({ ok: true, value: [0, 1, 2, 6] })
    expect(resolvePages(opts({ range: 'custom', custom: '3, 1-4' }), 8, 1)).toEqual({ ok: true, value: [2, 0, 1, 3] })
  })
  it('reports bad ranges', () => {
    const r = resolvePages(opts({ range: 'custom', custom: '1-9' }), 5, 1)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/Page 9 is out of range/)
    expect(resolvePages(opts({ range: 'custom', custom: '' }), 5, 1).ok).toBe(false)
    expect(resolvePages(opts({}), 0, 1).ok).toBe(false)
  })
})

describe('options math', () => {
  it('validates copies and percentages', () => {
    expect(validateOptions(opts({}))).toBeNull()
    expect(validateOptions(opts({ copies: 0 }))).toMatch(/Copies/)
    expect(validateOptions(opts({ copies: 1.5 }))).toMatch(/Copies/)
    expect(validateOptions(opts({ copies: 100 }))).toMatch(/Copies/)
    expect(validateOptions(opts({ scaling: 'custom', percent: 5 }))).toMatch(/Scale/)
    expect(validateOptions(opts({ scaling: 'custom', percent: NaN }))).toMatch(/Scale/)
    expect(validateOptions(opts({ scaling: 'fit', percent: 5 }))).toBeNull() // percent only matters for "custom"
  })
  it('computes scale factors', () => {
    const page = { width: 612, height: 792 }
    expect(scaleFor('actual', 50, page, { width: 100, height: 100 })).toBe(1)
    expect(scaleFor('custom', 50, page, page)).toBe(0.5)
    expect(scaleFor('custom', 9999, page, page)).toBe(4)
    expect(scaleFor('fit', 100, page, { width: 306, height: 792 })).toBe(0.5)
    expect(scaleFor('fit', 100, page, { width: 1224, height: 1584 })).toBe(2)
  })
  it('picks the job orientation from the majority of pages', () => {
    const p = { width: 612, height: 792 }
    const l = { width: 792, height: 612 }
    expect(jobOrientation('auto', [p, p, l])).toBe('portrait')
    expect(jobOrientation('auto', [l, l, p])).toBe('landscape')
    expect(jobOrientation('auto', [l, p])).toBe('portrait') // a tie stays portrait
    expect(jobOrientation('landscape', [p])).toBe('landscape')
  })
  it('sheet sizes for Save as PDF', () => {
    expect(sheetFor('source', 'auto', { width: 1, height: 2 })).toBeNull()
    expect(sheetFor('letter', 'auto', { width: 800, height: 600 })).toEqual({ width: 792, height: 612 })
    expect(sheetFor('a4', 'portrait', { width: 800, height: 600 })).toEqual({ width: 595.28, height: 841.89 })
    expect(sheetFor('a4', 'landscape', { width: 600, height: 800 })?.width).toBeCloseTo(841.89)
  })
  it('summarizes', () => {
    expect(summarize(1, 1)).toBe('1 page')
    expect(summarize(3, 2)).toBe('3 pages × 2 copies = 6 sheets')
  })
})

describe('stripAnnotations (works on a temporary copy)', () => {
  it('removes comments, highlights and links but keeps form widgets, and drops their objects', async () => {
    const doc = await makeDoc(2)
    annotate(doc, 0, 'Highlight', { QuadPoints: [100, 520, 200, 520, 100, 500, 200, 500] })
    annotate(doc, 0, 'Text', { Name: 'Comment' })
    annotate(doc, 0, 'Widget', { FT: 'Tx', T: 'field' })
    annotate(doc, 1, 'Link')
    const bytes = await doc.save()
    const copy = await PDFDocument.load(bytes)
    expect(stripAnnotations(copy)).toBe(3)
    const out = await reload(await copy.save())
    expect(annotCount(out, 0)).toBe(1)
    expect(out.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict).lookup(N('Subtype'), PDFName).decodeText()).toBe('Widget')
    expect(annotCount(out, 1)).toBe(0)
    expect(out.getPage(1).node.has(N('Annots'))).toBe(false)
    // The original document object is untouched.
    expect(annotCount(doc, 0)).toBe(3)
  })
})

describe('preparePrintPdf', () => {
  it('keeps only the requested pages, in order, with or without annotations', async () => {
    const doc = await makeDoc(6)
    annotate(doc, 2, 'Highlight')
    annotate(doc, 4, 'Text')
    const bytes = await doc.save()

    const withNotes = await reload(await preparePrintPdf(bytes, { pages: [2, 3, 4], annotations: true }))
    expect(pageLabelsOf(withNotes)).toEqual(['Page 3', 'Page 4', 'Page 5'])
    expect(annotCount(withNotes, 0)).toBe(1)
    expect(annotCount(withNotes, 2)).toBe(1)
    expect(fileContains(withNotes, 'Page 1')).toBe(false)

    const without = await reload(await preparePrintPdf(bytes, { pages: [2, 3, 4], annotations: false }))
    expect(pageLabelsOf(without)).toEqual(['Page 3', 'Page 4', 'Page 5'])
    expect([0, 1, 2].map((i) => annotCount(without, i))).toEqual([0, 0, 0])
    expect(without.context.enumerateIndirectObjects().every(([, o]) => !(o instanceof PDFDict) || !o.has(N('QuadPoints')))).toBe(true)
  })

  it('leaves the source bytes unchanged', async () => {
    const doc = await makeDoc(3)
    annotate(doc, 0, 'Text')
    const bytes = await doc.save()
    const copy = bytes.slice()
    await preparePrintPdf(bytes, { pages: [0], annotations: false })
    expect(bytes).toEqual(copy)
  })
})

describe('scalePages', () => {
  const scaled = async (o: Parameters<typeof scalePages>[1], size: [number, number] = [612, 792], rotate = 0): Promise<PDFDocument> => {
    const doc = await makeDoc(1, { sizes: [size] })
    doc.getPage(0).setRotation(degrees(rotate))
    annotate(doc, 0, 'Highlight')
    scalePages(doc, o)
    return reload(await doc.save())
  }

  it('a custom percentage resizes the page and moves annotations with the content', async () => {
    const out = await scaled({ scaling: 'custom', percent: 50, paper: 'source', orientation: 'auto' })
    expect(out.getPage(0).getSize()).toEqual({ width: 306, height: 396 })
    const r = out.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict).lookup(N('Rect'), PDFArray).asArray().map((n) => Number(n.toString()))
    expect(r).toEqual([50, 250, 100, 260]) // [100 500 200 520] at 50%
    expect(fileContains(out, 'Page 1')).toBe(true)
  })

  it('fit onto A4 centres the scaled page', async () => {
    const out = await scaled({ scaling: 'fit', percent: 100, paper: 'a4', orientation: 'auto' })
    const { width, height } = out.getPage(0).getSize()
    expect(width).toBeCloseTo(595.28)
    expect(height).toBeCloseTo(841.89)
    // 612x792 letter fits A4 with scale min(595.28/612, 841.89/792) = 0.9727 → centred horizontally at 0
    const r = out.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict).lookup(N('Rect'), PDFArray).asArray().map((n) => Number(n.toString()))
    const s = 595.28 / 612
    expect(r[0]).toBeCloseTo(100 * s, 1)
    expect(r[1]).toBeCloseTo(500 * s + (841.89 - 792 * s) / 2, 1)
  })

  it('"actual size" on a smaller paper crops instead of shrinking; source paper + fit/actual is a no-op', async () => {
    const crop = await scaled({ scaling: 'actual', percent: 100, paper: 'a4', orientation: 'auto' }, [800, 1000])
    expect(crop.getPage(0).getSize().width).toBeCloseTo(595.28)
    const same = await scaled({ scaling: 'fit', percent: 100, paper: 'source', orientation: 'auto' })
    expect(same.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
  })

  it('handles rotated pages: the sheet follows the displayed orientation', async () => {
    const out = await scaled({ scaling: 'fit', percent: 100, paper: 'a4', orientation: 'auto' }, [612, 792], 90)
    const page = out.getPage(0)
    expect(page.getRotation().angle).toBe(90)
    // displayed landscape → sheet is landscape; its unrotated MediaBox is portrait
    expect(page.getSize().width).toBeCloseTo(595.28)
    expect(page.getSize().height).toBeCloseTo(841.89)
  })
})

describe('print document (HTML)', () => {
  const pages = [{ widthPt: 612, heightPt: 792 }, { widthPt: 792, heightPt: 612 }, { widthPt: 300, heightPt: 400 }]
  const base = { origin: 'epdf-app://print-1', scaling: 'fit' as const, percent: 100, copies: 1, target: 'native' as const }
  const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length

  it('has one sheet per page per copy, collated', () => {
    expect(count(buildPrintHtml(pages, base), /class="sheet"/g)).toBe(3)
    const two = buildPrintHtml(pages, { ...base, copies: 2 })
    expect(count(two, /class="sheet"/g)).toBe(6)
    expect([...two.matchAll(/print-1\/(\d)\.jpg/g)].map((m) => m[1]).join('')).toBe('012012')
  })
  it('sizes pages for actual size and custom percentages, and lets "fit" fill the sheet', () => {
    expect(buildPrintHtml(pages, { ...base, scaling: 'actual' })).toContain('width:612pt;height:792pt')
    expect(buildPrintHtml(pages, { ...base, scaling: 'custom', percent: 50 })).toContain('width:306pt;height:396pt')
    expect(buildPrintHtml(pages, { ...base, scaling: 'custom', percent: 5000 })).toContain('width:2448pt') // clamped to 400%
    expect(buildPrintHtml(pages, base)).toContain('class="fit"')
  })
  it('is inert: no scripts, no external loads, images only from the job origin', () => {
    const html = buildPrintHtml(pages, base)
    expect(html).not.toMatch(/<script|onerror|onload|javascript:/i)
    expect(html).toContain("default-src 'none'; img-src epdf-app://print-1; style-src 'unsafe-inline'")
    expect([...html.matchAll(/src="([^"]+)"/g)].every((m) => m[1].startsWith('epdf-app://print-1/'))).toBe(true)
  })
  it('only the file target forces zero margins', () => {
    expect(buildPrintHtml(pages, { ...base, target: 'file' })).toContain('@page { margin: 0 }')
    expect(buildPrintHtml(pages, base)).not.toContain('@page')
  })
})
