import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, redactDocument, type MarkInput, type RedactOptions } from '../../src/renderer/src/features/redact/logic/redact'
import { collectGarbage, reachableTags } from '../../src/renderer/src/features/redact/logic/docScrub'
import { verifyRedaction } from '../../src/renderer/src/features/redact/logic/verify'
import { decoded } from '../support/redactProof'

const N = (s: string): PDFName => PDFName.of(s)
const CODE = 'AGENTSMITH-42'

/** A document with `CODE` on the page and in many other places (built with pdf-lib). */
async function base(setup?: (doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>) => void | Promise<void>): Promise<PDFDocument> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  page.drawText(`The agent is ${CODE} today`, { x: 72, y: 700, size: 14, font })
  page.drawText('A visible line that stays', { x: 72, y: 600, size: 14, font })
  await setup?.(doc, page)
  // as in the app: the document is read back from bytes (pdf-lib embeds fonts and flattens content on save)
  return PDFDocument.load(await doc.save())
}

const areaOnCode: MarkInput = { id: 'a', pageIndex: 0, rects: [{ x0: 72, y0: 690, x1: 400, y1: 720 }], text: CODE }

async function redact(doc: PDFDocument, opts: Partial<RedactOptions> = {}, marks: MarkInput[] = [areaOnCode]) {
  const res = redactDocument(doc, marks, { ...DEFAULT_OPTIONS, ...opts })
  const bytes = await doc.save()
  return { res, bytes, pdf: await PDFDocument.load(bytes) }
}

const dictOf = (pdf: PDFDocument, o: unknown): PDFDict => pdf.context.lookup(o as PDFRef) as PDFDict

describe('annotations and form fields', () => {
  it('removes annotations under a mark with their popups and replies, keeps the others (links included)', async () => {
    const doc = await base((d, p) => {
      const ctx = d.context
      const note = ctx.nextRef()
      const popup = ctx.nextRef()
      const reply = ctx.nextRef()
      ctx.assign(note, ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [100, 700, 118, 718], Contents: PDFString.of('a note'), Popup: popup }))
      ctx.assign(popup, ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [300, 600, 400, 700], Parent: note }))
      ctx.assign(reply, ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 100, 518, 118], Contents: PDFString.of('reply'), IRT: note }))
      const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 50, 200, 70], A: { S: 'URI', URI: PDFString.of('https://keep.example') } }))
      const other = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 300, 518, 318], Contents: PDFString.of('unrelated') }))
      p.node.set(N('Annots'), ctx.obj([note, popup, reply, link, other]))
    })
    const { res, pdf } = await redact(doc)
    const annots = pdf.getPage(0).node.Annots()!
    const subs = Array.from({ length: annots.size() }, (_, i) => (dictOf(pdf, annots.get(i)).lookup(N('Subtype')) as PDFName).decodeText())
    expect(subs).toEqual(['Link', 'Text'])
    expect(res.report.scrub.annotations).toBe(3)
  })

  it('a text annotation elsewhere that repeats the redacted text is removed (Contents, RC, T, Subj, and appearance text)', async () => {
    const doc = await base((d, p) => {
      const ctx = d.context
      const ap = ctx.register(ctx.flateStream(`BT /Helv 10 Tf 2 2 Td (${CODE} was here) Tj ET`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 20], Resources: { Font: { Helv: ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })) } } }))
      const a1 = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 300, 518, 318], Contents: PDFString.of(`about ${CODE}`) }))
      const a2 = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 340, 518, 358], Contents: PDFString.of('x'), T: PDFHexString.fromText(`by ${CODE}`) }))
      const a3 = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 380, 518, 398], Contents: PDFString.of('x'), Subj: PDFString.of(CODE.toLowerCase()) }))
      const a4 = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [300, 400, 400, 420], Contents: PDFString.of('x'), AP: { N: ap } }))
      const keep = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 420, 518, 438], Contents: PDFString.of('clean') }))
      p.node.set(N('Annots'), ctx.obj([a1, a2, a3, a4, keep]))
    })
    const { pdf } = await redact(doc)
    const annots = pdf.getPage(0).node.Annots()!
    expect(annots.size()).toBe(1)
    expect((dictOf(pdf, annots.get(0)).lookup(N('Contents')) as PDFString).decodeText()).toBe('clean')
  })

  it('form widgets: one under the mark is detached from its field and the AcroForm; one elsewhere has its value cleaned and its appearance dropped', async () => {
    const doc = await base((d, p) => {
      const form = d.getForm()
      const under = form.createTextField('under')
      under.setText('secret value')
      under.addToPage(p, { x: 100, y: 695, width: 150, height: 20 })
      const elsewhere = form.createTextField('elsewhere')
      elsewhere.setText(`code ${CODE}`)
      elsewhere.addToPage(p, { x: 100, y: 300, width: 200, height: 20 })
      const keep = form.createTextField('keep')
      keep.setText('fine')
      keep.addToPage(p, { x: 100, y: 200, width: 200, height: 20 })
    })
    const { pdf } = await redact(doc)
    const form = pdf.getForm()
    const names = form.getFields().map((f) => f.getName())
    expect(names.sort()).toEqual(['elsewhere', 'keep'])
    expect(form.getTextField('keep').getText()).toBe('fine')
    expect(form.getTextField('elsewhere').getText() ?? '').not.toContain(CODE)
    expect(form.getTextField('elsewhere').getText()).toContain('[redacted]')
    // viewers redraw the field whose appearance was dropped
    expect((pdf.catalog.lookup(N('AcroForm')) as PDFDict).lookup(N('NeedAppearances'))).toBe(PDFBool.True)
    expect(pdf.getPage(0).node.Annots()!.size()).toBe(2)
  })
})

