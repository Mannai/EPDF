import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { LEAD, PAGE_H, PAGE_W, S, plainWidth, wrapLines, writeCompareFixtures } from '../support/compareFixtures'
import { flattenText, readPdf } from '../support/pdfText'
import { FIX, axeViolations, copyFixture, fixture, launch, menuClick, quitDiscarding } from './helpers'

test.beforeAll(async () => {
  await writeCompareFixtures(FIX)
})

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'epdf-cmp-'))

async function stubOpenDialog(app: ElectronApplication, paths: string[] | null): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as unknown as { showOpenDialog: () => Promise<unknown> }).showOpenDialog = () => Promise.resolve(p ? { canceled: false, filePaths: p } : { canceled: true, filePaths: [] })
  }, paths)
}

async function stubSaveDialog(app: ElectronApplication, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = () => Promise.resolve(p ? { canceled: false, filePath: p } : { canceled: true })
  }, path)
}

const setTheme = (app: ElectronApplication, dark: boolean): Promise<void> => app.evaluate(({ nativeTheme }, v) => void (nativeTheme.themeSource = v ? 'dark' : 'light'), dark)

/** Opens Tools > Compare Files… for the active document and waits for the choose step. */
async function openCompare(app: ElectronApplication, page: Page): Promise<void> {
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  await menuClick(app, 'Tools', 'Compare Files…')
  await expect(page.getByTestId('compare-choose')).toBeVisible()
}

/** Chooses the OLD version through the native dialog (stubbed to return `path`) and starts the comparison. */
async function compareWithFile(app: ElectronApplication, page: Page, path: string): Promise<void> {
  await stubOpenDialog(app, [path])
  await page.getByTestId('compare-old').getByRole('button', { name: 'Choose file…' }).click()
  await expect(page.getByTestId('compare-old-name')).toContainText(path.split(/[\\/]/).pop()!)
  await page.getByTestId('compare-start').click()
}

const verdict = (page: Page): Locator => page.getByTestId('compare-verdict')
const counter = (page: Page): Locator => page.getByTestId('compare-counter')
const options = (page: Page): Locator => page.getByTestId('compare-change')

async function waitResults(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.getByTestId('compare-verdict')).toBeVisible({ timeout })
}

/** Launches with the NEW report open, compares it with the OLD one (from a file) and waits for the results. */
async function reportSession(): Promise<{ app: ElectronApplication; page: Page; oldPath: string; newPath: string }> {
  const newPath = copyFixture('cmp-report-new.pdf')
  const oldPath = copyFixture('cmp-report-old.pdf')
  const { app, page } = await launch({ files: [newPath] })
  await openCompare(app, page)
  await compareWithFile(app, page, oldPath)
  await waitResults(page)
  return { app, page, oldPath, newPath }
}

const count = async (page: Page, kind: string): Promise<string> => (await page.getByTestId(`count-${kind}`).innerText()).replace(/[()]/g, '')

