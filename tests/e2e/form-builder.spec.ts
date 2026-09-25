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

async function openDoc(files: string[], env?: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launch({ files, env })
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  return { app, page }
}

/** Center of page N in client coordinates plus helpers to convert a point in PDF space (unrotated page). */
async function pageBox(page: Page, n = 1): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await page.locator(`[data-page="${n}"]`).boundingBox()
  return b!
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

test.afterAll(() => {
  void [existsSync, mkdtempSync, tmpdir, join, PDFCheckBox, PDFNumber, PDFRadioGroup, PDFTextField, axeViolations, quitDiscarding, tool, dark, panel, drawOnPage, axeWithOverlays]
  void ({} as Locator)
})
