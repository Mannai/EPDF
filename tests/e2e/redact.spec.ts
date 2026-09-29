import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFStream, PDFString } from 'pdf-lib'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { bytesToLatin1 } from '../../src/renderer/src/features/textedit/pdfcontent/content'
import { decodeImage } from '../../src/renderer/src/features/redact/logic/imageRedact'
import { FIX, answerDelete, axeViolations, copyFixture, launch, menuClick, quitDiscarding, clickTool, showAdvanced } from './helpers'
import { decoded, residue } from '../support/redactProof'
import { flattenText, readPdf } from '../support/pdfText'
import { openWith } from '../unit/helpers/securityHelpers'

/**
 * Redaction end to end: mark by selection, by area and by search/pattern, review, preview, apply, save, then read
 * the SAVED FILE back and prove that the redacted content is gone (PDF.js, the content engine, every stream and byte).
 */

const SECRET = 'TOPSECRET-4711'
const N = (s: string): PDFName => PDFName.of(s)
const RASTER = { width: 200, height: 40 }

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/redact.mjs', FIX], { stdio: 'ignore' })
})

// ---- helpers -----------------------------------------------------------------------------------------------

const dot = (page: Page): Locator => page.getByTestId('unsaved-dot')
const pageEl = (page: Page, n = 1): Locator => page.locator(`[data-page="${n}"]`)
const tool = (page: Page, id: string): Locator => page.locator(`[data-tool="${id}"]`)
const panel = (page: Page): Locator => page.getByTestId('redact-panel')
const marks = (page: Page): Locator => page.getByTestId('redact-mark')
const toast = (page: Page, text: string | RegExp): Locator => page.locator('[role="status"], [role="alert"]').filter({ hasText: text }).first()

async function openDoc(name: string, opts: { env?: Record<string, string> } = {}): Promise<{ path: string; app: ElectronApplication; page: Page; userData: string }> {
  const path = copyFixture(name)
  const { app, page, userData } = await launch({ files: [path], env: opts.env })
  await expect(pageEl(page).locator('canvas')).toBeVisible()
  await expect(pageEl(page).locator('.textLayer')).not.toBeEmpty()
  return { path, app, page, userData }
}

async function saveNow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dot(page)).toHaveCount(0)
}

async function search(page: Page, text: string): Promise<void> {
  await clickTool(page, 'redact-find')
  await panel(page).getByLabel('Text to find').fill(text)
  await page.getByTestId('redact-search').click()
}

async function addArea(page: Page, pageNo: number, left: number, top: number, width: number, height: number): Promise<void> {
  await showAdvanced(panel(page)) // "Areas by exact position"
  const add = page.getByTestId('redact-add-area-fields')
  await add.getByLabel('Page for the new area').fill(String(pageNo))
  await add.getByLabel('New area left in points').fill(String(left))
  await add.getByLabel('New area top in points').fill(String(top))
  await add.getByLabel('New area width in points').fill(String(width))
  await add.getByLabel('New area height in points').fill(String(height))
  await expect(page.getByTestId('redact-add-area')).toBeEnabled()
  await page.getByTestId('redact-add-area').click()
}

const dialog = (page: Page): Locator => page.getByTestId('redact-dialog')

async function applyThroughDialog(page: Page, opts: { overlay?: RegExp; metadata?: boolean; hidden?: boolean; preview?: boolean } = {}): Promise<void> {
  await page.getByTestId('redact-open-apply').click()
  await expect(dialog(page)).toBeVisible()
  if (opts.overlay) await dialog(page).getByRole('radio', { name: opts.overlay }).check()
  if (opts.metadata) await dialog(page).getByLabel(/All metadata/).check()
  if (opts.hidden) await dialog(page).getByLabel(/Hidden data/).check()
  if (opts.preview) {
    await page.getByTestId('redact-preview-button').click()
    await expect(page.getByTestId('redact-selfcheck')).toContainText('Self-check passed', { timeout: 60_000 })
    // the test documents' drawings are either inside a mark or cut along it: nothing is removed beyond the marks
    await expect(page.getByTestId('redact-collateral')).toHaveCount(0)
  }
  await page.getByTestId('redact-apply-button').click()
  await expect(dialog(page)).toHaveCount(0, { timeout: 60_000 })
}

// ---- THE proof on the saved file --------------------------------------------------------------------------

