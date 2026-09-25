import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFStream, PDFString } from 'pdf-lib'
import { describe, expect, it, beforeAll } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { bytesToLatin1 } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import { decodeImage } from '../../src/renderer/src/features/redact/logic/imageRedact'
import { redactDocument, type MarkInput, DEFAULT_OPTIONS, type RedactOptions } from '../../src/renderer/src/features/redact/logic/redact'
import { searchDocument } from '../../src/renderer/src/features/redact/logic/search'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { RASTER, SECRET, createProofPdf, rasterPixels } from '../fixtures/redact.mjs'
import { flattenText, readPdf } from '../support/pdfText'
import { decoded, residue } from '../support/redactProof'

/**
 * THE proof: a document with the secret in every form we handle is redacted; afterwards the secret cannot be
 * extracted by PDF.js, by the text-edit engine, or found in any decompressed stream / object string / raw byte
 * (literal, hex, UTF-16BE or glyph-code spelling), the marked image pixels are black while the rest is unchanged,
 * and everything that was not marked is still there.
 */

const N = (s: string): PDFName => PDFName.of(s)

let proof: Awaited<ReturnType<typeof createProofPdf>>
let out: Uint8Array
let outPdf: PDFDocument
let marks: MarkInput[]
let report: ReturnType<typeof redactDocument>['report']
let secrets: string[]
let marksByPage: Map<number, unknown>

const OPTIONS: RedactOptions = { ...DEFAULT_OPTIONS, overlayText: 'REDACTED' }

beforeAll(async () => {
  proof = await createProofPdf()
  const src = await PDFDocument.load(proof.bytes)
  const hits = await searchDocument(src, { kind: 'literal', query: SECRET, caseSensitive: true, wholeWord: false })
  marks = hits.map((h, i) => ({ id: `s${i}`, pageIndex: h.pageIndex, rects: h.rects, quads: h.quads, text: h.text }))
  const p = proof.positions
  marks.push({ id: 'raw', pageIndex: 0, rects: [{ ...p.rawLeft }] }, { id: 'jpg', pageIndex: 0, rects: [{ ...p.jpegLeft }] }, { id: 'vec', pageIndex: 0, rects: [{ ...p.vectorArea }] })
  const res = redactDocument(src, marks, OPTIONS)
  report = res.report
  secrets = res.secrets
  marksByPage = res.marksByPage
  out = await src.save()
  outPdf = await PDFDocument.load(out)
})


const pageRefs = (pdf: PDFDocument): PDFDict[] => pdf.getPages().map((p) => p.node)

// ---- (1) PDF.js -------------------------------------------------------------------------------------------

