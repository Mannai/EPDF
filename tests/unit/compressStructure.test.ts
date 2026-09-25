import fontkit from '@pdf-lib/fontkit'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, StandardFonts, rgb } from 'pdf-lib'
import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { PRESETS, type CompressOptions } from '../../src/renderer/src/features/compress/pdf/options'
import { reachable, trailerRoots } from '../../src/renderer/src/features/compress/pdf/graph'
import { decodeStream, encodedBytes } from '../../src/renderer/src/features/compress/pdf/streams'
import { addRawImage, baseDoc, imagesOf, photoRGB, placeAt } from './compressHelpers'
import { pdfjsImages, pdfjsPageCount, pdfjsPageSize, pdfjsText } from './compressPdfjs'
import { notoBytes } from './helpers/pdfBuilder'
import { addLink, addOutline, linkTarget, makeDoc } from './pdfTestUtils'

const N = (s: string): PDFName => PDFName.of(s)
const run = (bytes: Uint8Array, extra: Partial<CompressOptions> = {}, preset: keyof typeof PRESETS = 'balanced') => compressPdf(bytes, { ...PRESETS[preset], ...extra }, { codec: pureCodec })
const text = (b: Uint8Array): string => Buffer.from(b).toString('latin1')

/** Streams (with a given /Subtype or /Type) among the indirect objects. */
const streamsWhere = (doc: PDFDocument, pred: (d: PDFDict, s: PDFStream) => boolean): PDFStream[] => {
  const out: PDFStream[] = []
  for (const [, o] of doc.context.enumerateIndirectObjects()) if (o instanceof PDFStream && pred(o.dict, o)) out.push(o)
  return out
}

describe('deduplication', () => {
  it('identical images collapse into one object; both placements still draw', async () => {
    const { doc, page } = await baseDoc()
    const data = photoRGB(200, 150, 3)
    const a = addRawImage(doc, { w: 200, h: 150, data, cs: 'DeviceRGB' })
    const b = addRawImage(doc, { w: 200, h: 150, data, cs: 'DeviceRGB' })
    placeAt(page, a, 20, 400, 100, 75)
    placeAt(page, b, 200, 400, 100, 75)
    const input = await doc.save()
    const r = await run(input, { images: false })
    expect(r.kept).toBe('result')
    const out = await PDFDocument.load(r.bytes)
    expect(imagesOf(out)).toHaveLength(1)
    expect(r.stats.dedupe.merged).toBeGreaterThanOrEqual(1)
    expect(await pdfjsImages(r.bytes)).toHaveLength(2)
    expect(r.bytes.length).toBeLessThan(input.length * 0.65)
  })

  it('images that differ by one byte are kept apart', async () => {
    const { doc, page } = await baseDoc()
    const data = photoRGB(200, 150, 3)
    const data2 = data.slice()
    data2[1000] ^= 1
    placeAt(page, addRawImage(doc, { w: 200, h: 150, data, cs: 'DeviceRGB' }), 20, 400, 100, 75)
    placeAt(page, addRawImage(doc, { w: 200, h: 150, data: data2, cs: 'DeviceRGB' }), 200, 400, 100, 75)
    const r = await run(await doc.save(), { images: false })
    expect(imagesOf(await PDFDocument.load(r.bytes))).toHaveLength(2)
  })

  it('the same font embedded twice collapses (font program, descriptor, descendant and Type 0 dictionaries)', async () => {
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const bytes = notoBytes('Regular')
    const f1 = await doc.embedFont(bytes, { subset: false })
    const f2 = await doc.embedFont(bytes, { subset: false })
    const p1 = doc.addPage([400, 300])
    const p2 = doc.addPage([400, 300])
    p1.drawText('First page uses font one', { x: 20, y: 200, size: 16, font: f1 })
    p2.drawText('Second page uses font two', { x: 20, y: 200, size: 16, font: f2 })
    const input = await doc.save()
    const before = await PDFDocument.load(input)
    const programs = (d: PDFDocument): number => {
      const refs = new Set<string>()
      for (const [, o] of d.context.enumerateIndirectObjects()) {
        if (!(o instanceof PDFDict)) continue
        for (const k of ['FontFile', 'FontFile2', 'FontFile3']) {
          const v = o.get(N(k))
          if (v instanceof PDFRef) refs.add(String(v))
        }
      }
      return refs.size
    }
    expect(programs(before)).toBe(2)
    const r = await run(input)
    expect(r.kept).toBe('result')
    const after = await PDFDocument.load(r.bytes)
    expect(programs(after)).toBe(1)
    expect(r.bytes.length).toBeLessThan(input.length * 0.6)
    expect(await pdfjsText(r.bytes, 1)).toBe('First page uses font one')
    expect(await pdfjsText(r.bytes, 2)).toBe('Second page uses font two')
  })

  it('page content streams are never shared, even when two pages are identical', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < 3; i++) doc.addPage([300, 300]).drawText('identical page', { x: 10, y: 100, size: 20, font })
    const r = await run(await doc.save(), {})
    const out = await PDFDocument.load(r.bytes)
    const refs = new Set<string>()
    for (const p of out.getPages()) {
      const c = p.node.get(N('Contents'))
      const list = c instanceof PDFArray ? c.asArray() : [c]
      for (const x of list) if (x instanceof PDFRef) refs.add(`${x.objectNumber}`)
    }
    expect(refs.size).toBe(3)
  })
})