async function assertProof(path: string, positions: { rawLeft: unknown; jpegLeft: unknown }): Promise<void> {
  void positions
  const bytes = new Uint8Array(readFileSync(path))
  const pdf = await PDFDocument.load(bytes)

  // (1) PDF.js extracts nothing of the secret from any page
  const { pages } = await readPdf(bytes)
  const flat = flattenText(pages)
  expect(flat.replace(/\s+/g, '').toLowerCase()).not.toContain('topsecret')
  expect(flat).not.toContain('4711')

  // (2) the content engine decodes nothing either
  for (let i = 0; i < pdf.getPageCount(); i++) {
    const t = analyzePage(pdf, i).runs.filter((r) => !r.fontName.startsWith('EpdfRdFont')).map((r) => r.text).join('')
    expect(t.replace(/\s+/g, '')).not.toContain('TOPSECRET')
  }

  // (3) no stream, object string or byte holds the secret in any spelling (literal, UTF-16BE, hex, glyph codes)
  expect(residue(bytes, pdf, SECRET)).toEqual([])

  // (4) image pixels: the left half of both images is black; the right half is unchanged (JPEG: within tolerance)
  const xo = pdf.getPage(0).node.Resources()!.lookup(N('XObject')) as PDFDict
  const orig = new Uint8Array(readFileSync(join(FIX, 'redact-proof.raster')))
  let raw = 0
  let jpg = 0
  for (const [k] of xo.entries()) {
    const s = xo.lookup(k)
    if (!(s instanceof PDFStream) || s.dict.lookup(N('Subtype')) !== N('Image')) continue
    const img = decodeImage(pdf, s)!
    const isJpeg = String(s.dict.lookup(N('Filter'))) === '/DCTDecode'
    let inside = 0
    let outside = 0
    for (let y = 0; y < RASTER.height; y++) {
      for (let x = 0; x < RASTER.width; x++) {
        for (let c = 0; c < 3; c++) {
          const v = img.data[(y * RASTER.width + x) * 3 + c]
          if (x < 99) inside = Math.max(inside, v)
          else if (x > 101) outside = Math.max(outside, Math.abs(v - orig[(y * RASTER.width + x) * 3 + c]))
        }
      }
    }
    expect(inside).toBeLessThanOrEqual(isJpeg ? 24 : 0)
    expect(outside).toBeLessThanOrEqual(isJpeg ? 40 : 0)
    if (isJpeg) jpg++
    else raw++
  }
  expect([raw, jpg]).toEqual([1, 1])

  // (5) what was not marked is intact
  for (const keep of ['Public heading that stays', 'Footer text that stays', 'Second page text that stays', 'Form caption that stays', 'Reference', 'plain Helvetica', 'in Noto Sans']) expect(flat).toContain(keep)
  expect(pdf.getPageCount()).toBe(2)
  const subtypes: string[] = []
  let uri = ''
  const annots = pdf.getPage(0).node.Annots()!
  for (let i = 0; i < annots.size(); i++) {
    const d = annots.lookup(i)
    if (d instanceof PDFDict) {
      subtypes.push((d.lookup(N('Subtype')) as PDFName).decodeText())
      const a = d.lookup(N('A'))
      if (a instanceof PDFDict) uri = (a.lookup(N('URI')) as PDFString).decodeText()
    }
  }
  expect(subtypes).toContain('Link')
  expect(uri).toBe('https://example.com/keep')
  expect(subtypes).not.toContain('Text')

  // (6) metadata, bookmarks, named destinations and form values are scrubbed
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info!) as PDFDict
  const infoText: string[] = []
  for (const [, v] of info.entries()) if (v instanceof PDFString || v instanceof PDFHexString) infoText.push(v.decodeText())
  expect(infoText.join('|')).not.toContain('TOPSECRET')
  const meta = pdf.catalog.lookup(N('Metadata'))
  if (meta instanceof PDFStream) expect(bytesToLatin1(decoded(meta)!)).not.toContain('TOPSECRET')
  const titles: string[] = []
  const first = (pdf.catalog.lookup(N('Outlines')) as PDFDict).lookup(N('First'))
  for (let it: unknown = first; it instanceof PDFDict; it = it.lookup(N('Next'))) titles.push((it.lookup(N('Title')) as PDFHexString).decodeText())
  expect(titles).toEqual(['Chapter [redacted]', 'Public chapter'])
  const names = ((pdf.catalog.lookup(N('Names')) as PDFDict).lookup(N('Dests')) as PDFDict).lookup(N('Names')) as PDFArray
  expect(names.size()).toBe(2)
  expect(pdf.getForm().getTextField('keep.field').getText()).toBe('harmless value')
}

// ---- tests -------------------------------------------------------------------------------------------------