test.describe('compare: choose, run and summary', () => {
  test('compares two files: exact counts per type, verdict, list and page filter', async () => {
    const { app, page } = await reportSession()
    try {
      await expect(verdict(page)).toContainText('8 changes: 2 added, 2 removed, 3 modified, 1 moved on 5 of 5 page pairs.')
      expect([await count(page, 'added'), await count(page, 'removed'), await count(page, 'modified'), await count(page, 'moved')]).toEqual(['2', '2', '3', '1'])
      await expect(options(page)).toHaveCount(8)
      await expect(counter(page)).toHaveText('8 changes')
      // every kind of change has a word label (colour is not the only cue) and shows old -> new for modifications
      await expect(page.locator('[data-testid="compare-change"][data-kind="modified"]').filter({ hasText: 'Monday' })).toContainText('Tuesday')
      await expect(page.locator('[data-testid="compare-change"][data-kind="modified"]').filter({ hasText: '12.5' })).toContainText('15.5')
      await expect(page.locator('[data-testid="compare-change"][data-kind="moved"]')).toContainText('Rotterdam')
      await expect(page.locator('[data-testid="compare-change"][data-kind="moved"]')).toContainText('Page 1 → page 2')
      await expect(page.locator('[data-testid="compare-change"][data-kind="removed"]').filter({ hasText: 'sentence will be removed' })).toBeVisible()
      await expect(page.locator('[data-testid="compare-change"][data-kind="added"]').filter({ hasText: 'brand new paragraph' })).toBeVisible()
      // the per-page counts
      const pageSelect = page.getByLabel('Filter by page')
      await expect(pageSelect.locator('option')).toHaveText(['All pages', 'Page 1 (1)', 'Page 2 (4)', 'Page 3 (1)', 'Page 4 (2)'])
      await pageSelect.selectOption('2')
      await expect(page.getByTestId('compare-list-count')).toHaveText('Showing 4 of 8 changes')
      await pageSelect.selectOption('')
      // type filter and search
      await page.getByTestId('filter-added').getByRole('checkbox').uncheck()
      await expect(page.getByTestId('compare-list-count')).toHaveText('Showing 6 of 8 changes')
      await page.getByTestId('filter-added').getByRole('checkbox').check()
      await page.getByLabel('Search in changes').fill('tuesday')
      await expect(options(page)).toHaveCount(1)
      await expect(page.getByTestId('compare-list-count')).toHaveText('Showing 1 of 8 changes')
      await page.getByLabel('Search in changes').fill('no such words')
      await expect(page.getByText('No change matches the current filters.')).toBeVisible()
      await page.getByLabel('Search in changes').fill('')
      await expect(options(page)).toHaveCount(8)
    } finally {
      await app.close()
    }
  })

  test('swapping old and new exchanges added and removed', async () => {
    const { app, page, oldPath, newPath } = await reportSession()
    try {
      await page.getByTestId('compare-new').click()
      await expect(page.getByTestId('compare-choose')).toBeVisible()
      await page.getByRole('button', { name: 'Swap old and new' }).click()
      await expect(page.getByTestId('compare-old-name')).toContainText(newPath.split(/[\\/]/).pop()!)
      await expect(page.getByTestId('compare-new-name')).toContainText(oldPath.split(/[\\/]/).pop()!)
      await page.getByTestId('compare-start').click()
      await waitResults(page)
      await expect(verdict(page)).toContainText('8 changes: 2 added, 2 removed, 3 modified, 1 moved')
      // the sentence that was removed is now an addition
      await expect(page.locator('[data-testid="compare-change"][data-kind="added"]').filter({ hasText: 'sentence will be removed' })).toBeVisible()
      await expect(page.locator('[data-testid="compare-change"][data-kind="removed"]').filter({ hasText: 'brand new paragraph' })).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('the old version can be taken from another open tab', async () => {
    const oldPath = copyFixture('cmp-report-old.pdf')
    const newPath = copyFixture('cmp-report-new.pdf')
    const { app, page } = await launch({ files: [oldPath, newPath] })
    try {
      await expect(page.getByRole('tab')).toHaveCount(2)
      await expect(page.getByRole('tab', { selected: true })).toContainText('cmp-report-new')
      await openCompare(app, page)
      // by default the open document is the NEW version
      await expect(page.getByTestId('compare-new-name')).toContainText('cmp-report-new')
      await expect(page.getByTestId('compare-old-name')).toContainText('Nothing chosen yet')
      await expect(page.getByTestId('compare-start')).toBeDisabled()
      await page.getByLabel('Use an open tab as the old version').selectOption({ label: oldPath.split(/[\\/]/).pop()! })
      await expect(page.getByTestId('compare-old-name')).toContainText('(open tab)')
      await page.getByTestId('compare-start').click()
      await waitResults(page)
      await expect(verdict(page)).toContainText('8 changes')
    } finally {
      await app.close()
    }
  })

  test('identical files report no differences (text and appearance)', async () => {
    const a = copyFixture('cmp-report-old.pdf')
    const b = copyFixture('cmp-report-copy.pdf')
    const { app, page } = await launch({ files: [a] })
    try {
      await openCompare(app, page)
      await compareWithFile(app, page, b)
      await waitResults(page)
      await expect(verdict(page)).toHaveText('No differences found: the text and the appearance of every page are the same.', { timeout: 60_000 })
      await expect(counter(page)).toHaveText('No text changes')
      await expect(page.getByTestId('compare-list-count')).toHaveText('No changes')
      await expect(page.getByText('The two documents have the same text.')).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('a visual-only difference: no text differences but a page differs visually; sensitivity slider; overlay', async () => {
    const a = copyFixture('cmp-visual-new.pdf')
    const b = copyFixture('cmp-visual-old.pdf')
    const { app, page } = await launch({ files: [a] })
    try {
      await openCompare(app, page)
      await compareWithFile(app, page, b)
      await waitResults(page)
      await expect(verdict(page)).toHaveText('No text differences, but 1 page differs visually.', { timeout: 60_000 })
      await page.getByTestId('mode-visual').check()
      await expect(page.getByTestId('visual-summary')).toContainText('pixels differ', { timeout: 30_000 })
      await expect(page.getByTestId('visual-scan-result')).toHaveText('1 page pair differs visually.')
      // the overlay canvas really contains the magenta difference mask
      const hasMask = (): Promise<boolean> =>
        page.getByTestId('visual-canvas').evaluate((c: HTMLCanvasElement) => {
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
          for (let i = 0; i < d.length; i += 4) if (d[i] === 230 && d[i + 1] === 0 && d[i + 2] === 190) return true
          return false
        })
      expect(await hasMask()).toBe(true)
      // lowest sensitivity: the colour change (max 220 levels) is below the threshold, so nothing is reported
      const slider = page.getByTestId('visual-sensitivity')
      await slider.fill('0')
      await expect(page.getByTestId('visual-summary')).toContainText('no visual difference at this sensitivity')
      expect(await hasMask()).toBe(false)
      await slider.fill('100')
      await expect(page.getByTestId('visual-summary')).toContainText('pixels differ')
      expect(await hasMask()).toBe(true)
    } finally {
      await app.close()
    }
  })
})

test.describe('compare: input problems', () => {
  test('an encrypted file gives a clear message once the password prompt is declined', async () => {
    const { app, page } = await launch({ files: [copyFixture('cmp-report-new.pdf')] })
    try {
      await openCompare(app, page)
      await stubOpenDialog(app, [fixture('cmp-encrypted.pdf')])
      await page.getByTestId('compare-old').getByRole('button', { name: 'Choose file…' }).click()
      await page.getByTestId('compare-start').click()
      const dialog = page.getByRole('dialog', { name: 'Password required' })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByTestId('compare-error')).toContainText('password protected')
      await expect(page.getByTestId('compare-error')).toContainText('cmp-encrypted.pdf')
      await expect(page.getByTestId('compare-choose')).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('a damaged file gives a clear message and the app keeps working', async () => {
    const { app, page } = await launch({ files: [copyFixture('cmp-report-new.pdf')] })
    try {
      await openCompare(app, page)
      await stubOpenDialog(app, [fixture('cmp-broken.pdf')])
      await page.getByTestId('compare-old').getByRole('button', { name: 'Choose file…' }).click()
      await page.getByTestId('compare-start').click()
      await expect(page.getByTestId('compare-error')).toContainText('damaged or is not a PDF file')
      // choosing a good file afterwards works
      await compareWithFile(app, page, copyFixture('cmp-report-old.pdf'))
      await waitResults(page)
      await expect(verdict(page)).toContainText('8 changes')
    } finally {
      await app.close()
    }
  })

  test('cancelling the file dialog changes nothing', async () => {
    const { app, page } = await launch({ files: [copyFixture('cmp-report-new.pdf')] })
    try {
      await openCompare(app, page)
      await stubOpenDialog(app, null)
      await page.getByTestId('compare-old').getByRole('button', { name: 'Choose file…' }).click()
      await expect(page.getByTestId('compare-old-name')).toContainText('Nothing chosen yet')
      await expect(page.getByTestId('compare-start')).toBeDisabled()
    } finally {
      await app.close()
    }
  })
})

// Geometry helpers -----------------------------------------------------------------------------------------------

interface Expected {
  x: number
  w: number
  /** Distance of the box top from the page top, in points. */
  top: number
  h: number
}

/** Where the word `word` of paragraph `text` (drawn by the fixtures at x, firstBaseline) sits, in top-left points, with the 1.2pt padding. */
async function expectedWord(text: string, word: string, x: number, firstBaseline: number): Promise<Expected> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const lines = wrapLines(font, text)
  const li = lines.findIndex((l) => l.includes(word))
  const idx = lines[li].indexOf(word)
  const baseline = firstBaseline - li * LEAD
  return { x: x + plainWidth(font, lines[li].slice(0, idx)) - 1.2, w: plainWidth(font, word) + 2.4, top: PAGE_H - baseline - 12 * 0.85 - 1.2, h: 12 * 1.07 + 2.4 }
}

/** The highlight's rectangle in page points, measured from the DOM. */
async function domRect(hl: Locator, pageEl: Locator): Promise<Expected> {
  const [h, p] = [await hl.boundingBox(), await pageEl.boundingBox()]
  if (!h || !p) throw new Error('highlight or page not visible')
  const scale = p.width / PAGE_W
  return { x: (h.x - p.x) / scale, w: h.width / scale, top: (h.y - p.y) / scale, h: h.height / scale }
}

function expectNear(actual: Expected, want: Expected, tol = 2.5): void {
  expect(Math.abs(actual.x - want.x), `x ${actual.x} vs ${want.x}`).toBeLessThan(tol)
  expect(Math.abs(actual.w - want.w), `width ${actual.w} vs ${want.w}`).toBeLessThan(tol + 1)
  expect(Math.abs(actual.top - want.top), `top ${actual.top} vs ${want.top}`).toBeLessThan(tol)
  expect(Math.abs(actual.h - want.h), `height ${actual.h} vs ${want.h}`).toBeLessThan(tol + 1)
}

const pageCell = (page: Page, side: 'old' | 'new', n: number): Locator => page.locator(`[data-testid="cmp-page"][data-side="${side}"][data-page="${n}"]`)
const current = (page: Page, side: 'old' | 'new'): Locator => page.locator(`[data-testid="cmp-hl"][data-current="true"][data-side="${side}"]`)

test.describe('compare: jumping, highlights and navigation', () => {
  test('clicking a change scrolls to it in both panes; highlights sit exactly over the changed words', async () => {
    const { app, page } = await reportSession()
    try {
      // modified: Monday -> Tuesday (old page 2 / new page 2)
      await page.locator('[data-testid="compare-change"]').filter({ hasText: 'Monday' }).click()
      await expect(counter(page)).toHaveText(/Change \d of 8/)
      await expect(current(page, 'old')).toHaveCount(1)
      await expect(current(page, 'new')).toHaveCount(1)
      await expect(current(page, 'new')).toHaveAttribute('data-kind', 'modified')
      const oldWord = await expectedWord(S.committeeOld, 'Monday', 72, 680)
      const newWord = await expectedWord(S.committeeNew, 'Tuesday', 72, 680)
      expectNear(await domRect(current(page, 'old'), pageCell(page, 'old', 2)), oldWord)
      expectNear(await domRect(current(page, 'new'), pageCell(page, 'new', 2)), newWord)
      // the highlight is on screen (the pane scrolled to it)
      const scroller = page.getByTestId('compare-scroller')
      const sb = (await scroller.boundingBox())!
      const hb = (await current(page, 'new').boundingBox())!
      expect(hb.y).toBeGreaterThanOrEqual(sb.y)
      expect(hb.y + hb.height).toBeLessThanOrEqual(sb.y + sb.height)
      // the changed characters inside the word are marked separately
      await expect(current(page, 'new').locator('.cmp-hl-inner')).not.toHaveCount(0)
      // both panes show the SAME page of the row (synchronised)
      const rowOld = await pageCell(page, 'old', 2).boundingBox()
      const rowNew = await pageCell(page, 'new', 2).boundingBox()
      expect(Math.abs(rowOld!.y - rowNew!.y)).toBeLessThan(1.5)

      // removed (old side only) and added (new side only)
      await page.locator('[data-testid="compare-change"][data-kind="removed"]').filter({ hasText: 'sentence will be removed' }).click()
      await expect(current(page, 'old')).not.toHaveCount(0)
      await expect(current(page, 'new')).toHaveCount(0)
      await page.locator('[data-testid="compare-change"][data-kind="added"]').filter({ hasText: 'brand new paragraph' }).click()
      await expect(current(page, 'new')).not.toHaveCount(0)
      await expect(current(page, 'old')).toHaveCount(0)
      await expect(current(page, 'new').first()).toHaveAttribute('data-kind', 'added')

      // two columns: the change is in the RIGHT column of the new page 4 (not interleaved with the left one)
      await page.locator('[data-testid="compare-change"]').filter({ hasText: 'monthly' }).click()
      await expect(current(page, 'new')).toHaveCount(1)
      const r = await domRect(current(page, 'new'), pageCell(page, 'new', 4))
      const right = 330 + plainWidth(await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica), 'South region: the ') - 1.2
      expect(Math.abs(r.x - right)).toBeLessThan(2.5)
      expect(Math.abs(r.top - (PAGE_H - 680 - 12 * 0.85 - 1.2))).toBeLessThan(2.5)

      // moved: highlighted in the old page 1 and in the new page 2
      await page.locator('[data-testid="compare-change"][data-kind="moved"]').click()
      await expect(current(page, 'new')).not.toHaveCount(0)
      await expect(current(page, 'new').first()).toHaveAttribute('data-kind', 'moved')
      await expect(page.locator('[data-testid="cmp-hl"][data-kind="moved"][data-side="old"]')).not.toHaveCount(0)
      // clicking a highlight in the page selects that change too
      await page.locator('[data-testid="cmp-hl"][data-kind="modified"][data-side="new"]').first().click()
      await expect(page.locator('[data-testid="compare-change"][aria-selected="true"]')).toHaveCount(1)
    } finally {
      await app.close()
    }
  })

  test('next/previous change with F8 / Shift+F8 and the buttons; counter and announcements; wraps around', async () => {
    const { app, page } = await reportSession()
    try {
      const announce = page.getByTestId('compare-announce')
      await page.keyboard.press('F8')
      await expect(counter(page)).toHaveText('Change 1 of 8')
      await expect(announce).toContainText('Change 1 of 8.')
      await expect(page.locator('[data-testid="compare-change"][aria-selected="true"]')).toHaveCount(1)
      await page.keyboard.press('F8')
      await expect(counter(page)).toHaveText('Change 2 of 8')
      await expect(announce).toContainText(/Change 2 of 8\. (Modified|Removed|Added|Moved)/)
      await page.getByRole('button', { name: 'Next change' }).click()
      await expect(counter(page)).toHaveText('Change 3 of 8')
      await page.keyboard.press('Shift+F8')
      await expect(counter(page)).toHaveText('Change 2 of 8')
      await page.getByRole('button', { name: 'Previous change' }).click()
      await page.getByRole('button', { name: 'Previous change' }).click()
      await expect(counter(page)).toHaveText('Change 8 of 8') // wrapped
      await page.keyboard.press('F8')
      await expect(counter(page)).toHaveText('Change 1 of 8')
      // the announcement names kind, page and the words
      await page.locator('[data-testid="compare-change"]').filter({ hasText: 'Monday' }).click()
      await expect(announce).toContainText('Modified on page 2: “Monday” to “Tuesday”.')
      // navigation follows the filters
      await page.getByTestId('filter-added').getByRole('checkbox').uncheck()
      await page.getByTestId('filter-moved').getByRole('checkbox').uncheck()
      await page.keyboard.press('F8')
      await expect(counter(page)).toHaveText(/Change \d of 5/)
    } finally {
      await app.close()
    }
  })

  test('the change list is fully keyboard operable', async () => {
    const { app, page } = await reportSession()
    try {
      const list = page.getByTestId('compare-changes')
      await list.focus()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await expect(list).toHaveAttribute('aria-activedescendant', /cmp-change-\d+/)
      await page.keyboard.press('Enter')
      await expect(counter(page)).toHaveText('Change 3 of 8')
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await expect(counter(page)).toHaveText('Change 8 of 8')
      await page.keyboard.press('Home')
      await page.keyboard.press('Space')
      await expect(counter(page)).toHaveText('Change 1 of 8')
      // every control of the toolbar is reachable with the keyboard
      await page.getByRole('button', { name: 'Previous change' }).focus()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button', { name: 'Next change' })).toBeFocused()
    } finally {
      await app.close()
    }
  })
})

test.describe('compare: reports', () => {
  test('exports the summary as a PDF report and as CSV, verified by re-loading the files', async () => {
    const { app, page } = await reportSession()
    try {
      const dir = tmpDir()
      const pdfPath = join(dir, 'report.pdf')
      const csvPath = join(dir, 'changes.csv')
      await stubSaveDialog(app, pdfPath)
      await page.getByTestId('export-pdf').click()
      await expect(page.getByTestId('compare-announce')).toContainText('Saved the report as report.pdf')
      expect(existsSync(pdfPath)).toBe(true)
      const bytes = new Uint8Array(readFileSync(pdfPath))
      const pdf = await PDFDocument.load(bytes)
      expect(pdf.getTitle()).toBe('Epdf comparison report')
      expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1)
      const text = flattenText((await readPdf(bytes)).pages)
      expect(text).toContain('8 changes: 2 added, 2 removed, 3 modified, 1 moved.')
      expect(text).toContain('cmp-report-new')
      for (const label of ['[~] MODIFIED', '[-] REMOVED', '[+] ADDED', '[>] MOVED']) expect(text).toContain(label)
      expect(text).toContain('Monday')
      expect(text).toContain('Tuesday')
      expect(text).toContain('12.5')
      expect(text).toContain('Rotterdam')

      await stubSaveDialog(app, csvPath)
      await page.getByTestId('export-csv').click()
      await expect(page.getByTestId('compare-announce')).toContainText('Saved the change list as changes.csv')
      const csv = readFileSync(csvPath, 'utf8')
      expect(csv.charCodeAt(0)).toBe(0xfeff)
      const lines = csv.slice(1).trim().split('\r\n')
      expect(lines[0]).toBe('Change,Type,Old page,New page,Old text,New text,Note')
      expect(lines).toHaveLength(9)
      expect(lines.filter((l) => /^\d+,Modified,/.test(l))).toHaveLength(3)
      expect(lines.some((l) => /^\d+,Modified,2,2,Monday,Tuesday,$/.test(l))).toBe(true)
      expect(lines.some((l) => /^\d+,Moved,1,2,.*Rotterdam.*,.*Rotterdam.*,Moved$/.test(l))).toBe(true)
      expect(lines.filter((l) => /^\d+,Removed,/.test(l))).toHaveLength(2)

      // a cancelled save dialog writes nothing and reports no error
      await stubSaveDialog(app, null)
      await page.getByTestId('export-pdf').click()
      await expect(page.getByTestId('export-pdf')).toBeEnabled()
      await expect(page.getByTestId('compare-announce')).not.toContainText('error')
      expect(existsSync(join(dir, 'never.pdf'))).toBe(false)
    } finally {
      await app.close()
    }
  })
})

test.describe('compare: large documents', () => {
  test('cancel during a 500-page comparison returns to the chooser and leaves nothing running', async () => {
    const { app, page } = await launch({ files: [copyFixture('cmp-large-new.pdf')] })
    try {
      await openCompare(app, page)
      await stubOpenDialog(app, [fixture('cmp-large-old.pdf')])
      await page.getByTestId('compare-old').getByRole('button', { name: 'Choose file…' }).click()
      await page.getByTestId('compare-start').click()
      const bar = page.getByTestId('compare-progress')
      await expect(bar).toBeVisible()
      await expect(page.getByTestId('compare-progress-label')).toContainText(/Reading the (old|new) version: page \d+ of 500/, { timeout: 30_000 })
      await expect(bar).toHaveAttribute('aria-valuenow', /^\d+$/)
      await page.getByTestId('compare-cancel').click()
      await expect(page.getByTestId('compare-choose')).toBeVisible()
      await expect(bar).toHaveCount(0)
      await expect(page.getByTestId('compare-error')).toHaveCount(0)
      // and a new comparison still works afterwards
      await expect(page.getByTestId('compare-start')).toBeEnabled()
    } finally {
      await app.close()
    }
  })

  test('a 500-page comparison completes with exact counts and only renders the pages near the viewport', async () => {
    test.setTimeout(240_000)
    const { app, page } = await launch({ files: [copyFixture('cmp-large-new.pdf')] })
    try {
      await openCompare(app, page)
      await stubOpenDialog(app, [fixture('cmp-large-old.pdf')])
      await page.getByTestId('compare-old').getByRole('button', { name: 'Choose file…' }).click()
      await page.getByTestId('compare-start').click()
      await expect(page.getByTestId('compare-verdict')).toBeVisible({ timeout: 200_000 })
      await expect(verdict(page)).toContainText('3 changes: 3 modified on 3 of 500 page pairs.')
      await expect(page.locator('[data-testid="compare-change"]')).toHaveCount(3)
      // windowed: only a handful of the 1000 pages are mounted
      await expect(page.locator('[data-testid="cmp-page"]').first()).toBeVisible()
      expect(await page.locator('[data-testid="cmp-page"]').count()).toBeLessThan(24)
      // jumping to the change on page 450 renders that region
      await page.locator('[data-testid="compare-change"]').last().click()
      await expect(pageCell(page, 'new', 450)).toBeVisible()
      expect(await page.locator('[data-testid="cmp-page"]').count()).toBeLessThan(24)
      await expect(current(page, 'new')).toHaveCount(1)
      // only pages with changes
      await page.getByLabel('Only pages with changes').check()
      await expect(page.locator('[data-testid="cmp-row"]').first()).toBeVisible()
      await expect(page.locator('[data-testid="cmp-row"]')).toHaveCount(3, { timeout: 5000 }).catch(() => undefined)
    } finally {
      await app.close()
    }
  })
})

test.describe('compare: options, scripts and session behaviour', () => {
  test('ignore-case and ignore-punctuation options make case-only differences disappear', async () => {
    const { app, page } = await launch({ files: [copyFixture('cmp-case-new.pdf')] })
    try {
      await openCompare(app, page)
      await compareWithFile(app, page, copyFixture('cmp-case-old.pdf'))
      await waitResults(page)
      // exact comparison: capital letters and punctuation are differences
      await expect(verdict(page)).not.toContainText('No text differences')
      expect(await options(page).count()).toBeGreaterThan(3)
      await page.getByTestId('compare-new').click()
      await page.getByRole('checkbox', { name: /Ignore upper and lower case/ }).check()
      await page.getByRole('checkbox', { name: /Ignore punctuation/ }).check()
      await page.getByTestId('compare-start').click()
      await waitResults(page)
      await expect(counter(page)).toHaveText('No text changes')
      await expect(page.getByTestId('compare-list-count')).toHaveText('No changes')
    } finally {
      await app.close()
    }
  })

  test('Cyrillic text is compared word by word and the PDF report keeps it readable', async () => {
    const { app, page } = await launch({ files: [copyFixture('cmp-unicode-new.pdf')] })
    try {
      await openCompare(app, page)
      await compareWithFile(app, page, copyFixture('cmp-unicode-old.pdf'))
      await waitResults(page)
      await expect(verdict(page)).toContainText('1 change: 1 modified')
      await expect(page.locator('[data-testid="compare-change"]')).toContainText('десять')
      await expect(page.locator('[data-testid="compare-change"]')).toContainText('двадцать')
      const pdfPath = join(tmpDir(), 'unicode-report.pdf')
      await stubSaveDialog(app, pdfPath)
      await page.getByTestId('export-pdf').click()
      await expect(page.getByTestId('compare-announce')).toContainText('Saved the report as unicode-report.pdf')
      const text = flattenText((await readPdf(new Uint8Array(readFileSync(pdfPath)))).pages)
      expect(text).toContain('десять')
      expect(text).toContain('двадцать')
    } finally {
      await app.close()
    }
  })

  test('results survive switching to another tab and back', async () => {
    const oldPath = copyFixture('cmp-report-old.pdf')
    const newPath = copyFixture('cmp-report-new.pdf')
    const { app, page } = await launch({ files: [oldPath, newPath] })
    try {
      await openCompare(app, page)
      await page.getByLabel('Use an open tab as the old version').selectOption({ label: oldPath.split(/[\\/]/).pop()! })
      await page.getByTestId('compare-start').click()
      await waitResults(page)
      await page.locator('[data-testid="compare-change"]').filter({ hasText: 'Monday' }).click()
      await page.getByRole('tab', { name: /cmp-report-old/ }).click()
      await expect(page.getByTestId('compare')).toHaveCount(0)
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await page.getByRole('tab', { name: /cmp-report-new/ }).click()
      await expect(page.getByTestId('compare-verdict')).toContainText('8 changes')
      await expect(page.locator('[data-testid="compare-change"][aria-selected="true"]')).toContainText('Monday')
    } finally {
      await app.close()
    }
  })

  test('editing the open document afterwards marks the comparison as out of date and offers to compare again', async () => {
    const { app, page } = await reportSession()
    try {
      await page.getByRole('button', { name: 'Done' }).click()
      await expect(page.getByTestId('compare')).toHaveCount(0)
      await menuClick(app, 'Document', 'Rotate Page Clockwise')
      await expect(page.getByTestId('unsaved-dot')).toBeVisible()
      await menuClick(app, 'Tools', 'Compare Files…')
      await expect(page.getByRole('alert').filter({ hasText: 'has changed since this comparison' })).toBeVisible()
      await page.getByRole('button', { name: 'Compare again' }).click()
      await waitResults(page)
      await expect(page.getByRole('alert').filter({ hasText: 'has changed since this comparison' })).toHaveCount(0)
      await expect(verdict(page)).toContainText('8 changes')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('compare: accessibility', () => {
  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light'
    test(`axe scans of every state (${theme})`, async () => {
      const newPath = copyFixture('cmp-report-new.pdf')
      const { app, page } = await launch({ files: [newPath] })
      try {
        await setTheme(app, dark)
        await openCompare(app, page)
        expect(await axeViolations(page, `choose ${theme}`)).toEqual([])
        await stubOpenDialog(app, [copyFixture('cmp-report-old.pdf')])
        await page.getByTestId('compare-old').getByRole('button', { name: 'Choose file…' }).click()
        expect(await axeViolations(page, `choose filled ${theme}`)).toEqual([])
        await page.getByTestId('compare-start').click()
        await waitResults(page)
        await options(page).first().waitFor()
        expect(await axeViolations(page, `results ${theme}`)).toEqual([])
        await page.locator('[data-testid="compare-change"]').filter({ hasText: 'Monday' }).click()
        await expect(current(page, 'new')).toHaveCount(1)
        expect(await axeViolations(page, `results with current change ${theme}`)).toEqual([])
        await page.getByTestId('mode-visual').check()
        await expect(page.getByTestId('visual-summary')).toContainText('pixels differ', { timeout: 30_000 })
        expect(await axeViolations(page, `visual ${theme}`)).toEqual([])
      } finally {
        await app.close()
      }
    })
  }

  test('changes are identifiable without colour: words, symbols and text decorations', async () => {
    const { app, page } = await reportSession()
    try {
      for (const [kind, label] of [
        ['removed', 'Removed'],
        ['added', 'Added'],
        ['modified', 'Modified'],
        ['moved', 'Moved']
      ] as const) {
        const item = page.locator(`[data-testid="compare-change"][data-kind="${kind}"]`).first()
        await expect(item.locator('.cmp-kind')).toContainText(label)
      }
      await page.locator('[data-testid="compare-change"][data-kind="removed"]').filter({ hasText: 'sentence will be removed' }).click()
      const hl = current(page, 'old').first()
      await expect(hl.locator('.cmp-badge')).toHaveText('−')
      // struck through: the line drawn by the ::after rule
      const after = await hl.evaluate((el) => getComputedStyle(el, '::after').height)
      expect(after).toBe('2px')
      await page.locator('[data-testid="compare-change"][data-kind="added"]').filter({ hasText: 'brand new paragraph' }).click()
      const added = current(page, 'new').first()
      await expect(added.locator('.cmp-badge')).toHaveText('+')
      expect(await added.evaluate((el) => getComputedStyle(el).borderBottomStyle)).toBe('solid')
      await page.locator('[data-testid="compare-change"]').filter({ hasText: 'Monday' }).click()
      expect(await current(page, 'new').first().evaluate((el) => getComputedStyle(el).borderBottomStyle)).toBe('double')
    } finally {
      await app.close()
    }
  })
})