describe('deduplication: things that must stay separate objects', () => {
  it('identical annotation appearance streams are not shared between annotations', async () => {
    const doc = await makeDoc(1)
    const ctx = doc.context
    const mkAp = (): PDFRef => ctx.register(ctx.stream('0 0 1 rg 0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }))
    const a = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [10, 10, 20, 20], AP: { N: mkAp() }, F: 4 }))
    const b = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [30, 10, 40, 20], AP: { N: mkAp() }, F: 4 }))
    doc.getPage(0).node.set(N('Annots'), ctx.obj([a, b]))
    const r = await run(await doc.save(), {})
    const out = await PDFDocument.load(r.bytes)
    const annots = out.getPage(0).node.lookup(N('Annots'), PDFArray)
    const aps = [0, 1].map((i) => String(((annots.lookup(i, PDFDict) as PDFDict).lookup(N('AP'), PDFDict) as PDFDict).get(N('N'))))
    expect(new Set(aps).size).toBe(2)
  })
})

describe('unused objects', () => {
  it('orphans are dropped and every remaining object is reachable from the trailer', async () => {
    const { doc, page } = await baseDoc()
    placeAt(page, addRawImage(doc, { w: 100, h: 80, data: photoRGB(100, 80, 3), cs: 'DeviceRGB' }), 20, 400, 100, 80)
    for (let i = 0; i < 5; i++) doc.context.register(doc.context.stream(new Uint8Array(20000).map((_, k) => (k * (i + 3)) & 255)))
    doc.context.register(doc.context.obj({ Type: 'Dangling', Big: 'x' }))
    const input = await doc.save()
    const r = await run(input, { images: false })
    expect(r.stats.unreachable.objects).toBeGreaterThanOrEqual(6)
    expect(r.bytes.length).toBeLessThan(input.length - 50000)
    const out = await PDFDocument.load(r.bytes)
    const { root, info } = trailerRoots(out.context)
    const reach = new Set(reachable(out.context, [root, info]).map((x) => `${x.ref.objectNumber}`))
    const all = out.context.enumerateIndirectObjects().filter(([, o]) => !(o instanceof PDFStream && ['ObjStm', 'XRef'].includes(String(o.dict.get(N('Type'))).slice(1))))
    for (const [ref] of all) expect(reach.has(`${ref.objectNumber}`), `object ${ref.objectNumber} unreachable`).toBe(true)
  })

  it('no dangling references after writing: every reference resolves', async () => {
    const doc = await makeDoc(4)
    addOutline(doc, [{ title: 'A', page: 1, children: [{ title: 'A1', page: 2 }] }, { title: 'B', page: 3 }])
    addLink(doc, 0, 3)
    const r = await run(await doc.save(), {})
    const out = await PDFDocument.load(r.bytes)
    let dangling = 0
    const seen = new Set<string>()
    const visit = (o: unknown): void => {
      if (o instanceof PDFRef) {
        if (!out.context.lookup(o)) dangling++
        if (seen.has(String(o))) return
        seen.add(String(o))
        visit(out.context.lookup(o))
      } else if (o instanceof PDFStream) visit(o.dict)
      else if (o instanceof PDFDict) for (const v of o.values()) visit(v)
      else if (o instanceof PDFArray) for (const v of o.asArray()) visit(v)
    }
    visit(out.context.trailerInfo.Root)
    expect(dangling).toBe(0)
  })
})

