import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { axeViolations, canvasHasInk, clickTool, launch, quitDiscarding } from './helpers'
import { norm, pageModel } from '../support/retrofit'

/**
 * Editing EXISTING Arabic / Hebrew text in the real app (docs/features/edit-content.md, "Right-to-left and
 * complex-script text"): the Edit text tool offers each right-to-left line as the text a person reads, the editor is
 * right-to-left and anchored at the line's right edge, a commit is one undo step, and the saved file reads back in
 * logical order with the page text model (PDF.js cannot read these producers' Arabic in order).
 */

const FIXTURES = resolve('tests/fixtures/pagetext')
const corpus = JSON.parse(readFileSync(join(FIXTURES, 'corpus.json'), 'utf8')) as {
  lines: { id: string; dir: string; text: string }[]
  paragraphs: { id: string; text: string }[]
}
const line = (id: string): string => corpus.lines.find((l) => l.id === id)!.text

function copy(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'epdf-rtl-edit-'))
  const dest = join(dir, name)
  copyFileSync(join(FIXTURES, name), dest)
  return dest
}

const pageEl = (page: Page, n = 1): Locator => page.locator(`[data-page="${n}"]`)
const toast = (page: Page, text: string | RegExp): Locator => page.locator('[role="status"], [role="alert"]').filter({ hasText: text }).first()
const block = (page: Page, text: string, kind = 'text'): Locator => pageEl(page).getByRole('button', { name: `Edit ${kind}: ${norm(text).slice(0, 67)}`, exact: text.length <= 70 })

async function open(name: string): Promise<{ path: string; app: ElectronApplication; page: Page }> {
  const path = copy(name)
  const { app, page } = await launch({ files: [path] })
  await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas'), { timeout: 30_000 }).toBe(true)
  return { path, app, page }
}

/** Lines of page 1's logical text layer (the page text model the viewer builds for right-to-left pages). */
const layerText = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const out: string[] = []
    for (const s of document.querySelectorAll<HTMLElement>('[data-page="1"] .textLayer[data-pagetext="model"] span[data-line]')) {
      const i = Number(s.dataset.line)
      out[i] = (out[i] ?? '') + (s.textContent ?? '')
    }
    return out.join('\n')
  })

async function savedLines(path: string): Promise<string[]> {
  return (await pageModel(new Uint8Array(readFileSync(path)))).text.split('\n').map(norm)
}

