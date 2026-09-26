import { PDFDocument, PDFName, PDFRef, PDFStream, StandardFonts, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { defaultBackground, defaultHeaderFooter, defaultWatermark, type OverlaySettings } from '../../src/shared/features/headerfooter'
import { applyOverlay } from '../../src/renderer/src/features/headerfooter/pdf/apply'
import { applyGroup } from '../../src/renderer/src/features/headerfooter/pdf/ops'
import { previewBytes } from '../../src/renderer/src/features/headerfooter/pdf/preview'
import { summarizeMarks } from '../../src/renderer/src/features/headerfooter/pdf/remove'
import { seePages } from './helpers/hfPdfjs'
import { setupText } from './helpers/text'

/** Watermarks/backgrounds from a page of another PDF, and the preview builder. */
setupText()

async function target(n = 2): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= n; i++) pdf.addPage([612, 792]).drawText(`Target ${i}`, { x: 72, y: 700, size: 12, font })
  return pdf
}

async function sourcePdf(rotate: number, crop?: [number, number, number, number]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([300, 200]).drawText('FIRSTPAGE', { x: 20, y: 100, size: 20, font })
  const p = pdf.addPage([400, 300])
  p.drawText('SRCPAGE', { x: 50, y: 150, size: 30, font })
  if (crop) p.setCropBox(...crop)
  if (rotate) p.setRotation(degrees(rotate))
  return pdf.save()
}

const pdfWm = (page: number, over: Partial<OverlaySettings> = {}): OverlaySettings => ({ ...defaultWatermark(), source: { kind: 'pdf', name: 'src.pdf', page }, rotation: 0, opacity: 1, ...over })

describe('a page of another PDF as the watermark', () => {
  it('draws the chosen page, the way a reader shows it (its /Rotate honoured), centred', async () => {
    for (const rotate of [0, 90, 180, 270]) {
      const src = await sourcePdf(rotate)
      const seenSrc = (await seePages(src))[1]!.items.find((t) => t.str === 'SRCPAGE')!
      const pdf = await target()
      await applyOverlay(pdf, 'watermark', pdfWm(2, { scale: { mode: 'absolute', percent: 100 } }), { bytes: src, kind: 'pdf' }, { fileName: 'x' })
      const seen = await seePages(await pdf.save())
      const it0 = seen[0]!.items.find((t) => t.str === 'SRCPAGE')!
      expect(it0, `rotate ${rotate}`).toBeTruthy()
      expect(seen[0]!.text).not.toContain('FIRSTPAGE')
      // same direction on our page as in the source viewer
      expect(it0.dir[0], `rotate ${rotate} dir x`).toBeCloseTo(seenSrc.dir[0], 5)
      expect(it0.dir[1], `rotate ${rotate} dir y`).toBeCloseTo(seenSrc.dir[1], 5)
      // and at the same place relative to the centre of the embedded page (absolute 100 %: no scaling)
      const srcW = rotate % 180 ? 300 : 400
      const srcH = rotate % 180 ? 400 : 300
      const ox = (612 - srcW) / 2
      const oy = (792 - srcH) / 2
      expect(it0.x - ox, `rotate ${rotate} x`).toBeCloseTo(seenSrc.x, 1)
      expect(it0.y - oy, `rotate ${rotate} y`).toBeCloseTo(seenSrc.y, 1)
    }
  })

  it('only the visible (cropped) part of the source page is used', async () => {
    const src = await sourcePdf(0, [40, 130, 200, 60]) // CropBox 40..240 x 130..190 contains the word
    const pdf = await target(1)
    await applyOverlay(pdf, 'background', { ...defaultBackground(), source: { kind: 'pdf', name: 'src.pdf', page: 2 }, scale: { mode: 'absolute', percent: 100 } }, { bytes: src, kind: 'pdf' }, { fileName: 'x' })
    const seen = await seePages(await pdf.save())
    const it0 = seen[0]!.items.find((t) => t.str === 'SRCPAGE')!
    // the 200 x 60 crop is centred: its left edge is at (612 - 200) / 2, the word starts 10 pt into it
    expect(it0.x).toBeCloseTo((612 - 200) / 2 + 10, 1)
  })

  it('clear errors: page out of range, not a PDF, encrypted source', async () => {
    const src = await sourcePdf(0)
    await expect(applyOverlay(await target(1), 'watermark', pdfWm(5), { bytes: src, kind: 'pdf' }, { fileName: 'x' })).rejects.toThrow('That PDF has only 2 pages.')
    await expect(applyOverlay(await target(1), 'watermark', pdfWm(1), { bytes: new TextEncoder().encode('%PDF-1.7 garbage'), kind: 'pdf' }, { fileName: 'x' })).rejects.toThrow(/could not be read/)
    const { readFileSync } = await import('node:fs')
    const enc = new Uint8Array(readFileSync('tests/fixtures/security/aes-256-r6.pdf'))
    await expect(applyOverlay(await target(1), 'watermark', pdfWm(1), { bytes: enc, kind: 'pdf' }, { fileName: 'x' })).rejects.toThrow(/password protected/)
    await expect(applyOverlay(await target(1), 'watermark', pdfWm(1), undefined, { fileName: 'x' })).rejects.toThrow('Choose a PDF file.')
    const img: OverlaySettings = { ...defaultWatermark(), source: { kind: 'image', name: 'x.png' } }
    await expect(applyOverlay(await target(1), 'watermark', img, { bytes: new Uint8Array([1, 2, 3]), kind: 'png' }, { fileName: 'x' })).rejects.toThrow(/picture could not be read/)
  })
})

