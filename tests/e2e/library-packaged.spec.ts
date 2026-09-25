import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { menuClick } from './helpers'
import { makeCjkPdf, makeTextPdf } from '../support/libraryFixtures'

// Runs against a real packaged build:  EPDF_PACKAGED_EXE=dist/win-unpacked/Epdf.exe npx playwright test library-packaged
// (the index worker and the pdf.js fonts/CMaps are read from inside app.asar there)
const exe = process.env['EPDF_PACKAGED_EXE']

test.describe('library in a packaged build', () => {
  test.skip(!exe, 'set EPDF_PACKAGED_EXE to the packaged executable to run this')

  test('indexes a folder in the worker thread and finds text inside the files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-libpkg-'))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'a.pdf'), await makeTextPdf(['Packaged build text zeppelin', 'second page']))
    writeFileSync(join(dir, 'sub', 'b.pdf'), await makeCjkPdf(['日本語のテスト']))
    const userData = mkdtempSync(join(tmpdir(), 'epdf-libpkg-ud-'))
    const app = await electron.launch({
      executablePath: exe!,
      args: [],
      env: { ...process.env, EPDF_USER_DATA: userData, ELECTRON_RENDERER_URL: '', EPDF_LIBRARY_PICK_FOLDER: dir } as Record<string, string>
    })
    try {
      const page = await app.firstWindow()
      await expect(page.getByRole('heading', { name: 'Epdf' })).toBeVisible()
      await menuClick(app, 'File', 'Library…')
      const library = page.getByRole('dialog', { name: 'Library' })
      await expect(library).toBeVisible()
      await library.getByRole('button', { name: 'Add folder…' }).first().click()
      await expect(library.getByTestId('library-counts')).toContainText('2 of 2 files searchable', { timeout: 60_000 })
      await library.getByText('Text inside files', { exact: true }).click()
      const box = library.getByRole('textbox', { name: 'Search text inside files' })
      await box.fill('zeppelin')
      await expect(library.getByRole('listbox', { name: 'Search results' }).getByRole('option')).toHaveCount(1)
      await box.fill('日本語')
      await expect(library.getByRole('listbox', { name: 'Search results' }).getByRole('option')).toHaveCount(1)
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
