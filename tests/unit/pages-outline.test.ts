import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { planDelete, planReorder } from '../../src/shared/features/pages/order'
import { formatLabel, readPageLabels, writePageLabels, type PageLabel } from '../../src/shared/features/pages/labels'
import { readOutline, remapOutlineNodes, writeOutline, firstPageOf } from '../../src/shared/features/pages/outline'
import { applyPageSpecs, extractPages } from '../../src/shared/features/pages/pdfOps'
import { addOutline, makeDoc, reload } from './pdfTestUtils'

const N = (s: string): PDFName => PDFName.of(s)
const titles = (nodes: { title: string; children: unknown[] }[]): string[] => nodes.map((n) => n.title)

describe('readOutline', () => {
  it('reads nested bookmarks with explicit, named and missing destinations', async () => {
    const doc = await makeDoc(6)
    addOutline(doc, [
      { title: 'Intro', page: 0 },
      { title: 'Part A', page: 1, children: [{ title: 'A.1', page: 2 }, { title: 'A.2', named: 'a2', page: 3 }] },
      { title: 'Heading only' },
      { title: 'Broken name', named: 'nowhere' },
      { title: 'Café – 日本語', page: 5 }
    ])
    const { nodes, warnings } = readOutline(await reload(await doc.save()))
    expect(titles(nodes)).toEqual(['Intro', 'Part A', 'Heading only', 'Broken name', 'Café – 日本語'])
    expect(nodes.map((n) => n.dest?.pageIndex ?? null)).toEqual([0, 1, null, null, 5])
    expect(nodes[1].children.map((c) => c.dest?.pageIndex)).toEqual([2, 3]) // A.2 is a named destination
    expect(nodes[1].dest?.tail).toEqual(['XYZ', null, 700, null])
    expect(firstPageOf(nodes[2])).toBeNull()
    expect(warnings.join(' ')).toMatch(/2 bookmarks had no usable page destination/)
  })

  it('resolves /GoTo actions and name-tree destinations', async () => {
    const doc = await makeDoc(3)
    const ctx = doc.context
    const dest = ctx.obj([doc.getPage(2).ref, 'Fit'])
    const names = ctx.obj({ Dests: { Names: [PDFString.of('chapter'), dest] } })
    doc.catalog.set(N('Names'), names)
    const root = ctx.obj({ Type: 'Outlines' }) as PDFDict
    const rootRef = ctx.register(root)
    const a = ctx.register(ctx.obj({ Title: PDFHexString.fromText('By action'), Parent: rootRef, A: { S: 'GoTo', D: PDFString.of('chapter') } }))
    const b = ctx.register(ctx.obj({ Title: PDFHexString.fromText('By URI'), Parent: rootRef, A: { S: 'URI', URI: PDFString.of('http://x') } }))
    ;(ctx.lookup(a) as PDFDict).set(N('Next'), b)
    root.set(N('First'), a)
    root.set(N('Last'), b)
    doc.catalog.set(N('Outlines'), rootRef)
    const { nodes } = readOutline(await reload(await doc.save()))
    expect(nodes.map((n) => n.dest?.pageIndex ?? null)).toEqual([2, null])
  })

  it('returns nothing for a document without an outline and survives a circular one', async () => {
    const doc = await makeDoc(2)
    expect(readOutline(doc)).toEqual({ nodes: [], warnings: [] })
    addOutline(doc, [{ title: 'One', page: 0 }, { title: 'Two', page: 1 }])
    const root = doc.catalog.lookup(N('Outlines'), PDFDict)
    const last = doc.context.lookup(root.get(N('Last')) as never, PDFDict)
    last.set(N('Next'), root.get(N('First'))!) // loop: Two -> One
    const { nodes } = readOutline(doc)
    expect(titles(nodes)).toEqual(['One', 'Two']) // each item once, no endless loop
  })

  it('does not throw on garbage in the outline', async () => {
    const doc = await makeDoc(2)
    doc.catalog.set(N('Outlines'), PDFNumber.of(5)) // not even a dictionary
    expect(readOutline(doc).nodes).toEqual([])
    addOutline(doc, [{ title: 'Ok', page: 1 }])
    const root = doc.catalog.lookup(N('Outlines'), PDFDict)
    const first = doc.context.lookup(root.get(N('First')) as never, PDFDict)
    first.set(N('Title'), PDFNumber.of(3))
    first.set(N('Dest'), PDFNumber.of(7))
    const { nodes } = readOutline(doc)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].title).toBe('Untitled')
    expect(nodes[0].dest).toBeNull()
  })
})

