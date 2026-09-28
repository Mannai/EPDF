import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { FIX, answerDelete, clickTool, copyFixture, launch, menuClick, quitDiscarding } from './helpers'

/**
 * Keyboard and menu behaviour around placed items and pages: Ctrl+C / Ctrl+V copy and paste a selected item, the
 * File button's menu greys out what needs a document on the start screen, and Delete / Backspace on selected page
 * thumbnails deletes those pages after asking.
 */

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/markup.mjs', resolve(FIX)], { stdio: 'inherit' })
})

const frame = (page: Page) => page.getByTestId('markup-frame')
const thumbs = (page: Page) => page.getByTestId('thumbnails').locator('button[aria-label^="Go to page"]')

async function open(file: string): Promise<{ app: ElectronApplication; page: Page; path: string }> {
  const path = copyFixture(file)
  const l = await launch({ files: [path] })
  await expect(l.page.locator('[data-page="1"] canvas')).toBeVisible()
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
  await l.page.getByLabel('Zoom level').selectOption('fit-page')
  await l.page.waitForTimeout(700)
  return { ...l, path }
}

async function pdfPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const b = (await page.locator('[data-page="1"]').boundingBox())!
  return { x: b.x + (x / 612) * b.width, y: b.y + ((792 - y) / 792) * b.height }
}

async function squaresOnDisk(path: string): Promise<number[][]> {
  const pdf = await PDFDocument.load(readFileSync(path))
  const arr = pdf.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  const out: number[][] = []
  for (let i = 0; i < (arr?.size() ?? 0); i++) {
    const d = arr!.lookup(i, PDFDict)
    if (d.get(PDFName.of('Subtype'))?.toString() !== '/Square') continue
    out.push((d.lookup(PDFName.of('Rect'), PDFArray).asArray() as unknown as { asNumber(): number }[]).map((n) => n.asNumber()))
  }
  return out
}

interface MenuSummary {
  label: string
  enabled: boolean
  submenu?: MenuSummary[]
}

/** Clicks the title bar's File button and returns the menu it would show (recorded by main's test hook). */
async function fileMenu(app: ElectronApplication, page: Page): Promise<MenuSummary[]> {
  await app.evaluate(() => {
    ;(globalThis as { __epdfFileMenus?: unknown[] }).__epdfFileMenus = []
  })
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await expect.poll(() => app.evaluate(() => ((globalThis as { __epdfFileMenus?: unknown[] }).__epdfFileMenus ?? []).length)).toBe(1)
  return app.evaluate(() => (globalThis as unknown as { __epdfFileMenus: MenuSummary[][] }).__epdfFileMenus[0])
}
const find = (items: MenuSummary[], label: string): MenuSummary | undefined => {
  for (const i of items) {
    if (i.label === label) return i
    const s = i.submenu && find(i.submenu, label)
    if (s) return s
  }
  return undefined
}

