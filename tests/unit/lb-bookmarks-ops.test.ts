import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { readPdfText } from '../../src/shared/features/pdftext'
import { newBookmarkId, type BmNode, type NewBookmark } from '../../src/renderer/src/features/bookmarks/pdf/model'
import {
  BookmarkError,
  addBookmark,
  addBookmarkTree,
  clearBookmarks,
  deleteBookmark,
  indentBookmark,
  moveBookmarkBy,
  moveBookmarkTo,
  outdentBookmark,
  renameBookmark,
  setAllBookmarksOpen,
  setBookmarkDestination,
  styleBookmark
} from '../../src/renderer/src/features/bookmarks/pdf/ops'
import { readBookmarks } from '../../src/renderer/src/features/bookmarks/pdf/read'
import { validateOutline } from '../../src/renderer/src/features/bookmarks/pdf/validate'
import { writeBookmarks } from '../../src/renderer/src/features/bookmarks/pdf/write'
import { pdfjsOutline } from './helpers/lbPdfjs'
import { addOutline, makeDoc, reload } from './pdfTestUtils'

const N = (s: string): PDFName => PDFName.of(s)

/** Saves, re-loads with pdf-lib, asserts the outline is strictly valid, and returns both views. */
async function roundTrip(doc: PDFDocument): Promise<{ pdf: PDFDocument; bytes: Uint8Array; titles: string[] }> {
  const bytes = await doc.save()
  const pdf = await reload(bytes)
  expect(validateOutline(pdf)).toEqual([])
  const titles: string[] = []
  const walk = (nodes: BmNode[], depth: number): void => {
    for (const n of nodes) {
      titles.push(`${'-'.repeat(depth)}${n.title}`)
      walk(n.children, depth + 1)
    }
  }
  walk(readBookmarks(pdf).roots, 0)
  return { pdf, bytes, titles }
}

const at = (pageIndex: number, top: number | null = null): { pageIndex: number; tail: (string | number | null)[] } => ({ pageIndex, tail: ['XYZ', null, top, null] })

async function sampleDoc(): Promise<PDFDocument> {
  const doc = await makeDoc(8)
  addBookmarkTree(
    doc,
    [
      { title: 'One', page: at(0, 700), children: [{ title: 'One.A', page: at(1) }, { title: 'One.B', page: at(2) }] },
      { title: 'Two', page: at(3) },
      { title: 'Three', page: at(4), open: false, children: [{ title: 'Three.A', page: at(5) }] }
    ],
    'replace'
  )
  return doc
}

const idOf = (doc: PDFDocument, title: string): string => {
  let found = ''
  const walk = (nodes: BmNode[]): void => {
    for (const n of nodes) {
      if (n.title === title) found = n.id
      walk(n.children)
    }
  }
  walk(readBookmarks(doc).roots)
  if (!found) throw new Error(`no bookmark ${title}`)
  return found
}

