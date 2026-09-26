import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { DestinationResolver } from '../../src/shared/features/destinations'
import { pdfRectToView, geomOfPage, type Rect } from '../../src/renderer/src/features/markup/pdf/geometry'
import { hitLink, linkContains, regionFromViewRects, rectOfQuads, scaleQuads, translateQuads, viewRectToLinkRect } from '../../src/renderer/src/features/links/pdf/geometry'
import { INVISIBLE_BORDER, THIN_BORDER, describeTarget, type LinkBorder } from '../../src/renderer/src/features/links/pdf/model'
import { addLink, addLinks, deleteLink, LinkError, moveLink, removeAllLinks, resizeLink, updateLink } from '../../src/renderer/src/features/links/pdf/ops'
import { readLinks } from '../../src/renderer/src/features/links/pdf/read'
import { checkUrl, findLinkables } from '../../src/renderer/src/features/links/pdf/url'
import { pdfjsLinks } from './helpers/lbPdfjs'
import { addOutline, makeDoc, reload } from './pdfTestUtils'

const N = (s: string): PDFName => PDFName.of(s)
const RECT: Rect = [50, 600, 250, 630]
const back = async (doc: PDFDocument): Promise<{ pdf: PDFDocument; bytes: Uint8Array }> => {
  const bytes = await doc.save()
  return { pdf: await reload(bytes), bytes }
}

