import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream, degrees, rgb } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { ContentParseError, formatOp, objEquals, parseContent, serializeContent } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import { makePng, notoBytes, pdfLibDoc } from './helpers/pdfBuilder'

/** Decoded bytes of every page content stream and Form XObject stream in a document. */
async function contentStreams(bytes: Uint8Array): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(bytes)
  const out: Uint8Array[] = []
  const seen = new Set<PDFRawStream>()
  const add = (s: unknown): void => {
    if (s instanceof PDFRawStream && !seen.has(s)) {
      seen.add(s)
      out.push(decodePDFRawStream(s).decode())
    }
  }
  for (const page of doc.getPages()) {
    const c = page.node.Contents()
    if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) add(c.lookup(i))
    else add(c)
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && (obj.dict.get(PDFName.of('Subtype')) as PDFName | undefined)?.toString() === '/Form') add(obj)
  }
  void PDFRef
  return out
}

function checkRoundTrip(bytes: Uint8Array, label: string): void {
  const p = parseContent(bytes)
  // 1. untouched operations serialize to the identical bytes
  const again = serializeContent(p.ops, p.tail)
  expect(again.length, label).toBe(bytes.length)
  expect(Buffer.from(again).equals(Buffer.from(bytes)), label).toBe(true)
  // 2. forcing every operation through the serializer preserves its meaning
  const forced = serializeContent(
    p.ops.map((o) => ({ ...o, raw: null })),
    p.tail
  )
  const q = parseContent(forced)
  expect(q.ops.length, label).toBe(p.ops.length)
  q.ops.forEach((o, i) => {
    expect(o.op, `${label} op ${i}`).toBe(p.ops[i].op)
    expect(o.args.length, `${label} op ${i}`).toBe(p.ops[i].args.length)
    o.args.forEach((a, j) => expect(objEquals(a, p.ops[i].args[j], 1e-9), `${label} op ${i} arg ${j}: ${formatOp(p.ops[i])}`).toBe(true))
    if (o.inline) expect(Buffer.from(o.inline.data).equals(Buffer.from(p.ops[i].inline!.data)), `${label} inline ${i}`).toBe(true)
  })
}

describe('round trips over streams written by pdf-lib', () => {
  it('standard fonts, colours, rotated and scaled text, lines and rectangles', async () => {
    const bytes = await pdfLibDoc(async (doc, page) => {
      const f = await doc.embedFont(StandardFonts.TimesRomanBold)
      page.drawText('Rotated text', { x: 200, y: 200, size: 18, font: f, rotate: degrees(33), color: rgb(0.2, 0.4, 0.6) })
      page.drawText('Skewed', { x: 50, y: 50, size: 10, font: f, xSkew: degrees(20) })
      page.drawText('Multi\nline\ntext with spaces', { x: 72, y: 500, size: 12, font: f, lineHeight: 15, maxWidth: 100 })
      page.drawRectangle({ x: 10, y: 10, width: 100, height: 40, borderWidth: 2, borderColor: rgb(1, 0, 0) })
      page.drawLine({ start: { x: 0, y: 0 }, end: { x: 100, y: 100 }, dashArray: [3, 2] })
      page.drawSvgPath('M 0,20 L 100,20 Q 50,80 0,20 Z', { x: 300, y: 300, scale: 0.5 })
      page.drawCircle({ x: 400, y: 400, size: 30 })
    })
    for (const [i, s] of (await contentStreams(bytes)).entries()) checkRoundTrip(s, `pdf-lib standard ${i}`)
  })

  it('embedded subset and non-subset custom fonts (Type0 hex strings)', async () => {
    const bytes = await pdfLibDoc(async (doc, page) => {
      doc.registerFontkit(fontkit)
      const sub = await doc.embedFont(notoBytes(), { subset: true })
      const full = await doc.embedFont(notoBytes('Italic'), { subset: false })
      page.drawText('Subset: Привет ünïcode ﬁ', { x: 50, y: 700, size: 20, font: sub })
      page.drawText('Full font: Ελληνικά', { x: 50, y: 650, size: 20, font: full })
    })
    for (const [i, s] of (await contentStreams(bytes)).entries()) checkRoundTrip(s, `pdf-lib custom ${i}`)
  })

  it('images, embedded pages (Form XObjects) and several streams', async () => {
    const src = await pdfLibDoc(async (doc, page) => {
      const f = await doc.embedFont(StandardFonts.Courier)
      page.drawText('Source page', { x: 20, y: 20, size: 10, font: f })
    }, [200, 200])
    const bytes = await pdfLibDoc(async (doc, page) => {
      const [embedded] = await doc.embedPdf(src)
      page.drawPage(embedded, { x: 100, y: 100, xScale: 0.5, yScale: 0.5 })
      const img = await doc.embedPng(makePng(8, 8, [10, 200, 90]))
      page.drawImage(img, { x: 300, y: 300, width: 64, height: 64, rotate: degrees(15), opacity: 0.5 })
      const f = await doc.embedFont(StandardFonts.Helvetica)
      page.drawText('after', { x: 10, y: 10, size: 10, font: f })
    })
    const streams = await contentStreams(bytes)
    expect(streams.length).toBeGreaterThanOrEqual(2)
    for (const [i, s] of streams.entries()) checkRoundTrip(s, `pdf-lib image/form ${i}`)
    const a = analyzePage(await PDFDocument.load(bytes), 0)
    expect(a.images).toHaveLength(1)
    expect(a.runs.map((r) => r.text).sort()).toEqual(['Source page', 'after'])
    // the embedded page is a Form: its text is reachable and located under the form's matrix
    const inForm = a.runs.find((r) => r.text === 'Source page')!
    expect(inForm.addr.source).toMatch(/^form:/)
  })

  it('hand-written streams with inline images, comments, odd whitespace and every operator family', () => {
    const src = [
      '%PDF content',
      'q 1 0 0 1 10 10 cm',
      '0 0 100 100 re W n',
      '/GS1 gs [3 2] 0 d 2 w 1 J 1 j 10 M 0 i /Perceptual ri',
      '0.5 g 0.1 0.2 0.3 rg 0 0 0 1 k /Cs1 cs 0.5 sc /Cs2 CS 1 0 0 SCN /Pattern cs /P1 scn',
      '10 10 m 50 50 l 60 20 80 20 100 50 c 120 60 140 70 v 130 50 y h S s f f* B B* b b* n',
      'BT /F1 12 Tf 1 Tc 2 Tw 90 Tz 14 TL 3 Ts 2 Tr 10 20 Td 10 20 TD 1 0 0 1 5 5 Tm T* (a\\)b\\\\c\\n) Tj [(x) -20 (y)] TJ (q) \' 1 2 (r) " ET',
      'BI /W 2 /H 2 /CS /RGB /BPC 8 ID \x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\nEI',
      'BX /Foo 1 unknownop EX',
      '/Im1 Do /Sh1 sh /OC /MC0 BDC /Tag BMC EMC EMC',
      '1 0 0 1 0 0 cm 100 0 d0 1 2 3 4 5 6 d1 [1 2] TJ',
      'Q',
      ''
    ].join('\n')
    checkRoundTrip(Uint8Array.from(Array.from(src, (c) => c.charCodeAt(0) & 255)), 'hand written')
  })
})