describe('bookmarks, destinations, structure, strings', () => {
  it('scrubs bookmark titles (nested), legacy and name-tree destinations (with limits), and structure /ActualText /Alt', async () => {
    const doc = await base((d, p) => {
      const ctx = d.context
      const outlines = ctx.nextRef()
      const parent = ctx.nextRef()
      const child = ctx.nextRef()
      ctx.assign(child, ctx.obj({ Title: PDFHexString.fromText(`Section on ${CODE}`), Parent: parent, Dest: [p.ref, N('Fit')] }))
      ctx.assign(parent, ctx.obj({ Title: PDFString.of('Chapter'), Parent: outlines, First: child, Last: child, Count: 1, Dest: [p.ref, N('Fit')] }))
      ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: parent, Last: parent, Count: 2 }))
      d.catalog.set(N('Outlines'), outlines)
      const leafA = ctx.register(ctx.obj({ Names: [PDFString.of('alpha'), [p.ref, N('Fit')], PDFString.of(`${CODE}-x`), [p.ref, N('Fit')]], Limits: [PDFString.of('alpha'), PDFString.of(`${CODE}-x`)] }))
      const leafB = ctx.register(ctx.obj({ Names: [PDFString.of('omega'), [p.ref, N('Fit')]], Limits: [PDFString.of('omega'), PDFString.of('omega')] }))
      d.catalog.set(N('Names'), ctx.obj({ Dests: { Kids: [leafA, leafB], Limits: [PDFString.of('alpha'), PDFString.of('omega')] } }))
      d.catalog.set(N('Dests'), ctx.obj({ [`old-${CODE}`]: [p.ref, N('Fit')], keepme: [p.ref, N('Fit')] }))
      const struct = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Span', ActualText: PDFString.of(`the ${CODE}`), Alt: PDFHexString.fromText(`picture of ${CODE}`), Lang: PDFString.of('en') }))
      d.catalog.set(N('StructTreeRoot'), ctx.obj({ Type: 'StructTreeRoot', K: [struct] }))
    })
    const { pdf } = await redact(doc)
    const title = (o: PDFDict): string => (o.lookup(N('Title')) as PDFString | PDFHexString).decodeText()
    const top = (pdf.catalog.lookup(N('Outlines')) as PDFDict).lookup(N('First')) as PDFDict
    expect(title(top)).toBe('Chapter')
    expect(title(top.lookup(N('First')) as PDFDict)).toBe('Section on [redacted]')
    const kids = ((pdf.catalog.lookup(N('Names')) as PDFDict).lookup(N('Dests')) as PDFDict).lookup(N('Kids')) as PDFArray
    const a = kids.lookup(0) as PDFDict
    expect((a.lookup(N('Names')) as PDFArray).size()).toBe(2) // only "alpha" is left
    const limits = a.lookup(N('Limits')) as PDFArray
    expect((limits.lookup(1) as PDFString).decodeText()).toBe('alpha') // limits follow the remaining keys
    const legacy = pdf.catalog.lookup(N('Dests')) as PDFDict
    expect([...legacy.entries()].map(([k]) => k.decodeText())).toEqual(['keepme'])
    const struct = ((pdf.catalog.lookup(N('StructTreeRoot')) as PDFDict).lookup(N('K')) as PDFArray).lookup(0) as PDFDict
    expect((struct.lookup(N('ActualText')) as PDFString).decodeText()).toBe('the [redacted]')
    expect((struct.lookup(N('Alt')) as PDFHexString).decodeText()).toBe('picture of [redacted]')
    expect((struct.lookup(N('Lang')) as PDFString).decodeText()).toBe('en')
  })

  it('the redaction text is matched ignoring case, whitespace runs and encoding (PDFDocEncoding / UTF-16BE)', async () => {
    const doc = await base((d) => {
      d.setTitle(`agentsmith-42 report`)
      d.setAuthor(CODE)
      d.setSubject(`Notes: ${CODE}`)
      d.setKeywords(['plain', CODE.toLowerCase()])
      d.setCreator(`Ü ${CODE} Ü`)
    })
    const { pdf, bytes } = await redact(doc)
    for (const v of [pdf.getTitle(), pdf.getAuthor(), pdf.getSubject(), pdf.getKeywords(), pdf.getCreator()]) expect(v?.toLowerCase()).not.toContain('agentsmith')
    expect(pdf.getTitle()).toBe('[redacted] report')
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('AGENTSMITH')
  })
})

