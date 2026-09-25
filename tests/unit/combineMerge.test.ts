import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { MergeError, mergePdfs, probePdf } from '../../src/main/features/combine/merge'
import { parsePageRange } from '../../src/shared/features/combine'
import { makeEncryptedLookingPdf, makePdf, readOutline } from '../support/pdfs'

const load = (b: Uint8Array): Promise<PDFDocument> => PDFDocument.load(b)

describe('parsePageRange', () => {
  it('treats empty text as all pages', () => {
    expect(parsePageRange('', 3)).toEqual({ ok: true, pages: [0, 1, 2] })
    expect(parsePageRange(undefined, 2)).toEqual({ ok: true, pages: [0, 1] })
  })
  it('parses lists, ranges and open ranges in the order written', () => {
    expect(parsePageRange('3, 1-2', 5)).toEqual({ ok: true, pages: [2, 0, 1] })
    expect(parsePageRange('4-', 6)).toEqual({ ok: true, pages: [3, 4, 5] })
    expect(parsePageRange('-2', 6)).toEqual({ ok: true, pages: [0, 1] })
    expect(parsePageRange(' 2 ', 6)).toEqual({ ok: true, pages: [1] })
  })
  it('rejects malformed, backwards and out-of-range input with a helpful message', () => {
    expect(parsePageRange('abc', 5)).toMatchObject({ ok: false })
    expect(parsePageRange('0', 5)).toMatchObject({ ok: false })
    expect(parsePageRange('6', 5)).toEqual({ ok: false, error: 'This file has only 5 pages.' })
    expect(parsePageRange('4-2', 5)).toMatchObject({ ok: false, error: expect.stringContaining('backwards') })
    expect(parsePageRange('1-9', 5)).toMatchObject({ ok: false })
    expect(parsePageRange(',', 5)).toMatchObject({ ok: false })
  })
})

