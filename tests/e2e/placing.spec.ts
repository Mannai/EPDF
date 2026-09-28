import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { FIX, answerDelete, clickTool, copyFixture, launch, menuClick, quitDiscarding } from './helpers'

/**
 * Placing things on a page and changing them afterwards: tools don't follow the user to another task, placed shapes
 * and stamps are selected for editing, Delete / Backspace asks first (with "Don't ask again"), and click-to-place
 * tools preview what a click would add.
 */

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/markup.mjs', resolve(FIX)], { stdio: 'inherit' })
  execFileSync(process.execPath, ['tests/fixtures/forms-signing.mjs', resolve(FIX)], { stdio: 'inherit' })
})

const dot = (page: Page) => page.getByTestId('unsaved-dot')
const frame = (page: Page) => page.getByTestId('markup-frame')
const ghost = (page: Page) => page.getByTestId('place-ghost')
const pressed = (page: Page) => page.locator('#ribbon-tools button[data-tool][aria-pressed="true"]')

async function open(file = 'markup.pdf', opts: Parameters<typeof launch>[0] = {}): Promise<{ app: ElectronApplication; page: Page; path: string }> {
  const path = copyFixture(file)
  const l = await launch({ files: [path], ...opts })
  await expect(l.page.locator('[data-page="1"] canvas')).toBeVisible()
  await expect(l.page.locator('[data-page="1"] .textLayer span').first()).toBeVisible()
  await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
  await l.page.getByLabel('Zoom level').selectOption('fit-page')
  await l.page.waitForTimeout(700)
  return { ...l, path }
}

/** Screen position of a PDF point on an unrotated 612x792 page 1. */
async function pdfPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const b = (await page.locator('[data-page="1"]').boundingBox())!
  return { x: b.x + (x / 612) * b.width, y: b.y + ((792 - y) / 792) * b.height }
}

async function drag(page: Page, a: { x: number; y: number }, b: { x: number; y: number }): Promise<void> {
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await page.mouse.up()
}

async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dot(page)).toHaveCount(0)
}

/** The saved page-1 annotations of one subtype. */
async function annotsOnDisk(path: string, subtype: string): Promise<PDFDict[]> {
  const pdf = await PDFDocument.load(readFileSync(path))
  const arr = pdf.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  const out: PDFDict[] = []
  for (let i = 0; i < (arr?.size() ?? 0); i++) {
    const d = arr!.lookup(i, PDFDict)
    if (d.get(PDFName.of('Subtype'))?.toString() === `/${subtype}`) out.push(d)
  }
  return out
}

const menuChecked = (app: ElectronApplication, label: string): Promise<boolean | undefined> =>
  app.evaluate(({ Menu }, l) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === l) return i
        const s = i.submenu && find(i.submenu.items)
        if (s) return s
      }
      return undefined
    }
    return find(Menu.getApplicationMenu()!.items)?.checked
  }, label)

const menuRadio = (app: ElectronApplication, label: string): Promise<boolean | undefined> => menuChecked(app, label)

/** Clicks an item of a submenu of the application menu (labels compared without `&` mnemonics). */
function menuClickSub(app: ElectronApplication, menu: string, sub: string, item: string): Promise<void> {
  return app.evaluate(
    ({ Menu }, [m, s, i]) => {
      const strip = (x: string): string => x.replace(/&(?!&)/g, '').replace(/&&/g, '&')
      const top = Menu.getApplicationMenu()!.items.find((x) => strip(x.label) === m)
      const submenu = top?.submenu?.items.find((x) => strip(x.label) === s)
      const it = submenu?.submenu?.items.find((x) => strip(x.label) === i)
      if (!it) throw new Error(`Menu item not found: ${m} > ${s} > ${i}`)
      it.click()
    },
    [menu, sub, item]
  )
}

