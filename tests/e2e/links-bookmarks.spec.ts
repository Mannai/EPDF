import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { readBookmarks } from '../../src/renderer/src/features/bookmarks/pdf/read'
import { validateOutline } from '../../src/renderer/src/features/bookmarks/pdf/validate'
import type { BmNode } from '../../src/renderer/src/features/bookmarks/pdf/model'
import { readLinks } from '../../src/renderer/src/features/links/pdf/read'
import { writeLbFixtures } from '../fixtures/lbFixtures'
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
})