describe('pictures', () => {
  it('a JPEG picture is embedded once and drawn at its size (1 px = 1 pt) on every page', async () => {
    const jpeg = await import('jpeg-js')
    const w = 40
    const h = 20
    const data = Buffer.alloc(w * h * 4, 0)
    for (let i = 0; i < w * h; i++) data.set([200, 30, 30, 255], i * 4)
    const bytes = new Uint8Array(jpeg.encode({ data, width: w, height: h }, 90).data)
    const pdf = await target(3)
    const s: OverlaySettings = { ...defaultWatermark(), source: { kind: 'image', name: 'x.jpg' }, scale: { mode: 'absolute', percent: 100 }, rotation: 0 }
    const r = await applyOverlay(pdf, 'watermark', s, { bytes, kind: 'jpeg' }, { fileName: 'x' })
    expect(r.pages).toBe(3)
    const doc = await PDFDocument.load(await pdf.save())
    const images = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
    expect(images.length).toBe(1)
    const src = summarizeMarks(doc).watermark.source!
    const bbox = doc.context.lookup(src, PDFStream).dict.lookup(PDFName.of('BBox'))!.toString()
    expect(bbox).toBe('[ 0 0 40 20 ]')
  })
})

describe('preview', () => {
  it('draws the marks on a copy of the chosen page, numbered as in the real document, and never touches the document', async () => {
    const base = await PDFDocument.load(await (await target(5)).save())
    const before = await base.save()
    const s = defaultHeaderFooter()
    s.slots.bottomCenter = 'Page {page} of {pages}'
    const bytes = await previewBytes({ base, pageIndex: 3, gs: { group: 'headerfooter', settings: s }, mode: 'replace', fileName: 'x', withMarks: true })
    const seen = await seePages(bytes)
    expect(seen.length).toBe(1)
    expect(seen[0]!.text).toContain('Target 4')
    expect(seen[0]!.text).toContain('Page 4 of 5')
    expect((await base.save()).length).toBe(before.length)
    const plain = await seePages(await previewBytes({ base, pageIndex: 3, gs: { group: 'headerfooter', settings: s }, mode: 'replace', fileName: 'x', withMarks: false }))
    expect(plain[0]!.text).not.toContain('Page 4 of 5')
  })

  it('replace mode shows the update: the old mark is gone from the preview; an earlier picture is reused', async () => {
    const pdf = await target(2)
    const old = defaultWatermark()
    if (old.source.kind === 'text') old.source.text = 'OLDMARK'
    await applyOverlay(pdf, 'watermark', old, undefined, { fileName: 'x' })
    const base = await PDFDocument.load(await pdf.save())
    const next = { ...defaultWatermark() }
    if (next.source.kind === 'text') next.source.text = 'NEWMARK'
    const replaced = await seePages(await previewBytes({ base, pageIndex: 0, gs: { group: 'watermark', settings: next }, mode: 'replace', fileName: 'x', withMarks: true }))
    expect(replaced[0]!.text).toContain('NEWMARK')
    expect(replaced[0]!.text).not.toContain('OLDMARK')
    const added = await seePages(await previewBytes({ base, pageIndex: 0, gs: { group: 'watermark', settings: next }, mode: 'add', fileName: 'x', withMarks: true }))
    expect(added[0]!.text).toContain('OLDMARK')

    // picture reuse: the source XObject of the real document is copied into the preview
    const src = await sourcePdf(0)
    const withPdf = await target(1)
    await applyGroup(withPdf, { group: 'watermark', settings: pdfWm(2) }, { mode: 'add', fileName: 'x', source: { bytes: src, kind: 'pdf' } })
    const reopened = await PDFDocument.load(await withPdf.save())
    const sum = summarizeMarks(reopened).watermark
    expect(sum.source).toBeInstanceOf(PDFRef)
    const pv = await seePages(await previewBytes({ base: reopened, pageIndex: 0, gs: { group: 'watermark', settings: pdfWm(2, { rotation: 30 }) }, mode: 'replace', fileName: 'x', withMarks: true, source: { ref: sum.source! } }))
    expect(pv[0]!.items.filter((t) => t.str === 'SRCPAGE').length).toBe(1)
  })
})
