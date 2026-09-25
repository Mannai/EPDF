import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readPdf, flattenText } from '../support/pdfText'
import { copyFixture, FIX, menuClick } from './helpers'

// Runs against a real packaged build (asar, unpacked worker/WASM, extraResources):
//   npx electron-builder --win --dir --publish never
//   $env:EPDF_PACKAGED_EXE = 'dist\win-unpacked\Epdf.exe'; npx playwright test tests/e2e/ocr-packaged.spec.ts
const exe = process.env['EPDF_PACKAGED_EXE']

test.describe('OCR in a packaged build', () => {
  test.skip(!exe, 'set EPDF_PACKAGED_EXE to the packaged executable to run this')
  test.setTimeout(240_000)

  test.beforeAll(() => {
    execFileSync(process.execPath, ['tests/fixtures/ocr.mjs', FIX], { stdio: 'inherit' })
  })

  test('recognizes text with the engine, WebAssembly core and English data shipped inside the app (offline)', async () => {
    const resources = join(dirname(exe!), 'resources')
    // what the installer ships
    expect(existsSync(join(resources, 'ocr', 'eng.traineddata'))).toBe(true)
    expect(existsSync(join(resources, 'ocr', 'LICENSE-tessdata_fast.txt'))).toBe(true)
    const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')
    expect(existsSync(join(unpacked, 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'))).toBe(true)
    expect(existsSync(join(unpacked, 'tesseract.js-core', 'tesseract-core-lstm.wasm'))).toBe(true)
    // the unused engines (legacy models, browser-only copies) are not shipped
    expect(existsSync(join(unpacked, 'tesseract.js-core', 'tesseract-core.wasm'))).toBe(false)
    expect(existsSync(join(unpacked, 'tesseract.js-core', 'tesseract-core-lstm.wasm.js'))).toBe(false)

    const path = copyFixture('scan1.pdf')
    const userData = mkdtempSync(join(tmpdir(), 'epdf-pkg-ocr-'))
    const env = { ...process.env, EPDF_USER_DATA: userData, ELECTRON_RENDERER_URL: '', EPDF_OCR_WORKERS: '2' } as Record<string, string>
    const app = await electron.launch({ executablePath: exe!, args: [path], env })
    try {
      expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(true)
      const page = await app.firstWindow()
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Tools', 'Recognize Text (OCR)…')
      const dlg = page.getByRole('dialog', { name: 'Recognize text (OCR)' })
      await expect(dlg.locator('[data-lang="eng"]')).toContainText('Built in')
      await dlg.getByRole('button', { name: /^Recognize/ }).click()
      await expect(page.getByRole('status').filter({ hasText: /Recognized 1 page, \d+ words/ })).toBeVisible({ timeout: 120_000 })
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Invoice', { timeout: 30_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      const read = await readPdf(new Uint8Array(readFileSync(path)))
      expect(flattenText(read.pages).toLowerCase()).toContain('invoice number 48213')
    } finally {
      const closing = app.close().catch(() => undefined)
      await closing
    }
  })
})
