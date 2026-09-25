import { PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { extractPageText } from '../../src/renderer/src/features/redact/logic/extract'
import { RegexBudgetError } from '../../src/renderer/src/features/redact/logic/safeRegex'
import { compileMatcher, searchDocument, searchModel, type Matcher } from '../../src/renderer/src/features/redact/logic/search'
import { createPatternsPdf, createSharedFormPdf } from '../fixtures/redact.mjs'
import { buildPdf, helvetica, register, stream } from './helpers/pdfBuilder'

const lit = (query: string, o: { caseSensitive?: boolean; wholeWord?: boolean } = {}): Matcher => ({ kind: 'literal', query, caseSensitive: o.caseSensitive ?? false, wholeWord: o.wholeWord ?? false })

async function hitsOf(bytes: Uint8Array, m: Matcher, pages?: number[]) {
  return searchDocument(await PDFDocument.load(bytes), m, { pages })
}

describe('literal search with the real glyph geometry', () => {
  it('case and whole-word options', async () => {
    const { bytes } = await buildPdf([{ content: 'BT /F1 12 Tf 72 700 Td (Secret secretary SECRET secret_word) Tj ET', fonts: { F1: helvetica } }])
    expect((await hitsOf(bytes, lit('secret'))).map((h) => h.text)).toEqual(['Secret', 'secret', 'SECRET', 'secret'])
    expect((await hitsOf(bytes, lit('secret', { caseSensitive: true }))).map((h) => h.text)).toEqual(['secret', 'secret'])
    expect((await hitsOf(bytes, lit('secret', { wholeWord: true }))).map((h) => h.text)).toEqual(['Secret', 'SECRET'])
    expect((await hitsOf(bytes, lit('SECRET', { wholeWord: true, caseSensitive: true }))).map((h) => h.text)).toEqual(['SECRET'])
  })

  it('a match that spans several runs on one line is one hit with one box; whitespace in the query matches any whitespace', async () => {
    const { bytes } = await buildPdf([{ content: 'BT /F1 12 Tf 72 700 Td (SEC) Tj (RET) Tj 20 0 Td (two) Tj (words) Tj ET', fonts: { F1: helvetica } }])
    const h = await hitsOf(bytes, lit('SECRET'))
    expect(h).toHaveLength(1)
    expect(h[0].rects).toHaveLength(1)
    const w = await hitsOf(bytes, lit('two   words'))
    expect(w.length + (await hitsOf(bytes, lit('twowords'))).length).toBeGreaterThan(0)
  })

  it('a token split by a line break is found (the two lines each get a box)', async () => {
    const { bytes } = await buildPdf([{ content: 'BT /F1 12 Tf 72 700 Td (broken TOPSEC-) Tj 0 -14 Td (RET4711 next) Tj ET', fonts: { F1: helvetica } }])
    const h = await hitsOf(bytes, lit('TOPSEC-RET4711'))
    expect(h).toHaveLength(1)
    expect(h[0].rects).toHaveLength(2)
    expect(h[0].text).toBe('TOPSEC- RET4711')
    // the boxes lie on their own lines
    expect(h[0].rects[0].y0).toBeGreaterThan(h[0].rects[1].y1 - 1)
  })

  it('invisible OCR text is searched and flagged; the same text visible is not flagged', async () => {
    const { bytes } = await buildPdf([{ content: 'BT 3 Tr /F1 12 Tf 72 700 Td (needle hidden) Tj ET BT 0 Tr /F1 12 Tf 72 600 Td (needle visible) Tj ET', fonts: { F1: helvetica } }])
    const h = await hitsOf(bytes, lit('needle'))
    expect(h.map((x) => x.hiddenOnly)).toEqual([true, false])
  })

  it('text in a form drawn twice is found at both places, on the right pages', async () => {
    const bytes = await createSharedFormPdf()
    const h = await hitsOf(bytes, lit('SECRETFORM'))
    expect(h.map((x) => x.pageIndex)).toEqual([0, 1, 2])
    const ys = h.map((x) => x.rects[0].y0)
    expect(new Set(ys).size).toBe(3) // three different positions
    expect(await hitsOf(bytes, lit('SECRETFORM'), [1])).toHaveLength(1)
  })

  it('finds text inside a form with a Matrix, drawn scaled, with boxes in page space', async () => {
    const { doc } = await buildPdf([{ content: 'q 2 0 0 2 100 100 cm /Fm1 Do Q', fonts: {} }])
    const form = stream(doc, 'BT /F1 10 Tf 5 5 Td (scaled SECRET) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 30], Matrix: [1, 0, 0, 1, 10, 0], Resources: { Font: { F1: register(doc, helvetica) } } })
    doc.getPage(0).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Fm1: form }))
    const h = await hitsOf(await doc.save(), lit('SECRET'))
    expect(h).toHaveLength(1)
    // text origin: 100 + 2*(10+5) = 130, 100 + 2*5 = 110; font size 10 * 2 = 20; "scaled " is about 7 characters wide
    expect(h[0].rects[0].x0).toBeGreaterThan(130 + 2 * 20)
    expect(h[0].rects[0].y0).toBeGreaterThan(100)
    expect(h[0].rects[0].y0).toBeLessThan(112)
    expect(h[0].rects[0].y1).toBeGreaterThan(122)
    expect(h[0].rects[0].y1).toBeLessThan(135)
  })
})
describe('patterns and custom regular expressions over a document', () => {
  it('presets find their matches and skip look-alikes', async () => {
    const bytes = await createPatternsPdf()
    const expectations: [string, string[]][] = [
      ['email', ['jane.doe@example.com', 'sales@shop.example.org', 'bob@example.net']],
      ['phone', ['(555) 123-4567', '+44 20 7946 0958']],
      ['card', ['4111 1111 1111 1111']],
      ['ssn', ['123-45-6789']],
      ['iban', ['DE89 3704 0044 0532 0130 00']],
      ['date', ['2024-03-15', 'March 15, 2024']],
      ['url', ['https://example.com/path?q=1']],
      ['ip', ['192.168.0.1']]
    ]
    for (const [id, want] of expectations) expect((await hitsOf(bytes, { kind: 'preset', id })).map((h) => h.text), id).toEqual(want)
  })

  it('a custom regular expression, with its budget: a catastrophic one is stopped with a clear error', async () => {
    const bytes = await createPatternsPdf()
    expect((await hitsOf(bytes, { kind: 'regex', source: '\\b\\d{3}-\\d{2}-\\d{4}\\b', caseSensitive: false })).map((h) => h.text)).toEqual(['123-45-6789', '000-12-3456'])
    await expect(hitsOf(bytes, { kind: 'regex', source: '(a+)+$', caseSensitive: true })).rejects.toBeInstanceOf(RegexBudgetError)
  })

  it('invalid input is reported, not thrown deep inside', () => {
    expect(() => compileMatcher(lit('   '))).toThrow(/Type the text/)
    expect(() => compileMatcher({ kind: 'preset', id: 'nope' })).toThrow(/Unknown pattern/)
    expect(() => compileMatcher({ kind: 'regex', source: 'a(', caseSensitive: false })).toThrow()
  })
})

describe('text model', () => {
  it('separates lines and words by position, in stream order', async () => {
    const { bytes } = await buildPdf([{ content: 'BT /F1 12 Tf 72 700 Td (first) Tj 60 0 Td (second) Tj -60 -20 Td (third line) Tj ET', fonts: { F1: helvetica } }])
    const m = extractPageText(await PDFDocument.load(bytes), 0)
    expect(m.text).toBe('first second\nthird line')
    expect(m.rects.filter((r) => r === null).length).toBe(2) // the inserted space and newline have no box
    expect(searchModel(m, compileMatcher(lit('second')))[0].rects).toHaveLength(1)
  })
})