describe('link annotations: writing every kind of target', () => {
  it('writes a URI link that pdf-lib and PDF.js both understand, with print flag and border', async () => {
    const doc = await makeDoc(2)
    const id = addLink(doc, 0, { rect: RECT, target: { kind: 'uri', uri: 'https://example.com/a?b=1&c=(2)' }, border: THIN_BORDER() })
    const { pdf, bytes } = await back(doc)
    const [l] = readLinks(pdf)
    expect(l.id).toBe(id)
    expect(l.pageIndex).toBe(0)
    expect(l.rect).toEqual(RECT)
    expect(l.target).toEqual({ kind: 'uri', uri: 'https://example.com/a?b=1&c=(2)' })
    expect(l.flags & 4).toBe(4)
    expect(l.ours).toBe(true)
    expect(l.border.width).toBe(1)
    const annot = pdf.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict)
    expect(annot.lookup(N('Subtype'), PDFName).decodeText()).toBe('Link')
    expect(annot.lookup(N('A'), PDFDict).lookup(N('S'), PDFName).decodeText()).toBe('URI')
    expect(annot.has(N('AP'))).toBe(true)
    const pjs = await pdfjsLinks(bytes, 1)
    expect(pjs).toHaveLength(1)
    expect(pjs[0].url).toBe('https://example.com/a?b=1&c=(2)')
    expect(pjs[0].rect.map(Math.round)).toEqual(RECT)
  })

  it('writes mailto: and tel: links', async () => {
    const doc = await makeDoc(1)
    addLink(doc, 0, { rect: RECT, target: { kind: 'uri', uri: 'name@example.com' }, border: INVISIBLE_BORDER })
    addLink(doc, 0, { rect: [50, 500, 250, 530], target: { kind: 'uri', uri: 'tel:+974 4444 4444' }, border: INVISIBLE_BORDER })
    const { bytes } = await back(doc)
    expect((await pdfjsLinks(bytes, 1)).map((l) => l.url)).toEqual(['mailto:name@example.com', 'tel:+97444444444'])
  })

  it('writes a page link with each destination type and resolves it in PDF.js', async () => {
    const doc = await makeDoc(4)
    const kinds: [string, (string | number | null)[]][] = [
      ['XYZ', ['XYZ', 12, 700, null]],
      ['Fit', ['Fit']],
      ['FitH', ['FitH', 500]],
      ['FitR', ['FitR', 10, 10, 200, 300]]
    ]
    kinds.forEach(([, tail], i) => addLink(doc, 0, { rect: [10, 10 + i * 40, 110, 40 + i * 40], target: { kind: 'page', pageIndex: 2 + (i % 2), tail }, border: INVISIBLE_BORDER }))
    const { pdf, bytes } = await back(doc)
    const links = readLinks(pdf)
    expect(links.map((l) => (l.target.kind === 'page' ? [l.target.dest.pageIndex, ...l.target.dest.tail] : null))).toEqual([
      [2, 'XYZ', 12, 700, null],
      [3, 'Fit'],
      [2, 'FitH', 500],
      [3, 'FitR', 10, 10, 200, 300]
    ])
    expect((await pdfjsLinks(bytes, 1)).map((l) => l.page)).toEqual([3, 4, 3, 4])
    expect(links.every((l) => l.target.kind === 'page' && l.target.via === 'dest')).toBe(true)
  })

  it('writes a named-destination link (name tree and /Dests dictionary) and refuses unknown names', async () => {
    const doc = await makeDoc(3)
    addOutline(doc, [{ title: 'Ch', named: 'chapter-2', page: 1 }])
    // A second name in the PDF 1.1 style /Dests dictionary of the catalog.
    const dests = doc.catalog.lookup(N('Dests'), PDFDict)
    dests.set(N('legacy'), doc.context.obj([doc.getPage(2).ref, 'Fit']))
    addLink(doc, 0, { rect: RECT, target: { kind: 'named', name: 'chapter-2' }, border: INVISIBLE_BORDER })
    addLink(doc, 0, { rect: [50, 500, 250, 530], target: { kind: 'named', name: 'legacy' }, border: INVISIBLE_BORDER })
    expect(() => addLink(doc, 0, { rect: RECT, target: { kind: 'named', name: 'nope' }, border: INVISIBLE_BORDER })).toThrow(LinkError)
    const { pdf, bytes } = await back(doc)
    const links = readLinks(pdf)
    expect(links.map((l) => l.target)).toMatchObject([
      { kind: 'page', named: 'chapter-2', dest: { pageIndex: 1 } },
      { kind: 'page', named: 'legacy', dest: { pageIndex: 2 } }
    ])
    expect((await pdfjsLinks(bytes, 1)).map((l) => l.page)).toEqual([2, 3])
    expect(new DestinationResolver(pdf).namedDestinations().map((d) => [d.name, d.pageIndex])).toEqual([['chapter-2', 1], ['legacy', 2]])
  })

  it('rejects unsafe or malformed targets and leaves the document untouched', async () => {
    const doc = await makeDoc(2)
    for (const uri of ['javascript:alert(1)', 'file:///C:/Windows/system.ini', 'data:text/html,<script>1</script>', 'ftp://x.test', 'notaurl']) {
      expect(() => addLink(doc, 0, { rect: RECT, target: { kind: 'uri', uri }, border: INVISIBLE_BORDER })).toThrow(LinkError)
    }
    expect(() => addLink(doc, 0, { rect: RECT, target: { kind: 'page', pageIndex: 9, tail: ['Fit'] }, border: INVISIBLE_BORDER })).toThrow(/does not exist/)
    expect(() => addLink(doc, 5, { rect: RECT, target: { kind: 'uri', uri: 'https://a.test' }, border: INVISIBLE_BORDER })).toThrow(/does not exist/)
    expect(readLinks(doc)).toHaveLength(0)
  })

  it('writes invisible links without border or appearance, and dashed coloured borders with both', async () => {
    const doc = await makeDoc(1)
    addLink(doc, 0, { rect: RECT, target: { kind: 'uri', uri: 'https://a.test' }, border: INVISIBLE_BORDER })
    const dashed: LinkBorder = { width: 2, dashed: true, color: [1, 0, 0] }
    addLink(doc, 0, { rect: [50, 500, 250, 530], target: { kind: 'uri', uri: 'https://b.test' }, border: dashed })
    const { pdf, bytes } = await back(doc)
    const [a, b] = readLinks(pdf)
    expect(a.border).toEqual(INVISIBLE_BORDER)
    expect(b.border).toEqual(dashed)
    const annots = pdf.getPage(0).node.lookup(N('Annots'), PDFArray)
    expect(annots.lookup(0, PDFDict).has(N('AP'))).toBe(false)
    const ap = annots.lookup(1, PDFDict).lookup(N('AP'), PDFDict).lookup(N('N')) as unknown as { getContents(): Uint8Array }
    expect(Buffer.from(ap.getContents()).toString('latin1')).toMatch(/1 0 0 RG[\s\S]*\[3 3\] 0 d[\s\S]*re S/)
    const pjs = await pdfjsLinks(bytes, 1)
    expect(pjs.map((l) => l.borderWidth)).toEqual([0, 2])
  })

  it('describes targets for the UI', () => {
    expect(describeTarget({ kind: 'uri', uri: 'https://a.test' })).toBe('https://a.test')
    expect(describeTarget({ kind: 'page', dest: { pageIndex: 2, tail: ['Fit'] }, via: 'dest' })).toBe('Page 3')
    expect(describeTarget({ kind: 'other', action: 'Launch', detail: 'a.exe' })).toBe('Launch: a.exe')
  })
})