test.describe('placing and changing things on a page', () => {
  test('leaving the Redact task ends its tool and closes its panel, so selecting text no longer marks it', async () => {
    const { app, page } = await open()
    try {
      await clickTool(page, 'redact-text')
      await expect(page.getByTestId('redact-panel')).toBeVisible()
      await expect(pressed(page)).toHaveAttribute('data-tool', 'redact-text')

      await page.locator('button[data-task="comment"]').click()
      await expect(pressed(page)).toHaveCount(0)
      await expect(page.getByTestId('redact-panel')).toHaveCount(0)

      // Selecting text now is just a selection. (The page re-fits once the panel closes: wait for it to settle.)
      const span = page.locator('[data-page="1"] .textLayer span', { hasText: 'Epdf markup fixture line one' }).first()
      await expect(span).toBeVisible()
      await page.waitForTimeout(700)
      await expect(span).toBeVisible()
      const b = (await span.boundingBox())!
      await drag(page, { x: b.x + 2, y: b.y + b.height / 2 }, { x: b.x + b.width * 0.9, y: b.y + b.height / 2 })
      await page.waitForTimeout(400)
      await expect(page.getByTestId('redact-mark')).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a drawn rectangle is selected for editing; Backspace asks first; "Don\'t ask again" sticks until Edit ▸ Ask Before Deleting', async () => {
    const { app, page, path } = await open()
    try {
      await clickTool(page, 'markup.rect')
      await drag(page, await pdfPoint(page, 72, 380), await pdfPoint(page, 200, 320))
      // Selected with the Select tool, and the ribbon stays on Draw (Select is there too).
      await expect(frame(page)).toHaveAttribute('aria-label', /Selected Rectangle/)
      await expect(page.locator('button[data-task="draw"]')).toHaveAttribute('aria-pressed', 'true')
      await expect(pressed(page)).toHaveAttribute('data-tool', 'markup.select')
      // Its properties: dashed outline, after the fact.
      await page.getByRole('group', { name: 'Select options' }).getByLabel('Dashed').check()
      await expect(page.getByRole('button', { name: 'Undo Change line style' })).toBeEnabled()

      // Backspace asks; Cancel keeps it.
      await frame(page).focus()
      await page.keyboard.press('Backspace')
      await answerDelete(page, { cancel: true })
      await expect(frame(page)).toBeVisible()
      // Delete, with "Don't ask again".
      await frame(page).focus()
      await page.keyboard.press('Backspace')
      await answerDelete(page, { dontAsk: true })
      await expect(frame(page)).toHaveCount(0)
      await expect.poll(() => menuChecked(app, 'Ask Before Deleting')).toBe(false)

      // The next one goes without asking.
      await clickTool(page, 'markup.rect')
      await drag(page, await pdfPoint(page, 72, 300), await pdfPoint(page, 200, 240))
      await expect(frame(page)).toBeVisible()
      await frame(page).focus()
      await page.keyboard.press('Delete')
      await expect(frame(page)).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: /^Delete / })).toHaveCount(0)

      // Edit ▸ Ask Before Deleting turns the question back on.
      await menuClick(app, 'Edit', 'Ask Before Deleting')
      await expect.poll(() => menuChecked(app, 'Ask Before Deleting')).toBe(true)
      await clickTool(page, 'markup.rect')
      await drag(page, await pdfPoint(page, 300, 300), await pdfPoint(page, 400, 240))
      await frame(page).focus()
      await page.keyboard.press('Delete')
      await answerDelete(page, { cancel: true })
      await expect(frame(page)).toBeVisible()

      await save(page)
      const rects = await annotsOnDisk(path, 'Square')
      expect(rects).toHaveLength(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('stamps and lines can be changed after placing: another stamp, arrowhead on and off', async () => {
    const { app, page, path } = await open()
    try {
      await clickTool(page, 'markup.stamp')
      await page.getByRole('combobox', { name: 'Stamp' }).selectOption('Draft')
      const at = await pdfPoint(page, 300, 240)
      await page.mouse.click(at.x, at.y)
      await expect(frame(page)).toHaveAttribute('aria-label', /Selected Stamp/)
      const before = (await frame(page).boundingBox())!
      await page.getByRole('combobox', { name: 'Stamp' }).selectOption('Confidential')
      await expect(page.getByRole('button', { name: 'Undo Change stamp' })).toBeEnabled()
      // A longer word makes a wider stamp around the same centre.
      await expect.poll(async () => (await frame(page).boundingBox())!.width).toBeGreaterThan(before.width + 20)
      const after = (await frame(page).boundingBox())!
      expect(Math.abs(after.x + after.width / 2 - (before.x + before.width / 2))).toBeLessThan(3)

      await clickTool(page, 'markup.line')
      await drag(page, await pdfPoint(page, 72, 500), await pdfPoint(page, 250, 460))
      await expect(frame(page)).toHaveAttribute('aria-label', /Selected Line/)
      await page.getByRole('group', { name: 'Select options' }).getByLabel('Arrowhead').check()
      await expect(page.getByRole('button', { name: 'Undo Add arrowhead' })).toBeEnabled()

      await save(page)
      const [stamp] = await annotsOnDisk(path, 'Stamp')
      expect(stamp.get(PDFName.of('Name'))?.toString()).toBe('/Confidential')
      const [line] = await annotsOnDisk(path, 'Line')
      expect(line.lookup(PDFName.of('LE'), PDFArray).asArray().map(String)).toEqual(['/None', '/OpenArrow'])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('dragging a shape moves the shape itself, and it stays where it was dropped while the page catches up', async () => {
    const { app, page } = await open()
    try {
      await clickTool(page, 'markup.rect')
      await page.getByRole('group', { name: /Rectangle options/ }).getByLabel('Fill').check()
      await drag(page, await pdfPoint(page, 300, 300), await pdfPoint(page, 420, 220))
      await expect(frame(page)).toBeVisible()
      await page.waitForTimeout(800) // the page shows the new rectangle
      const f = (await frame(page)).boundingBox ? (await frame(page).boundingBox())! : null
      const c = { x: f!.x + f!.width / 2, y: f!.y + f!.height / 2 }
      await page.mouse.move(c.x, c.y)
      await page.mouse.down()
      await page.mouse.move(c.x - 60, c.y + 40, { steps: 6 })
      // Mid-drag: a copy of the real rectangle is under the pointer, and the old spot is covered.
      await expect(page.getByTestId('lift-image')).toBeVisible()
      await expect(page.getByTestId('lift-eraser')).toBeVisible()
      const li = (await page.getByTestId('lift-image').boundingBox())!
      expect(Math.abs(li.x + li.width / 2 - (c.x - 60))).toBeLessThan(3)
      expect(Math.abs(li.y + li.height / 2 - (c.y + 40))).toBeLessThan(3)
      // The copy holds the rectangle's fill colour (not just an outline).
      const filled = await page.getByTestId('lift-image').locator('canvas').evaluate((cv: HTMLCanvasElement) => {
        const d = cv.getContext('2d')!.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data
        return d[3] > 200
      })
      expect(filled).toBe(true)
      await page.screenshot({ path: test.info().outputPath('mid-drag.png') })
      await page.mouse.up()
      // Dropped: the copy stays until the redrawn page arrives, then goes; the frame ends where it was dropped.
      await expect(page.getByTestId('lift-image')).toHaveCount(0, { timeout: 5000 })
      const g = (await frame(page).boundingBox())!
      expect(Math.abs(g.x + g.width / 2 - (c.x - 60))).toBeLessThan(3)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('dragging a picture (Edit images) moves the picture itself, and it does not snap back after the drop', async () => {
    execFileSync(process.execPath, ['tests/fixtures/edit-content.mjs', FIX], { stdio: 'ignore' })
    const { app, page } = await open('ec-images.pdf')
    try {
      await clickTool(page, 'edit-images')
      const img = page.locator('[data-page="1"] [data-image]').first()
      await expect(img).toBeVisible()
      const b = (await img.boundingBox())!
      const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      await page.mouse.move(c.x, c.y)
      await page.mouse.down()
      await page.mouse.move(c.x + 50, c.y + 30, { steps: 6 })
      await expect(page.getByTestId('lift-image')).toBeVisible()
      const li = (await page.getByTestId('lift-image').boundingBox())!
      expect(Math.abs(li.x + li.width / 2 - (c.x + 50))).toBeLessThan(4)
      await page.mouse.up()
      // Right after the drop the outline is at the drop point, never back at the start.
      for (let i = 0; i < 10; i++) {
        const boxes = await page.locator('[data-page="1"] [data-image], [data-page="1"] .outline-accent').evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect()
            return r.x + r.width / 2
          })
        )
        expect(boxes.some((x) => Math.abs(x - c.x) < 3)).toBe(false)
        await page.waitForTimeout(60)
      }
      await expect(page.getByTestId('lift-image')).toHaveCount(0, { timeout: 5000 })
      await expect.poll(async () => {
        const nb = (await page.locator('[data-page="1"] [data-image]').first().boundingBox())!
        return Math.round(nb.x + nb.width / 2 - (c.x + 50))
      }).toBeLessThan(4)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Fill & sign: clicking outside the typed text confirms it; saving asks to lock or keep; "Don\'t ask again" sticks; the Edit menu changes it', async () => {
    const { app, page, path } = await open('flat.pdf')
    try {
      const pb = (await page.locator('[data-page="1"]').boundingBox())!
      await clickTool(page, 'forms.addText')
      await page.mouse.click(pb.x + 120, pb.y + 150)
      await page.getByLabel('Text to add to the page').fill('Confirmed by clicking elsewhere')
      // Clicking outside the box confirms it: added, selected, and no second box opened.
      await page.mouse.click(pb.x + 400, pb.y + 600)
      await expect(page.getByRole('button', { name: 'Undo Add text' })).toBeEnabled()
      await expect(page.getByTestId('text-draft')).toHaveCount(0)
      await expect(frame(page)).toHaveAttribute('aria-label', /Selected Text/)
      // A check mark too.
      await clickTool(page, 'forms.stampCheck')
      await page.mouse.click(pb.x + 120, pb.y + 250)
      await expect(frame(page)).toHaveAttribute('aria-label', /Selected Check mark/)

      // Cancel keeps everything as it was (nothing saved).
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const q = page.getByRole('dialog', { name: 'Lock filled-in items into the page?' })
      await q.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dot(page)).toHaveCount(1)
      // Keep editable, and don't ask again.
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await q.getByLabel('Don’t ask again').check()
      await q.getByRole('button', { name: 'Keep editable', exact: true }).click()
      await expect(dot(page)).toHaveCount(0)
      let saved = await PDFDocument.load(readFileSync(path))
      expect(saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size()).toBe(2)
      await expect.poll(() => menuRadio(app, 'Keep Them Editable')).toBe(true)

      // The next save doesn't ask.
      await clickTool(page, 'forms.stampCross')
      await page.mouse.click(pb.x + 200, pb.y + 250)
      await expect(dot(page)).toHaveCount(1)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dot(page)).toHaveCount(0)
      await expect(q).toHaveCount(0)

      // Edit ▸ When Saving Fill & Sign Items ▸ Lock Them Into the Page: the next save locks without asking.
      await menuClickSub(app, 'Edit', 'When Saving Fill & Sign Items', 'Lock Them Into the Page')
      await clickTool(page, 'forms.stampDot')
      await page.mouse.click(pb.x + 280, pb.y + 250)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dot(page)).toHaveCount(0)
      saved = await PDFDocument.load(readFileSync(path))
      expect(saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0).toBe(0)
      // What was locked is part of the page now: the typed text reads as page text.
      await menuClick(app, 'File', 'Reload from Disk')
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Confirmed by clicking elsewhere')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('click-to-place tools preview what a click adds, where it lands and at its size', async () => {
    const { app, page } = await open()
    try {
      const page1 = page.locator('[data-page="1"]')
      await clickTool(page, 'markup.stamp')
      const at = await pdfPoint(page, 300, 400)
      await page.mouse.move(at.x, at.y)
      await expect(ghost(page)).toHaveAttribute('data-ghost', 'stamp')
      const g = (await ghost(page).boundingBox())!
      expect(Math.abs(g.x + g.width / 2 - at.x)).toBeLessThan(2) // centred on the pointer
      expect(Math.abs(g.y + g.height / 2 - at.y)).toBeLessThan(2)
      // Leaving the page hides it.
      const pb = (await page1.boundingBox())!
      await page.mouse.move(pb.x - 30, pb.y + 40)
      await expect(ghost(page)).toHaveCount(0)
      // The placed stamp is where, and as big as, the preview said (within the word-width rounding).
      await page.mouse.move(at.x, at.y)
      await expect(ghost(page)).toBeVisible()
      await page.mouse.click(at.x, at.y)
      await expect(frame(page)).toHaveAttribute('aria-label', /Selected Stamp/)
      const f = (await frame(page).boundingBox())!
      expect(Math.abs(f.width - g.width)).toBeLessThan(6)
      expect(Math.abs(f.height - g.height)).toBeLessThan(3)
      expect(Math.abs(f.x + f.width / 2 - at.x)).toBeLessThan(4)

      await clickTool(page, 'markup.note')
      await page.mouse.move(at.x + 5, at.y + 60)
      await expect(ghost(page)).toHaveAttribute('data-ghost', 'note')
      await clickTool(page, 'markup.textbox')
      await page.mouse.move(at.x, at.y + 80)
      await expect(ghost(page)).toHaveAttribute('data-ghost', 'textbox')

      // Fill & sign marks too.
      await clickTool(page, 'forms.stampCheck')
      await page.mouse.move(at.x, at.y + 100)
      await expect(ghost(page)).toHaveAttribute('data-ghost', 'check')
      await clickTool(page, 'forms.stampDate')
      await page.mouse.move(at.x, at.y + 110)
      await expect(ghost(page)).toHaveAttribute('data-ghost', 'date')
      await clickTool(page, 'forms.addText')
      await page.mouse.move(at.x, at.y + 120)
      await expect(ghost(page)).toHaveAttribute('data-ghost', 'text')

      // No tool, no preview.
      await page.keyboard.press('Escape')
      await page.mouse.move(at.x, at.y + 130)
      await expect(ghost(page)).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a signature previews at its placing size under the pointer', async () => {
    const { app, page } = await open('flat.pdf')
    try {
      await menuClick(app, 'Tools', 'Signatures…')
      const dialog = page.getByRole('dialog', { name: 'Signatures' })
      const pad = page.getByTestId('signature-pad')
      const box = (await pad.boundingBox())!
      await page.mouse.move(box.x + 60, box.y + 100)
      await page.mouse.down()
      for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 60 + i * 30, box.y + 100 + (i % 2 ? -40 : 40), { steps: 2 })
      await page.mouse.up()
      await dialog.getByLabel('Name', { exact: true }).fill('Preview test')
      await dialog.getByRole('button', { name: 'Save signature' }).click()
      await expect(dialog.getByTestId('signature-list')).toContainText('Preview test')
      await dialog.getByRole('button', { name: 'Close' }).click()

      await clickTool(page, 'sign.signature')
      const pb = (await page.locator('[data-page="1"]').boundingBox())!
      const at = { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 }
      await page.mouse.move(at.x, at.y)
      await expect(ghost(page)).toHaveAttribute('data-ghost', 'signature')
      const g = (await ghost(page).boundingBox())!
      expect(Math.abs(g.x + g.width / 2 - at.x)).toBeLessThan(2)
      // 150 pt wide, like the box a click opens.
      expect(Math.abs(g.width - (150 / 612) * pb.width)).toBeLessThan(2)
      await page.mouse.click(at.x, at.y)
      await expect(ghost(page)).toHaveCount(0) // the placement box takes over
    } finally {
      await quitDiscarding(app, page)
    }
  })
})