describe('outline maintenance during page edits', () => {
  const build = async (): Promise<PDFDocument> => {
    const doc = await makeDoc(6)
    addOutline(doc, [
      { title: 'One', page: 0 },
      { title: 'Two', page: 1, children: [{ title: 'Two.a', page: 2 }, { title: 'Two.b', page: 3 }] },
      { title: 'Three', page: 4 },
      { title: 'Four', page: 5 }
    ])
    return reload(await doc.save())
  }
  const flat = (pdf: PDFDocument): [string, number | null][] => {
    const out: [string, number | null][] = []
    const walk = (list: ReturnType<typeof readOutline>['nodes']): void => list.forEach((n) => (out.push([n.title, n.dest?.pageIndex ?? null]), walk(n.children)))
    walk(readOutline(pdf).nodes)
    return out
  }

  it('bookmarks follow their pages when pages are reordered', async () => {
    const doc = await build()
    await applyPageSpecs(doc, planReorder(6, [5], 0)!.specs)
    expect(flat(await reload(await doc.save()))).toEqual([['One', 1], ['Two', 2], ['Two.a', 3], ['Two.b', 4], ['Three', 5], ['Four', 0]])
    // the destination's zoom/position parameters survive the move
    expect(readOutline(await reload(await doc.save())).nodes[0].dest?.tail).toEqual(['XYZ', null, 700, null])
  })

  it('deleting a page drops its bookmark; a parent whose page went keeps its title and children', async () => {
    const doc = await build()
    await applyPageSpecs(doc, planDelete(6, [1, 5])!.specs) // "Two" and "Four"
    const out = await reload(await doc.save())
    expect(flat(out)).toEqual([['One', 0], ['Two', null], ['Two.a', 1], ['Two.b', 2], ['Three', 3]])
    const root = out.catalog.lookup(N('Outlines'), PDFDict)
    expect(root.lookup(N('Count'), PDFNumber).asNumber()).toBe(5) // the open parent shows its children
  })

  it('deleting the pages of a whole branch removes the branch; deleting everything removes the outline', async () => {
    const doc = await build()
    await applyPageSpecs(doc, planDelete(6, [1, 2, 3])!.specs)
    expect(flat(await reload(await doc.save()))).toEqual([['One', 0], ['Three', 1], ['Four', 2]])
    const doc2 = await build()
    await applyPageSpecs(doc2, planDelete(6, [0, 1, 2, 3, 4])!.specs)
    expect(flat(await reload(await doc2.save()))).toEqual([['Four', 0]])
    const doc3 = await build()
    await applyPageSpecs(doc3, [{ kind: 'blank' }])
    const bare = await reload(await doc3.save())
    expect(readOutline(bare).nodes).toEqual([])
    expect(bare.catalog.has(N('Outlines'))).toBe(false)
  })

  it('prev/next/first/last stay consistent after removals', async () => {
    const doc = await build()
    await applyPageSpecs(doc, planDelete(6, [0, 4])!.specs)
    const out = await reload(await doc.save())
    const root = out.catalog.lookup(N('Outlines'), PDFDict)
    let cur = root.lookup(N('First'), PDFDict)
    const seen: string[] = []
    let prev: PDFDict | undefined
    for (;;) {
      seen.push((cur.lookup(N('Title'), PDFHexString)).decodeText())
      if (prev) expect(cur.lookup(N('Prev'), PDFDict)).toBe(prev)
      else expect(cur.has(N('Prev'))).toBe(false)
      const next = cur.lookupMaybe(N('Next'), PDFDict)
      if (!next) break
      prev = cur
      cur = next
    }
    expect(seen).toEqual(['Two', 'Four'])
    expect(root.lookup(N('Last'), PDFDict)).toBe(cur)
  })

  it('extracted pages carry the bookmarks of their pages', async () => {
    const doc = await build()
    const out = await reload(await extractPages(await doc.save(), [2, 3, 4]))
    expect(flat(out)).toEqual([['Two', null], ['Two.a', 0], ['Two.b', 1], ['Three', 2]])
  })
})