describe('mergePdfs', () => {
  it('keeps every page, in order, with its own size and rotation', async () => {
    const a = await makePdf({ sizes: [[612, 792], [792, 612]], label: 'A', rotate: { 2: 90 } })
    const b = await makePdf({ sizes: [[300, 400]], label: 'B' })
    const r = await mergePdfs([{ name: 'a.pdf', bytes: a }, { name: 'b.pdf', bytes: b }], { bookmarks: false })
    expect(r.pageCount).toBe(3)
    const doc = await load(r.bytes)
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight(), p.getRotation().angle])).toEqual([
      [612, 792, 0],
      [792, 612, 90],
      [300, 400, 0]
    ])
  })

  it('takes only the selected pages, in the requested order', async () => {
    const a = await makePdf({ pages: 5, label: 'A' })
    const b = await makePdf({ sizes: [[100, 100], [200, 200], [300, 300]], label: 'B' })
    const r = await mergePdfs(
      [
        { name: 'a.pdf', bytes: a, pages: [3, 0] },
        { name: 'b.pdf', bytes: b, pages: [2, 1] }
      ],
      { bookmarks: false }
    )
    const doc = await load(r.bytes)
    expect(doc.getPageCount()).toBe(4)
    expect(doc.getPages().slice(2).map((p) => p.getWidth())).toEqual([300, 200])
  })

  it('adds one bookmark per file with the file’s own bookmarks nested below it', async () => {
    const a = await makePdf({ pages: 3, label: 'A', outline: [{ title: 'Intro', page: 1 }, { title: 'Part', page: 2, children: [{ title: 'Sub', page: 3 }] }] })
    const b = await makePdf({ pages: 2, label: 'B' })
    const c = await makePdf({ pages: 2, label: 'C', outline: [{ title: 'Only', page: 2 }] })
    const r = await mergePdfs(
      [{ name: 'a.pdf', bytes: a }, { name: 'b.pdf', bytes: b }, { name: 'c.pdf', bytes: c }],
      { bookmarks: true }
    )
    const doc = await load(r.bytes)
    expect(readOutline(doc)).toEqual([
      {
        title: 'a',
        pageIndex: 0,
        children: [
          { title: 'Intro', pageIndex: 0, children: [] },
          { title: 'Part', pageIndex: 1, children: [{ title: 'Sub', pageIndex: 2, children: [] }] }
        ]
      },
      { title: 'b', pageIndex: 3, children: [] },
      { title: 'c', pageIndex: 5, children: [{ title: 'Only', pageIndex: 6, children: [] }] }
    ])
  })

  it('drops bookmarks that point at pages outside the selected range and offsets the rest', async () => {
    const a = await makePdf({ pages: 4, outline: [{ title: 'One', page: 1 }, { title: 'Three', page: 3 }, { title: 'Four', page: 4 }] })
    const r = await mergePdfs([{ name: 'a.pdf', bytes: a, pages: [2, 3] }], { bookmarks: true })
    const tree = readOutline(await load(r.bytes))
    // 0-based pages [2, 3] are the source's pages 3 and 4; "One" (page 1) is gone.
    expect(tree[0].children).toEqual([
      { title: 'Three', pageIndex: 0, children: [] },
      { title: 'Four', pageIndex: 1, children: [] }
    ])
  })

  it('without per-file bookmarks it still keeps each source’s own outline', async () => {
    const a = await makePdf({ pages: 2, outline: [{ title: 'A1', page: 2 }] })
    const b = await makePdf({ pages: 2, outline: [{ title: 'B1', page: 1 }] })
    const r = await mergePdfs([{ name: 'a.pdf', bytes: a }, { name: 'b.pdf', bytes: b }], { bookmarks: false })
    expect(readOutline(await load(r.bytes)).map((n) => [n.title, n.pageIndex])).toEqual([['A1', 1], ['B1', 2]])
  })

  it('renames clashing form field names and keeps every field on its page', async () => {
    const a = await makePdf({ pages: 1, label: 'A', fields: ['name', 'email'] })
    const b = await makePdf({ pages: 1, label: 'B', fields: ['name', 'phone'] })
    const c = await makePdf({ pages: 1, label: 'C', fields: ['name'] })
    const r = await mergePdfs([{ name: 'a.pdf', bytes: a }, { name: 'b.pdf', bytes: b }, { name: 'c.pdf', bytes: c }], { bookmarks: false })
    expect(r.renamedFields).toEqual([
      { file: 'b.pdf', from: 'name', to: 'name_2' },
      { file: 'c.pdf', from: 'name', to: 'name_3' }
    ])
    const doc = await load(r.bytes)
    const fields = doc.getForm().getFields()
    expect(fields.map((f) => f.getName()).sort()).toEqual(['email', 'name', 'name_2', 'name_3', 'phone'])
    // values survive, and each widget sits on the right page
    expect(doc.getForm().getTextField('name_2').getText()).toBe('B:name')
    const widgetPages = fields.map((f) => f.acroField.getWidgets().map((w) => w.P()?.tag))
    const pageTags = doc.getPages().map((p) => p.ref.tag)
    expect(widgetPages.flat().every((t) => t && pageTags.includes(t))).toBe(true)
    expect(doc.getForm().getTextField('phone').acroField.getWidgets()[0].P()?.tag).toBe(pageTags[1])
  })

  it('re-points internal links at the copied pages and drops links to pages that were not taken', async () => {
    const a = await makePdf({ pages: 4, label: 'A', links: [[1, 4]] })
    const first = await makePdf({ pages: 3, label: 'F' })
    const r = await mergePdfs([{ name: 'f.pdf', bytes: first }, { name: 'a.pdf', bytes: a }], { bookmarks: false })
    const doc = await load(r.bytes)
    const annots = doc.getPage(3).node.lookup(PDFName.of('Annots'), PDFArray)
    const link = annots.lookup(0, PDFDict)
    const dest = link.lookup(PDFName.of('Dest'), PDFArray)
    expect((dest.get(0) as PDFRef).tag).toBe(doc.getPage(3 + 3).ref.tag)
    expect(doc.getPageCount()).toBe(7)

    const partial = await mergePdfs([{ name: 'a.pdf', bytes: a, pages: [0, 1] }], { bookmarks: false })
    const pdoc = await load(partial.bytes)
    const plink = pdoc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict)
    expect(plink.get(PDFName.of('Dest'))).toBeUndefined()
    // and no stray page objects were dragged along with the annotation
    expect(pdoc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Page')).length).toBe(2)
  })

  it('reports which file is encrypted or damaged, and why', async () => {
    const good = await makePdf({ pages: 1 })
    const enc = await makeEncryptedLookingPdf()
    await expect(mergePdfs([{ name: 'good.pdf', bytes: good }, { name: 'secret.pdf', bytes: enc }], { bookmarks: false })).rejects.toThrow(
      /“secret\.pdf” is password protected/
    )
    const err = await mergePdfs([{ name: 'junk.pdf', bytes: new TextEncoder().encode('not a pdf at all') }], { bookmarks: false }).catch((e) => e)
    expect(err).toBeInstanceOf(MergeError)
    expect((err as MergeError).file).toBe('junk.pdf')
    expect((err as MergeError).message).toMatch(/“junk\.pdf” is damaged or is not a valid PDF/)
  })

  it('rejects page selections outside the document', async () => {
    const a = await makePdf({ pages: 2 })
    await expect(mergePdfs([{ name: 'a.pdf', bytes: a, pages: [5] }], { bookmarks: false })).rejects.toThrow(/has no page 6/)
  })

  it('probePdf returns a page count or a problem', async () => {
    expect(await probePdf('a.pdf', await makePdf({ pages: 3 }))).toEqual({ pages: 3 })
    expect(await probePdf('e.pdf', await makeEncryptedLookingPdf())).toMatchObject({ problem: expect.stringContaining('password protected') })
  })
})