describe('link annotations: editing links, including ones from other software', () => {
  async function foreignDoc(): Promise<{ doc: PDFDocument; ids: string[] }> {
    const doc = await makeDoc(3)
    const ctx = doc.context
    const mk = (extra: Record<string, unknown>, rect: number[]): PDFRef =>
      ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], ...extra } as never))
    const refs = [
      mk({ A: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } }, [10, 10, 110, 40]),
      mk({ A: { S: 'GoToR', F: PDFString.of('other.pdf'), D: [0, 'Fit'] } }, [10, 60, 110, 90]),
      mk({ A: { S: 'Launch', F: PDFString.of('run.bat') } }, [10, 110, 110, 140]),
      mk({ A: { S: 'URI', URI: PDFString.of('http://old.test/') }, AA: { E: { S: 'JavaScript', JS: PDFString.of('x') } }, 'X-Vendor': 7 }, [10, 160, 110, 190]),
      mk({ Dest: [doc.getPage(2).ref, 'Fit'] }, [10, 210, 110, 240]),
      mk({ A: { S: 'GoTo', D: [doc.getPage(1).ref, 'XYZ', 5, 5, null] } }, [10, 260, 110, 290])
    ]
    doc.getPage(0).node.set(N('Annots'), ctx.obj(refs))
    return { doc, ids: refs.map((r) => `${r.objectNumber} ${r.generationNumber}`) }
  }

  it('reads every kind of foreign link and shows non-GoTo/URI actions read-only', async () => {
    const { doc } = await foreignDoc()
    const targets = readLinks(await reload(await doc.save())).map((l) => l.target)
    expect(targets).toMatchObject([
      { kind: 'other', action: 'JavaScript' },
      { kind: 'other', action: 'GoToR', detail: 'other.pdf' },
      { kind: 'other', action: 'Launch', detail: 'run.bat' },
      { kind: 'uri', uri: 'http://old.test/' },
      { kind: 'page', via: 'dest', dest: { pageIndex: 2 } },
      { kind: 'page', via: 'action', dest: { pageIndex: 1, tail: ['XYZ', 5, 5, null] } }
    ])
  })

  it('moving, resizing and restyling preserve JavaScript / GoToR / Launch actions and unknown keys exactly', async () => {
    const { doc, ids } = await foreignDoc()
    const before = (id: string): string => {
      const d = doc.context.lookup(PDFRef.of(+id.split(' ')[0], 0), PDFDict)
      return (d.lookup(N('A'), PDFDict) as PDFDict).toString()
    }
    const actions = ids.slice(0, 4).map(before)
    for (const id of ids.slice(0, 4)) {
      moveLink(doc, id, 5, -5)
      resizeLink(doc, id, [20, 20, 200, 80])
      updateLink(doc, id, { border: THIN_BORDER([0, 0.5, 0]), contents: 'Tooltip' })
    }
    const { pdf } = await back(doc)
    const links = readLinks(pdf).slice(0, 4)
    expect(links.map((l) => l.rect)).toEqual([[20, 20, 200, 80], [20, 20, 200, 80], [20, 20, 200, 80], [20, 20, 200, 80]])
    expect(links.map((l) => l.border.width)).toEqual([1, 1, 1, 1])
    expect(links.map((l) => l.contents)).toEqual(['Tooltip', 'Tooltip', 'Tooltip', 'Tooltip'])
    ids.slice(0, 4).forEach((id, i) => {
      const d = pdf.context.lookup(PDFRef.of(+id.split(' ')[0], 0), PDFDict)
      expect((d.lookup(N('A'), PDFDict) as PDFDict).toString()).toBe(actions[i])
    })
    // The URI link's extra keys survive too.
    const d = pdf.context.lookup(PDFRef.of(+ids[3].split(' ')[0], 0), PDFDict)
    expect(d.has(N('AA'))).toBe(true)
    expect(d.lookup(N('X-Vendor'), PDFNumber).asNumber()).toBe(7)
  })

  it('changing the target replaces the action or destination, and never leaves both', async () => {
    const { doc, ids } = await foreignDoc()
    updateLink(doc, ids[0], { target: { kind: 'uri', uri: 'https://safe.test' } }) // JavaScript → URI
    updateLink(doc, ids[3], { target: { kind: 'page', pageIndex: 1, tail: ['Fit'] } }) // URI → page
    updateLink(doc, ids[4], { target: { kind: 'uri', uri: 'mailto:a@b.test' } }) // page → URI
    updateLink(doc, ids[5], { target: { kind: 'page', pageIndex: 2, tail: ['FitH', 100] } }) // GoTo action → Dest
    const { pdf } = await back(doc)
    const dicts = ids.map((id) => pdf.context.lookup(PDFRef.of(+id.split(' ')[0], 0), PDFDict))
    for (const i of [0, 3, 4, 5]) expect(dicts[i].has(N('Dest')) && dicts[i].has(N('A'))).toBe(false)
    expect(readLinks(pdf).map((l) => l.target.kind)).toEqual(['uri', 'other', 'other', 'page', 'uri', 'page'])
    expect(() => updateLink(doc, ids[1], { target: { kind: 'uri', uri: 'javascript:1' } })).toThrow(LinkError)
  })

  it('deletes one link or every link of a page or of the document, and only links', async () => {
    const { doc, ids } = await foreignDoc()
    // A non-link annotation and a link on page 2 must survive removals aimed at page 1.
    const note = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [1, 1, 20, 20], Contents: PDFString.of('n') }))
    doc.getPage(0).node.lookup(N('Annots'), PDFArray).push(note)
    addLink(doc, 1, { rect: RECT, target: { kind: 'uri', uri: 'https://p2.test' }, border: INVISIBLE_BORDER })
    deleteLink(doc, ids[0])
    expect(readLinks(doc)).toHaveLength(6)
    expect(() => deleteLink(doc, ids[0])).toThrow(/no longer exists/)
    expect(removeAllLinks(doc, 0)).toBe(5)
    expect(readLinks(doc).map((l) => l.pageIndex)).toEqual([1])
    const annots = doc.getPage(0).node.lookup(N('Annots'), PDFArray)
    expect(annots.size()).toBe(1) // just the note
    expect(removeAllLinks(doc)).toBe(1)
    expect(readLinks(doc)).toHaveLength(0)
  })

  it('adds several links in one call (auto-detect, multi-page selection)', async () => {
    const doc = await makeDoc(3)
    const ids = addLinks(doc, [
      { pageIndex: 0, spec: { rect: RECT, target: { kind: 'uri', uri: 'https://a.test' }, border: INVISIBLE_BORDER } },
      { pageIndex: 2, spec: { rect: RECT, target: { kind: 'uri', uri: 'https://b.test' }, border: INVISIBLE_BORDER } }
    ])
    expect(new Set(ids).size).toBe(2)
    expect(readLinks(doc).map((l) => l.pageIndex)).toEqual([0, 2])
    expect(() => addLinks(doc, [])).toThrow(LinkError)
  })

  it('works on pages whose /Annots is an indirect array or missing, and keeps a shared array shared', async () => {
    const doc = await makeDoc(2)
    const arr = doc.context.register(doc.context.obj([]))
    doc.getPage(0).node.set(N('Annots'), arr)
    addLink(doc, 0, { rect: RECT, target: { kind: 'uri', uri: 'https://a.test' }, border: INVISIBLE_BORDER })
    addLink(doc, 1, { rect: RECT, target: { kind: 'uri', uri: 'https://b.test' }, border: INVISIBLE_BORDER })
    expect(doc.getPage(0).node.get(N('Annots'))).toBeInstanceOf(PDFRef)
    expect((doc.context.lookup(arr) as PDFArray).size()).toBe(1)
    expect(readLinks(await reload(await doc.save()))).toHaveLength(2)
  })
})

