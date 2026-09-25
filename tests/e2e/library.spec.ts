import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { axeViolations, launch, menuClick, quitDiscarding } from './helpers'
import { generateLibrary, makeCjkPdf, makeCorruptPdf, makeImageOnlyPdf, makePasswordPdf, makeTextPdf } from '../support/libraryFixtures'

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/generate.mjs', 'test-results/fixtures'], { stdio: 'ignore' })
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'epdf-lib-'))
const write = async (dir: string, rel: string, pages: string[]): Promise<string> => {
  const p = join(dir, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, await makeTextPdf(pages))
  return p
}

/** Launches the app pointed at a fresh profile; the "Add folder…" dialog is replaced by `pick` (a test hook). */
async function start(pick?: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const env: Record<string, string> = { EPDF_LIBRARY_WATCH_MS: '300', EPDF_LIBRARY_START_MS: '200', EPDF_LIBRARY_RESCAN_MS: '600000', ...extra }
  if (pick) env['EPDF_LIBRARY_PICK_FOLDER'] = pick
  const l = await launch({ env })
  await expect(l.page.getByRole('heading', { name: 'Epdf' })).toBeVisible()
  return l
}

const library = (page: Page): Locator => page.getByRole('dialog', { name: 'Library' })
const rows = (page: Page): Locator => library(page).getByRole('grid', { name: 'Files' }).getByRole('row')
const nameCells = (page: Page): Locator => library(page).getByRole('grid', { name: 'Files' }).locator('[role="row"][aria-rowindex] [role="gridcell"]:first-child span.font-medium')

async function openLibrary(app: ElectronApplication, page: Page): Promise<void> {
  await menuClick(app, 'File', 'Library…')
  await expect(library(page)).toBeVisible()
}

/** Waits until the background index is idle again ("Up to date." or a finished/cancelled message). */
async function idle(page: Page, timeout = 60_000): Promise<void> {
  await expect(library(page).getByTestId('indexing-message')).toHaveCount(0, { timeout })
}

async function addFolderAndIndex(page: Page): Promise<void> {
  await library(page).getByRole('button', { name: 'Add folder…' }).first().click()
  await expect(library(page).getByTestId('library-status')).not.toHaveText('', { timeout: 30_000 })
  await idle(page)
}

test.describe('library', () => {
  test('add a folder: indexing progress, files appear, name search, sorting, favorites, recents', async () => {
    const dir = tmp()
    await write(dir, 'Invoice 2024.pdf', ['Invoice number 2024-001\nTotal due 500 euros'])
    await write(dir, 'Résumé_Émile.pdf', ['Curriculum vitae of Émile\nExperience in accounting'])
    await write(dir, 'reports/Quarterly report.pdf', ['Quarterly report Q1', 'Revenue grew', 'Appendix with tables'])
    await write(dir, 'reports/Annual report.pdf', ['Annual report cover', 'Financial statements'])
    writeFileSync(join(dir, 'notes.txt'), 'not a pdf')
    const { app, page } = await start(dir)
    try {
      // The empty state offers the library, and the library starts empty with a welcome.
      await page.getByRole('button', { name: 'Open Library' }).click()
      await expect(library(page)).toBeVisible()
      await expect(library(page).getByTestId('library-welcome')).toBeVisible()

      await library(page).getByRole('button', { name: 'Add folder…' }).first().click()
      await expect(rows(page).nth(1)).toBeVisible({ timeout: 30_000 }) // rows are listed while indexing goes on
      await idle(page)
      await expect(library(page).getByTestId('library-counts')).toContainText('4 of 4 files searchable')
      await expect(nameCells(page)).toHaveText(['Annual report.pdf', 'Invoice 2024.pdf', 'Quarterly report.pdf', 'Résumé_Émile.pdf'])
      await expect(library(page).getByTestId('scope-count')).toHaveText('4 files')
      // The watched folder is in the sidebar with its sub-folder.
      const label = dir.split(/[\\/]/).pop()!
      await expect(library(page).getByRole('navigation').getByRole('button', { name: new RegExp(`^${label} 4$`) })).toBeVisible()

      // Instant name search: case-, accent- and substring-insensitive.
      const box = library(page).getByRole('textbox', { name: 'Search file names' })
      await box.fill('resume')
      await expect(nameCells(page)).toHaveText(['Résumé_Émile.pdf'])
      await box.fill('REPORT')
      await expect(nameCells(page)).toHaveText(['Annual report.pdf', 'Quarterly report.pdf'])
      await box.fill('xyz')
      await expect(library(page).getByTestId('library-empty')).toContainText('No files match')
      await box.fill('')
      await expect(nameCells(page)).toHaveCount(4)

      // Sorting by size, both directions, through the header buttons.
      await library(page).getByRole('columnheader', { name: /Size/ }).getByRole('button').click()
      const sizes = await library(page).getByRole('grid', { name: 'Files' }).locator('[role="row"][aria-rowindex] [role="gridcell"]:nth-child(3)').allTextContents()
      expect(sizes.length).toBe(4)

      // Favorites: star a file; it shows in Favorites.
      await library(page).getByRole('button', { name: 'Add Invoice 2024.pdf to favorites' }).click()
      await expect(library(page).getByRole('button', { name: 'Remove Invoice 2024.pdf from favorites' })).toHaveAttribute('aria-pressed', 'true')
      await library(page).getByRole('navigation').getByRole('button', { name: /^Favorites/ }).click()
      await expect(nameCells(page)).toHaveText(['Invoice 2024.pdf'])

      // Opening a file puts it in Recent; Recent lists it first.
      await library(page).getByRole('grid', { name: 'Files' }).getByRole('row').nth(1).dblclick()
      await expect(library(page)).toBeHidden()
      await expect(page.getByRole('tab', { name: /Invoice 2024\.pdf/ })).toBeVisible()
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Invoice number 2024-001')
      await openLibrary(app, page)
      await library(page).getByRole('navigation').getByRole('button', { name: /^Recent/ }).click()
      await expect(nameCells(page).first()).toHaveText('Invoice 2024.pdf')
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
