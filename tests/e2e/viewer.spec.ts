import { expect, test } from '@playwright/test'
import { canvasHasInk, currentPage, fixture, gotoPage, launch } from './helpers'

test.describe('viewer', () => {
  test('opens a PDF passed on the command line and renders canvas + text layer', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await expect(page.getByRole('toolbar').getByText('/ 5')).toBeVisible()
      await expect(page.locator('.epdf-page canvas').first()).toBeVisible()
      await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas')).toBe(true)
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Epdf sample page 1')
      await expect(page).toHaveTitle(/sample\.pdf/)
    } finally {
      await app.close()
    }
  })

  test('navigates with the page box and thumbnails', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await gotoPage(page, 3)
      await expect.poll(() => currentPage(page)).toBe('3')
      await expect(page.locator('[data-page="3"] .textLayer')).toContainText('Epdf sample page 3')
      // Thumbnail for the current page is marked, and clicking another one navigates.
      await expect(page.getByRole('button', { name: 'Go to page 3' })).toHaveAttribute('aria-current', 'page')
      await page.getByRole('button', { name: 'Go to page 5' }).click()
      await expect.poll(() => currentPage(page)).toBe('5')
      await expect(page.locator('[data-page="5"] .textLayer')).toContainText('Epdf sample page 5')
    } finally {
      await app.close()
    }
  })

  test('zoom changes the rendered page size and fit-width fills the viewport', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const zoom = page.getByLabel('Zoom level')
      await zoom.selectOption('100')
      const w100 = (await page.locator('[data-page="1"]').boundingBox())!.width
      expect(w100).toBeCloseTo(612 * (96 / 72), 0)
      await zoom.selectOption('200')
      await expect.poll(async () => (await page.locator('[data-page="1"]').boundingBox())!.width).toBeCloseTo(w100 * 2, 0)
      // Re-rendered sharply at the new scale (canvas backing store grew).
      await expect.poll(() => page.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-page="1"] canvas')!.width)).toBeGreaterThan(w100 * 1.9)

      await zoom.selectOption('fit-width')
      const scroller = await page.getByTestId('viewer-scroll').boundingBox()
      const pw = (await page.locator('[data-page="1"]').boundingBox())!.width
      expect(pw).toBeGreaterThan(scroller!.width * 0.85)
      expect(pw).toBeLessThanOrEqual(scroller!.width)
    } finally {
      await app.close()
    }
  })

  test('single, two-page and continuous layouts', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await page.getByRole('button', { name: 'Two-page spread' }).click()
      await expect(page.locator('[data-page="2"]')).toBeVisible()
      const a = (await page.locator('[data-page="1"]').boundingBox())!
      const b = (await page.locator('[data-page="2"]').boundingBox())!
      expect(Math.abs(a.y - b.y)).toBeLessThan(2)
      expect(b.x).toBeGreaterThan(a.x + a.width - 1)

      await page.getByRole('button', { name: 'Single page' }).click()
      await gotoPage(page, 4)
      await expect(page.locator('[data-page="4"]')).toBeVisible()
      await expect(page.locator('[data-page="3"]')).toHaveCount(0)
      await expect(page.locator('[data-page="5"]')).toHaveCount(0)
      await page.getByRole('button', { name: 'Next page' }).click()
      await expect(page.locator('[data-page="5"]')).toBeVisible()

      await page.getByRole('button', { name: 'Continuous scroll' }).click()
      await expect(page.getByRole('button', { name: 'Continuous scroll' })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('[data-page="5"] .textLayer')).toContainText('page 5')
    } finally {
      await app.close()
    }
  })

  test('full-text search highlights hits and steps across pages', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await page.getByRole('button', { name: 'Find in document' }).click()
      await page.getByLabel('Find text').fill('needle')
      await expect(page.getByRole('search').getByRole('status')).toHaveText('1 of 3')
      await expect(page.locator('[data-page="3"] .epdf-hit')).toHaveCount(2)
      await expect(page.locator('.epdf-hit-active')).toHaveCount(1)
      await expect(page.locator('.epdf-hit-active')).toBeInViewport()

      await page.getByLabel('Find text').press('Enter')
      await expect(page.getByRole('search').getByRole('status')).toHaveText('2 of 3')
      await page.getByLabel('Find text').press('Enter')
      await expect(page.getByRole('search').getByRole('status')).toHaveText('3 of 3')
      await expect(page.locator('[data-page="5"] .epdf-hit-active')).toBeInViewport()
      await page.getByLabel('Find text').press('Enter') // wraps
      await expect(page.getByRole('search').getByRole('status')).toHaveText('1 of 3')
      await page.getByLabel('Find text').press('Shift+Enter')
      await expect(page.getByRole('search').getByRole('status')).toHaveText('3 of 3')

      // Options and the empty case.
      // A new query starts from the page being viewed (5), so the first hit at/after it is #3.
      await page.getByLabel('Find text').fill('NEEDLE')
      await expect(page.getByRole('search').getByRole('status')).toHaveText('3 of 3')
      await page.getByRole('button', { name: 'Match case' }).click()
      await expect(page.getByRole('search').getByRole('status')).toHaveText('No results')
      await page.getByRole('button', { name: 'Match case' }).click()
      await page.getByLabel('Find text').fill('zzzzqqq')
      await expect(page.getByRole('search').getByRole('status')).toHaveText('No results')

      // Escape closes and removes highlights.
      await page.getByLabel('Find text').press('Escape')
      await expect(page.getByRole('search')).toHaveCount(0)
      await expect(page.locator('.epdf-hit')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('internal links navigate', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await page.locator('[data-page="1"] a.epdf-link').first().click()
      await expect.poll(() => currentPage(page)).toBe('4')
    } finally {
      await app.close()
    }
  })

  test('handles pages of different sizes and orientations', async () => {
    const { app, page } = await launch({ files: [fixture('mixed.pdf')] })
    try {
      await expect(page.getByRole('toolbar').getByText('/ 4')).toBeVisible()
      await page.getByLabel('Zoom level').selectOption('100')
      await gotoPage(page, 2)
      const landscape = (await page.locator('[data-page="2"]').boundingBox())!
      expect(landscape.width).toBeGreaterThan(landscape.height)
      await gotoPage(page, 3)
      const small = (await page.locator('[data-page="3"]').boundingBox())!
      expect(small.width).toBeCloseTo(300 * (96 / 72), 0)
    } finally {
      await app.close()
    }
  })

  test('500-page document: lazy rendering, virtualized DOM, fast first paint', async () => {
    const t0 = Date.now()
    const { app, page } = await launch({ files: [fixture('large.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas')).toBe(true)
      const firstPaintMs = Date.now() - t0
      console.log(`large.pdf: launch → first page painted in ${firstPaintMs} ms`)
      expect(firstPaintMs).toBeLessThan(6000) // generous CI bound; the target (<3s) is logged above

      await expect(page.getByRole('toolbar').getByText('/ 500')).toBeVisible()
      const mounted = () => page.locator('.epdf-page').count()
      expect(await mounted()).toBeLessThan(15)

      await gotoPage(page, 400)
      await expect(page.locator('[data-page="400"] canvas')).toBeVisible()
      await expect(page.locator('[data-page="400"] .textLayer')).toContainText('Large document page 400')
      expect(await mounted()).toBeLessThan(15)
      await expect(page.locator('[data-page="1"]')).toHaveCount(0)

      // End / Home keys inside the viewer.
      await page.getByTestId('viewer-scroll').focus()
      await page.keyboard.press('End')
      await expect.poll(() => currentPage(page)).toBe('500')
      await page.keyboard.press('Home')
      await expect.poll(() => currentPage(page)).toBe('1')
    } finally {
      await app.close()
    }
  })
})