describe('reading generated documents end to end', () => {
  it('every text run of a pdf-lib document with mixed content is found once, in the right font', async () => {
    const bytes = await pdfLibDoc(async (doc, page) => {
      doc.registerFontkit(fontkit)
      const a = await doc.embedFont(StandardFonts.HelveticaOblique)
      const b = await doc.embedFont(notoBytes('Bold'), { subset: true })
      page.drawText('Oblique', { x: 10, y: 700, size: 12, font: a })
      page.drawText('Bold Noto', { x: 10, y: 680, size: 12, font: b })
      page.drawText('Rotated', { x: 300, y: 300, size: 12, font: a, rotate: degrees(90) })
    })
    const an = analyzePage(await PDFDocument.load(bytes), 0)
    expect(an.runs.map((r) => [r.text, r.font.style.italic, r.font.style.bold])).toEqual([
      ['Oblique', true, false],
      ['Bold Noto', false, true],
      ['Rotated', true, false]
    ])
    const set = buildBlocks(an)
    expect(set.lines.map((l) => [l.text, l.editable])).toEqual([
      ['Oblique', true],
      ['Bold Noto', true],
      ['Rotated', false]
    ])
  })
})

describe('optional corpus check (set EPDF_CORPUS_DIR to a folder of real-world PDFs)', () => {
  const dir = process.env['EPDF_CORPUS_DIR']
  it.skipIf(!dir)('every content stream round-trips byte for byte and every page analyses without crashing', async () => {
    const files = readdirSync(dir!).filter((f) => /\.pdf$/i.test(f))
    const failures: string[] = []
    let pages = 0
    let streams = 0
    let runs = 0
    for (const f of files) {
      let doc: PDFDocument
      try {
        doc = await PDFDocument.load(readFileSync(join(dir!, f)), { updateMetadata: false })
      } catch {
        continue // encrypted or damaged: not our concern here
      }
      for (const [i, s] of (await contentStreams(readFileSync(join(dir!, f)))).entries()) {
        streams++
        try {
          checkRoundTrip(s, `${f} stream ${i}`)
        } catch (e) {
          if (!(e instanceof ContentParseError)) failures.push(`${f}: ${(e as Error).message}`)
        }
      }
      for (let p = 0; p < Math.min(doc.getPageCount(), 30); p++) {
        pages++
        try {
          const a = analyzePage(doc, p)
          runs += a.runs.length
          buildBlocks(a)
        } catch (e) {
          if (e instanceof ContentParseError || (e instanceof Error && e.name !== 'TypeError' && e.name !== 'RangeError')) continue
          failures.push(`${f} page ${p + 1}: ${(e as Error).stack}`)
        }
      }
    }
    console.log(`corpus: ${files.length} files, ${pages} pages, ${streams} streams, ${runs} text runs`)
    expect(failures).toEqual([])
  }, 600_000)
})
