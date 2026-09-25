import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFArray, PDFName } from 'pdf-lib'
import { pageLabelsOf } from '../unit/pdfTestUtils'
import { FIX, axeViolations, copyFixture, fixture, gotoPage, launch, menuClick, quitDiscarding } from './helpers'

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/pages-print.mjs', FIX], { stdio: 'inherit' })
})

const SAMPLE = 'Epdf sample page'
const N = (s: string): PDFName => PDFName.of(s)

const load = (path: string): Promise<PDFDocument> => PDFDocument.load(readFileSync(path))
const order = async (path: string, prefix = SAMPLE): Promise<string[]> => pageLabelsOf(await load(path), prefix).map((l) => l.replace(`${prefix} `, ''))
const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'epdf-pp-'))

const grid = (page: Page): Locator => page.getByTestId('organizer-grid')
const thumbs = (page: Page): Locator => page.getByTestId('organizer-page')
const pageItem = (page: Page, n: number): Locator => page.locator(`[data-testid="organizer-page"][data-page="${n}"]`)

async function openOrganizer(app: ElectronApplication, page: Page, expected = 5): Promise<void> {
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  await menuClick(app, 'Document', 'Organize Pages…')
  await expect(page.getByTestId('organizer')).toBeVisible()
  await expect(pageItem(page, 1)).toBeVisible()
  await expect(page.getByTestId('organizer-count')).toContainText(`${expected} pages`)
}

/** Saves through the File menu (the toolbar is hidden in the organizer) and waits until the tab is clean. */
async function save(app: ElectronApplication, page: Page): Promise<void> {
  await menuClick(app, 'File', 'Save')
  await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
  await idle(page)
}

/** The organizer ignores input while an edit is being applied and the edited document reloads. */
async function idle(page: Page): Promise<void> {
  const organizer = page.getByTestId('organizer')
  if (await organizer.count()) await expect(organizer).toHaveAttribute('aria-busy', 'false')
}

async function stubOpenDialog(app: ElectronApplication, paths: string[] | null): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as unknown as { showOpenDialog: () => Promise<unknown> }).showOpenDialog = () =>
      Promise.resolve(p ? { canceled: false, filePaths: p } : { canceled: true, filePaths: [] })
  }, paths)
}

async function stubSaveDialog(app: ElectronApplication, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = () =>
      Promise.resolve(p ? { canceled: false, filePath: p } : { canceled: true })
  }, path)
}

async function dragPage(page: Page, from: number, toPage: number, side: 'before' | 'after'): Promise<void> {
  const a = (await pageItem(page, from).boundingBox())!
  const b = (await pageItem(page, toPage).boundingBox())!
  const x = side === 'before' ? b.x + 8 : b.x + b.width - 8
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 3 })
  await page.mouse.move(x, b.y + b.height / 2, { steps: 12 })
  await expect(page.getByTestId('drop-indicator')).toBeVisible()
  await page.mouse.up()
}

