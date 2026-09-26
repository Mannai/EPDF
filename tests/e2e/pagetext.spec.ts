import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { canvasHasInk, launch, quitDiscarding } from './helpers'

const FIXTURES = resolve('tests/fixtures/pagetext')

function copy(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'epdf-pagetext-'))
  const dest = join(dir, name)
  copyFileSync(join(FIXTURES, name), dest)
  return dest
}

async function waitModelLayer(page: Page, pageNo = 1): Promise<void> {
  await expect.poll(() => canvasHasInk(page, `[data-page="${pageNo}"] canvas`), { timeout: 30_000 }).toBe(true)
  await page.locator(`[data-page="${pageNo}"] .textLayer[data-pagetext="model"]`).waitFor({ timeout: 30_000 })
}

test('explore: LibreOffice Arabic lines in the text layer', async () => {
  const { app, page } = await launch({ files: [copy('lo-lines.pdf')] })
  try {
    await waitModelLayer(page)
    const sel = await page.evaluate(() => {
      const el = document.querySelector('[data-page="1"] .textLayer')!
      const range = document.createRange()
      range.selectNodeContents(el)
      const s = getSelection()!
      s.removeAllRanges()
      s.addRange(range)
      return s.toString()
    })
    console.log(sel)
    await page.addStyleTag({ content: '.textLayer span { color: rgba(255,0,0,0.55) !important; outline: 1px solid rgba(0,0,255,0.4) }' })
    await page.evaluate(() => getSelection()!.removeAllRanges())
    await page.locator('[data-page="1"]').screenshot({ path: 'test-results/pagetext/explore.png' })
  } finally {
    await quitDiscarding(app, page)
  }
})
