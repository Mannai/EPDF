import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRadioGroup, PDFTextField } from 'pdf-lib'
import { FIX, axeViolations, copyFixture, launch, menuClick, quitDiscarding } from './helpers'

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/forms-signing.mjs', resolve(FIX)], { stdio: 'inherit' })
  execFileSync(process.execPath, ['tests/fixtures/form-builder.mjs', resolve(FIX)], { stdio: 'inherit' })
})

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

const N = PDFName.of
const undoBtn = (page: Page, label?: string | RegExp) => page.getByRole('button', { name: label ?? /^Undo/ })
const redoBtn = (page: Page, label?: string | RegExp) => page.getByRole('button', { name: label ?? /^Redo/ })
const dot = (page: Page) => page.getByTestId('unsaved-dot')
const save = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dot(page)).toHaveCount(0)
}
const loadSaved = async (path: string): Promise<PDFDocument> => PDFDocument.load(readFileSync(path))
const tool = (page: Page, label: string) => page.locator('button[data-tool]', { hasText: label })
const dark = (app: ElectronApplication, on: boolean) => app.evaluate(({ nativeTheme }, v) => void (nativeTheme.themeSource = v ? 'dark' : 'light'), on)
const fieldCount = (page: Page) => page.getByTestId('fb-field-count')
const panel = (page: Page) => page.getByTestId('fb-panel')

