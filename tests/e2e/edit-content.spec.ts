import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { FIX, axeViolations, canvasHasInk, copyFixture, gotoPage, launch, quitDiscarding, clickTool } from './helpers'

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
      await clickTool(page, 'edit-text')
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
      expect(stream.toLowerCase()).toContain(hex('Total: 1299 (revised)')) // the new text is what the stream now shows
      expect((await PDFDocument.load(readFileSync(path))).getPageCount()).toBe(2)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('undo and redo move the edit in and out; escape cancels without leaving a mark', async () => {
    const { app, page } = await openDoc('ec-text.pdf')
    try {
      await clickTool(page, 'edit-text')
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
      await clickTool(page, 'edit-text')
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
      await clickTool(page, 'edit-text')
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
      await quitDiscarding(app, page)
    }
  })

  test('paragraph scope edits a whole paragraph and re-wraps it', async () => {
    const { path, app, page } = await openDoc('ec-text.pdf')
    try {
      await clickTool(page, 'edit-text')
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
      await quitDiscarding(app, page)
    }
  })

  test('a Unicode replacement uses the bundled font and says so; the page still renders and old text is gone', async () => {
    const { path, app, page } = await openDoc('ec-text.pdf')
    try {
      await clickTool(page, 'edit-text')
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
      await quitDiscarding(app, page)
    }
  })

  test('characters missing from an embedded subset font fall back to Helvetica (announced)', async () => {
    const { path, app, page } = await openDoc('ec-embedded.pdf')
    try {
      await clickTool(page, 'edit-text')
      await replaceText(page, 'Embedded font sample', 'Embedded font zebra quiz')
      await expect(toast(page, 'Font not available in this PDF — used Helvetica')).toBeVisible()
      await expect(pageEl(page).locator('.textLayer')).toContainText('Embedded font zebra quiz')
      await save(page)
      const items = await pdfjsText(path)
      expect(items).toContain('Embedded font zebra quiz')
      expect(items).toContain('Another embedded line')
      expect(items).not.toContain('Embedded font sample')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('characters the subset already contains are edited in place', async () => {
    const { path, app, page } = await openDoc('ec-embedded.pdf')
    try {
      await clickTool(page, 'edit-text')
      await replaceText(page, 'Another embedded line', 'Another line embedded')
      await expect(toast(page, 'Edited using the document’s own font')).toBeVisible()
      await save(page)
      expect(await pdfjsText(path)).toContain('Another line embedded')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('clicking outside any text does nothing; a page with no text says so', async () => {
    const { app, page } = await openDoc('ec-text.pdf')
    try {
      await clickTool(page, 'edit-text')
      await pageEl(page).getByTestId('textedit-layer').click({ position: { x: 300, y: 400 } })
      await expect(page.getByTestId('textedit-editor')).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0)
      await expect(page.getByTestId('textedit-banner')).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
    const scan = await openDoc('ec-scan.pdf')
    try {
      await clickTool(scan.page, 'edit-text')
      await expect(scan.page.getByTestId('textedit-banner')).toContainText('No editable text on this page')
      await pageEl(scan.page).getByTestId('textedit-layer').click({ position: { x: 200, y: 300 } })
      await expect(toast(scan.page, 'No editable text on this page')).toBeVisible()
      await expect(dot(scan.page)).toHaveCount(0)
    } finally {
      await quitDiscarding(scan.app, scan.page)
    }
  })

  test('rotated text and text in a shared form are outlined as not editable and explain why when clicked', async () => {
    const { app, page } = await openDoc('ec-special.pdf')
    try {
      await clickTool(page, 'edit-text')
      const rotated = textBlock(page, 'Sideways text')
      await expect(rotated).toHaveAttribute('data-editable', 'false')
      await rotated.click()
      await expect(toast(page, /can’t be edited: the text is rotated, mirrored or skewed/)).toBeVisible()
      await expect(page.getByTestId('textedit-editor')).toHaveCount(0)

      const shared = pageEl(page).getByRole('button', { name: /Can’t edit text: Shared logo text/ }).first()
      await expect(shared).toBeVisible()
      await shared.click()
      await expect(toast(page, /shared element/)).toBeVisible()
      await expect(dot(page)).toHaveCount(0)

      // ...while ordinary text on the same page is fine
      await replaceText(page, 'Plain editable line', 'Plain line, edited')
      await expect(toast(page, 'Edited using the document’s own font')).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the accessibility scan is clean with the tool and the editor open (light and dark)', async () => {
    const { app, page } = await openDoc('ec-text.pdf')
    try {
      await clickTool(page, 'edit-text')
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
      await clickTool(page, 'edit-text')
      await replaceText(page, 'Total: 1234', 'Total: 777')
      await save(page)
    } finally {
      await quitDiscarding(app, page)
    }
    const again = await launch({ files: [path] })
    try {
      await expect(pageEl(again.page).locator('.textLayer')).toContainText('Total: 777')
      await gotoPage(again.page, 2)
      await expect(pageEl(again.page, 2).locator('.textLayer')).toContainText('Second page stays untouched')
    } finally {
      await quitDiscarding(again.app, again.page)
    }
  })
})

// ---- images ----------------------------------------------------------------------------------------------

const outlines = (page: Page, n = 1): Locator => pageEl(page, n).locator('[data-image]')

const mockOpenDialog = (app: ElectronApplication, path: string | null): Promise<void> =>
  app.evaluate(({ dialog }, p) => {
    ;(dialog as unknown as { showOpenDialog: () => Promise<unknown> }).showOpenDialog = () =>
      Promise.resolve(p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] })
  }, path)

const pageScale = async (page: Page): Promise<number> => (await pageEl(page).boundingBox())!.width / 612

async function imagesOnDisk(path: string, pageIndex = 0) {
  const { a } = await analysisOf(path, pageIndex)
  return a.images
}

/** Number of image XObjects stored in the file at all (dangling data check). */
async function imageObjectCount(path: string): Promise<number> {
  const doc = await PDFDocument.load(readFileSync(path))
  let n = 0
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = (obj as { dict?: { get(k: PDFName): unknown } }).dict
    const sub = dict?.get(PDFName.of('Subtype')) as PDFName | undefined
    if (sub?.toString() === '/Image') n++
  }
  return n
}

const near = (a: number, b: number, eps = 0.6): void => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(eps)
const field = (page: Page, id: string): Locator => page.getByTestId(`imageedit-${id}`)

test.describe('edit images', () => {
  test('outlines images, shows their box, and moves one through the numeric fields (one undo step)', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      await clickTool(page, 'edit-images')
      await expect(outlines(page)).toHaveCount(2)
      await outlines(page).nth(0).click()
      await expect(field(page, 'x')).toHaveValue('72')
      await expect(field(page, 'y')).toHaveValue('600')
      await expect(field(page, 'w')).toHaveValue('200')
      await expect(field(page, 'h')).toHaveValue('100')
      await field(page, 'x').fill('150')
      await field(page, 'y').fill('500')
      await field(page, 'apply').click()
      await expect(toast(page, 'Image moved')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Undo Move image' })).toBeEnabled()
      await save(page)
      const imgs = await imagesOnDisk(path)
      expect(imgs).toHaveLength(2)
      const red = imgs.find((i) => i.width === 40)!
      const green = imgs.find((i) => i.width === 30)!
      near(red.bbox.x0, 150, 0.01)
      near(red.bbox.y0, 500, 0.01)
      near(red.bbox.x1, 350, 0.01)
      near(red.bbox.y1, 600, 0.01)
      near(green.bbox.x0, 320, 0.01) // the other image is untouched
      near(green.bbox.y0, 300, 0.01)
      expect(await pdfjsText(path)).toContain('Image page')
      expect((await PDFDocument.load(readFileSync(path))).getPageCount()).toBe(2)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('resizes with the fields and keeps proportions; the page still renders the image', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      await clickTool(page, 'edit-images')
      await outlines(page).nth(0).click()
      await field(page, 'w').fill('300') // "Keep proportions" is on: height follows
      await expect(field(page, 'h')).toHaveValue('150')
      await field(page, 'apply').click()
      await expect(toast(page, 'Image resized')).toBeVisible()
      await save(page)
      const red = (await imagesOnDisk(path)).find((i) => i.width === 40)!
      near(red.bbox.x0, 72, 0.01)
      near(red.bbox.y0, 600, 0.01)
      near(red.bbox.x1 - red.bbox.x0, 300, 0.01)
      near(red.bbox.y1 - red.bbox.y0, 150, 0.01)
      // the canvas shows red pixels inside the new box
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const c = document.querySelector<HTMLCanvasElement>('[data-page="1"] canvas')
            if (!c || c.width === 0) return 'no canvas'
            const s = c.width / 612
            const d = c.getContext('2d')!.getImageData(Math.round(200 * s), Math.round((792 - 700) * s), 1, 1).data
            return d[0] > 180 && d[1] < 80 && d[2] < 80 ? 'red' : `rgb(${d[0]},${d[1]},${d[2]})`
          })
        )
        .toBe('red')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('drags an image with the mouse; handles resize, Shift keeps the aspect ratio', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      await clickTool(page, 'edit-images')
      const s = await pageScale(page)
      const o = outlines(page).nth(0)
      await o.scrollIntoViewIfNeeded()
      const b = (await o.boundingBox())!
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await page.mouse.down()
      await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2 + 30, { steps: 6 })
      await page.mouse.up()
      await expect(toast(page, 'Image moved')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Undo Move image' })).toBeEnabled()
      await expect.poll(async () => (await field(page, 'x').inputValue()) !== '72').toBe(true)

      // Shift + southeast handle: width grows by ~100px, height must follow the aspect ratio (2:1)
      const handle = pageEl(page).locator('[data-handle="se"]')
      await expect(handle).toBeVisible()
      const hb = (await handle.boundingBox())!
      await page.keyboard.down('Shift')
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.mouse.down()
      await page.mouse.move(hb.x + hb.width / 2 + 100, hb.y + hb.height / 2 + 3, { steps: 6 })
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await expect(toast(page, 'Image resized')).toBeVisible()
      await save(page)
      const red = (await imagesOnDisk(path)).find((i) => i.width === 40)!
      const w = red.bbox.x1 - red.bbox.x0
      const h = red.bbox.y1 - red.bbox.y0
      near(w / h, 2, 0.02)
      near(w, 200 + 100 / s, 1.5)
      // the move: dragged by (60, 30) px = (60/s, -30/s) points; the resize kept the top-left corner
      near(red.bbox.x0, 72 + 60 / s, 1)
      near(red.bbox.y1, 700 - 30 / s, 1)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('arrow keys nudge the selected image; a burst of key presses is a single undo step', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      await clickTool(page, 'edit-images')
      const o = outlines(page).nth(0)
      await o.click()
      await o.focus()
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Shift+ArrowUp')
      await expect(page.getByRole('button', { name: 'Undo Move image' })).toBeEnabled()
      await expect(toast(page, 'Image moved')).toBeVisible()
      await save(page)
      const red = (await imagesOnDisk(path)).find((i) => i.width === 40)!
      near(red.bbox.x0, 77, 0.01)
      near(red.bbox.y0, 610, 0.01)
    } finally {
      await quitDiscarding(app, page)
    }
    const second = await openDoc('ec-images.pdf')
    try {
      await clickTool(second.page, 'edit-images')
      const o = outlines(second.page).nth(0)
      await o.click()
      await o.focus()
      for (let i = 0; i < 4; i++) await second.page.keyboard.press('ArrowDown')
      await expect(second.page.getByRole('button', { name: 'Undo Move image' })).toBeEnabled()
      await second.page.getByRole('button', { name: 'Undo Move image' }).click()
      await expect(dot(second.page)).toHaveCount(0) // one step took it all back
    } finally {
      await quitDiscarding(second.app, second.page)
    }
  })

  test('deletes images (Delete key and button), leaves no dangling image data, and undo/redo work', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      await clickTool(page, 'edit-images')
      expect(await imageObjectCount(path)).toBe(2)
      const first = outlines(page).nth(0)
      await first.click()
      await first.focus()
      await page.keyboard.press('Delete')
      await expect(toast(page, 'Image deleted')).toBeVisible()
      await expect(outlines(page)).toHaveCount(1)
      await page.getByRole('button', { name: 'Undo Delete image' }).click()
      await expect(outlines(page)).toHaveCount(2)
      await page.getByRole('button', { name: 'Redo Delete image' }).click()
      await expect(outlines(page)).toHaveCount(1)

      await outlines(page).nth(0).click()
      await page.getByTestId('imageedit-delete').click()
      await expect(outlines(page)).toHaveCount(0)
      await expect(pageEl(page).getByTestId('imageedit-banner')).toContainText('No images on this page')
      await save(page)
      expect(await imagesOnDisk(path)).toHaveLength(0)
      expect(await imageObjectCount(path)).toBe(0)
      expect(await pdfjsText(path)).toContain('Image page')
      expect(await pdfjsText(path, 2)).toEqual(['Page two'])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('replaces a picture: fit keeps the aspect ratio inside the same box, fill covers it', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      await mockOpenDialog(app, join(FIX, 'ec-picture.png'))
      await clickTool(page, 'edit-images')
      // red box 200x100 (aspect 2) gets a 50x25 picture (aspect 2): exact fit
      await outlines(page).nth(0).click()
      await page.getByTestId('imageedit-replace').click()
      await expect(toast(page, /Image replaced/)).toBeVisible()
      // green box 100x100 (aspect 1) with the wide picture, "fills the box (cropped)"
      await outlines(page).nth(1).click()
      await page.getByTestId('imageedit-mode').selectOption('fill')
      await page.getByTestId('imageedit-replace').click()
      await expect(page.getByRole('button', { name: 'Undo Replace image' })).toBeEnabled()
      await expect.poll(async () => (await imagesOnDisk(path)).length, { timeout: 1000 }).toBe(2) // nothing written yet
      await save(page)
      const imgs = await imagesOnDisk(path)
      expect(imgs).toHaveLength(2)
      expect(imgs.every((i) => i.width === 50 && i.height === 25)).toBe(true)
      const a = imgs.find((i) => Math.abs(i.bbox.x0 - 72) < 0.01)!
      near(a.bbox.x1, 272, 0.01)
      near(a.bbox.y0, 600, 0.01)
      near(a.bbox.y1, 700, 0.01)
      const b = imgs.find((i) => Math.abs(i.bbox.y0 - 300) < 0.01)!
      near(b.bbox.x0, 270, 0.01) // 200x100 unclipped extent centred on the 100x100 box
      near(b.bbox.x1, 470, 0.01)
      expect(await contentText(path)).toMatch(/0 0 1 1 re\s+W\s+n/)
      expect(await imageObjectCount(path)).toBe(2) // the two old pictures are gone
      await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas')).toBe(true)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('replaces with a real JPEG (baseline, encoded by Chromium): embedded as DCT and rendered', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      const png = readFileSync(join(FIX, 'ec-picture.png')).toString('base64')
      const jpgB64 = await app.evaluate(({ nativeImage }, s) => nativeImage.createFromBuffer(Buffer.from(s, 'base64')).toJPEG(90).toString('base64'), png)
      const jpg = join(dirname(path), 'picture.jpg')
      writeFileSync(jpg, Buffer.from(jpgB64, 'base64'))
      await mockOpenDialog(app, jpg)
      await clickTool(page, 'edit-images')
      await outlines(page).nth(0).click()
      await page.getByTestId('imageedit-replace').click()
      await expect(toast(page, /Image replaced/)).toBeVisible()
      await save(page)
      const red = (await imagesOnDisk(path)).find((i) => i.width === 50)!
      expect(red.height).toBe(25)
      near(red.bbox.x0, 72, 0.01)
      near(red.bbox.x1, 272, 0.01)
      const doc = await PDFDocument.load(readFileSync(path))
      let dct = 0
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        const dict = (obj as { dict?: { get(k: PDFName): unknown } }).dict
        if ((dict?.get(PDFName.of('Subtype')) as PDFName | undefined)?.toString() === '/Image' && String(dict?.get(PDFName.of('Filter'))).includes('DCTDecode')) dct++
      }
      expect(dct).toBe(1)
      // Chromium (PDF.js) decodes it: bluish pixels where the red picture used to be
      await expect
        .poll(() =>
          page.evaluate(() => {
            const c = document.querySelector<HTMLCanvasElement>('[data-page="1"] canvas')
            if (!c || c.width === 0) return 'no canvas'
            const s = c.width / 612
            const d = c.getContext('2d')!.getImageData(Math.round(170 * s), Math.round((792 - 650) * s), 1, 1).data
            return d[2] > 150 && d[0] < 90 ? 'blue' : `rgb(${d[0]},${d[1]},${d[2]})`
          })
        )
        .toBe('blue')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('adds an image at the clicked point and at the page center', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      await mockOpenDialog(app, join(FIX, 'ec-picture.png'))
      await clickTool(page, 'edit-images')
      const s = await pageScale(page)
      await page.getByTestId('imageedit-add').click()
      await expect(pageEl(page).getByTestId('imageedit-banner')).toContainText('Click on the page where')
      await pageEl(page).getByTestId('imageedit-layer').click({ position: { x: 300 * s, y: 200 * s } })
      await expect(toast(page, 'Image added')).toBeVisible()
      await expect(outlines(page)).toHaveCount(3)

      await page.getByTestId('imageedit-add').click()
      await page.getByTestId('imageedit-center').click()
      await expect(outlines(page)).toHaveCount(4)
      await save(page)
      const imgs = await imagesOnDisk(path)
      expect(imgs).toHaveLength(4)
      const added = imgs.filter((i) => i.width === 50 && i.height === 25)
      expect(added).toHaveLength(2)
      const centers = added.map((i) => [(i.bbox.x0 + i.bbox.x1) / 2, (i.bbox.y0 + i.bbox.y1) / 2]).sort((p, q) => q[1] - p[1])
      near(centers[0][0], 300, 1)
      near(centers[0][1], 792 - 200, 1) // clicked point, converted to PDF space (y up)
      near(centers[1][0], 306, 1)
      near(centers[1][1], 396, 1)
      // natural size at 96 dpi: 50x25 px = 37.5 x 18.75 pt
      near(added[0].bbox.x1 - added[0].bbox.x0, 37.5, 0.05)
      expect((await PDFDocument.load(readFileSync(path))).getPageCount()).toBe(2)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a cancelled dialog, a fake image and an unsupported file change nothing', async () => {
    const { app, page } = await openDoc('ec-images.pdf')
    try {
      await clickTool(page, 'edit-images')
      await mockOpenDialog(app, null)
      await page.getByTestId('imageedit-add').click()
      await expect(pageEl(page).getByTestId('imageedit-banner')).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0)

      await mockOpenDialog(app, join(FIX, 'ec-not-an-image.png'))
      await page.getByTestId('imageedit-add').click()
      await expect(toast(page, 'not a PNG or JPEG')).toBeVisible()
      await expect(dot(page)).toHaveCount(0)

      // the renderer cannot smuggle a path into the picker: extra fields are rejected by the channel schema
      const rejected = await page.evaluate(async () => {
        try {
          await window.epdf.call('imageedit:pickImage', { path: 'C:\\Windows\\win.ini' })
          return false
        } catch {
          return true
        }
      })
      expect(rejected).toBe(true)
      const unknown = await page.evaluate(async () => {
        try {
          await window.epdf.call('imageedit:readFile', { path: 'C:\\Windows\\win.ini' })
          return false
        } catch {
          return true
        }
      })
      expect(unknown).toBe(true)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a page without images says so; images can be edited on another page', async () => {
    const { app, page } = await openDoc('ec-images.pdf')
    try {
      await clickTool(page, 'edit-images')
      await gotoPage(page, 2)
      await expect(pageEl(page, 2).getByTestId('imageedit-banner')).toContainText('No images on this page')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the accessibility scan is clean with an image selected (light and dark)', async () => {
    const { app, page } = await openDoc('ec-images.pdf')
    try {
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light'
      })
      await expect(page.locator('html')).not.toHaveClass(/dark/)
      await clickTool(page, 'edit-images')
      await outlines(page).nth(0).click()
      await expect(field(page, 'w')).toHaveValue('200')
      expect(await axeViolations(page, 'edit images selected light')).toEqual([])
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      expect(await axeViolations(page, 'edit images selected dark')).toEqual([])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the text tool accessibility scan runs in an explicit light theme too', async () => {
    const { app, page } = await openDoc('ec-text.pdf')
    try {
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light'
      })
      await expect(page.locator('html')).not.toHaveClass(/dark/)
      await clickTool(page, 'edit-text')
      await beginEdit(page, 'Total: 1234')
      expect(await axeViolations(page, 'edit text editing (explicit light)')).toEqual([])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('images on a rotated page: outlines follow the rotation and edits land in unrotated page space', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      await clickTool(page, 'edit-images')
      const before = (await outlines(page).nth(0).boundingBox())!
      expect(before.width).toBeGreaterThan(before.height) // 200 x 100 landscape box
      await app.evaluate(({ Menu }) => {
        const doc = Menu.getApplicationMenu()!.items.find((x) => x.label.replace('&', '') === 'Document')!
        doc.submenu!.items.find((x) => x.label === 'Rotate Page Clockwise')!.click()
      })
      await expect.poll(async () => (await outlines(page).nth(0).boundingBox())!.width).toBeLessThan(before.height * 1.2)
      const after = (await outlines(page).nth(0).boundingBox())!
      expect(after.height).toBeGreaterThan(after.width) // now portrait
      const pb = (await pageEl(page).boundingBox())!
      expect(after.x).toBeGreaterThanOrEqual(pb.x - 1)
      expect(after.x + after.width).toBeLessThanOrEqual(pb.x + pb.width + 1)
      await outlines(page).nth(0).click()
      await expect(field(page, 'x')).toHaveValue('72') // the fields always speak user space
      await field(page, 'x').fill('120')
      await field(page, 'apply').click()
      await expect(toast(page, 'Image moved')).toBeVisible()
      await save(page)
      const doc = await PDFDocument.load(readFileSync(path))
      expect(doc.getPage(0).getRotation().angle).toBe(90)
      const red = (await imagesOnDisk(path)).find((i) => i.width === 40)!
      near(red.bbox.x0, 120, 0.01)
      near(red.bbox.y0, 600, 0.01)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('text on a rotated page is outlined as not editable, with the reason', async () => {
    const { app, page } = await openDoc('ec-text.pdf')
    try {
      await app.evaluate(({ Menu }) => {
        const doc = Menu.getApplicationMenu()!.items.find((x) => x.label.replace('&', '') === 'Document')!
        doc.submenu!.items.find((x) => x.label === 'Rotate Page Clockwise')!.click()
      })
      await clickTool(page, 'edit-text')
      const b = pageEl(page).getByRole('button', { name: /Can’t edit text: Total: 1234/ })
      await expect(b).toBeVisible()
      await b.click()
      await expect(toast(page, /can’t be edited: text editing on rotated pages is not supported/)).toBeVisible()
      await expect(page.getByTestId('textedit-editor')).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('text and image edits share one history: text edit, image move, undo twice', async () => {
    const { path, app, page } = await openDoc('ec-images.pdf')
    try {
      await clickTool(page, 'edit-text')
      await replaceText(page, 'Image page', 'Pictures page')
      await clickTool(page, 'edit-images')
      await outlines(page).nth(0).click()
      await field(page, 'x').fill('100')
      await field(page, 'apply').click()
      await expect(page.getByRole('button', { name: 'Undo Move image' })).toBeEnabled()
      await page.getByRole('button', { name: 'Undo Move image' }).click()
      await page.getByRole('button', { name: 'Undo Edit text' }).click()
      await expect(dot(page)).toHaveCount(0)
      await expect(pageEl(page).locator('.textLayer')).toContainText('Image page')
      expect((await imagesOnDisk(path)).find((i) => i.width === 40)!.bbox.x0).toBeCloseTo(72, 1)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})