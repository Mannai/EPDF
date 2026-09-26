import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, StandardFonts, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { defaultBackground, defaultBates, defaultHeaderFooter, defaultWatermark, type HeaderFooterSettings, type OverlaySettings } from '../../src/shared/features/headerfooter'
import { makeTextXObject } from '../../src/shared/text/pdf/draw'
import { applyHeaderFooter, applyOverlay } from '../../src/renderer/src/features/headerfooter/pdf/apply'
import { cutMarks, removeMarks, summarizeMarks } from '../../src/renderer/src/features/headerfooter/pdf/remove'
import { applyGroup, removeGroup } from '../../src/renderer/src/features/headerfooter/pdf/ops'
import { parseContent, serializeContent } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import { actualTexts, contentOf, fontDicts, fontParts, shownCodes } from '../support/pdfContent'
import { ocVisibility, seePages } from './helpers/hfPdfjs'
import { setupText } from './helpers/text'

/**
 * Marking, finding, updating and removing: what is written (artifact tags, PieceInfo, optional content), that it is
 * found again in saved-and-reopened files, and that removal leaves nothing behind (text, objects, fonts).
 */
setupText()

const N = (s: string): PDFName => PDFName.of(s)
const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1')
const reload = (b: Uint8Array): Promise<PDFDocument> => PDFDocument.load(b, { updateMetadata: false })

async function bodyDoc(n = 3, size: [number, number] = [612, 792]): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= n; i++) {
    const p = pdf.addPage(size)
    p.drawText(`Body text of page ${i}`, { x: 72, y: 400, size: 14, font })
  }
  return pdf
}

function hf(slots: Partial<HeaderFooterSettings['slots']>, over: Partial<HeaderFooterSettings> = {}): HeaderFooterSettings {
  const s = defaultHeaderFooter()
  s.slots = { topLeft: '', topCenter: '', topRight: '', bottomLeft: '', bottomCenter: '', bottomRight: '', ...slots }
  return { ...s, ...over }
}

function textWm(text: string, over: Partial<OverlaySettings> = {}): OverlaySettings {
  const w = defaultWatermark()
  if (w.source.kind === 'text') w.source.text = text
  return { ...w, ...over }
}

const xobjects = (pdf: PDFDocument, i: number): PDFDict => pdf.getPage(i).node.Resources()!.lookup(N('XObject'), PDFDict)
const streamText = (s: PDFStream): string => latin1(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : (s as unknown as { getContents(): Uint8Array }).getContents())

/** The mark form and the text form(s) inside it, on page i. */
function markForms(pdf: PDFDocument, i: number): { name: string; form: PDFStream; inner: PDFStream[] }[] {
  const out: { name: string; form: PDFStream; inner: PDFStream[] }[] = []
  for (const [k, v] of xobjects(pdf, i).entries()) {
    const form = pdf.context.lookup(v)
    if (!(form instanceof PDFStream) || !form.dict.lookup(N('PieceInfo'))) continue
    const res = form.dict.lookup(N('Resources'), PDFDict)
    const x = res.lookup(N('XObject'))
    const inner: PDFStream[] = []
    if (x instanceof PDFDict) for (const [, r] of x.entries()) inner.push(pdf.context.lookup(r) as PDFStream)
    out.push({ name: k.decodeText(), form, inner })
  }
  return out
}