describe('outline: create and read back', () => {
  it('writes a strictly valid outline that pdf-lib and PDF.js both read', async () => {
    const doc = await sampleDoc()
    const { bytes, titles } = await roundTrip(doc)
    expect(titles).toEqual(['One', '-One.A', '-One.B', 'Two', 'Three', '-Three.A'])
    const pjs = await pdfjsOutline(bytes)
    expect(pjs!.map((i) => [i.title, i.page])).toEqual([['One', 1], ['Two', 4], ['Three', 5]])
    expect(pjs![0].items.map((i) => [i.title, i.page])).toEqual([['One.A', 2], ['One.B', 3]])
    expect(pjs![0].destType).toBe('XYZ')
    expect(pjs![2].items.map((i) => i.title)).toEqual(['Three.A'])
  })

  it('computes /Count with the open/closed state of each level', async () => {
    const doc = await sampleDoc()
    const pdf = await reload(await doc.save())
    const root = pdf.catalog.lookup(N('Outlines'), PDFDict)
    // One (open, 2 children) + Two + Three (closed, its child is not visible) + One.A + One.B = 5
    expect(root.lookup(N('Count'), PDFNumber).asNumber()).toBe(5)
    const three = pdf.context.lookup(root.get(N('Last')) as never, PDFDict)
    expect(three.lookup(N('Count'), PDFNumber).asNumber()).toBe(-1)
    const one = pdf.context.lookup(root.get(N('First')) as never, PDFDict)
    expect(one.lookup(N('Count'), PDFNumber).asNumber()).toBe(2)
  })

  it('writes /Dest arrays with the right page and view type', async () => {
    const doc = await makeDoc(3)
    addBookmarkTree(
      doc,
      [
        { title: 'xyz', page: { pageIndex: 0, tail: ['XYZ', 10, 20, 1.5] } },
        { title: 'fit', page: { pageIndex: 1, tail: ['Fit'] } },
        { title: 'fith', page: { pageIndex: 2, tail: ['FitH', 300] } },
        { title: 'fitr', page: { pageIndex: 2, tail: ['FitR', 1, 2, 3, 4] } },
        { title: 'junk', page: { pageIndex: 0, tail: ['Bogus', 1] } }
      ],
      'replace'
    )
    const { pdf } = await roundTrip(doc)
    const read = readBookmarks(pdf).roots.map((n) => (n.target.kind === 'page' ? [n.target.dest.pageIndex, ...n.target.dest.tail] : null))
    expect(read).toEqual([[0, 'XYZ', 10, 20, 1.5], [1, 'Fit'], [2, 'FitH', 300], [2, 'FitR', 1, 2, 3, 4], [0, 'Fit']])
  })

  it('an empty outline is removed from the catalog', async () => {
    const doc = await sampleDoc()
    expect(clearBookmarks(doc)).toBe(6)
    expect(doc.catalog.has(N('Outlines'))).toBe(false)
    expect(readBookmarks(doc).hasOutline).toBe(false)
  })
})

