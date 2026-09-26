import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { DEFAULT_OPTIONS, redactDocument, redactDocumentAsync, type MarkInput } from '../../src/renderer/src/features/redact/logic/redact'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { norm, pageModel } from '../support/retrofit'
import { buildPdf, helvetica } from './helpers/pdfBuilder'

/** Redaction overlay text in Arabic / Hebrew / CJK is drawn by the text engine and the self-check stays clean. */

const area = (x0: number, y0: number, x1: number, y1: number, pageIndex = 0): MarkInput => ({ id: 'a', pageIndex, rects: [{ x0, y0, x1, y1 }] })

async function doc(rotate = 0): Promise<Uint8Array> {
  const { doc } = await buildPdf([{ content: 'BT /F1 14 Tf 72 700 Td (Account TOPSECRET 4711) Tj ET BT /F1 14 Tf 72 600 Td (Keep this line) Tj ET', fonts: { F1: helvetica }, rotate }])
  return doc.save()
}

describe('redaction overlay text in any script', () => {
  for (const [label, text] of [
    ['Arabic', 'محجوب'],
    ['Hebrew', 'חסוי'],
    ['mixed', 'محذوف ID 42'],
    ['CJK', '已删除']
  ] as const) {
    it(`${label}: shaped overlay text, read back in logical order, self-check clean`, async () => {
      const pdf = await PDFDocument.load(await doc())
      const res = await redactDocumentAsync(pdf, [area(120, 690, 260, 720)], { ...DEFAULT_OPTIONS, fill: [0, 0, 0], overlayText: text })
      const out = await pdf.save()
      const m = await pageModel(out)
      const lines = m.text.split('\n').map(norm)
      // (the overlay sits on the line of the text it replaced: "Accoun محذوف ID 42")
      expect(norm(m.text)).toContain(norm(text))
      expect(m.text).not.toContain('TOPSECRET')
      expect(lines).toContain('Keep this line')
      // the overlay's fonts carry the overlay prefix, so the self-check does not count them as page text
      const re = await PDFDocument.load(out)
      const overlay = analyzePage(re, 0).runs.filter((r) => r.fontName.startsWith('EpdfRdFont'))
      expect(overlay.length).toBeGreaterThan(0)
      expect(await verifyRedaction({ bytes: out, marksByPage: res.marksByPage, secrets: res.secrets })).toEqual([])
      if (label === 'Arabic') {
        mkdirSync(resolve('test-results/text-retrofit'), { recursive: true })
        writeFileSync(resolve('test-results/text-retrofit/redact-arabic.pdf'), out)
      }
    })
  }

  it('upright on a rotated page', async () => {
    const pdf = await PDFDocument.load(await doc(90))
    await redactDocumentAsync(pdf, [area(60, 600, 100, 800)], { ...DEFAULT_OPTIONS, fill: [1, 1, 1], overlayText: 'محجوب' })
    const m = await pageModel(await pdf.save())
    const l = m.lines.find((x) => norm(m.text.slice(x.start, x.end)) === 'محجوب')!
    expect(l).toBeDefined()
    expect(Math.abs(l.angle)).toBeLessThan(1)
  })

  it('Latin overlay text is written with Helvetica as before; the synchronous path draws only what Helvetica has', async () => {
    const pdf = await PDFDocument.load(await doc())
    await redactDocumentAsync(pdf, [area(120, 690, 260, 720)], { ...DEFAULT_OPTIONS, overlayText: 'REDACTED' })
    const re = await PDFDocument.load(await pdf.save())
    expect(analyzePage(re, 0).runs.filter((r) => r.fontName.startsWith('EpdfRdFont')).map((r) => r.text)).toEqual(['REDACTED'])
    const sync = await PDFDocument.load(await doc())
    redactDocument(sync, [area(120, 690, 260, 720)], { ...DEFAULT_OPTIONS, overlayText: 'محجوب' })
    const s = await PDFDocument.load(await sync.save())
    expect(analyzePage(s, 0).runs.filter((r) => r.fontName.startsWith('EpdfRdFont'))).toHaveLength(0)
  })
})