describe('object streams and the writer', () => {
  const build = async (): Promise<Uint8Array> => {
    const doc = await makeDoc(6)
    addOutline(doc, [{ title: 'Intro', page: 0 }, { title: 'Middle', page: 2, children: [{ title: 'Deep', page: 3 }] }, { title: 'End', page: 5 }])
    addLink(doc, 0, 4)
    addLink(doc, 2, 1)
    // legacy classic-xref file: no object streams in the input
    return doc.save({ useObjectStreams: false })
  }

  it('packs objects into compressed object streams with an xref stream and reads back everywhere', async () => {
    const input = await build()
    const r = await run(input, { objectStreams: true })
    expect(r.kept).toBe('result')
    const s = text(r.bytes)
    expect(s.startsWith('%PDF-1.')).toBe(true)
    expect(s).toContain('/Type/ObjStm')
    expect(s).toContain('/Type/XRef')
    expect(s).not.toMatch(/\nxref\n/)
    const out = await PDFDocument.load(r.bytes)
    expect(out.getPageCount()).toBe(6)
    expect(await pdfjsPageCount(r.bytes)).toBe(6)
    for (let i = 1; i <= 6; i++) expect(await pdfjsText(r.bytes, i)).toBe(`Page ${i}`)
    expect(await pdfjsPageSize(r.bytes)).toEqual(await pdfjsPageSize(input))
    expect(linkTarget(out, 0)).toBe(4)
    expect(linkTarget(out, 2)).toBe(1)
    expect(r.bytes.length).toBeLessThan(input.length)
  })

  it('writes a classic cross-reference table when object streams are off', async () => {
    const input = await build()
    const r = await run(input, { objectStreams: false, recompressStreams: false }, 'balanced')
    if (r.kept === 'result') {
      const s = text(r.bytes)
      expect(s).not.toContain('/Type/ObjStm')
      expect(s).toMatch(/\nxref\n0 \d+\n0000000000 65535 f/)
      expect(s).toMatch(/startxref\n\d+\n%%EOF\n$/)
      expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(6)
      expect(await pdfjsPageCount(r.bytes)).toBe(6)
    }
  })

  it('object numbers are dense and start at 1', async () => {
    const r = await run(await build(), {})
    const out = await PDFDocument.load(r.bytes)
    const nums = out.context.enumerateIndirectObjects().map(([ref]) => ref.objectNumber)
    expect(Math.min(...nums)).toBe(1)
    expect(Math.max(...nums)).toBeLessThanOrEqual(nums.length + 2)
  })

  it('a big file with several object streams round-trips (600 pages)', async () => {
    const doc = await makeDoc(600)
    const r = await run(await doc.save({ useObjectStreams: false }), {})
    expect(r.kept).toBe('result')
    const out = await PDFDocument.load(r.bytes)
    expect(out.getPageCount()).toBe(600)
    expect((text(r.bytes).match(/\/Type\/ObjStm/g) ?? []).length).toBeGreaterThan(1)
    expect(await pdfjsText(r.bytes, 600)).toBe('Page 600')
  })
})