describe('the redacted file', () => {
  it('reports what was removed', () => {
    expect(report.textRuns).toBeGreaterThanOrEqual(9)
    expect(report.images).toBe(2)
    expect(report.forms).toBe(2) // the shared form, once per page it is used on
    expect(report.paths + report.pathsClipped).toBeGreaterThanOrEqual(2)
    expect(report.scrub.annotations).toBeGreaterThanOrEqual(2)
    expect(secrets).toContain(SECRET.toLowerCase())
  })

  it('(1) PDF.js cannot extract the secret from any page', async () => {
    const { pages } = await readPdf(out)
    const flat = flattenText(pages)
    expect(flat.replace(/\s+/g, '').toLowerCase()).not.toContain('topsecret')
    expect(flat).not.toContain('4711')
    for (const p of pages) expect(p.text.replace(/\s+/g, '')).not.toContain('TOPSECRET')
  })

  it('(2) the text-edit engine decodes no secret either (all fonts: Helvetica, Noto, subset TrueType, Type0)', () => {
    for (let i = 0; i < outPdf.getPageCount(); i++) {
      const texts = analyzePage(outPdf, i).runs.filter((r) => !r.fontName.startsWith('EpdfRdFont')).map((r) => r.text)
      expect(texts.join('').replace(/\s+/g, '')).not.toContain('TOPSECRET')
      expect(texts.join('')).not.toContain('4711')
    }
  })

  it('(3) no stream, object string or byte of the file holds the secret in any spelling', () => {
    expect(residue(out, outPdf, SECRET)).toEqual([])
    // the same scan finds the secret in the ORIGINAL file (so the scan itself works)
    return PDFDocument.load(proof.bytes).then((orig) => {
      const before = residue(proof.bytes, orig, SECRET)
      expect(before.some((b) => b.includes('literal') || b.includes('joined'))).toBe(true)
      expect(before.some((b) => b.includes('glyph codes'))).toBe(true)
    })
  })

  it('(3b) the independent self-check passes and PDF.js agrees', async () => {
    const findings = await verifyRedaction({
      bytes: out,
      marksByPage: marksByPage as never,
      secrets,
      pdfjsPages: async (b) => (await readPdf(b)).pages.map((p) => p.text)
    })
    expect(findings).toEqual([])
  })

  it('(4) image pixels under the marks are black (raw: exactly), everything else is unchanged', () => {
    const page = outPdf.getPage(0)
    const xo = page.node.Resources()!.lookup(N('XObject')) as PDFDict
    const images: { name: string; img: NonNullable<ReturnType<typeof decodeImage>> }[] = []
    // the page draws two images; find them through the (rewritten) content
    const orig = rasterPixels()
    for (const [k, v] of xo.entries()) {
      const s = xo.lookup(k)
      if (s instanceof PDFStream && s.dict.lookup(N('Subtype')) === N('Image')) {
        const img = decodeImage(outPdf, s)
        if (img) images.push({ name: k.decodeText(), img })
      }
      void v
    }
    expect(images.length).toBeGreaterThanOrEqual(2)
    let checkedRaw = 0
    let checkedJpg = 0
    for (const { name, img } of images) {
      const isJpeg = (() => {
        const s = xo.lookup(N(name)) as PDFStream
        const f = s.dict.lookup(N('Filter'))
        return f instanceof PDFName && f.decodeText() === 'DCTDecode'
      })()
      // image space: 200x40 px over 300x60 pt; the marks cover the left 150 pt = 100 px
      const w = RASTER.width
      let maxInside = 0
      let maxOutsideDiff = 0
      for (let y = 0; y < RASTER.height; y++) {
        for (let x = 0; x < w; x++) {
          for (let c = 0; c < 3; c++) {
            const v = img.data[(y * w + x) * 3 + c]
            if (x < 99) maxInside = Math.max(maxInside, v)
            else if (x > 101) maxOutsideDiff = Math.max(maxOutsideDiff, Math.abs(v - orig[(y * w + x) * 3 + c]))
          }
        }
      }
      if (isJpeg) {
        expect(maxInside).toBeLessThanOrEqual(24)
        expect(maxOutsideDiff).toBeLessThanOrEqual(40) // re-encoded JPEG, original was q90 too
        checkedJpg++
      } else if (img.width === RASTER.width && maxInside === 0) {
        expect(maxOutsideDiff).toBe(0)
        checkedRaw++
      }
    }
    expect(checkedRaw).toBe(1)
    expect(checkedJpg).toBe(1)
  })

  it('(5) unmarked text, links and structure are intact and the pages still render', async () => {
    const { pages } = await readPdf(out)
    const all = flattenText(pages)
    for (const keep of ['Public heading that stays', 'Footer text that stays', 'Second page text that stays', 'Form caption that stays', 'Reference', 'plain Helvetica', 'Embedded font', 'in Noto Sans', 'second line'])
      expect(all).toContain(keep)
    expect(outPdf.getPageCount()).toBe(2)
    expect(pages[0].imageCount).toBeGreaterThanOrEqual(2)
    // the unmarked vector rectangle (blue one at x 480..540 is partly under the mark: its right part remains) and the link
    const annots = outPdf.getPage(0).node.Annots()!
    const subtypes: string[] = []
    let uri = ''
    for (let i = 0; i < annots.size(); i++) {
      const d = annots.lookup(i)
      if (d instanceof PDFDict) {
        subtypes.push((d.lookup(N('Subtype')) as PDFName).decodeText())
        const a = d.lookup(N('A'))
        if (a instanceof PDFDict) uri = (a.lookup(N('URI')) as PDFString).decodeText()
      }
    }
    expect(subtypes).toContain('Link')
    expect(uri).toBe('https://example.com/keep')
    expect(subtypes).not.toContain('Text')
    // the overlay was painted on top of the removed text
    const streams = analyzePage(outPdf, 0)
    expect(streams.runs.some((r) => r.text === 'REDACTED')).toBe(true)
  })

  it('(6) metadata, bookmarks, named destinations, annotations and fields are scrubbed', async () => {
    const info = outPdf.context.lookup(outPdf.context.trailerInfo.Info!) as PDFDict
    const texts: string[] = []
    for (const [, v] of info.entries()) if (v instanceof PDFString || v instanceof PDFHexString) texts.push(v.decodeText())
    expect(texts.join('|')).not.toContain('TOPSECRET')
    expect(outPdf.getTitle()).toContain('Report')
    expect(outPdf.getAuthor()).toBe('Agent Smith')
    // XMP
    const meta = outPdf.catalog.lookup(N('Metadata'))
    expect(meta).toBeInstanceOf(PDFStream)
    expect(bytesToLatin1(decoded(meta as PDFStream)!)).not.toContain('TOPSECRET')
    expect(bytesToLatin1(decoded(meta as PDFStream)!)).toContain('Report')
    // outlines
    const titles: string[] = []
    const first = (outPdf.catalog.lookup(N('Outlines')) as PDFDict).lookup(N('First'))
    for (let it: unknown = first; it instanceof PDFDict; it = it.lookup(N('Next'))) titles.push((it.lookup(N('Title')) as PDFHexString).decodeText())
    expect(titles).toEqual(['Chapter [redacted]', 'Public chapter'])
    // named destinations
    const names = ((outPdf.catalog.lookup(N('Names')) as PDFDict).lookup(N('Dests')) as PDFDict).lookup(N('Names')) as PDFArray
    const keys: string[] = []
    for (let i = 0; i < names.size(); i += 2) keys.push((names.lookup(i) as PDFString).decodeText())
    expect(keys).toEqual(['public-dest'])
    // form fields
    const form = outPdf.getForm()
    expect(form.getTextField('keep.field').getText()).toBe('harmless value')
    expect(form.getTextField('agent.code').getText() ?? '').not.toContain('TOPSECRET')
    // annotations under the mark and elsewhere carrying the text are gone
    expect(pageRefs(outPdf)[0].lookup(N('Annots'))).toBeInstanceOf(PDFArray)
  })

  it('(7) saving again does not bring anything back; nothing unreachable is left in the file', async () => {
    const again = await (await PDFDocument.load(out)).save()
    expect(residue(again, await PDFDocument.load(again), SECRET)).toEqual([])
    const findings = await verifyRedaction({ bytes: again, marksByPage: marksByPage as never, secrets })
    expect(findings).toEqual([])
  })
})