describe('outline: edit operations', () => {
  it('adds a bookmark after another, at the end, and as a child', async () => {
    const doc = await sampleDoc()
    const two = idOf(doc, 'Two')
    addBookmark(doc, { title: 'After Two', page: at(6), afterId: two })
    addBookmark(doc, { title: 'Last', page: at(7) })
    addBookmark(doc, { title: 'Child of Two', page: at(3), parentId: two, index: 0 })
    addBookmark(doc, { title: 'First of all', parentId: null, index: 0 })
    const { titles } = await roundTrip(doc)
    expect(titles).toEqual(['First of all', 'One', '-One.A', '-One.B', 'Two', '-Child of Two', 'After Two', 'Three', '-Three.A', 'Last'])
  })

  it('returns the id the new item has in the file, and existing ids stay stable', async () => {
    const doc = await sampleDoc()
    const before = idOf(doc, 'Three')
    const id = addBookmark(doc, { title: 'Fresh', page: at(1) })
    expect(id).toMatch(/^\d+ \d+$/)
    expect(idOf(doc, 'Fresh')).toBe(id)
    expect(idOf(doc, 'Three')).toBe(before)
  })

  it('renames and rejects empty titles', async () => {
    const doc = await sampleDoc()
    renameBookmark(doc, idOf(doc, 'Two'), '  Second  ')
    expect((await roundTrip(doc)).titles).toContain('Second')
    expect(() => renameBookmark(doc, idOf(doc, 'Second'), '   ')).toThrow(BookmarkError)
    expect(() => renameBookmark(doc, '999 0', 'x')).toThrow(/no longer exists/)
  })

  it('deletes with children and reports how many items went', async () => {
    const doc = await sampleDoc()
    expect(deleteBookmark(doc, idOf(doc, 'One'))).toBe(3)
    const { titles, pdf } = await roundTrip(doc)
    expect(titles).toEqual(['Two', 'Three', '-Three.A'])
    // The deleted items' objects are gone from the file, not just unlinked.
    expect([...pdf.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFDict && readPdfText((o as PDFDict).lookup(N('Title'))) === 'One.A')).toHaveLength(0)
  })

  it('nests (indent) under the previous sibling and refuses for the first item of a level', async () => {
    const doc = await sampleDoc()
    indentBookmark(doc, idOf(doc, 'Two'))
    expect((await roundTrip(doc)).titles).toEqual(['One', '-One.A', '-One.B', '-Two', 'Three', '-Three.A'])
    expect(() => indentBookmark(doc, idOf(doc, 'One'))).toThrow(BookmarkError)
    expect(() => indentBookmark(doc, idOf(doc, 'One.A'))).toThrow(BookmarkError)
  })

  it('un-nests (outdent) to just after the parent', async () => {
    const doc = await sampleDoc()
    outdentBookmark(doc, idOf(doc, 'One.A'))
    expect((await roundTrip(doc)).titles).toEqual(['One', '-One.B', 'One.A', 'Two', 'Three', '-Three.A'])
    expect(() => outdentBookmark(doc, idOf(doc, 'Two'))).toThrow(/top level/)
  })

  it('moves up and down within a level and refuses at the ends', async () => {
    const doc = await sampleDoc()
    moveBookmarkBy(doc, idOf(doc, 'Two'), -1)
    expect((await roundTrip(doc)).titles).toEqual(['Two', 'One', '-One.A', '-One.B', 'Three', '-Three.A'])
    moveBookmarkBy(doc, idOf(doc, 'One.A'), 1)
    expect((await roundTrip(doc)).titles).toEqual(['Two', 'One', '-One.B', '-One.A', 'Three', '-Three.A'])
    expect(() => moveBookmarkBy(doc, idOf(doc, 'Two'), -1)).toThrow(/first/)
    expect(() => moveBookmarkBy(doc, idOf(doc, 'Three'), 1)).toThrow(/last/)
  })

  it('moves by drag and drop semantics: before, after, inside; never into itself', async () => {
    const doc = await sampleDoc()
    moveBookmarkTo(doc, idOf(doc, 'Three'), idOf(doc, 'One'), 'before')
    expect((await roundTrip(doc)).titles).toEqual(['Three', '-Three.A', 'One', '-One.A', '-One.B', 'Two'])
    moveBookmarkTo(doc, idOf(doc, 'One.B'), idOf(doc, 'Two'), 'after')
    expect((await roundTrip(doc)).titles).toEqual(['Three', '-Three.A', 'One', '-One.A', 'Two', 'One.B'])
    moveBookmarkTo(doc, idOf(doc, 'Two'), idOf(doc, 'Three.A'), 'inside')
    expect((await roundTrip(doc)).titles).toEqual(['Three', '-Three.A', '--Two', 'One', '-One.A', 'One.B'])
    expect(() => moveBookmarkTo(doc, idOf(doc, 'Three'), idOf(doc, 'Two'), 'inside')).toThrow(/into itself/)
    expect(() => moveBookmarkTo(doc, idOf(doc, 'One'), idOf(doc, 'One'), 'after')).toThrow(BookmarkError)
  })

  it('sets style (bold, italic, colour) and the default open state', async () => {
    const doc = await sampleDoc()
    const id = idOf(doc, 'Two')
    styleBookmark(doc, id, { bold: true, italic: true, color: [1, 0, 0.5] })
    styleBookmark(doc, idOf(doc, 'Three'), { open: true })
    const { pdf, bytes } = await roundTrip(doc)
    const two = readBookmarks(pdf).roots[1]
    expect([two.bold, two.italic, two.color]).toEqual([true, true, [1, 0, 0.5]])
    expect(readBookmarks(pdf).roots[2].open).toBe(true)
    const pjs = await pdfjsOutline(bytes)
    expect([pjs![1].bold, pjs![1].italic]).toEqual([true, true])
    expect(pjs![1].color).toEqual([255, 0, 128])
    styleBookmark(doc, id, { bold: false, italic: false, color: null })
    const again = readBookmarks(await reload(await doc.save())).roots[1]
    expect([again.bold, again.italic, again.color]).toEqual([false, false, null])
  })

  it('opens or closes every level by default', async () => {
    const doc = await sampleDoc()
    setAllBookmarksOpen(doc, true)
    let { pdf } = await roundTrip(doc)
    expect(pdf.catalog.lookup(N('Outlines'), PDFDict).lookup(N('Count'), PDFNumber).asNumber()).toBe(6)
    setAllBookmarksOpen(doc, false)
    ;({ pdf } = await roundTrip(doc))
    expect(pdf.catalog.lookup(N('Outlines'), PDFDict).lookup(N('Count'), PDFNumber).asNumber()).toBe(3)
  })

  it('changes and removes a destination', async () => {
    const doc = await sampleDoc()
    setBookmarkDestination(doc, idOf(doc, 'Two'), { pageIndex: 7, tail: ['XYZ', null, 500, null] })
    setBookmarkDestination(doc, idOf(doc, 'One.A'), null)
    const { pdf, bytes } = await roundTrip(doc)
    const nodes = readBookmarks(pdf).roots
    expect(nodes[1].target).toMatchObject({ kind: 'page', dest: { pageIndex: 7, tail: ['XYZ', null, 500, null] } })
    expect(nodes[0].children[0].target.kind).toBe('none')
    expect((await pdfjsOutline(bytes))![1].page).toBe(8)
    expect(() => setBookmarkDestination(doc, idOf(doc, 'Two'), { pageIndex: 99, tail: ['Fit'] })).toThrow(/does not exist/)
  })

  it('appends a generated tree after existing bookmarks, or replaces them', async () => {
    const doc = await sampleDoc()
    const gen: NewBookmark[] = [{ title: 'Gen 1', page: at(0), children: [{ title: 'Gen 1.1', page: at(1) }] }]
    expect(addBookmarkTree(doc, gen, 'append')).toBe(2)
    expect((await roundTrip(doc)).titles.slice(-2)).toEqual(['Gen 1', '-Gen 1.1'])
    addBookmarkTree(doc, gen, 'replace')
    expect((await roundTrip(doc)).titles).toEqual(['Gen 1', '-Gen 1.1'])
    expect(() => addBookmarkTree(doc, [{ title: '   ' }], 'append')).toThrow(/no bookmarks/)
    expect(() => addBookmarkTree(doc, [{ title: 'x', page: at(50) }], 'append')).toThrow(/does not exist/)
  })
})

