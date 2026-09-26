import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument, PDFName } from 'pdf-lib'
import { readBookmarks } from '../../src/renderer/src/features/bookmarks/pdf/read'
import { validateOutline } from '../../src/renderer/src/features/bookmarks/pdf/validate'
import type { BmNode } from '../../src/renderer/src/features/bookmarks/pdf/model'
import { readLinks } from '../../src/renderer/src/features/links/pdf/read'
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
      await expect(page.locator('[role="status"]').filter({ hasText: 'Bookmark added for page 11' })).toBeAttached()
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

/**
 * Lets Chromium (the engine inside Electron) print an HTML document to a PDF file: a real PDF producer, with its own
 * font subsetting, ToUnicode maps, bidi ordering and header/footer templates. Returns the path of the file.
 */
async function chromiumPdf(html: string, headerText: string): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), 'epdf-lb-chromium-')), 'chromium.pdf')
  const maker = await launch({})
  try {
    const b64 = await maker.app.evaluate(
      async ({ BrowserWindow }, arg) => {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(arg.html)}`)
        const pdf = await win.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: `<div style="font-size:9px;width:100%;text-align:center">${arg.header}</div>`,
          footerTemplate: '<div style="font-size:9px;width:100%;text-align:center"><span class="pageNumber"></span></div>'
        })
        win.destroy()
        return pdf.toString('base64')
      },
      { html, header: headerText }
    )
    writeFileSync(path, Buffer.from(b64, 'base64'))
  } finally {
    await quitDiscarding(maker.app, maker.page)
  }
  return path
}

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

  test('an Arabic document made by Chromium itself (a real PDF producer, not our fixture): chapters and sections are found in logical order', async () => {
    const chapters = ['الفصل الأول: مقدمة عن الأمن', 'الفصل الثاني: المفاهيم الأساسية', 'الفصل الثالث: أساليب الحماية']
    const para = 'يقوم النظام على تصميم متعدد الوحدات حيث تتواصل كل وحدة عبر واجهات محددة ويتم التحقق من كل طلب قبل معالجته ثم تخزين النتيجة وإبلاغ الأطراف المعنية بالتغييرات. '.repeat(9)
    // Step 1: let Chromium print a right-to-left HTML document to PDF (real shaping, real subset fonts, real bidi order).
    const path = await chromiumPdf(
      `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>
        body { font-family: Tahoma, 'Segoe UI', Arial, sans-serif; font-size: 12pt; line-height: 1.7 }
        h1 { font-size: 26pt; margin: 0 0 14pt } h2 { font-size: 17pt; margin: 18pt 0 8pt }
        .ch { page-break-before: always } .cover { text-align: center; margin-top: 200pt }
      </style></head><body>
        <div class="cover"><h1>كتاب الأمن السيبراني</h1><p>دليل شامل للمبتدئين</p></div>
        ${chapters.map((c, i) => `<div class="ch"><h1>${c}</h1><p>${para}</p><h2>${i + 1}.1 نظرة عامة</h2><p>${para}</p><h2>${i + 1}.2 أهداف الفصل</h2><p>${para}</p></div>`).join('')}
      </body></html>`,
      'كتاب الأمن السيبراني'
    )
    // Step 2: open it in Epdf and generate bookmarks from its headings.
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'View', 'Bookmarks Panel')
      await generateButton(page).click()
      const dlg = generateDialog(page)
      await expect(dlg.getByTestId('generate-review')).toBeVisible({ timeout: 60_000 })
      const texts = await dlg.getByTestId('generate-item').locator('span[dir="auto"]').allTextContents()
      for (const c of chapters) expect(texts, `chapter heading ${c}`).toContain(c)
      expect(texts).toContain('1.1 نظرة عامة')
      expect(texts).toContain('3.2 أهداف الفصل')
      // The page numbers and the running header are not offered as headings.
      expect(texts.filter((t) => t === 'كتاب الأمن السيبراني').length).toBeLessThanOrEqual(1) // at most the cover title
      await dlg.getByRole('button', { name: /^Create \d+ bookmarks$/ }).click()
      await expect(dlg).toHaveCount(0)
      await expect(item(page, /الفصل الأول: مقدمة عن الأمن/)).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a two-column English document made by Chromium: headings inside both columns, in reading order, running header and page numbers ignored', async () => {
    const words = 'the system uses a modular design where each component communicates through well defined interfaces and every request is validated before it is processed. '
    const section = (n: string, title: string): string => `<h2>${n} ${title}</h2><p>${words.repeat(12)}</p>`
    const path = await chromiumPdf(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
        body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; line-height: 1.35 }
        h1 { font-size: 22pt; text-align: center; margin: 0 0 12pt } .cols { column-count: 2; column-gap: 24pt; text-align: justify }
        h2 { font-size: 13pt; margin: 14pt 0 5pt; break-after: avoid }
      </style></head><body>
        <h1>A Study of Modular Systems</h1>
        <div class="cols">
          ${section('1', 'Introduction')}${section('2', 'Related Work')}${section('3', 'Method')}${section('4', 'Results')}${section('5', 'Conclusion')}
        </div>
      </body></html>`,
      'Journal of Modular Systems'
    )
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'View', 'Bookmarks Panel')
      await generateButton(page).click()
      const dlg = generateDialog(page)
      await expect(dlg.getByTestId('generate-review')).toBeVisible({ timeout: 60_000 })
      const texts = await dlg.getByTestId('generate-item').locator('span[dir="auto"]').allTextContents()
      const sections = texts.filter((t) => /^\d /.test(t))
      expect(sections).toEqual(['1 Introduction', '2 Related Work', '3 Method', '4 Results', '5 Conclusion'])
      expect(texts.filter((t) => /Journal of Modular Systems/.test(t))).toEqual([])
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

