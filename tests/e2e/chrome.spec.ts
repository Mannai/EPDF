import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { fixture, launch, menuClick, windowsHitTest } from './helpers'

// The Windows title bar is drawn by the app and is a window-drag area, with Windows' own caption buttons over its right
// end. Real clicks there never reach the page, which Playwright's clicks (sent straight into the page) can't notice.
// These tests ask Windows what a real click on every control would do.
// Regression: the Library covered the title bar, so its search box dragged the window and its Settings and Close
// buttons sat under the minimise and maximise buttons: users were stuck in it.
test.describe('Windows title bar: every control can really be clicked', () => {
  test.skip(process.platform !== 'win32', 'the custom title bar is Windows only')

  const CONTROLS = 'button, input, select, textarea, [role="tab"]'
  const blocked = async (app: ElectronApplication, page: Page, scope: string): Promise<string[]> =>
    (await windowsHitTest(app, page, `${scope} :is(${CONTROLS})`)).filter((r) => r.hit !== 'client').map((r) => `${r.name}: ${r.hit}`)

  test('title bar, ribbon and status bar controls reach the app; the empty title bar drags the window', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 60, y: 60, width: 1200, height: 800 }))
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      expect(await blocked(app, page, '#root')).toEqual([])
      // An empty stretch of the title bar (right of the search box, left of the caption buttons) moves the window.
      await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.id = 'drag-probe'
        probe.setAttribute('data-hit-probe', '')
        probe.style.cssText = 'position:fixed;top:12px;right:160px;width:4px;height:4px;pointer-events:none'
        document.body.append(probe)
      })
      expect((await windowsHitTest(app, page, '#drag-probe'))[0]?.hit).toBe('drag')
    } finally {
      await app.close()
    }
  })

  test('the Library, a dialog and the scanner keep all their controls clickable', async () => {
    const { app, page } = await launch({ files: [fixture('sample.pdf')] })
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 60, y: 60, width: 1100, height: 700 }))
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()

      await menuClick(app, 'File', 'Library…')
      await expect(page.getByTestId('library')).toBeVisible()
      expect(await blocked(app, page, '[data-testid="library"]')).toEqual([])
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('library')).toHaveCount(0)

      await menuClick(app, 'File', 'Combine Files…')
      const dlg = page.getByRole('dialog', { name: 'Combine files' })
      await expect(dlg).toBeVisible()
      expect(await blocked(app, page, '[role="dialog"]')).toEqual([])
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)

      await menuClick(app, 'File', 'Scan to PDF…')
      const scan = page.getByTestId('scan-dialog')
      await expect(scan).toBeVisible()
      expect(await blocked(app, page, '[data-testid="scan-dialog"]')).toEqual([])
      await page.keyboard.press('Escape')
    } finally {
      await app.close()
    }
  })
})