test.describe('edit existing right-to-left text', () => {
  test('LibreOffice Arabic line: logical text in a right-to-left editor, one undo step, saved file reads back', async () => {
    const { path, app, page } = await open('lo-lines.pdf')
    try {
      await clickTool(page, 'edit-text')
      const hello = line('ar-hello')
      const b = block(page, hello)
      await expect(b).toBeVisible()
      const box = (await b.boundingBox())!
      await b.click()
      const editor = page.getByTestId('textedit-editor')
      await expect(editor).toBeVisible()
      await expect(editor).toHaveValue(hello)
      await expect(editor).toHaveAttribute('dir', 'rtl')
      // anchored at the line's right edge, like the text it replaces
      const eb = (await editor.boundingBox())!
      expect(Math.abs(eb.x + eb.width - (box.x + box.width))).toBeLessThan(8)
      expect(await axeViolations(page, 'rtl editor')).toEqual([])

      await editor.fill('مرحبا يا عالم جميل')
      await editor.press('Enter')
      await expect(toast(page, /Font not available in this PDF — used Noto Naskh Arabic \(the document’s font/)).toBeVisible()
      await expect(page.getByTestId('textedit-editor')).toHaveCount(0)
      await expect.poll(() => layerText(page).then(norm), { timeout: 30_000 }).toContain('مرحبا يا عالم جميل')

      // a second edit of the same document only names the font
      await block(page, line('ar-date')).click()
      await expect(editor).toHaveValue(line('ar-date'))
      await editor.fill('رقم الطلب 67890 بتاريخ 2026-10-01 (Epdf)')
      await editor.press('Enter')
      await expect(toast(page, 'Edited — drawn with Noto Naskh Arabic')).toBeVisible()
      await expect.poll(() => layerText(page).then(norm), { timeout: 30_000 }).toContain(norm('رقم الطلب 67890 بتاريخ 2026-10-01 (Epdf)'))

      // one undo step per edit
      await page.getByRole('button', { name: 'Undo Edit text' }).click()
      await expect.poll(() => layerText(page).then(norm), { timeout: 30_000 }).toContain(norm(line('ar-date')))
      await page.getByRole('button', { name: 'Redo Edit text' }).click()
      await expect.poll(() => layerText(page).then(norm), { timeout: 30_000 }).toContain(norm('رقم الطلب 67890 بتاريخ 2026-10-01 (Epdf)'))

      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      const lines = await savedLines(path)
      expect(lines).toContain(norm('مرحبا يا عالم جميل'))
      expect(lines).toContain(norm('رقم الطلب 67890 بتاريخ 2026-10-01 (Epdf)'))
      expect(lines).not.toContain(norm(hello))
      expect(lines).not.toContain(norm(line('ar-date')))
      for (const id of ['ar-vocalised', 'ar-punct', 'fa', 'ur', 'he', 'he-niqqud', 'latin']) expect(lines).toContain(norm(line(id)))
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Chromium (Skia) Hebrew and mixed lines, and a left-to-right line with an Arabic word', async () => {
    const { path, app, page } = await open('chromium-lines.pdf')
    try {
      await clickTool(page, 'edit-text')
      const editor = page.getByTestId('textedit-editor')
      const edits: [string, string][] = [
        [line('he'), 'שלום לכולם, טקסט חדש 2027.'],
        [line('ar-latin'), 'برنامج Epdf لتحرير ملفات PDF و DOCX'],
        [line('ar-in-ltr'), 'The word سلام means peace.']
      ]
      for (const [old, next] of edits) {
        await block(page, old).click()
        await expect(editor).toHaveValue(old)
        await expect(editor).toHaveAttribute('dir', old.startsWith('The') ? 'ltr' : 'rtl')
        await editor.fill(next)
        await editor.press('Enter')
        await expect(page.getByTestId('textedit-editor')).toHaveCount(0)
        await expect.poll(() => layerText(page).then(norm), { timeout: 30_000 }).toContain(norm(next))
      }
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      const lines = await savedLines(path)
      for (const [old, next] of edits) {
        expect(lines).toContain(norm(next))
        expect(lines).not.toContain(norm(old))
      }
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('paragraph scope: a wrapped Arabic paragraph is rewritten and re-wrapped in its old width', async () => {
    const { path, app, page } = await open('lo-para.pdf')
    try {
      await clickTool(page, 'edit-text')
      await page.getByTestId('textedit-scope').selectOption('paragraph')
      const old = corpus.paragraphs.find((p) => p.id === 'ar-para')!.text
      await pageEl(page).getByRole('button', { name: /^Edit paragraph: هذه فقرة طويلة/ }).click()
      const editor = page.getByTestId('textedit-editor')
      await expect(editor).toHaveAttribute('dir', 'rtl')
      expect(norm((await editor.inputValue()).replace(/\n/g, ' '))).toBe(norm(old))
      const next = 'هذه فقرة جديدة قصيرة حلت محل الفقرة القديمة، وفيها رقم 2026 وكلمة Epdf، ثم تنتهي بعد سطرين أو ثلاثة من النص العربي.'
      await editor.fill(next)
      await editor.press('Enter')
      await expect(page.getByTestId('textedit-editor')).toHaveCount(0)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      const m = await pageModel(new Uint8Array(readFileSync(path)))
      const arabic = m.lines.filter((l) => /[؀-ۿ]/.test(m.text.slice(l.start, l.end)))
      expect(arabic.length).toBeGreaterThanOrEqual(2)
      expect(norm(arabic.map((l) => m.text.slice(l.start, l.end)).join(' '))).toBe(norm(next))
      const right = Math.max(...arabic.map((l) => l.x1))
      for (const l of arabic) expect(Math.abs(l.x1 - right)).toBeLessThan(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})
