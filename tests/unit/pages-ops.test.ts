import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  planDelete,
  planDuplicate,
  planInsertBlank,
  planInsertExternal,
  planReorder,
  planRotate
} from '../../src/shared/features/pages/order'
import { applyPageSpecs, extractPages, materializeInherited, pruneUnreachable } from '../../src/shared/features/pages/pdfOps'
import { addLink, fileContains, linkTarget, makeDoc, pageLabelsOf, reload } from './pdfTestUtils'

const N = (s: string): PDFName => PDFName.of(s)
const apply = async (doc: PDFDocument, plan: { specs: Parameters<typeof applyPageSpecs>[1] }, ext?: PDFDocument): Promise<PDFDocument> => {
  await applyPageSpecs(doc, plan.specs, { ext })
  return reload(await doc.save())
}

describe('applyPageSpecs: reorder / delete / duplicate / rotate / blank', () => {
  it('reorders pages and keeps every page', async () => {
    const doc = await makeDoc(5)
    const out = await apply(doc, planReorder(5, [3], 0)!)
    expect(pageLabelsOf(out)).toEqual(['Page 4', 'Page 1', 'Page 2', 'Page 3', 'Page 5'])
  })

  it('moves several pages at once, keeping their relative order', async () => {
    const doc = await makeDoc(6)
    const out = await apply(doc, planReorder(6, [1, 4], 6)!)
    expect(pageLabelsOf(out)).toEqual(['Page 1', 'Page 3', 'Page 4', 'Page 6', 'Page 2', 'Page 5'])
  })

  it('deletes pages and really removes their content from the file', async () => {
    const doc = await makeDoc(5)
    const out = await apply(doc, planDelete(5, [1, 2])!)
    expect(pageLabelsOf(out)).toEqual(['Page 1', 'Page 4', 'Page 5'])
    expect(fileContains(out, 'Page 2')).toBe(false)
    expect(fileContains(out, 'Page 3')).toBe(false)
    expect(fileContains(out, 'Page 4')).toBe(true)
  })

  it('refuses to delete every page', () => {
    expect(planDelete(3, [0, 1, 2])).toBeNull()
    expect(planDelete(3, [])).toBeNull()
  })

  it('duplicates pages right after themselves and selects the copies', async () => {
    const doc = await makeDoc(3)
    const plan = planDuplicate(3, [0, 2])
    expect(plan.selection).toEqual([1, 4])
    const out = await apply(doc, plan)
    expect(pageLabelsOf(out)).toEqual(['Page 1', 'Page 1', 'Page 2', 'Page 3', 'Page 3'])
    // A copy shares the content stream, so the file does not grow by a whole page.
    expect(out.getPageCount()).toBe(5)
  })

  it('rotates only the selected pages, relative to their current rotation', async () => {
    const doc = await makeDoc(3)
    let out = await apply(doc, planRotate(3, [1], 90))
    out = await apply(out, planRotate(3, [1, 2], -90))
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 270])
  })

  it('inserts a blank page sized like its neighbour (also when that neighbour is rotated)', async () => {
    const doc = await makeDoc(3, { sizes: [[612, 792], [300, 400], [612, 792]] })
    doc.getPage(1).setRotation(degrees(90))
    const out = await apply(doc, planInsertBlank(3, 2, 'neighbour'))
    expect(out.getPageCount()).toBe(4)
    const blank = out.getPage(2)
    expect(blank.getRotation().angle).toBe(0)
    expect(blank.getSize()).toEqual({ width: 400, height: 300 }) // rotated neighbour: 300x400 shown as 400x300
    expect(pageLabelsOf(out)).toEqual(['Page 1', 'Page 2', '(blank)', 'Page 3'])
  })

  it('inserts a blank page of an explicit size at the start', async () => {
    const doc = await makeDoc(2)
    const out = await apply(doc, planInsertBlank(2, 0, { width: 595, height: 842 }, 2))
    expect(out.getPages().map((p) => p.getSize().width)).toEqual([595, 595, 612, 612])
  })

  it('rejects invalid specs with readable errors', async () => {
    const doc = await makeDoc(2)
    await expect(applyPageSpecs(doc, [{ kind: 'orig', index: 5 }])).rejects.toThrow(/Page 6 does not exist/)
    await expect(applyPageSpecs(doc, [])).rejects.toThrow(/at least one page/)
    await expect(applyPageSpecs(doc, [{ kind: 'ext', index: 0 }])).rejects.toThrow(/No source document/)
  })
})