describe('link geometry: rotation, CropBox offsets, QuadPoints', () => {
  const rotatedDoc = async (rotate: number, crop?: Rect): Promise<PDFDocument> => {
    const doc = await makeDoc(1)
    const p = doc.getPage(0)
    p.setRotation(degrees(rotate))
    if (crop) p.setCropBox(crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1])
    return doc
  }

  for (const rotate of [0, 90, 180, 270]) {
    for (const crop of [undefined, [30, 40, 500, 700] as Rect]) {
      it(`a rectangle drawn on the displayed page maps to the right PDF rect (rotate ${rotate}${crop ? ', CropBox offset' : ''})`, async () => {
        const doc = await rotatedDoc(rotate, crop)
        const g = geomOfPage(doc.getPage(0))
        const view: Rect = [20, 30, 120, 70] // drawn on the displayed page, in points from its top-left
        const pdfRect = viewRectToLinkRect(g, view)
        expect(pdfRect[0]).toBeLessThan(pdfRect[2])
        expect(pdfRect[1]).toBeLessThan(pdfRect[3])
        const roundTrip = pdfRectToView(g, pdfRect)
        expect(roundTrip.map((v) => Math.round(v * 1000) / 1000)).toEqual(view)
        // The rect stays inside the visible box.
        expect(pdfRect[0]).toBeGreaterThanOrEqual(g.box[0] - 1e-6)
        expect(pdfRect[3]).toBeLessThanOrEqual(g.box[3] + 1e-6)
        // And a link written with it is found at its centre by the hit test.
        addLink(doc, 0, { rect: pdfRect, target: { kind: 'uri', uri: 'https://a.test' }, border: INVISIBLE_BORDER })
        const [l] = readLinks(await reload(await doc.save()))
        expect(linkContains(l, (pdfRect[0] + pdfRect[2]) / 2, (pdfRect[1] + pdfRect[3]) / 2)).toBe(true)
        expect(linkContains(l, pdfRect[2] + 20, pdfRect[3] + 20)).toBe(false)
      })
    }
  }

  it('builds one quad per selected line (top-left, top-right, bottom-left, bottom-right) and a bounding rect', async () => {
    const doc = await rotatedDoc(0)
    const g = geomOfPage(doc.getPage(0)) // 612 x 792
    const lines: Rect[] = [[100, 100, 300, 112], [72, 114, 200, 126]]
    const region = regionFromViewRects(g, lines)!
    expect(region.quads).toHaveLength(2)
    // View y grows downwards; PDF y grows upwards: the first quad's top edge is at PDF y = 792 - 100.
    expect(region.quads[0]).toEqual([100, 692, 300, 692, 100, 680, 300, 680])
    expect(region.rect).toEqual([72, 666, 300, 692])
    expect(rectOfQuads(region.quads)).toEqual(region.rect)
    // A single line needs no QuadPoints.
    expect(regionFromViewRects(g, [lines[0]])!.quads).toEqual([])
    expect(regionFromViewRects(g, [])).toBeNull()
  })

  it('writes QuadPoints, hit-tests inside the quads only, and moves/resizes them with the link', async () => {
    const doc = await makeDoc(1)
    const g = geomOfPage(doc.getPage(0))
    const region = regionFromViewRects(g, [[100, 100, 300, 112], [72, 114, 200, 126]])!
    const id = addLink(doc, 0, { rect: region.rect, quads: region.quads, target: { kind: 'uri', uri: 'https://a.test' }, border: INVISIBLE_BORDER })
    let [l] = readLinks(await reload(await doc.save()))
    expect(l.quads).toEqual(region.quads)
    // (250, 670) is inside the union rect but to the right of the second line: not on the link.
    expect(linkContains(l, 150, 686)).toBe(true) // first line
    expect(linkContains(l, 250, 673)).toBe(false) // beside the second line
    expect(linkContains(l, 150, 673)).toBe(true) // second line
    moveLink(doc, id, 10, 20)
    ;[l] = readLinks(await reload(await doc.save()))
    expect(l.quads[0]).toEqual([110, 712, 310, 712, 110, 700, 310, 700])
    expect(l.rect).toEqual([82, 686, 310, 712])
    resizeLink(doc, id, [82, 686, 82 + 2 * 228, 712])
    ;[l] = readLinks(await reload(await doc.save()))
    expect(l.quads[1][0]).toBeCloseTo(82, 5) // left edge of line 2 stays at the rect's left edge
    expect(l.quads[0][2]).toBeCloseTo(82 + 2 * 228, 5) // right edge of line 1 follows the rect
    const doubled = scaleQuads(region.quads, region.rect, [region.rect[0], region.rect[1], region.rect[2] + 228, region.rect[3]])
    expect(doubled[0][2]).toBeGreaterThan(region.quads[0][2])
    expect(translateQuads(region.quads, 1, 1)[0][0]).toBe(101)
  })

  it('hit test: the smallest link wins, a border widens the target, other pages are ignored', async () => {
    const doc = await makeDoc(2)
    addLink(doc, 0, { rect: [0, 0, 400, 400], target: { kind: 'uri', uri: 'https://big.test' }, border: INVISIBLE_BORDER })
    addLink(doc, 0, { rect: [100, 100, 150, 130], target: { kind: 'uri', uri: 'https://small.test' }, border: { width: 4, dashed: false, color: null } })
    addLink(doc, 1, { rect: [0, 0, 400, 400], target: { kind: 'uri', uri: 'https://p2.test' }, border: INVISIBLE_BORDER })
    const links = readLinks(await reload(await doc.save()))
    const at = (p: number, x: number, y: number, tol = 0): string | undefined => {
      const h = hitLink(links, p, x, y, tol)
      return h && h.target.kind === 'uri' ? h.target.uri : undefined
    }
    expect(at(0, 120, 110)).toBe('https://small.test/')
    expect(at(0, 300, 300)).toBe('https://big.test/')
    expect(at(0, 151, 110)).toBe('https://small.test/') // the 4pt border adds 2pt
    expect(at(0, 500, 500)).toBeUndefined()
    expect(at(0, 500, 500, 200)).toBe('https://big.test/')
    expect(at(1, 10, 10)).toBe('https://p2.test/')
  })
})

