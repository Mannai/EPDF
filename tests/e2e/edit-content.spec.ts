import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { FIX, axeViolations, canvasHasInk, copyFixture, gotoPage, launch, quitDiscarding } from './helpers'

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/edit-content.mjs', FIX], { stdio: 'ignore' })
})

// ---- helpers ---------------------------------------------------------------------------------------------

const dot = (page: Page): Locator => page.getByTestId('unsaved-dot')
const saveBtn = (page: Page): Locator => page.getByRole('button', { name: 'Save', exact: true })
const tool = (page: Page, id: string): Locator => page.locator(`[data-tool="${id}"]`)
const pageEl = (page: Page, n = 1): Locator => page.locator(`[data-page="${n}"]`)

async function openDoc(name: string): Promise<{ path: string; app: ElectronApplication; page: Page }> {
  const path = copyFixture(name)
  const { app, page } = await launch({ files: [path] })
  await expect(pageEl(page).locator('canvas')).toBeVisible()
  return { path, app, page }
}

async function save(page: Page): Promise<void> {
  await saveBtn(page).click()
  await expect(dot(page)).toHaveCount(0)
}

/** Every text item PDF.js extracts from the file on disk (independent of our own engine). */
async function pdfjsText(pathOrBytes: string | Uint8Array, pageNo = 1): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = typeof pathOrBytes === 'string' ? new Uint8Array(readFileSync(pathOrBytes)) : pathOrBytes
  const task = pdfjs.getDocument({ data, useSystemFonts: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  try {
    const tc = await (await doc.getPage(pageNo)).getTextContent()
    return (tc.items as { str?: string }[]).map((i) => i.str ?? '').filter((s) => s !== '')
  } finally {
    await task.destroy()
  }
}

/** All decoded content-stream text of a page, as latin1 (for "is the old text really gone" checks). */
async function contentText(path: string, pageIndex = 0): Promise<string> {
  const doc = await PDFDocument.load(readFileSync(path))
  const node = doc.getPage(pageIndex).node
  const contents = node.Contents()
  const streams: PDFRawStream[] = []
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) streams.push(contents.lookup(i) as PDFRawStream)
  else if (contents) streams.push(contents as PDFRawStream)
  return streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join('\n')
}

const hex = (s: string): string => Buffer.from(s, 'latin1').toString('hex')

async function analysisOf(path: string, pageIndex = 0) {
  const doc = await PDFDocument.load(readFileSync(path))
  const a = analyzePage(doc, pageIndex)
  return { a, blocks: buildBlocks(a), doc }
}

