import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { degrees, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { buildPageText } from '../../src/shared/pagetext'
import { axeViolations, canvasHasInk, launch, menuClick, quitDiscarding, showAdvanced, withSystemClipboard } from './helpers'

/**
 * Arabic, Persian, Urdu and Hebrew OCR in the real app.
 *
 * Always run: a page with a REAL recognized Arabic text layer (tests/fixtures/ocr-rtl/ocr-ara-letter.pdf, made by
 * tests/unit/ocr-rtl-fixture.test.ts) in the viewer: the logical text layer, mouse selection and Copy, the find bar;
 * the dialog's right-to-left languages and the optional page orientation data (downloaded from a local stand-in
 * server), with axe.
 *
 * Only with EPDF_OCR_TESSDATA (a folder with the real ara/osd traineddata; the suite never downloads them): the whole
 * flow with the real Arabic data, served by a local server as if it were the tessdata repository.
 */

const RTL = resolve('tests/fixtures/ocr-rtl')
const CORPUS = JSON.parse(readFileSync(join(RTL, 'corpus.json'), 'utf8')) as { pages: { name: string; lines: string[] }[] }
const LETTER = CORPUS.pages.find((p) => p.name === 'scan-ara-letter')!.lines
const TESSDATA = process.env['EPDF_OCR_TESSDATA'] ?? ''
const hasData = (code: string): boolean => !!TESSDATA && existsSync(join(TESSDATA, `${code}.traineddata`))

const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim()
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const ENV = { EPDF_OCR_WORKERS: '2' }

test.setTimeout(240_000)

function copy(src: string, name = src.split(/[\\/]/).pop()!): string {
  const dir = mkdtempSync(join(tmpdir(), 'epdf-ocr-rtl-'))
  const dest = join(dir, name)
  copyFileSync(src, dest)
  return dest
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Recognize text (OCR)' })
const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })

async function openDialog(app: ElectronApplication, page: Page): Promise<ReturnType<typeof dialog>> {
  await menuClick(app, 'Tools', 'Recognize Text (OCR)…')
  const d = dialog(page)
  await expect(d).toBeVisible()
  await expect(d.getByText('Loading…')).toHaveCount(0)
  return d
}

/** Text of every line of page 1's logical (model) text layer. */
const layerLines = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out: string[] = []
    for (const s of document.querySelectorAll<HTMLElement>('[data-page="1"] .textLayer span[data-line]')) {
      const i = Number(s.dataset.line)
      out[i] = (out[i] ?? '') + (s.textContent ?? '')
    }
    return out
  })

async function dragAcrossLine(page: Page, li: number): Promise<void> {
  const spans = page.locator(`[data-page="1"] .textLayer span[data-line="${li}"]`)
  await spans.first().scrollIntoViewIfNeeded()
  const b = await page.evaluate((i) => {
    const rs = [...document.querySelectorAll<HTMLElement>(`[data-page="1"] .textLayer span[data-line="${i}"]`)].map((s) => s.getBoundingClientRect())
    return { left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)), top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)) }
  }, li)
  const y = (b.top + b.bottom) / 2
  // right to left, as a reader of Arabic selects
  await page.mouse.move(b.right - 1, y)
  await page.mouse.down()
  await page.mouse.move((b.left + b.right) / 2, y, { steps: 5 })
  await page.mouse.move(b.left + 1, y, { steps: 5 })
  await page.mouse.up()
}

/** Fraction of `want`'s words found in `got`. */
function recall(want: string, got: string): number {
  const tok = (s: string): string[] => norm(s).split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean)
  const have = new Set(tok(got))
  const ws = tok(want)
  return ws.filter((w) => have.has(w)).length / ws.length
}

