import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { planDelete, planReorder } from '../../src/shared/features/pages/order'
import { applyPageSpecs, extractPages } from '../../src/shared/features/pages/pdfOps'
import type { BmNode } from '../../src/renderer/src/features/bookmarks/pdf/model'
import { addBookmarkTree, styleBookmark } from '../../src/renderer/src/features/bookmarks/pdf/ops'
import { readBookmarks } from '../../src/renderer/src/features/bookmarks/pdf/read'
import { validateOutline } from '../../src/renderer/src/features/bookmarks/pdf/validate'
import { INVISIBLE_BORDER } from '../../src/renderer/src/features/links/pdf/model'
import { addLink } from '../../src/renderer/src/features/links/pdf/ops'
import { readLinks } from '../../src/renderer/src/features/links/pdf/read'
import { pdfjsLinks, pdfjsOutline } from './helpers/lbPdfjs'
import { makeDoc, reload } from './pdfTestUtils'

/**
 * The page-organizer feature edits page order, deletes and extracts pages. These tests run ITS helpers on
 * documents whose bookmarks and links were written by THIS feature, and check that they stay valid and keep
 * pointing where they should, in our readers and in PDF.js.
 */

const N = (s: string): PDFName => PDFName.of(s)
const at = (pageIndex: number, top = 700): { pageIndex: number; tail: (string | number | null)[] } => ({ pageIndex, tail: ['XYZ', null, top, null] })

async function build(): Promise<PDFDocument> {
  const doc = await makeDoc(6)
  addBookmarkTree(
    doc,
    [
      { title: 'الفصل الأول', page: at(0) },
      { title: 'الفصل الثاني', page: at(1), children: [{ title: 'Two.a', page: at(2) }, { title: 'Two.b', page: at(3) }] },
      { title: 'Three', page: at(4) },
      { title: 'שלום', page: at(5) }
    ],
    'replace'
  )
  const two = readBookmarks(doc).roots[1]
  styleBookmark(doc, two.id, { bold: true, color: [1, 0, 0] })
  // Links on page 1: to page 3 (explicit), to page 6, to a URL, and a named destination.
  addLink(doc, 0, { rect: [10, 10, 100, 30], target: { kind: 'page', pageIndex: 2, tail: ['XYZ', 5, 600, null] }, border: INVISIBLE_BORDER })
  addLink(doc, 0, { rect: [10, 40, 100, 60], target: { kind: 'page', pageIndex: 5, tail: ['Fit'] }, border: INVISIBLE_BORDER })
  addLink(doc, 0, { rect: [10, 70, 100, 90], target: { kind: 'uri', uri: 'https://keep.example' }, border: INVISIBLE_BORDER })
  // A named destination for page 4 and a link that uses it.
  const dests = doc.context.obj({}) as PDFDict
  dests.set(N('target4'), doc.context.obj([doc.getPage(3).ref, 'Fit']))
  doc.catalog.set(N('Dests'), dests)
  addLink(doc, 1, { rect: [10, 10, 100, 30], target: { kind: 'named', name: 'target4' }, border: INVISIBLE_BORDER })
  return reload(await doc.save())
}

const flatBookmarks = (pdf: PDFDocument): [string, number | null][] => {
  const out: [string, number | null][] = []
  const walk = (list: BmNode[]): void => {
    for (const n of list) {
      out.push([n.title, n.target.kind === 'page' ? n.target.dest.pageIndex : null])
      walk(n.children)
    }
  }
  walk(readBookmarks(pdf).roots)
  return out
}

const linkTargets = (pdf: PDFDocument): string[] =>
  readLinks(pdf).map((l) => `${l.pageIndex}:${l.target.kind === 'page' ? `p${l.target.dest.pageIndex}${l.target.named ? `(${l.target.named})` : ''}` : l.target.kind === 'uri' ? l.target.uri : l.target.kind}`)

describe('our bookmarks and links with the page-organizer helpers', () => {
  it('reordering pages: bookmarks and links follow their pages, styles and positions survive, outline stays valid', async () => {
    const doc = await build()
    await applyPageSpecs(doc, planReorder(6, [5], 0)!.specs) // last page to the front
    const bytes = await doc.save()
    const out = await reload(bytes)
    expect(validateOutline(out)).toEqual([])
    expect(flatBookmarks(out)).toEqual([['الفصل الأول', 1], ['الفصل الثاني', 2], ['Two.a', 3], ['Two.b', 4], ['Three', 5], ['שלום', 0]])
    const two = readBookmarks(out).roots[1]
    expect([two.bold, two.color]).toEqual([true, [1, 0, 0]])
    expect(readBookmarks(out).roots[0].target).toMatchObject({ kind: 'page', dest: { tail: ['XYZ', null, 700, null] } })
    // Links on the (moved) first page now sit on page index 1 and point at the pages' new positions.
    expect(linkTargets(out)).toEqual(['1:p3', '1:p0', '1:https://keep.example/', '2:p4(target4)'])
    // An independent reader agrees.
    const pjs = await pdfjsOutline(bytes)
    expect(pjs!.map((i) => i.page)).toEqual([2, 3, 6, 1])
    expect(pjs![0].page).toBe(2)
    expect(pjs![3].page).toBe(1)
    const links = await pdfjsLinks(bytes, 2)
    expect(links.map((l) => l.page ?? l.url)).toEqual([4, 1, 'https://keep.example/'])
  })

  it('deleting pages: dead destinations are dropped, everything else is untouched and valid', async () => {
    const doc = await build()
    await applyPageSpecs(doc, planDelete(6, [2, 5])!.specs) // pages 3 and 6
    const out = await reload(await doc.save())
    expect(validateOutline(out)).toEqual([])
    expect(flatBookmarks(out)).toEqual([['الفصل الأول', 0], ['الفصل الثاني', 1], ['Two.b', 2], ['Three', 3]])
    expect(readBookmarks(out).roots[1].bold).toBe(true)
    // Links to the deleted pages lose their destination (they are not left pointing nowhere); the URL link and the
    // named-destination link (its page survived) are intact.
    expect(linkTargets(out)).toEqual(['0:none', '0:none', '0:https://keep.example/', '1:p2(target4)'])
    expect(readLinks(out).some((l) => l.target.kind === 'dead')).toBe(false)
  })

  it('deleting the pages of a whole branch removes the branch, and a parent whose own page went keeps its children', async () => {
    const doc = await build()
    await applyPageSpecs(doc, planDelete(6, [1])!.specs) // "الفصل الثاني" itself (page 2)
    const out = await reload(await doc.save())
    expect(validateOutline(out)).toEqual([])
    expect(flatBookmarks(out)).toEqual([['الفصل الأول', 0], ['الفصل الثاني', null], ['Two.a', 1], ['Two.b', 2], ['Three', 3], ['שלום', 4]])
  })

  it('extracting pages gives a valid outline and no dangling links', async () => {
    const doc = await build()
    const out = await reload(await extractPages(await doc.save(), [1, 2, 3])) // pages 2..4
    expect(validateOutline(out)).toEqual([])
    const titles = flatBookmarks(out).map(([t]) => t)
    expect(titles).toContain('Two.a')
    expect(titles).toContain('Two.b')
    expect(titles).not.toContain('Three')
    const kinds = readLinks(out).map((l) => l.target.kind)
    expect(kinds).not.toContain('dead')
  })
})
