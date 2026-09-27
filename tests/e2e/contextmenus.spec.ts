import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib'
import { makeTextPdf } from '../support/libraryFixtures'
import { writeLbFixtures } from '../fixtures/lbFixtures'
import { FIX, clickTool, contextMenu, copyFixture, launch, menuClick, menuLabels, quitDiscarding, showToolTask } from './helpers'

/**
 * Right-click menus everywhere: they are native Windows menus, which Playwright cannot click, so main's test hook
 * picks the item instead (see contextMenu() in helpers.ts). Each test checks what the menu offers and that choosing an
 * item does the same thing as the ribbon or the keyboard.
 */

test.beforeAll(async () => {
  execFileSync(process.execPath, ['tests/fixtures/markup.mjs', resolve(FIX)], { stdio: 'inherit' })
  execFileSync(process.execPath, ['tests/fixtures/forms-signing.mjs', resolve(FIX)], { stdio: 'inherit' })
  execFileSync(process.execPath, ['tests/fixtures/form-builder.mjs', resolve(FIX)], { stdio: 'inherit' })
  await writeLbFixtures(resolve(FIX))
})

/** Screen position of a PDF point on an unrotated 612x792 page. */
async function pdfPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const b = (await page.locator('[data-page="1"]').boundingBox())!
  return { x: b.x + (x / 612) * b.width, y: b.y + ((792 - y) / 792) * b.height }
}

const dot = (page: Page) => page.getByTestId('unsaved-dot')

async function settle(page: Page, n = 1): Promise<void> {
  await expect(page.locator(`[data-page="${n}"] canvas`)).toBeVisible()
  await expect(page.locator(`[data-page="${n}"] .textLayer span`).first()).toBeVisible()
  await page.waitForTimeout(500)
}

/** Drags across one text-layer span, like a reader selecting a line. Returns the span's box. */
async function selectLine(page: Page, text: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const span = page.locator('[data-page="1"] .textLayer span', { hasText: text }).first()
  await expect(span).toBeVisible()
  const b = (await span.boundingBox())!
  await page.mouse.move(b.x + 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width * 0.985, b.y + b.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? '')).toContain(text.slice(0, 10))
  return b
}

const annotCount = async (path: string): Promise<number> => {
  const pdf = await PDFDocument.load(readFileSync(path))
  return pdf.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0
}

async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dot(page)).toHaveCount(0)
}