describe('link addresses', () => {
  const ok = (s: string): string => {
    const r = checkUrl(s)
    if (!r.ok) throw new Error(r.reason)
    return r.url
  }

  it('accepts and normalises http, https, mailto and tel; completes www. and e-mail addresses', () => {
    expect(ok('https://example.com')).toBe('https://example.com/')
    expect(ok('  HTTP://Example.COM/a b'.replace(' b', '%20b'))).toBe('http://example.com/a%20b')
    expect(ok('www.example.com/x')).toBe('https://www.example.com/x')
    expect(ok('name@example.com')).toBe('mailto:name@example.com')
    expect(ok('mailto:a@b.co?subject=Hi there'.replace(' ', '%20'))).toBe('mailto:a@b.co?subject=Hi%20there')
    expect(ok('tel:+974 4444 4444')).toBe('tel:+97444444444')
    expect(ok('https://bücher.example/straße')).toMatch(/^https:\/\/xn--bcher-kva\.example\/stra%C3%9Fe$/)
    expect(ok('https://مثال.إختبار/صفحة')).toMatch(/^https:\/\/xn--[a-z0-9.-]+\/%D8%B5/)
  })

  it('refuses dangerous, unsupported and malformed addresses with a reason', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html;base64,AAAA',
      'vbscript:x',
      'ftp://example.com',
      'ms-msdt:/id',
      'https://user:pass@example.com',
      'https://',
      'http://exa mple.com',
      'https://example.com/\u0000',
      'mailto:',
      'mailto:notanaddress',
      'tel:abc',
      'localhost:3000',
      'just words',
      '',
      '   ',
      'https://' + 'a'.repeat(3000)
    ]) {
      const r = checkUrl(bad)
      expect(r.ok, bad.slice(0, 40)).toBe(false)
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(5)
    }
  })

  it('finds web and e-mail addresses in text, without trailing punctuation', () => {
    const text = 'See https://example.com/docs, or (www.example.org/page).\nMail me@example.com! Wikipedia: https://en.wikipedia.org/wiki/Foo_(bar). End.'
    const found = findLinkables(text).map((f) => [f.text, f.url, f.kind])
    expect(found).toEqual([
      ['https://example.com/docs', 'https://example.com/docs', 'web'],
      ['www.example.org/page', 'https://www.example.org/page', 'web'],
      ['me@example.com', 'mailto:me@example.com', 'email'],
      ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'web']
    ])
    const f = findLinkables('x https://a.test/y z')[0]
    expect(text.slice(0, 0) + 'x https://a.test/y z'.slice(f.start, f.end)).toBe('https://a.test/y')
  })

  it('finds addresses inside Arabic and Hebrew sentences', () => {
    const found = findLinkables('لمزيد من المعلومات زوروا https://example.com/ar، أو راسلونا على info@example.com؛ תודה www.example.co.il.')
    expect(found.map((f) => f.text)).toEqual(['https://example.com/ar', 'info@example.com', 'www.example.co.il'])
  })

  it('does not link things that are not addresses', () => {
    expect(findLinkables('version 1.2.3 and file.txt and e.g. this')).toEqual([])
    expect(findLinkables('javascript:alert(1) and ftp://x.test')).toEqual([])
  })
})

describe('PDF object sanity', () => {
  it('link strings survive as hex/literal strings in the saved file', async () => {
    const doc = await makeDoc(1)
    addLink(doc, 0, { rect: RECT, target: { kind: 'uri', uri: 'https://a.test/x' }, border: INVISIBLE_BORDER, contents: 'وصف الرابط' })
    const { pdf } = await back(doc)
    const annot = pdf.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict)
    expect(annot.lookup(N('Contents'))).toBeInstanceOf(PDFHexString)
    expect(readLinks(pdf)[0].contents).toBe('وصف الرابط')
  })
})