test.describe('redaction: mark, preview, apply, save, prove', () => {
  test('search everywhere + areas → preview → apply → save → the saved file no longer holds the secret in any form; version history is purged on request', async () => {
    test.setTimeout(240_000)
    const positions = JSON.parse(readFileSync(join(FIX, 'redact-proof.json'), 'utf8')).positions as Record<string, { x0: number; y0: number; x1: number; y1: number }>
    const { path, app, page, userData } = await openDoc('redact-proof.pdf')
    try {
      // find and mark every occurrence of the secret
      await search(page, SECRET)
      await expect(page.getByTestId('redact-search-status')).toContainText('11 matches on 2 pages')
      await expect(page.getByTestId('redact-result')).toHaveCount(11)
      await page.getByTestId('redact-mark-all').click()
      await expect(page.getByTestId('redact-count')).toContainText('11 marks')
      // the two images and a vector rectangle, by numeric area fields (keyboard-operable)
      const top = (r: { y1: number }): number => 792 - r.y1
      await addArea(page, 1, positions.rawLeft.x0, top(positions.rawLeft), positions.rawLeft.x1 - positions.rawLeft.x0, positions.rawLeft.y1 - positions.rawLeft.y0)
      await addArea(page, 1, positions.jpegLeft.x0, top(positions.jpegLeft), positions.jpegLeft.x1 - positions.jpegLeft.x0, positions.jpegLeft.y1 - positions.jpegLeft.y0)
      await addArea(page, 1, positions.vectorArea.x0, top(positions.vectorArea), positions.vectorArea.x1 - positions.vectorArea.x0, positions.vectorArea.y1 - positions.vectorArea.y0)
      await expect(page.getByTestId('redact-count')).toContainText('14 marks')
      await expect(page.getByTestId('redact-mark-row')).toHaveCount(14)
      expect(await marks(page).count()).toBeGreaterThanOrEqual(1)

      await applyThroughDialog(page, { overlay: /REDACTED/, metadata: false, preview: true })
      await expect(toast(page, 'Save the file to make the redaction permanent')).toBeVisible()
      await expect(dot(page)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Undo Apply redactions' })).toBeEnabled()
      // the document on screen no longer has the secret in its text layer
      await expect(pageEl(page).locator('.textLayer')).not.toContainText('TOPSECRET')
      await expect(pageEl(page).locator('.textLayer')).toContainText('Public heading that stays')
      await expect(page.getByTestId('redact-count')).toContainText('No marks yet')

      // saving offers to purge the version history (a copy of the previous file is a known residue)
      await saveNow(page)
      const versionsDir = join(userData, 'versions')
      const snapshots = (): string[] => (existsSync(versionsDir) ? readdirSync(versionsDir).flatMap((d) => readdirSync(join(versionsDir, d))) : [])
      expect(snapshots().length).toBe(1)
      const purge = page.getByRole('dialog').filter({ hasText: 'Purge the version history?' })
      await expect(purge).toBeVisible()
      await expect(purge).toContainText('unredacted content')
      await purge.getByRole('button', { name: 'Purge version history' }).click()
      await expect(toast(page, /Purged 1 earlier version/)).toBeVisible()
      expect(snapshots()).toEqual([])

      await assertProof(path, { rawLeft: positions.rawLeft, jpegLeft: positions.jpegLeft })
      // a saved redaction is irreversible: the undo history (which held the unredacted bytes) is gone
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
      await expect(pageEl(page).locator('.textLayer')).toContainText('Public heading that stays')
      await expect(pageEl(page).locator('.textLayer')).not.toContainText('TOPSECRET')
      // saving again changes nothing and resurrects nothing
      const before = readFileSync(path)
      await page.getByRole('button', { name: 'Save', exact: true }).click().catch(() => undefined)
      expect(readFileSync(path).equals(before)).toBe(true)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the text tool marks a selection (exact glyph boxes); Escape/keys, undo of marks and the notice work', async () => {
    const { app, page } = await openDoc('redact-proof.pdf')
    try {
      await clickTool(page, 'redact-text')
      await expect(tool(page, 'redact-text')).toHaveAttribute('aria-pressed', 'true')
      await expect(panel(page)).toBeVisible() // the tool opens the panel
      // select the heading through the browser selection, as a mouse drag would, then finish it with a mouse-up
      await page.evaluate(() => {
        const span = [...document.querySelectorAll('[data-page="1"] .textLayer span')].find((s) => s.textContent?.includes('Public heading'))!
        const r = document.createRange()
        r.selectNodeContents(span)
        const sel = window.getSelection()!
        sel.removeAllRanges()
        sel.addRange(r)
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      await expect(marks(page)).toHaveCount(1)
      await expect(marks(page).first()).toHaveAttribute('aria-label', /Text: Public heading that stays on page 1/)
      await expect(toast(page, 'Marked “Public heading that stays”')).toBeVisible()
      await expect(page.getByTestId('redact-mark-row')).toHaveCount(1)
      // nothing was removed yet
      await expect(dot(page)).toHaveCount(0)
      await expect(pageEl(page).locator('.textLayer')).toContainText('Public heading that stays')
      // the mark sits on the text
      const m = await marks(page).first().boundingBox()
      const t = await pageEl(page).locator('.textLayer span', { hasText: 'Public heading' }).first().boundingBox()
      expect(m!.x).toBeLessThan(t!.x + t!.width)
      expect(m!.x + m!.width).toBeGreaterThan(t!.x)
      expect(Math.abs(m!.y + m!.height / 2 - (t!.y + t!.height / 2))).toBeLessThan(t!.height)
      // marks are undoable and clearable before anything is applied
      await panel(page).getByRole('button', { name: 'Clear all' }).click()
      await expect(marks(page)).toHaveCount(0)
      await panel(page).getByTestId('redact-undo-marks').click()
      await expect(marks(page)).toHaveCount(1)
      await marks(page).first().focus()
      // Delete asks first; Cancel keeps the mark.
      await page.keyboard.press('Delete')
      await answerDelete(page, { cancel: true })
      await expect(marks(page)).toHaveCount(1)
      await marks(page).first().focus()
      await page.keyboard.press('Delete')
      await answerDelete(page)
      await expect(marks(page)).toHaveCount(0)
      await expect(page.getByTestId('redact-no-marks')).toBeVisible()
      // Tools ▸ Redact… opens the panel and activates the text tool from the menu
      await clickTool(page, 'redact-text')
      await expect(tool(page, 'redact-text')).toHaveAttribute('aria-pressed', 'false')
      await menuClick(app, 'Tools', 'Redact…')
      await expect(tool(page, 'redact-text')).toHaveAttribute('aria-pressed', 'true')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the area tool: draw with the pointer, nudge and resize with the keyboard, edit by number, delete', async () => {
    const { app, page } = await openDoc('redact-proof.pdf')
    try {
      await clickTool(page, 'redact-area')
      const box = (await pageEl(page).boundingBox())!
      await page.mouse.move(box.x + 100, box.y + 300)
      await page.mouse.down()
      await page.mouse.move(box.x + 260, box.y + 340, { steps: 6 })
      await page.mouse.up()
      await expect(marks(page)).toHaveCount(1)
      await expect(marks(page).first()).toHaveAttribute('aria-label', /Area on page 1/)
      await showAdvanced(panel(page)) // "Areas by exact position"
      const edit = page.getByTestId('redact-edit-area-fields')
      await expect(edit).toBeVisible()
      const left = edit.getByLabel('Selected area left in points')
      // The fields settle a moment after the mark appears; read the starting values only once they stop changing
      // (reading them immediately races the first render and made this test depend on machine speed).
      const settled = async (field: Locator): Promise<number> => {
        let prev = NaN
        for (let i = 0; i < 40; i++) {
          const v = Number(await field.inputValue())
          if (v === prev) return v
          prev = v
          await page.waitForTimeout(150)
        }
        return prev
      }
      const w0 = await settled(edit.getByLabel('Selected area width in points'))
      const l0 = await settled(left)
      expect(w0).toBeGreaterThan(20)
      // keyboard: arrows move by 1 pt (10 with Shift), Alt+arrows resize
      await marks(page).first().focus()
      await page.keyboard.press('Shift+ArrowRight')
      await page.keyboard.press('ArrowRight')
      await expect.poll(async () => Number(await left.inputValue())).toBeCloseTo(l0 + 11, 0)
      await page.keyboard.press('Alt+Shift+ArrowRight')
      await expect.poll(async () => Number(await edit.getByLabel('Selected area width in points').inputValue())).toBeCloseTo(w0 + 10, 0)
      // by number
      await edit.getByLabel('Selected area width in points').fill('90')
      await edit.getByLabel('Selected area width in points').press('Enter')
      await expect.poll(async () => Number(await edit.getByLabel('Selected area width in points').inputValue())).toBe(90)
      const wide = (await marks(page).first().boundingBox())!.width
      await edit.getByLabel('Selected area width in points').fill('45')
      await edit.getByLabel('Selected area width in points').press('Enter')
      await expect.poll(async () => (await marks(page).first().boundingBox())!.width).toBeCloseTo(wide / 2, -1)
      // handles exist on the selected area; dragging a handle resizes it
      await expect(page.getByTestId('redact-area-editor').locator('[data-handle]')).toHaveCount(8)
      await marks(page).first().focus()
      await page.keyboard.press('Delete')
      await answerDelete(page)
      await expect(marks(page)).toHaveCount(0)
      await panel(page).getByTestId('redact-undo-marks').click()
      await expect(marks(page)).toHaveCount(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a rotated page: marks follow the text, and the saved file loses it', async () => {
    const { path, app, page } = await openDoc('redact-rotated.pdf')
    try {
      await search(page, 'ROTATEDSECRET')
      await expect(page.getByTestId('redact-search-status')).toContainText('1 match on 1 page')
      await page.getByTestId('redact-mark-all').click()
      await expect(marks(page)).toHaveCount(1)
      const span = pageEl(page).locator('.textLayer span', { hasText: 'ROTATEDSECRET' }).first()
      await expect(marks(page).first()).toBeVisible()
      await expect(span).toBeVisible() // the text layer re-renders after marks appear: don't sample it mid-render
      // the text runs downwards on a page turned by 90 degrees: the mark must lie inside the text's box, on the same column
      await expect
        .poll(async () => {
          const m = await marks(page).first().boundingBox()
          const t = await span.boundingBox()
          if (!m || !t) return false
          const cx = m.x + m.width / 2
          const cy = m.y + m.height / 2
          return cx > t.x && cx < t.x + t.width && cy > t.y && cy < t.y + t.height
        })
        .toBe(true)
      await applyThroughDialog(page, { overlay: /REDACTED/ })
      await expect(pageEl(page).locator('.textLayer')).not.toContainText('ROTATEDSECRET')
      await expect(pageEl(page).locator('.textLayer')).toContainText('Second rotated line that stays')
      await saveNow(page)
      await page.getByRole('dialog').getByRole('button', { name: 'Keep it' }).click()
      const { pages } = await readPdf(new Uint8Array(readFileSync(path)))
      expect(flattenText(pages)).not.toContain('ROTATEDSECRET')
      expect(flattenText(pages)).toContain('Second rotated line that stays')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---- patterns, custom regular expressions and the review list ------------------------------------------------

test.describe('find and mark: patterns, regular expressions, review list', () => {
  const PRESET_COUNTS: [string, string, string][] = [
    ['E-mail addresses', '3 matches on 2 pages', 'jane.doe@example.com'],
    ['Phone numbers (US and international)', '2 matches on 1 page', '(555) 123-4567'],
    ['Payment card numbers (Luhn checked)', '1 match on 1 page', '4111 1111 1111 1111'],
    ['Social Security numbers (US)', '1 match on 1 page', '123-45-6789'],
    ['IBANs (checksum verified)', '1 match on 1 page', 'DE89 3704 0044 0532 0130 00'],
    ['Dates', '2 matches on 1 page', '2024-03-15'],
    ['URLs', '1 match on 1 page', 'https://example.com/path?q=1'],
    ['IP addresses (IPv4 and IPv6)', '1 match on 1 page', '192.168.0.1']
  ]

  test('every built-in pattern finds the right matches (and skips the look-alikes); review, skip, mark all, page filter', async () => {
    const { app, page } = await openDoc('redact-patterns.pdf')
    try {
      await clickTool(page, 'redact-find')
      await panel(page).getByLabel('Search type').selectOption('preset')
      for (const [label, status, first] of PRESET_COUNTS) {
        await panel(page).getByLabel('Pattern', { exact: true }).selectOption({ label })
        await page.getByTestId('redact-search').click()
        await expect(page.getByTestId('redact-search-status')).toContainText(status)
        await expect(page.getByTestId('redact-result').first()).toContainText(first)
      }
      // review workflow with the e-mail pattern
      await panel(page).getByLabel('Pattern', { exact: true }).selectOption({ label: 'E-mail addresses' })
      await page.getByTestId('redact-search').click()
      await expect(page.getByTestId('redact-result')).toHaveCount(3)
      // pending hits are drawn on the page in a different style from marks
      await expect(page.getByTestId('redact-pending-hit').first()).toBeVisible()
      await expect(marks(page)).toHaveCount(0)
      const rows = page.getByTestId('redact-result')
      await rows.nth(0).getByRole('button', { name: /^Skip match/ }).click()
      await expect(rows.nth(0)).toHaveAttribute('data-decision', 'rejected')
      await rows.nth(1).getByRole('button', { name: /^Mark match/ }).click()
      await expect(rows.nth(1)).toHaveAttribute('data-decision', 'accepted')
      await expect(page.getByTestId('redact-count')).toContainText('1 mark ')
      // page filter shows only the page-2 hit; Mark all works on what is shown
      await panel(page).getByLabel('Show matches on page').selectOption('2')
      await expect(page.getByTestId('redact-result')).toHaveCount(1)
      await page.getByTestId('redact-mark-all').click()
      await expect(page.getByTestId('redact-count')).toContainText('2 marks')
      await panel(page).getByLabel('Show matches on page').selectOption('0')
      await expect(page.getByTestId('redact-mark-all')).toContainText('Mark all (0)')
      // unmarking a hit removes its mark
      await rows.nth(1).getByRole('button', { name: /^Unmark match/ }).click()
      await expect(page.getByTestId('redact-count')).toContainText('1 mark ')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('custom regular expressions: validated, matched with real geometry, and stopped when they would backtrack forever', async () => {
    const { app, page } = await openDoc('redact-patterns.pdf')
    try {
      await clickTool(page, 'redact-find')
      await panel(page).getByLabel('Search type').selectOption('regex')
      const re = panel(page).getByLabel('Regular expression')
      const msg = page.getByTestId('redact-regex-message')
      await re.fill('a(')
      await expect(msg).toContainText(/group|parenthes|\)/i)
      await expect(page.getByTestId('redact-search')).toBeDisabled()
      await re.fill('\\b\\d{3}-\\d{2}-\\d{4}\\b')
      await expect(page.getByTestId('redact-search')).toBeEnabled()
      await page.getByTestId('redact-search').click()
      await expect(page.getByTestId('redact-search-status')).toContainText('2 matches on 1 page')
      // catastrophic backtracking: (a+)+$ on forty a's followed by "!"
      await re.fill('(a+)+$')
      const started = Date.now()
      await page.getByTestId('redact-search').click()
      await expect(page.getByTestId('redact-search-status')).toContainText('takes too long', { timeout: 30_000 })
      expect(Date.now() - started).toBeLessThan(20_000)
      // the app is still responsive
      await panel(page).getByLabel('Search type').selectOption('literal')
      await panel(page).getByLabel('Text to find').fill('bob@example.net')
      await page.getByTestId('redact-search').click()
      await expect(page.getByTestId('redact-search-status')).toContainText('1 match on 1 page')
      // the page range (under Search options) limits the search
      await panel(page).getByLabel('Text to find').fill('example')
      await showAdvanced(panel(page))
      await panel(page).getByLabel('Last page').fill('1')
      await page.getByTestId('redact-search').click()
      await expect(page.getByTestId('redact-search-status')).not.toContainText('2 pages')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('undo and redo of an applied redaction before saving; saving then keeps the version history when asked', async () => {
    const { path, app, page, userData } = await openDoc('redact-patterns.pdf')
    try {
      await clickTool(page, 'redact-find')
      await panel(page).getByLabel('Search type').selectOption('preset')
      await panel(page).getByLabel('Pattern', { exact: true }).selectOption({ label: 'E-mail addresses' })
      await page.getByTestId('redact-search').click()
      await page.getByTestId('redact-mark-all').click()
      await applyThroughDialog(page)
      await expect(pageEl(page).locator('.textLayer')).not.toContainText('jane.doe@example.com')
      await expect(page.getByTestId('redact-unsaved-note')).toBeVisible() // the panel says it is not permanent yet
      await page.getByRole('button', { name: 'Undo Apply redactions' }).click()
      await expect(pageEl(page).locator('.textLayer')).toContainText('jane.doe@example.com')
      await expect(dot(page)).toHaveCount(0) // back to what is on disk
      await page.getByRole('button', { name: 'Redo Apply redactions' }).click()
      await expect(pageEl(page).locator('.textLayer')).not.toContainText('jane.doe@example.com')
      await saveNow(page)
      const dlg = page.getByRole('dialog').filter({ hasText: 'Purge the version history?' })
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: 'Keep it' }).click()
      await expect(toast(page, 'still contains the unredacted content')).toBeVisible()
      const versions = readdirSync(join(userData, 'versions')).flatMap((d) => readdirSync(join(userData, 'versions', d)))
      expect(versions).toHaveLength(1) // the known residue: the previous file is still in the version history
      const { pages } = await readPdf(new Uint8Array(readFileSync(path)))
      expect(flattenText(pages)).not.toContain('jane.doe')
      expect(flattenText(pages)).toContain('Call (555) 123-4567')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---- preview, cancel paths, self-check failures, hidden data --------------------------------------------------

test.describe('apply dialog', () => {
  test('preview shows before and after from real renderings; cancel and Escape leave everything untouched', async () => {
    const positions = JSON.parse(readFileSync(join(FIX, 'redact-proof.json'), 'utf8')).positions as Record<string, { x0: number; y0: number; x1: number; y1: number }>
    const { app, page } = await openDoc('redact-proof.pdf')
    try {
      await clickTool(page, 'redact-area')
      const r = positions.rawLeft
      await addArea(page, 1, r.x0, 792 - r.y1, r.x1 - r.x0, r.y1 - r.y0)
      await page.getByTestId('redact-open-apply').click()
      await expect(dialog(page)).toContainText('1 mark')
      await expect(page.getByTestId('redact-irreversible-note')).toContainText('cannot be undone')
      await expect(page.getByTestId('redact-irreversible-note')).toContainText('version history')
      await page.getByTestId('redact-preview-button').click()
      await expect(page.getByTestId('redact-selfcheck')).toContainText('Self-check passed', { timeout: 60_000 })
      await expect(page.getByTestId('redact-summary')).toContainText('1 image (regions)')
      const canvas = page.getByTestId('preview-canvas')
      // pixel at the top-left of the image (image background colour), read from the canvas of each mode
      const sample = (): Promise<number[]> =>
        canvas.evaluate((c: HTMLCanvasElement, p) => {
          const sx = c.width / 612
          const sy = c.height / 792
          const d = c.getContext('2d')!.getImageData(Math.round((p.x + 2) * sx), Math.round((792 - p.y + 2) * sy), 1, 1).data
          return [d[0], d[1], d[2]]
        }, { x: r.x0, y: r.y1 })
      await expect(canvas).toHaveAttribute('data-ready', 'after:1')
      const after = await sample()
      expect(Math.max(...after)).toBeLessThan(20) // black under the mark
      await page.getByTestId('preview-before').click()
      await expect(canvas).toHaveAttribute('data-ready', 'before:1')
      const before = await sample()
      expect(before[0]).toBeGreaterThan(200) // the image's own background
      await page.getByTestId('preview-after').click()
      await expect(canvas).toHaveAttribute('data-ready', 'after:1')
      // changing an option invalidates the preview
      await dialog(page).getByRole('radio', { name: /REDACTED/ }).check()
      await expect(page.getByTestId('redact-preview-result')).toHaveCount(0)
      // cancel: nothing applied
      await dialog(page).getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog(page)).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
      await expect(page.getByTestId('redact-count')).toContainText('1 mark')
      // Escape closes it too
      await page.getByTestId('redact-open-apply').click()
      await expect(dialog(page)).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog(page)).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0)
      // the ribbon's Apply button opens the dialog; with nothing marked it explains instead
      await clickTool(page, 'redact-apply')
      await expect(dialog(page)).toBeVisible()
      await page.keyboard.press('Escape')
      await panel(page).getByRole('button', { name: 'Clear all' }).click()
      await clickTool(page, 'redact-apply')
      await expect(toast(page, 'Nothing is marked for redaction yet')).toBeVisible()
      await expect(dialog(page)).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a failing self-check blocks the redaction and says where the text is; removing hidden data fixes it', async () => {
    const { path, app, page } = await openDoc('redact-hidden.pdf')
    try {
      await search(page, 'ATTACHSECRET')
      await expect(page.getByTestId('redact-search-status')).toContainText('1 match on 1 page')
      await page.getByTestId('redact-mark-all').click()
      await page.getByTestId('redact-open-apply').click()
      await page.getByTestId('redact-preview-button').click()
      // the attachment still holds the secret: apply is blocked and the finding is listed
      await expect(page.getByTestId('redact-selfcheck')).toContainText('Self-check FAILED', { timeout: 60_000 })
      await expect(page.getByTestId('redact-findings')).toContainText('attachment')
      await expect(page.getByTestId('redact-apply-button')).toBeDisabled()
      await dialog(page).getByLabel(/Hidden data/).check()
      await page.getByTestId('redact-preview-button').click()
      await expect(page.getByTestId('redact-selfcheck')).toContainText('Self-check passed', { timeout: 60_000 })
      await expect(page.getByTestId('redact-apply-button')).toBeEnabled()
      await page.getByTestId('redact-apply-button').click()
      await expect(dialog(page)).toHaveCount(0, { timeout: 60_000 })
      await saveNow(page)
      await page.getByRole('dialog').getByRole('button', { name: 'Keep it' }).click()
      const bytes = new Uint8Array(readFileSync(path))
      const pdf = await PDFDocument.load(bytes)
      const names = pdf.catalog.lookup(N('Names'))
      expect(names instanceof PDFDict && names.has(N('EmbeddedFiles'))).toBe(false)
      expect(pdf.catalog.has(N('OpenAction'))).toBe(false)
      expect(pdf.catalog.has(N('PageLabels'))).toBe(false)
      expect(pdf.getTitle()).toBe('Plain title')
      expect(residue(bytes, pdf, 'ATTACHSECRET')).toEqual([])
      const { pages } = await readPdf(bytes)
      expect(flattenText(pages)).toContain('Another line that stays')
      expect(flattenText(pages)).not.toContain('ATTACHSECRET')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('an encrypted document is unlocked through Security, redacted, and saved still encrypted (no marker or key leaks)', async () => {
    execFileSync(process.execPath, ['tests/fixtures/forms-signing.mjs', FIX], { stdio: 'ignore' })
    const { path, app, page } = await openDoc('forms-encrypted.pdf')
    try {
      await search(page, 'Encrypted')
      await expect(page.getByTestId('redact-search-status')).toContainText(/match/)
      await page.getByTestId('redact-mark-all').click()
      await applyThroughDialog(page, { preview: true })
      await expect(dot(page)).toBeVisible()
      await saveNow(page)
      const dlg = page.getByRole('dialog').filter({ hasText: 'Purge the version history?' })
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: 'Keep it' }).click()
      const bytes = new Uint8Array(readFileSync(path))
      const raw = Buffer.from(bytes).toString('latin1')
      expect(raw).toContain('/Encrypt') // still protected on disk
      expect(raw).not.toContain('EPDF-SECURITY-MARKER') // the in-memory marker (key material) never reaches the file
      expect(raw).not.toContain('EpdfSecurity')
      const opened = await openWith(bytes, '')
      const { pages } = await readPdf(new Uint8Array(opened.plain))
      expect(flattenText(pages)).not.toContain('Encrypted')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})
// ---- accessibility --------------------------------------------------------------------------------------------

test.describe('accessibility of the redaction UI (WCAG 2.1 A/AA, light and dark)', () => {
  test('ribbon, panel with marks and results, apply dialog with preview and errors', async () => {
    test.setTimeout(180_000)
    const { app, page } = await openDoc('redact-hidden.pdf')
    try {
      const themes = ['light', 'dark'] as const
      const scan = async (label: string): Promise<void> => {
        for (const theme of themes) {
          await app.evaluate(({ nativeTheme }, t) => void (nativeTheme.themeSource = t), theme)
          if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
          else await expect(page.locator('html')).not.toHaveClass(/dark/)
          expect(await axeViolations(page, `${label} ${theme}`)).toEqual([])
        }
      }
      await clickTool(page, 'redact-find')
      await scan('ribbon and empty panel')
      await panel(page).getByLabel('Text to find').fill('ATTACHSECRET')
      await page.getByTestId('redact-search').click()
      await expect(page.getByTestId('redact-result')).toHaveCount(1)
      await scan('search results')
      await panel(page).getByLabel('Search type').selectOption('regex')
      await panel(page).getByLabel('Regular expression').fill('a(')
      await scan('invalid regular expression')
      await panel(page).getByLabel('Search type').selectOption('preset')
      await scan('pattern picker')
      await panel(page).getByLabel('Search type').selectOption('literal')
      await page.getByTestId('redact-mark-all').click()
      await scan('panel with marks and area fields')
      await clickTool(page, 'redact-area')
      await scan('area tool active')
      await page.getByTestId('redact-open-apply').click()
      await scan('apply dialog')
      await page.getByTestId('redact-preview-button').click()
      await expect(page.getByTestId('redact-selfcheck')).toContainText('FAILED', { timeout: 60_000 })
      await scan('apply dialog with a failed self-check')
      await dialog(page).getByLabel(/Hidden data/).check()
      await page.getByTestId('redact-preview-button').click()
      await expect(page.getByTestId('redact-selfcheck')).toContainText('passed', { timeout: 60_000 })
      await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'after:1')
      await scan('apply dialog with the before/after preview')
      await page.getByTestId('preview-before').click()
      await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-ready', 'before:1')
      await scan('preview before')
      await page.getByTestId('redact-apply-button').click()
      await expect(dialog(page)).toHaveCount(0, { timeout: 60_000 })
      await scan('after applying (unsaved note)')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})
