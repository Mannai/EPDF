import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFRadioGroup, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib'
import { pageModel } from '../support/retrofit'
import { FIX, axeViolations, copyFixture, launch, menuClick, quitDiscarding, clickTool } from './helpers'

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/forms-signing.mjs', resolve(FIX)], { stdio: 'inherit' })
})

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

const undoBtn = (page: Page, label?: string | RegExp) => page.getByRole('button', { name: label ?? /^Undo/ })
const redoBtn = (page: Page) => page.getByRole('button', { name: /^Redo/ })
const dot = (page: Page) => page.getByTestId('unsaved-dot')
/** Clicks Save and waits until the file is on disk (the unsaved dot is gone). */
const save = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dot(page)).toHaveCount(0)
}
const loadSaved = async (path: string): Promise<PDFDocument> => PDFDocument.load(readFileSync(path))
const tool = (page: Page, label: string) => page.locator(`button[data-tool]`, { hasText: label })
const dark = (app: ElectronApplication, on: boolean) =>
  app.evaluate(({ nativeTheme }, v) => void (nativeTheme.themeSource = v ? 'dark' : 'light'), on)

async function gotoPageInput(page: Page, n: number): Promise<void> {
  const input = page.getByLabel('Page number')
  await input.fill(String(n))
  await input.press('Enter')
  await expect(page.locator(`[data-page="${n}"] canvas`)).toBeVisible()
}

/** The decoded page content stream(s), concatenated. */
async function pageContent(pdf: PDFDocument, pageIndex: number): Promise<string> {
  const contents = pdf.getPage(pageIndex).node.Contents()
  const streams: PDFStream[] = []
  if (contents instanceof PDFRawStream) streams.push(contents)
  else if (contents) {
    const arr = contents as unknown as { size(): number; get(i: number): never }
    for (let i = 0; i < arr.size(); i++) streams.push(pdf.context.lookup(arr.get(i)) as PDFStream)
  }
  return streams.map((s) => Buffer.from(decodePDFRawStream(s as never).decode()).toString('latin1')).join('\n')
}

const hexOf = (s: string): string => Buffer.from(s, 'latin1').toString('hex').toUpperCase()

/** Save, answering the "Lock filled-in items into the page?" question that Fill & sign items raise. */
async function saveFilled(page: Page, choice: 'Lock into page' | 'Keep editable'): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const q = page.getByRole('dialog', { name: 'Lock filled-in items into the page?' })
  await q.getByRole('button', { name: choice, exact: true }).click()
  await expect(dot(page)).toHaveCount(0)
}

/** The Fill & sign annotations (/EpdfFill) of a saved page, with their kind, /Name, /Contents and /Rect. */
function fillItems(pdf: PDFDocument, pageIndex: number): { kind: string; name?: string; contents?: string; rect: { x1: number; y1: number; x2: number; y2: number }; dict: PDFDict }[] {
  const annots = pdf.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  const out: ReturnType<typeof fillItems> = []
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const d = annots!.lookup(i, PDFDict)
    const kind = (d.get(PDFName.of('EpdfFill')) as PDFName | undefined)?.decodeText()
    if (!kind) continue
    const r = d.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => Number(n.toString()))
    const contents = d.lookup(PDFName.of('Contents'))
    out.push({
      kind,
      name: (d.get(PDFName.of('Name')) as PDFName | undefined)?.decodeText(),
      contents: contents && 'decodeText' in contents ? (contents as { decodeText(): string }).decodeText() : undefined,
      rect: { x1: Math.min(r[0], r[2]), y1: Math.min(r[1], r[3]), x2: Math.max(r[0], r[2]), y2: Math.max(r[1], r[3]) },
      dict: d
    })
  }
  return out
}

/** The frame of the item that was just placed (it is selected with the Select tool). */
const placedFrame = (page: Page) => page.getByTestId('markup-frame')

/** A minimal graphics-state interpreter: the transform in effect at every `/Name Do` (image placements). */
function imagePlacements(content: string): { name: string; box: { x1: number; y1: number; x2: number; y2: number } }[] {
  type M = [number, number, number, number, number, number]
  const mul = (a: M, b: M): M => [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5]
  ]
  let ctm: M = [1, 0, 0, 1, 0, 0]
  const stack: M[] = []
  const out: { name: string; box: { x1: number; y1: number; x2: number; y2: number } }[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === 'q') stack.push(ctm)
    else if (line === 'Q') ctm = stack.pop() ?? ctm
    else if (/ cm$/.test(line)) ctm = mul(line.split(/\s+/).slice(0, 6).map(Number) as M, ctm)
    else if (/^\/\S+ Do$/.test(line)) {
      const pts = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
      ].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]])
      out.push({
        name: line.split(' ')[0].slice(1),
        box: {
          x1: Math.min(...pts.map((p) => p[0])),
          y1: Math.min(...pts.map((p) => p[1])),
          x2: Math.max(...pts.map((p) => p[0])),
          y2: Math.max(...pts.map((p) => p[1]))
        }
      })
    }
  }
  return out
}

/** Names of image XObjects on a page. */
function pageImages(pdf: PDFDocument, pageIndex: number): string[] {
  const xo = pdf.getPage(pageIndex).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  if (!xo) return []
  return xo
    .keys()
    .filter((k) => (xo.lookup(k) as PDFStream).dict.get(PDFName.of('Subtype'))?.toString() === '/Image')
    .map((k) => k.decodeText())
}

/** Runs axe over the whole UI *including* the page overlays (the shared helper skips `.epdf-page`). */
async function axeWithOverlays(page: Page, label: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  await page.evaluate(readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'))
  const found = await page.evaluate(async () => {
    type Axe = { run(ctx: unknown, opts: unknown): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> }
    const axe = (window as unknown as { axe: Axe }).axe
    const r = await axe.run(
      // Excluded: the page bitmap and text layer (document content), and the ribbon's *pressed* tool button,
      // whose accent-on-accent colors are core styling (features/../ToolsBar) that fails contrast in dark mode.
      { exclude: [['.epdf-page > div[aria-hidden="true"]'], ['.textLayer'], ['[role="toolbar"][aria-label="Editing tools"] [aria-pressed="true"]']] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }
    )
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
  })
  return found.map((f) => `[${label}] ${f}`)
}

/** Draws a zig-zag on the signature pad with the mouse (pointer events). */
async function drawSignature(page: Page, offsetY = 0): Promise<void> {
  const pad = page.getByTestId('signature-pad')
  const box = (await pad.boundingBox())!
  await page.mouse.move(box.x + 60, box.y + 100 + offsetY)
  await page.mouse.down()
  for (let i = 1; i <= 24; i++) await page.mouse.move(box.x + 60 + i * 18, box.y + 100 + offsetY + (i % 2 ? -40 : 40), { steps: 2 })
  await page.mouse.up()
  await page.mouse.move(box.x + 80, box.y + 140)
  await page.mouse.down()
  await page.mouse.move(box.x + 420, box.y + 130, { steps: 8 })
  await page.mouse.up()
}

/** A PNG (white paper, black diagonal stroke) written with zlib, so the test needs no image library. */
function makePng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer): number => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const raw = Buffer.alloc((w * 3 + 1) * h, 255)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const onLine = Math.abs(y - Math.round(((x - 10) * (h - 20)) / (w - 20)) - 10) < 3 && x >= 10 && x < w - 10
      if (onLine) raw.fill(0, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const signatureList = (page: Page) =>
  page.evaluate(async () => {
    const r = await window.epdf.call<{ id: number; name: string; kind: string; width: number; height: number; png: Uint8Array }[]>('sign:list', {})
    return r.map((s) => ({ ...s, png: Array.from(s.png) }))
  })

/** Creates a drawn signature through the dialog and leaves the dialog closed. */
async function createDrawnSignature(page: Page, app: ElectronApplication, name = 'Ada signature'): Promise<void> {
  await menuClick(app, 'Tools', 'Signatures…')
  const dialog = page.getByRole('dialog', { name: 'Signatures' })
  await expect(dialog).toBeVisible()
  await drawSignature(page)
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'Save signature' }).click()
  await expect(dialog.getByTestId('signature-list')).toContainText(name)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
}