const textBlock = (page: Page, part: string | RegExp, n = 1): Locator =>
  pageEl(page, n).getByRole('button', { name: typeof part === 'string' ? new RegExp(`(Edit|Can’t edit) (text|paragraph): ${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : part })

async function beginEdit(page: Page, part: string | RegExp, n = 1): Promise<Locator> {
  await textBlock(page, part, n).click()
  const editor = page.getByTestId('textedit-editor')
  await expect(editor).toBeVisible()
  return editor
}

async function replaceText(page: Page, part: string | RegExp, next: string, n = 1): Promise<void> {
  const editor = await beginEdit(page, part, n)
  await editor.fill(next)
  await editor.press('Enter')
}

const toast = (page: Page, text: string | RegExp): Locator => page.locator('[role="status"], [role="alert"]').filter({ hasText: text }).first()

// ---- text: in place --------------------------------------------------------------------------------------

test.describe('edit text', () => {
  test('edits a line in place with the document’s own font: saved file changed, old text gone, rest untouched', async () => {
    const { path, app, page } = await openDoc('ec-text.pdf')
    try {
      await tool(page, 'edit-text').click()
      await expect(tool(page, 'edit-text')).toHaveAttribute('aria-pressed', 'true')
      const editor = await beginEdit(page, 'Total: 1234')
      await expect(editor).toHaveValue('Total: 1234')
      await editor.fill('Total: 1299 (revised)')
      await editor.press('Enter')

      await expect(toast(page, 'Edited using the document’s own font')).toBeVisible()
      await expect(page.getByTestId('textedit-editor')).toHaveCount(0)
      await expect(dot(page)).toBeVisible()
      await expect(pageEl(page).locator('.textLayer')).toContainText('Total: 1299 (revised)')
      await expect(pageEl(page).locator('.textLayer')).not.toContainText('Total: 1234')
      await expect(page.getByRole('button', { name: 'Undo Edit text' })).toBeEnabled()
      expect(await canvasHasInk(page, '[data-page="1"] canvas')).toBe(true)

      await save(page)
      const items = await pdfjsText(path)
      expect(items).toContain('Total: 1299 (revised)')
      expect(items).not.toContain('Total: 1234')
      for (const keep of ['Quarterly Report', 'Signed by Alice', 'The revenue grew by twelve percent this quarter.']) expect(items).toContain(keep)
      expect(await pdfjsText(path, 2)).toEqual(['Second page stays untouched'])
      // the OLD string is not hiding anywhere in the content stream, in either string syntax
      const stream = await contentText(path)
      expect(stream).not.toContain('Total: 1234')
      expect(stream.toLowerCase()).not.toContain(hex('Total: 1234'))
      expect((await PDFDocument.load(readFileSync(path))).getPageCount()).toBe(2)
    } finally {
      await app.close()
    }
  })

  test('undo and redo move the edit in and out; escape cancels without leaving a mark', async () => {
    const { app, page } = await openDoc('ec-text.pdf')
    try {
      await tool(page, 'edit-text').click()
      // cancel with Escape
      const editor = await beginEdit(page, 'Signed by Alice')
      await editor.fill('Signed by Bob')
      await editor.press('Escape')
      await expect(page.getByTestId('textedit-editor')).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()
      await expect(tool(page, 'edit-text')).toHaveAttribute('aria-pressed', 'true') // Escape closed the editor, not the tool
      await expect(pageEl(page).locator('.textLayer')).toContainText('Signed by Alice')

      await replaceText(page, 'Signed by Alice', 'Signed by Carol')
      await expect(pageEl(page).locator('.textLayer')).toContainText('Signed by Carol')
      await page.getByRole('button', { name: 'Undo Edit text' }).click()
      await expect(pageEl(page).locator('.textLayer')).toContainText('Signed by Alice')
      await expect(dot(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Redo Edit text' }).click()
      await expect(pageEl(page).locator('.textLayer')).toContainText('Signed by Carol')
      await expect(dot(page)).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('blur commits the edit; an unchanged text does not create an undo step', async () => {
    const { app, page } = await openDoc('ec-text.pdf')
    try {
      await tool(page, 'edit-text').click()
      const editor = await beginEdit(page, 'Total: 1234')
      await editor.press('Enter') // nothing changed
      await expect(page.getByTestId('textedit-editor')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()

      const e2 = await beginEdit(page, 'Total: 1234')
      await e2.fill('Total: 42')
      await pageEl(page).getByTestId('textedit-layer').click({ position: { x: 500, y: 20 } }) // click elsewhere: blur
      await expect(pageEl(page).locator('.textLayer')).toContainText('Total: 42')
      await expect(page.getByRole('button', { name: 'Undo Edit text' })).toBeEnabled()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('font size and color from the tool options, keeping the document font', async () => {
    const { path, app, page } = await openDoc('ec-text.pdf')
    try {
      await tool(page, 'edit-text').click()
      const editor = await beginEdit(page, 'Signed by Alice')
      await page.getByTestId('textedit-size').fill('24')
      await page.getByTestId('textedit-color').fill('#0000ff')
      await expect(editor).toBeVisible() // moving to the options keeps the editor open
      await page.getByTestId('textedit-apply').click()
      await expect(toast(page, 'Edited using the document’s own font')).toBeVisible()
      await save(page)
      const { blocks } = await analysisOf(path)
      const b = blocks.lines.find((l) => l.text === 'Signed by Alice')!
      expect(b).toBeTruthy()
      expect(Math.abs(b.size - 24)).toBeLessThan(0.01)
      expect(b.color.css).toBe('#0000ff')
      expect(b.font.displayName).toBe('Times-Italic')
      expect(Math.abs(b.lines[0].baseline - 500)).toBeLessThan(0.01)
      expect((await pdfjsText(path)).filter((t) => t === 'Signed by Alice')).toHaveLength(1)
      expect(await contentText(path)).not.toContain(hex('Signed by Alice') + '>x')
    } finally {
      await app.close()
    }
  })

  test('paragraph scope edits a whole paragraph and re-wraps it', async () => {
    const { path, app, page } = await openDoc('ec-text.pdf')
    try {
      await tool(page, 'edit-text').click()
      await page.getByTestId('textedit-scope').selectOption('paragraph')
      const editor = await beginEdit(page, /Edit paragraph: The revenue grew/)
      await expect(editor).toHaveValue(
        'The revenue grew by twelve percent this quarter.\nCosts stayed flat compared with the last quarter.\nOutlook for the next quarter remains positive.'
      )
      await editor.fill('Revenue grew by twenty percent this quarter and costs fell, so the outlook for the next quarter remains very positive indeed.')
      await editor.press('Enter')
      await expect(toast(page, /Edited using the document’s own font|Font not available/)).toBeVisible()
      await save(page)
      const items = await pdfjsText(path)
      const joined = items.filter((t) => !['Quarterly Report', 'Total: 1234', 'Signed by Alice'].includes(t)).join(' ')
      expect(joined).toContain('Revenue grew by twenty percent')
      expect(joined).toContain('remains very positive indeed.')
      expect(joined).not.toContain('twelve percent')
      expect(joined).not.toContain('Costs stayed flat')
      const stream = await contentText(path)
      expect(stream.toLowerCase()).not.toContain(hex('twelve percent'))
      // wrapped inside the original width: every line ends before the old right edge (+ tolerance)
      const { blocks } = await analysisOf(path)
      const lines = blocks.lines.filter((l) => l.size === 12)
      expect(lines.length).toBeGreaterThanOrEqual(3)
      for (const l of lines) expect(l.lines[0].x1).toBeLessThan(72 + 270)
    } finally {
      await app.close()
    }
  })

  test('a Unicode replacement uses the bundled font and says so; the page still renders and old text is gone', async () => {
    const { path, app, page } = await openDoc('ec-text.pdf')
    try {
      await tool(page, 'edit-text').click()
      await replaceText(page, 'Quarterly Report', 'Квартальный отчёт')
      await expect(toast(page, 'Font not available in this PDF — used Noto Sans')).toBeVisible()
      await expect(pageEl(page).locator('.textLayer')).toContainText('Квартальный отчёт')
      await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas')).toBe(true)
      await save(page)
      expect(await pdfjsText(path)).toContain('Квартальный отчёт')
      expect(await pdfjsText(path)).not.toContain('Quarterly Report')
      expect(await contentText(path)).not.toContain(hex('Quarterly Report'))
      const { blocks } = await analysisOf(path)
      const b = blocks.lines.find((l) => l.text === 'Квартальный отчёт')!
      expect(Math.abs(b.size - 28)).toBeLessThan(0.01)
      expect(Math.abs(b.lines[0].baseline - 700)).toBeLessThan(0.01)
      expect(Math.abs(b.lines[0].x0 - 72)).toBeLessThan(0.5)
    } finally {
      await app.close()
    }
  })

  test('characters missing from an embedded subset font fall back to Helvetica (announced)', async () => {
    const { path, app, page } = await openDoc('ec-embedded.pdf')
    try {
      await tool(page, 'edit-text').click()
      await replaceText(page, 'Embedded font sample', 'Embedded font zebra quiz')
      await expect(toast(page, 'Font not available in this PDF — used Helvetica')).toBeVisible()
      await expect(pageEl(page).locator('.textLayer')).toContainText('Embedded font zebra quiz')
      await save(page)
      const items = await pdfjsText(path)
      expect(items).toContain('Embedded font zebra quiz')
      expect(items).toContain('Another embedded line')
      expect(items).not.toContain('Embedded font sample')
    } finally {
      await app.close()
    }
  })

  test('characters the subset already contains are edited in place', async () => {
    const { path, app, page } = await openDoc('ec-embedded.pdf')
    try {
      await tool(page, 'edit-text').click()
      await replaceText(page, 'Another embedded line', 'Another line embedded')
      await expect(toast(page, 'Edited using the document’s own font')).toBeVisible()
      await save(page)
      expect(await pdfjsText(path)).toContain('Another line embedded')
    } finally {
      await app.close()
    }
  })

  test('clicking outside any text does nothing; a page with no text says so', async () => {
    const { app, page } = await openDoc('ec-text.pdf')
    try {
      await tool(page, 'edit-text').click()
      await pageEl(page).getByTestId('textedit-layer').click({ position: { x: 300, y: 400 } })
      await expect(page.getByTestId('textedit-editor')).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0)
      await expect(page.getByTestId('textedit-banner')).toHaveCount(0)
    } finally {
      await app.close()
    }
    const scan = await openDoc('ec-scan.pdf')
    try {
      await tool(scan.page, 'edit-text').click()
      await expect(scan.page.getByTestId('textedit-banner')).toContainText('No editable text on this page')
      await pageEl(scan.page).getByTestId('textedit-layer').click({ position: { x: 200, y: 300 } })
      await expect(toast(scan.page, 'No editable text on this page')).toBeVisible()
      await expect(dot(scan.page)).toHaveCount(0)
    } finally {
      await scan.app.close()
    }
  })

  test('the accessibility scan is clean with the tool and the editor open (light and dark)', async () => {
    const { app, page } = await openDoc('ec-text.pdf')
    try {
      await tool(page, 'edit-text').click()
      await expect(textBlock(page, 'Total: 1234')).toBeVisible()
      expect(await axeViolations(page, 'edit text idle light')).toEqual([])
      await beginEdit(page, 'Total: 1234')
      expect(await axeViolations(page, 'edit text editing light')).toEqual([])
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      expect(await axeViolations(page, 'edit text editing dark')).toEqual([])
      await page.getByTestId('textedit-cancel').click()
      expect(await axeViolations(page, 'edit text idle dark')).toEqual([])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the edit survives autosave-style reopen: Save, close, open again shows the new text', async () => {
    const { path, app, page } = await openDoc('ec-text.pdf')
    try {
      await tool(page, 'edit-text').click()
      await replaceText(page, 'Total: 1234', 'Total: 777')
      await save(page)
    } finally {
      await app.close()
    }
    const again = await launch({ files: [path] })
    try {
      await expect(pageEl(again.page).locator('.textLayer')).toContainText('Total: 777')
      await gotoPage(again.page, 2)
      await expect(pageEl(again.page, 2).locator('.textLayer')).toContainText('Second page stays untouched')
    } finally {
      await again.app.close()
    }
  })
})

void [join, PDFName, PDFRef]