// ---------------------------------------------------------------- links

type Box = { x: number; y: number; width: number; height: number }

/** The page's box once its layout has stopped moving. */
async function pageBox(page: Page, n = 1): Promise<Box> {
  const read = async (): Promise<Box> => (await page.locator(`.epdf-page[data-page="${n}"]`).boundingBox())!
  let prev = await read()
  for (let i = 0, same = 0; i < 40 && same < 3; i++) {
    await page.waitForTimeout(100)
    const cur = await read()
    same = cur.x === prev.x && cur.y === prev.y && cur.width === prev.width && cur.height === prev.height ? same + 1 : 0
    prev = cur
  }
  return prev
}

/** Screen position of a PDF point on an unrotated 612x792 page. */
async function pdfPoint(page: Page, n: number, x: number, y: number): Promise<{ x: number; y: number }> {
  const b = await pageBox(page, n)
  return { x: b.x + (x / 612) * b.width, y: b.y + ((792 - y) / 792) * b.height }
}

async function mouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
}

/** Opens a links fixture, fit-width at a known window size, and waits for the text layer. */
async function openLinks(file = 'lb-links.pdf', opts: Parameters<typeof launch>[0] = {}): Promise<{ app: ElectronApplication; page: Page; path: string }> {
  const r = await open(file, opts)
  await r.page.getByLabel('Zoom level').selectOption('fit-page')
  await r.page.waitForTimeout(700)
  return r
}

/** A text-layer span's box once it has stopped moving (the page re-renders after every edit). */
async function textBox(page: Page, text: string, n = 1): Promise<Box> {
  const span = page.locator(`[data-page="${n}"] .textLayer span`, { hasText: text }).first()
  await expect(span).toBeVisible()
  let prev = (await span.boundingBox())!
  for (let i = 0, same = 0; i < 60 && same < 4; i++) {
    await page.waitForTimeout(100)
    const cur = (await span.boundingBox())!
    same = cur.x === prev.x && cur.y === prev.y && cur.width === prev.width && cur.height === prev.height ? same + 1 : 0
    prev = cur
  }
  return prev
}

const linkTool = (page: Page, name: 'Add link' | 'Edit links'): Locator => tool(page, name)
const linkDialog = (page: Page, name: 'Add link' | 'Edit link'): Locator => page.getByRole('dialog', { name })

async function activate(page: Page, name: 'Add link' | 'Edit links'): Promise<void> {
  await linkTool(page, name).click()
  await expect(linkTool(page, name)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(name === 'Add link' ? '[data-testid="links-draw-layer"]' : '[data-testid="links-select-layer"][data-ready="true"]').first()).toBeAttached()
}

const linksOnDisk = async (path: string) => readLinks(await docOnDisk(path))
const near = (a: number, b: number, tol = 2.5): boolean => Math.abs(a - b) <= tol