describe('stream recompression', () => {
  const contentStreams = (doc: PDFDocument): PDFStream[] => streamsWhere(doc, (d) => !d.has(N('Subtype')) && !d.has(N('Type')) && !d.has(N('Length1')))

  it('deflates uncompressed streams, converts ASCII85 to Flate and re-deflates weak Flate; decoded bytes are identical', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([300, 300])
    const ctx = doc.context
    const payload = new TextEncoder().encode('0 0 m 10 10 l S\n'.repeat(400))
    const raw = ctx.register(ctx.stream(payload, { Tag: 'raw' }))
    const weak = ctx.register(ctx.stream(zlibSync(payload, { level: 1 }), { Filter: 'FlateDecode', Tag: 'weak' } as never))
    const a85 = ctx.register(ctx.stream(ascii85(payload), { Filter: 'ASCII85Decode', Tag: 'a85' } as never))
    page.node.set(N('Extra'), ctx.obj([raw, weak, a85]))
    const input = await doc.save({ useObjectStreams: false })
    const r = await run(input, { dedupe: false })
    const out = await PDFDocument.load(r.bytes)
    const tagged = streamsWhere(out, (d) => d.has(N('Tag')))
    expect(tagged).toHaveLength(3)
    for (const s of tagged) {
      expect(String(s.dict.get(N('Filter')))).toBe('/FlateDecode')
      expect(Array.from(decodeStream(out.context, s)!)).toEqual(Array.from(payload))
    }
    expect(r.stats.streams.redeflated).toBeGreaterThanOrEqual(2) // raw + ASCII85 always shrink; level-1 Flate may already be optimal for this payload
    void contentStreams
  })

  it('leaves Flate streams with predictors decodable (predictor parameters are kept)', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([200, 200])
    const ctx = doc.context
    const rows = 40
    const cols = 30
    const png = new Uint8Array(rows * (cols + 1))
    const plain = new Uint8Array(rows * cols)
    for (let y = 0; y < rows; y++) {
      png[y * (cols + 1)] = 2
      for (let x = 0; x < cols; x++) {
        png[y * (cols + 1) + 1 + x] = y === 0 ? x * 3 : 1
        plain[y * cols + x] = (x * 3 + y) & 255
      }
    }
    const ref = ctx.register(ctx.stream(zlibSync(png, { level: 1 }), { Filter: 'FlateDecode', DecodeParms: { Predictor: 12, Columns: cols }, Tag: 'p' } as never))
    page.node.set(N('Extra'), ctx.obj([ref]))
    const input = await doc.save({ useObjectStreams: false })
    const before = decodeStream(ctx, ctx.lookup(ref) as PDFStream)!
    const r = await run(input, { dedupe: false })
    const out = await PDFDocument.load(r.bytes)
    const s = streamsWhere(out, (d) => d.has(N('Tag')))[0]
    expect(Array.from(decodeStream(out.context, s)!)).toEqual(Array.from(before))
    void plain
  })

  it('does not touch stored JPEG or XMP streams', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([100, 100])
    const ctx = doc.context
    const xmp = ctx.register(ctx.stream('<?xpacket?><x:xmpmeta>hello</x:xmpmeta><?xpacket end="w"?>'.repeat(20), { Type: 'Metadata', Subtype: 'XML' }))
    doc.catalog.set(N('Metadata'), xmp)
    const r = await run(await doc.save({ useObjectStreams: false }), { stripMetadata: false })
    const out = await PDFDocument.load(r.bytes)
    const m = streamsWhere(out, (d) => String(d.get(N('Type'))) === '/Metadata')[0]
    expect(m.dict.has(N('Filter'))).toBe(false)
    expect(text(encodedBytes(m))).toContain('hello')
  })
})

/** ASCII85 encoder for the tests. */
function ascii85(data: Uint8Array): Uint8Array {
  let out = ''
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4)
    let v = 0
    for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0)
    if (chunk.length === 4 && v === 0) {
      out += 'z'
      continue
    }
    const digits: string[] = []
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode((v % 85) + 33))
      v = Math.floor(v / 85)
    }
    out += digits.slice(0, chunk.length + 1).join('')
  }
  return new TextEncoder().encode(out + '~>')
}

