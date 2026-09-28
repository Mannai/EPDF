import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib'
import { flattenText, readPdf } from '../support/pdfText'
import { allStreamText, openWith } from '../unit/helpers/securityHelpers'
import { axeViolations, copyFixture, FIX, launch, menuClick, quitDiscarding, showAdvanced } from './helpers'

const PAGE_TEXT: string[][] = JSON.parse(readFileSync(resolve('tests/fixtures/ocr-text.json'), 'utf8'))
const ENG = resolve('resources/ocr/eng.traineddata')
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/ocr.mjs', FIX], { stdio: 'inherit' })
  execFileSync(process.execPath, ['tests/fixtures/forms-signing.mjs', FIX], { stdio: 'inherit' }) // forms-encrypted.pdf
})

test.setTimeout(240_000)

/** Every test runs the recognizer with two workers: the machine is shared with other test runs. */
const ENV = { EPDF_OCR_WORKERS: '2' }
const open = (files: string[], env: Record<string, string> = {}, userData?: string) => launch({ files, userData, env: { ...ENV, ...env } })

const bytesOf = (path: string): Uint8Array => new Uint8Array(readFileSync(path))
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Recognize text (OCR)' })
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true })
const dot = (page: Page) => page.getByTestId('unsaved-dot')
const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })

async function openDialog(app: ElectronApplication, page: Page): Promise<ReturnType<typeof dialog>> {
  await menuClick(app, 'Tools', 'Recognize Text (OCR)…')
  const d = dialog(page)
  await expect(d).toBeVisible()
  await expect(d.getByText('Loading…')).toHaveCount(0)
  await showAdvanced(d) // resolution, contrast, straightening, pages with text
  return d
}