describe('remapOutlineNodes / writeOutline', () => {
  it('builds a fresh outline for a subset of pages', async () => {
    const src = await makeDoc(6)
    addOutline(src, [{ title: 'A', page: 0 }, { title: 'B', page: 3, children: [{ title: 'B1', page: 4 }] }, { title: 'C', page: 5 }])
    const { nodes } = readOutline(await reload(await src.save()))
    const map = new Map([[3, 0], [4, 1]])
    const subset = remapOutlineNodes(nodes, (i) => map.get(i))
    expect(subset.map((n) => n.title)).toEqual(['B'])
    const out = await makeDoc(2)
    writeOutline(out, subset)
    const back = readOutline(await reload(await out.save())).nodes
    expect(back[0].title).toBe('B')
    expect(back[0].dest?.pageIndex).toBe(0)
    expect(back[0].children[0].dest?.pageIndex).toBe(1)
    writeOutline(out, [])
    expect(out.catalog.has(N('Outlines'))).toBe(false)
  })
})

describe('page labels', () => {
  const labelled = async (): Promise<PDFDocument> => {
    const doc = await makeDoc(6)
    // i, ii, iii, then 1, 2, 3 with prefix "A-"
    doc.catalog.set(N('PageLabels'), doc.context.obj({ Nums: [0, { S: 'r' }, 3, { S: 'D', P: PDFString.of('A-') }] }))
    return reload(await doc.save())
  }
  const shown = (labels: PageLabel[] | null): string[] => (labels ?? []).map(formatLabel)

  it('expands ranges to one label per page', async () => {
    expect(shown(readPageLabels(await labelled()))).toEqual(['i', 'ii', 'iii', 'A-1', 'A-2', 'A-3'])
  })

  it('formats letters and roman numerals like PDF does', () => {
    expect(formatLabel({ style: 'a', prefix: '', value: 27 })).toBe('aa')
    expect(formatLabel({ style: 'A', prefix: 'X', value: 2 })).toBe('XB')
    expect(formatLabel({ style: 'R', prefix: '', value: 14 })).toBe('XIV')
    expect(formatLabel({ style: null, prefix: 'Cover', value: 0 })).toBe('Cover')
  })

  it('labels travel with their pages when pages move, and blanks are unlabelled', async () => {
    const doc = await labelled()
    // move page "i" to the end, then put a blank page after the third page
    const moved = planReorder(6, [0], 6)!.specs // order: ii iii A-1 A-2 A-3 i
    await applyPageSpecs(doc, [...moved.slice(0, 3), { kind: 'blank' }, ...moved.slice(3)])
    const out = await reload(await doc.save())
    expect(shown(readPageLabels(out))).toEqual(['ii', 'iii', 'A-1', '', 'A-2', 'A-3', 'i'])
  })

  it('round-trips through compact ranges and removes plain 1..n labels', async () => {
    const doc = await makeDoc(4)
    writePageLabels(doc, [{ style: 'D', prefix: '', value: 1 }, { style: 'D', prefix: '', value: 2 }, { style: 'D', prefix: '', value: 3 }, { style: 'D', prefix: '', value: 4 }])
    expect(doc.catalog.has(N('PageLabels'))).toBe(false)
    writePageLabels(doc, [{ style: 'r', prefix: '', value: 1 }, { style: 'r', prefix: '', value: 2 }, { style: 'D', prefix: '', value: 1 }, { style: 'D', prefix: '', value: 2 }])
    const nums = doc.catalog.lookup(N('PageLabels'), PDFDict).lookup(N('Nums'), PDFArray)
    expect(nums.size()).toBe(4) // two ranges
    expect(shown(readPageLabels(await reload(await doc.save())))).toEqual(['i', 'ii', '1', '2'])
  })

  it('deleting pages keeps the remaining labels', async () => {
    const doc = await labelled()
    await applyPageSpecs(doc, planDelete(6, [1, 4])!.specs)
    expect(shown(readPageLabels(await reload(await doc.save())))).toEqual(['i', 'iii', 'A-1', 'A-3'])
  })
})
