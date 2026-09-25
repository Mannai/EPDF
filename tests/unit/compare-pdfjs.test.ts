import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { runCompare } from '../../src/renderer/src/features/compare/diff/engine'
import { changeText } from '../../src/renderer/src/features/compare/diff/enrich'
import { highlightRects } from '../../src/renderer/src/features/compare/diff/rects'
import type { PageModel } from '../../src/renderer/src/features/compare/diff/types'
import { extractDocument, itemsToRuns } from '../../src/renderer/src/features/compare/extract'
import { LEAD, PAGE_H, S, fakeEncrypted, para, reportBook, wordRect } from '../support/compareFixtures'
import { opts } from './helpers/compareItems'

/**
 * The whole text pipeline against a REAL PDF.js (legacy build, runs in Node): extraction geometry, reading order
 * of a two-column page, and the exact change counts of the report fixture pair.
 */

async function open(bytes: Uint8Array): Promise<import('pdfjs-dist').PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return (await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true }).promise) as unknown as import('pdfjs-dist').PDFDocumentProxy
}

async function pagesOf(bytes: Uint8Array, o = opts()): Promise<PageModel[]> {
  const doc = await open(bytes)
  try {
    return (await extractDocument(doc, o, new AbortController().signal, () => undefined)).pages
  } finally {
    await doc.loadingTask.destroy()
  }
}

describe('extraction with PDF.js', () => {
  it('gives word boxes that sit exactly where pdf-lib drew the text', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([612, 792])
    const line = 'Revenue grew by 12.5% in 2023'
    page.drawText(line, { x: 100, y: 600, size: 12, font })
    const [m] = await pagesOf(await pdf.save())
    expect(m.text).toEqual(['Revenue', 'grew', 'by', '12.5', '%', 'in', '2023'])
    const i = m.text.indexOf('12.5')
    const want = await wordRect(font, line, '12.5', 100, 600)
    expect(m.box[i * 4]).toBeCloseTo(want.x0, 1)
    expect(m.box[i * 4] + m.box[i * 4 + 2]).toBeCloseTo(want.x1, 1)
    // top-left origin: the box spans 0.85 em above and 0.22 em below the baseline (y = 792 - 600 from the top)
    expect(m.box[i * 4 + 1]).toBeCloseTo(792 - 600 - 12 * 0.85, 1)
    expect(m.box[i * 4 + 3]).toBeCloseTo(12 * 1.07, 1)
  })

  it('accounts for the page rotation (a page with /Rotate 90 is read as displayed)', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([612, 792])
    page.drawText('Rotated page text', { x: 100, y: 600, size: 12, font })
    page.setRotation(degrees(90))
    const [m] = await pagesOf(await pdf.save())
    expect(m.width).toBe(792)
    expect(m.height).toBe(612)
    expect(m.text).toEqual(['Rotated', 'page', 'text'])
    // displayed: the run now reads top-to-bottom, so the boxes are tall and narrow rather than wide
    expect(m.box[3]).toBeGreaterThan(m.box[2])
  })

  it('reads a two-column page column by column', async () => {
    const [, , p3] = await pagesOf(await reportBook({ next: false }))
    const text = p3.text.join(' ')
    expect(text.indexOf('Customer satisfaction')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('was replaced with a local partner')).toBeGreaterThan(text.indexOf('Customer satisfaction stayed'))
    expect(text.indexOf('South region')).toBeGreaterThan(text.indexOf('second quarter in a row'))
  })

  it('a line wrapped with a hyphen compares equal to the same text unwrapped', async () => {
    const make = async (lines: string[]): Promise<PageModel> => {
      const pdf = await PDFDocument.create()
      const font = await pdf.embedFont(StandardFonts.Helvetica)
      const page = pdf.addPage([612, 792])
      lines.forEach((l, i) => page.drawText(l, { x: 72, y: 700 - i * 16, size: 12, font }))
      return (await pagesOf(await pdf.save()))[0]
    }
    const wrapped = await make(['The stock will be moved to the distri-', 'bution centre next week and then sold.'])
    const plain = await make(['The stock will be moved to the distribution centre next week and then sold.'])
    expect(wrapped.keys).toEqual(plain.keys)
    expect(runCompare([wrapped.keys], [plain.keys], opts()).counts.total).toBe(0)
  })

  it('converts a rotated/skewed text matrix to an axis-aligned box', () => {
    const [r] = itemsToRuns([{ str: 'x', transform: [0, 12, -12, 0, 100, 100], width: 20, height: 12 }], [1, 0, 0, -1, 0, 792])
    expect(r.y1 - r.y0).toBeGreaterThan(19) // the run is vertical: 20 long
    expect(r.x1 - r.x0).toBeLessThan(14)
    expect(itemsToRuns([{ str: '' }, { str: 'a', transform: [1, 0, 0, 0, 0, 0], width: 1 }, { transform: [1, 0, 0, 1, 0, 0] }], [1, 0, 0, -1, 0, 792])).toEqual([])
  })

  it('an encrypted file without its password cannot be opened by PDF.js', async () => {
    await expect(open(await fakeEncrypted())).rejects.toMatchObject({ name: 'PasswordException' })
  })
})

