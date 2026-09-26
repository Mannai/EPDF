import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument, PDFName } from 'pdf-lib'
import { readBookmarks } from '../../src/renderer/src/features/bookmarks/pdf/read'
import { validateOutline } from '../../src/renderer/src/features/bookmarks/pdf/validate'
import type { BmNode } from '../../src/renderer/src/features/bookmarks/pdf/model'
import { writeLbFixtures } from '../fixtures/lbFixtures'
import { openWith } from '../unit/helpers/securityHelpers'
import { axeViolations, copyFixture, launch, menuClick, quitDiscarding } from './helpers'

const FIXTURES = resolve('test-results/fixtures')

test.beforeAll(async () => {
  await writeLbFixtures(FIXTURES)
})

// ---------------------------------------------------------------- helpers

const N = (s: string): PDFName => PDFName.of(s)
const dot = (page: Page): Locator => page.getByTestId('unsaved-dot')
const tool = (page: Page, name: string): Locator => page.getByRole('toolbar', { name: 'Editing tools' }).getByRole('button', { name, exact: true })
const tree = (page: Page): Locator => page.getByRole('tree', { name: 'Bookmarks' })
const item = (page: Page, name: string | RegExp): Locator => tree(page).getByRole('treeitem', { name })

async function open(file: string, opts: Parameters<typeof launch>[0] = {}): Promise<{ app: ElectronApplication; page: Page; path: string }> {
  const path = copyFixture(file)
  const launched = await launch({ files: [path], ...opts })
  const { app, page } = launched
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  await expect(page.locator('[data-page="1"] .textLayer span').first()).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
  await page.waitForTimeout(400)
  return { ...launched, path }
}

const showBookmarks = async (app: ElectronApplication, page: Page): Promise<void> => {
  await menuClick(app, 'View', 'Bookmarks Panel')
  await expect(page.getByTestId('bookmarks-panel')).toBeVisible()
}

async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dot(page)).toHaveCount(0)
}

const docOnDisk = async (path: string): Promise<PDFDocument> => PDFDocument.load(readFileSync(path))

/** The saved outline as indented titles, and whether it is a strictly valid /Outlines tree. */
async function outlineOnDisk(path: string): Promise<{ titles: string[]; problems: string[]; roots: BmNode[] }> {
  const pdf = await docOnDisk(path)
  const roots = readBookmarks(pdf).roots
  const titles: string[] = []
  const walk = (nodes: BmNode[], depth: number): void => {
    for (const n of nodes) {
      titles.push(`${'-'.repeat(depth)}${n.title}`)
      walk(n.children, depth + 1)
    }
  }
  walk(roots, 0)
  return { titles, problems: validateOutline(pdf), roots }
}

const visibleTitles = async (page: Page): Promise<string[]> => tree(page).getByRole('treeitem').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.title ?? ''))

const ARABIC_TITLE = 'اَلْفَصْلُ الْأَوَّلُ: مُقَدِّمَة'
const HEBREW = 'שָׁלוֹם עוֹלָם'
const CHAPTER3 = 'Chapter 三 第三章 🚀'
const MIXED = 'Mixed العربية English 123'
const ALL_TITLES = ['Introduction', 'Background', ARABIC_TITLE, 'Scope', HEBREW, CHAPTER3, MIXED, 'Last']

/** The page number the viewer believes it is on. */
const currentPage = async (page: Page): Promise<number> => Number(await page.getByLabel('Page number').inputValue())
const goto = async (page: Page, n: number): Promise<void> => {
  const input = page.getByLabel('Page number')
  await input.fill(String(n))
  await input.press('Enter')
  await expect.poll(() => currentPage(page)).toBe(n)
}
const undoButton = (page: Page, label: string): Locator => page.getByRole('button', { name: `Undo ${label}` })

/** Clicks a row and gives the tree keyboard focus. */
async function selectRow(page: Page, name: string | RegExp): Promise<void> {
  await item(page, name).click()
  await expect(item(page, name)).toHaveAttribute('aria-selected', 'true')
  await expect(tree(page)).toBeFocused()
}

// ---------------------------------------------------------------- bookmarks: viewing

