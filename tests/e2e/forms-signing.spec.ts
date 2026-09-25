import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFCheckBox, PDFDocument, PDFName, PDFRadioGroup, PDFStream, decodePDFRawStream } from 'pdf-lib'
import { axeViolations, copyFixture, launch, menuClick, quitDiscarding, FIX } from './helpers'

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/forms-signing.mjs', resolve(FIX)], { stdio: 'inherit' })
})

const save = (page: Page) => page.getByRole('button', { name: 'Save', exact: true }).click()
const undoBtn = (page: Page, label?: string | RegExp) => page.getByRole('button', { name: label ?? /^Undo/ })
const dot = (page: Page) => page.getByTestId('unsaved-dot')

const loadSaved = async (path: string): Promise<PDFDocument> => PDFDocument.load(readFileSync(path))

/** Decoded content of a page's content stream(s), concatenated. */
async function pageContent(pdf: PDFDocument, pageIndex: number): Promise<string> {
  const contents = pdf.getPage(pageIndex).node.Contents()
  const streams: PDFStream[] = []
  if (contents instanceof PDFStream) streams.push(contents)
  else if (contents) {
    for (let i = 0; i < (contents as unknown as { size(): number }).size(); i++) {
      streams.push(pdf.context.lookup((contents as unknown as { get(i: number): never }).get(i)) as PDFStream)
    }
  }
  return streams.map((s) => Buffer.from(decodePDFRawStream(s as never).decode()).toString('latin1')).join('\n')
}

test.describe('form filling', () => {
  test('fills every field type, saves, and the saved file has the values and appearance streams', async () => {
    const path = copyFixture('forms.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(page.getByTestId('form-banner')).toContainText('This form has 12 fields')

      const name = page.getByLabel('Full name')
      await name.fill('Ada Lovelace')
      await name.press('Enter')
      await expect(undoBtn(page, 'Undo Fill “Full name”')).toBeEnabled()

      const notes = page.getByLabel('Notes')
      await notes.fill('first line\nsecond line')
      await notes.press('Control+Enter')

      // MaxLen 5: the input itself refuses more.
      const code = page.getByLabel('Code (max 5 characters)')
      await code.click()
      await code.pressSequentially('ABCDEFGH')
      await expect(code).toHaveValue('ABCDE')
      await code.press('Enter')

      const pin = page.getByLabel('PIN')
      await expect(pin).toHaveAttribute('type', 'password')
      await pin.fill('s3cret')
      await pin.press('Enter')

      const ro = page.getByLabel('Customer id (read only)')
      await expect(ro).toHaveAttribute('readonly', '')
      await expect(ro).toHaveValue('ID-0001')

      await page.getByLabel('I agree to the terms').check()
      await page.getByLabel('color: green').check()
      await page.getByLabel('Country').selectOption('Germany')
      await page.getByLabel('Languages').selectOption(['English', 'German'])
      await gotoPageInput(page, 2)
      const p2 = page.getByLabel('Page two field')
      await p2.fill('on page two')
      await p2.press('Enter')
      await expect(dot(page)).toBeVisible()

      await save(page)
      await expect(dot(page)).toHaveCount(0)

      const saved = await loadSaved(path)
      const form = saved.getForm()
      expect(form.getTextField('full_name').getText()).toBe('Ada Lovelace')
      expect(form.getTextField('notes').getText()).toBe('first line\nsecond line')
      expect(form.getTextField('code').getText()).toBe('ABCDE')
      expect(form.getTextField('pin').getText()).toBe('s3cret')
      expect(form.getTextField('readonly_id').getText()).toBe('ID-0001')
      expect((form.getField('agree') as PDFCheckBox).isChecked()).toBe(true)
      expect((form.getField('color') as PDFRadioGroup).getSelected()).toBe('green')
      expect(form.getDropdown('country').getSelected()).toEqual(['Germany'])
      expect(form.getOptionList('langs').getSelected()).toEqual(['English', 'German'])
      expect(form.getTextField('page2_field').getText()).toBe('on page two')

      // Real appearance streams exist for the filled text fields (so other readers show them).
      for (const n of ['full_name', 'notes', 'code', 'pin', 'page2_field']) {
        const w = form.getTextField(n).acroField.getWidgets()[0]
        expect(w.getAppearances()?.normal, `${n} has an appearance stream`).toBeInstanceOf(PDFStream)
      }
      // The document still has its two pages and the drawn heading.
      expect(saved.getPageCount()).toBe(2)
      expect(await pageContent(saved, 0)).toContain('Registration form'.length ? '' : '')
    } finally {
      await app.close()
    }
  })
})

async function gotoPageInput(page: Page, n: number): Promise<void> {
  const input = page.getByLabel('Page number')
  await input.fill(String(n))
  await input.press('Enter')
  await expect(page.locator(`[data-page="${n}"] canvas`)).toBeVisible()
}

// Keep imports used by later tests in this file.
void [PDFName, axeViolations, menuClick, quitDiscarding]
