import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canvasHasInk, currentPage, fixture, gotoPage } from './helpers'

// Runs against a real packaged build:  EPDF_PACKAGED_EXE=dist/win-unpacked/Epdf.exe npx playwright test packaged
const exe = process.env['EPDF_PACKAGED_EXE']

test.describe('packaged build', () => {
  test.skip(!exe, 'set EPDF_PACKAGED_EXE to the packaged executable to run this')

  test('launches from an asar, opens a PDF, persists via SQLite, and restores the session', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'epdf-pkg-'))
    const env = { ...process.env, EPDF_USER_DATA: userData, ELECTRON_RENDERER_URL: '' } as Record<string, string>

    const first = await electron.launch({ executablePath: exe!, args: [fixture('sample.pdf')], env })
    const isPackaged = await first.evaluate(({ app }) => app.isPackaged)
    expect(isPackaged).toBe(true)
    const page = await first.firstWindow()
    await expect(page.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
    await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas')).toBe(true)
    await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Epdf sample page 1')
    await gotoPage(page, 4)
    await expect.poll(() => currentPage(page)).toBe('4')
    await page.waitForTimeout(1000)
    await first.close()

    const second = await electron.launch({ executablePath: exe!, args: [], env })
    try {
      const p2 = await second.firstWindow()
      await expect(p2.getByRole('tab', { name: /sample\.pdf/ })).toBeVisible()
      await expect.poll(() => currentPage(p2)).toBe('4')
    } finally {
      await second.close()
    }
  })
})