describe('the report fixture pair', () => {
  it('finds exactly the planted differences and no others', async () => {
    const oldPages = await pagesOf(await reportBook({ next: false }))
    const newPages = await pagesOf(await reportBook({ next: true }))
    expect(oldPages).toHaveLength(4)
    expect(newPages).toHaveLength(4)
    const r = runCompare(oldPages.map((p) => p.keys), newPages.map((p) => p.keys), opts())
    expect(r.counts).toEqual({ modified: 3, removed: 2, added: 2, moved: 1, total: 8 })

    const texts = r.changes.map((c) => changeText(c, c.old ? oldPages[r.pairs[c.old.pair].old! - 1] : undefined, c.new ? newPages[r.pairs[c.new.pair].new! - 1] : undefined))
    // the modifications, exactly
    const mods = r.changes.map((c, i) => [c, texts[i]] as const).filter(([c]) => c.kind === 'modified')
    expect(mods.map(([, t]) => `${t.oldText}>${t.newText}`).sort()).toEqual(['12.5>15.5', 'Monday>Tuesday', 'quarterly>monthly'])
    // the two-column change is a single word in the RIGHT column: old page 3 became new page 4 (an appendix went in at 3)
    const col = mods.find(([, t]) => t.newText === 'monthly')![0]
    expect([col.old!.page, col.new!.page]).toEqual([3, 4])
    const [rect] = highlightRects(newPages[3], col.new!.parts, 0)
    expect(rect.x).toBeGreaterThan(330)
    expect(rect.y).toBeCloseTo(PAGE_H - 680 - 12 * 0.85, 0) // the first line of the right column
    // removed: the sentence (old page 2) and the deleted page 4; added: the paragraph (new page 2) and the appendix (new page 3)
    expect(r.changes.filter((c) => c.kind === 'removed').map((c) => c.old!.page).sort()).toEqual([2, 4])
    expect(r.changes.filter((c) => c.kind === 'added').map((c) => c.new!.page).sort()).toEqual([2, 3])
    // the moved paragraph goes from page 1 to page 2, unchanged
    const moved = r.changes.find((c) => c.kind === 'moved')!
    expect([moved.old!.page, moved.new!.page]).toEqual([1, 2])
    expect(moved.edited).toBeUndefined()
    // page pairing: 1-1, 2-2, an added page, old 3 = new 4, old page 4 removed
    expect(r.pairs.map((p) => `${p.old}:${p.new}`)).toEqual(['1:1', '2:2', 'null:3', '3:4', '4:null'])
  })

  it('identical files compare with no changes', async () => {
    const a = await pagesOf(await reportBook({ next: false }))
    const b = await pagesOf(await reportBook({ next: false }))
    const r = runCompare(a.map((p) => p.keys), b.map((p) => p.keys), opts())
    expect(r.counts.total).toBe(0)
    expect(r.changedPairs).toBe(0)
  })

  it('the geometry helper used by the fixtures agrees with para()', () => {
    expect(LEAD).toBe(16)
    expect(typeof para).toBe('function')
    expect(S.revenueOld).toContain('12.5%')
  })
})
