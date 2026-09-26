import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib'
import { addBookmarkTree } from '../../src/renderer/src/features/bookmarks/pdf/ops'
import type { NewBookmark } from '../../src/renderer/src/features/bookmarks/pdf/model'
import { arabicBook, englishReport } from '../unit/helpers/lbHeadingDocs'

/** Fixture PDFs for the links and bookmarks e2e tests (deterministic; written to the shared fixtures folder). */

const N = (s: string): PDFName => PDFName.of(s)

async function textDoc(pages: string[][], size = 12): Promise<PDFDocument> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const lines of pages) {
    const p = doc.addPage([612, 792])
    lines.forEach((l, i) => p.drawText(l, { x: 72, y: 700 - i * 20, size, font, color: rgb(0, 0, 0) }))
  }
  return doc
}

/** Three pages with addresses in the text, a wrapped sentence, and links from "other software" (URI, GoToR, Launch). */
export async function linksDoc(): Promise<Uint8Array> {
  const doc = await textDoc([
    [
      'Visit https://example.com/docs for the documentation.',
      'Write to support@example.com or see www.example.org/about today.',
      '',
      'Select these words to make a link.',
      '',
      'This sentence wraps across',
      'two lines for the multi line link.',
      '',
      'Existing link text',
      'Open other file',
      'Launch a program'
    ],
    ['Second page of the links document', 'Nothing special here.'],
    ['Third page of the links document']
  ])
  const ctx = doc.context
  const p1 = doc.getPage(0)
  // "Existing link text" (y = 700 - 8*20 = 540), "Open other file" (520), "Launch a program" (500)
  const mk = (rect: number[], extra: Record<string, unknown>): ReturnType<typeof ctx.register> =>
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], ...extra } as never))
  const refs = [
    mk([72, 536, 180, 552], { A: { S: 'URI', URI: PDFString.of('https://existing.example/') } }),
    mk([72, 516, 180, 532], { A: { S: 'GoToR', F: PDFString.of('other.pdf'), D: [0, 'Fit'] } }),
    mk([72, 496, 180, 512], { A: { S: 'Launch', F: PDFString.of('program.exe') } })
  ]
  p1.node.set(N('Annots'), ctx.obj(refs))
  return doc.save()
}

/** Twelve pages with a nested outline whose titles use several scripts. */
export async function outlineDoc(): Promise<Uint8Array> {
  const doc = await textDoc(Array.from({ length: 12 }, (_, i) => [`Chapter page ${i + 1}`, 'Some body text on this page.']), 18)
  const at = (pageIndex: number, top = 700): { pageIndex: number; tail: (string | number | null)[] } => ({ pageIndex, tail: ['XYZ', null, top, null] })
  const tree: NewBookmark[] = [
    {
      title: 'Introduction',
      page: at(0),
      children: [
        { title: 'Background', page: at(1) },
        { title: 'اَلْفَصْلُ الْأَوَّلُ: مُقَدِّمَة', page: at(1, 500) },
        { title: 'Scope', page: at(2) }
      ]
    },
    { title: 'שָׁלוֹם עוֹלָם', page: at(3) },
    { title: 'Chapter 三 第三章 🚀', page: at(4), open: false, children: [{ title: 'Deep', page: at(5), children: [{ title: 'Deeper', page: at(6) }] }] },
    { title: 'Mixed العربية English 123', page: at(7) },
    { title: 'Last', page: at(9) }
  ]
  addBookmarkTree(doc, tree, 'replace')
  return doc.save()
}

/** Fifty pages and 5,000 bookmarks (50 chapters of 99 sections). */
export async function manyBookmarksDoc(): Promise<Uint8Array> {
  const doc = await textDoc(Array.from({ length: 50 }, (_, i) => [`Page ${i + 1}`]))
  const items: NewBookmark[] = []
  for (let c = 0; c < 50; c++) {
    const children: NewBookmark[] = []
    for (let s = 0; s < 99; s++) children.push({ title: `Section ${c + 1}.${s + 1}`, page: { pageIndex: s % 50, tail: ['XYZ', null, 700, null] } })
    items.push({ title: `Chapter ${c + 1}`, page: { pageIndex: c, tail: ['XYZ', null, 700, null] }, open: false, children })
  }
  addBookmarkTree(doc, items, 'replace')
  return doc.save()
}

export async function writeLbFixtures(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'lb-links.pdf'), await linksDoc())
  writeFileSync(join(dir, 'lb-outline.pdf'), await outlineDoc())
  writeFileSync(join(dir, 'lb-many.pdf'), await manyBookmarksDoc())
  writeFileSync(join(dir, 'lb-report.pdf'), (await englishReport()).bytes)
  writeFileSync(join(dir, 'lb-arabic.pdf'), (await arabicBook('visual')).bytes)
}