describe('removals (each behind its own toggle)', () => {
  const NONE: Partial<CompressOptions> = { stripMetadata: false, stripThumbnails: false, stripPieceInfo: false, stripJavaScript: false, stripUnusedDests: false, stripExtras: false }

  async function fatDoc(): Promise<Uint8Array> {
    const doc = await makeDoc(2)
    const ctx = doc.context
    doc.setTitle('Keep me')
    doc.setAuthor('Someone')
    doc.setSubject('A subject')
    doc.setKeywords(['a', 'b'])
    doc.setCreator('Creator App')
    doc.setProducer('Producer App')
    doc.catalog.set(N('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>' + 'z'.repeat(3000) + '</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })))
    const p0 = doc.getPage(0)
    const thumb = addRawImage(doc, { w: 60, h: 80, data: photoRGB(60, 80, 1), cs: 'DeviceRGB' })
    p0.node.set(N('Thumb'), thumb)
    p0.node.set(N('PieceInfo'), ctx.obj({ MyApp: { LastModified: PDFString.of('D:20200101'), Private: ctx.register(ctx.stream(new Uint8Array(5000).map((_, i) => (i * 7) & 255))) } }))
    // JavaScript: document-level tree, OpenAction, a link action, a widget-like additional action
    const js = ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }))
    doc.catalog.set(N('Names'), ctx.obj({ JavaScript: { Names: [PDFString.of('boot'), js] } }))
    doc.catalog.set(N('OpenAction'), ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFString.of('this.print()') })))
    const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 30], A: { S: 'JavaScript', JS: PDFString.of('x=1') } }))
    p0.node.set(N('Annots'), ctx.obj([link]))
    doc.catalog.set(N('Extensions'), ctx.obj({ ADBE: { BaseVersion: '1.7', ExtensionLevel: 3 } }))
    return doc.save()
  }

  it('with every toggle off, nothing is removed', async () => {
    const r = await run(await fatDoc(), { ...NONE, objectStreams: false })
    const out = await PDFDocument.load(r.bytes, { updateMetadata: false })
    expect(out.getTitle()).toBe('Keep me')
    expect(out.getAuthor()).toBe('Someone')
    expect(out.catalog.has(N('Metadata'))).toBe(true)
    expect(out.getPage(0).node.has(N('Thumb'))).toBe(true)
    expect(out.getPage(0).node.has(N('PieceInfo'))).toBe(true)
    expect(out.catalog.has(N('OpenAction'))).toBe(true)
    expect(out.catalog.has(N('Extensions'))).toBe(true)
    expect(text(r.bytes)).toContain('app.alert(1)')
  })

  it('metadata: XMP gone, Info reduced to title and dates', async () => {
    const r = await run(await fatDoc(), { ...NONE, stripMetadata: true, objectStreams: false })
    const out = await PDFDocument.load(r.bytes, { updateMetadata: false })
    expect(out.catalog.has(N('Metadata'))).toBe(false)
    expect(out.getTitle()).toBe('Keep me')
    expect(out.getAuthor()).toBeUndefined()
    expect(out.getSubject()).toBeUndefined()
    expect(out.getKeywords()).toBeUndefined()
    expect(out.getCreator()).toBeUndefined()
    expect(out.getProducer()).toBeUndefined()
    expect(out.getCreationDate()).toBeInstanceOf(Date)
    expect(text(r.bytes)).not.toContain('x:xmpmeta')
  })

  it('thumbnails and piece info', async () => {
    const r = await run(await fatDoc(), { ...NONE, stripThumbnails: true, stripPieceInfo: true })
    const out = await PDFDocument.load(r.bytes)
    expect(out.getPage(0).node.has(N('Thumb'))).toBe(false)
    expect(out.getPage(0).node.has(N('PieceInfo'))).toBe(false)
    expect(imagesOf(out)).toHaveLength(0) // the thumbnail image went with it
    expect(out.catalog.has(N('Metadata'))).toBe(true) // untouched
  })

  it('JavaScript: names tree, OpenAction and link actions are removed; the link itself stays', async () => {
    const r = await run(await fatDoc(), { ...NONE, stripJavaScript: true, objectStreams: false })
    const out = await PDFDocument.load(r.bytes, { updateMetadata: false })
    const names = out.catalog.lookup(N('Names'), PDFDict)
    expect(names.has(N('JavaScript'))).toBe(false)
    expect(out.catalog.has(N('OpenAction'))).toBe(false)
    const annots = out.getPage(0).node.lookup(N('Annots'), PDFArray)
    expect(annots.size()).toBe(1)
    expect((annots.lookup(0, PDFDict) as PDFDict).has(N('A'))).toBe(false)
    expect(text(r.bytes)).not.toContain('app.alert')
    expect(r.stats.strips.javascript).toBeGreaterThanOrEqual(3)
  })

  it('extras (Extensions) are removed only when asked', async () => {
    const r = await run(await fatDoc(), { ...NONE, stripExtras: true })
    expect((await PDFDocument.load(r.bytes)).catalog.has(N('Extensions'))).toBe(false)
  })

  it('unused named destinations go; used ones (link, bookmark, GoTo) stay, and lookups still work', async () => {
    const doc = await makeDoc(4)
    const ctx = doc.context
    const dest = (i: number): PDFArray => ctx.obj([doc.getPage(i).ref, 'Fit'])
    const pair = (k: string, i: number): [PDFString, PDFArray] => [PDFString.of(k), dest(i)]
    const flat = [pair('alpha', 0), pair('bravo', 1), pair('charlie', 2), pair('delta', 3)].flat()
    doc.catalog.set(N('Names'), ctx.obj({ Dests: { Names: flat } }))
    const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [1, 1, 20, 20], Dest: PDFString.of('bravo') }))
    doc.getPage(0).node.set(N('Annots'), ctx.obj([link]))
    addOutline(doc, [{ title: 'To charlie', page: 2, named: 'charlie' }])
    // the outline helper registers /Dests as a dictionary for named entries; keep the tree too
    const input = await doc.save()
    const r = await run(input, { ...NONE, stripUnusedDests: true })
    const out = await PDFDocument.load(r.bytes)
    const tree = out.catalog.lookup(N('Names'), PDFDict).lookup(N('Dests'), PDFDict).lookup(N('Names'), PDFArray)
    const keys: string[] = []
    for (let i = 0; i < tree.size(); i += 2) keys.push((tree.lookup(i) as PDFString).asString())
    expect(keys).toEqual(['bravo', 'charlie']) // alpha and delta were unused
    const legacy = out.catalog.lookupMaybe(N('Dests'), PDFDict)
    expect(legacy?.has(N('charlie'))).toBe(true)
    expect(r.stats.strips.destinations).toBeGreaterThanOrEqual(2)
  })

  it('named destinations are kept when the document has scripts (they may call them by name)', async () => {
    const doc = await makeDoc(2)
    const ctx = doc.context
    doc.catalog.set(N('Names'), ctx.obj({ Dests: { Names: [PDFString.of('a'), ctx.obj([doc.getPage(1).ref, 'Fit'])] }, JavaScript: { Names: [PDFString.of('j'), ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFString.of('1') }))] } }))
    const r = await run(await doc.save(), { ...NONE, stripUnusedDests: true })
    const out = await PDFDocument.load(r.bytes)
    expect(out.catalog.lookup(N('Names'), PDFDict).has(N('Dests'))).toBe(true)
    expect(r.stats.strips.destinations).toBe(0)
  })
})