describe('what a header/footer writes', () => {
  it('artifact marked content, PieceInfo (Acrobat + Epdf), settings, one form per band', async () => {
    const pdf = await bodyDoc(3)
    await applyHeaderFooter(pdf, 'headerfooter', hf({ topCenter: 'Report', bottomRight: 'Page {page} of {pages}' }), { fileName: 'r.pdf' })
    const doc = await reload(await pdf.save())
    const content = contentOf(doc, doc.getPage(1))
    expect(content).toContain('/Artifact << /Type /Pagination /Subtype /Header /EpdfMark /HeaderFooter >> BDC')
    expect(content).toContain('/Artifact << /Type /Pagination /Subtype /Footer /EpdfMark /HeaderFooter >> BDC')
    const forms = markForms(doc, 1)
    expect(forms.length).toBe(2)
    for (const f of forms) {
      const pi = f.form.dict.lookup(N('PieceInfo'), PDFDict)
      const adobe = pi.lookup(N('ADBE_CompoundType'), PDFDict)
      expect(['/Header', '/Footer']).toContain(adobe.get(N('Private'))!.toString())
      expect(adobe.get(N('LastModified'))).toBeTruthy()
      const ours = pi.lookup(N('EpdfPageMarks'), PDFDict).lookup(N('Private'), PDFDict)
      expect(ours.get(N('Group'))!.toString()).toBe('/HeaderFooter')
      expect(ours.get(N('Settings'))).toBeInstanceOf(PDFRef)
      expect(f.form.dict.get(N('BBox'))!.toString()).toBe('[ 0 0 612 792 ]')
    }
    // the original content is untouched and wrapped: q, original, Q, then the marks
    const refs = doc.getPage(1).node.Contents() as PDFArray
    expect(refs.size()).toBe(5)
    const summary = summarizeMarks(doc)
    expect(summary.headerfooter.pages).toBe(3)
    expect(summary.headerfooter.settings?.group).toBe('headerfooter')
    expect(summary.headerfooter.settings && 'slots' in summary.headerfooter.settings.settings && summary.headerfooter.settings.settings.slots.bottomRight).toBe('Page {page} of {pages}')
    const seen = await seePages(await doc.save())
    expect(seen.map((p) => p.items.filter((t) => /Page \d of 3|Report/.test(t.str)).map((t) => t.str))).toEqual([
      ['Report', 'Page 1 of 3'],
      ['Report', 'Page 2 of 3'],
      ['Report', 'Page 3 of 3']
    ])
  })

  it('fonts are embedded once per document (subset), not once per page', async () => {
    const pdf = await bodyDoc(60)
    await applyHeaderFooter(pdf, 'headerfooter', hf({ topRight: 'تقرير سري {page}', bottomCenter: 'Page {page} of {pages}' }), { fileName: 'r.pdf' })
    const doc = await reload(await pdf.save())
    const type0 = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.get(N('Subtype')) === N('Type0'))
    expect(type0.length).toBeGreaterThanOrEqual(1)
    expect(type0.length).toBeLessThanOrEqual(3) // Latin font + Arabic fallback (+ digits), never 60+
  })
})

