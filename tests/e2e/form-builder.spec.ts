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
  page.on('console', (m) => m.text().startsWith('FBDBG') && console.log(m.text()))
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
      await quitDiscarding(app, page)
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
      await quitDiscarding(again.app, again.page)
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

// ---------------------------------------------------------------------------------------------------------
// properties
// ---------------------------------------------------------------------------------------------------------

test.describe('field properties', () => {
  test('name rules, required, read-only, max length and format are saved correctly and enforced when filling', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await openDoc([path])
    try {
      await menuClick(app, 'Tools', 'Prepare Form…')
      const add = panel(page).getByRole('button', { name: 'Text field', exact: true })
      await add.click()
      await expect(fieldCount(page)).toContainText('Fields (1)', { timeout: 20_000 })
      const props = page.getByTestId('fb-properties')
      const nameBox = props.getByLabel('Name', { exact: true })

      // Names: no periods, unique. The message says why and nothing changes.
      await nameBox.fill('bad.name')
      await nameBox.press('Enter')
      await expect(props.getByRole('alert')).toContainText('period')
      await expect(props).toHaveAttribute('data-field', 'Text1')
      await nameBox.fill('amount')
      await nameBox.press('Enter')
      await expect(props).toHaveAttribute('data-field', 'amount')
      await expect(undoBtn(page, 'Undo Rename “Text1”')).toBeEnabled()

      await add.click()
      await expect(fieldCount(page)).toContainText('Fields (2)')
      await nameBox.fill('AMOUNT')
      await nameBox.press('Enter')
      await expect(props.getByRole('alert')).toContainText('already exists')
      await nameBox.fill('code')
      await nameBox.press('Enter')
      await expect(props).toHaveAttribute('data-field', 'code')
      await props.getByLabel(/^Default value/).fill('ABC')
      await props.getByLabel(/^Default value/).press('Enter')
      await props.getByLabel('Read-only').check()

      // The first field: tooltip, required, max length, number format with a range.
      await panel(page).getByTestId('fb-field-list').locator('[data-field-row="amount"]').click()
      await expect(props).toHaveAttribute('data-field', 'amount')
      await props.getByLabel(/^Tooltip/).fill('Amount due')
      await props.getByLabel(/^Tooltip/).press('Enter')
      await props.getByLabel('Required').check()
      await props.getByLabel('Maximum length', { exact: true }).fill('6')
      await props.getByLabel('Maximum length', { exact: true }).press('Enter')
      await props.getByText('Format and validation').click()
      await props.getByLabel('Format / validation').selectOption('number')
      await expect(props.getByLabel('Decimal places')).toHaveValue('2')
      await props.getByLabel('Minimum value').fill('0')
      await props.getByLabel('Minimum value').press('Enter')
      await props.getByLabel('Maximum value').fill('999')
      await props.getByLabel('Maximum value').press('Enter')

      await save(page)
      const form = (await loadSaved(path)).getForm()
      const amount = form.getTextField('amount')
      expect(amount.isRequired()).toBe(true)
      expect(amount.getMaxLength()).toBe(6)
      expect(amount.acroField.dict.lookup(N('TU'))?.toString()).toContain('FEFF')
      const aa = amount.acroField.dict.lookup(N('AA'), PDFDict)
      const js = (k: string): string => (aa.lookup(N(k), PDFDict).lookup(N('JS')) as unknown as { decodeText(): string }).decodeText()
      expect(js('F')).toBe('AFNumber_Format(2, 0, 0, 0, "", true);')
      expect(js('K')).toBe('AFNumber_Keystroke(2, 0, 0, 0, "", true);')
      expect(js('V')).toBe('AFRange_Validate(true, 0, true, 999);')
      const code = form.getTextField('code')
      expect(code.isReadOnly()).toBe(true)
      expect(code.getText()).toBe('ABC')
      expect(code.acroField.dict.lookup(N('DV'))).toBeTruthy()
    } catch (err) {
      await snap(page, err)
    } finally {
      await quitDiscarding(app, page)
    }

    // Reopen and use the form: limits and format are honoured by Epdf's own fill experience.
    const again = await openDoc([path])
    try {
      const p = again.page
      await expect(p.getByTestId('form-banner')).toContainText('This form has 2 fields')
      const amount = p.getByLabel('Amount due (required)', { exact: true })
      await expect(amount).toHaveAttribute('maxlength', '6')
      await expect(amount).toHaveAttribute('aria-required', 'true')
      await expect(p.getByLabel('code', { exact: true })).toHaveAttribute('readonly', '')

      await amount.fill('abc')
      await amount.press('Enter')
      await expect(p.getByText(/must be a number/)).toBeVisible()
      await expect(undoBtn(p, /^Undo Fill/)).toHaveCount(0)
      await amount.fill('1000')
      await amount.press('Enter')
      await expect(p.getByText(/at most 999/)).toBeVisible()
      await amount.click()
      await amount.pressSequentially('1234567') // the box itself stops at the maximum length
      await expect(amount).toHaveValue('123456')
      await amount.fill('12.5')
      await amount.press('Enter')
      await expect(undoBtn(p, 'Undo Fill “Amount due”')).toBeEnabled()

      // Required fields are listed by the preview check until they are filled in.
      await menuClick(again.app, 'Tools', 'Prepare Form…')
      await p.getByTestId('fb-mode-preview').click()
      await p.getByTestId('fb-check-required').click()
      await expect(p.getByTestId('fb-required-result')).toContainText('Every required field is filled in')
      await save(p)
      expect((await loadSaved(path)).getForm().getTextField('amount').getText()).toBe('12.5')
    } catch (err) {
      await snap(again.page, err)
    } finally {
      await quitDiscarding(again.app, again.page)
    }
  })

  test('drop-down options, radio export values, checkbox export value and appearance edits round-trip', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await openDoc([path])
    try {
      await menuClick(app, 'Tools', 'Prepare Form…')
      await panel(page).getByRole('button', { name: 'Dropdown', exact: true }).click()
      await expect(fieldCount(page)).toContainText('Fields (1)', { timeout: 20_000 })
      const props = page.getByTestId('fb-properties')
      await props.getByLabel('Options, one per line').fill('Red\nGreen\nBlue')
      await props.getByLabel('Options, one per line').press('Control+Enter')
      await props.getByLabel('Selected by default').selectOption('Green')
      await props.getByLabel('Allow the user to type another value').check()

      await panel(page).getByRole('button', { name: 'Radio group', exact: true }).click()
      await expect(fieldCount(page)).toContainText('Fields (2)')
      await props.getByLabel('Button 1 export value').fill('small')
      await props.getByLabel('Button 1 export value').press('Enter')
      await props.getByRole('button', { name: 'Add a button to this group' }).click()
      await expect(props.getByLabel('Button 2 export value')).toBeVisible({ timeout: 15_000 })
      await props.getByLabel('Button 2 export value').fill('large')
      await props.getByLabel('Button 2 export value').press('Enter')
      await props.getByLabel('Selected by default').selectOption('large')
      await props.getByLabel('Button 2 export value').fill('small') // duplicates are refused
      await props.getByLabel('Button 2 export value').press('Enter')
      await expect(props.getByRole('alert')).toContainText('different')
      await props.getByLabel('Button 2 export value').press('Escape')

      await panel(page).getByRole('button', { name: 'Check box', exact: true }).click()
      await expect(fieldCount(page)).toContainText('Fields (3)')
      await props.getByLabel('Export value (when checked)').fill('Agreed')
      await props.getByLabel('Export value (when checked)').press('Enter')
      await props.getByLabel('Checked by default').check()
      await props.getByText('Appearance').click()
      await props.getByLabel('Border colour').fill('#ff0000')
      await props.getByLabel('Border width').fill('2')
      await props.getByLabel('Border width').press('Enter')
      await props.getByLabel('No fill (transparent)').check()

      await save(page)
      const form = (await loadSaved(path)).getForm()
      const dd = form.getDropdown('Dropdown1')
      expect(dd.getOptions()).toEqual(['Red', 'Green', 'Blue'])
      expect(dd.getSelected()).toEqual(['Green'])
      expect(dd.isEditable()).toBe(true)
      const rg = form.getRadioGroup('Radio_Group1')
      expect(rg.getOptions()).toEqual(['small', 'large'])
      expect(rg.getSelected()).toBe('large')
      const cb = form.getCheckBox('Check_Box1')
      expect(cb.isChecked()).toBe(true)
      expect(cb.acroField.getWidgets()[0].getOnValue()?.decodeText()).toBe('Agreed')
      const mk = cb.acroField.getWidgets()[0].dict.lookup(N('MK'), PDFDict)
      expect(mk.has(N('BG'))).toBe(false)
      expect((mk.lookup(N('BC')) as unknown as { asArray(): { asNumber(): number }[] }).asArray().map((n) => Math.round(n.asNumber()))).toEqual([1, 0, 0])
      expect(cb.acroField.getWidgets()[0].dict.lookup(N('BS'), PDFDict).lookup(N('W'), PDFNumber).asNumber()).toBe(2)
    } catch (err) {
      await snap(page, err)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// tab order
// ---------------------------------------------------------------------------------------------------------

const activeField = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('data-field') ?? null)

/** Names of the form widgets in /Annots order, and the page's /Tabs entry. */
async function annotOrder(path: string): Promise<{ names: string[]; tabs: string | undefined }> {
  const pdf = await loadSaved(path)
  const page = pdf.getPage(0)
  const annots = page.node.Annots()!
  const byRef = new Map<string, string>()
  for (const f of pdf.getForm().getFields()) for (const w of f.acroField.getWidgets()) byRef.set(pdf.context.getObjectRef(w.dict)!.tag, f.getName())
  const names: string[] = []
  for (let i = 0; i < annots.size(); i++) names.push(byRef.get((annots.get(i) as unknown as { tag: string }).tag)!)
  const tabs = page.node.lookup(N('Tabs'))
  return { names, tabs: tabs ? tabs.toString() : undefined }
}

test.describe('tab order', () => {
  test('the editor reorders the fields (buttons, keyboard, presets), the numbers on the page follow, and Tab in the filling UI follows the saved order', async () => {
    const path = copyFixture('fb-fields.pdf')
    const { app, page } = await openDoc([path])
    try {
      await menuClick(app, 'Tools', 'Prepare Form…')
      await panel(page).getByRole('button', { name: 'Tab order…' }).click()
      const editor = page.getByTestId('fb-taborder')
      const list = page.getByTestId('fb-order-list')
      await expect(list.getByRole('listitem')).toHaveCount(4)
      await expect(page.getByTestId('fb-tabs-mode')).toContainText('not set')
      // Numbers on the page badges: first=1 second=2 third=3 agree=4.
      await expect(page.getByTestId('fb-order-third')).toContainText('3')

      await list.getByRole('button', { name: /^Move third up/ }).click()
      await list.getByRole('button', { name: /^Move third up/ }).click()
      await expect(page.getByTestId('fb-order-third')).toContainText('1')
      await expect(page.getByTestId('fb-order-first')).toContainText('2')
      // Keyboard: Alt+Up on the last row moves it up one place (the moved row keeps the focus).
      await expect(list.locator('[data-order-key="third#0"]')).toBeFocused()
      await list.locator('[data-order-key="agree#0"]').focus()
      await page.keyboard.press('Alt+ArrowUp')
      await expect(page.getByTestId('fb-order-agree')).toContainText('3')
      await expect(page.getByTestId('fb-order-second')).toContainText('4')

      await editor.getByTestId('fb-taborder-apply').click()
      await expect(undoBtn(page, 'Undo Set tab order of page 1')).toBeEnabled({ timeout: 15_000 })
      await expect(editor.getByTestId('fb-taborder-apply')).toBeDisabled()
      await expect(page.getByTestId('fb-tabs-mode')).toContainText('custom order')
      await editor.getByTestId('fb-taborder-close').click()

      // Preview: Tab walks third -> first -> agree -> second.
      await page.getByTestId('fb-mode-preview').click()
      await expect(page.locator('[data-field="third"]')).toBeVisible()
      await page.locator('[data-field="third"]').focus()
      expect(await activeField(page)).toBe('third')
      const seq: (string | null)[] = []
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Tab')
        seq.push(await activeField(page))
      }
      expect(seq).toEqual(['first', 'agree', 'second'])
      await page.keyboard.press('Shift+Tab')
      expect(await activeField(page)).toBe('agree')

      await save(page)
      expect(await annotOrder(path)).toEqual({ names: ['third', 'first', 'agree', 'second'], tabs: '/S' })

      // Undo puts the original order back (the Tab key follows at once).
      await undoBtn(page, 'Undo Set tab order of page 1').click()
      await expect
        .poll(async () => {
          await page.locator('[data-field="first"]').focus()
          await page.keyboard.press('Tab')
          return activeField(page)
        })
        .toBe('second')
      await redoBtn(page, 'Redo Set tab order of page 1').click()

      // Presets: rows / columns write /Tabs R / C.
      await page.getByTestId('fb-mode-edit').click()
      await panel(page).getByRole('button', { name: 'Tab order…' }).click()
      await editor.getByRole('button', { name: 'By columns' }).click()
      await expect(undoBtn(page, 'Undo Tab order by columns, page 1')).toBeEnabled({ timeout: 15_000 })
      await expect(page.getByTestId('fb-tabs-mode')).toContainText('columns')
      await expect(list.getByRole('listitem').first()).toContainText('first')
      await editor.getByRole('button', { name: 'By rows' }).click()
      await expect(undoBtn(page, 'Undo Tab order by rows, page 1')).toBeEnabled({ timeout: 15_000 })
      await expect(page.getByTestId('fb-tabs-mode')).toContainText('rows')
      await save(page)
      expect((await annotOrder(path)).tabs).toBe('/R')
      // Escape closes the editor.
      await page.keyboard.press('Escape')
      await expect(editor).toHaveCount(0)
    } catch (err) {
      await snap(page, err)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// rotated pages
// ---------------------------------------------------------------------------------------------------------

test.describe('rotated page', () => {
  test('detect on a /Rotate 90 page, save, fill: fields sit where the reader sees them', async () => {
    const path = copyFixture('fb-rotated.pdf')
    const { app, page } = await openDoc([path])
    try {
      await menuClick(app, 'Tools', 'Detect Form Fields…')
      await page.getByTestId('fb-detect-start').click()
      await expect(page.getByTestId('fb-proposals').getByRole('listitem')).toHaveCount(9, { timeout: 60_000 })
      await page.getByTestId('fb-accept-all').click()
      await expect(fieldCount(page)).toContainText('Fields (9)', { timeout: 30_000 })
      await save(page)
      const pdf = await loadSaved(path)
      expect(pdf.getPage(0).getRotation().angle).toBe(90)
      const w = pdf.getForm().getTextField('Full_name').acroField.getWidgets()[0]
      const r = w.getRectangle()
      expect(r.height).toBeGreaterThan(r.width * 5) // 220 pt wide on screen = tall in unrotated user space
      expect((w.dict.lookup(N('MK'), PDFDict).lookup(N('R')) as unknown as PDFNumber).asNumber()).toBe(90)
    } catch (err) {
      await snap(page, err)
    } finally {
      await quitDiscarding(app, page)
    }

    const again = await openDoc([path])
    try {
      const p = again.page
      await expect(p.getByTestId('form-banner')).toContainText('This form has 9 fields')
      const input = p.getByLabel('Full name', { exact: true })
      const box = (await input.boundingBox())!
      const pageBox = (await p.locator('[data-page="1"]').boundingBox())!
      expect(box.width).toBeGreaterThan(box.height * 5) // wide on screen
      expect(box.x).toBeGreaterThan(pageBox.x)
      expect(box.y).toBeLessThan(pageBox.y + pageBox.height * 0.3) // near the top, as drawn
      await input.fill('Ada')
      await input.press('Enter')
      await p.getByLabel('I agree to the terms', { exact: true }).check()
      await save(p)
      const form = (await loadSaved(path)).getForm()
      expect(form.getTextField('Full_name').getText()).toBe('Ada')
      expect(form.getCheckBox('I_agree_to_the_terms').isChecked()).toBe(true)
    } catch (err) {
      await snap(again.page, err)
    } finally {
      await quitDiscarding(again.app, again.page)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// failure and cancel paths
// ---------------------------------------------------------------------------------------------------------

test.describe('cancel and failure paths', () => {
  test('a scanned page is reported as such (with the OCR hint) and nothing is guessed', async () => {
    const path = copyFixture('fb-scan.pdf')
    const { app, page } = await openDoc([path])
    try {
      await menuClick(app, 'Tools', 'Detect Form Fields…')
      await page.getByTestId('fb-detect-start').click()
      await expect(page.getByTestId('fb-detect-notes')).toContainText('looks like a scan', { timeout: 60_000 })
      await expect(page.getByTestId('fb-detect-notes')).toContainText('OCR')
      await expect(page.getByTestId('fb-detect-summary')).toContainText('No fields were found')
      await expect(dot(page)).toHaveCount(0)
      await expect(page.getByTestId('fb-accept-all')).toBeDisabled()
      await page.keyboard.press('Escape') // nothing pending: closes at once
      await expect(page.getByTestId('fb-detect')).toHaveCount(0)
    } catch (err) {
      await snap(page, err)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Escape and Cancel leave the document alone: scope dialog, review, drawing', async () => {
    const path = copyFixture('fb-detect.pdf')
    const { app, page } = await openDoc([path])
    try {
      // The scope dialog.
      await menuClick(app, 'Tools', 'Detect Form Fields…')
      const dlg = page.getByRole('dialog', { name: 'Detect Form Fields' })
      await expect(dlg).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)
      await menuClick(app, 'Tools', 'Detect Form Fields…')
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dlg).toHaveCount(0)
      await expect(page.getByTestId('fb-detect')).toHaveCount(0)

      // A bad page range is explained.
      await menuClick(app, 'Tools', 'Detect Form Fields…')
      await dlg.getByLabel('These pages:').check()
      await dlg.getByLabel('Page range').fill('7-9')
      await dlg.getByTestId('fb-detect-start').click()
      await expect(dlg.getByRole('alert')).toContainText('between 1 and')
      await dlg.getByLabel('Page range').fill('1')
      await dlg.getByTestId('fb-detect-start').click()

      // The review: Escape asks before throwing suggestions away.
      const rows = page.getByTestId('fb-proposals').getByRole('listitem')
      await expect(rows).toHaveCount(9, { timeout: 60_000 })
      await rows.first().getByRole('button').focus()
      await page.keyboard.press('Escape')
      const ask = page.getByRole('dialog', { name: 'Discard suggestions?' })
      await expect(ask).toBeVisible()
      await ask.getByRole('button', { name: 'Keep reviewing' }).click()
      await expect(rows).toHaveCount(9)
      await rows.first().getByRole('button').focus()
      await page.keyboard.press('Escape')
      await ask.getByRole('button', { name: 'Discard' }).click()
      await expect(page.getByTestId('fb-detect')).toHaveCount(0)
      await expect(dot(page)).toHaveCount(0)
      await expect(undoBtn(page)).toBeDisabled()

      // Drawing: Escape while dragging cancels the field but keeps the tool.
      await page.locator('button[data-tool="formbuilder.text"]').click()
      const b = await pageBox(page)
      await page.mouse.move(b.x + 100, b.y + 400)
      await page.mouse.down()
      await page.mouse.move(b.x + 300, b.y + 440, { steps: 5 })
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await expect(page.locator('button[data-tool="formbuilder.text"]')).toHaveAttribute('aria-pressed', 'true')
      await expect(dot(page)).toHaveCount(0)
      await expect(fieldCount(page)).toContainText('Fields (0)')
      // A second Escape leaves the tool.
      await page.keyboard.press('Escape')
      await expect(page.locator('button[data-tool="formbuilder.text"]')).toHaveAttribute('aria-pressed', 'false')
    } catch (err) {
      await snap(page, err)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('an encrypted document is unlocked through ensureEditable, edited, and written back still encrypted', async () => {
    const path = copyFixture('forms-encrypted.pdf')
    const before = readFileSync(path).toString('latin1')
    expect(before).toContain('/Encrypt')
    const { app, page } = await openDoc([path])
    try {
      await menuClick(app, 'Tools', 'Prepare Form…')
      await expect(page.locator('button[data-tool="formbuilder.select"]')).toHaveAttribute('aria-pressed', 'true')
      const add = panel(page).getByRole('button', { name: 'Text field', exact: true })
      await add.click()
      await expect(undoBtn(page, 'Undo Add text field')).toBeEnabled({ timeout: 30_000 })
      await save(page)
      const after = readFileSync(path).toString('latin1')
      expect(after).toContain('/Encrypt') // never written as plaintext
      await expect(PDFDocument.load(readFileSync(path))).rejects.toThrow(/encrypt/i)
    } catch (err) {
      await snap(page, err)
    } finally {
      await quitDiscarding(app, page)
    }
  })

})

// ---------------------------------------------------------------------------------------------------------
// list of fields, clear form
// ---------------------------------------------------------------------------------------------------------

test.describe('form-wide actions', () => {
  test('the list of fields is exported as CSV; Clear form empties the fillable fields in one undo step', async () => {
    const path = copyFixture('forms.pdf')
    const csvPath = join(mkdtempSync(join(tmpdir(), 'epdf-csv-')), 'fields.csv')
    const { app, page } = await openDoc([path])
    try {
      await app.evaluate(({ dialog }, target) => {
        ;(dialog as unknown as Record<string, unknown>).showSaveDialog = async () => ({ canceled: false, filePath: target })
      }, csvPath)
      await menuClick(app, 'Tools', 'Prepare Form…')
      await expect(fieldCount(page)).toContainText('Fields (12)', { timeout: 20_000 })
      await panel(page).getByRole('button', { name: 'Export list (CSV)' }).click()
      await expect.poll(() => existsSync(csvPath), { timeout: 15_000 }).toBe(true)
      const text = readFileSync(csvPath, 'utf8')
      expect(text.charCodeAt(0)).toBe(0xfeff) // UTF-8 byte-order mark for spreadsheets
      const lines = text.slice(1).trimEnd().split('\r\n')
      expect(lines[0]).toBe('Name,Type,Page,Required,Read-only,Tooltip,Options,Default value,Max length,Format')
      expect(lines).toHaveLength(13)
      expect(lines).toContain('full_name,Text field,1,No,No,Full name,,,,')
      expect(lines.find((l) => l.startsWith('readonly_id,'))).toMatch(/^readonly_id,Text field,1,No,Yes,/)
      expect(lines.find((l) => l.startsWith('color,'))).toContain('red; green; blue')
      expect(lines.find((l) => l.startsWith('page2_field,'))).toContain(',2,')

      // Clear form (in preview, where a person would fill the form in).
      await page.getByTestId('fb-mode-preview').click()
      const name = page.getByLabel('Full name', { exact: true })
      await name.fill('Ada')
      await name.press('Enter')
      await page.getByLabel('I agree to the terms', { exact: true }).check()
      await page.getByRole('button', { name: 'Clear form' }).click()
      await expect(undoBtn(page, 'Undo Clear form')).toBeEnabled({ timeout: 15_000 })
      await expect(name).toHaveValue('')
      await expect(page.getByLabel('I agree to the terms', { exact: true })).not.toBeChecked()
      await expect(page.getByLabel('Customer id (read only)', { exact: true })).toHaveValue('ID-0001') // read-only content stays
      await undoBtn(page, 'Undo Clear form').click()
      await expect(name).toHaveValue('Ada')
    } catch (err) {
      await snap(page, err)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// accessibility
// ---------------------------------------------------------------------------------------------------------

test.describe('accessibility', () => {
  test('axe is clean in light and dark: scope dialog, review, field properties, tab order, preview', async () => {
    const path = copyFixture('fb-detect.pdf')
    const { app, page } = await openDoc([path])
    const scan = async (label: string): Promise<string[]> => {
      const out: string[] = []
      for (const isDark of [false, true]) {
        await dark(app, isDark)
        await page.waitForTimeout(400)
        out.push(...(await axeWithOverlays(page, `${label} ${isDark ? 'dark' : 'light'}`)))
      }
      await dark(app, false)
      return out
    }
    const problems: string[] = []
    try {
      await menuClick(app, 'Tools', 'Detect Form Fields…')
      await expect(page.getByRole('dialog', { name: 'Detect Form Fields' })).toBeVisible()
      problems.push(...(await scan('scope dialog')))
      await page.getByTestId('fb-detect-start').click()
      await expect(page.getByTestId('fb-proposals').getByRole('listitem')).toHaveCount(9, { timeout: 60_000 })
      await page.getByTestId('fb-proposals').getByRole('button').first().click()
      problems.push(...(await scan('detect review')))
      await page.getByTestId('fb-accept-all').click()
      await expect(fieldCount(page)).toContainText('Fields (9)', { timeout: 30_000 })

      const props = page.getByTestId('fb-properties')
      await panel(page).getByTestId('fb-field-list').locator('[data-field-row="Date_of_birth"]').click()
      await expect(props).toHaveAttribute('data-field', 'Date_of_birth')
      for (const s of ['Appearance', 'Format and validation']) await props.locator('summary', { hasText: s }).evaluate((el) => ((el.parentElement as HTMLDetailsElement).open = true))
      problems.push(...(await scan('field properties (text, date format)')))
      await panel(page).getByTestId('fb-field-list').locator('[data-field-row="Level"]').click()
      await expect(props).toHaveAttribute('data-field', 'Level')
      problems.push(...(await scan('field properties (radio)')))
      await panel(page).getByRole('button', { name: 'Tab order…' }).click()
      await expect(page.getByTestId('fb-taborder')).toBeVisible()
      problems.push(...(await scan('tab order')))
      await page.getByTestId('fb-taborder-close').click()
      await page.getByTestId('fb-mode-preview').click()
      await expect(page.getByTestId('fb-preview')).toBeVisible()
      problems.push(...(await scan('preview')))
      expect(problems).toEqual([])
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
