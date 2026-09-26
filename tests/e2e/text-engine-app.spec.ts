import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canvasHasInk, launch } from './helpers'

/**
 * The text engine inside the REAL app: the engine runs in the sandboxed renderer (WebAssembly under the CSP, resources over
 * the `text:resource` channel), writes a PDF with Arabic and mixed-direction text, and the app then opens that PDF: it
 * renders, its text layer holds the logical text, the app's own full-text search finds Arabic words, and selecting the text
 * layer (what copy does) returns the logical string.
 */

const ARABIC = 'مرحبا بالعالم. هذا اختبار للكتابة العربية داخل ملفات PDF، مع أرقام ١٢٣ و 456 وكلمة English في الوسط، ثم (قوس) وجملة أخيرة.'
const HEBREW = 'שלום עולם, זהו טקסט בעברית עם מספרים 123.'
const TEXT = `${ARABIC}\n${HEBREW}\nनमस्ते दुनिया — 你好世界 — สวัสดี`

const norm = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim()

test.describe('text engine in the app', () => {
  test('the renderer writes an Arabic PDF and the app renders, searches and selects it in logical order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-text-app-'))
    const path = join(dir, 'arabic.pdf')

    // 1) Write the PDF from inside the sandboxed renderer.
    const first = await launch({ files: [] })
    try {
      await first.page.waitForFunction(() => !!window.__epdfTextEngine, undefined, { timeout: 30_000 })
      const r = await first.page.evaluate((t) => window.__epdfTextEngine!.selfTest(t, { width: 340, size: 15 }), TEXT)
      expect(r.missing).toEqual([])
      expect(r.lines).toBeGreaterThan(4)
      expect(r.fonts.join(' ')).toMatch(/Arabic|Naskh/)
      writeFileSync(path, Buffer.from(r.pdf, 'base64'))
    } finally {
      await first.app.close()
    }

    // 2) Open it in the app.
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.getByRole('tab', { name: /arabic\.pdf/ })).toBeVisible()
      await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas')).toBe(true)
      await page.locator('[data-page="1"] canvas').screenshot({ path: 'test-results/text/app-page1.png' }) // for humans
      const layer = page.locator('[data-page="1"] .textLayer')
      await expect(layer).toContainText('مرحبا بالعالم')
      await expect(layer).toContainText('שלום עולם')
      await expect(layer).toContainText('你好世界')

      // Selecting the text layer is what copy reads.
      const selected = await page.evaluate(() => {
        const el = document.querySelector('[data-page="1"] .textLayer')!
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = getSelection()!
        sel.removeAllRanges()
        sel.addRange(range)
        return sel.toString()
      })
      expect(norm(selected)).toContain(norm('مرحبا بالعالم'))
      expect(norm(selected)).toContain(norm('שלום עולם, זהו טקסט בעברית'))
      expect(norm(selected)).toContain(norm('द'.length ? 'नमस्ते दुनिया' : ''))

      // The app's own full-text search: an Arabic word, a phrase across two words and Hebrew.
      await page.getByRole('button', { name: 'Find in document' }).click()
      const find = page.getByLabel('Find text')
      await find.fill('بالعالم')
      await expect(page.getByRole('search').getByRole('status')).toHaveText(/1 of 1/)
      await expect(page.locator('[data-page="1"] .epdf-hit')).toHaveCount(1)
      await find.fill('العربية داخل ملفات')
      await expect(page.getByRole('search').getByRole('status')).toHaveText(/1 of 1/)
      await find.fill('עולם')
      await expect(page.getByRole('search').getByRole('status')).toHaveText(/1 of 1/)
      await find.fill('بالعالم البعيد')
      await expect(page.getByRole('search').getByRole('status')).toHaveText('No results')
    } finally {
      await app.close()
    }
  })
})