test.describe('shortcuts and menus', () => {
  test('Ctrl+C / Ctrl+V copy a selected rectangle; each paste lands a little further on and is selected', async () => {
    const { app, page, path } = await open('markup.pdf')
    try {
      await clickTool(page, 'markup.rect')
      const a = await pdfPoint(page, 100, 400)
      const b = await pdfPoint(page, 200, 340)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 8 })
      await page.mouse.up()
      await expect(frame(page)).toHaveAttribute('aria-label', /Selected Rectangle/)
      const first = (await frame(page).boundingBox())!

      await frame(page).focus()
      await page.keyboard.press('Control+c')
      await page.keyboard.press('Control+v')
      await expect(page.getByRole('button', { name: 'Undo Paste' })).toBeEnabled()
      // The copy is selected, down and to the right of the original.
      await expect.poll(async () => (await frame(page).boundingBox())!.x).toBeGreaterThan(first.x + 5)
      const second = (await frame(page).boundingBox())!
      expect(second.y).toBeGreaterThan(first.y + 5)
      expect(Math.abs(second.width - first.width)).toBeLessThan(2)

      await page.keyboard.press('Control+v')
      await expect.poll(async () => (await frame(page).boundingBox())!.x).toBeGreaterThan(second.x + 5)

      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      const rects = (await squaresOnDisk(path)).sort((p, q) => p[0] - q[0])
      expect(rects).toHaveLength(3)
      expect(rects[1][0] - rects[0][0]).toBeCloseTo(12, 0)
      expect(rects[2][0] - rects[0][0]).toBeCloseTo(24, 0)
      expect(rects[1][1] - rects[0][1]).toBeCloseTo(-12, 0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the File menu greys out what needs a document on the start screen, and not once one is open', async () => {
    const { app, page } = await launch()
    try {
      await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible()
      const none = await fileMenu(app, page)
      for (const label of ['Save', 'Save As…', 'Print…', 'Close Tab', 'Reduce File Size…', 'Recognize Text (OCR)…', 'Zoom In', 'Find…'])
        expect(find(none, label)?.enabled, label).toBe(false)
      for (const label of ['Open…', 'New Window', 'Create PDF from File…', 'Combine Files…', 'Scan to PDF…', 'Library…', 'Reduce Several Files…', 'Signatures…'])
        expect(find(none, label)?.enabled, label).toBe(true)
      // A menu with nothing usable left is greyed out as a whole.
      expect(find(none, 'Document')?.enabled).toBe(false)
      expect(find(none, 'Export To')?.enabled).toBe(false)
    } finally {
      await app.close()
    }

    const opened = await open('sample.pdf')
    try {
      const menu = await fileMenu(opened.app, opened.page)
      for (const label of ['Save', 'Print…', 'Close Tab', 'Zoom In', 'Document']) expect(find(menu, label)?.enabled, label).toBe(true)
    } finally {
      await quitDiscarding(opened.app, opened.page)
    }
  })

  test('busy dialogs fold their advanced settings away; opening them is remembered; a field with a problem opens them', async () => {
    const { app, page } = await open('sample.pdf')
    try {
      await menuClick(app, 'Document', 'Header and Footer…')
      const d = page.getByRole('dialog')
      await expect(d.getByTestId('hf-dialog')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
      const toggle = d.locator('[data-advanced="headerfooter"] [data-advanced-toggle]')
      // The common settings are there; margins and the page range are folded away.
      await expect(d.getByLabel('Footer center')).toBeVisible()
      await expect(d.getByLabel('Page numbers')).toBeVisible()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(d.getByLabel('Page range (empty = all)')).toHaveCount(0)
      await toggle.click()
      await d.getByLabel('Page range (empty = all)').fill('2-')
      await toggle.click()
      // Folded again, it says what inside is not the default.
      await expect(toggle).toContainText('pages changed')
      // A bad range opens it by itself.
      await toggle.click()
      await d.getByLabel('Page range (empty = all)').fill('abc')
      await toggle.click()
      await expect(d.getByLabel('Page range (empty = all)')).toBeVisible()
      await d.getByLabel('Page range (empty = all)').fill('')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false') // no problem left: folded, as it was left
      await toggle.click()
      await d.getByRole('button', { name: 'Cancel' }).click()
      await expect(d).toHaveCount(0)

      // Left open, it is open next time.
      await menuClick(app, 'Document', 'Header and Footer…')
      await expect(page.getByRole('dialog').getByLabel('Page range (empty = all)')).toBeVisible()
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

      // The same pattern in the Redact panel and the password dialog.
      await clickTool(page, 'redact-find')
      await expect(page.getByTestId('redact-panel').getByLabel('First page')).toHaveCount(0)
      await expect(page.getByTestId('redact-panel').getByRole('button', { name: /Search options/ })).toHaveAttribute('aria-expanded', 'false')
      await menuClick(app, 'Tools', 'Protect with Password…')
      const p = page.getByRole('dialog', { name: 'Protect with Password' })
      await expect(p.getByLabel('Password to open', { exact: true })).toBeVisible()
      await expect(p.getByLabel('Password to edit', { exact: true })).toHaveCount(0)
      await p.getByRole('button', { name: 'Cancel' }).click()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Delete / Backspace on selected page thumbnails asks, then deletes those pages; Ctrl+click picks several', async () => {
    const { app, page } = await open('sample.pdf')
    try {
      await expect(thumbs(page)).toHaveCount(5)
      await thumbs(page).nth(1).click()
      await page.keyboard.press('Backspace')
      await answerDelete(page, { cancel: true })
      await expect(thumbs(page)).toHaveCount(5)

      await thumbs(page).nth(1).click()
      await page.keyboard.press('Delete')
      await answerDelete(page)
      await expect(thumbs(page)).toHaveCount(4)
      await expect(page.getByRole('button', { name: 'Undo Delete page 2' })).toBeEnabled()

      // Ctrl+click adds pages to the selection; one question for all of them.
      await thumbs(page).nth(0).click()
      await thumbs(page).nth(2).click({ modifiers: ['Control'] })
      await thumbs(page).nth(3).click({ modifiers: ['Control'] })
      await expect(page.getByTestId('thumbnails').locator('button[aria-pressed="true"]')).toHaveCount(3)
      await page.keyboard.press('Backspace')
      await expect(page.getByRole('dialog', { name: 'Delete 3 pages?' })).toBeVisible()
      await answerDelete(page)
      await expect(thumbs(page)).toHaveCount(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})
