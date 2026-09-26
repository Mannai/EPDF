import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { defaultHeaderFooter, defaultWatermark } from '../../src/shared/features/headerfooter'
import { ApplyCancelled } from '../../src/renderer/src/features/headerfooter/pdf/apply'
import { applyGroup, removeGroup } from '../../src/renderer/src/features/headerfooter/pdf/ops'
import { summarizeMarks } from '../../src/renderer/src/features/headerfooter/pdf/remove'
import { setupText } from './helpers/text'

/** 500 pages: time, progress, cancel, fonts embedded once, and the size the marks add. */
setupText()

async function big(n: number): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= n; i++) pdf.addPage([612, 792]).drawText(`Page body ${i}`, { x: 72, y: 700, size: 24, font })
  return PDFDocument.load(await pdf.save())
}

describe('500 pages', () => {
  it('header + footer with page numbers and an Arabic header: fast, one font subset per font, reports progress', async () => {
    const pdf = await big(500)
    const s = defaultHeaderFooter()
    s.slots.topRight = 'تقرير {date}'
    s.slots.bottomCenter = 'Page {page} of {pages}'
    const progress: number[] = []
    const t0 = performance.now()
    const r = await applyGroup(pdf, { group: 'headerfooter', settings: s }, { mode: 'replace', fileName: 'big.pdf', yieldEvery: 10, onProgress: (d) => progress.push(d) })
    const tApply = performance.now() - t0
    const bytes = await pdf.save()
    const tAll = performance.now() - t0
    console.log(`500 pages: apply ${tApply.toFixed(0)} ms, apply + save ${tAll.toFixed(0)} ms, ${(bytes.length / 1024).toFixed(0)} KB`)
    expect(r.pages).toBe(500)
    expect(tAll).toBeLessThan(20_000) // measured ~1-3 s on the dev machine; generous for a loaded CI box
    expect(progress.length).toBeGreaterThanOrEqual(500)
    expect(progress[progress.length - 1]).toBe(500)
    const doc = await PDFDocument.load(bytes)
    const type0 = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of('Subtype')) === PDFName.of('Type0'))
    expect(type0.length).toBeLessThanOrEqual(3)
    expect(summarizeMarks(doc).headerfooter.pages).toBe(500)
  })

  it('a watermark on 500 same-size pages shares one form: the file grows by kilobytes, not megabytes', async () => {
    const pdf = await big(500)
    const before = (await pdf.save()).length
    await applyGroup(pdf, { group: 'watermark', settings: defaultWatermark() }, { mode: 'replace', fileName: 'big.pdf' })
    const after = (await pdf.save()).length
    console.log(`watermark on 500 pages adds ${((after - before) / 1024).toFixed(0)} KB`)
    expect(after - before).toBeLessThan(60 * 1024) // measured ~5 KB: forms and content streams are shared
  })

  it('cancelling stops the work and throws, and removing on 500 pages is fast', async () => {
    const pdf = await big(500)
    let n = 0
    await expect(applyGroup(pdf, { group: 'headerfooter', settings: defaultHeaderFooter() }, { mode: 'replace', fileName: 'x', yieldEvery: 5, isCancelled: () => ++n > 50 })).rejects.toBeInstanceOf(ApplyCancelled)
    const pdf2 = await big(500)
    await applyGroup(pdf2, { group: 'headerfooter', settings: defaultHeaderFooter() }, { mode: 'replace', fileName: 'x' })
    const doc = await PDFDocument.load(await pdf2.save())
    const t0 = performance.now()
    const r = await removeGroup(doc, 'headerfooter')
    console.log(`remove from 500 pages: ${(performance.now() - t0).toFixed(0)} ms`)
    expect(r.pages).toBe(500)
    expect(performance.now() - t0).toBeLessThan(15_000)
  })
})
