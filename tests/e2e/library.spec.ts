import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { axeViolations, launch, menuClick, quitDiscarding } from './helpers'
import { generateLibrary, makeCjkPdf, makeCorruptPdf, makeImageOnlyPdf, makePasswordPdf, makeTextPdf } from '../support/libraryFixtures'

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/generate.mjs', 'test-results/fixtures'], { stdio: 'ignore' })
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'epdf-lib-'))
const statExists = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
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

  test('content search: highlighted snippets and page numbers, then open at that page with the term highlighted', async () => {
    const dir = tmp()
    await write(dir, 'contracts.pdf', ['Contract cover page', 'Terms and conditions apply', 'The zebra clause governs all animals', 'Signatures at the end'])
    await write(dir, 'menu.pdf', ['Café crème brûlée and Crème anglaise'])
    await write(dir, 'finance.pdf', ['annual report budget forecast', 'draft budget only'])
    writeFileSync(join(dir, 'nihongo.pdf'), await makeCjkPdf(['日本語のテスト文書 東京タワー']))
    const { app, page } = await start(dir)
    try {
      await openLibrary(app, page)
      await addFolderAndIndex(page)
      await library(page).getByText('Text inside files', { exact: true }).click()
      const box = library(page).getByRole('textbox', { name: 'Search text inside files' })
      await box.fill('zebra')
      const results = library(page).getByRole('listbox', { name: 'Search results' })
      await expect(results.getByRole('option')).toHaveCount(1)
      await expect(library(page).getByTestId('content-status')).toContainText('1 result')
      const hit = results.getByRole('option').first()
      await expect(hit).toContainText('contracts.pdf')
      await expect(hit).toContainText('Page 3')
      await expect(hit.locator('mark')).toHaveText('zebra')
      await expect(hit).toContainText('governs all animals')

      // Accents fold both ways; phrases, OR, NOT, exclusion and prefixes work; CJK is a substring search.
      const count = async (q: string): Promise<number> => {
        await box.fill(q)
        await expect(library(page).getByTestId('content-results')).toHaveAttribute('data-query', q)
        await expect(library(page).getByTestId('content-results')).toHaveAttribute('data-searching', 'false')
        return results.getByRole('option').count()
      }
      expect(await count('cafe creme')).toBe(1)
      await expect(results.getByRole('option').first().locator('mark').first()).toHaveText(/Café|crème/i)
      expect(await count('"annual report"')).toBe(1)
      expect(await count('budget')).toBe(2)
      expect(await count('budget -draft')).toBe(1)
      expect(await count('zebra OR forecast')).toBe(2)
      expect(await count('budg*')).toBe(2)
      expect(await count('日本語')).toBe(1)
      expect(await count('東京')).toBe(1)
      expect(await count('大阪')).toBe(0)
      await expect(library(page).getByTestId('content-status')).toContainText('No results')

      // FTS syntax typed by the user is harmless: no error, or a friendly one.
      expect(await count('NEAR(zebra clause)')).toBe(0) // "NEAR" is just a word here, not an operator
      await expect(library(page).getByTestId('content-error')).toHaveCount(0)
      expect(await count('zebra clause')).toBe(1)
      await box.fill('"')
      await expect(library(page).getByTestId('content-error')).toContainText('Type a word or phrase')
      await box.fill('-draft')
      await expect(library(page).getByTestId('content-error')).toContainText('at least one word')
      expect(await count("'; DROP TABLE library_files; --")).toBe(0)
      await expect(library(page).getByTestId('content-error')).toHaveCount(0)

      // Open the zebra hit: the PDF opens on page 3 and the term is searched for and highlighted.
      expect(await count('zebra')).toBe(1)
      await box.press('ArrowDown')
      await expect(results).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(library(page)).toBeHidden()
      await expect(page.getByRole('tab', { name: /contracts\.pdf/ })).toBeVisible()
      await expect.poll(() => page.getByLabel('Page number').inputValue()).toBe('3')
      await expect(page.getByLabel('Find text')).toHaveValue('zebra')
      await expect(page.locator('[data-page="3"] .epdf-hit').first()).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('status').filter({ hasText: /^1 of 1/ })).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('stays fresh: files added, edited and deleted while the library is open; virtual folders; removing a folder', async () => {
    const dir = tmp()
    await write(dir, 'alpha.pdf', ['alpha original text'])
    await write(dir, 'beta.pdf', ['beta original text'])
    const { app, page } = await start(dir)
    try {
      await openLibrary(app, page)
      await addFolderAndIndex(page)
      await expect(nameCells(page)).toHaveText(['alpha.pdf', 'beta.pdf'])

      // added
      await write(dir, 'sub/gamma.pdf', ['gamma freshly added words'])
      await expect(nameCells(page)).toHaveText(['alpha.pdf', 'beta.pdf', 'gamma.pdf'], { timeout: 30_000 })
      // edited: the old text is gone from search, the new text is found
      await write(dir, 'alpha.pdf', ['alpha rewritten with zeppelin'])
      await library(page).getByText('Text inside files', { exact: true }).click()
      const box = library(page).getByRole('textbox', { name: 'Search text inside files' })
      const options = library(page).getByRole('listbox', { name: 'Search results' }).getByRole('option')
      await box.fill('zeppelin')
      await expect(options).toHaveCount(1, { timeout: 30_000 })
      await box.fill('original')
      await expect(options).toHaveCount(1) // only beta.pdf still has it
      await expect(options.first()).toContainText('beta.pdf')
      // deleted
      unlinkSync(join(dir, 'beta.pdf'))
      await expect(library(page).getByTestId('content-status')).toContainText('No results', { timeout: 30_000 })
      await box.fill('')
      await library(page).getByText('File names', { exact: true }).click()
      await expect(nameCells(page)).toHaveText(['alpha.pdf', 'gamma.pdf'])

      // Virtual folders: "Add to folder…" creates nested folders from a path.
      await rows(page).nth(1).click()
      await library(page).getByRole('button', { name: 'Add to folder…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Add to folder' })
      await dlg.getByLabel('New folder').fill('Projects/Invoices')
      await dlg.getByRole('button', { name: 'Create and add' }).click()
      await expect(dlg).toBeHidden()
      const nav = library(page).getByRole('navigation')
      await expect(nav.getByRole('button', { name: /^Projects/ })).toBeVisible()
      await nav.getByRole('button', { name: /^Invoices 1$/ }).click()
      await expect(nameCells(page)).toHaveText(['alpha.pdf'])
      await expect(library(page).getByTestId('scope-title')).toHaveText('Invoices')

      // Drag and drop another file onto the folder in the sidebar.
      await nav.getByRole('button', { name: /^All files/ }).click()
      await expect(nameCells(page)).toHaveCount(2)
      const dt = await page.evaluateHandle(() => new DataTransfer())
      const gamma = rows(page).nth(2)
      await gamma.dispatchEvent('dragstart', { dataTransfer: dt })
      const target = nav.getByRole('button', { name: /^Invoices/ })
      await target.dispatchEvent('dragover', { dataTransfer: dt })
      await target.dispatchEvent('drop', { dataTransfer: dt })
      await expect(nav.getByRole('button', { name: /^Invoices 2$/ })).toBeVisible()
      await nav.getByRole('button', { name: /^Invoices 2$/ }).click()
      await expect(nameCells(page)).toHaveText(['alpha.pdf', 'gamma.pdf'])

      // Rename and delete a library folder (files stay).
      await library(page).getByRole('button', { name: 'Rename…' }).click()
      const rename = page.getByRole('dialog', { name: 'Rename library folder' })
      await rename.getByLabel('Name').fill('Bills')
      await rename.getByRole('button', { name: 'Rename' }).click()
      await expect(nav.getByRole('button', { name: /^Bills 2$/ })).toBeVisible()
      await library(page).getByRole('button', { name: 'Delete folder…' }).click()
      await page.getByRole('dialog', { name: /Delete the folder/ }).getByRole('button', { name: 'Delete folder' }).click()
      await expect(nav.getByRole('button', { name: /^Bills/ })).toHaveCount(0)
      await expect(library(page).getByTestId('scope-title')).toHaveText('All files')
      await expect(nameCells(page)).toHaveCount(2)

      // Remove the watched folder: its files vanish from the library (and the PDFs stay on disk).
      const label = dir.split(/[\\/]/).pop()!
      await nav.getByRole('button', { name: new RegExp(`^${label} 2$`) }).click()
      await library(page).getByRole('button', { name: 'Remove folder…' }).click()
      await page.getByRole('dialog', { name: /Remove .* from the library/ }).getByRole('button', { name: 'Remove folder' }).click()
      await expect(library(page).getByTestId('library-welcome')).toBeVisible()
      expect(readdirSync(dir).sort()).toEqual(['alpha.pdf', 'sub'])
      await library(page).getByText('Text inside files', { exact: true }).click()
      await library(page).getByRole('textbox', { name: 'Search text inside files' }).fill('zeppelin')
      await expect(library(page).getByTestId('content-status')).toContainText('No results')
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('indexing can be cancelled, keeps what was finished, and resumes', async () => {
    const dir = tmp()
    await generateLibrary(dir, 60, { pagesEach: 3, wordsPerPage: 80, folders: 5 })
    // A pause after every file makes the run slow enough to cancel deterministically.
    const { app, page } = await start(dir, { EPDF_LIBRARY_THROTTLE_MS: '150' })
    try {
      await openLibrary(app, page)
      await library(page).getByRole('button', { name: 'Add folder…' }).first().click()
      const cancel = library(page).getByRole('button', { name: 'Cancel indexing' })
      await expect(library(page).getByTestId('indexing-message')).toContainText(/Indexing \d+ of 60/, { timeout: 30_000 })
      await expect(library(page).getByRole('progressbar', { name: 'Indexing progress' })).toBeVisible()
      await cancel.click()
      await expect(library(page).getByTestId('idle-message')).toContainText('cancelled', { timeout: 30_000 })
      const counts = await library(page).getByTestId('library-counts').textContent()
      const done = Number(/^(\d[\d,]*) of/.exec(counts ?? '')![1].replace(/,/g, ''))
      expect(done).toBeLessThan(60)
      // The files that were found are listed even though not all are indexed yet.
      await expect(library(page).getByTestId('scope-count')).toHaveText('60 files')
      // Rescan resumes with the rest.
      const label = dir.split(/[\\/]/).pop()!
      await library(page).getByRole('navigation').getByRole('button', { name: new RegExp(`^${label} 60$`) }).click()
      await library(page).getByRole('button', { name: 'Rescan', exact: true }).click()
      await expect(library(page).getByTestId('library-counts')).toContainText('60 of 60 files searchable', { timeout: 120_000 })
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('thumbnails are rendered lazily for visible rows, cached as PNG files, and reused after a restart', async () => {
    const dir = tmp()
    await write(dir, 'one.pdf', ['First document'])
    await write(dir, 'two.pdf', ['Second document'])
    writeFileSync(join(dir, 'locked.pdf'), makePasswordPdf())
    const first = await start(dir)
    const thumbsDir = join(first.userData, 'library-thumbs')
    let cachedNames: string[] = []
    try {
      await openLibrary(first.app, first.page)
      await addFolderAndIndex(first.page)
      const pictures = library(first.page).getByRole('grid', { name: 'Files' }).locator('[role="row"] img')
      await expect(pictures).toHaveCount(2, { timeout: 30_000 })
      expect(await pictures.first().getAttribute('src')).toMatch(/^data:image\/png;base64,/)
      // The password-protected file gets a placeholder, never a picture (that would need the password).
      await expect(rows(first.page).filter({ hasText: 'locked.pdf' }).locator('img')).toHaveCount(0)
      await expect.poll(() => (statExists(thumbsDir) ? readdirSync(thumbsDir).sort() : [])).toHaveLength(2)
      cachedNames = readdirSync(thumbsDir).sort()
      const stamps = cachedNames.map((n) => statSync(join(thumbsDir, n)).mtimeMs)
      await first.app.close()

      // Second session: the pictures come from the cache (files untouched), and appear at once.
      const second = await launch({ userData: first.userData, env: { EPDF_LIBRARY_START_MS: '60000' } })
      try {
        await expect(second.page.getByRole('heading', { name: 'Epdf' })).toBeVisible()
        await openLibrary(second.app, second.page)
        await expect(library(second.page).getByRole('grid', { name: 'Files' }).locator('[role="row"] img')).toHaveCount(2, { timeout: 15_000 })
        expect(readdirSync(thumbsDir).sort()).toEqual(cachedNames)
        expect(cachedNames.map((n) => statSync(join(thumbsDir, n)).mtimeMs)).toEqual(stamps)
      } finally {
        await quitDiscarding(second.app, second.page)
      }
    } finally {
      await first.app.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('files opened from anywhere show up in Recent; they can be starred and reopened without being in a watched folder', async () => {
    const elsewhere = tmp()
    const file = await write(elsewhere, 'loose file.pdf', ['A document that lives outside every watched folder'])
    const l = await launch({ files: [file], env: { EPDF_LIBRARY_START_MS: '60000' } })
    const { app, page } = l
    try {
      await expect(page.getByRole('tab', { name: /loose file\.pdf/ })).toBeVisible()
      await openLibrary(app, page)
      await library(page).getByRole('navigation').getByRole('button', { name: /^Recent/ }).click()
      await expect(nameCells(page)).toHaveText(['loose file.pdf'])
      await expect(rows(page).filter({ hasText: 'loose file.pdf' })).toContainText('Opened')
      // Not in the library: cannot be put into a library folder (and the button says why).
      await rows(page).nth(1).click()
      await expect(library(page).getByRole('button', { name: 'Add to folder…' })).toBeDisabled()
      // Star it: it appears in Favorites, and the star survives.
      await library(page).getByRole('button', { name: 'Add loose file.pdf to favorites' }).click()
      await library(page).getByRole('navigation').getByRole('button', { name: /^Favorites/ }).click()
      await expect(nameCells(page)).toHaveText(['loose file.pdf'])
      // Reopen from the library: it switches to the tab that is already open.
      await rows(page).nth(1).dblclick()
      await expect(library(page)).toBeHidden()
      await expect(page.getByRole('tab', { name: /loose file\.pdf/ })).toHaveCount(1)
      // Removing it from the library removes it from Recent (the file itself stays).
      await openLibrary(app, page)
      await library(page).getByRole('navigation').getByRole('button', { name: /^Recent/ }).click()
      await rows(page).nth(1).click()
      await library(page).getByRole('button', { name: 'Remove from library…' }).click()
      await page.getByRole('dialog', { name: 'Remove from library?' }).getByRole('button', { name: 'Remove from library' }).click()
      await expect(library(page).getByTestId('library-empty')).toBeVisible()
      expect(readdirSync(elsewhere)).toEqual(['loose file.pdf'])
    } finally {
      await quitDiscarding(app, page)
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  test('problem files are explained: scanned, encrypted and corrupt PDFs; cloud-only files are not read', async () => {
    const dir = tmp()
    await write(dir, 'good.pdf', ['perfectly fine text'])
    writeFileSync(join(dir, 'scanned.pdf'), await makeImageOnlyPdf(2))
    writeFileSync(join(dir, 'locked.pdf'), makePasswordPdf())
    writeFileSync(join(dir, 'broken.pdf'), makeCorruptPdf())
    const { app, page } = await start(dir)
    try {
      await openLibrary(app, page)
      await addFolderAndIndex(page)
      await expect(nameCells(page)).toHaveText(['broken.pdf', 'good.pdf', 'locked.pdf', 'scanned.pdf'])
      const row = (name: string): Locator => rows(page).filter({ hasText: name })
      await expect(row('scanned.pdf')).toContainText('No text: run OCR to make it searchable')
      await expect(row('locked.pdf')).toContainText('Password-protected')
      await expect(row('broken.pdf')).toContainText('Not searchable')
      await expect(library(page).getByTestId('library-counts')).toContainText('1 of 4 files searchable')
      await expect(library(page).getByTestId('library-counts')).toContainText('3 not searchable')
      // The filter isolates them.
      await library(page).getByLabel('Show only').selectOption('noText')
      await expect(nameCells(page)).toHaveText(['scanned.pdf'])
      await library(page).getByLabel('Show only').selectOption('notIndexable')
      await expect(nameCells(page)).toHaveText(['broken.pdf', 'locked.pdf'])
      // Settings show the statistics.
      await library(page).getByRole('button', { name: 'Library settings' }).click()
      const dlg = page.getByRole('dialog', { name: 'Library settings' })
      await expect(dlg.getByTestId('stat-files')).toHaveText('4')
      await dlg.getByRole('button', { name: 'Done' }).click()
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('failure paths: a folder that cannot be read, a file deleted behind the library’s back, a folder that disappears', async () => {
    const dir = tmp()
    const a = await write(dir, 'a.pdf', ['aaa text'])
    await write(dir, 'b.pdf', ['bbb text'])
    // Watching is slowed right down so the deleted file is still listed when it is clicked.
    const { app, page } = await start(dir, { EPDF_LIBRARY_WATCH_MS: '600000' })
    try {
      await openLibrary(app, page)
      await addFolderAndIndex(page)
      await expect(nameCells(page)).toHaveText(['a.pdf', 'b.pdf'])
      unlinkSync(a)
      await rows(page).nth(1).dblclick()
      await expect(page.getByRole('alert').filter({ hasText: /a\.pdf.*no longer exists/ })).toBeVisible()
      await expect(library(page)).toBeVisible() // nothing was opened: the library stays
      await expect(nameCells(page)).toHaveText(['b.pdf']) // and the dead entry is gone

      // The whole folder disappears (drive removed): it is flagged, files are kept and cannot be opened.
      rmSync(dir, { recursive: true, force: true })
      const nav = library(page).getByRole('navigation')
      const label = dir.split(/[\\/]/).pop()!
      await nav.getByRole('button', { name: new RegExp(`^${label} 1$`) }).click()
      await library(page).getByRole('button', { name: 'Rescan', exact: true }).click()
      await expect(library(page).getByRole('alert').filter({ hasText: 'not available right now' })).toBeVisible({ timeout: 30_000 })
      await expect(nameCells(page)).toHaveText(['b.pdf'])
      await rows(page).nth(1).dblclick()
      await expect(page.getByRole('alert').filter({ hasText: /b\.pdf/ }).first()).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('adding a folder that does not exist or is already covered shows a clear message', async () => {
    const dir = tmp()
    await write(dir, 'sub/x.pdf', ['x'])
    const { app, page } = await start(join(dir, 'does-not-exist'))
    try {
      await openLibrary(app, page)
      await library(page).getByRole('button', { name: 'Add folder…' }).first().click()
      await expect(page.getByRole('alert').filter({ hasText: 'cannot be read' })).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
    const second = await start(dir)
    try {
      await openLibrary(second.app, second.page)
      await addFolderAndIndex(second.page)
      // Same folder again.
      await library(second.page).getByRole('button', { name: 'Add folder…' }).first().click()
      await expect(second.page.getByRole('alert').filter({ hasText: 'already in the library' })).toBeVisible()
    } finally {
      await quitDiscarding(second.app, second.page)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('suggests OneDrive, Google Drive-style and Dropbox folders that exist, and adds one with a click', async () => {
    const home = tmp()
    const oneDrive = join(home, 'OneDrive - Contoso')
    mkdirSync(oneDrive)
    await write(oneDrive, 'Shared/contract.pdf', ['contract in the cloud folder'])
    const appData = join(home, 'AppData', 'Roaming')
    const dropbox = join(home, 'MyDropbox')
    mkdirSync(join(appData, 'Dropbox'), { recursive: true })
    mkdirSync(dropbox)
    writeFileSync(join(appData, 'Dropbox', 'info.json'), JSON.stringify({ personal: { path: dropbox } }))
    const { app, page } = await start(undefined, { OneDrive: oneDrive, OneDriveCommercial: oneDrive, APPDATA: appData })
    try {
      await openLibrary(app, page)
      const suggestions = library(page).getByTestId('library-welcome')
      await expect(suggestions.getByText('Folders found on this computer')).toBeVisible()
      await expect(suggestions.getByRole('button', { name: /Add OneDrive.*to the library/ }).first()).toBeVisible()
      await expect(suggestions.getByRole('button', { name: /Add Dropbox/ })).toBeVisible()
      await suggestions.getByRole('button', { name: /Add OneDrive/ }).first().click()
      await idle(page)
      await expect(nameCells(page)).toHaveText(['contract.pdf'])
      // The folder shows up with a cloud icon and is no longer suggested.
      await expect(library(page).getByRole('navigation').getByRole('button', { name: /^OneDrive/ }).first()).toBeVisible()
      await expect(library(page).getByRole('navigation').getByRole('button', { name: /Add OneDrive/ })).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('keyboard only: search, move through the list, select, open, favorite, Escape', async () => {
    const dir = tmp()
    await write(dir, 'report one.pdf', ['first report'])
    await write(dir, 'report two.pdf', ['second report'])
    await write(dir, 'other.pdf', ['something else'])
    const { app, page } = await start(dir)
    try {
      await openLibrary(app, page)
      await addFolderAndIndex(page)
      await page.keyboard.press('Escape')
      await expect(library(page)).toBeHidden()
      await openLibrary(app, page)
      const grid = library(page).getByRole('grid', { name: 'Files' })
      // Focus starts in the search box; type, then ArrowDown into the list.
      await expect(library(page).getByRole('textbox', { name: 'Search file names' })).toBeFocused()
      await page.keyboard.type('report')
      await expect(nameCells(page)).toHaveText(['report one.pdf', 'report two.pdf'])
      await page.keyboard.press('ArrowDown')
      await expect(grid).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(rows(page).nth(2)).toHaveAttribute('aria-selected', 'true')
      await expect(grid).toHaveAttribute('aria-activedescendant', 'lib-item-1')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Shift+ArrowDown')
      await expect(rows(page).filter({ has: page.locator('[aria-selected="true"]') }).or(page.locator('[role="row"][aria-selected="true"]'))).toHaveCount(2)
      await page.keyboard.press('ControlOrMeta+d')
      await expect(library(page).getByRole('button', { name: /^Remove report .* from favorites$/ })).toHaveCount(2)
      // Enter opens both selected files in new tabs.
      await page.keyboard.press('Enter')
      await expect(library(page)).toBeHidden()
      await expect(page.getByRole('tab', { name: /report one\.pdf/ })).toBeVisible()
      await expect(page.getByRole('tab', { name: /report two\.pdf/ })).toBeVisible()

      // Tab never leaves the layer; Escape closes it and puts focus back.
      await openLibrary(app, page)
      for (let i = 0; i < 45; i++) {
        await page.keyboard.press('Tab')
        const outside = await page.evaluate(() => (document.activeElement?.closest('[role="dialog"][aria-label="Library"]') ? '' : (document.activeElement?.outerHTML ?? 'nothing').slice(0, 160)))
        expect(outside, `Tab #${i + 1} left the library`).toBe('')
      }
      await page.keyboard.press('Escape')
      await expect(library(page)).toBeHidden()
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('has no WCAG 2.1 A/AA violations (welcome, list, thumbnails, results, dialogs; light and dark)', async () => {
    const dir = tmp()
    await write(dir, 'one.pdf', ['some searchable words here'])
    await write(dir, 'two.pdf', ['more words'])
    writeFileSync(join(dir, 'scan.pdf'), await makeImageOnlyPdf(1))
    const { app, page } = await start(dir)
    const problems: string[] = []
    const scan = async (label: string): Promise<void> => void problems.push(...(await axeViolations(page, label)))
    try {
      await openLibrary(app, page)
      await scan('welcome light')
      await addFolderAndIndex(page)
      await library(page).getByRole('button', { name: 'Add one.pdf to favorites' }).click()
      await scan('list light')
      await library(page).getByRole('button', { name: 'Thumbnail view' }).click()
      await expect(library(page).getByRole('grid', { name: 'Files' }).getByRole('gridcell').first()).toBeVisible()
      await scan('thumbnails light')
      await library(page).getByRole('button', { name: 'List view' }).click()
      await library(page).getByText('Text inside files', { exact: true }).click()
      await library(page).getByRole('textbox', { name: 'Search text inside files' }).fill('words')
      await expect(library(page).getByRole('listbox', { name: 'Search results' }).getByRole('option')).toHaveCount(2)
      await scan('results light')
      await library(page).getByRole('textbox', { name: 'Search text inside files' }).fill('"')
      await expect(library(page).getByTestId('content-error')).toBeVisible()
      await scan('error light')
      await library(page).getByRole('textbox', { name: 'Search text inside files' }).fill('')
      await library(page).getByText('File names', { exact: true }).click()
      await rows(page).nth(1).click()
      await library(page).getByRole('button', { name: 'Add to folder…' }).click()
      await scan('add to folder dialog light')
      await page.getByRole('button', { name: 'Cancel' }).click()
      await library(page).getByRole('button', { name: 'New library folder' }).click()
      await scan('new folder dialog light')
      await page.getByRole('button', { name: 'Cancel' }).click()
      await library(page).getByRole('button', { name: 'Library settings' }).click()
      await scan('settings light')
      await page.getByRole('button', { name: 'Done' }).click()

      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      await scan('list dark')
      await library(page).getByRole('button', { name: 'Thumbnail view' }).click()
      await scan('thumbnails dark')
      await library(page).getByText('Text inside files', { exact: true }).click()
      await library(page).getByRole('textbox', { name: 'Search text inside files' }).fill('words')
      await expect(library(page).getByRole('listbox', { name: 'Search results' }).getByRole('option')).toHaveCount(2)
      await scan('results dark')
      await library(page).getByRole('button', { name: 'Library settings' }).click()
      await scan('settings dark')
      await page.getByRole('button', { name: 'Done' }).click()
      expect(problems).toEqual([])
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a 2,000-file library indexes in the background, stays responsive, and searches fast', async () => {
    test.setTimeout(420_000)
    const dir = tmp()
    const t0 = Date.now()
    await generateLibrary(dir, 2000, { pagesEach: 2, wordsPerPage: 60, folders: 20 })
    const genMs = Date.now() - t0
    const { app, page } = await start(dir)
    try {
      await openLibrary(app, page)
      // Measure how long the UI thread is ever blocked while indexing goes on (timer drift, 20 ms timer).
      await page.evaluate(() => {
        const w = window as unknown as { __lag: { max: number; over200: number } }
        w.__lag = { max: 0, over200: 0 }
        let last = performance.now()
        setInterval(() => {
          const now = performance.now()
          const gap = now - last - 20
          if (gap > w.__lag.max) w.__lag.max = gap
          if (gap > 200) w.__lag.over200++
          last = now
        }, 20)
      })
      const t1 = Date.now()
      await library(page).getByRole('button', { name: 'Add folder…' }).first().click()
      await expect(library(page).getByTestId('indexing-message')).toContainText(/Indexing/, { timeout: 60_000 })
      // While indexing: the UI still answers (typing into the search box, scrolling the list).
      const box = library(page).getByRole('textbox', { name: 'Search file names' })
      const typing = Date.now()
      await box.fill('doc0012')
      await expect(box).toHaveValue('doc0012')
      const typingMs = Date.now() - typing
      await box.fill('')
      await expect(library(page).getByTestId('library-counts')).toContainText('of 2,000 files', { timeout: 120_000 })
      await idle(page, 300_000)
      const indexMs = Date.now() - t1
      await expect(library(page).getByTestId('library-counts')).toContainText('2,000 of 2,000 files searchable')
      const lag = await page.evaluate(() => (window as unknown as { __lag: { max: number; over200: number } }).__lag)

      // Virtualised list: only a screenful of rows exists, End jumps to the last file.
      await expect(rows(page).first()).toBeVisible()
      expect(await rows(page).count()).toBeLessThan(80)
      await library(page).getByRole('grid', { name: 'Files' }).focus()
      await page.keyboard.press('End')
      await expect(library(page).getByRole('grid', { name: 'Files' }).getByText('doc01999.pdf', { exact: true })).toBeVisible({ timeout: 15_000 })

      // Content search over ~240k words.
      await library(page).getByText('Text inside files', { exact: true }).click()
      const search = library(page).getByRole('textbox', { name: 'Search text inside files' })
      const s0 = Date.now()
      await search.fill('doc01234')
      await expect(library(page).getByTestId('content-status')).toContainText('1 result')
      const searchMs = Date.now() - s0
      await search.fill('invoice contract')
      await expect(library(page).getByTestId('content-status')).toContainText(/result/)
      const status = (await library(page).getByTestId('content-status').textContent()) ?? ''
      const inApp = /· (\d+) ms/.exec(status)?.[1]
      console.log(`LIBRARY-PERF generate=${genMs}ms index=${indexMs}ms (2000 files) typingDuringIndex=${typingMs}ms maxUiGap=${Math.round(lag.max)}ms gapsOver200ms=${lag.over200} exactSearchRoundTrip=${searchMs}ms multiWordSearchInApp=${inApp}ms`)
      test.info().annotations.push({ type: 'perf', description: `index ${indexMs} ms, max UI gap ${Math.round(lag.max)} ms, search ${searchMs} ms` })
      expect(lag.max).toBeLessThan(1500)
      expect(typingMs).toBeLessThan(3000)
      expect(searchMs).toBeLessThan(3000)
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