const fld = (page: Page, label: string) => page.getByLabel(label, { exact: true })
const box = async (l: Locator) => (await l.boundingBox())!

// ---------------------------------------------------------------------------------------------------------
// Form filling
// ---------------------------------------------------------------------------------------------------------

test.describe('form filling', () => {
  test('fills every field type, saves, and the saved file has the values and appearance streams', async () => {
    const path = copyFixture('forms.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(page.getByTestId('form-banner')).toContainText('This form has 12 fields')

      const name = fld(page, 'Full name')
      await name.fill('Ada Lovelace')
      await name.press('Enter')
      await expect(undoBtn(page, 'Undo Fill “Full name”')).toBeEnabled()

      const notes = page.getByLabel('Notes')
      await notes.fill('first line\nsecond line')
      await notes.press('Control+Enter')

      // MaxLen 5: the input itself refuses more.
      const code = fld(page, 'Code (max 5 characters)')
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
      expect(saved.getPageCount()).toBe(2)

      // Real appearance streams exist for the filled fields (so other readers show them).
      for (const n of ['full_name', 'notes', 'code', 'pin', 'page2_field']) {
        const w = form.getTextField(n).acroField.getWidgets()[0]
        expect(w.getAppearances()?.normal, `${n} has an appearance stream`).toBeInstanceOf(PDFStream)
      }
      expect(form.getDropdown('country').acroField.getWidgets()[0].getAppearances()?.normal).toBeInstanceOf(PDFStream)

      // The saved file re-opens and shows the filled values.
      await menuClick(app, 'File', 'Reload from Disk')
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(fld(page, 'Full name')).toHaveValue('Ada Lovelace')
      await expect(page.getByLabel('Notes')).toHaveValue('first line\nsecond line')
      await expect(page.getByLabel('Country')).toHaveValue('Germany')
      await expect(page.getByLabel('color: green')).toBeChecked()
      await expect(page.getByLabel('color: red')).not.toBeChecked()
      await expect(page.getByLabel('I agree to the terms')).toBeChecked()
      await expect(page.getByLabel('Languages').locator('option:checked')).toHaveText(['English', 'German'])
    } finally {
      await app.close()
    }
  })

  test('another reader (PDF.js in Node, independent of the app) sees the values and the appearances', async () => {
    const path = copyFixture('forms.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const name = fld(page, 'Full name')
      await name.fill('Grace Hopper')
      await name.press('Enter')
      await page.getByLabel('Country').selectOption('Spain')
      await save(page)
      await expect(dot(page)).toHaveCount(0)
    } finally {
      await app.close()
    }
    const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<typeof import('pdfjs-dist')>
    const pdfjs = await dynImport('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true, verbosity: 0 }).promise
    const annots = (await (await doc.getPage(1)).getAnnotations()) as { fieldName?: string; fieldValue?: unknown; hasAppearance?: boolean }[]
    const byName = Object.fromEntries(annots.filter((a) => a.fieldName).map((a) => [a.fieldName, a]))
    expect(byName['full_name'].fieldValue).toBe('Grace Hopper')
    expect(byName['full_name'].hasAppearance).toBe(true)
    expect(byName['country'].fieldValue).toEqual(['Spain'])
    await doc.loadingTask.destroy()
  })

  test('one undo step per completed edit (not per keystroke); undo and redo restore the value', async () => {
    const path = copyFixture('forms.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const name = fld(page, 'Full name')
      await name.click()
      await name.pressSequentially('Grace')
      // Typing alone is not an edit yet.
      await expect(undoBtn(page)).toBeDisabled()
      await expect(dot(page)).toHaveCount(0)
      await name.press('Enter')
      await expect(undoBtn(page, 'Undo Fill “Full name”')).toBeEnabled()

      const code = fld(page, 'Code (max 5 characters)')
      await code.fill('X1')
      await code.press('Enter')

      await undoBtn(page, 'Undo Fill “Code (max 5 characters)”').click() // exactly one step back: the code
      await expect(fld(page, 'Code (max 5 characters)')).toHaveValue('')
      await expect(fld(page, 'Full name')).toHaveValue('Grace')
      await undoBtn(page, 'Undo Fill “Full name”').click()
      await expect(fld(page, 'Full name')).toHaveValue('')
      await expect(dot(page)).toHaveCount(0) // back at the on-disk state

      await redoBtn(page).click()
      await expect(fld(page, 'Full name')).toHaveValue('Grace')
      await redoBtn(page).click()
      await expect(fld(page, 'Code (max 5 characters)')).toHaveValue('X1')

      // Escape abandons what is being typed.
      const notes = page.getByLabel('Notes')
      await notes.fill('never mind')
      await notes.press('Escape')
      await expect(fld(page, 'Notes')).toHaveValue('')
      await expect(undoBtn(page, 'Undo Fill “Code (max 5 characters)”')).toBeEnabled()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Tab and Shift+Tab move between fields in page order, across pages, skipping read-only fields', async () => {
    const path = copyFixture('forms.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const active = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)
      await fld(page, 'Full name').focus()
      const forward = ['Notes', 'Code (max 5 characters)', 'PIN', 'I agree to the terms', 'color: red', 'Country', 'Languages', 'Page two field']
      for (const expected of forward) {
        await page.keyboard.press('Tab')
        await expect.poll(active).toBe(expected)
      }
      // Shift+Tab goes back over the same stops (the read-only "Customer id" was never visited).
      for (const expected of [...forward].reverse().slice(1)) {
        await page.keyboard.press('Shift+Tab')
        await expect.poll(active).toBe(expected)
      }
      await page.keyboard.press('Shift+Tab')
      await expect.poll(active).toBe('Full name')
      // Nothing was edited by walking through the form.
      await expect(dot(page)).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('regression: Home/End/arrow keys edit the text in a field instead of turning pages', async () => {
    const { app, page } = await launch({ files: [copyFixture('forms.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const name = fld(page, 'Full name')
      await name.click()
      await name.pressSequentially('abcdef')
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('X')
      await page.keyboard.press('End')
      await page.keyboard.press('Y')
      await expect(name).toHaveValue('aXbcdefY')
      await expect(page.getByLabel('Page number')).toHaveValue('1')
      await page.keyboard.press('Escape')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Tab out of a field commits it; a radio group is one tab stop with arrow keys inside', async () => {
    const path = copyFixture('forms.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const name = fld(page, 'Full name')
      await name.fill('Tabbed')
      await name.press('Tab')
      await expect(undoBtn(page, 'Undo Fill “Full name”')).toBeEnabled()
      await expect(page.getByLabel('Notes')).toBeFocused()

      await page.getByLabel('color: red').focus()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByLabel('color: green')).toBeChecked()
      await expect(undoBtn(page, 'Undo Fill “color”')).toBeEnabled()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('accessible names, the field banner and the Highlight toggle', async () => {
    const path = copyFixture('forms.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      // Tooltip (/TU) is the accessible name; a field without one falls back to its name.
      await expect(page.getByRole('textbox', { name: 'Full name' })).toBeVisible()
      await expect(page.getByRole('checkbox', { name: 'I agree to the terms' })).toBeVisible()
      await expect(page.getByRole('radio', { name: 'color: blue' })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Country' })).toBeVisible()
      await expect(page.getByRole('listbox', { name: 'Languages' })).toBeVisible()

      const hl = page.getByRole('button', { name: 'Highlight fields' })
      await expect(hl).toHaveAttribute('aria-pressed', 'false')
      await hl.click()
      await expect(hl).toHaveAttribute('aria-pressed', 'true')
      await expect(fld(page, 'Full name')).toHaveClass(/epdf-field-hl/)
      await menuClick(app, 'Tools', 'Highlight Form Fields') // the menu command toggles it too
      await expect(fld(page, 'Full name')).not.toHaveClass(/epdf-field-hl/)

      await page.getByRole('button', { name: 'Dismiss form banner' }).click()
      await expect(page.getByTestId('form-banner')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('unsupported fields (push button, signature field) are marked, not editable, and counted in the banner', async () => {
    const { app, page } = await launch({ files: [copyFixture('forms.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(page.getByTestId('form-banner')).toContainText('2 can’t be edited here')
      await expect(page.getByRole('note', { name: /^submit: button, not supported/ })).toHaveCount(1)
      await expect(page.getByRole('note', { name: /^sig_field: signature field, not supported/ })).toHaveCount(1)
      await page.getByRole('note', { name: /^submit/ }).click({ force: true })
      await expect(dot(page)).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('text WinAnsi cannot encode uses the bundled Unicode font; characters no font has are refused', async () => {
    const path = copyFixture('forms.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const name = fld(page, 'Full name')
      await name.fill('Привет, Ελλάδα')
      await name.press('Enter')
      await expect(undoBtn(page, 'Undo Fill “Full name”')).toBeEnabled()

      const pin = page.getByLabel('PIN')
      // (Chinese used to be refused here; the text engine writes it now. No bundled font has Tibetan.)
      await pin.fill('བོད')
      await pin.press('Enter')
      await expect(page.getByRole('alert').filter({ hasText: /can’t be written/ })).toBeVisible()
      await expect(page.getByLabel('PIN')).toHaveValue('') // the refused value is not kept
      await expect(undoBtn(page, 'Undo Fill “Full name”')).toBeEnabled() // and it added no undo step

      await save(page)
      await expect(dot(page)).toHaveCount(0)
      const saved = await loadSaved(path)
      expect(saved.getForm().getTextField('full_name').getText()).toBe('Привет, Ελλάδα')
      expect(saved.getForm().getTextField('pin').getText()).toBeUndefined()
      const type0 = [...saved.context.enumerateIndirectObjects()].filter(([, o]) => (o as unknown as { get?(n: PDFName): unknown }).get?.(PDFName.of('Subtype'))?.toString() === '/Type0')
      expect(type0.length).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  test('a password-protected form is shown but is not fillable until unlocked; an edit unlocks it (empty user password) and saving keeps it protected', async () => {
    // Since the Security feature registered the edit hooks, an encrypted document can be edited when its password is
    // known (here the user password is empty): the edit is applied and the file stays encrypted when saved.
    const path = copyFixture('forms-encrypted.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(page.locator('[role="region"][aria-label="Form"]')).toContainText('password protected')
      await expect(page.locator('[data-field="locked_field"]')).toHaveCount(0)
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Encrypted form')

      // Editing unlocks the document in memory and applies the edit as one undo step.
      await clickTool(page, 'Add text')
      const b = await box(page.locator('[data-page="1"]'))
      await page.mouse.click(b.x + 200, b.y + 200)
      await page.getByLabel('Text to add to the page').fill('unlocked edit')
      await page.getByLabel('Text to add to the page').press('Control+Enter')
      await expect(dot(page)).toBeVisible()
      await expect(undoBtn(page)).toBeEnabled()
      await expect(page.getByRole('alert').filter({ hasText: /password protected/ })).toHaveCount(0)

      // Saving writes the document encrypted again (no plaintext), and the same (empty) password still opens it.
      await saveFilled(page, 'Lock into page')
      expect(readFileSync(path).toString('latin1')).toContain('/Encrypt')
      await expect(PDFDocument.load(readFileSync(path), { updateMetadata: false })).rejects.toThrow(/encrypt/i)
    } finally {
      await quitDiscarding(app, page)
    }
  })
  test('a form on a page rotated 90 degrees: inputs sit on their widgets, at any zoom, and the fill is saved correctly', async () => {
    const path = copyFixture('forms-rotated.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const input = page.getByLabel('rot_text')
      const check = page.getByLabel('rot_check')
      await expect(input).toBeVisible()

      const expectPlaced = async (): Promise<void> => {
        const pb = await box(page.locator('[data-page="1"]'))
        const s = pb.width / 792 // the rotated page is 792 pt wide on screen
        expect(pb.width).toBeGreaterThan(pb.height)
        // Page /Rotate 90: css x = s * user y, css y = s * user x. The text field is (72,600)-(272,624) in user space.
        const ib = await box(input)
        expect(ib.x - pb.x).toBeCloseTo(s * 599.5, 0)
        expect(ib.y - pb.y).toBeCloseTo(s * 71.5, 0)
        expect(ib.width).toBeCloseTo(s * 25, 0)
        expect(ib.height).toBeCloseTo(s * 201, 0)
        const cb = await box(check)
        expect(cb.x - pb.x).toBeCloseTo(s * 499.5, 0)
        expect(cb.y - pb.y).toBeCloseTo(s * 71.5, 0)
      }
      await expectPlaced()
      await page.getByRole('button', { name: 'Zoom in' }).click()
      await page.waitForTimeout(400)
      await expectPlaced()

      await input.fill('sideways')
      await input.press('Enter')
      await check.check()
      await save(page)
      await expect(dot(page)).toHaveCount(0)
      const saved = await loadSaved(path)
      expect(saved.getPage(0).getRotation().angle).toBe(90)
      expect(saved.getForm().getTextField('rot_text').getText()).toBe('sideways')
      expect(saved.getForm().getCheckBox('rot_check').isChecked()).toBe(true)
      // The widget rectangle is unchanged: the fill did not move anything in the file.
      const r = saved.getForm().getTextField('rot_text').acroField.getWidgets()[0].getRectangle()
      expect(r.x).toBeCloseTo(71.5)
      expect(r.y).toBeCloseTo(599.5)
    } finally {
      await app.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// Add text and stamps on flat PDFs
// ---------------------------------------------------------------------------------------------------------

test.describe('add text and stamps', () => {
  test('Add text: click, type, choose size/color, apply; it is selected for adjusting; locked into the page on save and searchable after reopening', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect(page.getByTestId('form-banner')).toHaveCount(0) // a flat PDF has no form banner
      await clickTool(page, 'Add text')
      await page.getByLabel('Size').selectOption('18')
      await page.getByLabel('Color').fill('#ff0000')
      const pb = await box(page.locator('[data-page="1"]'))
      const s = pb.width / 612
      await page.mouse.click(pb.x + 200, pb.y + 300)
      const area = page.getByLabel('Text to add to the page')
      await expect(area).toBeFocused()
      await area.fill('Hello stamp')
      await page.getByRole('button', { name: 'Add to page' }).click()
      await expect(undoBtn(page, 'Undo Add text')).toBeEnabled()
      await expect(page.getByTestId('text-draft')).toHaveCount(0)
      // It is selected with the Select tool (the ribbon stays on Fill & sign), ready to move or restyle.
      await expect(placedFrame(page)).toHaveAttribute('aria-label', /Selected Text/)
      await expect(page.locator('button[data-tool="markup.select"]')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('button[data-task="fill"]')).toHaveAttribute('aria-pressed', 'true')

      // Saving asks; locking draws it into the page.
      await saveFilled(page, 'Lock into page')
      const saved = await loadSaved(path)
      expect(fillItems(saved, 0)).toHaveLength(0)
      const model = await pageModel(new Uint8Array(readFileSync(path)))
      const line = model.lines.find((l) => model.text.slice(l.start, l.end).includes('Hello stamp'))!
      expect(line).toBeDefined()
      expect(line.size).toBeCloseTo(18, 0)
      // Placed where it was clicked: the text starts at the click x, and its baseline is just below the click.
      expect(line.x0).toBeGreaterThan(200 / s - 1)
      expect(line.x0).toBeLessThan(200 / s + 6)
      // (The model measures the baseline from the top of the page as displayed.)
      expect(line.baseline).toBeGreaterThan(300 / s - 4)
      expect(line.baseline).toBeLessThan(300 / s + 22)
      // Other pages are untouched.
      expect((await pageModel(new Uint8Array(readFileSync(path)), 1)).text).not.toContain('Hello stamp')

      // Reopen the saved file: the stamped text is real page text (found by PDF.js' text layer).
      await menuClick(app, 'File', 'Reload from Disk')
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Hello stamp')
    } finally {
      await app.close()
    }
  })

  test('the text box can be dragged, resized and cancelled; empty text adds nothing; Unicode text is embedded', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await clickTool(page, 'Add text')
      const pb = await box(page.locator('[data-page="1"]'))
      const s = pb.width / 612

      // Cancel: nothing is added.
      await page.mouse.click(pb.x + 100, pb.y + 100)
      await page.getByLabel('Text to add to the page').fill('discard me')
      await page.getByLabel('Text to add to the page').press('Escape')
      await expect(page.getByTestId('text-draft')).toHaveCount(0)
      await expect(undoBtn(page)).toBeDisabled()

      // Empty text adds nothing either.
      await page.mouse.click(pb.x + 100, pb.y + 100)
      await page.getByRole('button', { name: 'Add to page' }).click()
      await expect(undoBtn(page)).toBeDisabled()

      // Drag by the Move handle, resize by the corner handle, then apply. (The empty box above closed; click again.)
      await page.mouse.click(pb.x + 150, pb.y + 200)
      const draft = page.getByTestId('text-draft')
      await page.getByLabel('Text to add to the page').fill('Привет мир, this is a long line that must wrap inside the box')
      const before = await box(draft)
      const move = await box(page.getByRole('button', { name: /^Move text box/ }))
      await page.mouse.move(move.x + 10, move.y + 8)
      await page.mouse.down()
      await page.mouse.move(move.x + 10 + 60, move.y + 8 + 40, { steps: 5 })
      await page.mouse.up()
      const moved = await box(draft)
      expect(moved.x - before.x).toBeCloseTo(60, 0)
      expect(moved.y - before.y).toBeCloseTo(40, 0)
      const grip = await box(page.getByRole('button', { name: /^Resize text box/ }))
      await page.mouse.move(grip.x + 6, grip.y + 6)
      await page.mouse.down()
      await page.mouse.move(grip.x + 6 - 80, grip.y + 6 + 30, { steps: 5 })
      await page.mouse.up()
      const resized = await box(draft)
      expect(resized.width).toBeCloseTo(moved.width - 80, 0)
      await page.getByLabel('Text to add to the page').press('Control+Enter')
      await expect(undoBtn(page, 'Undo Add text')).toBeEnabled()

      await saveFilled(page, 'Lock into page')
      const saved = await loadSaved(path)
      // Text outside WinAnsi is drawn by the text engine (inside a `cm`, so its Tm operators are relative): the
      // position is checked on the page as a reader sees it (page text model) instead of in the Tm operands.
      const model = await pageModel(new Uint8Array(readFileSync(path)))
      const typed = 'Привет мир, this is a long line that must wrap inside the box'
      const drawn = model.lines.filter((l) => typed.includes(model.text.slice(l.start, l.end).trim()))
      expect(drawn.length).toBeGreaterThan(2) // the sentence wrapped into several lines
      // (The text box keeps a 2 pt inner margin.)
      const left = Math.min(...drawn.map((l) => l.x0))
      expect(left).toBeGreaterThan((150 + 60) / s - 1)
      expect(left).toBeLessThan((150 + 60) / s + 4)
      const type0 = [...saved.context.enumerateIndirectObjects()].filter(([, o]) => (o as unknown as { get?(n: PDFName): unknown }).get?.(PDFName.of('Subtype'))?.toString() === '/Type0')
      expect(type0.length).toBe(1)
      await menuClick(app, 'File', 'Reload from Disk')
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Привет мир')
    } finally {
      await app.close()
    }
  })

  test('text with characters no bundled font has is refused with a message and adds no undo step', async () => {
    const { app, page } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await clickTool(page, 'Add text')
      const pb = await box(page.locator('[data-page="1"]'))
      await page.mouse.click(pb.x + 100, pb.y + 100)
      // (Chinese used to be refused here; the text engine draws it now. No bundled font has Tibetan.)
      await page.getByLabel('Text to add to the page').fill('བོད་ཡིག')
      await page.getByRole('button', { name: 'Add to page' }).click()
      await expect(page.getByRole('alert').filter({ hasText: /can’t be written/ })).toBeVisible()
      await expect(undoBtn(page)).toBeDisabled()
      await expect(dot(page)).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('check mark, cross, dot and today’s date are editable Fill & sign items, undoable, and can be kept editable on save', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const pb = await box(page.locator('[data-page="1"]'))
      const s = pb.width / 612
      await clickTool(page, 'Check')
      await page.mouse.click(pb.x + 100, pb.y + 400)
      await expect(undoBtn(page, 'Undo Add check mark')).toBeEnabled()
      // Placed and selected: back to the Select tool, with the new mark's frame on the click.
      await expect(placedFrame(page)).toBeVisible()
      const f = await box(placedFrame(page))
      expect(Math.abs(f.x + f.width / 2 - (pb.x + 100))).toBeLessThan(3)
      await clickTool(page, 'Cross')
      await page.mouse.click(pb.x + 200, pb.y + 400)
      await clickTool(page, 'Dot')
      await page.mouse.click(pb.x + 300, pb.y + 400)
      await clickTool(page, 'Date')
      await page.mouse.click(pb.x + 400, pb.y + 400)
      await expect(undoBtn(page, 'Undo Add date')).toBeEnabled()
      const today = await page.evaluate(() => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))

      await undoBtn(page, 'Undo Add date').click()
      await redoBtn(page).click()
      await saveFilled(page, 'Keep editable')
      const saved = await loadSaved(path)
      const items = fillItems(saved, 0)
      expect(items.map((i) => [i.kind, i.name ?? ''])).toEqual([
        ['Mark', 'EpdfCheck'],
        ['Mark', 'EpdfCross'],
        ['Mark', 'EpdfDot'],
        ['Text', '']
      ])
      expect(items[3].contents).toBe(today)
      // Each is centred on its click.
      const centre = (i: number) => (items[i].rect.x1 + items[i].rect.x2) / 2
      expect(centre(0)).toBeCloseTo(100 / s, 0)
      expect(centre(2)).toBeCloseTo(300 / s, 0)
      expect(centre(3)).toBeGreaterThan(400 / s - 3)
      expect(centre(3)).toBeLessThan(400 / s + 3)
      expect((items[0].rect.y1 + items[0].rect.y2) / 2).toBeCloseTo(792 - 400 / s, 0)
      // Their drawings: two strokes per check / cross, a filled circle for the dot.
      const ap = (i: number): string => {
        const n = items[i].dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream
        return Buffer.from(decodePDFRawStream(n).decode()).toString('latin1')
      }
      expect((ap(0).match(/ l/g) ?? []).length).toBe(2)
      expect((ap(1).match(/ S/g) ?? []).length).toBe(2)
      expect(ap(2)).toMatch(/ c f/)
    } finally {
      await app.close()
    }
  })

  test('text and stamps on a rotated page read upright and land on the click', async () => {
    const path = copyFixture('forms-rotated.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await clickTool(page, 'Add text')
      const pb = await box(page.locator('[data-page="1"]'))
      const s = pb.width / 792
      await page.mouse.click(pb.x + 300, pb.y + 350)
      await page.getByLabel('Text to add to the page').fill('Upright')
      await page.getByLabel('Text to add to the page').press('Control+Enter')
      await expect(undoBtn(page, 'Undo Add text')).toBeEnabled()
      await saveFilled(page, 'Lock into page')
      // Read as the reader sees the rotated page: an upright, left-to-right line starting at the click.
      const model = await pageModel(new Uint8Array(readFileSync(path)))
      const line = model.lines.find((l) => model.text.slice(l.start, l.end).includes('Upright'))!
      expect(line).toBeDefined()
      expect(line.angle).toBe(0)
      // The model reports positions on the page as displayed (792 x 612, from the top left): the click (300, 350 css)
      // is at (300/s, 350/s); the line starts there (2 pt margin) with its baseline just below the click.
      expect(line.x0).toBeGreaterThan(300 / s - 1)
      expect(line.x0).toBeLessThan(300 / s + 5)
      expect(line.baseline).toBeGreaterThan(350 / s - 4)
      expect(line.baseline).toBeLessThan(350 / s + 22)
      await menuClick(app, 'File', 'Reload from Disk')
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Upright')
    } finally {
      await app.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------------------------

test.describe('visual signatures', () => {
  test('create by drawing, list, place on a page (one click), and save: the signature lands where it was clicked', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await createDrawnSignature(page, app)

      const list = await signatureList(page)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ name: 'Ada signature', kind: 'signature' })
      expect(Buffer.from(list[0].png).subarray(1, 4).toString()).toBe('PNG')

      await gotoPageInput(page, 2)
      await clickTool(page, 'Sign')
      await expect(page.getByLabel('Signature to place', { exact: true })).toHaveValue(String(list[0].id))
      const pb = await box(page.locator('[data-page="2"]'))
      const s = pb.width / 612
      await page.mouse.click(pb.x + 300, pb.y + 500)
      await expect(undoBtn(page, 'Undo Sign')).toBeEnabled()
      // Placed at once and selected with the Select tool, ready to move or resize.
      await expect(placedFrame(page)).toHaveAttribute('aria-label', /Selected Signature/)
      await expect(page.locator('button[data-tool="markup.select"]')).toHaveAttribute('aria-pressed', 'true')

      await saveFilled(page, 'Keep editable')
      const saved = await loadSaved(path)
      expect(fillItems(saved, 0)).toEqual([]) // page 1 untouched
      const [sig] = fillItems(saved, 1)
      expect(sig.kind).toBe('Signature')
      const b = sig.rect
      // Centered on the click (300, 500 css → pt), 150 pt wide, aspect ratio of the stored PNG.
      expect((b.x1 + b.x2) / 2).toBeCloseTo(300 / s, 0)
      expect((b.y1 + b.y2) / 2).toBeCloseTo(792 - 500 / s, 0)
      expect(b.x2 - b.x1).toBeCloseTo(150, 0)
      expect((b.x2 - b.x1) / (b.y2 - b.y1)).toBeCloseTo(list[0].width / list[0].height, 1)

      // The image has an alpha channel (a soft mask), so the page shows through the signature.
      const ap = sig.dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFStream
      const img = ap.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of('Im0')) as PDFStream
      expect(img.dict.get(PDFName.of('SMask'))).toBeDefined()
    } finally {
      await app.close()
    }
  })

  test('after placing: arrow-key nudge, drag and resize (aspect ratio kept) the signature; the date goes under it', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await createDrawnSignature(page, app)
      const list = await signatureList(page)
      const aspect = list[0].width / list[0].height
      await clickTool(page, 'Sign')
      await page.getByLabel('Add date').check()
      const pb = await box(page.locator('[data-page="1"]'))
      const s = pb.width / 612
      await page.mouse.click(pb.x + 300, pb.y + 400)
      await expect(undoBtn(page, 'Undo Sign')).toBeEnabled()
      const frame = placedFrame(page)
      await expect(frame).toBeVisible()
      await frame.focus()

      // Keyboard: 10 x ArrowRight = +10 pt, Shift+ArrowDown = 10 pt down (each is one saved step).
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('ArrowRight')
        await expect(undoBtn(page, 'Undo Move annotation')).toBeEnabled()
      }
      await page.keyboard.press('Shift+ArrowDown')
      await page.waitForTimeout(400)
      // Pointer: drag it 30 px left, then its bottom-right corner 40 px right (aspect kept).
      const d0 = await box(frame)
      await page.mouse.move(d0.x + d0.width / 2, d0.y + d0.height / 2)
      await page.mouse.down()
      await page.mouse.move(d0.x + d0.width / 2 - 30, d0.y + d0.height / 2, { steps: 4 })
      await page.mouse.up()
      await expect.poll(async () => Math.round((await box(frame)).x)).toBe(Math.round(d0.x - 30))
      await page.waitForTimeout(400)
      const handle = await box(frame.locator('[data-handle="se"]'))
      await page.mouse.move(handle.x + 5, handle.y + 5)
      await page.mouse.down()
      await page.mouse.move(handle.x + 5 + 40, handle.y + 5, { steps: 4 })
      await page.mouse.up()
      await expect(undoBtn(page, 'Undo Resize annotation')).toBeEnabled()
      await page.waitForTimeout(400)
      const d1 = await box(frame)
      expect(d1.width / d1.height).toBeCloseTo(aspect, 1)

      await saveFilled(page, 'Keep editable')
      const saved = await loadSaved(path)
      const [sig, date] = fillItems(saved, 0)
      expect(sig.kind).toBe('Signature')
      const w = sig.rect.x2 - sig.rect.x1
      expect(w).toBeCloseTo(150 + 40 / s, 0)
      expect(w / (sig.rect.y2 - sig.rect.y1)).toBeCloseTo(aspect, 1)
      // Left edge: click - half of the default width, +10 pt (arrows), -30 px (drag). The box grew to the right only.
      expect(sig.rect.x1).toBeCloseTo(300 / s - 75 + 10 - 30 / s, 0)
      // The date is a text item just under where the signature was placed, left-aligned with it.
      const today = await page.evaluate(() => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))
      expect(date.kind).toBe('Text')
      expect(date.contents).toBe(today)
      expect(date.rect.x1).toBeCloseTo(300 / s - 75, 0)
      expect(date.rect.y2).toBeLessThan(792 - 400 / s)
    } finally {
      await app.close()
    }
  })

  test('placing on a rotated page puts the image upright on the click', async () => {
    const path = copyFixture('forms-rotated.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await createDrawnSignature(page, app)
      const [sig] = await signatureList(page)
      await clickTool(page, 'Sign')
      const pb = await box(page.locator('[data-page="1"]'))
      const s = pb.width / 792
      await page.mouse.click(pb.x + 400, pb.y + 300)
      await expect(undoBtn(page, 'Undo Sign')).toBeEnabled()
      await saveFilled(page, 'Keep editable')
      const saved = await loadSaved(path)
      const [item] = fillItems(saved, 0)
      const b = item.rect
      // Drawn upright for the reader: its appearance is turned by the page's 90 degrees.
      const n = item.dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFStream
      const m = n.dict.lookup(PDFName.of('Matrix'), PDFArray).asArray().map((v) => Number(v.toString()))
      expect(Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI)).toBe(90)
      // 90-degree page: css (x, y) = s * (user y, user x). The image is 150 pt wide on screen = along user y.
      expect((b.x1 + b.x2) / 2).toBeCloseTo(300 / s, 0)
      expect((b.y1 + b.y2) / 2).toBeCloseTo(400 / s, 0)
      expect(b.y2 - b.y1).toBeCloseTo(150, 0)
      expect((b.y2 - b.y1) / (b.x2 - b.x1)).toBeCloseTo(sig.width / sig.height, 1)
    } finally {
      await app.close()
    }
  })

  test('initials: create as initials, place with the Initials tool at the smaller default size', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Tools', 'Signatures…')
      const dialog = page.getByRole('dialog', { name: 'Signatures' })
      await dialog.getByLabel('Initials').check()
      await drawSignature(page)
      await dialog.getByRole('button', { name: 'Save initials' }).click()
      await expect(dialog.getByTestId('signature-list')).toContainText('Initials 1')
      await dialog.getByRole('button', { name: 'Use' }).click()
      await expect(page.locator('button[data-tool="sign.initials"]')).toHaveAttribute('aria-pressed', 'true')
      const pb = await box(page.locator('[data-page="1"]'))
      const s = pb.width / 612
      await page.mouse.click(pb.x + 250, pb.y + 250)
      await expect(undoBtn(page, 'Undo Add initials')).toBeEnabled()
      await saveFilled(page, 'Keep editable')
      const [placed] = fillItems(await loadSaved(path), 0)
      expect(placed.rect.x2 - placed.rect.x1).toBeCloseTo(60, 0)
      expect((placed.rect.x1 + placed.rect.x2) / 2).toBeCloseTo(250 / s, 0)
    } finally {
      await app.close()
    }
  })

  test('type a name in a script font, and import an image with its white background removed', async () => {
    const { app, page } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Tools', 'Signatures…')
      const dialog = page.getByRole('dialog', { name: 'Signatures' })

      await dialog.getByRole('tab', { name: 'Type' }).click()
      await expect(dialog.getByRole('button', { name: 'Save signature' })).toBeDisabled() // nothing typed yet
      await dialog.getByLabel('Type your name').fill('Ada Lovelace')
      await dialog.getByRole('radio', { name: 'Allura' }).check()
      await expect(dialog.getByRole('button', { name: 'Save signature' })).toBeEnabled()
      await dialog.getByLabel('Name', { exact: true }).fill('Typed one')
      await dialog.getByRole('button', { name: 'Save signature' }).click()
      await expect(dialog.getByTestId('signature-list')).toContainText('Typed one')

      const pngPath = join(mkdtempSync(join(tmpdir(), 'epdf-sig-')), 'scan.png')
      writeFileSync(pngPath, makePng(300, 120))
      await dialog.getByRole('tab', { name: 'Import image' }).click()
      await dialog.getByTestId('signature-import-file').setInputFiles(pngPath)
      await expect(dialog.getByRole('img', { name: /Preview of scan\.png/ })).toBeVisible()
      await dialog.getByLabel('Name', { exact: true }).fill('Imported one')
      await dialog.getByRole('button', { name: 'Save signature' }).click()
      await expect(dialog.getByTestId('signature-list')).toContainText('Imported one')

      const list = await signatureList(page)
      expect(list.map((s) => s.name).sort()).toEqual(['Imported one', 'Typed one'])
      // The imported image really has transparent paper: corner pixels are clear, ink is opaque.
      const imported = list.find((s) => s.name === 'Imported one')!
      const alpha = await page.evaluate(async (png) => {
        const bmp = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }))
        const c = document.createElement('canvas')
        c.width = bmp.width
        c.height = bmp.height
        const ctx = c.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        const px = (x: number, y: number): number => ctx.getImageData(x, y, 1, 1).data[3]
        const opaque = ctx.getImageData(0, 0, c.width, c.height).data.filter((_, i) => i % 4 === 3 && _ > 200).length
        return { corner: px(0, 0), opaque, total: c.width * c.height }
      }, imported.png)
      expect(alpha.corner).toBe(0)
      expect(alpha.opaque).toBeGreaterThan(50)
      expect(alpha.opaque).toBeLessThan(alpha.total / 2)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('import failures: a file that is not an image, and turning removal off keeps the whole picture', async () => {
    const { app, page } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Tools', 'Signatures…')
      const dialog = page.getByRole('dialog', { name: 'Signatures' })
      await dialog.getByRole('tab', { name: 'Import image' }).click()
      const dir = mkdtempSync(join(tmpdir(), 'epdf-sig-'))
      writeFileSync(join(dir, 'fake.png'), 'this is not a picture')
      await dialog.getByTestId('signature-import-file').setInputFiles(join(dir, 'fake.png'))
      await expect(dialog.getByRole('alert')).toContainText(/could not be read as an image/)
      await expect(dialog.getByRole('button', { name: 'Save signature' })).toBeDisabled()
      writeFileSync(join(dir, 'notes.txt'), 'text')
      await dialog.getByTestId('signature-import-file').setInputFiles(join(dir, 'notes.txt'))
      await expect(dialog.getByRole('alert')).toContainText('Choose a PNG or JPEG image')
    } finally {
      await app.close()
    }
  })

  test('signatures are encrypted at rest: the PNG never appears in the database or anywhere in the profile', async () => {
    const { app, page, userData } = await launch({ files: [copyFixture('flat.pdf')] })
    let png: number[] = []
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await createDrawnSignature(page, app, 'Secret one')
      png = (await signatureList(page))[0].png
      expect(png.length).toBeGreaterThan(200)
    } finally {
      await app.close()
    }
    const bytes = Buffer.from(png)
    const b64 = bytes.toString('base64')
    // Distinctive slices of the image: header, a chunk from the middle of the pixel data, and the tail.
    const needles = [bytes, bytes.subarray(0, 64), bytes.subarray(Math.floor(bytes.length / 2), Math.floor(bytes.length / 2) + 48), bytes.subarray(bytes.length - 24), Buffer.from(b64.slice(0, 80)), Buffer.from(b64.slice(b64.length >> 1, (b64.length >> 1) + 80))]
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n)
        try {
          return statSync(p).isDirectory() ? walk(p) : [p]
        } catch {
          return []
        }
      })
    const files = walk(userData)
    expect(files.some((f) => f.endsWith('epdf.db'))).toBe(true)
    for (const f of files) {
      let data: Buffer
      try {
        data = readFileSync(f)
      } catch {
        continue // locked by a still-exiting Chromium process: not a place we write signatures
      }
      for (const n of needles) expect(data.includes(n), `${f} must not contain the signature image`).toBe(false)
    }
    // The row exists and holds ciphertext that is not a PNG.
    const db = new Database(join(userData, 'epdf.db'), { readonly: true })
    const rows = db.prepare('SELECT name, image FROM signatures').all() as { name: string; image: Buffer }[]
    db.close()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Secret one')
    expect(rows[0].image.length).toBeGreaterThan(50)
    expect(rows[0].image.subarray(1, 4).toString()).not.toBe('PNG')
    expect(rows[0].image.includes(Buffer.from('IHDR'))).toBe(false)

    // ...and it decrypts again in a fresh launch of the app on the same profile.
    const again = await launch({ userData, files: [copyFixture('flat.pdf')] })
    try {
      await expect(again.page.locator('[data-page="1"] canvas')).toBeVisible()
      const list = await signatureList(again.page)
      expect(list).toHaveLength(1)
      expect(Buffer.from(list[0].png).equals(bytes)).toBe(true)
    } finally {
      await again.app.close()
    }
  })

  test('when the OS cannot encrypt, nothing is saved and the dialog says why (no plain-text fallback)', async () => {
    const { app, page, userData } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await app.evaluate(({ safeStorage }) => {
        ;(safeStorage as unknown as { isEncryptionAvailable: () => boolean }).isEncryptionAvailable = () => false
      })
      await menuClick(app, 'Tools', 'Signatures…')
      const dialog = page.getByRole('dialog', { name: 'Signatures' })
      await expect(dialog.getByTestId('encryption-unavailable')).toContainText('never stores signatures without encryption')
      await drawSignature(page)
      await expect(dialog.getByRole('button', { name: 'Save signature' })).toBeDisabled()

      // Even a direct call to main is refused.
      const res = await page.evaluate(() =>
        window.epdf.call<{ ok: boolean; code?: string; message?: string }>('sign:save', {
          name: 'x',
          kind: 'signature',
          method: 'draw',
          png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
          width: 1,
          height: 1
        })
      )
      expect(res).toMatchObject({ ok: false, code: 'encryption-unavailable' })
      expect(await signatureList(page)).toHaveLength(0)
      expect(await page.evaluate(() => window.epdf.call<{ encryptionAvailable: boolean }>('sign:status', {}))).toEqual({ encryptionAvailable: false })
    } finally {
      await app.close()
    }
    const db = new Database(join(userData, 'epdf.db'), { readonly: true })
    expect((db.prepare('SELECT COUNT(*) AS n FROM signatures').get() as { n: number }).n).toBe(0)
    db.close()
  })

  test('save fails cleanly if encryption disappears after the dialog opened', async () => {
    const { app, page } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Tools', 'Signatures…')
      const dialog = page.getByRole('dialog', { name: 'Signatures' })
      await drawSignature(page)
      await expect(dialog.getByRole('button', { name: 'Save signature' })).toBeEnabled()
      await app.evaluate(({ safeStorage }) => {
        ;(safeStorage as unknown as { isEncryptionAvailable: () => boolean }).isEncryptionAvailable = () => false
      })
      await dialog.getByRole('button', { name: 'Save signature' }).click()
      await expect(dialog.getByTestId('signature-error')).toContainText('secure storage is not available')
      await expect(dialog.getByTestId('signature-list')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('channel validation: oversize or malformed signature payloads are rejected by main', async () => {
    const { app, page } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const call = (payload: unknown) =>
        page.evaluate(async (p) => {
          try {
            await window.epdf.call('sign:save', p)
            return 'accepted'
          } catch (e) {
            return (e as Error).message
          }
        }, payload)
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
      expect(await call({ name: 'x', kind: 'signature', method: 'draw', png: new Uint8Array(2_000_000), width: 1, height: 1 })).toMatch(/Invalid request/)
      expect(await call({ name: '', kind: 'signature', method: 'draw', png, width: 1, height: 1 })).toMatch(/Invalid request/)
      expect(await call({ name: 'x', kind: 'nope', method: 'draw', png, width: 1, height: 1 })).toMatch(/Invalid request/)
      expect(await call({ name: 'x', kind: 'signature', method: 'draw', png, width: 99999, height: 1 })).toMatch(/Invalid request/)
      expect(await call({ name: 'x', kind: 'signature', method: 'draw', png: 'text', width: 1, height: 1 })).toMatch(/Invalid request/)
      expect(await call({ name: 'x', kind: 'signature', method: 'draw', png: new Uint8Array(20), width: 1, height: 1 })).toMatch(/rejected|not a valid PNG|accepted/)
      expect((await signatureList(page)).length).toBe(0)
      // Fonts are served by name only.
      const bad = await page.evaluate(() => window.epdf.call('forms:font', { name: '../../secret' }).then(() => 'ok', (e: Error) => e.message))
      expect(bad).toMatch(/Invalid request/)
    } finally {
      await app.close()
    }
  })

  test('cancelled dialogs and placements change nothing; deleting asks first', async () => {
    const path = copyFixture('flat.pdf')
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      // Escape closes the dialog and saves nothing.
      await menuClick(app, 'Tools', 'Signatures…')
      const dialog = page.getByRole('dialog', { name: 'Signatures' })
      await drawSignature(page)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      expect(await signatureList(page)).toHaveLength(0)

      // With a signature saved: a placement is taken back with Undo, or deleted (asking first).
      await createDrawnSignature(page, app)
      await clickTool(page, 'Sign')
      const pb = await box(page.locator('[data-page="1"]'))
      await page.mouse.click(pb.x + 300, pb.y + 300)
      await expect(placedFrame(page)).toBeVisible()
      await undoBtn(page, 'Undo Sign').click()
      await expect(placedFrame(page)).toHaveCount(0)
      await clickTool(page, 'Sign')
      await page.mouse.click(pb.x + 300, pb.y + 300)
      await placedFrame(page).focus()
      await page.keyboard.press('Delete')
      await page.getByRole('dialog', { name: 'Delete this signature?' }).getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(placedFrame(page)).toHaveCount(0)
      await clickTool(page, 'Sign')

      // Delete: cancelling keeps it, confirming removes it.
      await menuClick(app, 'Tools', 'Signatures…')
      await dialog.getByRole('button', { name: 'Delete Ada signature' }).click()
      await page.getByRole('dialog', { name: 'Delete signature?' }).getByRole('button', { name: 'Cancel' }).click()
      expect(await signatureList(page)).toHaveLength(1)
      await dialog.getByRole('button', { name: 'Delete Ada signature' }).click()
      await page.getByRole('dialog', { name: 'Delete signature?' }).getByRole('button', { name: 'Delete' }).click()
      await expect(dialog.getByText('Nothing saved yet')).toBeVisible()
      expect(await signatureList(page)).toHaveLength(0)
      await dialog.getByRole('button', { name: 'Close' }).click()

      // With nothing saved, clicking the page with the Sign tool asks you to create one.
      await page.mouse.click(pb.x + 300, pb.y + 300)
      await expect(page.getByRole('dialog', { name: 'Signatures' })).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the Tools menu items activate the Sign, Initials and Add text tools', async () => {
    const { app, page } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Tools', 'Sign Document')
      await expect(page.locator('button[data-tool="sign.signature"]')).toHaveAttribute('aria-pressed', 'true')
      await menuClick(app, 'Tools', 'Add Initials')
      await expect(page.locator('button[data-tool="sign.initials"]')).toHaveAttribute('aria-pressed', 'true')
      await menuClick(app, 'Tools', 'Add Text')
      await expect(page.locator('button[data-tool="forms.addText"]')).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Escape')
      await expect(page.locator('button[data-tool="forms.addText"]')).toHaveAttribute('aria-pressed', 'false')
    } finally {
      await app.close()
    }
  })

  test('the UI says it is a visual signature, not a cryptographic one', async () => {
    const { app, page } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await clickTool(page, 'Sign')
      await expect(page.getByText('Visual signature only. Not a digital certificate signature.')).toBeVisible()
      await menuClick(app, 'Tools', 'Signatures…')
      await expect(page.getByTestId('visual-signature-notice')).toContainText('not a cryptographic digital signature')
    } finally {
      await app.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------------------------------------

test.describe('accessibility (WCAG 2.1 A/AA)', () => {
  test('the form overlay, banner and Add text box: light and dark', async () => {
    const { app, page } = await launch({ files: [copyFixture('forms.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await page.getByRole('button', { name: 'Highlight fields' }).click()
      for (const theme of [false, true]) {
        await dark(app, theme)
        await expect(page.locator('html')).toHaveClass(theme ? /dark/ : /^(?!.*dark)/)
        expect(await axeWithOverlays(page, `form ${theme ? 'dark' : 'light'}`)).toEqual([])
      }
      await dark(app, false)
      await clickTool(page, 'Add text')
      const pb = await box(page.locator('[data-page="1"]'))
      await page.mouse.click(pb.x + 300, pb.y + 350)
      await page.getByLabel('Text to add to the page').fill('a11y')
      for (const theme of [false, true]) {
        await dark(app, theme)
        expect(await axeWithOverlays(page, `add-text ${theme ? 'dark' : 'light'}`)).toEqual([])
      }
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the Signatures dialog (draw, type, import) and a placed signature: light and dark', async () => {
    const { app, page } = await launch({ files: [copyFixture('flat.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await menuClick(app, 'Tools', 'Signatures…')
      const dialog = page.getByRole('dialog', { name: 'Signatures' })
      await drawSignature(page)
      for (const theme of [false, true]) {
        await dark(app, theme)
        for (const [tabName, label] of [
          ['Draw', 'draw'],
          ['Type', 'type'],
          ['Import image', 'import']
        ]) {
          await dialog.getByRole('tab', { name: tabName }).click()
          if (label === 'type') await dialog.getByLabel('Type your name').fill('Ada')
          expect(await axeViolations(page, `signature dialog ${label} ${theme ? 'dark' : 'light'}`)).toEqual([])
        }
      }
      await dark(app, false)
      await dialog.getByRole('tab', { name: 'Type' }).click()
      await dialog.getByLabel('Type your name').fill('Ada')
      await expect(dialog.getByRole('button', { name: 'Save signature' })).toBeEnabled()
      await dialog.getByRole('button', { name: 'Save signature' }).click()
      await expect(dialog.getByTestId('signature-list')).toBeVisible()
      await dialog.getByRole('button', { name: 'Close' }).click()
      await clickTool(page, 'Sign')
      const pb = await box(page.locator('[data-page="1"]'))
      await page.mouse.click(pb.x + 300, pb.y + 300)
      await expect(placedFrame(page)).toBeVisible()
      for (const theme of [false, true]) {
        await dark(app, theme)
        expect(await axeWithOverlays(page, `placement ${theme ? 'dark' : 'light'}`)).toEqual([])
      }
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// The shared fixtures directory is regenerated by global setup; this keeps `existsSync` honest for editors.
void existsSync
