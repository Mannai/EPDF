import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { extractPdf } from '../../src/renderer/src/features/export/extract'
import { layoutDocument } from '../../src/renderer/src/features/export/layout'
import { exportDocument } from '../../src/renderer/src/features/export/run'
import { encodePng, toRgba } from '../../src/renderer/src/features/export/png'
import { makePng } from '../support/images'
import { makeRichPdf, openWithPdfjs, TABLE_ROWS } from '../support/exportFixtures'
import { checkPackage, NS, textsOf, type Checked } from '../support/exportOoxml'

let pdf: Uint8Array
beforeAll(async () => {
  pdf = await makeRichPdf()
})

describe('extraction from a real PDF (legacy PDF.js)', () => {
  it('reads text with fonts, sizes and colours, rulings, images, links and page sizes', async () => {
    const { doc, OPS } = await openWithPdfjs(pdf)
    const model = await extractPdf(doc, { OPS, includeImages: true })
    expect(model.title).toBe('Rich fixture')
    expect(model.pages.map((p) => [p.width, p.height])).toEqual([[612, 792], [792, 612]])
    const p1 = model.pages[0]
    const by = (t: string) => p1.items.find((i) => i.text === t)!
    expect(by('Quarterly Report')).toMatchObject({ family: 'Arial', bold: true, color: 'FF0000', size: 24 })
    expect(by('Quarterly Report').y).toBeCloseTo(792 - 720, 0) // top-left origin
    expect(by('Second paragraph starts after a clear gap in')).toMatchObject({ family: 'Times New Roman', italic: true, color: '008000', serif: true })
    expect(by('code_sample = 42')).toMatchObject({ family: 'Courier New', mono: true, size: 10 })
    expect(by('Visit Epdf')).toMatchObject({ color: '0000FF', url: 'https://example.com/epdf' })
    expect(p1.links).toHaveLength(1)
    expect(p1.lines.length).toBe(9) // 5 horizontal + 4 vertical table rules
    expect(p1.images).toHaveLength(1)
    const img = p1.images[0]
    expect([img.x, img.y, img.width, img.height].map(Math.round)).toEqual([72, 492, 100, 50])
    expect([img.pxWidth, img.pxHeight]).toEqual([20, 10])
    expect(Array.from(img.png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('extracts pixel-exact images (PNG re-encoded from PDF.js pixel data)', async () => {
    const { doc, OPS } = await openWithPdfjs(pdf)
    const model = await extractPdf(doc, { OPS, includeImages: true })
    const png = model.pages[0].images[0].png
    // decode our own PNG independently: IHDR then a single IDAT
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect([dv.getUint32(16), dv.getUint32(20), png[24], png[25]]).toEqual([20, 10, 8, 2]) // opaque -> RGB
    let pos = 8
    let idat: Uint8Array | null = null
    while (pos < png.length) {
      const len = dv.getUint32(pos)
      const type = String.fromCharCode(...png.slice(pos + 4, pos + 8))
      if (type === 'IDAT') idat = png.slice(pos + 8, pos + 8 + len)
      pos += 12 + len
    }
    const raw = inflateSync(idat!)
    const px = (x: number, y: number): number[] => Array.from(raw.slice(y * (20 * 3 + 1) + 1 + x * 3, y * (20 * 3 + 1) + 1 + x * 3 + 3))
    expect(px(0, 0)).toEqual([0, 0, 128])
    expect(px(19, 9)).toEqual([228, 180, 128])
  })

  it('can leave images out', async () => {
    const { doc, OPS } = await openWithPdfjs(pdf)
    const model = await extractPdf(doc, { OPS, includeImages: false })
    expect(model.pages[0].images).toHaveLength(0)
  })

  it('lays the rich page out as heading, paragraphs, a ruled table and an image; the borderless table on page 2', async () => {
    const { doc, OPS } = await openWithPdfjs(pdf)
    const layouts = layoutDocument(await extractPdf(doc, { OPS, includeImages: true }))
    const kinds = layouts[0].blocks.map((b) => b.type)
    expect(kinds).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'table', 'image'])
    const t = layouts[0].blocks[5]
    if (t.type !== 'table') throw new Error('expected a table')
    expect(t.bordered).toBe(true)
    expect(t.rows.map((r) => r.map((c) => c.text))).toEqual(TABLE_ROWS)
    const t2 = layouts[1].blocks.find((b) => b.type === 'table')
    expect(t2 && t2.type === 'table' && t2.bordered).toBe(false)
    expect(layouts[1].blocks[0]).toMatchObject({ type: 'paragraph', heading: 2 })
  })
})

describe('end-to-end export of the rich PDF', () => {
  const run = async (format: 'docx' | 'xlsx' | 'pptx', options = {}) => {
    const { doc, OPS } = await openWithPdfjs(pdf)
    return exportDocument(doc, format, { OPS, options })
  }

  it('docx: text in reading order, styles, table, hyperlink, image and one section per page size', async () => {
    const r = await run('docx')
    expect(r.pages).toBe(2)
    const { docs, files, rels } = checkPackage(r.bytes)
    const doc = docs['word/document.xml']
    const t = textsOf(doc, NS.w, 't').join('|')
    expect(t.indexOf('Quarterly Report')).toBeGreaterThanOrEqual(0)
    expect(t.indexOf('Quarterly Report')).toBeLessThan(t.indexOf('This is the first paragraph'))
    expect(t).toContain('This is the first paragraph of the report and it continues onto a second line with more words to finish the paragraph here.')
    expect(t.indexOf('Visit Epdf')).toBeLessThan(t.indexOf('Apples'))
    expect(t.indexOf('Apples')).toBeLessThan(t.indexOf('Regional Sales'))
    for (const cell of TABLE_ROWS.flat()) expect(t).toContain(cell)
    // formatting
    const first = doc.getElementsByTagNameNS(NS.w, 'p')[0]
    expect(first.getElementsByTagNameNS(NS.w, 'pStyle')[0].getAttributeNS(NS.w, 'val')).toBe('Heading1')
    expect(first.getElementsByTagNameNS(NS.w, 'color')[0].getAttributeNS(NS.w, 'val')).toBe('FF0000')
    expect(first.getElementsByTagNameNS(NS.w, 'sz')[0].getAttributeNS(NS.w, 'val')).toBe('48')
    const fonts = new Set(Array.from(doc.getElementsByTagNameNS(NS.w, 'rFonts')).map((f) => f.getAttributeNS(NS.w, 'ascii')))
    expect([...fonts].sort()).toEqual(['Arial', 'Courier New', 'Times New Roman'])
    expect(doc.getElementsByTagNameNS(NS.w, 'i').length).toBeGreaterThan(0)
    // link, image, table, sections
    const rel = rels['word/document.xml']!.find((x) => x.external)!
    expect(rel.target).toBe('https://example.com/epdf')
    expect(Object.keys(files).filter((n) => n.startsWith('word/media/'))).toHaveLength(1)
    expect(doc.getElementsByTagNameNS(NS.a, 'blip')).toHaveLength(1)
    expect(doc.getElementsByTagNameNS(NS.w, 'tbl')).toHaveLength(2)
    const sects = doc.getElementsByTagNameNS(NS.w, 'sectPr')
    expect(sects).toHaveLength(2)
    expect(sects[1].getElementsByTagNameNS(NS.w, 'pgSz')[0].getAttributeNS(NS.w, 'orient')).toBe('landscape')
    expect(r.warnings).toEqual([])
  })

  it('xlsx: one sheet per detected table with numbers stored as numbers', async () => {
    const r = await run('xlsx', { xlsxMode: 'tables' })
    const { docs } = checkPackage(r.bytes)
    const names = Array.from(docs['xl/workbook.xml'].getElementsByTagNameNS(NS.x, 'sheet')).map((s) => s.getAttribute('name'))
    expect(names).toEqual(['Table 1', 'Table 2'])
    const sst = textsOf(docs['xl/sharedStrings.xml'], NS.x, 't')
    const cells = Array.from(docs['xl/worksheets/sheet1.xml'].getElementsByTagNameNS(NS.x, 'c'))
    const at = (ref: string) => cells.find((c) => c.getAttribute('r') === ref)!
    const v = (ref: string): string => at(ref).getElementsByTagNameNS(NS.x, 'v')[0].textContent!
    expect(sst[Number(v('A1'))]).toBe('Item')
    expect(sst[Number(v('A4'))]).toBe('Plums')
    expect(at('B2').getAttribute('t')).toBeNull()
    expect([v('B2'), v('B3'), v('B4'), v('C2'), v('C3'), v('C4')]).toEqual(['10', '20', '1200', '1.5', '2.25', '0.75'])
    const s2 = Array.from(docs['xl/worksheets/sheet2.xml'].getElementsByTagNameNS(NS.x, 'c'))
    expect(s2.filter((c) => c.getAttribute('t') !== 's').length).toBe(6) // the six numbers of the borderless table
    expect(r.warnings).toEqual([])
  })

  it('xlsx: one sheet per page, one row per line (tables kept as rows)', async () => {
    const r = await run('xlsx', { xlsxMode: 'pages' })
    const { docs } = checkPackage(r.bytes)
    expect(Array.from(docs['xl/workbook.xml'].getElementsByTagNameNS(NS.x, 'sheet')).map((s) => s.getAttribute('name'))).toEqual(['Page 1', 'Page 2'])
    const sst = textsOf(docs['xl/sharedStrings.xml'], NS.x, 't')
    expect(sst).toContain('Quarterly Report')
    expect(sst).toContain('Regional Sales')
    expect(sst).toContain('Numbers below are in thousands of units.')
  })

  it('xlsx: falls back to sheets per page (with a warning) when there are no tables', async () => {
    const d = await PDFDocument.create()
    const f = await d.embedFont(StandardFonts.Helvetica)
    d.addPage([300, 300]).drawText('Just a sentence with no table at all.', { x: 20, y: 200, size: 11, font: f })
    const { doc, OPS } = await openWithPdfjs(await d.save())
    const r = await exportDocument(doc, 'xlsx', { OPS })
    const { docs } = checkPackage(r.bytes)
    expect(docs['xl/workbook.xml'].getElementsByTagNameNS(NS.x, 'sheet')).toHaveLength(1)
    expect(r.warnings.join(' ')).toMatch(/No tables were detected/)
  })

  it('pptx: one slide per page at the page size, text boxes and one picture', async () => {
    const r = await run('pptx')
    const { docs } = checkPackage(r.bytes)
    const sz = docs['ppt/presentation.xml'].getElementsByTagNameNS(NS.p, 'sldSz')[0]
    expect([sz.getAttribute('cx'), sz.getAttribute('cy')]).toEqual([String(612 * 12700), String(792 * 12700)])
    expect(docs['ppt/presentation.xml'].getElementsByTagNameNS(NS.p, 'sldId')).toHaveLength(2)
    const s1 = textsOf(docs['ppt/slides/slide1.xml'], NS.a, 't')
    expect(s1[0]).toBe('Quarterly Report')
    expect(s1).toContain('code_sample = 42')
    expect(docs['ppt/slides/slide1.xml'].getElementsByTagNameNS(NS.p, 'pic')).toHaveLength(1)
    expect(textsOf(docs['ppt/slides/slide2.xml'], NS.a, 't')).toContain('Regional Sales')
    const c = docs['ppt/slides/slide1.xml'].getElementsByTagNameNS(NS.a, 'srgbClr')
    expect(Array.from(c).map((e) => e.getAttribute('val'))).toContain('FF0000')
  })

  it('reports progress from 0 to 1 and warns about PDFs without text', async () => {
    const d = await PDFDocument.create()
    d.addPage([200, 200]).drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(1, 0, 0) })
    const { doc, OPS } = await openWithPdfjs(await d.save())
    const seen: number[] = []
    const r = await exportDocument(doc, 'docx', { OPS, onProgress: (f) => seen.push(f) })
    expect(seen[0]).toBe(0)
    expect(seen[seen.length - 1]).toBe(1)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(r.warnings.join(' ')).toMatch(/No selectable text/)
    checkPackage(r.bytes)
  })
})