test.describe('organizer: opening, selecting, reordering', () => {
  test('opens as a full-tab view, shows every page, and closes with Done or Escape', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await openOrganizer(app, page)
      await expect(thumbs(page)).toHaveCount(5)
      await expect(page.getByRole('option', { name: 'Page 3 of 5' })).toBeVisible()
      // The viewer's own toolbar is hidden while the organizer is showing.
      await expect(page.getByRole('toolbar', { name: 'Document tools' })).toHaveCount(0)
      await pageItem(page, 3).locator('canvas').waitFor()
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByTestId('organizer')).toHaveCount(0)
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()

      await menuClick(app, 'Document', 'Organize Pages…')
      await expect(page.getByTestId('organizer')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('organizer')).toHaveCount(0)

      // Escape also works when a toolbar control has the focus.
      await menuClick(app, 'Document', 'Organize Pages…')
      await page.getByLabel('Thumbnail size').focus()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('organizer')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('click, ctrl+click, shift+click and Ctrl+A select pages', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await openOrganizer(app, page)
      const selected = async (): Promise<string[]> => thumbs(page).evaluateAll((els) => els.filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.getAttribute('data-page')!))
      await pageItem(page, 2).click()
      expect(await selected()).toEqual(['2'])
      await pageItem(page, 4).click({ modifiers: ['Shift'] })
      expect(await selected()).toEqual(['2', '3', '4'])
      await pageItem(page, 3).click({ modifiers: ['Control'] })
      expect(await selected()).toEqual(['2', '4'])
      await pageItem(page, 5).click()
      expect(await selected()).toEqual(['5'])
      await page.keyboard.press('Control+a')
      expect(await selected()).toEqual(['1', '2', '3', '4', '5'])
      await expect(page.getByTestId('organizer-count')).toContainText('5 of 5 selected')
    } finally {
      await app.close()
    }
  })

  test('drag and drop reorders one page and several pages, with a visible drop indicator; undo/redo', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page)
      await dragPage(page, 5, 1, 'before')
      await expect(page.getByRole('button', { name: 'Undo Move page 5' })).toBeEnabled()
      await save(app, page)
      expect(await order(path)).toEqual(['5', '1', '2', '3', '4'])

      // Two non-adjacent pages ('5' and '2') dragged together to the end (they keep their relative order).
      await pageItem(page, 1).click()
      await pageItem(page, 3).click({ modifiers: ['Control'] })
      await dragPage(page, 3, 5, 'after')
      await expect(page.getByRole('button', { name: 'Undo Move 2 pages' })).toBeEnabled()
      await save(app, page)
      expect(await order(path)).toEqual(['1', '3', '4', '5', '2'])
      // the moved pages are selected afterwards
      await expect(page.getByTestId('organizer-count')).toContainText('2 of 5 selected')

      await page.getByRole('button', { name: /^Undo Move 2 pages/ }).click()
      await save(app, page)
      expect(await order(path)).toEqual(['5', '1', '2', '3', '4'])
      await page.getByRole('button', { name: /^Redo Move 2 pages/ }).click()
      await save(app, page)
      expect(await order(path)).toEqual(['1', '3', '4', '5', '2'])

      // Back in the viewer the document shows the new order.
      await page.getByRole('button', { name: 'Done' }).click()
      await gotoPage(page, 2)
      await expect(page.locator('[data-page="2"] .textLayer')).toContainText('Epdf sample page 3')
      await gotoPage(page, 5)
      await expect(page.locator('[data-page="5"] .textLayer')).toContainText('Epdf sample page 2')
    } finally {
      await app.close()
    }
  })

  test('dropping a page where it already is changes nothing; Escape cancels a drag', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await openOrganizer(app, page)
      await dragPage(page, 3, 3, 'after')
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()

      const a = (await pageItem(page, 2).boundingBox())!
      const b = (await pageItem(page, 5).boundingBox())!
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
      await page.mouse.down()
      await page.mouse.move(b.x + 10, b.y + 40, { steps: 10 })
      await expect(page.getByTestId('drop-indicator')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('drop-indicator')).toHaveCount(0)
      await page.mouse.up()
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()
      await expect(page.getByTestId('organizer')).toBeVisible() // Escape ended the drag, not the organizer
    } finally {
      await app.close()
    }
  })

  test('keyboard only: arrows move focus, Space selects, Alt+Arrow moves pages, and it is announced', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page)
      await grid(page).focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight') // focus page 3
      await expect(grid(page)).toHaveAttribute('aria-activedescendant', 'org-page-3')
      await page.keyboard.press('Space')
      await expect(pageItem(page, 3)).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('status').filter({ hasText: 'Page 3 selected' })).toHaveCount(1)
      await page.keyboard.press('Alt+ArrowLeft')
      await expect(page.getByRole('button', { name: 'Undo Move page 3' })).toBeEnabled()
      await expect(page.getByRole('status').filter({ hasText: 'Page moved to position 2.' })).toHaveCount(1)
      await page.keyboard.press('Alt+End') // to the very end
      await expect(page.getByRole('button', { name: /^Undo Move page 2/ })).toBeEnabled()
      await save(app, page)
      expect(await order(path)).toEqual(['1', '2', '4', '5', '3'])

      // Shift+Arrow extends the selection; Alt+Home moves the block to the start.
      await pageItem(page, 4).click() // selects '5' (page 4 of the file) and focuses it
      await page.keyboard.press('Shift+ArrowRight')
      await expect(page.getByTestId('organizer-count')).toContainText('2 of 5 selected')
      await page.keyboard.press('Alt+Home')
      await save(app, page)
      expect(await order(path)).toEqual(['5', '3', '1', '2', '4'])
      // Delete key removes the selection
      await page.keyboard.press('Delete')
      await expect(thumbs(page)).toHaveCount(3)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('organizer: actions on the selection', () => {
  test('rotate, duplicate and delete; each is one undo step and survives save', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page)
      await pageItem(page, 2).click()
      await pageItem(page, 3).click({ modifiers: ['Control'] })
      await page.getByRole('button', { name: 'Rotate right' }).click()
      await expect(page.getByRole('button', { name: 'Undo Rotate 2 pages clockwise' })).toBeEnabled()
      await page.getByRole('button', { name: 'Rotate left' }).click() // back to 0...
      await page.getByRole('button', { name: 'Rotate left' }).click() // ...and to 270
      await save(app, page)
      expect((await load(path)).getPages().map((p) => p.getRotation().angle)).toEqual([0, 270, 270, 0, 0])

      await page.getByRole('button', { name: /^Undo Rotate 2 pages counterclockwise/ }).click()
      await save(app, page)
      expect((await load(path)).getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 0, 0, 0])

      // Duplicate: each page is copied right after itself and the copies become the selection.
      await pageItem(page, 2).click()
      await page.getByRole('button', { name: 'Duplicate' }).click()
      await expect(thumbs(page)).toHaveCount(6)
      await save(app, page)
      expect(await order(path)).toEqual(['1', '2', '2', '3', '4', '5'])
      await expect(pageItem(page, 3)).toHaveAttribute('aria-selected', 'true')

      // Delete one page (no confirmation), then undo.
      await pageItem(page, 3).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(thumbs(page)).toHaveCount(5)
      await save(app, page)
      expect(await order(path)).toEqual(['1', '2', '3', '4', '5'])
      await page.getByRole('button', { name: /^Undo Delete page 3/ }).click()
      await expect(thumbs(page)).toHaveCount(6)
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByText('/ 6', { exact: true })).toBeVisible() // the viewer knows the new page count
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('deleting many pages asks first; deleting every page is refused', async () => {
    const path = copyFixture('large.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page, 500)
      await pageItem(page, 1).click()
      await page.keyboard.press('Control+a')
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(page.getByRole('alert').filter({ hasText: 'A PDF needs at least one page' })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByTestId('organizer-count')).toContainText('500 of 500 selected')

      await pageItem(page, 2).click()
      await pageItem(page, 7).click({ modifiers: ['Shift'] })
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      const dlg = page.getByRole('dialog', { name: 'Delete 6 pages?' })
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByTestId('organizer-count')).toContainText('6 of 500 selected')
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await page.getByRole('dialog', { name: 'Delete 6 pages?' }).getByRole('button', { name: 'Delete' }).click()
      await expect(page.getByTestId('organizer-count')).toContainText('of 494 selected')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('insert blank pages: size from the neighbour, or a chosen paper size', async () => {
    const path = copyFixture('mixed.pdf') // 612x792, 792x612, 300x400, 612x792
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page, 4)
      await pageItem(page, 3).click()
      await page.getByRole('button', { name: 'Insert blank page…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Insert blank pages' })
      await expect(dlg.getByLabel('Position')).toHaveValue('after') // after the selected page
      await dlg.getByLabel('Position').selectOption('before')
      await dlg.getByRole('button', { name: 'Insert' }).click()
      await expect(thumbs(page)).toHaveCount(5)
      await expect(pageItem(page, 3)).toHaveAttribute('aria-selected', 'true') // the new blank page
      await save(app, page)
      let doc = await load(path)
      // Inserted before page 3: it takes the size of the page before the gap (the 792x612 landscape page 2).
      expect(doc.getPage(2).getSize()).toEqual({ width: 792, height: 612 })
      expect(doc.getPages().map((p) => p.getSize().width)).toEqual([612, 792, 792, 300, 612])

      await page.getByRole('button', { name: 'Insert blank page…' }).click()
      await dlg.getByLabel('Position').selectOption('start')
      await dlg.getByLabel('Page size').selectOption('a4')
      await dlg.getByLabel('Number of pages').fill('2')
      await dlg.getByRole('button', { name: 'Insert' }).click()
      await expect(thumbs(page)).toHaveCount(7)
      await save(app, page)
      doc = await load(path)
      expect(doc.getPages().map((p) => p.getSize().width)).toEqual([595, 595, 612, 792, 792, 300, 612])
      await page.getByRole('button', { name: /^Undo Insert 2 blank pages/ }).click()
      await expect(thumbs(page)).toHaveCount(5)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('insert pages from another PDF: pick which pages and where; encrypted and cancelled sources are handled', async () => {
    const path = copyFixture('sample.pdf')
    const other = copyFixture('other.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page)
      await pageItem(page, 2).click()
      await page.getByRole('button', { name: 'Insert from PDF…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Insert pages from another PDF' })
      await expect(dlg.getByRole('button', { name: 'Insert' })).toBeDisabled()

      // Cancelling the native dialog changes nothing.
      await stubOpenDialog(app, null)
      await dlg.getByRole('button', { name: 'Choose PDF…' }).click()
      await expect(dlg.getByTestId('insert-source')).toHaveText('No file chosen')

      // A password-protected source is refused with a clear message.
      await stubOpenDialog(app, [fixture('encrypted.pdf')])
      await dlg.getByRole('button', { name: 'Choose PDF…' }).click()
      await expect(dlg.getByRole('alert')).toContainText('password protected')
      await expect(dlg.getByRole('button', { name: 'Insert' })).toBeDisabled()

      await stubOpenDialog(app, [other])
      await dlg.getByRole('button', { name: 'Choose PDF…' }).click()
      await expect(dlg.getByTestId('insert-source')).toHaveText('other.pdf (3 pages)')
      await dlg.getByLabel('Pages to insert').fill('3, 1')
      await expect(dlg.getByRole('button', { name: 'Insert' })).toBeEnabled()
      await dlg.getByLabel('Pages to insert').fill('9')
      await expect(dlg.getByRole('alert')).toContainText('Page 9 is out of range')
      await expect(dlg.getByRole('button', { name: 'Insert' })).toBeDisabled()
      await dlg.getByLabel('Pages to insert').fill('3, 1')
      await dlg.getByLabel('Position').selectOption('before')
      await dlg.getByLabel('Page number').fill('4')
      await dlg.getByRole('button', { name: 'Insert' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(thumbs(page)).toHaveCount(7)
      await save(app, page)
      const doc = await load(path)
      expect(pageLabelsOf(doc, SAMPLE).map((l) => l.replace(`${SAMPLE} `, ''))).toEqual(['1', '2', '3', '(blank)', '(blank)', '4', '5'])
      expect(pageLabelsOf(doc, 'Other page').slice(3, 5)).toEqual(['Other page 3', 'Other page 1'])
      await page.getByRole('button', { name: /^Undo Insert 2 pages from other\.pdf/ }).click()
      await expect(thumbs(page)).toHaveCount(5)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('extract the selected pages to a new PDF, then open it; the original stays unchanged', async () => {
    const path = copyFixture('sample.pdf')
    const target = join(tmpDir(), 'extracted.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page)
      await pageItem(page, 4).click()
      await pageItem(page, 2).click({ modifiers: ['Control'] })
      await page.getByRole('button', { name: 'Extract…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Extract pages' })
      await expect(dlg.getByLabel('Pages to extract')).toHaveValue('2,4')

      // Cancelling the save dialog writes nothing.
      await stubSaveDialog(app, null)
      await dlg.getByRole('button', { name: 'Extract…' }).click()
      await expect(page.locator('[data-job="pages:extract"]').first()).toContainText('Finished')
      await expect(dlg.getByRole('button', { name: 'Extract…' })).toBeEnabled() // the (cancelled) save dialog has come back
      await expect(dlg).toBeVisible()
      expect(existsSync(target)).toBe(false)

      await stubSaveDialog(app, target)
      await dlg.getByLabel('Pages to extract').fill('4, 2-3')
      await dlg.getByRole('button', { name: 'Extract…' }).click()
      const done = page.getByRole('dialog', { name: 'Pages extracted' })
      await expect(done).toBeVisible()
      expect(await order(target)).toEqual(['4', '2', '3'])
      await done.getByRole('button', { name: 'Open' }).click()
      await expect(page.getByRole('tab', { name: /extracted\.pdf/ })).toBeVisible()
      // The original document was not touched.
      await expect(page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      expect(await order(path)).toEqual(['1', '2', '3', '4', '5'])
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('organizer: large documents', () => {
  test('a 500-page document only mounts the visible rows and stays responsive', async () => {
    const { app, page } = await launch({ files: [copyFixture('large.pdf')] })
    try {
      await openOrganizer(app, page, 500)
      const mounted = await thumbs(page).count()
      expect(mounted).toBeGreaterThan(0)
      expect(mounted).toBeLessThan(80)
      // Scroll far down: different pages are mounted, still a small number.
      await grid(page).evaluate((el) => (el.scrollTop = el.scrollHeight))
      await expect(pageItem(page, 500)).toBeVisible()
      await expect(pageItem(page, 1)).toHaveCount(0)
      expect(await thumbs(page).count()).toBeLessThan(80)
      await pageItem(page, 500).locator('canvas').waitFor()
      // The event loop is not blocked by rendering.
      const lag = await page.evaluate(() => new Promise<number>((r) => { const t = performance.now(); setTimeout(() => r(performance.now() - t), 50) }))
      expect(lag).toBeLessThan(500)
      // Keyboard navigation to the end scrolls the focused page into view.
      await grid(page).focus()
      await page.keyboard.press('Control+Home')
      await expect(pageItem(page, 1)).toBeVisible()
      await page.keyboard.press('Control+End')
      await expect(pageItem(page, 500)).toBeVisible()
      await expect(grid(page)).toHaveAttribute('aria-activedescendant', 'org-page-500')
    } finally {
      await app.close()
    }
  })

  test('the thumbnail size slider changes the grid and is remembered', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await openOrganizer(app, page)
      const before = (await pageItem(page, 1).boundingBox())!.width
      await page.getByLabel('Thumbnail size').fill('250')
      await expect.poll(async () => (await pageItem(page, 1).boundingBox())!.width).toBeGreaterThan(before + 50)
    } finally {
      await app.close()
    }
  })
})

test.describe('split', () => {
  const splitTarget = async (app: ElectronApplication): Promise<string> => {
    const dir = tmpDir()
    await stubOpenDialog(app, [dir])
    return dir
  }
  const startSplit = async (page: Page): Promise<Locator> => {
    await page.getByRole('button', { name: 'Split…' }).click()
    return page.getByRole('dialog', { name: 'Split document' })
  }

  test('by page ranges: files are named safely, verified with pdf-lib; a cancelled folder dialog does nothing', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page)
      const dlg = await startSplit(page)
      await expect(dlg.getByRole('button', { name: 'Split', exact: true })).toBeDisabled() // no folder yet
      await stubOpenDialog(app, null)
      await dlg.getByRole('button', { name: 'Choose folder…' }).click()
      await expect(dlg.getByTestId('split-folder')).toHaveText('No folder chosen')

      const dir = await splitTarget(app)
      writeFileSync(join(dir, 'sample - 01 - pages 1-2.pdf'), 'precious') // must not be overwritten
      await dlg.getByRole('button', { name: 'Choose folder…' }).click()
      await expect(dlg.getByTestId('split-folder')).not.toHaveText('No folder chosen')
      await dlg.getByRole('textbox', { name: 'Page ranges' }).fill('1-2, 3, 4-')
      await expect(dlg.getByText('Creates 3 files.')).toBeVisible()
      await dlg.getByRole('textbox', { name: 'Page ranges' }).fill('1-9')
      await expect(dlg.getByRole('alert')).toContainText('Page 9 is out of range')
      await expect(dlg.getByRole('button', { name: 'Split', exact: true })).toBeDisabled()
      await dlg.getByRole('textbox', { name: 'Page ranges' }).fill('1-2, 3, 4-')
      await dlg.getByRole('button', { name: 'Split', exact: true }).click()

      const summary = page.getByRole('dialog', { name: 'Split complete' })
      await expect(summary.getByTestId('split-summary')).toContainText('Created 3 files')
      await expect(summary.getByRole('button', { name: 'Show in folder' })).toBeVisible()
      const files = readdirSync(dir).sort()
      expect(files).toEqual(['sample - 01 - pages 1-2 (2).pdf', 'sample - 01 - pages 1-2.pdf', 'sample - 02 - pages 3.pdf', 'sample - 03 - pages 4-5.pdf'])
      expect(readFileSync(join(dir, 'sample - 01 - pages 1-2.pdf'), 'utf8')).toBe('precious')
      expect(await order(join(dir, 'sample - 01 - pages 1-2 (2).pdf'))).toEqual(['1', '2'])
      expect(await order(join(dir, 'sample - 02 - pages 3.pdf'))).toEqual(['3'])
      expect(await order(join(dir, 'sample - 03 - pages 4-5.pdf'))).toEqual(['4', '5'])
      // The original tab is unchanged and clean.
      await summary.getByRole('button', { name: 'Close' }).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('by maximum file size: parts stay under the limit and oversized pages are reported', async () => {
    const path = copyFixture('heavy.pdf') // pages of ~120 KB, page 4 is ~700 KB
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page, 6)
      const dlg = await startSplit(page)
      const dir = await splitTarget(app)
      await dlg.getByRole('button', { name: 'Choose folder…' }).click()
      await dlg.getByLabel('Maximum file size').check()
      await dlg.getByLabel('Largest file').fill('300')
      await dlg.getByLabel('Unit').selectOption('KB')
      await dlg.getByRole('button', { name: 'Split', exact: true }).click()
      const summary = page.getByRole('dialog', { name: 'Split complete' })
      await expect(summary).toBeVisible({ timeout: 60_000 })
      const files = readdirSync(dir).sort()
      expect(files).toHaveLength(4)
      const parts = await Promise.all(files.map(async (f) => ({ f, pages: (await load(join(dir, f))).getPageCount(), size: readFileSync(join(dir, f)).length })))
      expect(parts.map((p) => p.pages)).toEqual([2, 1, 1, 2]) // [1 2] [3] [4: too big on its own] [5 6]
      expect(summary.getByText(/alone is .* over the limit/)).toHaveCount(1)
      // Every part that could be made small enough is under the limit; the oversized one is flagged.
      const over = parts.filter((p) => p.size > 300 * 1024)
      expect(over).toHaveLength(1)
      expect(over[0].pages).toBe(1)
      expect(await order(join(dir, over[0].f), 'Heavy page')).toEqual(['4'])
    } finally {
      await app.close()
    }
  })

  test('by top-level bookmarks: titles become safe file names, broken bookmarks are skipped', async () => {
    const path = copyFixture('outline.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page, 6)
      const dlg = await startSplit(page)
      const dir = await splitTarget(app)
      await dlg.getByRole('button', { name: 'Choose folder…' }).click()
      await dlg.getByLabel('Top-level bookmarks').check()
      await expect(dlg.getByTestId('split-bookmarks')).toContainText('Creates 4 files')
      await expect(dlg.getByTestId('split-bookmarks')).toContainText('had no usable page destination')
      await dlg.getByRole('button', { name: 'Split', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Split complete' })).toBeVisible()
      // Bookmarks: Chapter 1 (p1) [Section 1.1 p2], "../../evil" (p3), "CON" -> named dest chapter3 (p4), Broken, Epilogue (p6).
      const files = readdirSync(dir).sort()
      expect(files).toEqual(['outline - 01 - Chapter 1 Intro.pdf', 'outline - 02 - evil.pdf', 'outline - 03 - _CON.pdf', 'outline - 04 - Epilogue.pdf'])
      expect(readdirSync(tmpdir()).some((f) => f === 'evil.pdf')).toBe(false) // nothing escaped the folder
      expect(await order(join(dir, files[0]), 'Outline page')).toEqual(['1', '2'])
      expect(await order(join(dir, files[1]), 'Outline page')).toEqual(['3'])
      expect(await order(join(dir, files[2]), 'Outline page')).toEqual(['4', '5'])
      expect(await order(join(dir, files[3]), 'Outline page')).toEqual(['6'])
      // Each part carries the bookmarks that live in it.
      const first = await load(join(dir, files[0]))
      const outlines = first.catalog.lookup(N('Outlines'))
      expect(outlines).toBeTruthy()
      expect(first.catalog.has(N('Outlines'))).toBe(true)
    } finally {
      await app.close()
    }
  })

  test('a running split shows progress, can be cancelled, and leaves no files behind', async () => {
    const { app, page } = await launch({ files: [copyFixture('large.pdf')] })
    try {
      await openOrganizer(app, page, 500)
      const dlg = await startSplit(page)
      const dir = await splitTarget(app)
      await dlg.getByRole('button', { name: 'Choose folder…' }).click()
      await dlg.getByLabel('Maximum file size').check()
      await dlg.getByLabel('Largest file').fill('30')
      await dlg.getByLabel('Unit').selectOption('KB')
      await dlg.getByRole('button', { name: 'Split', exact: true }).click()
      const card = page.locator('[data-job="pages:split"]')
      await expect(card.getByRole('progressbar')).toBeVisible()
      await expect(dlg.getByText('Splitting…')).toBeVisible()
      await dlg.getByRole('button', { name: 'Cancel splitting' }).click()
      await expect(card).toContainText('Cancelled')
      await expect(dlg.getByRole('button', { name: 'Split', exact: true })).toBeVisible() // back to the setup form
      expect(readdirSync(dir)).toEqual([])
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('splitting a document without bookmarks explains why', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await openOrganizer(app, page)
      const dlg = await startSplit(page)
      await dlg.getByLabel('Top-level bookmarks').check()
      await expect(dlg.getByTestId('split-bookmarks')).toContainText('This document has no bookmarks.')
      await expect(dlg.getByRole('button', { name: 'Split', exact: true })).toBeDisabled()
    } finally {
      await app.close()
    }
  })
})

test.describe('document menu commands and undo of structure edits', () => {
  test('Rotate Pages…, Delete Pages… and Extract Pages… work from the viewer; page tools keep bookmarks and links', async () => {
    const path = copyFixture('sample.pdf') // has a link on page 1 to page 4
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Pages…')
      const rot = page.getByRole('dialog', { name: 'Rotate pages' })
      await rot.getByLabel('Pages to rotate').fill('2-3')
      await rot.getByLabel('Upside down (180°)').check()
      await rot.getByRole('button', { name: 'Rotate' }).click()
      await expect(page.getByRole('button', { name: 'Undo Rotate 2 pages 180°' })).toBeEnabled()

      await menuClick(app, 'Document', 'Delete Pages…')
      const del = page.getByRole('dialog', { name: 'Delete pages' })
      await del.getByLabel('Pages to delete').fill('9')
      await expect(del.getByRole('alert')).toContainText('out of range')
      await expect(del.getByRole('button', { name: 'Delete' })).toBeDisabled()
      await del.getByLabel('Pages to delete').fill('2')
      await del.getByRole('button', { name: 'Delete' }).click()
      await menuClick(app, 'File', 'Save')
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      const doc = await load(path)
      expect(await order(path)).toEqual(['1', '3', '4', '5'])
      expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 180, 0, 0])
      // The link on page 1 (to old page 4) now points at the page that is 3rd in the file.
      const link = doc.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0)
      const dest = (link as unknown as { lookup(k: PDFName, t: typeof PDFArray): PDFArray }).lookup(N('Dest'), PDFArray)
      expect(doc.getPages().findIndex((p) => p.ref.tag === dest.get(0).toString())).toBe(2)
    } finally {
      await app.close()
    }
  })

  test('Rotate Page Clockwise keeps working and rotates the selected pages inside the organizer', async () => {
    const path = copyFixture('sample.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await openOrganizer(app, page)
      await pageItem(page, 4).click()
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect(page.getByRole('button', { name: 'Undo Rotate page clockwise' })).toBeEnabled()
      await save(app, page)
      expect((await load(path)).getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 0, 90, 0])
    } finally {
      await app.close()
    }
  })
})

test.describe('accessibility', () => {
  test('organizer and its dialogs have no WCAG A/AA violations in light and dark', async () => {
    const { app, page } = await launch({ files: [copyFixture('sample.pdf')] })
    try {
      await openOrganizer(app, page)
      await pageItem(page, 2).click()
      await pageItem(page, 3).click({ modifiers: ['Control'] })
      const scan = async (label: string): Promise<void> => expect(await axeViolations(page, label)).toEqual([])
      await scan('organizer light')
      for (const [button, name] of [
        ['Insert blank page…', 'Insert blank pages'],
        ['Insert from PDF…', 'Insert pages from another PDF'],
        ['Extract…', 'Extract pages'],
        ['Split…', 'Split document']
      ] as const) {
        await page.getByRole('button', { name: button }).click()
        await expect(page.getByRole('dialog', { name })).toBeVisible()
        await scan(`${name} light`)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
      }
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      await scan('organizer dark')
      await page.getByRole('button', { name: 'Split…' }).click()
      await page.getByLabel('Maximum file size').check()
      await scan('split dark')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Insert blank page…' }).click()
      await scan('blank dark')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---- printing --------------------------------------------------------------------------------------------------

test.describe('printing (through the EPDF_PRINT_TO_FILE test hook)', () => {
  const printTo = (): { out: string; env: Record<string, string> } => {
    const out = join(tmpDir(), 'printed.pdf')
    return { out, env: { EPDF_PRINT_TO_FILE: out } }
  }

  async function openPrint(app: ElectronApplication, page: Page): Promise<Locator> {
    await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
    await menuClick(app, 'File', 'Print…')
    const dlg = page.getByRole('dialog', { name: 'Print' })
    await expect(dlg).toBeVisible()
    await expect(dlg.getByTestId('print-preview').locator('canvas')).toBeVisible()
    return dlg
  }

  /** Renders every page of the printed file in the app itself and reports each page's size and ink bounding box. */
  async function inspect(out: string): Promise<{ pages: { w: number; h: number; ink: [number, number, number, number] | null; yellow: boolean; red: boolean }[] }> {
    const { app, page } = await launch({ files: [out] })
    try {
      const n = await load(out).then((d) => d.getPageCount())
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const pages = []
      for (let i = 1; i <= n; i++) {
        await page.getByLabel('Page number').fill(String(i))
        await page.getByLabel('Page number').press('Enter')
        const canvas = page.locator(`[data-page="${i}"] canvas`)
        await expect(canvas).toBeVisible()
        await page.waitForTimeout(400)
        pages.push(
          await page.evaluate((idx) => {
            const c = document.querySelector<HTMLCanvasElement>(`[data-page="${idx}"] canvas`)!
            const g = c.getContext('2d')!
            const d = g.getImageData(0, 0, c.width, c.height).data
            let minX = c.width, minY = c.height, maxX = -1, maxY = -1, yellow = false, red = false
            for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
              const o = (y * c.width + x) * 4
              const [r, gg, b] = [d[o], d[o + 1], d[o + 2]]
              if (r > 235 && gg > 235 && b > 235) continue
              minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
              if (r > 200 && gg > 200 && b < 120) yellow = true
              if (r > 180 && gg < 90 && b < 90) red = true
            }
            return { w: c.width, h: c.height, ink: maxX < 0 ? null : ([minX / c.width, minY / c.height, maxX / c.width, maxY / c.height] as [number, number, number, number]), yellow, red }
          }, i)
        )
      }
      return { pages }
    } finally {
      await app.close()
    }
  }

  test('page ranges and copies decide how many sheets are printed', async () => {
    const { out, env } = printTo()
    const { app, page } = await launch({ files: [copyFixture('annotated.pdf')], env })
    try {
      const dlg = await openPrint(app, page)
      await expect(dlg.getByTestId('print-summary')).toHaveText('3 pages')
      await dlg.getByRole('button', { name: 'Print…' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect((await load(out)).getPageCount()).toBe(3)

      const again = await openPrint(app, page)
      await again.getByLabel('Page range').fill('1, 3')
      await again.getByLabel('Copies').fill('2')
      await expect(again.getByTestId('print-summary')).toHaveText('2 pages × 2 copies = 4 sheets')
      await again.getByRole('button', { name: 'Print…' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const doc = await load(out)
      expect(doc.getPageCount()).toBe(4)
      // Auto orientation: the majority of the chosen pages (1 portrait, 1 landscape) is a tie -> portrait.
      expect(doc.getPage(0).getSize().height).toBeGreaterThan(doc.getPage(0).getSize().width)

      // Only the current page.
      await page.getByLabel('Page number').fill('2')
      await page.getByLabel('Page number').press('Enter')
      const cur = await openPrint(app, page)
      await cur.getByLabel('Current page').check()
      await cur.getByLabel('Copies').fill('1')
      await cur.getByRole('button', { name: 'Print…' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect((await load(out)).getPageCount()).toBe(1)
    } finally {
      await app.close()
    }
  })

  test('invalid ranges and copies are explained and block printing', async () => {
    const { out, env } = printTo()
    const { app, page } = await launch({ files: [copyFixture('annotated.pdf')], env })
    try {
      const dlg = await openPrint(app, page)
      await dlg.getByLabel('Page range').fill('1-9')
      await expect(dlg.getByRole('alert')).toContainText('Page 9 is out of range')
      await expect(dlg.getByRole('button', { name: 'Print…' })).toBeDisabled()
      await dlg.getByLabel('Page range').fill('2-')
      await expect(dlg.getByRole('button', { name: 'Print…' })).toBeEnabled()
      await dlg.getByLabel('Copies').fill('0')
      await expect(dlg.getByRole('alert')).toContainText('Copies must be')
      await expect(dlg.getByRole('button', { name: 'Print…' })).toBeDisabled()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(existsSync(out)).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('annotations are printed or left out as requested, and unsaved edits are printed', async () => {
    const { out, env } = printTo()
    const { app, page } = await launch({ files: [copyFixture('annotated.pdf')], env })
    try {
      // Unsaved edit: delete page 3 in the organizer, then print without saving.
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Delete Pages…')
      const del = page.getByRole('dialog', { name: 'Delete pages' })
      await del.getByLabel('Pages to delete').fill('3')
      await del.getByRole('button', { name: 'Delete' }).click()
      await expect(page.getByTestId('unsaved-dot')).toBeVisible()

      let dlg = await openPrint(app, page)
      await dlg.getByLabel('Page range').fill('1')
      await dlg.getByRole('button', { name: 'Print…' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      let doc = await load(out)
      expect(doc.getPageCount()).toBe(1)
      const withNotes = await inspect(out)
      expect(withNotes.pages[0].yellow).toBe(true)
      expect(withNotes.pages[0].red).toBe(true)

      dlg = await openPrint(app, page)
      await dlg.getByLabel('Page range').fill('1-2')
      await dlg.getByLabel('Print annotations').uncheck()
      await dlg.getByRole('button', { name: 'Print…' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      doc = await load(out)
      expect(doc.getPageCount()).toBe(2) // 3 pages minus the deleted one = 2: the unsaved edit was printed
      const without = await inspect(out)
      expect(without.pages[0].yellow).toBe(false)
      expect(without.pages[0].red).toBe(false)
      expect(without.pages[0].ink).not.toBeNull() // the page text is still there
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('scaling: fit fills the sheet, actual size keeps the page size, custom scale shrinks it', async () => {
    const { out, env } = printTo()
    const { app, page } = await launch({ files: [copyFixture('mixed.pdf')], env })
    try {
      const measure = async (scaling: 'fit' | 'actual' | 'custom', percent?: number): Promise<number> => {
        const dlg = await openPrint(app, page)
        await dlg.getByLabel('Page range').fill('3')
        await dlg.getByLabel('Scaling').selectOption(scaling)
        if (percent) await dlg.getByLabel('Scale in percent').fill(String(percent))
        await dlg.getByRole('button', { name: 'Print…' }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        const r = (await inspect(out)).pages[0]
        // width of the ink relative to the sheet
        return r.ink![2] - r.ink![0]
      }
      const fit = await measure('fit')
      const actual = await measure('actual')
      const half = await measure('custom', 50)
      // Page 3 is 300x400 pt on an A4 sheet: "fit" scales it up by about 1.98, "actual" keeps it, 50% halves it.
      expect(fit / actual).toBeGreaterThan(1.7)
      expect(fit / actual).toBeLessThan(2.3)
      expect(half / actual).toBeGreaterThan(0.42)
      expect(half / actual).toBeLessThan(0.58)
    } finally {
      await app.close()
    }
  })

  test('landscape documents are printed landscape with automatic orientation', async () => {
    const { out, env } = printTo()
    const { app, page } = await launch({ files: [copyFixture('mixed.pdf')], env })
    try {
      const dlg = await openPrint(app, page)
      await dlg.getByLabel('Page range').fill('2')
      await dlg.getByRole('button', { name: 'Print…' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const size = (await load(out)).getPage(0).getSize()
      expect(size.width).toBeGreaterThan(size.height)
    } finally {
      await app.close()
    }
  })

  test('printing leaves no temporary files behind', async () => {
    const { out, env } = printTo()
    // Give the app a private temp folder, so nothing another process creates can be mistaken for a leak.
    const privateTemp = tmpDir()
    const { app, page } = await launch({ files: [copyFixture('annotated.pdf')], env: { ...env, TEMP: privateTemp, TMP: privateTemp, TMPDIR: privateTemp } })
    try {
      const appTemp = await app.evaluate(({ app: a }) => a.getPath('temp'))
      expect(appTemp.toLowerCase()).toBe(privateTemp.toLowerCase())
      const listing = (): string[] => readdirSync(privateTemp).sort()
      const dlg = await openPrint(app, page)
      const before = listing()
      await dlg.getByRole('button', { name: 'Print…' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect((await load(out)).getPageCount()).toBe(3)
      expect(listing().filter((f) => !before.includes(f))).toEqual([])
    } finally {
      await app.close()
    }
  })

  test('Print to PDF saves the current (edited) state as vector PDF with the chosen range, scale and annotations', async () => {
    const target = join(tmpDir(), 'printed-copy.pdf')
    const { app, page } = await launch({ files: [copyFixture('annotated.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Document', 'Rotate Pages…')
      const rot = page.getByRole('dialog', { name: 'Rotate pages' })
      await rot.getByLabel('Pages to rotate').fill('2')
      await rot.getByRole('button', { name: 'Rotate' }).click()
      await expect(page.getByTestId('unsaved-dot')).toBeVisible()

      await menuClick(app, 'File', 'Print to PDF…')
      const dlg = page.getByRole('dialog', { name: 'Print to PDF' })
      await expect(dlg).toBeVisible()
      await dlg.getByLabel('Page range').fill('1-2')
      await dlg.getByLabel('Paper size').selectOption('letter')
      await dlg.getByLabel('Print annotations').uncheck()
      await stubSaveDialog(app, null)
      await dlg.getByRole('button', { name: 'Save as PDF…' }).click()
      await expect(page.locator('[data-job="print:prepare"]').first()).toContainText('Finished')
      await expect(dlg.getByRole('button', { name: 'Save as PDF…' })).toBeEnabled() // the (cancelled) save dialog came back
      await expect(dlg).toBeVisible() // still open, nothing written
      expect(existsSync(target)).toBe(false)

      await stubSaveDialog(app, target)
      await dlg.getByRole('button', { name: 'Save as PDF…' }).click()
      await expect(dlg).toHaveCount(0)
      const doc = await load(target)
      expect(doc.getPageCount()).toBe(2)
      expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
      expect(doc.getPage(1).getRotation().angle).toBe(90) // the unsaved rotation is included
      expect(doc.getPage(0).node.has(N('Annots'))).toBe(false)
      expect(pageLabelsOf(doc, 'Print page')).toEqual(['Print page 1', 'Print page 2']) // vector text is still text
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the print dialog has no WCAG A/AA violations (light and dark)', async () => {
    const { app, page } = await launch({ files: [copyFixture('annotated.pdf')] })
    try {
      const dlg = await openPrint(app, page)
      await dlg.getByLabel('Scaling').selectOption('custom')
      expect(await axeViolations(page, 'print light')).toEqual([])
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      expect(await axeViolations(page, 'print dark')).toEqual([])
      await page.keyboard.press('Escape')
      await menuClick(app, 'File', 'Print to PDF…')
      await expect(page.getByRole('dialog', { name: 'Print to PDF' })).toBeVisible()
      expect(await axeViolations(page, 'print to pdf dark')).toEqual([])
    } finally {
      await app.close()
    }
  })
})
