import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, redactDocument, type MarkInput } from '../../src/renderer/src/features/redact/logic/redact'
import { searchDocument } from '../../src/renderer/src/features/redact/logic/search'
import { countOccurrences, usableSecrets, verifyRedaction, type Finding } from '../../src/renderer/src/features/redact/logic/verify'
import { SECRET, createProofPdf, rasterJpeg, rasterPixels } from '../fixtures/redact.mjs'
import { readPdf } from '../support/pdfText'

/**
 * Mutation tests for the self-check: start from a correctly redacted file, plant the secret back in one specific
 * way, and require the check to notice. A check that cannot fail proves nothing.
 */

const N = (s: string): PDFName => PDFName.of(s)

let out: Uint8Array
let secrets: string[]
let marksByPage: Map<number, { x0: number; y0: number; x1: number; y1: number }[]>
let shapesByPage: Map<number, number[][]>
let positions: Awaited<ReturnType<typeof createProofPdf>>['positions']

beforeAll(async () => {
  const proof = await createProofPdf()
  positions = proof.positions
  const src = await PDFDocument.load(proof.bytes)
  const hits = await searchDocument(src, { kind: 'literal', query: SECRET, caseSensitive: true, wholeWord: false })
  const marks: MarkInput[] = hits.map((h, i) => ({ id: `s${i}`, pageIndex: h.pageIndex, rects: h.rects, quads: h.quads, text: h.text }))
  marks.push({ id: 'raw', pageIndex: 0, rects: [{ ...positions.rawLeft }] }, { id: 'jpg', pageIndex: 0, rects: [{ ...positions.jpegLeft }] }, { id: 'vec', pageIndex: 0, rects: [{ ...positions.vectorArea }] })
  const res = redactDocument(src, marks, DEFAULT_OPTIONS)
  out = await src.save()
  secrets = res.secrets
  marksByPage = res.marksByPage as never
  shapesByPage = res.shapesByPage as never
})

const check = (bytes: Uint8Array, extra: Partial<Parameters<typeof verifyRedaction>[0]> = {}): Promise<Finding[]> => verifyRedaction({ bytes, marksByPage, shapesByPage: shapesByPage as never, secrets, ...extra })

async function mutate(fn: (pdf: PDFDocument) => void | Promise<void>): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(out)
  await fn(pdf)
  return pdf.save()
}

const page1Content = (pdf: PDFDocument, content: string, extraRes?: (res: PDFDict) => void): void => {
  const p = pdf.getPage(0)
  const ref = pdf.context.register(pdf.context.flateStream(content))
  p.node.normalize()
  p.node.addContentStream(ref)
  if (extraRes) extraRes(p.node.Resources()!)
}

const helvetica = (pdf: PDFDocument): PDFRef => pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }))
const addFont = (pdf: PDFDocument, res: PDFDict, name: string, ref: PDFRef): void => {
  let fonts = res.lookup(N('Font'))
  if (!(fonts instanceof PDFDict)) {
    fonts = pdf.context.obj({})
    res.set(N('Font'), fonts)
  }
  ;(fonts as PDFDict).set(N(name), ref)
}

const where = (f: Finding[]): string => f.map((x) => `${x.where}: ${x.detail}`).join(' | ')