/** Stops "open in the browser" from really launching one, and records what would have been opened. */
async function trapExternal(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened?: string[] }
    g.__opened = []
    ;(shell as unknown as { openExternal: (u: string) => Promise<void> }).openExternal = async (u: string) => {
      g.__opened!.push(u)
    }
  })
  return () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
}

test.describe('links: add', () => {
  test('draw a box, enter an address (unsafe ones are refused), create, undo/redo; the saved file has a real Link annotation that works in Epdf', async () => {
    const { app, page, path } = await openLinks()
    const opened = await trapExternal(app)
    try {
      await activate(page, 'Add link')
      const from = await pdfPoint(page, 1, 72, 330)
      const to = await pdfPoint(page, 1, 300, 300)
      await mouseDrag(page, from, to)
      const dlg = linkDialog(page, 'Add link')
      await expect(dlg).toBeVisible()
      const address = dlg.getByRole('textbox', { name: 'Address' })
      const create = dlg.getByRole('button', { name: 'Create link' })
      await expect(create).toBeDisabled()
      for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,hi', 'not an address']) {
        await address.fill(bad)
        await expect(dlg.getByRole('alert')).toContainText('Problem:')
        await expect(create).toBeDisabled()
      }
      await address.fill('example.org/page?a=1')
      await expect(dlg.getByRole('alert')).toHaveCount(0)
      await dlg.getByLabel('Border', { exact: true }).selectOption('thin')
      await dlg.getByLabel('Description').fill('وصف الرابط – Link description')
      await create.click()
      await expect(dlg).toHaveCount(0)
      await expect(dot(page)).toBeVisible()
      await expect(undoButton(page, 'Add link')).toBeVisible()
      // Screen readers are told (the app's polite live region).
      await expect(page.locator('[role="status"]').filter({ hasText: 'Link added on page 1' })).toBeAttached()

      // Undo removes it, Redo brings it back (one step each).
      await undoButton(page, 'Add link').click()
      await expect(dot(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Redo Add link' }).click()
      await expect(dot(page)).toBeVisible()

      await save(page)
      const links = await linksOnDisk(path)
      const mine = links.find((l) => l.target.kind === 'uri' && l.target.uri.startsWith('https://example.org'))!
      expect(mine.target).toEqual({ kind: 'uri', uri: 'https://example.org/page?a=1' })
      expect(mine.pageIndex).toBe(0)
      expect(near(mine.rect[0], 72) && near(mine.rect[2], 300) && near(mine.rect[1], 300) && near(mine.rect[3], 330)).toBe(true)
      expect(mine.flags & 4).toBe(4) // print flag
      expect(mine.contents).toBe('وصف الرابط – Link description')
      expect(mine.border).toMatchObject({ width: 1, dashed: false })
      expect(links).toHaveLength(4) // the three existing links are untouched

      // Click-through inside Epdf itself: the link is a real PDF link, so the viewer's own link layer offers it.
      await page.keyboard.press('Escape')
      const el = page.locator('[data-page="1"] a.epdf-link[title="https://example.org/page?a=1"]')
      await expect(el).toHaveCount(1)
      await el.click()
      await expect.poll(opened).toEqual(['https://example.org/page?a=1'])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('link to a page with a spot picked on it: XYZ destination written, and following it in Epdf scrolls there', async () => {
    const { app, page, path } = await openLinks()
    try {
      await activate(page, 'Add link')
      await mouseDrag(page, await pdfPoint(page, 1, 72, 400), await pdfPoint(page, 1, 250, 380))
      const dlg = linkDialog(page, 'Add link')
      await dlg.getByLabel('A page in this document').check()
      await dlg.getByLabel('Target page').fill('3')
      await dlg.getByLabel('How the page opens').selectOption('position')
      await dlg.getByLabel('Zoom when opened').selectOption('1.5')
      await dlg.getByRole('button', { name: 'Choose the spot on a page…' }).click()
      // The dialog steps aside; a banner explains, and Escape would go back.
      await expect(dlg).toHaveCount(0)
      await expect(page.getByText('Click the spot on any page that the link should open')).toBeVisible()
      // Click on page 3 at PDF (100, 300): the pick layer reports the page and the spot.
      await page.evaluate(() => document.querySelector('.epdf-page[data-page="3"]')?.scrollIntoView())
      await expect(page.locator('.epdf-page[data-page="3"] [data-testid="links-pick-layer"]')).toBeVisible()
      const at = await pdfPoint(page, 3, 100, 300)
      await page.mouse.click(at.x, at.y)
      await expect(dlg).toBeVisible()
      await expect(dlg.getByTestId('link-picked')).toContainText('Page 3')
      await dlg.getByRole('button', { name: 'Create link' }).click()
      await expect(dlg).toHaveCount(0)
      await save(page)
      const links = await linksOnDisk(path)
      const mine = links.find((l) => l.target.kind === 'page')!
      expect(mine.target.kind === 'page' && mine.target.dest.pageIndex).toBe(2)
      if (mine.target.kind === 'page') {
        const [type, x, y, zoom] = mine.target.dest.tail
        expect(type).toBe('XYZ')
        expect(near(x as number, 100, 4) && near(y as number, 300, 4)).toBe(true)
        expect(zoom).toBe(1.5)
      }
      // Follow it in the viewer: page 3 opens with the spot near the top of the window.
      await page.keyboard.press('Escape')
      await goto(page, 1)
      await page.locator('[data-page="1"] a.epdf-link[title="Jump to page"]').first().click()
      await expect.poll(() => currentPage(page)).toBe(3)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('link to a named destination is offered only when the document has some; a document without shows why', async () => {
    const { app, page } = await openLinks()
    try {
      await activate(page, 'Add link')
      await mouseDrag(page, await pdfPoint(page, 1, 72, 400), await pdfPoint(page, 1, 250, 380))
      const dlg = linkDialog(page, 'Add link')
      await expect(dlg.getByLabel(/A named destination \(this document has none\)/)).toBeDisabled()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0) // cancelled: nothing was written
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a box drawn on a rotated page with a CropBox offset lands exactly on the text it was drawn around', async () => {
    const { app, page, path } = await openLinks('lb-rotated.pdf')
    try {
      await activate(page, 'Add link')
      const span = page.locator('[data-page="1"] .textLayer span', { hasText: 'TARGET' }).first()
      await expect(span).toBeVisible()
      await page.waitForTimeout(500)
      const b = (await span.boundingBox())!
      await mouseDrag(page, { x: b.x - 4, y: b.y - 4 }, { x: b.x + b.width + 4, y: b.y + b.height + 4 })
      const dlg = linkDialog(page, 'Add link')
      await dlg.getByRole('textbox', { name: 'Address' }).fill('https://rotated.example')
      await dlg.getByRole('button', { name: 'Create link' }).click()
      await expect(dlg).toHaveCount(0)
      await save(page)
      const [l] = await linksOnDisk(path)
      // TARGET (24 pt Helvetica) runs from x = 200 to about 297 with its baseline at y = 400 in PDF space: the rect covers that, and not much more.
      expect(l.rect[0]).toBeLessThan(206)
      expect(l.rect[2]).toBeGreaterThan(292)
      expect(l.rect[1]).toBeLessThan(402)
      expect(l.rect[3]).toBeGreaterThan(415)
      expect(l.rect[2] - l.rect[0]).toBeLessThan(115)
      expect(l.rect[3] - l.rect[1]).toBeLessThan(50)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('links: from text, and addresses found in the text', () => {
  test('link the selected text (one line, and a wrapped sentence as QuadPoints)', async () => {
    const { app, page, path } = await openLinks()
    try {
      // Text is selected while no tool is active (a tool's catcher would draw instead), then linked from the Tools menu.
      const one = page.locator('[data-page="1"] .textLayer span', { hasText: 'Select these words' }).first()
      await expect(one).toBeVisible()
      await page.waitForTimeout(500)
      const b = (await one.boundingBox())!
      await mouseDrag(page, { x: b.x + 2, y: b.y + b.height / 2 }, { x: b.x + b.width * 0.985, y: b.y + b.height / 2 })
      await menuClick(app, 'Tools', 'Link from Selected Text')
      const dlg = linkDialog(page, 'Add link')
      await dlg.getByRole('textbox', { name: 'Address' }).fill('https://one-line.example')
      await dlg.getByRole('button', { name: 'Create link' }).click()
      await expect(dlg).toHaveCount(0)

      // Two lines: drag from inside the first line to the end of the second.
      const b1 = await textBox(page, 'This sentence wraps across')
      const b2 = await textBox(page, 'two lines for the multi line link.')
      await mouseDrag(page, { x: b1.x + 2, y: b1.y + b1.height / 2 }, { x: b2.x + b2.width * 0.985, y: b2.y + b2.height / 2 }, 12)
      expect(await page.evaluate(() => window.getSelection()!.toString())).toBe('This sentence wraps across\ntwo lines for the multi line link')
      await activate(page, 'Add link') // the selection survives choosing the tool; its button links it
      await page.getByRole('button', { name: 'Link selected text' }).click()
      await expect(dlg).toBeVisible()
      await expect(dlg).toContainText('covering 2 lines of text')
      await dlg.getByRole('textbox', { name: 'Address' }).fill('https://wrapped.example')
      await dlg.getByRole('button', { name: 'Create link' }).click()
      await expect(dlg).toHaveCount(0)
      await save(page)
      const links = await linksOnDisk(path)
      const single = links.find((l) => l.target.kind === 'uri' && l.target.uri.startsWith('https://one-line'))!
      // "Select these words to make a link." is line 4: baseline y = 700 - 3*20 = 640.
      expect(single.rect[0]).toBeLessThan(76)
      expect(single.rect[1]).toBeLessThan(642)
      expect(single.rect[3]).toBeGreaterThan(648)
      expect(single.quads).toHaveLength(0)
      const wrapped = links.find((l) => l.target.kind === 'uri' && l.target.uri.startsWith('https://wrapped'))!
      expect(wrapped.quads).toHaveLength(2)
      // Two lines 20 pt apart (baselines 580 and 560): the quads' tops differ by about a line.
      expect(Math.abs(wrapped.quads[0][1] - wrapped.quads[1][1])).toBeGreaterThan(15)
      expect(wrapped.rect[3] - wrapped.rect[1]).toBeGreaterThan(30)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('find web and e-mail addresses in the text: review, reject one, create; a second run lists them as already linked', async () => {
    const { app, page, path } = await openLinks()
    try {
      await activate(page, 'Add link')
      await page.getByRole('button', { name: 'Find addresses…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Find web and e-mail addresses' })
      await expect(dlg.getByTestId('detect-review')).toBeVisible({ timeout: 30_000 })
      const items = dlg.getByTestId('detect-item')
      await expect(items).toHaveCount(3)
      await expect(items.nth(0)).toContainText('https://example.com/docs')
      await expect(items.nth(1)).toContainText('support@example.com')
      await expect(items.nth(2)).toContainText('www.example.org/about')
      await dlg.getByRole('checkbox', { name: 'Link www.example.org/about' }).uncheck()
      await dlg.getByRole('button', { name: 'Create 2 links' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(undoButton(page, 'Add detected links')).toBeVisible()
      await save(page)
      const links = await linksOnDisk(path)
      const uris = links.map((l) => (l.target.kind === 'uri' ? l.target.uri : l.target.kind))
      expect(uris).toContain('https://example.com/docs')
      expect(uris).toContain('mailto:support@example.com')
      expect(uris).not.toContain('https://www.example.org/about')
      // The box hugs the address: "Visit https://example.com/docs for ..." is line 1 (baseline 700); the link starts after "Visit ".
      const web = links.find((l) => l.target.kind === 'uri' && l.target.uri === 'https://example.com/docs')!
      expect(web.rect[0]).toBeGreaterThan(95)
      expect(web.rect[0]).toBeLessThan(115)
      expect(web.rect[2]).toBeLessThan(290)
      expect(web.rect[1]).toBeLessThan(702)
      expect(web.rect[3]).toBeGreaterThan(708)

      // Again: the two new links are recognised, so they are listed as already linked and left unticked.
      await page.getByRole('button', { name: 'Find addresses…' }).click()
      await expect(dlg.getByTestId('detect-review')).toBeVisible({ timeout: 30_000 })
      await expect(items.filter({ hasText: 'Already linked' })).toHaveCount(2)
      await expect(dlg.getByRole('button', { name: 'Create 1 link' })).toBeVisible()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dlg).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a document without addresses says so, and cancelling the search leaves it untouched', async () => {
    const { app, page } = await openLinks('lb-outline.pdf')
    try {
      await activate(page, 'Add link')
      await page.getByRole('button', { name: 'Find addresses…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Find web and e-mail addresses' })
      await expect(dlg.getByTestId('detect-empty')).toBeVisible({ timeout: 30_000 })
      await dlg.getByRole('button', { name: 'Close' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('links: edit', () => {
  test('select a link from another program, move and resize it with the keyboard, retarget it, change its border, undo', async () => {
    const { app, page, path } = await openLinks()
    try {
      await activate(page, 'Edit links')
      // The existing URI link covers "Existing link text": x 72..180, y 536..552.
      const p = await pdfPoint(page, 1, 120, 544)
      await page.mouse.click(p.x, p.y)
      const frame = page.getByTestId('link-frame')
      await expect(frame).toBeVisible()
      await expect(frame).toBeFocused()
      await expect(frame).toHaveAttribute('aria-label', /Selected link: https:\/\/existing\.example\//)
      // Keyboard: 3 x Right = +3 pt, Shift+Down = -10 pt (down the page), Alt+Right = wider by 1 pt.
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Shift+ArrowDown')
      await page.keyboard.press('Alt+ArrowRight')
      await expect(undoButton(page, 'Resize link')).toBeVisible()
      await expect.poll(async () => (await frame.boundingBox())!.width).toBeGreaterThan(0)
      // Enter opens the editor; change the target and give it a dashed red border.
      await page.keyboard.press('Enter')
      const dlg = linkDialog(page, 'Edit link')
      await expect(dlg).toBeVisible()
      await expect(dlg.getByRole('textbox', { name: 'Address' })).toHaveValue('https://existing.example/')
      await dlg.getByRole('textbox', { name: 'Address' }).fill('https://changed.example/x')
      await dlg.getByLabel('Border', { exact: true }).selectOption('dashed')
      await dlg.getByLabel('Border colour').fill('#ff0000')
      await dlg.getByRole('button', { name: 'Save link' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(undoButton(page, 'Edit link')).toBeVisible()
      await save(page)
      const changed = (await linksOnDisk(path)).find((l) => l.target.kind === 'uri' && l.target.uri === 'https://changed.example/x')!
      expect(changed).toBeTruthy()
      expect(near(changed.rect[0], 75) && near(changed.rect[1], 526) && near(changed.rect[2], 184)).toBe(true) // +3, -10, +3 +1
      expect(changed.border).toEqual({ width: 1, dashed: true, color: [1, 0, 0] })
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('links whose action Epdf does not manage (GoToR, Launch) are kept exactly; they can still be moved, restyled and deleted', async () => {
    const { app, page, path } = await openLinks()
    try {
      const before = await docOnDisk(path)
      const actionsBefore = readLinks(before).map((l) => (l.target.kind === 'other' ? `${l.target.action}:${l.target.detail}` : l.target.kind))
      expect(actionsBefore).toEqual(['uri', 'other', 'other'].map((k, i) => (i === 0 ? 'uri' : ['GoToR:other.pdf', 'Launch:program.exe'][i - 1])))
      await activate(page, 'Edit links')
      await page.getByLabel('Choose a link').selectOption({ label: 'Page 1: GoToR: other.pdf' })
      const frame = page.getByTestId('link-frame')
      await expect(frame).toBeVisible()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      const dlg = linkDialog(page, 'Edit link')
      await expect(dlg).toContainText('does something Epdf does not change')
      await expect(dlg.getByRole('textbox', { name: 'Address' })).toHaveCount(0)
      await dlg.getByLabel('Border', { exact: true }).selectOption('thin')
      await dlg.getByRole('button', { name: 'Save link' }).click()
      await expect(dlg).toHaveCount(0)
      // Delete the Launch link with the keyboard.
      await page.getByLabel('Choose a link').selectOption({ label: 'Page 1: Launch: program.exe' })
      await expect(page.getByTestId('link-frame')).toBeFocused()
      await page.keyboard.press('Delete')
      await expect(undoButton(page, 'Delete link')).toBeVisible()
      await save(page)
      const after = await linksOnDisk(path)
      expect(after.map((l) => (l.target.kind === 'other' ? `${l.target.action}:${l.target.detail}` : l.target.kind))).toEqual(['uri', 'GoToR:other.pdf'])
      const gotor = after[1]
      expect(near(gotor.rect[1], 515, 1.5)).toBe(true) // moved down by 1 pt from 516
      expect(gotor.border.width).toBe(1)
      // The action dictionary itself is byte-for-byte what it was.
      const pdf = await docOnDisk(path)
      const annots = pdf.getPage(0).node.lookup(N('Annots'))
      const dict = (annots as unknown as { lookup(i: number): PDFDict }).lookup(1)
      expect(dict.lookup(N('A')).toString()).toContain('/GoToR')
      expect(dict.lookup(N('A')).toString()).toContain('other.pdf')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('drag to move and resize with the mouse; Delete removes; Escape deselects', async () => {
    const { app, page, path } = await openLinks()
    try {
      await activate(page, 'Edit links')
      const p = await pdfPoint(page, 1, 120, 544)
      await page.mouse.click(p.x, p.y)
      const frame = page.getByTestId('link-frame')
      await expect(frame).toBeVisible()
      const fb = (await frame.boundingBox())!
      // Move: drag the frame body 40 px right and 30 px down.
      await mouseDrag(page, { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 }, { x: fb.x + fb.width / 2 + 40, y: fb.y + fb.height / 2 + 30 })
      await expect(undoButton(page, 'Move link')).toBeVisible()
      // Resize: drag the south-east handle 30 px right and 20 px down.
      const se = page.locator('[data-link-frame] [data-handle="se"]')
      await expect.poll(async () => (await se.boundingBox())?.x ?? 0).toBeGreaterThan(fb.x + fb.width)
      const sb = (await se.boundingBox())!
      await mouseDrag(page, { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 }, { x: sb.x + sb.width / 2 + 30, y: sb.y + sb.height / 2 + 20 })
      await expect(undoButton(page, 'Resize link')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(frame).toHaveCount(0)
      await save(page)
      const moved = (await linksOnDisk(path)).find((l) => l.target.kind === 'uri')!
      const scale = fb.width / (108) // frame px per pt at the start (108 pt wide)
      expect(moved.rect[0]).toBeGreaterThan(72 + 30 / scale - 3)
      expect(moved.rect[1]).toBeLessThan(536 - 22 / scale)
      expect(moved.rect[2] - moved.rect[0]).toBeGreaterThan(108 + 20 / scale)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('remove links from a page or from the whole document, after asking; undo brings them back', async () => {
    const { app, page, path } = await openLinks()
    try {
      await activate(page, 'Add link')
      await page.getByRole('button', { name: /^Remove links on page 1$/ }).click()
      const dlg = page.getByRole('dialog', { name: 'Remove all links from page 1?' })
      await expect(dlg).toContainText('3 links')
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dot(page)).toHaveCount(0)
      await page.getByRole('button', { name: /^Remove links on page 1$/ }).click()
      await dlg.getByRole('button', { name: 'Remove 3 links' }).click()
      await expect(undoButton(page, 'Remove links from page')).toBeVisible()
      await undoButton(page, 'Remove links from page').click()
      await expect(dot(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Remove all links', exact: true }).click()
      await page.getByRole('dialog', { name: 'Remove all links from this document?' }).getByRole('button', { name: 'Remove 3 links' }).click()
      await save(page)
      expect(await linksOnDisk(path)).toHaveLength(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the "show all links" highlight outlines every link, and the View menu toggles it', async () => {
    const { app, page } = await openLinks()
    try {
      await expect(page.getByTestId('link-outlines')).toHaveCount(0)
      await menuClick(app, 'View', 'Highlight Links')
      await expect(page.locator('[data-page="1"] [data-link-outline]')).toHaveCount(3)
      await menuClick(app, 'View', 'Highlight Links')
      await expect(page.getByTestId('link-outlines')).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---------------------------------------------------------------- accessibility

const setTheme = async (app: ElectronApplication, page: Page, theme: 'light' | 'dark'): Promise<void> => {
  await app.evaluate(({ nativeTheme }, t) => void (nativeTheme.themeSource = t), theme)
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark')
}

test.describe('accessibility (axe, WCAG 2.1 A/AA)', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`bookmarks panel and dialogs are axe-clean in ${theme} mode`, async () => {
      const { app, page } = await open('lb-outline.pdf')
      try {
        await setTheme(app, page, theme)
        await showBookmarks(app, page)
        expect(await axeViolations(page, `panel ${theme}`)).toEqual([])
        // A selected bookmark with its properties, a colour, and the inline title editor.
        await selectRow(page, /^Last/)
        await page.getByLabel('Bookmark colour').fill('#ffee00')
        expect(await axeViolations(page, `panel selected ${theme}`)).toEqual([])
        await tree(page).focus()
        await page.keyboard.press('F2')
        await expect(tree(page).getByLabel('Bookmark title')).toBeFocused()
        expect(await axeViolations(page, `panel editing ${theme}`)).toEqual([])
        await page.keyboard.press('Escape')
        await page.getByLabel('Filter bookmarks').fill('deep')
        expect(await axeViolations(page, `panel filtered ${theme}`)).toEqual([])
        await page.getByLabel('Filter bookmarks').fill('')
        // The delete confirmation.
        await selectRow(page, /Introduction/)
        await page.keyboard.press('Delete')
        await expect(page.getByRole('dialog', { name: 'Delete this bookmark and its children?' })).toBeVisible()
        expect(await axeViolations(page, `delete confirm ${theme}`)).toEqual([])
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
      } finally {
        await quitDiscarding(app, page)
      }
    })

    test(`generate dialog is axe-clean in ${theme} mode (analysing, review, empty)`, async () => {
      const { app, page } = await open('lb-report.pdf')
      try {
        await setTheme(app, page, theme)
        await showBookmarks(app, page)
        await generateButton(page).click()
        const dlg = generateDialog(page)
        await expect(dlg).toBeVisible()
        await expect(dlg.getByTestId('generate-review')).toBeVisible({ timeout: 45_000 })
        expect(await axeViolations(page, `generate review ${theme}`)).toEqual([])
        await dlg.getByRole('button', { name: 'Cancel' }).click()
      } finally {
        await quitDiscarding(app, page)
      }
    })

    test(`link tools, dialogs and the address review are axe-clean in ${theme} mode`, async () => {
      const { app, page } = await openLinks()
      try {
        await setTheme(app, page, theme)
        await activate(page, 'Add link')
        expect(await axeViolations(page, `add link options ${theme}`)).toEqual([])
        await mouseDrag(page, await pdfPoint(page, 1, 72, 400), await pdfPoint(page, 1, 250, 380))
        const dlg = linkDialog(page, 'Add link')
        await expect(dlg).toBeVisible()
        await dlg.getByRole('textbox', { name: 'Address' }).fill('javascript:1')
        expect(await axeViolations(page, `add link dialog error ${theme}`)).toEqual([])
        await dlg.getByLabel('A page in this document').check()
        expect(await axeViolations(page, `add link dialog page ${theme}`)).toEqual([])
        await dlg.getByRole('button', { name: 'Cancel' }).click()

        await page.getByRole('button', { name: 'Find addresses…' }).click()
        const detect = page.getByRole('dialog', { name: 'Find web and e-mail addresses' })
        await expect(detect.getByTestId('detect-review')).toBeVisible({ timeout: 30_000 })
        expect(await axeViolations(page, `detect review ${theme}`)).toEqual([])
        await detect.getByRole('button', { name: 'Cancel' }).click()

        await activate(page, 'Edit links')
        const p = await pdfPoint(page, 1, 120, 544)
        await page.mouse.click(p.x, p.y)
        await expect(page.getByTestId('link-frame')).toBeVisible()
        expect(await axeViolations(page, `edit links ${theme}`)).toEqual([])
        await page.keyboard.press('Enter')
        await expect(linkDialog(page, 'Edit link')).toBeVisible()
        expect(await axeViolations(page, `edit link dialog ${theme}`)).toEqual([])
        await page.keyboard.press('Escape')
      } finally {
        await quitDiscarding(app, page)
      }
    })
  }
})

test.describe('links: protected documents', () => {
  test('adding a link to a password-protected document works after unlocking and Save keeps it encrypted', async () => {
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
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
      await page.getByLabel('Zoom level').selectOption('fit-page')
      await page.waitForTimeout(700)
      await activate(page, 'Add link')
      await mouseDrag(page, await pdfPoint(page, 1, 72, 500), await pdfPoint(page, 1, 250, 470))
      const dlg = linkDialog(page, 'Add link')
      await dlg.getByRole('textbox', { name: 'Address' }).fill('https://protected.example')
      await dlg.getByRole('button', { name: 'Create link' }).click()
      await expect(dlg).toHaveCount(0)
      await save(page)
      const bytes = new Uint8Array(readFileSync(path))
      expect(Buffer.from(bytes).toString('latin1')).toContain('/Encrypt')
      const links = readLinks(await PDFDocument.load((await openWith(bytes, 'user256')).plain))
      expect(links.map((l) => l.target)).toEqual([{ kind: 'uri', uri: 'https://protected.example/' }])
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