/** Tools ▸ Recognize Text (OCR)… then Recognize in the dialog. */
async function recognize(app: ElectronApplication, page: Page, setup?: (d: ReturnType<typeof dialog>) => Promise<void>): Promise<void> {
  const d = await openDialog(app, page)
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
const layersOf = async (path: string, pageIndex = 0): Promise<number> => (await pageStreams(path, pageIndex)).filter((s) => s.dict.has(PDFName.of('EpdfOcrLayer'))).length

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

/** Text runs of a page as PDF.js reports them (user space transform, so the writing direction is (a, b)). */
async function rawItems(path: string, pageNo = 1): Promise<{ str: string; transform: number[] }[]> {
  const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<typeof import('pdfjs-dist')>
  const pdfjs = await dynImport('file:///' + resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'))
  const task = pdfjs.getDocument({ data: bytesOf(path), useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  const tc = await (await doc.getPage(pageNo)).getTextContent()
  await task.destroy()
  return (tc.items as { str: string; transform: number[] }[]).filter((i) => i.str.trim())
}

/** Where the word `word` sits in the viewer's text layer, as fractions of the displayed page. */
async function spanFraction(page: Page, word: string, pageNo = 1): Promise<{ x: number; yc: number }> {
  const box = (await page.locator(`[data-page="${pageNo}"]`).boundingBox())!
  const sb = (await page.locator(`[data-page="${pageNo}"] .textLayer span`, { hasText: word }).first().boundingBox())!
  return { x: (sb.x - box.x) / box.width, yc: (sb.y + sb.height / 2 - box.y) / box.height }
}

// ---------------------------------------------------------------------------------------------------------------
test.describe('OCR: recognize scanned pages', () => {
  test('adds an invisible, selectable, searchable text layer aligned with the picture; saved file verified', async () => {
    const path = copyFixture('scan1.pdf')
    const original = await imageBytes(path)
    expect(original).toHaveLength(1)
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(page.locator('[data-page="1"] .textLayer')).not.toContainText('Invoice')

      await recognize(app, page)
      await expect(toast(page, /Recognized 1 page, \d+ words, average confidence \d+%/)).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole('button', { name: 'Undo Recognize text' })).toBeEnabled()
      // the viewer reloads and the words are now in its text layer
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Invoice', { timeout: 30_000 })

      // selectable: the text layer spans sit over the words of the picture ("Invoice" is at x 202..340, y 274..307 of 1700x2200)
      const f = await spanFraction(page, 'Invoice')
      expect(Math.abs(f.x - 202 / 1700)).toBeLessThan(0.03)
      expect(Math.abs(f.yc - 290 / 2200)).toBeLessThan(0.03)

      await saveButton(page).click()
      await expect(dot(page)).toHaveCount(0)

      // ---- the file on disk, read back with PDF.js and pdf-lib ----
      const read = await readPdf(bytesOf(path))
      expect(read.pages).toHaveLength(1)
      expect(recall(PAGE_TEXT[0].join(' '), flattenText(read.pages))).toBeGreaterThanOrEqual(0.9)
      const inv = read.pages[0].items.find((i) => /invoice/i.test(i.str))!
      expect(Math.abs(inv.x - 72)).toBeLessThan(3) // 202 px at 200 dpi
      expect(Math.abs(inv.y - 110)).toBeLessThan(3) // baseline 110pt below the top
      expect(read.pages[0].imageCount).toBe(1)

      const layer = (await pageStreams(path)).find((s) => s.dict.has(PDFName.of('EpdfOcrLayer')))!
      expect(layer).toBeTruthy()
      expect(layer.text).toContain('3 Tr') // text render mode 3 = invisible
      expect(layer.text).not.toMatch(/\b[0-2] Tr\b/)
      expect(await imageBytes(path)).toEqual(original) // the scan itself is byte-identical
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('undo removes the whole layer, redo brings it back (one step for the whole run)', async () => {
    const path = copyFixture('scan3.pdf')
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await recognize(app, page)
      await expect(toast(page, /Recognized 3 pages/)).toBeVisible({ timeout: 90_000 })
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Invoice', { timeout: 30_000 })
      await expect(dot(page)).toBeVisible()

      await page.getByRole('button', { name: 'Undo Recognize text' }).click()
      await expect(page.locator('[data-page="1"] .textLayer')).not.toContainText('Invoice')
      await expect(dot(page)).toHaveCount(0) // back to the saved state: ALL three pages undone at once
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()

      await page.getByRole('button', { name: 'Redo Recognize text' }).click()
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Invoice', { timeout: 30_000 })
      await saveButton(page).click()
      await expect(dot(page)).toHaveCount(0)
      const read = await readPdf(bytesOf(path))
      for (let i = 0; i < 3; i++) expect(recall(PAGE_TEXT[i].join(' '), read.pages[i].text), `page ${i + 1}`).toBeGreaterThanOrEqual(0.85)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('multi-page runs report progress per page in the jobs tray', async () => {
    const path = copyFixture('scan3.pdf')
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await page.evaluate(() => {
        const w = window as unknown as { __jobs: { state: string; progress: number; message?: string; title: string }[] }
        w.__jobs = []
        window.epdf.onFeature('job:update', (p) => {
          const u = p as { kind: string; state: string; progress: number; message?: string; title: string }
          if (u.kind === 'ocr:run') w.__jobs.push(u)
        })
      })
      await recognize(app, page)
      await expect(toast(page, /Recognized 3 pages/)).toBeVisible({ timeout: 90_000 })
      const seen = await page.evaluate(() => (window as unknown as { __jobs: { state: string; progress: number; message?: string; title: string }[] }).__jobs)
      expect(seen[0].title).toBe('Recognizing text')
      const messages = seen.map((u) => u.message ?? '')
      expect(messages.some((m) => /Recognized page \d of 3/.test(m))).toBe(true)
      const fractions = seen.filter((u) => u.state === 'running').map((u) => u.progress)
      expect(fractions.some((f) => f > 0 && f < 1)).toBe(true)
      expect([...fractions].sort((a, b) => a - b)).toEqual(fractions) // never goes backwards
      expect(seen[seen.length - 1]).toMatchObject({ state: 'done', progress: 1 })
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('cancelling from the jobs tray stops the run, leaves the document untouched and the app usable', async () => {
    const path = copyFixture('scan-many.pdf')
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await recognize(app, page)
      const tray = page.locator('[data-job="ocr:run"]')
      await expect(tray).toContainText(/Recognized page \d+ of 14/, { timeout: 60_000 })
      await tray.getByRole('button', { name: 'Cancel' }).click()
      await expect(toast(page, /Text recognition was cancelled/)).toBeVisible({ timeout: 30_000 })
      await expect(tray).toContainText('Cancelled')
      await expect(dot(page)).toHaveCount(0) // nothing was applied
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()

      // and a new run works: no stuck worker, no half-finished state
      await recognize(app, page, async (d) => {
        await d.getByLabel('Page range').fill('2')
      })
      await expect(toast(page, /Recognized 1 page/)).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole('button', { name: 'Undo Recognize text' })).toBeEnabled()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('pages that already have text are skipped; "force" runs them again without stacking layers', async () => {
    const path = copyFixture('scan-mixed.pdf')
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await recognize(app, page)
      await expect(toast(page, /Recognized 1 page.*1 page already had text and was skipped/)).toBeVisible({ timeout: 60_000 })
      await saveButton(page).click()
      await expect(dot(page)).toHaveCount(0)
      let read = await readPdf(bytesOf(path))
      expect(read.pages[0].text.replace(/\s+/g, ' ')).toBe('This page already contains genuine searchable text') // untouched, no duplicate
      expect(recall(PAGE_TEXT[1].join(' '), read.pages[1].text)).toBeGreaterThanOrEqual(0.85)
      expect(await layersOf(path, 0)).toBe(0)
      expect(await layersOf(path, 1)).toBe(1)

      // now nothing is left to do: an explanatory message, no edit
      await recognize(app, page)
      await expect(toast(page, /Those pages already contain text/)).toBeVisible()
      await expect(dot(page)).toHaveCount(0)

      // force: both pages are recognized; page 2's earlier layer is replaced, not stacked
      await recognize(app, page, async (d) => {
        await d.getByLabel('Recognize pages that already contain text').check()
      })
      await expect(toast(page, /Recognized 2 pages/)).toBeVisible({ timeout: 60_000 })
      await saveButton(page).click()
      await expect(dot(page)).toHaveCount(0)
      expect(await layersOf(path, 1)).toBe(1)
      read = await readPdf(bytesOf(path))
      expect(recall(PAGE_TEXT[1].join(' '), read.pages[1].text)).toBeGreaterThanOrEqual(0.85)
      expect(read.pages[1].items.filter((i) => /Revenue/i.test(i.str))).toHaveLength(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  for (const file of ['scan-rot90.pdf', 'scan-rot270.pdf', 'scan-crop.pdf']) {
    test(`${file}: the text layer lines up with the picture on rotated pages and pages with CropBox offsets`, async () => {
      const path = copyFixture(file)
      const { app, page } = await open([path])
      try {
        await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
        await recognize(app, page)
        await expect(toast(page, /Recognized 1 page/)).toBeVisible({ timeout: 60_000 })
        await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Invoice', { timeout: 30_000 })
        const f = await spanFraction(page, 'Invoice')
        if (file === 'scan-crop.pdf') {
          // visible box x 60..652, y 90..822 of the 612x792 picture that starts at (40, 60)
          expect(Math.abs(f.x - (72.7 + 40 - 60) / 592)).toBeLessThan(0.03)
          expect(Math.abs(f.yc - (104.4 - (852 - 822)) / 732)).toBeLessThan(0.03)
        } else {
          // the picture is upright on screen in all rotations: 72.7pt from the left edge and about 104pt from the
          // top of the displayed page (792 x 612 pt once the page is turned sideways)
          expect(Math.abs(f.x - 72.7 / 792)).toBeLessThan(0.02)
          expect(Math.abs(f.yc - 104.4 / 612)).toBeLessThan(0.03)
        }
        await saveButton(page).click()
        await expect(dot(page)).toHaveCount(0)
        // (the runs are read in content order: a sideways page has no left-to-right / top-to-bottom order in user space)
        const items = await rawItems(path)
        expect(recall(PAGE_TEXT[0].join(' '), items.map((i) => i.str).join(' '))).toBeGreaterThanOrEqual(0.85)
        // the reading direction in the file follows /Rotate
        const [first] = items
        const [a, b] = first.transform
        const angle = Math.round((Math.atan2(b, a) * 180) / Math.PI)
        expect(angle).toBe(file === 'scan-rot90.pdf' ? 90 : file === 'scan-rot270.pdf' ? -90 : 0)
      } finally {
        await quitDiscarding(app, page)
      }
    })
  }

  test('a crooked scan: straightened for recognition, text written along the tilted lines', async () => {
    const path = copyFixture('scan-skew.pdf')
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await recognize(app, page)
      await expect(toast(page, /Recognized 1 page/)).toBeVisible({ timeout: 60_000 })
      await saveButton(page).click()
      await expect(dot(page)).toHaveCount(0)
      const read = await readPdf(bytesOf(path))
      expect(recall(PAGE_TEXT[0].join(' '), flattenText(read.pages))).toBeGreaterThanOrEqual(0.8)
      const [first] = await rawItems(path)
      const deg = (Math.atan2(first.transform[1], first.transform[0]) * 180) / Math.PI
      expect(deg).toBeGreaterThan(-4.5) // the scan is tilted 3 degrees clockwise = -3 in PDF space
      expect(deg).toBeLessThan(-1.5)
      // and the words of a line remain one line for readers
      expect(flattenText(read.pages)).toMatch(/Invoice number 48213/i)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('without the straighten option and with other resolutions the run still works (preferences are remembered)', async () => {
    const path = copyFixture('scan1.pdf')
    const userData = mkdtempSync(join(tmpdir(), 'epdf-ocr-ud-'))
    const first = await open([path], {}, userData)
    try {
      await expect(first.page.locator('[data-page="1"] canvas')).toBeVisible()
      await recognize(first.app, first.page, async (d) => {
        await d.getByLabel('Straighten tilted pages').uncheck()
        await d.getByLabel('Improve contrast (grayscale)').uncheck()
        await d.getByLabel('Resolution').selectOption('200')
      })
      await expect(toast(first.page, /Recognized 1 page/)).toBeVisible({ timeout: 60_000 })
    } finally {
      await quitDiscarding(first.app, first.page)
    }
    const second = await open([copyFixture('scan1.pdf')], {}, userData)
    try {
      await expect(second.page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(second.app, second.page)
      await expect(d.getByLabel('Straighten tilted pages')).not.toBeChecked()
      await expect(d.getByLabel('Improve contrast (grayscale)')).not.toBeChecked()
      await expect(d.getByLabel('Resolution')).toHaveValue('200')
      await d.getByRole('button', { name: 'Cancel' }).click()
    } finally {
      await quitDiscarding(second.app, second.page)
    }
  })

  test('the page selection: current page, ranges, and clear messages for bad ranges', async () => {
    const path = copyFixture('scan3.pdf')
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(app, page)
      await d.getByLabel('Page range').fill('7')
      await expect(d.getByRole('alert')).toContainText('Page 7 is out of range')
      await expect(d.getByRole('button', { name: /^Recognize/ })).toBeDisabled()
      await d.getByLabel('Page range').fill('2-3')
      await expect(d.getByRole('button', { name: 'Recognize 2 pages' })).toBeEnabled()
      await d.getByLabel('Page range').fill('3-1')
      await expect(d.getByRole('alert')).toContainText('runs backwards')
      await d.getByLabel('Page range').fill('2-3')
      await d.getByRole('button', { name: 'Recognize 2 pages' }).click()
      await expect(toast(page, /Recognized 2 pages/)).toBeVisible({ timeout: 60_000 })
      await saveButton(page).click()
      await expect(dot(page)).toHaveCount(0)
      const read = await readPdf(bytesOf(path))
      expect(read.pages[0].text).toBe('') // page 1 was not selected
      expect(recall(PAGE_TEXT[1].join(' '), read.pages[1].text)).toBeGreaterThanOrEqual(0.85)
      expect(recall(PAGE_TEXT[2].join(' '), read.pages[2].text)).toBeGreaterThanOrEqual(0.85)

      // "Current page": go to page 1
      await page.getByLabel('Page number').fill('1')
      await page.getByLabel('Page number').press('Enter')
      const d2 = await openDialog(app, page)
      await d2.getByLabel(/^Current page/).check()
      await d2.getByRole('button', { name: 'Recognize' }).click()
      await expect(toast(page, /Recognized 1 page/)).toBeVisible({ timeout: 60_000 })
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('OCR: failure paths', () => {
  test('a page picture that cannot be decoded: clear message, document unchanged', async () => {
    const path = copyFixture('scan-corrupt.pdf')
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"]')).toBeVisible()
      await recognize(app, page)
      await expect(page.getByRole('alert').filter({ hasText: /No text was found|could not be|failed/ })).toBeVisible({ timeout: 60_000 })
      await expect(dot(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('one unreadable page does not sink the others', async () => {
    const path = copyFixture('scan-partly-corrupt.pdf')
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"]')).toBeVisible()
      await recognize(app, page)
      await expect(toast(page, /Recognized 1 page/)).toBeVisible({ timeout: 60_000 })
      await saveButton(page).click()
      await expect(dot(page)).toHaveCount(0)
      const read = await readPdf(bytesOf(path))
      expect(recall(PAGE_TEXT[0].join(' '), read.pages[0].text)).toBeGreaterThanOrEqual(0.85)
      expect(read.pages[1].text).toBe('')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a password-protected document: OCR works after the password is given and the saved file stays encrypted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-ocr-enc-'))
    const path = join(dir, 'rc4-128.pdf') // committed RC4-128 fixture, user password "user128"
    writeFileSync(path, readFileSync(resolve('tests/fixtures/security/rc4-128.pdf')))
    const { app, page } = await open([path])
    try {
      const prompt = page.getByRole('dialog', { name: 'Password required', exact: true })
      await expect(prompt).toBeVisible()
      await prompt.getByLabel('Document password').fill('user128')
      await prompt.getByRole('button', { name: 'Open' }).click()
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await recognize(app, page, async (d) => {
        await d.getByLabel('Recognize pages that already contain text').check() // the fixture already has real text
      })
      // if the app still needs the password for editing it asks (and we answer); otherwise it goes straight on
      const ask = page.getByRole('dialog', { name: 'Password required to edit', exact: true })
      if (await ask.isVisible().catch(() => false)) {
        await ask.getByLabel('Password').fill('user128')
        await ask.getByRole('button', { name: 'Unlock' }).click()
      }
      await expect(toast(page, /Recognized \d+ pages?/)).toBeVisible({ timeout: 60_000 })
      await saveButton(page).click()
      await expect(dot(page)).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
    // still encrypted on disk (pdf-lib refuses it), and the decrypted content holds our invisible layer
    const raw = bytesOf(path)
    expect(Buffer.from(raw).toString('latin1')).toContain('/Encrypt')
    await expect(PDFDocument.load(raw, { updateMetadata: false })).rejects.toThrow(/encrypt/i)
    const plain = (await openWith(raw, 'user128')).plain
    const text = await allStreamText(plain)
    expect(text).toContain('3 Tr')
    expect(text).toContain('EPDF-OCR-LAYER')
  })

  test('a damaged or tampered language file is refused and named', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'epdf-ocr-ud-'))
    mkdirSync(join(userData, 'ocr-languages'))
    writeFileSync(join(userData, 'ocr-languages', 'deu.traineddata'), 'this is not a trained data file')
    const path = copyFixture('scan1.pdf')
    const { app, page } = await open([path], {}, userData)
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(app, page)
      const row = d.locator('[data-lang="deu"]')
      await expect(row).toContainText('Downloaded') // the file exists, but is not trusted until it verifies
      await row.getByRole('checkbox').check()
      await d.getByRole('button', { name: /^Recognize/ }).click()
      await expect(page.getByRole('alert').filter({ hasText: /German language data on disk is damaged or has been modified/ })).toBeVisible({ timeout: 30_000 })
      await expect(dot(page)).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the channels reject anything outside the catalogue or with the wrong shape', async () => {
    const { app, page } = await open([copyFixture('scan1.pdf')])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const results = await page.evaluate(async () => {
        const tries: [string, string, unknown][] = [
          ['unknown language', 'ocr:begin', { languages: ['klingon'], total: 1 }],
          ['a url instead of a language', 'ocr:begin', { languages: ['https://evil.example/x'], total: 1 }],
          ['no languages', 'ocr:begin', { languages: [], total: 1 }],
          ['too many languages', 'ocr:begin', { languages: ['eng', 'deu', 'fra', 'spa', 'ita'], total: 1 }],
          ['image as a string', 'ocr:addPage', { sessionId: 'abcdefghij', index: 0, image: 'data:image/png;base64,AAAA' }],
          ['no such session', 'ocr:addPage', { sessionId: 'abcdefghij', index: 0, image: new Uint8Array(4) }],
          ['bundled language removal', 'ocr:removeLanguage', { language: 'eng' }],
          ['path traversal', 'ocr:removeLanguage', { language: '../../epdf.db' }],
          ['download of an unknown language (job)', 'job:start', { kind: 'ocr:download', payload: { language: 'nope' } }],
          ['download of the bundled language (job)', 'job:start', { kind: 'ocr:download', payload: { language: 'eng' } }]
        ]
        const out: string[] = []
        for (const [label, ch, payload] of tries) {
          try {
            const r = (await window.epdf.call(ch, payload)) as { jobId?: string }
            out.push(`${label}: ${r?.jobId ? 'started' : 'accepted'}`)
          } catch (err) {
            out.push(`${label}: rejected`)
          }
        }
        return out
      })
      expect(results).toEqual([
        'unknown language: rejected',
        'a url instead of a language: rejected',
        'no languages: rejected',
        'too many languages: rejected',
        'image as a string: rejected',
        'no such session: rejected',
        'bundled language removal: rejected',
        'path traversal: rejected',
        'download of an unknown language (job): rejected',
        'download of the bundled language (job): started' // accepted by the schema, then fails inside the job (nothing to download)
      ])
      // that last job fails with a clear message and touches nothing
      await expect(page.locator('[data-job="ocr:download"]')).toContainText('nothing to download', { timeout: 15_000 })
      expect(existsSync(join(await app.evaluate(({ app: a }) => a.getPath('userData')), 'ocr-languages', 'eng.traineddata'))).toBe(false)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
interface PackServer {
  url: string
  hits(): number
  close(): Promise<void>
}

/** A local stand-in for the tessdata repository. `chunkDelayMs` slows it down so a download can be cancelled. */
async function packServer(body: Buffer, opts: { chunkDelayMs?: number } = {}): Promise<PackServer> {
  let hits = 0
  const server: Server = createServer((req, res) => {
    hits++
    if (!/^\/[a-z_]+\.traineddata$/.test(req.url ?? '')) {
      res.writeHead(404)
      return void res.end()
    }
    res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' })
    if (!opts.chunkDelayMs) return void res.end(body)
    let offset = 0
    const timer = setInterval(() => {
      if (res.destroyed || offset >= body.length) {
        clearInterval(timer)
        if (!res.destroyed) res.end()
        return
      }
      res.write(body.subarray(offset, offset + 65536))
      offset += 65536
    }, opts.chunkDelayMs)
    res.on('close', () => clearInterval(timer))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}

const packEnv = (srv: PackServer, hash: string): Record<string, string> => ({ EPDF_OCR_BASE_URL: srv.url, EPDF_OCR_TEST_HASHES: JSON.stringify({ deu: hash }) })

test.describe('OCR: languages on demand', () => {
  test('a language is downloaded (verified, atomically installed), used, and remembered', async () => {
    const eng = readFileSync(ENG)
    const srv = await packServer(eng) // stands in for deu.traineddata; its hash is what the app is told to expect
    const userData = mkdtempSync(join(tmpdir(), 'epdf-ocr-ud-'))
    const path = copyFixture('scan1.pdf')
    const first = await open([path], packEnv(srv, sha(eng)), userData)
    try {
      await expect(first.page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(first.app, first.page)
      // English is built in; the rest are listed with their size
      await expect(d.locator('[data-lang="eng"]')).toContainText('Built in')
      for (const name of ['German', 'French', 'Spanish', 'Italian', 'Portuguese', 'Dutch', 'Russian', 'Arabic', 'Chinese (Simplified)', 'Japanese', 'Korean', 'Hindi']) {
        await expect(d.getByTestId('ocr-languages')).toContainText(name)
      }
      const row = d.locator('[data-lang="deu"]')
      await expect(row).toContainText('Not downloaded')
      await row.getByRole('checkbox').check()
      // can't recognize until it is downloaded, and the dialog says why
      await expect(d.getByTestId('ocr-blocker')).toContainText('Download German before recognizing')
      await expect(d.getByRole('button', { name: /^Recognize/ })).toBeDisabled()

      await row.getByRole('button', { name: /Download German language data/ }).click()
      await expect(row).toContainText('Downloaded', { timeout: 30_000 })
      await expect(d.getByRole('button', { name: /^Recognize/ })).toBeEnabled()
      expect(srv.hits()).toBe(1)
      const dir = join(userData, 'ocr-languages')
      expect(readdirSync(dir)).toEqual(['deu.traineddata']) // installed, no leftover .part
      expect(sha(readFileSync(join(dir, 'deu.traineddata')))).toBe(sha(eng))

      await d.getByRole('button', { name: /^Recognize/ }).click()
      await expect(toast(first.page, /Recognized 1 page/)).toBeVisible({ timeout: 60_000 })
    } finally {
      await quitDiscarding(first.app, first.page)
    }

    // remembered across restarts: German is still ticked
    const second = await open([copyFixture('scan1.pdf')], packEnv(srv, sha(eng)), userData)
    try {
      await expect(second.page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(second.app, second.page)
      await expect(d.locator('[data-lang="deu"]').getByRole('checkbox')).toBeChecked()
      await expect(d.locator('[data-lang="eng"]').getByRole('checkbox')).toBeChecked()
      // a downloaded language can be removed again (English cannot)
      await d.locator('[data-lang="deu"]').getByRole('button', { name: /Remove German/ }).click()
      await expect(d.locator('[data-lang="deu"]')).toContainText('Not downloaded')
      await expect(d.locator('[data-lang="eng"]').getByRole('button', { name: /Remove/ })).toHaveCount(0)
      expect(readdirSync(join(userData, 'ocr-languages'))).toEqual([])
    } finally {
      await quitDiscarding(second.app, second.page)
      await srv.close()
    }
  })

  test('a download whose SHA-256 does not match is refused; nothing is installed', async () => {
    const eng = readFileSync(ENG)
    const tampered = Buffer.from(eng)
    tampered[tampered.length - 1] ^= 0xff
    const srv = await packServer(tampered)
    const userData = mkdtempSync(join(tmpdir(), 'epdf-ocr-ud-'))
    const { app, page } = await open([copyFixture('scan1.pdf')], packEnv(srv, sha(eng)), userData)
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(app, page)
      const row = d.locator('[data-lang="deu"]')
      await row.getByRole('button', { name: /Download German language data/ }).click()
      await expect(d.getByTestId('ocr-download-error')).toContainText('failed its integrity check', { timeout: 30_000 })
      await expect(row).toContainText('Not downloaded')
      expect(existsSync(join(userData, 'ocr-languages')) ? readdirSync(join(userData, 'ocr-languages')) : []).toEqual([])
      expect(srv.hits()).toBe(1)
    } finally {
      await quitDiscarding(app, page)
      await srv.close()
    }
  })

  test('a download can be cancelled; nothing is left behind', async () => {
    const eng = readFileSync(ENG)
    const srv = await packServer(eng, { chunkDelayMs: 60 })
    const userData = mkdtempSync(join(tmpdir(), 'epdf-ocr-ud-'))
    const { app, page } = await open([copyFixture('scan1.pdf')], packEnv(srv, sha(eng)), userData)
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(app, page)
      const row = d.locator('[data-lang="deu"]')
      await row.getByRole('button', { name: /Download German language data/ }).click()
      await expect(row).toContainText(/Downloading… \d+%/)
      await expect(page.locator('[data-job="ocr:download"]')).toContainText(/German: [\d.]+ [KM]B of/) // progress in the tray too
      await row.getByRole('button', { name: /Cancel/ }).click()
      await expect(row).toContainText('Not downloaded', { timeout: 15_000 })
      await expect(d.getByTestId('ocr-download-error')).toHaveCount(0) // cancelling is not an error
      await expect.poll(() => (existsSync(join(userData, 'ocr-languages')) ? readdirSync(join(userData, 'ocr-languages')) : [])).toEqual([])
    } finally {
      await quitDiscarding(app, page)
      await srv.close()
    }
  })

  test('airplane mode: English recognition works with no network access at all', async () => {
    const eng = readFileSync(ENG)
    const srv = await packServer(eng)
    const closedPort = srv.url // requests here would be counted
    const path = copyFixture('scan1.pdf')
    // the app is pointed at the counting server; the machine's own proxy settings are cleared as well
    const { app, page } = await open([path], { ...packEnv(srv, sha(eng)), HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await recognize(app, page)
      await expect(toast(page, /Recognized 1 page/)).toBeVisible({ timeout: 60_000 })
      await saveButton(page).click()
      await expect(dot(page)).toHaveCount(0)
      expect(recall(PAGE_TEXT[0].join(' '), flattenText((await readPdf(bytesOf(path))).pages))).toBeGreaterThanOrEqual(0.9)
      expect(srv.hits(), `nothing may contact ${closedPort}`).toBe(0)
    } finally {
      await quitDiscarding(app, page)
      await srv.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('OCR: big documents and accessibility', () => {
  test('a long scan is processed page by page without piling up memory', async () => {
    const path = copyFixture('scan-many.pdf')
    const { app, page } = await open([path])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const base = await app.evaluate(() => process.memoryUsage().rss)
      let peak = 0
      const sampler = setInterval(() => {
        void app
          .evaluate(() => process.memoryUsage().rss)
          .then((v) => (peak = Math.max(peak, v)))
          .catch(() => undefined)
      }, 500)
      try {
        await recognize(app, page)
        await expect(toast(page, /Recognized 14 pages/)).toBeVisible({ timeout: 200_000 })
      } finally {
        clearInterval(sampler)
      }
      // two workers (about 200 MB each) plus a few queued pictures; the pictures of all 14 pages would add ~14 x 1 MB more
      expect(peak - base).toBeLessThan(900 * 1024 * 1024)
      await expect(page.getByRole('button', { name: 'Undo Recognize text' })).toBeEnabled()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the dialog, the jobs tray and the messages have no WCAG 2.1 A/AA violations (light and dark)', async () => {
    const path = copyFixture('scan-many.pdf')
    const { app, page } = await open([path])
    const scan = async (label: string): Promise<void> => expect(await axeViolations(page, label)).toEqual([])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      for (const theme of ['light', 'dark'] as const) {
        await app.evaluate(({ nativeTheme }, t) => {
          nativeTheme.themeSource = t
        }, theme)
        if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
        const d = await openDialog(app, page)
        await scan(`dialog ${theme}`)
        // a state with a warning and an error message
        await d.getByLabel('Page range').fill('99')
        await expect(d.getByRole('alert')).toBeVisible()
        await scan(`dialog range error ${theme}`)
        await d.getByLabel('Page range').fill('')
        await d.getByLabel('All pages').check()
        await d.locator('[data-lang="deu"]').getByRole('checkbox').check()
        await expect(d.getByTestId('ocr-blocker')).toBeVisible()
        await scan(`dialog needs download ${theme}`)
        // keyboard: Escape closes it
        await page.keyboard.press('Escape')
        await expect(d).toHaveCount(0)
      }
      // running: the jobs tray with progress and Cancel, and the completion messages
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light'
      })
      await recognize(app, page, async (d) => {
        await d.locator('[data-lang="deu"]').getByRole('checkbox').uncheck()
      })
      await expect(page.locator('[data-job="ocr:run"]')).toContainText(/Recognized page/, { timeout: 60_000 })
      await scan('jobs tray while running')
      await page.locator('[data-job="ocr:run"]').getByRole('button', { name: 'Cancel' }).click()
      await expect(toast(page, /was cancelled/)).toBeVisible({ timeout: 30_000 })
      await scan('cancelled message')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the dialog is fully keyboard operable', async () => {
    const { app, page } = await open([copyFixture('scan3.pdf')])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(app, page)
      // focus starts inside the dialog and Tab never leaves it
      await expect(d).toContainText('Recognize text (OCR)')
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
      }
      await page.keyboard.press('Escape')
      await expect(d).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})