describe('the self-check', () => {
  it('passes on a correct redaction (including with PDF.js as the second extractor)', async () => {
    expect(await check(out)).toEqual([])
    expect(await check(out, { pdfjsPages: async (b) => (await readPdf(b)).pages.map((p) => p.text) })).toEqual([])
  })

  it('finds text put back under a mark (glyph geometry)', async () => {
    const bytes = await mutate((pdf) =>
      page1Content(pdf, 'BT /FX 12 Tf 74 702 Td (harmless words) Tj ET', (res) => addFont(pdf, res, 'FX', helvetica(pdf)))
    )
    const f = await check(bytes)
    expect(where(f)).toMatch(/page 1: Text is still present under a redaction mark/)
  })

  it('finds text of the ORIGINAL page content if it is left in the file (restored stream)', async () => {
    const proof = await createProofPdf()
    const orig = await PDFDocument.load(proof.bytes)
    const bytes = await mutate((pdf) => {
      // swap in the original first content stream of page 1
      const c0 = orig.getPage(0).node.Contents() as PDFArray
      const restored = pdf.context.register(pdf.context.flateStream(new TextEncoder().encode('BT /F1 12 Tf 72 700 Td (Reference TOPSECRET-4711 plain Helvetica) Tj ET')))
      void c0
      const p = pdf.getPage(0)
      const arr = p.node.Contents() as PDFArray
      arr.push(restored)
      addFont(pdf, p.node.Resources()!, 'F1', helvetica(pdf))
    })
    const f = await check(bytes)
    expect(f.length).toBeGreaterThan(0)
    expect(where(f)).toMatch(/Text is still present under a redaction mark|content streams/)
  })

  it('finds the secret in metadata streams and document strings', async () => {
    const xmp = await mutate((pdf) => {
      pdf.catalog.set(N('Metadata'), pdf.context.register(pdf.context.flateStream(`<x:xmpmeta><dc:title>${SECRET}</dc:title></x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' })))
    })
    expect(where(await check(xmp))).toMatch(/metadata stream/)
    const info = await mutate((pdf) => pdf.setTitle(`Quarterly ${SECRET} summary`))
    expect(where(await check(info))).toMatch(/document string/)
    const kw = await mutate((pdf) => pdf.setKeywords(['a', SECRET.toLowerCase()]))
    expect(where(await check(kw))).toMatch(/document string/)
  })

  it('finds UTF-16BE and hex spellings in strings', async () => {
    const utf16 = await mutate((pdf) => {
      const bytes = [0xfe, 0xff, ...Array.from(SECRET).flatMap((c) => [0, c.charCodeAt(0)])]
      pdf.catalog.set(N('Lang'), PDFHexString.of(bytes.map((b) => b.toString(16).padStart(2, '0')).join('')))
    })
    expect(where(await check(utf16))).toMatch(/document string/)
  })

  it('finds a leftover object that nothing refers to', async () => {
    const bytes = await mutate((pdf) => {
      pdf.context.register(pdf.context.obj({ Stale: PDFString.of('anything at all') }))
    })
    expect(where(await check(bytes))).toMatch(/nothing refers to are still in the file/)
  })

  it('finds an annotation left under a mark, and one carrying the text elsewhere', async () => {
    const under = await mutate((pdf) => {
      const a = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [positions.vectorArea.x0, positions.vectorArea.y0, positions.vectorArea.x0 + 10, positions.vectorArea.y0 + 10], Contents: PDFString.of('harmless') }))
      const arr = pdf.getPage(0).node.Annots()!
      arr.push(a)
    })
    expect(where(await check(under))).toMatch(/annotation \(Text\) under a redaction mark is still present/)
    const elsewhere = await mutate((pdf) => {
      const a = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 20, 510, 30], Contents: PDFString.of(`see ${SECRET}`) }))
      pdf.getPage(0).node.Annots()!.push(a)
    })
    expect(where(await check(elsewhere))).toMatch(/document string/)
  })

  it('finds image pixels that were not destroyed (lossless and JPEG)', async () => {
    const raw = await mutate((pdf) => {
      const xo = pdf.getPage(0).node.Resources()!.lookup(N('XObject')) as PDFDict
      for (const [k] of xo.entries()) {
        const s = xo.lookup(k)
        if (s && (s as { dict?: PDFDict }).dict && String((s as { dict: PDFDict }).dict.lookup(N('Filter'))) === '/FlateDecode' && String((s as { dict: PDFDict }).dict.lookup(N('Subtype'))) === '/Image') {
          const img = pdf.context.flateStream(rasterPixels(), { Type: 'XObject', Subtype: 'Image', Width: 200, Height: 40, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 })
          xo.set(k, pdf.context.register(img))
        }
      }
    })
    expect(where(await check(raw))).toMatch(/Image pixels under a redaction mark are not black/)
    const jpg = await mutate((pdf) => {
      const xo = pdf.getPage(0).node.Resources()!.lookup(N('XObject')) as PDFDict
      for (const [k] of xo.entries()) {
        const s = xo.lookup(k) as { dict?: PDFDict } | undefined
        if (s?.dict && String(s.dict.lookup(N('Filter'))) === '/DCTDecode') xo.set(k, pdf.context.register(pdf.context.stream(rasterJpeg(), { Type: 'XObject', Subtype: 'Image', Width: 200, Height: 40, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' })))
      }
    })
    expect(where(await check(jpg))).toMatch(/Image pixels under a redaction mark are not black/)
  })

  it('finds an undecodable image left under a mark and an inline image', async () => {
    const jbig = await mutate((pdf) => {
      const xo = pdf.getPage(0).node.Resources()!.lookup(N('XObject')) as PDFDict
      xo.set(N('Bad'), pdf.context.register(pdf.context.stream(new Uint8Array(20), { Type: 'XObject', Subtype: 'Image', Width: 40, Height: 20, ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'JBIG2Decode' })))
      page1Content(pdf, `q 100 0 0 40 ${positions.rawLeft.x0} ${positions.rawLeft.y0} cm /Bad Do Q`)
    })
    expect(where(await check(jbig))).toMatch(/could not be decoded to confirm/)
    const inline = await mutate((pdf) => page1Content(pdf, `q 40 0 0 40 ${positions.rawLeft.x0} ${positions.rawLeft.y0} cm BI /W 2 /H 2 /CS /G /BPC 8 ID ÿÿÿÿ EI Q`))
    expect(where(await check(inline))).toMatch(/inline image under a redaction mark/)
  })

  it('finds the secret in an attachment', async () => {
    const bytes = await mutate(async (pdf) => {
      await pdf.attach(new TextEncoder().encode(`the code is ${SECRET}`), 'notes.txt', { mimeType: 'text/plain' })
    })
    expect(where(await check(bytes))).toMatch(/attachment/)
  })

  it('finds a literal or hex spelling in a form that no page draws (reachable through resources)', async () => {
    const literal = await mutate((pdf) => {
      const form = pdf.context.register(pdf.context.flateStream(`BT /F1 9 Tf 0 0 Td (${SECRET}) Tj ET`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20], Resources: { Font: { F1: helvetica(pdf) } } }))
      ;(pdf.getPage(1).node.Resources()!.lookup(N('XObject')) as PDFDict).set(N('Hidden'), form)
    })
    expect(where(await check(literal))).toMatch(/content streams|file bytes/)
    const hex = await mutate((pdf) => {
      const hexText = Array.from(SECRET, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
      const form = pdf.context.register(pdf.context.flateStream(`BT /F1 9 Tf 0 0 Td <${hexText}> Tj ET`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20], Resources: { Font: { F1: helvetica(pdf) } } }))
      ;(pdf.getPage(1).node.Resources()!.lookup(N('XObject')) as PDFDict).set(N('Hidden'), form)
    })
    expect(where(await check(hex))).toMatch(/content streams/)
    const tj = await mutate((pdf) => {
      const form = pdf.context.register(pdf.context.flateStream(`BT /F1 9 Tf 0 0 Td [(TOPSE) -20 (CRET-) 15 (4711)] TJ ET`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20], Resources: { Font: { F1: helvetica(pdf) } } }))
      ;(pdf.getPage(1).node.Resources()!.lookup(N('XObject')) as PDFDict).set(N('Hidden'), form)
    })
    expect(where(await check(tj))).toMatch(/content streams/)
  })

  it('finds a glyph-code spelling that only a font can decode', async () => {
    const proof = await createProofPdf()
    const bytes = await mutate((pdf) => {
      // reuse the custom subset font of the original document: codes are 1-based positions of the characters
      const src = pdf
      void proof
      // find a font dict whose base name is ABCDEF+Arial (the custom-code subset font)
      let fontRef: PDFRef | undefined
      for (const [ref, obj] of src.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && obj.lookup(N('Type')) === N('Font') && String(obj.lookup(N('BaseFont'))) === '/ABCDEF+Arial') fontRef = ref
      }
      expect(fontRef).toBeDefined()
      const chars = Array.from(new Set(SECRET + ' :()abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.'))
      const codes = Array.from(SECRET, (c) => (chars.indexOf(c) + 1).toString(16).padStart(2, '0')).join('')
      const form = src.context.register(src.context.flateStream(`BT /F2 9 Tf 0 0 Td <${codes}> Tj ET`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20], Resources: { Font: { F2: fontRef! } } }))
      ;(src.getPage(1).node.Resources()!.lookup(N('XObject')) as PDFDict).set(N('Hidden'), form)
    })
    const f = await check(bytes)
    expect(where(f)).toMatch(/content streams/)
  })

  it('does not raise a false alarm for text that legitimately remains outside every mark', async () => {
    const bytes = await mutate((pdf) => {
      const p = pdf.getPage(1)
      const ref = pdf.context.register(pdf.context.flateStream(`BT /FZ 12 Tf 72 300 Td (${SECRET} appears again in an unmarked place) Tj ET`))
      p.node.normalize()
      p.node.addContentStream(ref)
      addFont(pdf, p.node.Resources()!, 'FZ', helvetica(pdf))
    })
    expect(await check(bytes)).toEqual([])
  })

  it('catches what PDF.js sees even if the content engine does not (callback), and reports a failing callback', async () => {
    const f1 = await check(out, { pdfjsPages: async () => ['harmless', `oops ${SECRET.toLowerCase()} here`] })
    expect(where(f1)).toMatch(/can still be extracted by PDF\.js/)
    const f2 = await check(out, { pdfjsPages: async () => Promise.reject(new Error('boom')) })
    expect(where(f2)).toMatch(/PDF\.js could not read the result.*boom/)
  })

  it('reports a file that cannot be read back', async () => {
    const f = await verifyRedaction({ bytes: new Uint8Array([1, 2, 3]), marksByPage, secrets })
    expect(f[0].where).toBe('file')
  })
})

describe('helpers', () => {
  it('counts occurrences ignoring case and whitespace, and keeps only usable secrets', () => {
    expect(countOccurrences('Top  Secret and TOPSECRET and topsecret', 'top secret')).toBe(3)
    expect(countOccurrences('abc', '')).toBe(0)
    expect(usableSecrets(['ab', 'Top  Secret', 'top secret', '  x  ', 'longer one'])).toEqual(['topsecret', 'longerone'])
  })
})