describe('Arabic headers: shaping, order and extraction', () => {
  it('"صفحة ١ من ٣" is drawn exactly as the text engine draws it, in right-to-left visual order, and extracts logically', async () => {
    const pdf = await bodyDoc(3)
    const s = hf({ topCenter: 'صفحة {page} من {pages}' }, { numberStyle: 'arabic-indic', font: { family: 'Noto Naskh Arabic', size: 18, color: '#000000', bold: false, italic: false } })
    await applyHeaderFooter(pdf, 'headerfooter', s, { fileName: 'r.pdf' })
    const doc = await reload(await pdf.save())
    const text = markForms(doc, 0)[0]!.inner[0]!
    // the glyph codes equal the text engine's own rendering of the same string in the same font
    const ref = await PDFDocument.create()
    ref.addPage()
    const xo = await makeTextXObject(ref, 'صفحة ١ من ٣', { size: 18, fontStack: ['Noto Naskh Arabic'], align: 'center' })
    const refDoc = await reload(await ref.save())
    const refContent = streamText(refDoc.context.lookup(xo.ref) as PDFStream)
    expect(shownCodes(streamText(text))).toEqual(shownCodes(refContent))
    // visual order (left to right) is "٣ من ١ صفحة": digits and words in right-to-left reading order
    const fonts = fontDicts(doc, text.dict.lookup(N('Resources'), PDFDict))
    const maps = [...fonts.values()].map((f) => fontParts(doc, f).toUnicode)
    const visual = shownCodes(streamText(text)).map((c) => maps.map((m) => m.get(c)).find((x) => x !== undefined) ?? '?').join('')
    expect(Array.from(visual).reverse().join('')).toBe('صفحة ١ من ٣')
    // readers that honour ActualText get the logical string; PDF.js returns it too
    expect(actualTexts(streamText(text))).toEqual(['صفحة ١ من ٣'])
    const seen = await seePages(await doc.save())
    expect(seen.map((p) => p.items.find((t) => /[؀-ۿ]/.test(t.str))?.str)).toEqual(['صفحة ١ من ٣', 'صفحة ٢ من ٣', 'صفحة ٣ من ٣'])
  })

  it('RTL direction option puts mixed text in right-to-left order; LTR keeps it left-to-right', async () => {
    const draw = async (direction: 'rtl' | 'ltr'): Promise<string> => {
      const pdf = await bodyDoc(1)
      await applyHeaderFooter(pdf, 'headerfooter', hf({ topCenter: 'Page {page} صفحة' }, { direction, font: { family: 'Noto Sans', size: 14, color: '#000000', bold: false, italic: false } }), { fileName: 'r.pdf' })
      const doc = await reload(await pdf.save())
      const text = markForms(doc, 0)[0]!.inner[0]!
      const maps = [...fontDicts(doc, text.dict.lookup(N('Resources'), PDFDict)).values()].map((f) => fontParts(doc, f).toUnicode)
      return shownCodes(streamText(text)).map((c) => maps.map((m) => m.get(c)).find((x) => x !== undefined) ?? '?').join('')
    }
    // visual strings, left to right
    expect((await draw('ltr')).replace(/\s+/g, ' ').trim()).toBe('Page 1 ةحفص')
    expect((await draw('rtl')).replace(/\s+/g, ' ').trim()).toBe('ةحفص Page 1')
  })

  it('Hebrew and mixed Hebrew/English footers', async () => {
    const pdf = await bodyDoc(2)
    await applyHeaderFooter(pdf, 'headerfooter', hf({ bottomLeft: 'עמוד {page} מתוך {pages}', bottomRight: 'Version 2 גרסה' }), { fileName: 'r.pdf' })
    const seen = await seePages(await pdf.save())
    expect(seen[1]!.items.some((t) => t.str === 'עמוד 2 מתוך 2')).toBe(true)
    expect(seen[1]!.text).toContain('גרסה')
  })
})

describe('Bates numbering', () => {
  it('stamps consecutive numbers on the selected pages only', async () => {
    const pdf = await bodyDoc(5)
    const b = defaultBates()
    b.bates = { prefix: 'ACME-', suffix: '', digits: 6, start: 41 }
    b.pages = { range: '2-5', subset: 'all' }
    await applyHeaderFooter(pdf, 'bates', b, { fileName: 'r.pdf' })
    const seen = await seePages(await pdf.save())
    expect(seen.map((p) => p.items.find((t) => t.str.startsWith('ACME'))?.str ?? null)).toEqual([null, 'ACME-000041', 'ACME-000042', 'ACME-000043', 'ACME-000044'])
    // bottom-right, upright
    const it0 = seen[1]!.items.find((t) => t.str.startsWith('ACME'))!
    expect(it0.x + it0.width).toBeCloseTo(612 - 36, 0)
    expect(summarizeMarks(pdf).bates.pages).toBe(4)
    expect(summarizeMarks(pdf).headerfooter.pages).toBe(0)
  })
})