describe('cancellation', () => {
  const manyPages = async (n: number): Promise<Uint8Array> => {
    const d = await PDFDocument.create()
    const f = await d.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < n; i++) d.addPage([300, 300]).drawText(`page ${i + 1}`, { x: 20, y: 200, size: 11, font: f })
    return d.save()
  }

  it('stops at a page boundary with an AbortError and produces nothing', async () => {
    const { doc, OPS } = await openWithPdfjs(await manyPages(12))
    const ac = new AbortController()
    const started: string[] = []
    let result: unknown = 'untouched'
    const p = exportDocument(doc, 'docx', {
      OPS,
      signal: ac.signal,
      onProgress: (_f, m) => {
        started.push(m)
        if (/page 3 of/.test(m)) ac.abort()
      }
    }).then((r) => (result = r))
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(result).toBe('untouched')
    expect(started.some((m) => /page 4 of/.test(m))).toBe(false) // it really stopped early
    expect(started.some((m) => /Writing/.test(m))).toBe(false)
  })

  it('rejects immediately when already aborted, and a late abort (during writing) still discards the result', async () => {
    const { doc, OPS } = await openWithPdfjs(await manyPages(2))
    const ac = new AbortController()
    ac.abort()
    await expect(exportDocument(doc, 'xlsx', { OPS, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const late = new AbortController()
    await expect(exportDocument(doc, 'pptx', { OPS, signal: late.signal, onProgress: (_f, m) => m.startsWith('Writing') && late.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('harder documents', () => {
  it('applies the page rotation: upright-looking text on a /Rotate 90 page is read as ordinary text in view coordinates', async () => {
    const d = await PDFDocument.create()
    const f = await d.embedFont(StandardFonts.Helvetica)
    const p = d.addPage([300, 400])
    p.setRotation(degrees(90))
    p.drawText('Rotated page text', { x: 60, y: 40, size: 12, font: f, rotate: degrees(90) })
    const { doc, OPS } = await openWithPdfjs(await d.save())
    const model = await extractPdf(doc, { OPS, includeImages: true })
    expect([model.pages[0].width, model.pages[0].height]).toEqual([400, 300])
    expect(model.pages[0].items.map((i) => i.text)).toEqual(['Rotated page text'])
    const it = model.pages[0].items[0]
    expect(it.y).toBeGreaterThan(0)
    expect(it.y).toBeLessThan(300)
    expect(model.warnings).toEqual([])
  })

  it('reports (not silently drops) text that is rotated relative to the page', async () => {
    const d = await PDFDocument.create()
    const f = await d.embedFont(StandardFonts.Helvetica)
    const p = d.addPage([300, 300])
    p.drawText('Horizontal', { x: 20, y: 250, size: 12, font: f })
    p.drawText('Vertical watermark', { x: 250, y: 50, size: 12, font: f, rotate: degrees(90) })
    const { doc, OPS } = await openWithPdfjs(await d.save())
    const model = await extractPdf(doc, { OPS, includeImages: true })
    expect(model.pages[0].items.map((i) => i.text)).toEqual(['Horizontal'])
    expect(model.warnings.join(' ')).toMatch(/rotated text/)
  })

  it('exports a long document without losing any text (every line of 60 pages is present, in order)', async () => {
    const d = await PDFDocument.create()
    const f = await d.embedFont(StandardFonts.Helvetica)
    const tokens: string[] = []
    for (let p = 0; p < 60; p++) {
      const page = d.addPage([612, 792])
      for (let l = 0; l < 30; l++) {
        const t = `p${p}l${l}`
        tokens.push(t)
        page.drawText(`${t} lorem ipsum dolor sit amet consectetur`, { x: 72, y: 720 - l * 20, size: 11, font: f })
      }
    }
    const { doc, OPS } = await openWithPdfjs(await d.save())
    const started = Date.now()
    const r = await exportDocument(doc, 'docx', { OPS })
    expect(Date.now() - started).toBeLessThan(60_000)
    const text = textsOf(checkPackage(r.bytes).docs['word/document.xml'], NS.w, 't').join(' ')
    let at = -1
    for (const t of tokens) {
      const i = text.indexOf(t + ' ', at + 1)
      expect(i, t).toBeGreaterThan(at)
      at = i
    }
    const x = await exportDocument(doc, 'xlsx', { OPS, options: { xlsxMode: 'pages' } })
    expect(checkPackage(x.bytes).docs['xl/workbook.xml'].getElementsByTagNameNS(NS.x, 'sheet')).toHaveLength(60)
    const s = await exportDocument(doc, 'pptx', { OPS })
    expect(checkPackage(s.bytes).docs['ppt/presentation.xml'].getElementsByTagNameNS(NS.p, 'sldId')).toHaveLength(60)
  }, 120_000)

  it('stores a picture that repeats on every page only once', async () => {
    const d = await PDFDocument.create()
    const png = await d.embedPng(makePng(16, 16, (x, y) => [x * 15, y * 15, 200, 255]))
    for (let i = 0; i < 3; i++) d.addPage([300, 300]).drawImage(png, { x: 20, y: 200, width: 64, height: 64 })
    const { doc, OPS } = await openWithPdfjs(await d.save())
    const r = await exportDocument(doc, 'docx', { OPS })
    const { files, docs } = checkPackage(r.bytes)
    expect(Object.keys(files).filter((n) => n.startsWith('word/media/'))).toHaveLength(1)
    expect(docs['word/document.xml'].getElementsByTagNameNS(NS.a, 'blip')).toHaveLength(3)
    const s = checkPackage((await exportDocument(doc, 'pptx', { OPS })).bytes)
    expect(Object.keys(s.files).filter((n) => n.startsWith('ppt/media/'))).toHaveLength(1)
  })
  it('reads a two-column page column by column', async () => {
    const d = await PDFDocument.create()
    const f = await d.embedFont(StandardFonts.Helvetica)
    const p = d.addPage([612, 792])
    p.drawText('Two column article', { x: 72, y: 730, size: 20, font: f })
    for (let i = 0; i < 12; i++) {
      p.drawText(`Left column line number ${i} with some text`, { x: 72, y: 690 - i * 14, size: 10, font: f })
      p.drawText(`Right column line number ${i} with some text`, { x: 330, y: 690 - i * 14, size: 10, font: f })
    }
    const { doc, OPS } = await openWithPdfjs(await d.save())
    const r = await exportDocument(doc, 'docx', { OPS })
    const text = textsOf(checkPackage(r.bytes).docs['word/document.xml'], NS.w, 't').join(' ')
    expect(text.indexOf('Two column article')).toBeLessThan(text.indexOf('Left column line number 0'))
    expect(text.indexOf('Left column line number 11')).toBeLessThan(text.indexOf('Right column line number 0'))
  })
})
describe('png encoder', () => {
  it('converts every PDF.js pixel format to RGBA and writes opaque images as RGB PNG, translucent as RGBA', () => {
    const gray = new Uint8Array([0b10100000]) // 3 px wide: 1,0,1
    expect(Array.from(toRgba(gray, 3, 1, 1))).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255])
    expect(Array.from(toRgba(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1, 2))).toEqual([1, 2, 3, 255, 4, 5, 6, 255])
    expect(Array.from(toRgba(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1, 3))).toEqual([1, 2, 3, 4])
    expect(() => toRgba(new Uint8Array(4), 1, 1, 9)).toThrow()
    const opaque = encodePng(new Uint8Array([1, 2, 3, 255]), 1, 1)
    const translucent = encodePng(new Uint8Array([1, 2, 3, 100]), 1, 1)
    expect(opaque[25]).toBe(2)
    expect(translucent[25]).toBe(6)
  })
})

// ---------------------------------------------------------------------------------------------------
// Optional: a real consumer (LibreOffice) opens what we wrote
// ---------------------------------------------------------------------------------------------------

const SOFFICE = [process.env['EPDF_TOOL_SOFFICE'], 'C:\\Program Files\\LibreOffice\\program\\soffice.exe', '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice'].find(
  (p) => !!p && existsSync(p)
)

describe.skipIf(!SOFFICE)('LibreOffice opens the generated files (skipped when LibreOffice is not installed)', () => {
  let out: Checked | null = null
  void out
  it(
    'converts the docx, xlsx and pptx to PDF (one soffice at a time)',
    async () => {
      const { doc, OPS } = await openWithPdfjs(pdf)
      const dir = mkdtempSync(join(tmpdir(), 'epdf-export-lo-'))
      try {
        const expected: Record<string, number> = { docx: 2, xlsx: 2, pptx: 2 }
        for (const format of ['docx', 'xlsx', 'pptx'] as const) {
          const r = await exportDocument(doc, format, { OPS })
          const file = join(dir, `sample.${format}`)
          writeFileSync(file, r.bytes)
          const outDir = join(dir, `out-${format}`)
          execFileSync(SOFFICE!, ['--headless', '--norestore', `-env:UserInstallation=file:///${join(dir, 'profile').replace(/\\/g, '/')}`, '--convert-to', 'pdf', '--outdir', outDir, file], {
            timeout: 150_000,
            stdio: 'ignore'
          })
          const produced = readdirSync(outDir).filter((n) => n.endsWith('.pdf'))
          expect(produced, `${format} should convert`).toHaveLength(1)
          const bytes = readFileSync(join(outDir, produced[0]))
          expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
          const pages = (await PDFDocument.load(bytes)).getPageCount()
          if (format === 'pptx') expect(pages).toBe(expected[format])
          else expect(pages).toBeGreaterThanOrEqual(1)
          // the text made it through a real Word/Excel/PowerPoint import
          const conv = await openWithPdfjs(new Uint8Array(bytes))
          const texts: string[] = []
          const n = (conv.doc as { numPages: number }).numPages
          for (let p = 1; p <= n; p++) {
            const page = await (conv.doc as { getPage(p: number): Promise<{ getTextContent(): Promise<{ items: { str: string }[] }> }> }).getPage(p)
            texts.push((await page.getTextContent()).items.map((i) => i.str).join(' '))
          }
          expect(texts.join(' ')).toContain(format === 'xlsx' ? 'Apples' : 'Quarterly')
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    600_000
  )
})