/** A local stand-in for the tessdata repository serving the given files. */
async function packServer(files: Record<string, Buffer>): Promise<{ url: string; hits: () => number; close(): Promise<void> }> {
  let hits = 0
  const server: Server = createServer((req, res) => {
    hits++
    const m = /^\/([a-z_]+)\.traineddata$/.exec(req.url ?? '')
    const body = m ? files[m[1]] : undefined
    if (!body) {
      res.writeHead(404)
      return void res.end()
    }
    res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}

// ---------------------------------------------------------------------------------------------------------------
test.describe('OCR of right-to-left scans: the recognized layer in the viewer', () => {
  test('a recognized Arabic letter: logical text layer, mouse selection and Copy give the line as typed, the find bar finds words', async () => {
    const path = copy(join(RTL, 'ocr-ara-letter.pdf'))
    const { app, page } = await launch({ files: [path], env: ENV })
    try {
      await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas'), { timeout: 30_000 }).toBe(true)
      await page.locator('[data-page="1"] .textLayer[data-pagetext="model"]').waitFor({ timeout: 30_000 })
      const lines = (await layerLines(page)).map(norm)
      // what recognition read (see ocr-ara-letter.txt), in reading order, line by line
      const recognized = readFileSync(join(RTL, 'ocr-ara-letter.txt'), 'utf8').split('\n').map(norm).filter(Boolean)
      expect(lines).toEqual(recognized)
      expect(recall(LETTER.join(' '), lines.join(' '))).toBeGreaterThanOrEqual(0.9)

      // the line with the amount, selected with the mouse from right to left
      const li = lines.findIndex((l) => l.includes('دينار بحريني'))
      expect(li).toBeGreaterThan(0)
      await dragAcrossLine(page, li)
      expect(norm(await page.evaluate(() => getSelection()?.toString() ?? ''))).toBe(lines[li])
      await withSystemClipboard(async () => {
        await page.keyboard.press('Control+C')
        await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('دينار بحريني')
        expect(norm(await app.evaluate(({ clipboard }) => clipboard.readText()))).toBe('نود إفادتكم بأن المبلغ المستحق هو 1250 دينار بحريني.')
      }, app)

      // the find bar: a word, a phrase with a number, and without the hamza (alef variants are folded)
      await page.getByRole('button', { name: 'Find in document' }).click()
      const find = page.getByLabel('Find text')
      for (const [q, n] of [
        ['الفاتورة', 1],
        ['هو 1250 دينار', 1],
        ['افادتكم', 1],
        ['الحسابات', 1],
        ['المبلغ', 2]
      ] as const) {
        await find.fill(q)
        await expect(page.getByRole('search').getByRole('status'), q).toHaveText(new RegExp(`of ${n}\\b`))
        await expect(page.locator('[data-page="1"] .epdf-hit-active').first(), q).toBeVisible()
      }
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('OCR of right-to-left scans: languages and page orientation in the dialog', () => {
  test('Persian, Urdu and Hebrew are offered; the page orientation data is an optional download (verified, removable)', async () => {
    const eng = readFileSync(resolve('resources/ocr/eng.traineddata'))
    // eng stands in for osd.traineddata: the app is told to expect its hash
    const srv = await packServer({ osd: eng })
    const userData = mkdtempSync(join(tmpdir(), 'epdf-ocr-ud-'))
    const { app, page } = await launch({
      files: [copy(join(RTL, 'scan-heb.pdf'))],
      userData,
      env: { ...ENV, EPDF_OCR_BASE_URL: srv.url, EPDF_OCR_TEST_HASHES: JSON.stringify({ osd: sha(eng) }) }
    })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(app, page)
      for (const [code, text] of [
        ['ara', 'Arabic (العربية)'],
        ['fas', 'Persian (فارسی)'],
        ['urd', 'Urdu (اردو)'],
        ['heb', 'Hebrew (עברית)']
      ]) {
        await expect(d.locator(`[data-lang="${code}"]`)).toContainText(text)
        await expect(d.locator(`[data-lang="${code}"]`)).toContainText('Not downloaded')
      }
      // orientation detection (under Advanced options): off by default, needs the data
      await showAdvanced(d)
      const orient = d.locator('[data-lang="osd"]')
      await expect(orient).toContainText('Needs a download · 10.1 MB')
      const box = orient.getByRole('checkbox', { name: /Detect turned pages/ })
      await expect(box).not.toBeChecked()
      await box.check()
      await expect(d.getByTestId('ocr-blocker')).toContainText('Download the page orientation data')
      await expect(d.getByRole('button', { name: /^Recognize/ })).toBeDisabled()
      expect(await axeViolations(page, 'dialog with orientation needing a download')).toEqual([])

      await orient.getByRole('button', { name: /Download page orientation data/ }).click()
      await expect(orient).toContainText('Downloaded', { timeout: 30_000 })
      await expect(d.getByRole('button', { name: /^Recognize/ })).toBeEnabled()
      expect(readdirSync(join(userData, 'ocr-languages'))).toEqual(['osd.traineddata'])
      expect(srv.hits()).toBe(1)
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      expect(await axeViolations(page, 'dialog with orientation downloaded, dark')).toEqual([])

      // removing it turns the option's requirement back on
      await orient.getByRole('button', { name: /Remove page orientation data/ }).click()
      await expect(orient).toContainText('Needs a download')
      await expect(d.getByRole('button', { name: /^Recognize/ })).toBeDisabled()
      expect(readdirSync(join(userData, 'ocr-languages'))).toEqual([])
      await box.uncheck()
      await expect(d.getByRole('button', { name: /^Recognize/ })).toBeEnabled()
    } finally {
      await quitDiscarding(app, page)
      await srv.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
/** A copy of `src` whose page picture is drawn turned by `turn` degrees clockwise, with no /Rotate (a sideways scan). */
async function turnedScan(src: string, turn: 90 | 180 | 270): Promise<string> {
  const pdf = await PDFDocument.load(readFileSync(src))
  const page = pdf.getPage(0)
  const xo = page.node.Resources()!.lookup(PDFName.of('XObject'))
  let jpg: Uint8Array | null = null
  for (const [, ref] of (xo as unknown as { entries(): [unknown, unknown][] }).entries()) {
    const s = pdf.context.lookup(ref as never) as unknown as PDFRawStream
    if (s && 'contents' in s && s.contents[0] === 0xff && s.contents[1] === 0xd8) jpg = s.contents
  }
  if (!jpg) throw new Error('the scan has no JPEG picture')
  const out = await PDFDocument.create()
  const img = await out.embedJpg(Uint8Array.from(jpg)) // a copy: pdf-lib reads the JPEG from the start of its buffer
  const { width: w, height: h } = page.getSize()
  const sideways = turn % 180 !== 0
  const p = out.addPage(sideways ? [h, w] : [w, h])
  // drawImage rotates counterclockwise around the lower left corner: place the picture so it fills the page
  if (turn === 90) p.drawImage(img, { x: 0, y: w, width: w, height: h, rotate: degrees(-90) })
  else if (turn === 180) p.drawImage(img, { x: w, y: h, width: w, height: h, rotate: degrees(180) })
  else p.drawImage(img, { x: h, y: 0, width: w, height: h, rotate: degrees(90) })
  const dest = join(mkdtempSync(join(tmpdir(), 'epdf-ocr-turned-')), `turned-${turn}.pdf`)
  writeFileSync(dest, await out.save())
  return dest
}

test.describe('OCR of right-to-left scans with the REAL language data (EPDF_OCR_TESSDATA)', () => {
  test.skip(!hasData('ara'), 'needs EPDF_OCR_TESSDATA with ara.traineddata (the suite never downloads language data)')

  test('Arabic downloaded from a stand-in server, a noisy scanned letter recognized: search, selection, saved file', async () => {
    const ara = readFileSync(join(TESSDATA, 'ara.traineddata'))
    const srv = await packServer({ ara }) // the real file: its hash is the catalogue's own, no override
    const userData = mkdtempSync(join(tmpdir(), 'epdf-ocr-ud-'))
    const path = copy(join(RTL, 'scan-ara-letter.pdf'))
    const { app, page } = await launch({ files: [path], userData, env: { ...ENV, EPDF_OCR_BASE_URL: srv.url } })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(app, page)
      const row = d.locator('[data-lang="ara"]')
      await row.getByRole('button', { name: /Download Arabic language data/ }).click()
      await expect(row).toContainText('Downloaded', { timeout: 60_000 })
      await row.getByRole('checkbox').check()
      await d.locator('[data-lang="eng"]').getByRole('checkbox').uncheck()
      await d.getByRole('button', { name: /^Recognize/ }).click()
      await expect(toast(page, /Recognized 1 page, \d+ words, average confidence \d+%/)).toBeVisible({ timeout: 120_000 })
      await page.locator('[data-page="1"] .textLayer[data-pagetext="model"]').waitFor({ timeout: 30_000 })
      const lines = (await layerLines(page)).map(norm)
      console.log(`recognized (noisy letter):\n${lines.join('\n')}`)
      expect(recall(LETTER.join(' '), lines.join(' '))).toBeGreaterThanOrEqual(0.6)
      await page.getByRole('button', { name: 'Find in document' }).click()
      for (const q of ['المبلغ', 'تحويل', 'نهاية']) {
        await page.getByLabel('Find text').fill(q)
        await expect(page.getByRole('search').getByRole('status'), q).toHaveText(/of [1-9]/)
      }
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      const saved = buildPageText(await PDFDocument.load(readFileSync(path)), 0)
      expect(norm(saved.text)).toContain('بأن المبلغ المستحق')
    } finally {
      await quitDiscarding(app, page)
      await srv.close()
    }
  })

  test('a real Arabic document scanned by a government office (WHO EMRO, PaperPort): page 1 recognized and searchable', async () => {
    const who = 'C:\\Users\\Administrator\\Documents\\Epdf-Arabic-RealWorld\\who-emro-em_rc48_8_ar.pdf'
    test.skip(!existsSync(who), 'the downloaded real-world scan is not on this machine')
    const ara = readFileSync(join(TESSDATA, 'ara.traineddata'))
    const srv = await packServer({ ara })
    const userData = mkdtempSync(join(tmpdir(), 'epdf-ocr-ud-'))
    const path = copy(who)
    const { app, page } = await launch({ files: [path], userData, env: { ...ENV, EPDF_OCR_BASE_URL: srv.url } })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 30_000 })
      const d = await openDialog(app, page)
      const row = d.locator('[data-lang="ara"]')
      await row.getByRole('button', { name: /Download Arabic language data/ }).click()
      await expect(row).toContainText('Downloaded', { timeout: 60_000 })
      await row.getByRole('checkbox').check()
      await d.getByLabel('Current page').check()
      await d.getByRole('button', { name: /^Recognize/ }).click()
      await expect(toast(page, /Recognized 1 page/)).toBeVisible({ timeout: 180_000 })
      await page.locator('[data-page="1"] .textLayer[data-pagetext="model"]').waitFor({ timeout: 30_000 })
      const lines = (await layerLines(page)).map(norm).filter(Boolean)
      console.log(`recognized (WHO EMRO page 1):\n${lines.join('\n')}`)
      const arabicWords = lines.join(' ').split(' ').filter((w) => /^[\u0621-\u064a]{3,}$/u.test(w))
      expect(arabicWords.length).toBeGreaterThan(20)
      // words of the cover page ("Regional Committee for the Eastern Mediterranean", "agenda", "original: Arabic")
      await page.getByRole('button', { name: 'Find in document' }).click()
      for (const q of ['اللجنة الإقليمية', 'المتوسط', 'جدول الأعمال', 'بالعربية']) {
        await page.getByLabel('Find text').fill(q)
        await expect(page.getByRole('search').getByRole('status'), q).toHaveText(/of [1-9]/)
      }
    } finally {
      await quitDiscarding(app, page)
      await srv.close()
    }
  })

  test('a letter scanned sideways (no /Rotate) is found turned and read the right way up', async () => {
    test.skip(!hasData('osd'), 'needs osd.traineddata in EPDF_OCR_TESSDATA')
    const srv = await packServer({ ara: readFileSync(join(TESSDATA, 'ara.traineddata')), osd: readFileSync(join(TESSDATA, 'osd.traineddata')) })
    const userData = mkdtempSync(join(tmpdir(), 'epdf-ocr-ud-'))
    const path = await turnedScan(join(RTL, 'scan-ara-letter.pdf'), 90)
    const { app, page } = await launch({ files: [path], userData, env: { ...ENV, EPDF_OCR_BASE_URL: srv.url } })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(app, page)
      await showAdvanced(d) // the orientation data is under Advanced options
      for (const code of ['ara', 'osd']) {
        const row = d.locator(`[data-lang="${code}"]`)
        await row.getByRole('button', { name: /Download/ }).click()
        await expect(row).toContainText('Downloaded', { timeout: 60_000 })
      }
      await d.locator('[data-lang="ara"]').getByRole('checkbox').check()
      await d.locator('[data-lang="eng"]').getByRole('checkbox').uncheck()
      await d.locator('[data-lang="osd"]').getByRole('checkbox').check()
      await d.getByRole('button', { name: /^Recognize/ }).click()
      await expect(toast(page, /1 page was scanned turned and read the right way up/)).toBeVisible({ timeout: 120_000 })
      await page.locator('[data-page="1"] .textLayer[data-pagetext="model"]').waitFor({ timeout: 30_000 })
      const lines = (await layerLines(page)).map(norm)
      console.log(`recognized (sideways letter):\n${lines.join('\n')}`)
      expect(recall(LETTER.join(' '), lines.join(' '))).toBeGreaterThanOrEqual(0.6)
      // the page itself is left as it was scanned
      const doc = await PDFDocument.load(readFileSync(path))
      expect(doc.getPage(0).getRotation().angle).toBe(0)
    } finally {
      await quitDiscarding(app, page)
      await srv.close()
    }
  })
})