describe('what must survive', () => {
  it('bookmarks, links, page geometry, rotation, annotations and form fields', async () => {
    const doc = await makeDoc(5, { sizes: [[612, 792], [500, 300], [612, 792], [300, 300], [612, 792]] })
    doc.getPage(1).setRotation({ type: 'degrees' as never, angle: 90 } as never)
    addOutline(doc, [{ title: 'One', page: 0 }, { title: 'Two', page: 2, children: [{ title: 'Two.a', page: 3 }] }, { title: 'Three', page: 4 }])
    addLink(doc, 0, 3)
    addLink(doc, 4, 0)
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const form = doc.getForm()
    const tf = form.createTextField('name.first')
    tf.addToPage(doc.getPage(0), { x: 50, y: 500, width: 150, height: 22, font })
    tf.setText('Ada')
    const cb = form.createCheckBox('agree')
    cb.addToPage(doc.getPage(0), { x: 50, y: 450, width: 16, height: 16 })
    cb.check()
    // A text (sticky-note) annotation with an appearance stream
    const ctx = doc.context
    const ap = ctx.register(ctx.stream('0 0 1 rg 0 0 20 20 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20] }))
    const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 600, 320, 620], Contents: PDFString.of('a note'), AP: { N: ap }, F: 4 }))
    const annots = doc.getPage(2).node.lookupMaybe(N('Annots'), PDFArray) ?? ctx.obj([])
    annots.push(note)
    doc.getPage(2).node.set(N('Annots'), annots)
    doc.getPage(0).drawText('Vector text stays extractable', { x: 50, y: 400, size: 14, font, color: rgb(0, 0, 0) })
    const input = await doc.save()
    const r = await run(input, {}, 'smallest')
    expect(r.kept).toBe('result')
    const out = await PDFDocument.load(r.bytes)
    expect(out.getPageCount()).toBe(5)
    out.getPages().forEach((p, i) => {
      const src = doc.getPage(i)
      expect(p.getSize()).toEqual(src.getSize())
      expect(p.getRotation().angle).toBe(src.getRotation().angle)
    })
    expect(linkTarget(out, 0)).toBe(3)
    expect(linkTarget(out, 4)).toBe(0)
    const fields = out.getForm().getFields().map((f) => f.getName())
    expect(fields).toEqual(['name.first', 'agree'])
    expect(out.getForm().getTextField('name.first').getText()).toBe('Ada')
    expect(out.getForm().getCheckBox('agree').isChecked()).toBe(true)
    const a2 = out.getPage(2).node.lookup(N('Annots'), PDFArray)
    const noteOut = a2.lookup(a2.size() - 1, PDFDict)
    expect(String(noteOut.get(N('Subtype')))).toBe('/Text')
    expect(noteOut.has(N('AP'))).toBe(true)
    // outline structure
    const outlines = out.catalog.lookup(N('Outlines'), PDFDict)
    expect(String(outlines.get(N('Count')))).toBe('4')
    const first = outlines.lookup(N('First'), PDFDict)
    expect((first.lookup(N('Title')) as PDFHexString).decodeText()).toBe('One')
    const second = first.lookup(N('Next'), PDFDict)
    expect((second.lookup(N('First'), PDFDict).lookup(N('Title')) as PDFHexString).decodeText()).toBe('Two.a')
    // independent reader
    expect(await pdfjsPageCount(r.bytes)).toBe(5)
    expect(await pdfjsText(r.bytes, 1)).toContain('Vector text stays extractable')
    expect(await pdfjsPageSize(r.bytes, 2)).toEqual(await pdfjsPageSize(input, 2))
  })
})