/** Runs axe over the whole UI including the page overlays (the shared helper skips `.epdf-page`). */
async function axeWithOverlays(page: Page, label: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  await page.evaluate(readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'))
  const found = await page.evaluate(async () => {
    type Axe = { run(ctx: unknown, opts: unknown): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> }
    const axe = (window as unknown as { axe: Axe }).axe
    const r = await axe.run(
      // Excluded: the page bitmap and text layer (document content), and the ribbon's *pressed* tool button,
      // whose accent-on-accent colours are core styling that fails contrast in dark mode.
      { exclude: [['.epdf-page > div[aria-hidden="true"]'], ['.textLayer'], ['[role="toolbar"][aria-label="Editing tools"] [aria-pressed="true"]']] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }
    )
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
  })
  return found.map((f) => `[${label}] ${f}`)
}

/** In a `catch`: saves a picture of the window (test-results/<test>/failure.png), then rethrows. */
async function snap(page: Page, err: unknown): Promise<never> {
  await page.screenshot({ path: test.info().outputPath('failure.png') }).catch(() => undefined)
  throw err
}

async function openDoc(files: string[], env?: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launch({ files, env })
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  return { app, page }
}

/** Center of page N in client coordinates plus helpers to convert a point in PDF space (unrotated page). */
async function pageBox(page: Page, n = 1): Promise<{ x: number; y: number; width: number; height: number }> {
  // Opening the side panel re-fits the page ("fit width"): wait until its box stops changing.
  let prev = ''
  let same = 0
  for (let i = 0; i < 60 && same < 4; i++) {
    const b = await page.locator(`[data-page="${n}"]`).boundingBox()
    const s = JSON.stringify(b)
    same = s === prev ? same + 1 : 0
    prev = s
    await page.waitForTimeout(80)
  }
  return JSON.parse(prev)
}

/** Drags a rectangle given in "visual points" (origin bottom-left of an unrotated 612x792 page, y up). */
async function drawOnPage(page: Page, x0: number, y0: number, x1: number, y1: number, n = 1, size: [number, number] = [612, 792]): Promise<void> {
  const b = await pageBox(page, n)
  const sx = b.width / size[0]
  const sy = b.height / size[1]
  const px = (x: number): number => b.x + x * sx
  const py = (y: number): number => b.y + (size[1] - y) * sy
  await page.mouse.move(px(x0), py(y1))
  await page.mouse.down()
  await page.mouse.move((px(x0) + px(x1)) / 2, (py(y1) + py(y0)) / 2, { steps: 4 })
  await page.mouse.move(px(x1), py(y0), { steps: 4 })
  await page.mouse.up()
}

// ---------------------------------------------------------------------------------------------------------
// automatic detection
// ---------------------------------------------------------------------------------------------------------

test.describe('automatic field detection', () => {
  test('detect, review (threshold, kinds, adjust, reject), create as ONE undo step, save, reopen and fill', async () => {
    const path = copyFixture('fb-detect.pdf')
    const { app, page } = await openDoc([path])
    try {
      await menuClick(app, 'Tools', 'Detect Form Fields…')
      const dlg = page.getByRole('dialog', { name: 'Detect Form Fields' })
      await expect(dlg).toBeVisible()
      await dlg.getByTestId('fb-detect-start').click()
      const review = page.getByTestId('fb-detect')
      await expect(review).toBeVisible({ timeout: 60_000 })
      const rows = page.getByTestId('fb-proposals').getByRole('listitem')
      await expect(rows).toHaveCount(9)
      await expect(page.getByTestId('fb-detect-summary')).toContainText('9 of 9 suggestions shown')
      // Every suggestion is drawn on the page with a visible tag (kind + confidence), not by colour alone.
      await expect(page.locator('[data-testid^="fb-proposal-"]')).toHaveCount(9)
      await expect(page.locator('[data-testid^="fb-proposal-"]').first()).toContainText('%')

      // Confidence threshold: at 100% nothing is sure enough; back at 50% all nine are.
      const slider = page.locator('#fb-threshold')
      await slider.focus()
      await page.keyboard.press('End')
      await expect(rows).toHaveCount(0)
      await page.keyboard.press('Home')
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
      await expect(page.getByTestId('fb-threshold-value')).toHaveText('50%')
      await expect(rows).toHaveCount(9)

      // Per-kind toggles.
      await page.getByLabel(/^Signature field \(/).uncheck()
      await expect(rows).toHaveCount(8)
      await page.getByLabel(/^Signature field \(/).check()
      await expect(rows).toHaveCount(9)

      // Adjust: rename one, move another with the keyboard, reject a third.
      await rows.filter({ hasText: 'Full_name' }).getByRole('button').click()
      await expect(page.getByTestId('fb-proposal-editor')).toBeVisible()
      await page.getByTestId('fb-proposal-name').fill('Applicant')
      await page.getByTestId('fb-proposal-name').press('Enter')
      await expect(rows.filter({ hasText: 'Applicant' })).toHaveCount(1)

      await rows.filter({ hasText: 'City' }).getByRole('button').click()
      const cityFrame = page.locator('[data-testid^="fb-proposal-"][aria-label*="“City”"]')
      await cityFrame.focus()
      await page.keyboard.press('Shift+ArrowRight') // +10 pt
      await page.keyboard.press('Shift+ArrowDown') // -10 pt

      await rows.filter({ hasText: 'City' }).getByLabel(/^Select suggestion/).uncheck()
      await rows.filter({ hasText: 'Comments' }).getByLabel(/^Select suggestion/).check()
      await page.getByTestId('fb-reject-selected').click()
      await expect(rows).toHaveCount(8)
      await expect(page.getByTestId('fb-detect-summary')).toContainText('8 of 8')

      // Nothing has been added to the document so far.
      await expect(dot(page)).toHaveCount(0)

      // Create all shown: one undo step.
      await page.getByTestId('fb-accept-all').click()
      await expect(fieldCount(page)).toContainText('Fields (8)', { timeout: 30_000 })
      await expect(undoBtn(page, 'Undo Add 8 detected form fields')).toBeEnabled()
      await expect(page.getByTestId('fb-detect')).toHaveCount(0)

      await undoBtn(page).click()
      await expect(fieldCount(page)).toContainText('Fields (0)')
      await redoBtn(page, 'Redo Add 8 detected form fields').click()
      await expect(fieldCount(page)).toContainText('Fields (8)')

      await save(page)
      const pdf = await loadSaved(path)
      const form = pdf.getForm()
      expect(form.getFields().map((f) => f.getName()).sort()).toEqual(
        ['Applicant', 'City', 'Date_of_birth', 'Email', 'I_agree_to_the_terms', 'Level', 'Send_me_the_newsletter', 'Signature'].sort()
      )
      expect(form.getFieldMaybe('Comments')).toBeUndefined() // rejected
      // City was moved by (+10, -10) points from where it was detected (the box is 90,578 - 250,600).
      const city = form.getTextField('City').acroField.getWidgets()[0].getRectangle()
      expect(city.x).toBeCloseTo(100, 0)
      expect(city.y).toBeCloseTo(568, 0)
      expect(city.width).toBeCloseTo(160, 0)
      // Real objects: appearance streams, tooltips from the labels, a date format script, exclusive radio kids.
      const applicant = form.getTextField('Applicant')
      expect(applicant.acroField.getWidgets()[0].dict.has(N('AP'))).toBe(true)
      expect(applicant.acroField.dict.lookup(N('TU'))?.toString()).toContain('FEFF')
      const dob = form.getTextField('Date_of_birth')
      expect(dob.acroField.dict.lookup(N('AA'), PDFDict).has(N('F'))).toBe(true)
      expect(form.getRadioGroup('Level').getOptions()).toEqual(['Basic', 'Plus', 'Pro'])
      expect(form.getSignature('Signature')).toBeTruthy()
    } finally {
      await app.close()
    }

    // Reopen: the created fields are fillable in Epdf's own form overlay (preview = the normal behaviour).
    const again = await openDoc([path])
    try {
      const p = again.page
      await expect(p.getByTestId('form-banner')).toContainText('This form has 8 fields')
      const name = p.getByLabel('Full name', { exact: true })
      await name.fill('Ada Lovelace')
      await name.press('Enter')
      await expect(undoBtn(p, 'Undo Fill “Full name”')).toBeEnabled()
      await p.getByLabel('Email', { exact: true }).fill('ada@example.org')
      await p.getByLabel('Email', { exact: true }).press('Enter')
      const birth = p.getByLabel('Date of birth', { exact: true })
      await birth.fill('99/99/2020')
      await birth.press('Enter')
      await expect(p.getByRole('alert').or(p.locator('[role="status"]')).filter({ hasText: /valid date/ }).first()).toBeVisible()
      await birth.fill('31/12/1990')
      await birth.press('Enter')
      await p.getByLabel('I agree to the terms', { exact: true }).check()
      await p.getByLabel('Level: Plus', { exact: true }).check()
      await save(p)
      const pdf = await loadSaved(path)
      const form = pdf.getForm()
      expect(form.getTextField('Applicant').getText()).toBe('Ada Lovelace')
      expect(form.getTextField('Date_of_birth').getText()).toBe('31/12/1990')
      expect(form.getCheckBox('I_agree_to_the_terms').isChecked()).toBe(true)
      expect(form.getRadioGroup('Level').getSelected()).toBe('Plus')
    } finally {
      await again.app.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// manual tools
// ---------------------------------------------------------------------------------------------------------

const drawTool = async (page: Page, id: string, rect: [number, number, number, number]): Promise<void> => {
  const btn = page.locator(`button[data-tool="${id}"]`)
  await btn.click()
  await expect(btn).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('fb-create-layer').first()).toBeVisible()
  await drawOnPage(page, ...rect)
}

test.describe('manual field tools', () => {
  test('every field type can be drawn; undo/redo; the saved file has real fields of each type', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await openDoc([path])
    try {
      // The tools live in their own ribbon group.
      await expect(page.getByRole('group', { name: 'Form builder' })).toBeVisible()
      await drawTool(page, 'formbuilder.text', [72, 700, 272, 722])
      await expect(fieldCount(page)).toContainText('Fields (1)', { timeout: 20_000 })
      await expect(undoBtn(page, 'Undo Add text field')).toBeEnabled()
      // After drawing, the tool returns to "Edit fields" and the new field is selected with its properties showing.
      await expect(page.locator('button[data-tool="formbuilder.select"]')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('fb-properties')).toHaveAttribute('data-field', 'Text1')

      await drawTool(page, 'formbuilder.checkbox', [72, 650, 86, 664])
      await expect(fieldCount(page)).toContainText('Fields (2)')
      await drawTool(page, 'formbuilder.dropdown', [72, 610, 212, 632])
      await expect(fieldCount(page)).toContainText('Fields (3)')
      await drawTool(page, 'formbuilder.list', [240, 560, 380, 632])
      await expect(fieldCount(page)).toContainText('Fields (4)')
      await drawTool(page, 'formbuilder.date', [72, 570, 212, 592])
      await expect(fieldCount(page)).toContainText('Fields (5)')
      await drawTool(page, 'formbuilder.signature', [72, 500, 272, 544])
      await expect(fieldCount(page)).toContainText('Fields (6)')
      await drawTool(page, 'formbuilder.button', [400, 700, 490, 726])
      await expect(fieldCount(page)).toContainText('Fields (7)')

      // Radio tool: the buttons drawn one after another join one group; "New group" starts another.
      await drawTool(page, 'formbuilder.radio', [72, 460, 86, 474])
      await expect(page.getByTestId('fb-radio-group')).toContainText('Adding to “Radio_Group1”')
      await drawOnPage(page, 120, 460, 134, 474)
      await drawOnPage(page, 168, 460, 182, 474)
      await expect(fieldCount(page)).toContainText('Fields (8)')
      await page.getByRole('button', { name: 'New group' }).click()
      await drawOnPage(page, 72, 430, 86, 444)
      await expect(fieldCount(page)).toContainText('Fields (9)')
      await page.keyboard.press('Escape') // leaves the tool: the panel switches to Preview
      await expect(page.getByTestId('fb-preview')).toBeVisible()
      await page.getByTestId('fb-mode-edit').click()
      await expect(fieldCount(page)).toContainText('Fields (9)')

      // Undo one step, redo it.
      await undoBtn(page, 'Undo Add radio button').click()
      await expect(fieldCount(page)).toContainText('Fields (8)')
      await redoBtn(page, 'Redo Add radio button').click()
      await expect(fieldCount(page)).toContainText('Fields (9)')

      await save(page)
      const pdf = await loadSaved(path)
      const form = pdf.getForm()
      const kinds = Object.fromEntries(form.getFields().map((f) => [f.getName(), f.constructor.name]))
      expect(kinds).toEqual({
        Text1: 'PDFTextField',
        Check_Box1: 'PDFCheckBox',
        Dropdown1: 'PDFDropdown',
        List_Box1: 'PDFOptionList',
        Date1: 'PDFTextField',
        Signature1: 'PDFSignature',
        Button1: 'PDFButton',
        Radio_Group1: 'PDFRadioGroup',
        Radio_Group2: 'PDFRadioGroup'
      })
      const radios = form.getRadioGroup('Radio_Group1')
      expect(radios.getOptions()).toEqual(['Choice1', 'Choice2', 'Choice3'])
      expect(radios.acroField.getWidgets()).toHaveLength(3)
      // Position: drawn from (72,700) to (272,722) in PDF space.
      const r = form.getTextField('Text1').acroField.getWidgets()[0].getRectangle()
      expect(r.x).toBeGreaterThan(68)
      expect(r.x).toBeLessThan(76)
      expect(r.width).toBeGreaterThan(190)
      expect(r.width).toBeLessThan(210)
      expect(form.getDropdown('Dropdown1').getOptions()).toEqual(['Option 1', 'Option 2', 'Option 3'])
      expect(form.getTextField('Date1').acroField.dict.lookup(N('AA'), PDFDict).has(N('F'))).toBe(true)
      for (const f of form.getFields()) for (const w of f.acroField.getWidgets()) expect(w.dict.has(N('AP')), f.getName()).toBe(true)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('keyboard: add from the panel, move / resize / copy / paste / duplicate / delete, align and same size', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await openDoc([path])
    try {
      await menuClick(app, 'Tools', 'Prepare Form…')
      await expect(page.getByTestId('fb-panel')).toBeVisible()
      const addText = panel(page).getByRole('button', { name: 'Text field', exact: true })
      await addText.click()
      await expect(fieldCount(page)).toContainText('Fields (1)', { timeout: 20_000 })
      // The new field's name box has the focus (keyboard users can rename right away).
      await expect(page.locator('[data-fb-name-input]')).toBeFocused()
      await addText.click()
      await addText.click()
      await expect(fieldCount(page)).toContainText('Fields (3)')

      // Focus the frame of the first field: arrow keys move it by 1 pt, Shift by 10 pt, Alt+arrows resize it.
      const frame = page.getByTestId('fb-field-Text1')
      await frame.focus()
      await page.keyboard.press('Shift+ArrowRight')
      await page.keyboard.press('ArrowUp') // key presses that follow each other are ONE undo step
      await expect(undoBtn(page, 'Undo Move “Text1”')).toBeEnabled({ timeout: 15_000 })
      await expect(frame).toBeFocused() // focus survives the reload that follows every edit
      await page.keyboard.press('Alt+Shift+ArrowRight')
      await expect(undoBtn(page, 'Undo Resize “Text1”')).toBeEnabled({ timeout: 15_000 })
      // Copy, paste (goes to the same page, offset), duplicate.
      await page.getByTestId('fb-field-Text1').focus()
      await page.keyboard.press('Control+c')
      await page.keyboard.press('Control+v')
      await expect(fieldCount(page)).toContainText('Fields (4)', { timeout: 15_000 })
      await page.getByTestId('fb-field-Text1').focus()
      await page.keyboard.press('Control+d')
      await expect(fieldCount(page)).toContainText('Fields (5)', { timeout: 15_000 })

      // Multi-select with Shift+click on list rows... then align left, same size, distribute.
      const rowsList = page.getByTestId('fb-field-list')
      const row = (n: string): Locator => rowsList.locator(`[data-field-row="${n}"]`)
      await row('Text2').click()
      await row('Text3').click({ modifiers: ['Shift'] })
      await row('Text1_2').click({ modifiers: ['Shift'] })
      await expect(page.getByTestId('fb-multi')).toContainText('3 fields selected')
      await page.getByLabel('Align selected fields').selectOption('left')
      await expect(undoBtn(page, 'Undo Align left')).toBeEnabled({ timeout: 15_000 })
      await page.getByLabel('Distribute selected fields').selectOption('vertical')
      await expect(undoBtn(page, 'Undo Distribute vertically')).toBeEnabled({ timeout: 15_000 })
      await page.getByLabel('Give selected fields the same size as the first').selectOption('both')
      await expect(undoBtn(page, 'Undo Same size')).toBeEnabled({ timeout: 15_000 })

      // Delete removes the selection as one step.
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(fieldCount(page)).toContainText('Fields (2)', { timeout: 15_000 })
      await expect(undoBtn(page, /^Undo Delete 3 fields/)).toBeEnabled()
      await undoBtn(page).click()
      await expect(fieldCount(page)).toContainText('Fields (5)')

      await save(page)
      const form = (await loadSaved(path)).getForm()
      const rects = form.getFields().map((f) => ({ name: f.getName(), r: f.acroField.getWidgets()[0].getRectangle() }))
      const byName = (n: string) => rects.find((x) => x.name === n)!.r
      // Text2, Text3 and the paste share their left edge and size after align/size (first selected = Text2).
      expect(byName('Text3').x).toBeCloseTo(byName('Text2').x, 1)
      expect(byName('Text1_2').x).toBeCloseTo(byName('Text2').x, 1)
      expect(byName('Text3').width).toBeCloseTo(byName('Text2').width, 1)
      expect(byName('Text1_2').height).toBeCloseTo(byName('Text2').height, 1)
      // Text1 was nudged: +10 pt right, +1 up, and 10 pt wider than the default 160.
      expect(byName('Text1').width).toBeCloseTo(170, 0)
    } catch (err) {
      await snap(page, err)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.afterAll(() => {
  void [existsSync, mkdtempSync, tmpdir, join, PDFCheckBox, PDFNumber, PDFRadioGroup, PDFTextField, axeViolations, quitDiscarding, tool, dark, panel, drawOnPage, axeWithOverlays]
  void ({} as Locator)
})