describe('watermarks and backgrounds', () => {
  it('behind / front ordering: background first, behind-watermark next, original content, front marks last', async () => {
    const pdf = await bodyDoc(1)
    await applyOverlay(pdf, 'watermark', textWm('FRONT', { layer: 'front' }), undefined, { fileName: 'x' })
    await applyOverlay(pdf, 'background', defaultBackground(), undefined, { fileName: 'x' })
    await applyOverlay(pdf, 'watermark', textWm('BEHIND', { layer: 'behind' }), undefined, { fileName: 'x' })
    await applyHeaderFooter(pdf, 'headerfooter', hf({ topCenter: 'HEAD' }), { fileName: 'x' })
    const doc = await reload(await pdf.save())
    const arr = doc.getPage(0).node.Contents() as PDFArray
    const kinds: string[] = []
    for (let i = 0; i < arr.size(); i++) {
      const s = doc.context.lookup(arr.get(i)) as PDFStream
      kinds.push(s.dict.get(N('EpdfMark'))?.toString() ?? 'original')
    }
    expect(kinds).toEqual(['/Background', '/Watermark', '/WrapOpen', 'original', '/WrapClose', '/Watermark', '/HeaderFooter'])
    const all = contentOf(doc, doc.getPage(0))
    expect(all).toContain('/Artifact << /Type /Background /BBox [0 0 612 792] /EpdfMark /Background >> BDC')
    expect(all).toContain('/Artifact << /Type /Pagination /Subtype /Watermark /EpdfMark /Watermark >> BDC')
  })

  it('opacity is applied to the mark as one isolated transparency group', async () => {
    const pdf = await bodyDoc(1)
    await applyOverlay(pdf, 'watermark', textWm('HALF', { opacity: 0.5 }), undefined, { fileName: 'x' })
    const doc = await reload(await pdf.save())
    const f = markForms(doc, 0)[0]!
    expect(streamText(f.form)).toContain('/GS0 gs')
    const gs = f.form.dict.lookup(N('Resources'), PDFDict).lookup(N('ExtGState'), PDFDict).lookup(N('GS0'), PDFDict)
    expect(gs.get(N('ca'))!.toString()).toBe('0.5')
    const group = f.inner[0]!.dict.lookup(N('Group'), PDFDict)
    expect(group.get(N('S'))!.toString()).toBe('/Transparency')
    expect(group.get(N('I'))!.toString()).toBe('true')
  })

  it('show on screen / when printing: optional content that PDF.js honours per intent', async () => {
    const mk = async (print: boolean, screen: boolean): Promise<Uint8Array> => {
      const pdf = await bodyDoc(1)
      await applyOverlay(pdf, 'watermark', textWm('OC', { print, screen }), undefined, { fileName: 'x' })
      return pdf.save()
    }
    const printOnly = await mk(true, false)
    expect(await ocVisibility(printOnly, 'display')).toEqual([{ name: 'Watermark', visible: false }])
    expect(await ocVisibility(printOnly, 'print')).toEqual([{ name: 'Watermark', visible: true }])
    const screenOnly = await mk(false, true)
    expect(await ocVisibility(screenOnly, 'display')).toEqual([{ name: 'Watermark', visible: true }])
    expect(await ocVisibility(screenOnly, 'print')).toEqual([{ name: 'Watermark', visible: false }])
    const doc = await reload(printOnly)
    const ocg = doc.context.lookup(markForms(doc, 0)[0]!.form.dict.get(N('OC'))) as PDFDict
    expect(ocg.lookup(N('Usage'), PDFDict).lookup(N('PageElement'), PDFDict).get(N('Subtype'))!.toString()).toBe('/FG')
    const d = doc.catalog.lookup(N('OCProperties'), PDFDict).lookup(N('D'), PDFDict)
    expect((d.lookup(N('AS'), PDFArray)).size()).toBe(3)
    await expect(applyOverlay(await bodyDoc(1), 'watermark', textWm('X', { print: false, screen: false }), undefined, { fileName: 'x' })).rejects.toThrow(/screen/)
  })
})