describe('outline: preserving what we do not manage', () => {
  it('keeps URI actions, extra keys and named destinations when editing other items', async () => {
    const doc = await makeDoc(4)
    addOutline(doc, [
      { title: 'Named', named: 'chap1', page: 1 },
      { title: 'Explicit', page: 2 },
      { title: 'Web' }
    ])
    // Give the third item a URI action and a custom key, and the first a colour.
    const root = doc.catalog.lookup(N('Outlines'), PDFDict)
    let cur = root.get(N('First'))
    const items: PDFDict[] = []
    while (cur) {
      const d = doc.context.lookup(cur as never, PDFDict)
      items.push(d)
      cur = d.get(N('Next'))
    }
    items[2].set(N('A'), doc.context.obj({ S: 'URI', URI: PDFString.of('https://example.com/x') }))
    items[2].set(N('X-Custom'), PDFNumber.of(42))
    const { roots } = readBookmarks(doc)
    expect(roots.map((n) => n.target.kind)).toEqual(['page', 'page', 'uri'])
    expect(roots[0].target).toMatchObject({ named: 'chap1', dest: { pageIndex: 1 } })

    renameBookmark(doc, roots[1].id, 'Explicit (renamed)')
    indentBookmark(doc, roots[2].id)
    const { pdf, bytes } = await roundTrip(doc)
    const again = readBookmarks(pdf).roots
    expect(again[0].target).toMatchObject({ kind: 'page', named: 'chap1' })
    const web = again[1].children[0]
    expect(web.target).toEqual({ kind: 'uri', uri: 'https://example.com/x' })
    const webDict = pdf.context.lookup(PDFNameRefFor(web.id), PDFDict)
    expect(webDict.lookup(N('X-Custom'), PDFNumber).asNumber()).toBe(42)
    // The named item still points through its name, not through an array we invented.
    const namedDict = pdf.context.lookup(PDFNameRefFor(again[0].id), PDFDict)
    expect(namedDict.get(N('Dest'))).toBeInstanceOf(PDFName)
    const pjs = await pdfjsOutline(bytes)
    expect(pjs![0].page).toBe(2)
    expect(pjs![1].items[0].url).toBe('https://example.com/x')
  })

  it('re-points a GoTo-action item when its destination is changed, dropping the action', async () => {
    const doc = await makeDoc(3)
    addOutline(doc, [{ title: 'Act' }])
    const root = doc.catalog.lookup(N('Outlines'), PDFDict)
    const item = doc.context.lookup(root.get(N('First')) as never, PDFDict)
    item.set(N('A'), doc.context.obj({ S: 'GoTo', D: [doc.getPage(1).ref, 'Fit'] }))
    const [n] = readBookmarks(doc).roots
    expect(n.target).toMatchObject({ kind: 'page', via: 'action', dest: { pageIndex: 1 } })
    setBookmarkDestination(doc, n.id, { pageIndex: 2, tail: ['Fit'] })
    const { pdf } = await roundTrip(doc)
    const d = pdf.context.lookup(PDFNameRefFor(readBookmarks(pdf).roots[0].id), PDFDict)
    expect(d.has(N('A'))).toBe(false)
    expect(d.lookup(N('Dest'), PDFArray).size()).toBe(2)
  })

  it('reading a damaged outline never throws and validation names the problem', async () => {
    const doc = await sampleDoc()
    const root = doc.catalog.lookup(N('Outlines'), PDFDict)
    const first = doc.context.lookup(root.get(N('First')) as never, PDFDict)
    first.set(N('Count'), PDFNumber.of(99)) // wrong
    expect(validateOutline(doc).join(' ')).toMatch(/Count/)
    expect(() => readBookmarks(doc)).not.toThrow()
    root.set(N('Last'), first.get(N('Next'))!) // wrong /Last
    expect(validateOutline(doc).join(' ')).toMatch(/Last/)
  })
})

