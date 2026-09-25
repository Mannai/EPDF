import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib'
const PAGE_TEXT: string[][] = JSON.parse(readFileSync(resolve('tests/fixtures/ocr-text.json'), 'utf8'))
import { readPdf, flattenText } from '../support/pdfText'
import { axeViolations, copyFixture, FIX, launch, menuClick, quitDiscarding } from './helpers'

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/ocr.mjs', FIX], { stdio: 'inherit' })
})

test.setTimeout(180_000)

const bytesOf = (path: string): Uint8Array => new Uint8Array(readFileSync(path))

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Recognize text (OCR)' })
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true })

/** Tools ▸ Recognize Text (OCR)… then Recognize in the dialog. */
async function recognize(app: Parameters<typeof menuClick>[0], page: Page, setup?: (d: ReturnType<typeof dialog>) => Promise<void>): Promise<void> {
  await menuClick(app, 'Tools', 'Recognize Text (OCR)…')
  const d = dialog(page)
  await expect(d).toBeVisible()
  await expect(d.getByText('Loading…')).toHaveCount(0)
  await setup?.(d)
  await d.getByRole('button', { name: /^Recognize/ }).click()
  await expect(d).toHaveCount(0)
}

/** Fraction of `expected` words that occur in `text` (ignoring case and punctuation). */
function recall(expected: string, text: string): number {
  const have = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  const want = expected.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return want.filter((w) => have.has(w)).length / want.length
}

/** Decoded content streams of a page, oldest first. */
async function pageStreams(path: string, pageIndex = 0): Promise<{ text: string; dict: PDFDict }[]> {
  const pdf = await PDFDocument.load(readFileSync(path))
  const page = pdf.getPage(pageIndex)
  const contents = pdf.context.lookup(page.node.get(PDFName.of('Contents')))
  const refs = contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of('Contents'))]
  const out: { text: string; dict: PDFDict }[] = []
  for (const r of refs) {
    const s = r instanceof PDFRef ? pdf.context.lookup(r) : r
    if (s instanceof PDFRawStream) out.push({ text: Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'), dict: s.dict })
  }
  return out
}

/** The raw (compressed) bytes of every image on a page: to prove the picture itself is never touched. */
async function imageBytes(path: string, pageIndex = 0): Promise<string[]> {
  const pdf = await PDFDocument.load(readFileSync(path))
  const res = pdf.getPage(pageIndex).node.Resources()!
  const xo = res.lookup(PDFName.of('XObject'), PDFDict)
  const out: string[] = []
  for (const [, v] of xo.entries()) {
    const s = pdf.context.lookup(v)
    if (s instanceof PDFRawStream && s.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) out.push(Buffer.from(s.contents).toString('base64'))
  }
  return out
}

test.describe('OCR: recognize a scanned page', () => {
  test('adds an invisible, selectable, searchable text layer aligned with the picture; one undo step; saved file verified', async () => {
    const path = copyFixture('scan1.pdf')
    const original = await imageBytes(path)
    expect(original).toHaveLength(1)
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(page.locator('[data-page="1"] .textLayer')).not.toContainText('Invoice')

      await recognize(app, page)
      await expect(page.getByText(/Recognized 1 page, \d+ words, average confidence \d+%/)).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole('button', { name: 'Undo Recognize text' })).toBeEnabled()
      // the viewer reloads and the words are now in its text layer
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Invoice', { timeout: 30_000 })

      // selectable: the text layer spans sit over the words of the picture
      const box = (await page.locator('[data-page="1"]').boundingBox())!
      const span = page.locator('[data-page="1"] .textLayer span', { hasText: 'Invoice' }).first()
      const sb = (await span.boundingBox())!
      // "Invoice" in the picture: x 202..340 of 1700, y 274..307 of 2200
      expect(Math.abs((sb.x - box.x) / box.width - 202 / 1700)).toBeLessThan(0.03)
      expect(Math.abs((sb.y + sb.height / 2 - box.y) / box.height - 290 / 2200)).toBeLessThan(0.03)

      await saveButton(page).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)

      // ---- the file on disk, read back with PDF.js and pdf-lib ----
      writeFileSync(resolve('test-results/ocr-debug.pdf'), bytesOf(path))
      const read = await readPdf(bytesOf(path))
      expect(read.pages).toHaveLength(1)
      expect(recall(PAGE_TEXT[0].join(' '), flattenText(read.pages))).toBeGreaterThanOrEqual(0.9)
      const inv = read.pages[0].items.find((i) => /invoice/i.test(i.str))!
      expect(Math.abs(inv.x - 72)).toBeLessThan(3) // 202 px at 200 dpi
      expect(Math.abs(inv.y - 110)).toBeLessThan(3) // baseline 110pt below the top
      expect(read.pages[0].imageCount).toBe(1)

      const streams = await pageStreams(path)
      const layer = streams.find((s) => s.dict.has(PDFName.of('EpdfOcrLayer')))!
      expect(layer).toBeTruthy()
      expect(layer.text).toContain('3 Tr') // text render mode 3 = invisible
      expect(layer.text).not.toMatch(/\b[0-2] Tr\b/)
      expect(await imageBytes(path)).toEqual(original) // the scan itself is byte-identical
    } finally {
      await app.close()
    }
  })

  test('undo removes the whole layer, redo brings it back (one step for the whole run)', async () => {
    const path = copyFixture('scan3.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await recognize(app, page)
      await expect(page.getByText(/Recognized 3 pages/)).toBeVisible({ timeout: 90_000 })
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Invoice', { timeout: 30_000 })
      await expect(page.getByTestId('unsaved-dot')).toBeVisible()

      await page.getByRole('button', { name: 'Undo Recognize text' }).click()
      await expect(page.locator('[data-page="1"] .textLayer')).not.toContainText('Invoice')
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0) // back to the saved state: ALL three pages undone at once
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()

      await page.getByRole('button', { name: 'Redo Recognize text' }).click()
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Invoice', { timeout: 30_000 })
      await saveButton(page).click()
      const read = await readPdf(bytesOf(path))
      for (let i = 0; i < 3; i++) expect(recall(PAGE_TEXT[i].join(' '), read.pages[i].text), `page ${i + 1}`).toBeGreaterThanOrEqual(0.85)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

void [existsSync, readdirSync, writeFileSync, join, resolve, axeViolations]