describe('metadata and hidden data options', () => {
  const rich = async (): Promise<PDFDocument> =>
    base(async (d, p) => {
      const ctx = d.context
      d.setTitle('A plain title')
      d.setAuthor('Someone')
      d.catalog.set(N('Metadata'), ctx.register(ctx.flateStream('<x:xmpmeta><dc:title>plain xmp</dc:title></x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })))
      d.catalog.set(N('PieceInfo'), ctx.obj({ App: { Private: PDFString.of('data') } }))
      p.node.set(N('Thumb'), ctx.register(ctx.stream(new Uint8Array(12), { Width: 2, Height: 2, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 } as never)))
      p.node.set(N('PieceInfo'), ctx.obj({ App: { Private: PDFString.of('page data') } }))
      await d.attach(new TextEncoder().encode('unrelated attachment'), 'a.txt', { mimeType: 'text/plain' })
      d.catalog.set(N('OpenAction'), ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }))
      d.catalog.set(N('AA'), ctx.obj({ WC: { S: 'JavaScript', JS: PDFString.of('app.alert(2)') } }))
      d.catalog.set(N('PageLabels'), ctx.obj({ Nums: [0, { S: 'D' }] }))
      const form = d.getForm()
      const f = form.createTextField('tip')
      f.addToPage(p, { x: 10, y: 10, width: 50, height: 20 })
      f.acroField.dict.set(N('TU'), PDFString.of('a tooltip'))
      ;(d.catalog.lookup(N('AcroForm')) as PDFDict).set(N('XFA'), ctx.obj([PDFString.of('template'), ctx.stream('<xml/>')]))
    })

  it('default: unrelated metadata, attachments, JavaScript and labels stay; the redacted page thumbnail and piece info go', async () => {
    const { pdf } = await redact(await rich())
    expect(pdf.getTitle()).toBe('A plain title')
    expect(pdf.catalog.has(N('Metadata'))).toBe(true)
    expect(pdf.catalog.has(N('PageLabels'))).toBe(true)
    expect(pdf.catalog.has(N('OpenAction'))).toBe(true)
    const names = pdf.catalog.lookup(N('Names'))
    expect(names instanceof PDFDict && names.has(N('EmbeddedFiles'))).toBe(true)
    expect(pdf.getPage(0).node.has(N('Thumb'))).toBe(false)
    expect(pdf.getPage(0).node.has(N('PieceInfo'))).toBe(false)
  })

  it('remove all metadata: Info, XMP, piece info and thumbnails are gone', async () => {
    const { pdf, bytes } = await redact(await rich(), { removeMetadata: true })
    expect(pdf.getTitle()).toBeUndefined()
    expect(pdf.getAuthor()).toBeUndefined()
    expect(pdf.catalog.has(N('Metadata'))).toBe(false)
    expect(pdf.catalog.has(N('PieceInfo'))).toBe(false)
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('plain xmp')
    for (const [, o] of pdf.context.enumerateIndirectObjects()) if (o instanceof PDFStream) expect(o.dict.lookup(N('Type'))).not.toBe(N('Metadata'))
  })

  it('remove hidden data: attachments, JavaScript (open action, additional actions), page labels, tooltips, XFA', async () => {
    const { pdf, res } = await (async () => {
      const r = await redact(await rich(), { removeHidden: true })
      return { pdf: r.pdf, res: r.res }
    })()
    const names = pdf.catalog.lookup(N('Names'))
    expect(names instanceof PDFDict && names.has(N('EmbeddedFiles'))).toBe(false)
    expect(pdf.catalog.has(N('OpenAction'))).toBe(false)
    expect(pdf.catalog.has(N('AA'))).toBe(false)
    expect(pdf.catalog.has(N('PageLabels'))).toBe(false)
    expect((pdf.catalog.lookup(N('AcroForm')) as PDFDict).has(N('XFA'))).toBe(false)
    expect(pdf.getForm().getTextField('tip').acroField.dict.has(N('TU'))).toBe(false)
    expect(res.report.scrub.attachments).toBeGreaterThan(0)
    expect(res.report.scrub.javascript).toBeGreaterThan(0)
    // no attachment stream survives in the file
    for (const [, o] of pdf.context.enumerateIndirectObjects()) if (o instanceof PDFStream) expect(o.dict.lookup(N('Type'))).not.toBe(N('EmbeddedFile'))
  })

  it('JavaScript that mentions the redacted text is removed even without the hidden-data option', async () => {
    const doc = await base((d) => {
      d.catalog.set(N('OpenAction'), d.context.obj({ S: 'JavaScript', JS: PDFString.of(`app.alert("${CODE}")`) }))
    })
    const { pdf, bytes } = await redact(doc)
    const oa = pdf.catalog.lookup(N('OpenAction')) as PDFDict
    expect((oa.lookup(N('JS')) as PDFString | PDFHexString).decodeText()).toBe('')
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('AGENTSMITH')
  })

  it('JavaScript kept in a stream is checked too', async () => {
    const doc = await base((d) => {
      const js = d.context.register(d.context.flateStream(`app.alert("${CODE}")`))
      d.catalog.set(N('OpenAction'), d.context.obj({ S: 'JavaScript', JS: js }))
    })
    const { bytes, pdf } = await redact(doc)
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('AGENTSMITH')
    for (const [, o] of pdf.context.enumerateIndirectObjects()) if (o instanceof PDFStream) expect(new TextDecoder('latin1').decode(decoded(o) ?? new Uint8Array())).not.toContain('AGENTSMITH')
  })

  it('XMP that mentions the text is rewritten, not just dropped', async () => {
    const doc = await base((d) => {
      d.catalog.set(N('Metadata'), d.context.register(d.context.flateStream(`<x:xmpmeta><dc:title>Report on ${CODE}</dc:title><dc:creator>kept</dc:creator></x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' })))
    })
    const { pdf } = await redact(doc)
    const meta = pdf.catalog.lookup(N('Metadata')) as PDFStream
    const xml = new TextDecoder().decode(decoded(meta)!)
    expect(xml).toContain('Report on [redacted]')
    expect(xml).toContain('kept')
    expect(String(meta.dict.lookup(N('Subtype')))).toBe('/XML')
  })
})

describe('the file is rewritten from scratch', () => {
  it('garbage collection removes unreachable objects, and reports them', async () => {
    const doc = await base()
    const orphan = doc.context.register(doc.context.obj({ Old: PDFString.of('OLDCONTENT-ZZZ') }))
    void orphan
    const before = doc.context.enumerateIndirectObjects().length
    const removed = collectGarbage(doc)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(doc.context.enumerateIndirectObjects().length).toBe(before - removed)
    expect(reachableTags(doc).size).toBe(doc.context.enumerateIndirectObjects().length)
    expect(collectGarbage(doc)).toBe(0)
  })

  it('an earlier revision (incremental update) with the old text does not survive the rewrite', async () => {
    // revision 1: uncompressed content with OLDSECRET; revision 2 (incremental update) replaces the page content
    const first = await PDFDocument.create()
    const font = first.context.register(first.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }))
    const page = first.addPage([612, 792])
    const content = first.context.register(first.context.stream('BT /F1 14 Tf 72 700 Td (OLDSECRET-9911 in revision one) Tj ET'))
    page.node.set(N('Contents'), content)
    page.node.set(N('Resources'), first.context.obj({ Font: { F1: font } }))
    const bytes1 = await first.save({ useObjectStreams: false })
    const text1 = new TextDecoder('latin1').decode(bytes1)
    expect(text1).toContain('OLDSECRET-9911')
    const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text1)![1])
    const size = Number(/\/Size (\d+)/.exec(text1.slice(text1.lastIndexOf('trailer')))![1])
    const root = /\/Root (\d+ \d+ R)/.exec(text1.slice(text1.lastIndexOf('trailer')))![1]
    const body = 'BT /F1 14 Tf 72 700 Td (public text only) Tj ET'
    const objNo = content.objectNumber
    const update = `\n${objNo} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`
    const objOffset = bytes1.length + update.indexOf(`${objNo} 0 obj`)
    const xrefAt = bytes1.length + update.length
    const tail = `xref\n0 1\n0000000000 65535 f \n${objNo} 1\n${String(objOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size} /Root ${root} /Prev ${startxref} >>\nstartxref\n${xrefAt}\n%%EOF\n`
    const bytes2 = new Uint8Array([...bytes1, ...new TextEncoder().encode(update + tail)])
    expect(new TextDecoder('latin1').decode(bytes2)).toContain('OLDSECRET-9911') // still in the older revision
    const doc = await PDFDocument.load(bytes2)
    expect(doc.getPage(0).node.Contents()).toBeDefined()
    const res = redactDocument(doc, [{ id: 'a', pageIndex: 0, rects: [{ x0: 60, y0: 690, x1: 400, y1: 720 }], text: 'public text only' }], DEFAULT_OPTIONS)
    const out = await doc.save()
    const findings = await verifyRedaction({ bytes: out, marksByPage: res.marksByPage, secrets: res.secrets })
    expect(findings).toEqual([])
    const outText = new TextDecoder('latin1').decode(out)
    expect(outText).not.toContain('OLDSECRET-9911')
    expect(outText).not.toContain('public text only')
    expect((outText.match(/%%EOF/g) ?? []).length).toBe(1) // one revision, no trailer chain
    expect(outText).not.toContain('/Prev')
  })

  it('a redacted stream that was shared between two pages keeps the other page intact', async () => {
    const doc = await PDFDocument.create()
    const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }))
    const shared = doc.context.register(doc.context.flateStream('BT /F1 14 Tf 72 700 Td (Shared line SHAREDCODE-77) Tj ET'))
    for (let i = 0; i < 2; i++) {
      const p = doc.addPage([612, 792])
      p.node.set(N('Contents'), shared)
      p.node.set(N('Resources'), doc.context.obj({ Font: { F1: font } }))
    }
    const r = redactDocument(doc, [{ id: 'a', pageIndex: 0, rects: [{ x0: 130, y0: 690, x1: 300, y1: 720 }] }], DEFAULT_OPTIONS)
    expect(r.report.textRuns).toBe(1)
    const out = await PDFDocument.load(await doc.save())
    const text = (i: number): string => {
      const c = out.getPage(i).node.Contents()
      const list: PDFStream[] = c instanceof PDFArray ? Array.from({ length: c.size() }, (_, k) => c.lookup(k) as PDFStream) : [c as PDFStream]
      return list.map((s) => new TextDecoder('latin1').decode(decoded(s) ?? new Uint8Array())).join('\n')
    }
    expect(text(1)).toContain('SHAREDCODE-77') // page 2 unchanged
    expect(text(0)).not.toContain('SHAREDCODE-77')
  })
})