describe('outline: scale', () => {
  it('handles 5,000 bookmarks with valid structure and reasonable speed', async () => {
    const doc = await makeDoc(50)
    const items: NewBookmark[] = []
    for (let c = 0; c < 50; c++) {
      const children: NewBookmark[] = []
      for (let s = 0; s < 99; s++) children.push({ title: `Section ${c + 1}.${s + 1}`, page: at(s % 50, 700) })
      items.push({ title: `Chapter ${c + 1}`, page: at(c % 50), open: c % 2 === 0, children })
    }
    const t0 = Date.now()
    expect(addBookmarkTree(doc, items, 'replace')).toBe(5000)
    const created = Date.now() - t0
    const id = idOf(doc, 'Section 25.50')
    renameBookmark(doc, id, 'Renamed')
    moveBookmarkBy(doc, idOf(doc, 'Chapter 10'), 1)
    const total = Date.now() - t0
    const { pdf } = await roundTrip(doc)
    expect(readBookmarks(pdf).count).toBe(5000)
    expect(created).toBeLessThan(5000)
    expect(total).toBeLessThan(10000)
  })

  it('newBookmarkId never repeats', () => {
    expect(new Set(Array.from({ length: 100 }, () => newBookmarkId())).size).toBe(100)
  })

  it('writeBookmarks keeps ids of untouched nodes when the tree is rewritten as is', async () => {
    const doc = await sampleDoc()
    const before = readBookmarks(doc).roots
    writeBookmarks(doc, before)
    const after = readBookmarks(doc).roots
    expect(after.map((n) => n.id)).toEqual(before.map((n) => n.id))
    expect(validateOutline(doc)).toEqual([])
  })
})

// pdf-lib ref for an outline item id ("12 0").
function PDFNameRefFor(id: string): PDFRef {
  const [n, g] = id.split(' ').map(Number)
  return PDFRef.of(n, g)
}
