import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { extractPageText, rectsForRange } from '../../src/renderer/src/features/redact/logic/extract'
import { redactDocument, type MarkInput, DEFAULT_OPTIONS } from '../../src/renderer/src/features/redact/logic/redact'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { buildPdf, helvetica, subsetSimpleFont } from './helpers/pdfBuilder'

/** A mark over the first occurrence of `needle` on the page. */
async function markOf(bytes: Uint8Array, needle: string, pageIndex = 0): Promise<MarkInput> {
  const pdf = await PDFDocument.load(bytes)
  const model = extractPageText(pdf, pageIndex)
  const at = model.text.indexOf(needle)
  if (at < 0) throw new Error(`"${needle}" not found in "${model.text}"`)
  return { id: 'm1', pageIndex, rects: rectsForRange(model, at, at + needle.length), text: needle }
}

async function redact(bytes: Uint8Array, marks: MarkInput[], opts = DEFAULT_OPTIONS): Promise<{ out: Uint8Array; secrets: string[]; pdf: PDFDocument }> {
  const pdf = await PDFDocument.load(bytes)
  const res = redactDocument(pdf, marks, opts)
  const out = await pdf.save()
  const findings = await verifyRedaction({ bytes: out, marksByPage: res.marksByPage, secrets: res.secrets })
  expect(findings).toEqual([])
  return { out, secrets: res.secrets, pdf }
}

const textOf = async (bytes: Uint8Array, i = 0): Promise<string> => {
  const pdf = await PDFDocument.load(bytes)
  return analyzePage(pdf, i)
    .runs.filter((r) => !r.fontName.startsWith('EpdfRdFont'))
    .map((r) => r.text)
    .join('|')
}

describe('text removal', () => {
  it('cuts the marked word out of a Tj and keeps the neighbours in place', async () => {
    const src = await (async () => {
      const doc = await PDFDocument.create()
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const page = doc.addPage([612, 792])
      page.drawText('Hello SECRETWORD world', { x: 72, y: 700, size: 14, font })
      page.drawText('Untouched line', { x: 72, y: 600, size: 14, font })
      return doc.save()
    })()
    const before = analyzePage(await PDFDocument.load(src), 0).runs[0]
    const worldX0 = before.matrix[4] + before.glyphs[before.text.indexOf('world')].x0
    const { out } = await redact(src, [await markOf(src, 'SECRETWORD')])
    const after = analyzePage(await PDFDocument.load(out), 0).runs.filter((r) => !r.fontName.startsWith('EpdfRdFont'))
    expect(after.map((r) => r.text).join('|')).toBe('Hello  world|Untouched line')
    // "world" is still exactly where it was
    const run = after[0]
    const at = run.text.indexOf('world')
    expect(run.matrix[4] + run.glyphs[at].x0).toBeCloseTo(worldX0, 3)
    expect(new TextDecoder('latin1').decode(out)).not.toContain('SECRETWORD')
  })

  it('handles TJ arrays with kerning and several strings', async () => {
    const { bytes } = await buildPdf([
      { content: 'BT /F1 12 Tf 72 700 Td [(The TOP) -40 (SEC) 30 (RET) -100 ( is out)] TJ ET', fonts: { F1: helvetica } }
    ])
    const { out } = await redact(bytes, [await markOf(bytes, 'TOPSECRET')])
    expect(await textOf(out)).toBe('The  is out')
  })

  it("removes ' and \" operators without breaking the line structure", async () => {
    const { bytes } = await buildPdf([
      { content: 'BT /F1 12 Tf 14 TL 72 700 Td (first line) Tj (second SECRET line) \' 3 1 (third) " ET', fonts: { F1: helvetica } }
    ])
    const { out } = await redact(bytes, [await markOf(bytes, 'SECRET')])
    expect(await textOf(out)).toBe('first line|second  line|third')
  })

  it('subset font with ToUnicode: removes only the covered codes', async () => {
    const { doc, bytes } = await buildPdf([{ content: 'BT /F1 12 Tf 72 700 Td (ABCDEF) Tj ET', fonts: {} }])
    const f = subsetSimpleFont(doc, { codes: { 65: 'A', 66: 'B', 67: 'C', 68: 'D', 69: 'E', 70: 'F' } })
    doc.getPage(0).node.Resources()!.set(doc.context.obj('Font') as never, doc.context.obj({ F1: f }))
    const src = await doc.save()
    void bytes
    const { out } = await redact(src, [await markOf(src, 'CD')])
    expect(await textOf(out)).toBe('AB EF'.replace(' ', ''))
  })

  it('reports what it removed', async () => {
    const { bytes } = await buildPdf([{ content: 'BT /F1 12 Tf 72 700 Td (say SECRET now) Tj ET', fonts: { F1: helvetica } }])
    const pdf = await PDFDocument.load(bytes)
    const res = redactDocument(pdf, [await markOf(bytes, 'SECRET')], DEFAULT_OPTIONS)
    expect(res.report.textRuns).toBe(1)
    expect(res.report.glyphs).toBe(6)
    expect(res.secrets).toContain('secret') // scanning strings are squeezed and lower-cased
  })
})