test.describe('right-click menus', () => {
  test('selected text: copy, search, mark up, link, bookmark, redact; the highlight then has its own menu', async () => {
    const path = copyFixture('markup.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
      await page.getByLabel('Zoom level').selectOption('fit-page')
      await settle(page)
      const before = await annotCount(path)

      const b = await selectLine(page, 'Epdf markup fixture line one')
      const at = async (): Promise<void> => page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' })
      const menu = await contextMenu(app, at, null)
      expect(menuLabels(menu).map((l) => (l.startsWith('Search for “Epdf markup') ? 'Search for …' : l))).toEqual([
        'Copy',
        'Search for …',
        '—',
        'Highlight',
        'Underline',
        'Strikethrough',
        'Squiggly underline',
        '—',
        'Link selected text…',
        '—',
        'Add bookmark for this text',
        '—',
        'Mark for redaction'
      ])
      // The right-click did not lose the selection (so the menu acts on what the reader selected).
      expect(await page.evaluate(() => document.getSelection()?.toString() ?? '')).toContain('Epdf markup fixture')

      await contextMenu(app, at, 'Highlight')
      await expect(dot(page)).toHaveCount(1)
      await save(page)
      expect(await annotCount(path)).toBe(before + 1)

      // With the Select tool, right-clicking the highlight offers its actions; Delete removes it.
      await clickTool(page, 'Select')
      await expect(page.locator('[data-testid="markup-select-layer"][data-ready="true"]').first()).toBeAttached()
      await page.waitForTimeout(300)
      const annotMenu = await contextMenu(app, at, 'Delete')
      expect(menuLabels(annotMenu)).toContain('Show in Comments panel')
      await expect(dot(page)).toHaveCount(1)
      await save(page)
      expect(await annotCount(path)).toBe(before)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('empty page: undo, go to page, sticky note, link, bookmark and page actions; rotate works from here', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await settle(page)
      const pageEl = page.locator('[data-page="1"]')
      const corner = { x: 12, y: 12 } // a margin, away from any text
      const menu = await contextMenu(app, pageEl, null, corner)
      const labels = menuLabels(menu)
      expect(labels.slice(0, 5)).toEqual(['Undo (off)', 'Redo (off)', '—', 'Select all text on this page', 'Go to page…'])
      for (const l of ['Add sticky note', 'Add link here…', 'Add bookmark here', 'Rotate page clockwise', 'Insert blank page after', 'Duplicate page 1', 'Delete page 1', 'Print…']) {
        expect(labels).toContain(l)
      }

      await contextMenu(app, pageEl, 'Rotate page clockwise', corner)
      await expect(dot(page)).toHaveCount(1)
      await expect.poll(async () => {
        const box = (await pageEl.boundingBox())!
        return box.width > box.height
      }).toBe(true)
      // Undo is now available from the same menu, names the edit, and undoes the rotation.
      const undo = menuLabels(await contextMenu(app, pageEl, null, corner))[0]!
      expect(undo).toMatch(/^Undo .*[Rr]otat/)
      await contextMenu(app, pageEl, undo, corner)
      await expect.poll(async () => {
        const box = (await pageEl.boundingBox())!
        return box.width > box.height
      }).toBe(false)

      await contextMenu(app, pageEl, 'Select all text on this page', corner)
      expect((await page.evaluate(() => document.getSelection()?.toString() ?? '')).length).toBeGreaterThan(10)

      await page.evaluate(() => document.getSelection()?.removeAllRanges())
      await contextMenu(app, pageEl, 'Add link here…', corner)
      await expect(page.getByRole('dialog', { name: /link/i })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: /link/i })).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('thumbnails: the page menu for that page (no text items); delete a page from there', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await settle(page)
      const thumb = page.getByRole('button', { name: 'Go to page 2' })
      await expect(thumb.locator('canvas')).toBeVisible()
      const total = (): Promise<string | null> => page.getByText(/^of \d+$/).first().textContent()
      const pages = Number((await total())!.slice(3))
      const menu = await contextMenu(app, thumb, null)
      const labels = menuLabels(menu)
      expect(labels).toContain('Duplicate page 2')
      expect(labels).not.toContain('Select all text on this page')
      expect(labels[0]).not.toBe('—')

      await contextMenu(app, thumb, 'Delete page 2')
      await expect(dot(page)).toHaveCount(1)
      await expect.poll(total).toBe(`of ${pages - 1}`)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('form fields (Edit fields): copy, paste, duplicate, tab order, delete', async () => {
    const { app, page } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await settle(page)
      await showToolTask(page, 'formbuilder.text')
      const btn = page.locator('button[data-tool="formbuilder.text"]')
      await btn.click()
      await expect(page.getByTestId('fb-create-layer').first()).toBeVisible()
      await page.waitForTimeout(400)
      const a = await pdfPoint(page, 72, 722)
      const b = await pdfPoint(page, 272, 700)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 6 })
      await page.mouse.up()
      const count = page.getByTestId('fb-field-count')
      await expect(count).toContainText('Fields (1)', { timeout: 20_000 })
      const frame = page.locator('[data-fb-key]').first()
      await expect(frame).toBeVisible()

      const menu = await contextMenu(app, frame, 'Duplicate')
      expect(menuLabels(menu)).toEqual(['Copy', 'Paste', 'Duplicate', '—', 'Edit tab order', '—', 'Delete field'])
      await expect(count).toContainText('Fields (2)')
      await contextMenu(app, page.locator('[data-fb-key]').first(), 'Delete field')
      await expect(count).toContainText('Fields (1)')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('links (Edit links): edit, copy address, delete', async () => {
    const { app, page } = await launch({ files: [copyFixture('lb-links.pdf')] })
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
      await page.getByLabel('Zoom level').selectOption('fit-page')
      await settle(page)
      await clickTool(page, 'Edit links')
      await expect(page.locator('[data-testid="links-select-layer"][data-ready="true"]').first()).toBeAttached()
      await page.waitForTimeout(300)
      // The existing link covers "Existing link text": x 72..180, y 536..552.
      const p = await pdfPoint(page, 120, 544)
      const menu = await contextMenu(app, () => page.mouse.click(p.x, p.y, { button: 'right' }), null)
      expect(menuLabels(menu)).toEqual(['Edit link…', 'Copy link address', '—', 'Delete link'])
      await expect(page.getByTestId('link-frame')).toBeVisible() // right-click selected it

      await contextMenu(app, page.getByTestId('link-frame'), 'Delete link')
      await expect(page.getByTestId('link-frame')).toHaveCount(0)
      await expect(dot(page)).toHaveCount(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('document tabs: close others, close to the right; the keyboard opens the same menu', async () => {
    const a = copyFixture('sample.pdf')
    const b = copyFixture('markup.pdf')
    const c = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [a, b, c] })
    try {
      const tabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab')
      await expect(tabs).toHaveCount(3)
      const menu = await contextMenu(app, tabs.nth(2), null)
      expect(menuLabels(menu)).toEqual(['Close', 'Close other tabs', 'Close tabs to the right (off)', '—', 'Move to new window', '—', 'Show in File Explorer', 'Copy file path'])

      await contextMenu(app, tabs.nth(0), 'Close tabs to the right')
      await expect(tabs).toHaveCount(1)

      // Shift+F10 on the focused tab.
      await tabs.nth(0).focus()
      const kb = await contextMenu(app, () => page.keyboard.press('Shift+F10'), null)
      expect(menuLabels(kb)[0]).toBe('Close')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('text fields get Undo / Cut / Copy / Paste / Select all', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await settle(page)
      const box = page.getByLabel('Page number')
      await box.fill('2')
      await box.selectText()
      const menu = await contextMenu(app, box, null)
      expect(menuLabels(menu).map((l) => l.replace(' (off)', ''))).toEqual(['Undo', 'Redo', '—', 'Cut', 'Copy', 'Paste', '—', 'Select all'])
      expect(menuLabels(menu)).toContain('Cut') // something is selected, so Cut is on
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('bookmarks: right-click a row, and the toolbar "More" button offers the same menu', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await settle(page)
      await menuClick(app, 'View', 'Bookmarks Panel')
      await expect(page.getByTestId('bookmarks-panel')).toBeVisible()
      const more = page.getByRole('button', { name: 'More bookmark actions' })
      // Nothing selected (the sample has no bookmarks): only "Add bookmark here" is on.
      const empty = await contextMenu(app, () => more.click(), 'Add bookmark here')
      expect(menuLabels(empty).filter((l) => l !== '—' && !l.endsWith('(off)'))).toEqual(['Add bookmark here'])
      const tree = page.getByRole('tree', { name: 'Bookmarks' })
      await expect(tree.getByRole('treeitem')).toHaveCount(1)
      // A new bookmark starts in rename mode; finish that first.
      await page.keyboard.press('Enter')
      const row = tree.getByRole('treeitem').first()
      const menu = await contextMenu(app, row, null)
      expect(menuLabels(menu)).toEqual([
        'Go to bookmark',
        'Rename',
        '—',
        'Add bookmark here',
        'Point to current view',
        '—',
        'Nest under previous',
        'Un-nest',
        'Move up',
        'Move down',
        '—',
        'Bold',
        'Italic',
        '—',
        'Delete'
      ])
      await contextMenu(app, row, 'Bold')
      await expect.poll(async () => menuLabels(await contextMenu(app, row, null))).toContain('Bold ✓')
      await contextMenu(app, row, 'Delete')
      await expect(tree.getByRole('treeitem')).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('library files: favorite, add to folder and remove from the menu; it acts on the selection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-lib-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'alpha.pdf'), await makeTextPdf(['alpha text']))
    writeFileSync(join(dir, 'beta.pdf'), await makeTextPdf(['beta text']))
    const { app, page } = await launch({ env: { EPDF_LIBRARY_WATCH_MS: '300', EPDF_LIBRARY_START_MS: '200', EPDF_LIBRARY_RESCAN_MS: '600000', EPDF_LIBRARY_PICK_FOLDER: dir } })
    try {
      await expect(page.getByRole('heading', { name: 'Epdf' })).toBeVisible()
      await menuClick(app, 'File', 'Library…')
      const lib = page.getByRole('dialog', { name: 'Library' })
      await lib.getByRole('button', { name: 'Add folder…' }).first().click()
      const grid = lib.getByRole('grid', { name: 'Files' })
      const rows = grid.locator('[role="row"][aria-rowindex]:not([aria-rowindex="1"])')
      await expect(rows).toHaveCount(2, { timeout: 30_000 })
      await expect(lib.getByTestId('indexing-message')).toHaveCount(0, { timeout: 60_000 })

      const menu = await contextMenu(app, rows.nth(0), null)
      expect(menuLabels(menu)).toEqual(['Open', 'Open in new window', 'Show in File Explorer', '—', 'Favorite', 'Add to folder…', '—', 'Remove from library…'])
      await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true') // right-click selected it

      await contextMenu(app, rows.nth(0), 'Favorite')
      await expect(lib.getByRole('button', { name: 'Remove alpha.pdf from favorites' })).toBeVisible()

      // With both selected, the menu acts on both.
      await rows.nth(0).click()
      await rows.nth(1).click({ modifiers: ['Shift'] })
      const both = await contextMenu(app, rows.nth(1), null)
      expect(menuLabels(both).slice(0, 3)).toEqual(['Open 2 files', 'Open in new window (off)', 'Show in File Explorer (off)'])

      await contextMenu(app, rows.nth(1), 'Remove from library…')
      await page.getByRole('dialog', { name: 'Remove from library?' }).getByRole('button', { name: 'Remove from library' }).click()
      await expect(rows).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