describe('update and remove, after saving and reopening', () => {
  it('remove leaves no text, no mark objects, no fonts and no optional content behind', async () => {
    const pdf = await bodyDoc(4)
    const originalBytes = await pdf.save()
    await applyHeaderFooter(pdf, 'headerfooter', hf({ topCenter: 'SECRET HEADER تقرير', bottomCenter: '{page}/{pages}' }), { fileName: 'r.pdf' })
    await applyOverlay(pdf, 'watermark', textWm('DRAFT', { print: true, screen: false }), undefined, { fileName: 'x' })
    const saved = await pdf.save()
    const doc = await reload(saved)
    const r1 = await removeGroup(doc, 'headerfooter')
    expect(r1).toMatchObject({ pages: 4, marks: 8, foreign: 0, unparsed: 0 })
    const r2 = await removeGroup(doc, 'watermark')
    expect(r2).toMatchObject({ pages: 4, marks: 4 })
    const after = await doc.save()
    const text = latin1(after)
    expect(text).not.toContain('EpdfPageMarks')
    expect(text).not.toContain('ADBE_CompoundType')
    expect(text).not.toContain('/Type0') // the only Type0 fonts were ours
    expect(text).not.toContain('OCProperties')
    const seen = await seePages(after)
    expect(seen.map((p) => p.text.replace(/\s+/g, ' ').trim())).toEqual(['Body text of page 1', 'Body text of page 2', 'Body text of page 3', 'Body text of page 4'])
    expect(after.length).toBeLessThan(originalBytes.length + 2500) // only the empty q/Q wrappers remain
    const s = summarizeMarks(await reload(after))
    expect(s.headerfooter.pages + s.watermark.pages).toBe(0)
  })

  it('removal also works when other software merged the page content into one stream', async () => {
    const pdf = await bodyDoc(1)
    await applyOverlay(pdf, 'watermark', textWm('MERGED'), undefined, { fileName: 'x' })
    await applyHeaderFooter(pdf, 'headerfooter', hf({ bottomCenter: 'FOOTER' }), { fileName: 'x' })
    const doc = await reload(await pdf.save())
    const merged = contentOf(doc, doc.getPage(0))
    const one = doc.context.register(doc.context.flateStream(merged))
    doc.getPage(0).node.set(N('Contents'), one)
    const r = await removeGroup(doc, 'watermark')
    expect(r.marks).toBe(1)
    const seen = await seePages(await doc.save())
    expect(seen[0]!.text).not.toContain('MERGED')
    expect(seen[0]!.text).toContain('FOOTER')
    expect(seen[0]!.text).toContain('Body text of page 1')
  })

  it('replace (update) swaps the old mark for the new one in one step; add keeps both', async () => {
    const pdf = await bodyDoc(2)
    await applyOverlay(pdf, 'watermark', textWm('OLD'), undefined, { fileName: 'x' })
    const doc = await reload(await pdf.save())
    await applyGroup(doc, { group: 'watermark', settings: textWm('NEW') }, { mode: 'replace', fileName: 'x' })
    const d2 = await reload(await doc.save())
    const t = (await seePages(await d2.save())).map((p) => p.text)
    expect(t.every((x) => x.includes('NEW') && !x.includes('OLD'))).toBe(true)
    await applyGroup(d2, { group: 'watermark', settings: textWm('THIRD') }, { mode: 'add', fileName: 'x' })
    const t2 = (await seePages(await d2.save())).map((p) => p.text)
    expect(t2.every((x) => x.includes('NEW') && x.includes('THIRD'))).toBe(true)
    expect(summarizeMarks(d2).watermark.settings?.settings).toMatchObject({ source: { text: 'THIRD' } })
  })

  it('an image watermark can be updated without choosing the picture again (its source is kept)', async () => {
    const png = await tinyPng()
    const pdf = await bodyDoc(2)
    const img: OverlaySettings = { ...defaultWatermark(), source: { kind: 'image', name: 'logo.png' } }
    await applyOverlay(pdf, 'watermark', img, { bytes: png, kind: 'png' }, { fileName: 'x' })
    const doc = await reload(await pdf.save())
    const sum = summarizeMarks(doc).watermark
    expect(sum.source).toBeInstanceOf(PDFRef)
    await applyGroup(doc, { group: 'watermark', settings: { ...img, opacity: 0.8, rotation: 0 } }, { mode: 'replace', fileName: 'x', source: { ref: sum.source! } })
    const d2 = await reload(await doc.save())
    const f = markForms(d2, 1)[0]!
    expect(streamText(f.inner[0]!)).toContain('/S0 Do')
    // the picture is still in the file exactly once
    const images = d2.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFStream && o.dict.get(N('Subtype')) === N('Image'))
    expect(images.length).toBe(1)
  })

  it('removes Acrobat-style marks (PieceInfo ADBE_CompoundType) and keeps the q/Q nesting balanced', async () => {
    const pdf = await bodyDoc(1)
    const page = pdf.getPage(0)
    const ctx = pdf.context
    const fm = ctx.register(
      ctx.flateStream('BT /F1 40 Tf 100 400 Td (ACROBAT WATERMARK) Tj ET', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 612, 792],
        Resources: page.node.Resources()!,
        PieceInfo: ctx.obj({ ADBE_CompoundType: ctx.obj({ DocSettings: ctx.obj({}), LastModified: 'D:20200101000000', Private: 'Watermark' }) })
      } as never)
    )
    const xo = page.node.Resources()!.lookup(N('XObject'))
    const xd = xo instanceof PDFDict ? xo : ctx.obj({})
    xd.set(N('Fm0'), fm)
    page.node.Resources()!.set(N('XObject'), xd)
    const acro = ctx.register(ctx.flateStream('q\n/Artifact <</Subtype /Watermark /Type /Pagination >>BDC\n0 g\n/Fm0 Do\nQ\nEMC\n'))
    const refs = page.node.Contents() as PDFArray
    refs.push(acro)
    const doc = await reload(await pdf.save())
    expect(summarizeMarks(doc).watermark).toMatchObject({ pages: 0, foreignPages: 1 })
    const r = await removeGroup(doc, 'watermark')
    expect(r.foreign).toBe(1)
    const out = await doc.save()
    const content = contentOf(await reload(out), (await reload(out)).getPage(0))
    expect(content).not.toContain('Fm0')
    const ops = parseContent(new TextEncoder().encode(content)).ops.map((o) => o.op)
    expect(ops.filter((o) => o === 'q').length).toBe(ops.filter((o) => o === 'Q').length)
    expect((await seePages(out))[0]!.text).not.toContain('ACROBAT')
  })

  it('cutMarks: nested sequences, stray Do and unrelated artifacts', () => {
    const src = '/Artifact <</Type /Pagination>> BDC q /Keep Do Q EMC\n/Span <</MCID 1>> BDC /EpdfMk0 Do EMC\n/Artifact BMC /P <<>> BDC /EpdfMk1 Do EMC EMC\n/EpdfMk2 Do\n'
    const ops = parseContent(new TextEncoder().encode(src)).ops
    const out = latin1(serializeContent(cutMarks(ops, new Set(['EpdfMk0', 'EpdfMk1', 'EpdfMk2']))!))
    expect(out).toContain('/Keep Do')
    expect(out).not.toContain('EpdfMk1')
    expect(out).not.toContain('EpdfMk2')
    // a Do inside a non-artifact sequence and no artifact around it is dropped on its own
    expect(out).not.toContain('EpdfMk0')
    expect(out).toContain('/Span')
    expect(cutMarks(ops, new Set(['Nothing']))).toBeNull()
  })
})

describe('removal and preservation of other page content', () => {
  it('removing one group never touches the others', async () => {
    const pdf = await bodyDoc(2)
    await applyHeaderFooter(pdf, 'headerfooter', hf({ topCenter: 'H' }), { fileName: 'x' })
    await applyHeaderFooter(pdf, 'bates', defaultBates(), { fileName: 'x' })
    await applyOverlay(pdf, 'background', defaultBackground(), undefined, { fileName: 'x' })
    const doc = await reload(await pdf.save())
    await removeGroup(doc, 'bates')
    const s = summarizeMarks(await reload(await doc.save()))
    expect([s.headerfooter.pages, s.bates.pages, s.background.pages]).toEqual([2, 0, 2])
    await removeMarks(doc, { groups: ['headerfooter', 'background'] })
    const s2 = summarizeMarks(await reload(await doc.save()))
    expect([s2.headerfooter.pages, s2.background.pages]).toEqual([0, 0])
  })
})

/** A 2x2 PNG built by hand (no image library needed). */
async function tinyPng(): Promise<Uint8Array> {
  const { deflateSync } = await import('node:zlib')
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer): number => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 255, 255])
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