test.describe('bookmarks panel: viewing', () => {
  test('shows the outline as a tree with correct ARIA, in every script', async () => {
    const { app, page } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      await expect(item(page, /Introduction/)).toBeVisible()
      expect(await visibleTitles(page)).toEqual(ALL_TITLES)
      // ARIA tree pattern: levels, set sizes and positions, expanded state only on parents.
      const intro = item(page, /Introduction/)
      await expect(intro).toHaveAttribute('aria-level', '1')
      await expect(intro).toHaveAttribute('aria-expanded', 'true')
      await expect(intro).toHaveAttribute('aria-setsize', '5')
      await expect(intro).toHaveAttribute('aria-posinset', '1')
      const scope = item(page, /^Scope/)
      await expect(scope).toHaveAttribute('aria-level', '2')
      await expect(scope).toHaveAttribute('aria-setsize', '3')
      await expect(scope).toHaveAttribute('aria-posinset', '3')
      await expect(scope).not.toHaveAttribute('aria-expanded', /.*/)
      await expect(item(page, /Chapter 三/)).toHaveAttribute('aria-expanded', 'false')
      // Titles are isolated for mixed direction: dir="auto" on the title element.
      const dirs = await tree(page).locator('[role="treeitem"] span[dir="auto"]').evaluateAll((els) => els.map((e) => getComputedStyle(e).unicodeBidi))
      expect(dirs.every((d) => d === 'isolate')).toBe(true)
      await expect(page.getByTestId('bookmarks-panel')).toHaveAttribute('data-count', '10')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('clicking navigates (page and position); the current position follows the page being viewed', async () => {
    const { app, page } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      await expect(item(page, /Introduction/)).toHaveAttribute('aria-current', 'location') // page 1
      await item(page, /^Scope/).click()
      await expect.poll(() => currentPage(page)).toBe(3)
      await expect(item(page, /^Scope/)).toHaveAttribute('aria-current', 'location')
      await expect(item(page, /Introduction/)).not.toHaveAttribute('aria-current', /.*/)
      // Browsing to a page inside a collapsed branch marks the nearest visible ancestor.
      await goto(page, 7)
      await expect(item(page, /Chapter 三/)).toHaveAttribute('aria-current', 'location')
      await goto(page, 12)
      await expect(item(page, /^Last/)).toHaveAttribute('aria-current', 'location')

      // A destination with a vertical position scrolls inside the page: the Arabic bookmark points at y=500 on page 2.
      await item(page, /اَلْفَصْلُ/).click()
      await expect.poll(() => currentPage(page)).toBe(2)
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const s = document.querySelector('[data-testid="viewer-scroll"]')!.getBoundingClientRect()
            const p = document.querySelector('.epdf-page[data-page="2"]')!.getBoundingClientRect()
            return Math.round(s.top - p.top) // how far the page top is above the viewport top
          })
        )
        .toBeGreaterThan(150)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the filter finds titles regardless of case and diacritics (Arabic tashkeel, Hebrew niqqud), and shows the path to matches', async () => {
    const { app, page } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      const filter = page.getByLabel('Filter bookmarks')
      await filter.fill('الفصل الاول') // typed without tashkeel and with a plain alef instead of alef-with-hamza
      await expect.poll(() => visibleTitles(page)).toEqual(['Introduction', ARABIC_TITLE])
      await filter.fill('الفصل')
      await expect.poll(() => visibleTitles(page)).toEqual(['Introduction', ARABIC_TITLE])
      await filter.fill('שלום')
      await expect.poll(() => visibleTitles(page)).toEqual(['שָׁלוֹם עוֹלָם'])
      await filter.fill('DEEP')
      await expect.poll(() => visibleTitles(page)).toEqual(['Chapter 三 第三章 🚀', 'Deep', 'Deeper']) // opened to show the matches ("Deep" is inside "Deeper")
      await expect(page.getByTestId('bookmarks-panel').getByRole('status').first()).toContainText('matching')
      await filter.fill('zzz')
      await expect(page.getByText('No bookmark matches')).toBeVisible()
      await filter.press('Escape')
      await expect(filter).toHaveValue('')
      expect(await visibleTitles(page)).toEqual(ALL_TITLES)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('keyboard: arrows, Home/End, expand/collapse, * and Enter follow the ARIA tree pattern', async () => {
    const { app, page } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      await selectRow(page, /Introduction/)
      const active = async (): Promise<string> => tree(page).evaluate((t) => document.getElementById(t.getAttribute('aria-activedescendant') ?? '')?.dataset.title ?? '')
      await page.keyboard.press('ArrowDown')
      expect(await active()).toBe('Background')
      await page.keyboard.press('End')
      expect(await active()).toBe('Last')
      await page.keyboard.press('Home')
      expect(await active()).toBe('Introduction')
      await page.keyboard.press('ArrowLeft') // collapses
      await expect(item(page, /Introduction/)).toHaveAttribute('aria-expanded', 'false')
      expect(await visibleTitles(page)).toEqual(['Introduction', 'שָׁלוֹם עוֹלָם', 'Chapter 三 第三章 🚀', 'Mixed العربية English 123', 'Last'])
      await page.keyboard.press('ArrowRight') // expands again
      await expect(item(page, /Introduction/)).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('ArrowRight') // moves to the first child
      expect(await active()).toBe('Background')
      await page.keyboard.press('ArrowLeft') // a leaf: moves to the parent
      expect(await active()).toBe('Introduction')
      // * opens every collapsed sibling at this level.
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      expect(await active()).toBe('Chapter 三 第三章 🚀')
      await page.keyboard.press('*')
      await expect(item(page, /Chapter 三/)).toHaveAttribute('aria-expanded', 'true')
      // Enter follows the bookmark.
      await page.keyboard.press('Enter')
      await expect.poll(() => currentPage(page)).toBe(5)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---------------------------------------------------------------- bookmarks: editing

test.describe('bookmarks panel: editing', () => {
  test('add a bookmark for the current page (inline title, Arabic), rename with F2, Escape cancels; saved file is valid', async () => {
    const { app, page, path } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      await goto(page, 11)
      await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
      const input = tree(page).getByLabel('Bookmark title')
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('Page 11')
      await input.fill('مرحبا بالعالم – 2024')
      await input.press('Enter')
      await expect(item(page, /مرحبا بالعالم/)).toBeVisible()
      await expect(dot(page)).toBeVisible()
      await expect(undoButton(page, 'Rename bookmark')).toBeVisible() // add and rename are separate undo steps

      // F2 renames; Escape leaves the title alone.
      await selectRow(page, /^Last/)
      await page.keyboard.press('F2')
      const edit = tree(page).getByLabel('Bookmark title')
      await edit.fill('should not be kept')
      await edit.press('Escape')
      await expect(item(page, /^Last/)).toBeVisible()
      await expect(tree(page)).toBeFocused()
      await page.keyboard.press('F2')
      await tree(page).getByLabel('Bookmark title').fill('Final')
      await page.keyboard.press('Enter')
      await expect(item(page, /^Final/)).toBeVisible()
      // Double click also starts editing.
      await item(page, /^Final/).dblclick()
      await expect(tree(page).getByLabel('Bookmark title')).toBeFocused()
      await page.keyboard.press('Escape')

      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.problems).toEqual([])
      expect(disk.titles).toContain('Final')
      expect(disk.titles).not.toContain('Last')
      expect(disk.titles).toContain('مرحبا بالعالم – 2024')
      // The new bookmark points at page 11.
      const added = disk.roots.find((n) => n.title.startsWith('مرحبا'))!
      expect(added.target).toMatchObject({ kind: 'page', dest: { pageIndex: 10 } })
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('add a bookmark from selected text: the title is prefilled from the selection', async () => {
    const { app, page, path } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      await goto(page, 2)
      const span = page.locator('[data-page="2"] .textLayer span', { hasText: 'Some body text' }).first()
      await expect(span).toBeVisible()
      await page.waitForTimeout(500)
      const b = (await span.boundingBox())!
      await page.mouse.move(b.x + 2, b.y + b.height / 2)
      await page.mouse.down()
      await page.mouse.move(b.x + b.width * 0.985, b.y + b.height / 2, { steps: 8 })
      await page.mouse.up()
      await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
      const input = tree(page).getByLabel('Bookmark title')
      await expect(input).toHaveValue(/Some body text/)
      await input.press('Enter')
      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.titles.some((t) => t.includes('Some body text'))).toBe(true)
      expect(disk.problems).toEqual([])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('delete asks before removing children; Cancel keeps everything; undo restores', async () => {
    const { app, page, path } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      await selectRow(page, /Introduction/)
      await page.keyboard.press('Delete')
      const dlg = page.getByRole('dialog', { name: 'Delete this bookmark and its children?' })
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dlg).toHaveCount(0)
      expect(await visibleTitles(page)).toEqual(ALL_TITLES)
      await expect(dot(page)).toHaveCount(0)

      await page.keyboard.press('Delete')
      await page.getByRole('dialog', { name: 'Delete this bookmark and its children?' }).getByRole('button', { name: 'Delete 4 bookmarks' }).click()
      await expect.poll(() => visibleTitles(page)).toEqual(ALL_TITLES.slice(4))
      // Selection moved to a neighbour, so Delete works again without clicking.
      await expect(item(page, /שָׁלוֹם/)).toHaveAttribute('aria-selected', 'true')

      await undoButton(page, 'Delete bookmarks').click()
      await expect.poll(() => visibleTitles(page)).toEqual(ALL_TITLES)

      // A leaf is deleted without a prompt.
      await selectRow(page, /^Last/)
      await page.getByRole('button', { name: 'Delete bookmark', exact: true }).click()
      await expect.poll(() => visibleTitles(page)).toEqual(ALL_TITLES.slice(0, -1))
      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.problems).toEqual([])
      expect(disk.titles).not.toContain('Last')
      expect(disk.titles).toContain('Introduction')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('nest, un-nest and reorder with the buttons and with Alt+arrows; every step is undoable', async () => {
    const { app, page, path } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      await selectRow(page, /^Last/)
      await page.keyboard.press('Alt+ArrowUp') // above "Mixed"
      await expect.poll(() => visibleTitles(page)).toEqual([...ALL_TITLES.slice(0, 6), 'Last', 'Mixed العربية English 123'])
      await page.keyboard.press('Alt+ArrowRight') // nest under "Chapter 三" (its previous sibling)
      await expect(item(page, /Chapter 三/)).toHaveAttribute('aria-expanded', 'true') // opened so the item stays visible
      await expect.poll(() => tree(page).getByRole('treeitem', { name: /^Last/ }).getAttribute('aria-level')).toBe('2')
      await page.keyboard.press('Alt+ArrowLeft') // and back out
      await expect.poll(() => tree(page).getByRole('treeitem', { name: /^Last/ }).getAttribute('aria-level')).toBe('1')
      await page.getByRole('button', { name: 'Move bookmark down', exact: true }).click()
      await expect.poll(() => visibleTitles(page).then((t) => t.slice(-1))).toEqual(['Last'])
      await page.getByRole('button', { name: 'Nest bookmark', exact: true }).click()
      await expect.poll(() => tree(page).getByRole('treeitem', { name: /^Last/ }).getAttribute('aria-level')).toBe('2')
      await page.getByRole('button', { name: 'Un-nest bookmark', exact: true }).click()
      await expect.poll(() => tree(page).getByRole('treeitem', { name: /^Last/ }).getAttribute('aria-level')).toBe('1')
      // The first bookmark of a level cannot be nested or moved up further.
      await selectRow(page, /Introduction/)
      await page.keyboard.press('Alt+ArrowRight')
      await expect(page.getByRole('alert').filter({ hasText: 'cannot be nested' })).toBeVisible()
      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.problems).toEqual([])
      expect(disk.titles).toEqual(['Introduction', '-Background', `-${ARABIC_TITLE}`, '-Scope', 'שָׁלוֹם עוֹלָם', 'Chapter 三 第三章 🚀', '-Deep', '--Deeper', 'Mixed العربية English 123', 'Last'])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('drag and drop reorders and nests, with a drop indicator; dropping onto itself does nothing', async () => {
    const { app, page, path } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      /**
       * Playwright's raw mouse cannot start an HTML5 drag in Electron, so the drag events are dispatched the way the
       * browser would: dragstart on the source, dragover(s) over the target at a chosen height, then drop and dragend.
       */
      const drag = async (from: Locator, to: Locator, where: 'before' | 'after' | 'inside', during?: () => Promise<void>): Promise<void> => {
        const dt = await page.evaluateHandle(() => new DataTransfer())
        const tb = (await to.boundingBox())!
        const y = tb.y + tb.height * (where === 'before' ? 0.1 : where === 'after' ? 0.9 : 0.5)
        await from.dispatchEvent('dragstart', { dataTransfer: dt })
        await to.dispatchEvent('dragover', { dataTransfer: dt, clientX: tb.x + 80, clientY: y })
        if (during) await during()
        await to.dispatchEvent('drop', { dataTransfer: dt, clientX: tb.x + 80, clientY: y })
        await from.dispatchEvent('dragend', { dataTransfer: dt })
      }
      // "Last" dropped on the lower edge of "Background": a line shows under Background, then it lands after it.
      await drag(item(page, /^Last/), item(page, /^Background/), 'after', async () => {
        await expect(tree(page).locator('[data-drop="after"]')).toBeVisible()
      })
      await expect.poll(() => visibleTitles(page)).toEqual(['Introduction', 'Background', 'Last', ARABIC_TITLE, 'Scope', HEBREW, CHAPTER3, MIXED])
      await expect(tree(page).locator('[data-drop]')).toHaveCount(0)

      // "Mixed" dropped on the middle of the Hebrew item: it becomes that item's child (a box, not a line, marks it).
      await drag(item(page, /^Mixed/), item(page, HEBREW), 'inside', async () => {
        await expect(item(page, HEBREW)).toHaveClass(/ring-2/)
      })
      await expect.poll(() => item(page, /^Mixed/).getAttribute('aria-level')).toBe('2')

      // Above the first item: the upper edge line, and the bookmark becomes the first one.
      await drag(item(page, /^Scope/), item(page, /Introduction/), 'before', async () => {
        await expect(tree(page).locator('[data-drop="before"]')).toBeVisible()
      })
      await expect.poll(() => visibleTitles(page).then((t) => t[0])).toBe('Scope')

      // A bookmark cannot be dropped into its own subtree: no indicator, no edit.
      const edits = await page.getByRole('button', { name: /^Undo / }).getAttribute('aria-label')
      await drag(item(page, /Introduction/), item(page, /^Background/), 'inside', async () => {
        await expect(tree(page).locator('[data-drop]')).toHaveCount(0)
      })
      expect(await page.getByRole('button', { name: /^Undo / }).getAttribute('aria-label')).toBe(edits)

      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.problems).toEqual([])
      expect(disk.titles[0]).toBe('Scope')
      expect(disk.titles).toContain(`-${MIXED}`)
      expect(disk.titles.indexOf('-Last')).toBeGreaterThan(disk.titles.indexOf('-Background'))
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('style: bold, italic, colour, open by default; "point to current view" changes the destination', async () => {
    const { app, page, path } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      await selectRow(page, /^Last/)
      await page.getByRole('button', { name: 'Bold', exact: true }).click()
      await page.getByRole('button', { name: 'Italic', exact: true }).click()
      await page.getByLabel('Bookmark colour').fill('#ff0000')
      await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await selectRow(page, /Chapter 三/)
      await page.getByLabel('Open by default').click()
      await expect(page.getByLabel('Open by default')).toBeChecked()
      await selectRow(page, /^Last/) // (clicking follows the bookmark to page 10)
      await goto(page, 9)
      await page.getByRole('button', { name: 'Point to current view' }).click()
      await expect(page.getByTestId('bookmark-destination')).toContainText('Page 9')
      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.problems).toEqual([])
      const last = disk.roots.find((n) => n.title === 'Last')!
      expect([last.bold, last.italic, last.color?.map((v) => Math.round(v * 255))]).toEqual([true, true, [255, 0, 0]])
      expect(last.target).toMatchObject({ kind: 'page', dest: { pageIndex: 8 } })
      expect(disk.roots.find((n) => n.title.startsWith('Chapter 三'))!.open).toBe(true)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('undo and redo move one operation at a time, and the panel follows', async () => {
    const { app, page } = await open('lb-outline.pdf')
    try {
      await showBookmarks(app, page)
      await selectRow(page, /^Last/)
      await page.keyboard.press('F2')
      await tree(page).getByLabel('Bookmark title').fill('Renamed once')
      await page.keyboard.press('Enter')
      await expect(item(page, /Renamed once/)).toBeVisible()
      await page.keyboard.press('Alt+ArrowUp')
      await expect.poll(() => visibleTitles(page).then((t) => t.slice(-2))).toEqual(['Renamed once', 'Mixed العربية English 123'])
      await undoButton(page, 'Reorder bookmark').click()
      await expect.poll(() => visibleTitles(page).then((t) => t.slice(-2))).toEqual(['Mixed العربية English 123', 'Renamed once'])
      await undoButton(page, 'Rename bookmark').click()
      await expect(item(page, /^Last/)).toBeVisible()
      await expect(dot(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Redo Rename bookmark' }).click()
      await expect(item(page, /Renamed once/)).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Arabic and Hebrew titles survive Save and reopen: in the saved file and in the panel', async () => {
    const { app, page, path } = await open('lb-outline.pdf')
    const titles = ['اَلْفَصْلُ الثَّانِي: الْمَفَاهِيمُ الْأَسَاسِيَّة', 'תוכן עניינים – פרק ב׳', 'Mixed: نظام (System) 2024 — 🚀']
    try {
      await showBookmarks(app, page)
      for (const t of titles) {
        await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
        const input = tree(page).getByLabel('Bookmark title')
        await expect(input).toBeFocused()
        await input.fill(t)
        await input.press('Enter')
        await expect(item(page, t)).toBeVisible()
      }
      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.problems).toEqual([])
      for (const t of titles) expect(disk.titles).toContain(t)
    } finally {
      await quitDiscarding(app, page)
    }
    // Reopen the saved file in a fresh app: the panel shows the same titles.
    const again = await launch({ files: [path] })
    try {
      await expect(again.page.locator('[data-page="1"] canvas')).toBeVisible()
      await showBookmarks(again.app, again.page)
      for (const t of titles) await expect(item(again.page, t)).toBeVisible()
    } finally {
      await quitDiscarding(again.app, again.page)
    }
  })
})

// ---------------------------------------------------------------- bookmarks: generate from headings

const generateButton = (page: Page): Locator => page.getByRole('button', { name: 'Generate bookmarks from headings', exact: true })
const generateDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Generate bookmarks from headings' })

test.describe('bookmarks: generate from headings', () => {
  test('English report: analysed in the background, reviewed (reject, promote), created as one undo step with correct destinations', async () => {
    const { app, page, path } = await open('lb-report.pdf')
    try {
      await showBookmarks(app, page)
      await expect(page.getByTestId('bookmarks-empty')).toBeVisible()
      await generateButton(page).click()
      const dlg = generateDialog(page)
      await expect(dlg.getByTestId('generate-review')).toBeVisible({ timeout: 45_000 })
      // The cover title is listed first but not pre-selected (low confidence); the chapters follow.
      await expect(dlg.getByTestId('generate-item').first()).toContainText('Annual Report 2024')
      await expect(dlg.getByTestId('generate-item').first()).toHaveAttribute('data-accepted', 'false')
      const introRow = dlg.getByTestId('generate-item').filter({ hasText: '1 Introduction' })
      await expect(introRow).toHaveAttribute('data-accepted', 'true')
      // Reasons are available for every candidate (title tooltip) and the list says how many are selected.
      await expect(dlg.getByRole('status').filter({ hasText: 'selected' })).toContainText(/2\d of 2\d selected/)
      await dlg.getByRole('checkbox', { name: 'Include “1.2 Objectives”' }).uncheck()
      await dlg.getByRole('button', { name: 'Promote “1.1 Background” (less nested)' }).click()
      await dlg.getByRole('button', { name: /^Create \d+ bookmarks$/ }).click()
      await expect(dlg).toHaveCount(0)
      await expect(item(page, /^1 Introduction/)).toBeVisible()
      await expect(undoButton(page, 'Generate bookmarks')).toBeVisible()
      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.problems).toEqual([])
      expect(disk.titles).toContain('1.1 Background') // promoted to the top level
      expect(disk.titles).not.toContain('-1.2 Objectives')
      expect(disk.titles.filter((t) => /^\d [A-Z]/.test(t))).toEqual(['1 Introduction', '2 System Architecture', '3 Implementation', '4 Evaluation', '5 Conclusion'])
      expect(disk.titles).toContain('-2.1 Overview')
      expect(disk.titles).toContain('-1.1.1 Details') // (nested under the promoted 1.1 Background)
      expect(disk.titles).toContain('--2.1.1 Details')
      // Destinations are /XYZ at the heading's top (page 2 = index 1, y in the upper part of the page).
      const intro = disk.roots.find((n) => n.title === '1 Introduction')!
      expect(intro.target).toMatchObject({ kind: 'page', dest: { pageIndex: 1, tail: ['XYZ', null, expect.any(Number), null] } })
      if (intro.target.kind === 'page') expect(intro.target.dest.tail[2] as number).toBeGreaterThan(650)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Arabic right-to-left report: Arabic chapter and section headings become nested bookmarks', async () => {
    const { app, page, path } = await open('lb-arabic.pdf')
    try {
      await showBookmarks(app, page)
      await generateButton(page).click()
      const dlg = generateDialog(page)
      await expect(dlg.getByTestId('generate-review')).toBeVisible({ timeout: 45_000 })
      await expect(dlg.getByTestId('generate-item').nth(1)).toContainText('الفصل الأول: مقدمة عن الأمن')
      await dlg.getByRole('button', { name: /^Create \d+ bookmarks$/ }).click()
      await expect(dlg).toHaveCount(0)
      await expect(item(page, /الفصل الأول/)).toBeVisible()
      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.problems).toEqual([])
      const chapters = disk.roots.filter((n) => n.title.startsWith('الفصل'))
      expect(chapters.map((c) => c.title)).toEqual([
        'الفصل الأول: مقدمة عن الأمن',
        'الفصل الثاني: المفاهيم الأساسية',
        'الفصل الثالث: التهديدات والمخاطر',
        'الفصل الرابع: أساليب الحماية',
        'الفصل الخامس: الخلاصة والتوصيات'
      ])
      expect(chapters[0].children.map((c) => c.title)).toEqual(['1.1 نظرة عامة', '1.2 أهداف الكتاب'])
      // The destination is at the heading, on the right-hand page area's top.
      expect(chapters[0].target).toMatchObject({ kind: 'page', dest: { pageIndex: 1 } })
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a document without headings says so; a long analysis can be cancelled and creates nothing', async () => {
    const first = await open('sample.pdf')
    try {
      await showBookmarks(first.app, first.page)
      await generateButton(first.page).click()
      await expect(generateDialog(first.page).getByTestId('generate-empty')).toBeVisible({ timeout: 45_000 })
      await expect(generateDialog(first.page)).toContainText('No headings were found')
      await generateDialog(first.page).getByRole('button', { name: 'Close' }).click()
      await expect(generateDialog(first.page)).toHaveCount(0)
    } finally {
      await quitDiscarding(first.app, first.page)
    }

    const { app, page } = await open('large.pdf') // 500 pages
    try {
      await showBookmarks(app, page)
      await generateButton(page).click()
      const dlg = generateDialog(page)
      await expect(dlg.getByTestId('generate-working')).toBeVisible()
      await expect(dlg.getByRole('progressbar', { name: 'Analysis progress' })).toBeVisible()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(page.getByTestId('bookmarks-empty')).toBeVisible()
      await expect(dot(page)).toHaveCount(0)
      // The background task ended as cancelled (it was a real job with a tray entry).
      await expect(page.locator('[data-job="bookmarks:detect"]')).toContainText('Cancelled')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('keyboard-only review: the dialog is operable with Tab, Space and Enter', async () => {
    const { app, page } = await open('lb-report.pdf')
    try {
      await showBookmarks(app, page)
      await generateButton(page).focus()
      await page.keyboard.press('Enter')
      const dlg = generateDialog(page)
      await expect(dlg.getByTestId('generate-review')).toBeVisible({ timeout: 45_000 })
      await dlg.getByRole('button', { name: 'Select none' }).focus()
      await page.keyboard.press('Enter')
      await expect(dlg.getByRole('button', { name: /^Create 0 bookmarks$/ })).toBeDisabled()
      const first = dlg.getByRole('checkbox', { name: 'Include “1 Introduction”' })
      await first.focus()
      await page.keyboard.press('Space')
      await expect(first).toBeChecked()
      await page.keyboard.press('Escape') // Escape closes the dialog without creating anything
      await expect(dlg).toHaveCount(0)
      await expect(page.getByTestId('bookmarks-empty')).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---------------------------------------------------------------- bookmarks: protected documents and scale

const SECURITY = resolve('tests/fixtures/security')

test.describe('bookmarks: protected documents', () => {
  test('a password-protected document asks to unlock; bookmarks can then be added, and Save keeps it encrypted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-lb-enc-'))
    const path = join(dir, 'protected.pdf')
    writeFileSync(path, readFileSync(join(SECURITY, 'aes-256-r6.pdf')))
    const { app, page } = await launch({ files: [path] })
    try {
      const prompt = page.getByRole('dialog', { name: 'Password required' })
      await expect(prompt).toBeVisible()
      await prompt.getByLabel('Document password').fill('user256')
      await prompt.getByRole('button', { name: 'Open' }).click()
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'View', 'Bookmarks Panel')
      const unlockButton = page.getByRole('button', { name: 'Unlock to edit bookmarks' })
      await expect(unlockButton).toBeVisible()
      expect(await axeViolations(page, 'bookmarks locked')).toEqual([])
      await unlockButton.click()
      await expect(page.getByTestId('bookmarks-empty')).toBeVisible()
      await page.getByRole('button', { name: 'Add bookmark for this page' }).click()
      await tree(page).getByLabel('Bookmark title').press('Enter')
      await expect(item(page, /Page 1/)).toBeVisible()
      await save(page)
      const bytes = new Uint8Array(readFileSync(path))
      expect(Buffer.from(bytes).toString('latin1')).toContain('/Encrypt') // still protected on disk
      await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypt/i) // and unreadable without the password
      const plain = (await openWith(bytes, 'user256')).plain
      const outline = readBookmarks(await PDFDocument.load(plain)).roots
      expect(outline.map((n) => n.title)).toEqual(['Page 1'])
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('bookmarks: scale', () => {
  test('5,000 bookmarks: the panel stays responsive (virtualised), navigates, filters and edits', async () => {
    const { app, page, path } = await open('lb-many.pdf')
    try {
      const t0 = Date.now()
      await menuClick(app, 'View', 'Bookmarks Panel')
      await expect(page.getByTestId('bookmarks-panel')).toHaveAttribute('data-count', '5000', { timeout: 30_000 })
      await expect(item(page, /^Chapter 1,/)).toBeVisible()
      const shown = Date.now() - t0
      expect(shown).toBeLessThan(15_000)
      test.info().annotations.push({ type: 'timing', description: `panel shown ${shown} ms` })
      await page.getByRole('button', { name: 'Expand', exact: true }).click()
      await expect(item(page, /^Section 1\.1,/)).toBeVisible()
      // Only the visible window is in the DOM, however large the tree.
      const rows = await tree(page).getByRole('treeitem').count()
      expect(rows).toBeGreaterThan(5)
      expect(rows).toBeLessThan(80)
      expect(await tree(page).evaluate((el) => el.style.height)).toBe(`${5000 * 30}px`)
      // End jumps to the last item quickly.
      await item(page, /^Chapter 1,/).click()
      const t1 = Date.now()
      await page.keyboard.press('End')
      await expect(item(page, /^Section 50\.99,/)).toBeVisible()
      expect(Date.now() - t1).toBeLessThan(3000)
      test.info().annotations.push({ type: 'timing', description: `End key ${Date.now() - t1} ms` })
      await expect(item(page, /^Section 50\.99,/)).toHaveAttribute('aria-posinset', '99')
      await expect(item(page, /^Section 50\.99,/)).toHaveAttribute('aria-setsize', '99')
      // Filtering searches all 5,000 titles.
      const t2 = Date.now()
      await page.getByLabel('Filter bookmarks').fill('section 7.42')
      await expect.poll(() => visibleTitles(page)).toEqual(['Chapter 7', 'Section 7.42'])
      expect(Date.now() - t2).toBeLessThan(3000)
      test.info().annotations.push({ type: 'timing', description: `filter ${Date.now() - t2} ms` })
      await page.getByLabel('Filter bookmarks').fill('')
      // An edit on the big tree completes in reasonable time and keeps the outline valid.
      await item(page, /^Section 3\.5,/).scrollIntoViewIfNeeded().catch(() => undefined)
      const t3 = Date.now()
      await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
      await tree(page).getByLabel('Bookmark title').press('Enter')
      await expect(dot(page)).toBeVisible()
      expect(Date.now() - t3).toBeLessThan(20_000)
      test.info().annotations.push({ type: 'timing', description: `add on 5000 ${Date.now() - t3} ms` })
      await save(page)
      const disk = await outlineOnDisk(path)
      expect(disk.problems).toEqual([])
      expect(disk.titles.length).toBe(5001)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