describe('applyPageSpecs: pages from another PDF', () => {
  it('inserts selected pages of another document at a chosen position', async () => {
    const doc = await makeDoc(3)
    const src = await makeDoc(4, { prefix: 'Other' })
    const out = await apply(doc, planInsertExternal(3, 1, [2, 0]), src)
    expect(pageLabelsOf(out)).toEqual(['Page 1', '(blank)', '(blank)', 'Page 2', 'Page 3']) // "Other n" does not match the Page regexp
    expect(pageLabelsOf(out, 'Other').slice(1, 3)).toEqual(['Other 3', 'Other 1'])
  })

  it('keeps links between inserted pages, and drops links to pages that were not inserted (no leaked pages)', async () => {
    const doc = await makeDoc(2)
    const src = await makeDoc(4, { prefix: 'Other' })
    addLink(src, 0, 2) // Other 1 -> Other 3 (both inserted)
    addLink(src, 2, 3) // Other 3 -> Other 4 (not inserted)
    const out = await apply(doc, planInsertExternal(2, 2, [0, 2]), src)
    expect(out.getPageCount()).toBe(4)
    expect(linkTarget(out, 2)).toBe(3) // Other 1 now points at the copy of Other 3
    expect(linkTarget(out, 3)).toBeUndefined() // its link to a page that is not in the document is gone
    expect(fileContains(out, 'Other 4')).toBe(false)
    expect(fileContains(out, 'Other 2')).toBe(false)
  })
})

describe('links, page trees and orphaned objects', () => {
  it('keeps a link working when its pages move, and drops it when its target is deleted', async () => {
    const doc = await makeDoc(4)
    addLink(doc, 0, 3) // page 1 -> page 4
    const moved = await apply(await reload(await doc.save()), planReorder(4, [3], 0)!) // page 4 first
    expect(linkTarget(moved, 1)).toBe(0) // the old page 1 is now second and still points at old page 4
    const deleted = await apply(await reload(await doc.save()), planDelete(4, [3])!)
    expect(deleted.getPageCount()).toBe(3)
    expect(linkTarget(deleted, 0)).toBeUndefined()
    expect(fileContains(deleted, 'Page 4')).toBe(false)
  })

  it('handles page trees with inherited attributes and nested nodes', async () => {
    const doc = await PDFDocument.create()
    const ctx = doc.context
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const pages = [0, 1, 2, 3].map((i) => {
      const p = doc.addPage([500, 500])
      p.drawText(`Page ${i + 1}`, { x: 10, y: 10, font })
      return p
    })
    // Move MediaBox and Rotate up into an intermediate node: pages inherit them.
    const group = ctx.obj({ Type: 'Pages', Kids: [pages[1].ref, pages[2].ref], Count: 2, MediaBox: [0, 0, 300, 200], Rotate: 90 }) as PDFDict
    const groupRef = ctx.register(group)
    for (const p of [pages[1], pages[2]]) {
      p.node.delete(N('MediaBox'))
      p.node.set(N('Parent'), groupRef)
    }
    const root = doc.catalog.Pages()
    root.set(N('Kids'), ctx.obj([pages[0].ref, groupRef, pages[3].ref]))
    ;(doc as unknown as { pageCache: { invalidate(): void } }).pageCache.invalidate()
    group.set(N('Parent'), doc.catalog.get(N('Pages'))!)
    const loaded = await reload(await doc.save())
    expect(loaded.getPageCount()).toBe(4)
    expect(loaded.getPage(1).getSize()).toEqual({ width: 300, height: 200 })

    const out = await apply(loaded, planReorder(4, [1], 4)!)
    expect(pageLabelsOf(out)).toEqual(['Page 1', 'Page 3', 'Page 4', 'Page 2'])
    expect(out.getPage(3).getSize()).toEqual({ width: 300, height: 200 })
    expect(out.getPage(3).getRotation().angle).toBe(90)
    expect(out.getPage(0).getRotation().angle).toBe(0)
  })

  it('materializeInherited puts inherited boxes on the page itself', async () => {
    const doc = await makeDoc(1)
    const pageNode = doc.getPage(0).node
    const root = doc.catalog.Pages()
    root.set(N('MediaBox'), doc.context.obj([0, 0, 100, 100]))
    pageNode.delete(N('MediaBox'))
    materializeInherited(doc)
    expect(pageNode.lookup(N('MediaBox'), PDFArray).size()).toBe(4)
  })

  it('pruneUnreachable removes only what nothing refers to', async () => {
    const doc = await makeDoc(2)
    const orphan = doc.context.register(doc.context.obj({ Junk: PDFNumber.of(1) }))
    const before = [...doc.context.enumerateIndirectObjects()].length
    expect(pruneUnreachable(doc)).toBe(1)
    expect(doc.context.lookup(orphan)).toBeUndefined()
    expect([...doc.context.enumerateIndirectObjects()].length).toBe(before - 1)
    expect(pageLabelsOf(await reload(await doc.save()))).toEqual(['Page 1', 'Page 2'])
  })
})

describe('extractPages', () => {
  it('writes a valid PDF with only the chosen pages, in the given order', async () => {
    const doc = await makeDoc(6)
    const out = await reload(await extractPages(await doc.save(), [4, 1, 2]))
    expect(pageLabelsOf(out)).toEqual(['Page 5', 'Page 2', 'Page 3'])
    expect(fileContains(out, 'Page 1')).toBe(false)
  })

  it('carries links between extracted pages', async () => {
    const doc = await makeDoc(4)
    addLink(doc, 1, 2)
    const out = await reload(await extractPages(await doc.save(), [1, 2]))
    expect(linkTarget(out, 0)).toBe(1)
  })
})