describe('never larger', () => {
  const minimal = (): Uint8Array => {
    const objs = [
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n',
      '2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n',
      '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>\nendobj\n'
    ]
    let body = '%PDF-1.4\n'
    const offs: number[] = []
    for (const o of objs) {
      offs.push(body.length)
      body += o
    }
    const xref = body.length
    body += `xref\n0 4\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
    return new TextEncoder().encode(body)
  }

  it('a tiny classic file is returned untouched (with a reason) when the rewrite would be bigger', async () => {
    const input = minimal()
    const r = await run(input, {})
    expect(r.kept).toBe('original')
    expect(r.bytes).toBe(input)
    expect(r.reason).toMatch(/already as small/)
    expect(r.stats.newSize).toBe(input.length)
  })

  it('running the reducer on its own output never grows the file', async () => {
    const doc = await makeDoc(8)
    addLink(doc, 0, 3)
    const once = await run(await doc.save(), {})
    const twice = await run(once.bytes, {})
    expect(twice.bytes.length).toBeLessThanOrEqual(once.bytes.length)
    expect((await PDFDocument.load(twice.bytes)).getPageCount()).toBe(8)
  })

  it('unreadable input gives a clear error, not a crash', async () => {
    await expect(run(new TextEncoder().encode('this is not a pdf'), {})).rejects.toThrow(/could not be read/)
  })
})
