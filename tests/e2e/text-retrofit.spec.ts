import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { grayPng } from '../support/png'
import { appearanceModels, appearanceOnlyPdf, norm, pageModel, pdfjsAnnotations, pageTexts } from '../support/retrofit'
import { inkBox, similarity, toInk, type Ink } from '../support/textCompare'
import { FIX, copyFixture, launch, menuClick, quitDiscarding } from './helpers'

/**
 * Every feature that writes text into a PDF, driven through the real app with Arabic (and Hebrew / mixed) text:
 * the saved file is read back in logical order with the page text model (and PDF.js for form fields), and what the
 * text looks like is compared with Chromium's own rendering of the same string in the same fonts (the text engine's
 * comparison harness), with a negative control (unjoined letters in the wrong order) that must fail.
 */

const OUT = resolve('test-results/text-retrofit')

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/forms-signing.mjs', resolve(FIX)], { stdio: 'inherit' })
  execFileSync(process.execPath, ['tests/fixtures/markup.mjs', resolve(FIX)], { stdio: 'inherit' })
  execFileSync(process.execPath, ['tests/fixtures/redact.mjs', FIX], { stdio: 'ignore' })
  execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/unit/retrofit-fixtures.test.ts'], { stdio: 'inherit' })
  mkdirSync(OUT, { recursive: true })
})

// ---------------------------------------------------------------- helpers

const dot = (page: Page) => page.getByTestId('unsaved-dot')
async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dot(page)).toHaveCount(0)
}
const ribbonTool = (page: Page, label: string) => page.locator('button[data-tool]', { hasText: label })

async function open(file: string): Promise<{ app: ElectronApplication; page: Page; path: string }> {
  const path = copyFixture(file)
  const { app, page } = await launch({ files: [path] })
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 30_000 })
  return { app, page, path }
}

const fontUrl = (dir: string, file: string): string => 'file:///' + resolve('resources', dir, file).replace(/\\/g, '/')
/** The engine's fallback order for the "Helvetica" stack, as Chromium @font-face families. */
const SANS_FONTS = [
  { name: 'RT-LiberationSans', url: fontUrl('fonts', 'LiberationSans-Regular.ttf') },
  { name: 'RT-NotoSans', url: fontUrl('fonts', 'NotoSans-Regular.ttf') },
  { name: 'RT-LiberationSerif', url: fontUrl('fonts', 'LiberationSerif-Regular.ttf') },
  { name: 'RT-NotoSansArabic', url: fontUrl('textfonts', 'NotoSansArabic-Regular.ttf') },
  { name: 'RT-NotoNaskhArabic', url: fontUrl('textfonts', 'NotoNaskhArabic-Regular.ttf') },
  { name: 'RT-NotoSansHebrew', url: fontUrl('textfonts', 'NotoSansHebrew-Regular.ttf') }
]

function crop(img: Ink, x: number, y: number, w: number, h: number): Ink {
  x = Math.max(0, Math.round(x))
  y = Math.max(0, Math.round(y))
  w = Math.min(img.width - x, Math.round(w))
  h = Math.min(img.height - y, Math.round(h))
  const data = new Float32Array(w * h)
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) data[yy * w + xx] = img.data[(y + yy) * img.width + (x + xx)]!
  return { width: w, height: h, data }
}

function saveSideBySide(name: string, a: Ink, b: Ink): void {
  const ba = inkBox(a) ?? { x0: 0, y0: 0, x1: a.width, y1: a.height }
  const bb = inkBox(b) ?? { x0: 0, y0: 0, x1: b.width, y1: b.height }
  const ca = crop(a, ba.x0, ba.y0, ba.x1 - ba.x0, ba.y1 - ba.y0)
  const cb = crop(b, bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0)
  const w = Math.max(ca.width, cb.width) + 8
  const h = ca.height + cb.height + 12
  const data = new Float32Array(w * h)
  for (let y = 0; y < ca.height; y++) for (let x = 0; x < ca.width; x++) data[(y + 4) * w + x + 4] = ca.data[y * ca.width + x]!
  for (let y = 0; y < cb.height; y++) for (let x = 0; x < cb.width; x++) data[(ca.height + 8 + y) * w + x + 4] = cb.data[y * cb.width + x]!
  writeFileSync(join(OUT, `${name}.png`), grayPng(w, h, data))
}

/**
 * Renders page 1 of `bytes` with PDF.js (harness window), crops `region` (points, top-left origin, y down) and
 * compares it with Chromium rendering `text` in the same fonts at `sizePt`; also checks the negative control.
 */
async function compareWithChromium(name: string, bytes: Uint8Array, region: { x0: number; y0: number; x1: number; y1: number }, text: string, dir: 'rtl' | 'ltr', sizePt: number): Promise<void> {
  const harness = await electron.launch({ args: [resolve('tests/support/textHarness/main.cjs')], env: { ...process.env, EPDF_HARNESS_ROOT: resolve('.') } as Record<string, string> })
  try {
    const hp = await harness.firstWindow()
    await hp.waitForFunction(() => (window as unknown as { __harness?: { ready: boolean } }).__harness?.ready === true, undefined, { timeout: 60_000 })
    const r = await hp.evaluate((b) => (window as unknown as { __harness: { renderPdf(b: string): Promise<{ width: number; height: number; rgba: string }> } }).__harness.renderPdf(b), Buffer.from(bytes).toString('base64'))
    const k = 96 / 72
    const full = toInk(Buffer.from(r.rgba, 'base64'), r.width, r.height)
    const got = crop(full, region.x0 * k, region.y0 * k, (region.x1 - region.x0) * k, (region.y1 - region.y0) * k)
    const reference = async (t: string, d: 'rtl' | 'ltr'): Promise<Ink> => {
      const rect = await hp.evaluate(
        (s) => (window as unknown as { __harness: { renderHtml(s: unknown): Promise<{ x: number; y: number; width: number; height: number }> } }).__harness.renderHtml(s),
        { fonts: SANS_FONTS, families: SANS_FONTS.map((f) => f.name), sizePt, boxWidth: 700, lines: [{ text: t, dir: d, height: sizePt * 2 }] }
      )
      const cap = await harness.evaluate(async ({ BrowserWindow }, rr) => {
        const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(rr)
        return { width: img.getSize().width, height: img.getSize().height, data: img.toBitmap().toString('base64') }
      }, rect)
      const bgra = Buffer.from(cap.data, 'base64')
      const rgba = new Uint8Array(bgra.length)
      for (let i = 0; i < bgra.length; i += 4) {
        rgba[i] = bgra[i + 2]!
        rgba[i + 1] = bgra[i + 1]!
        rgba[i + 2] = bgra[i]!
        rgba[i + 3] = 255
      }
      return toInk(rgba, cap.width, cap.height)
    }
    const good = await reference(text, dir)
    const s = similarity(got, good)
    saveSideBySide(`${name}-vs-chromium`, got, good)
    console.log(`${name} vs Chromium: ncc ${s.ncc.toFixed(3)} width ${s.a.width}/${s.b.width} height ${s.a.height}/${s.b.height}`)
    expect(s.ncc, `${name} ncc`).toBeGreaterThanOrEqual(0.8)
    expect(Math.abs(s.a.width - s.b.width), `${name} ink width ${s.a.width} vs ${s.b.width}`).toBeLessThanOrEqual(s.b.width * 0.04 + 2)
    const bad = similarity(got, await reference(Array.from(text).join('‌'), 'ltr'))
    console.log(`${name} negative (unjoined, left to right): ncc ${bad.ncc.toFixed(3)}`)
    expect(bad.ncc, `${name} negative control`).toBeLessThan(0.75)
  } finally {
    await harness.close()
  }
}

/** Page box (points, display space) of the first model line whose text is `text`. */
function lineBox(m: Awaited<ReturnType<typeof pageModel>>, text: string, pad = 3): { x0: number; y0: number; x1: number; y1: number; size: number } {
  const l = m.lines.find((x) => norm(m.text.slice(x.start, x.end)) === norm(text))
  if (!l) throw new Error(`no line "${text}" in ${JSON.stringify(m.text)}`)
  return { x0: l.x0 - pad, y0: l.y0 - pad, x1: l.x1 + pad, y1: l.y1 + pad, size: l.size }
}

// ---------------------------------------------------------------- form fields

test('form fields: Arabic and Hebrew values are saved logically, drawn by the engine, read by PDF.js and look right', async () => {
  const { app, page, path } = await open('forms.pdf')
  const AR = 'الاسم الكامل'
  try {
    const name = page.getByLabel('Full name', { exact: true })
    await expect(name).toHaveAttribute('dir', 'auto')
    await name.fill(AR)
    await name.press('Enter')
    await expect(page.getByRole('button', { name: 'Undo Fill “Full name”' })).toBeEnabled()
    await page.getByLabel('Page number').fill('2')
    await page.getByLabel('Page number').press('Enter')
    const p2 = page.getByLabel('Page two field')
    await p2.fill('שלום עולם 2026')
    await p2.press('Enter')
    await save(page)
  } finally {
    await app.close()
  }
  const bytes = new Uint8Array(readFileSync(path))
  const pdf = await PDFDocument.load(bytes)
  const f = pdf.getForm().getTextField('full_name')
  expect(f.getText()).toBe(AR)
  const da = (f.acroField.dict.lookup(PDFName.of('DA')) as PDFString).decodeText()
  const fontName = /\/(\S+) /.exec(da)![1]
  expect(pdf.getForm().acroForm.dict.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict).get(PDFName.of(fontName))).toBeDefined()
  const annots = await pdfjsAnnotations(bytes)
  expect(annots.find((a) => a.fieldName === 'full_name')).toMatchObject({ fieldValue: AR, hasAppearance: true })
  const annots2 = await pdfjsAnnotations(bytes, 2)
  expect(annots2.find((a) => a.fieldName === 'page2_field')).toMatchObject({ fieldValue: 'שלום עולם 2026', hasAppearance: true })
  const models = await appearanceModels(bytes)
  expect(models[0].text.split('\n').map(norm)).toContain(AR)
  expect(models[1].text.split('\n').map(norm)).toContain('שלום עולם 2026')
  const flat = await appearanceOnlyPdf(bytes)
  writeFileSync(join(OUT, 'e2e-forms-appearance.pdf'), flat)
  // (a tight crop: the field's border is 2 pt from the text)
  const box = lineBox(models[0], AR, 0.8)
  await compareWithChromium('form-field', flat, box, AR, 'rtl', box.size)
})

// ---------------------------------------------------------------- Add text

test('Add text: Arabic typed in the box is drawn on the page, right-aligned, read back logically, and looks right', async () => {
  const { app, page, path } = await open('flat.pdf')
  const AR = 'مرحبا بكم في Epdf'
  try {
    await ribbonTool(page, 'Add text').click()
    const pb = (await page.locator('[data-page="1"]').boundingBox())!
    await page.mouse.click(pb.x + 150, pb.y + pb.height * 0.45) // an empty part of the page
    const area = page.getByLabel('Text to add to the page')
    await expect(area).toHaveAttribute('dir', 'auto')
    await area.fill(AR)
    await area.press('Control+Enter')
    await expect(page.getByRole('button', { name: 'Undo Add text' })).toBeEnabled()
    await save(page)
    // after reopening, the app's own text layer (page text model) has the logical string
    await menuClick(app, 'File', 'Reload from Disk')
    await expect(page.locator('[data-page="1"] .textLayer')).toContainText('مرحبا', { timeout: 20_000 })
  } finally {
    await app.close()
  }
  const bytes = new Uint8Array(readFileSync(path))
  const m = await pageModel(bytes)
  const box = lineBox(m, AR)
  expect(m.lines.find((l) => norm(m.text.slice(l.start, l.end)) === norm(AR))!.dir).toBe('rtl')
  writeFileSync(join(OUT, 'e2e-addtext.pdf'), bytes)
  await compareWithChromium('add-text', bytes, box, AR, 'rtl', box.size)
})

// ---------------------------------------------------------------- markup text box

test('Markup text box: Arabic /Contents and /RC are logical, the appearance reads back logically and looks right', async () => {
  const path = copyFixture('markup.pdf')
  const { app, page } = await launch({ files: [path] })
  const AR = 'راجع هذه الفقرة'
  try {
    await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
    await expect(page.locator('[data-page="1"] .textLayer span').first()).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
    await page.getByLabel('Zoom level').selectOption('fit-page')
    await page.waitForTimeout(800)
    await page.getByRole('toolbar', { name: 'Editing tools' }).getByRole('button', { name: 'Text box', exact: true }).click()
    await page.waitForTimeout(500)
    const pb = (await page.locator('[data-page="1"]').boundingBox())!
    const pt = (x: number, y: number) => ({ x: pb.x + (x / 612) * pb.width, y: pb.y + ((792 - y) / 792) * pb.height })
    const a = pt(300, 250)
    const b = pt(540, 210)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 8 })
    await page.mouse.up()
    const box = page.getByLabel('Text box text')
    await expect(box).toBeVisible()
    await box.fill(AR)
    await box.press('Control+Enter')
    await expect(page.getByRole('button', { name: /^Undo Add text box/ })).toBeEnabled()
    await save(page)
  } finally {
    await app.close()
  }
  const bytes = new Uint8Array(readFileSync(path))
  const pdf = await PDFDocument.load(bytes)
  const annots = pdf.getPage(0).node.Annots()!
  let found: PDFDict | undefined
  for (let i = 0; i < annots.size(); i++) {
    const d = annots.lookup(i)
    if (d instanceof PDFDict && d.get(PDFName.of('Subtype'))?.toString() === '/FreeText' && (d.lookup(PDFName.of('Contents')) as PDFString | undefined)?.decodeText() === AR) found = d
  }
  expect(found, 'the new FreeText annotation').toBeDefined()
  expect((found!.lookup(PDFName.of('RC')) as PDFString).decodeText()).toContain(`<p dir="rtl">${AR}</p>`)
  const flat = await appearanceOnlyPdf(bytes)
  const m = (await appearanceModels(bytes))[0]
  const lb = lineBox(m, AR, 0.8) // the box's border is 3 pt from the text
  await compareWithChromium('markup-textbox', flat, lb, AR, 'rtl', lb.size)
})

// ---------------------------------------------------------------- form builder

test('Form builder: a text field with an Arabic default value gets an engine appearance with its font in /DR', async () => {
  const { app, page, path } = await open('flat.pdf')
  try {
    await menuClick(app, 'Tools', 'Prepare Form…')
    await page.getByTestId('fb-panel').getByRole('button', { name: 'Text field', exact: true }).click()
    await expect(page.getByTestId('fb-field-count')).toContainText('Fields (1)', { timeout: 20_000 })
    const props = page.getByTestId('fb-properties')
    await props.getByLabel(/^Default value/).fill('القيمة الافتراضية')
    await props.getByLabel(/^Default value/).press('Enter')
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled()
    await page.waitForTimeout(500)
    await save(page)
  } finally {
    await quitDiscarding(app, page)
  }
  const bytes = new Uint8Array(readFileSync(path))
  const pdf = await PDFDocument.load(bytes)
  const field = pdf.getForm().getTextField('Text1')
  expect(field.getText()).toBe('القيمة الافتراضية')
  const da = (field.acroField.dict.lookup(PDFName.of('DA')) as PDFString).decodeText()
  expect(da).toMatch(/^\/EpdfSans(_\d+)? /)
  expect((await appearanceModels(bytes))[0].text.split('\n').map(norm)).toContain('القيمة الافتراضية')
  const annots = await pdfjsAnnotations(bytes)
  expect(annots.find((a) => a.fieldName === 'Text1')).toMatchObject({ fieldValue: 'القيمة الافتراضية', hasAppearance: true })
})

// ---------------------------------------------------------------- redaction

test('Redaction: a custom Arabic overlay text is shaped on the marks and the self-check passes', async () => {
  const path = copyFixture('redact-proof.pdf')
  const { app, page } = await launch({ files: [path] })
  try {
    await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
    await expect(page.locator('[data-page="1"] .textLayer')).not.toBeEmpty()
    await page.locator('[data-tool="redact-find"]').click()
    const panel = page.getByTestId('redact-panel')
    await panel.getByLabel('Text to find').fill('TOPSECRET')
    await page.getByTestId('redact-search').click()
    await page.getByTestId('redact-mark-all').click()
    await expect(page.getByTestId('redact-mark').first()).toBeVisible()
    await page.getByTestId('redact-open-apply').click()
    const dialog = page.getByTestId('redact-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: /Custom text/ }).check()
    const custom = dialog.getByLabel('Custom overlay text')
    await expect(custom).toHaveAttribute('dir', 'auto')
    await custom.fill('محجوب')
    await page.getByTestId('redact-preview-button').click()
    await expect(page.getByTestId('redact-selfcheck')).toContainText('Self-check passed', { timeout: 60_000 })
    await page.getByTestId('redact-apply-button').click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })
    await save(page)
  } finally {
    await quitDiscarding(app, page)
  }
  const bytes = new Uint8Array(readFileSync(path))
  const texts = await pageTexts(bytes)
  expect(norm(texts.join('\n'))).toContain('محجوب')
  expect(texts.join('\n')).not.toContain('TOPSECRET')
  writeFileSync(join(OUT, 'e2e-redact.pdf'), bytes)
})

// ---------------------------------------------------------------- comparison report

test('Comparison report: changed Arabic lines are written by the engine and read back in logical order', async () => {
  const newPath = copyFixture('rt-cmp-new.pdf')
  const oldPath = copyFixture('rt-cmp-old.pdf')
  const { app, page } = await launch({ files: [newPath] })
  const report = join(mkdtempSync(join(tmpdir(), 'epdf-rt-')), 'report.pdf')
  try {
    await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
    await menuClick(app, 'Tools', 'Compare Files…')
    await expect(page.getByTestId('compare-choose')).toBeVisible()
    await app.evaluate(({ dialog }, p) => {
      ;(dialog as unknown as { showOpenDialog: () => Promise<unknown> }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] })
    }, oldPath)
    await page.getByTestId('compare-old').getByRole('button', { name: 'Choose file…' }).click()
    await page.getByTestId('compare-start').click()
    await expect(page.getByTestId('compare-verdict')).toBeVisible({ timeout: 60_000 })
    await app.evaluate(({ dialog }, p) => {
      ;(dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p })
    }, report)
    await page.getByTestId('export-pdf').click()
    await expect(page.getByTestId('compare-announce')).toContainText('Saved the report as report.pdf')
  } finally {
    await app.close()
  }
  const bytes = new Uint8Array(readFileSync(report))
  writeFileSync(join(OUT, 'e2e-compare-report.pdf'), bytes)
  const text = norm((await pageTexts(bytes)).join('\n'))
  // the changed words, logical order (the report shows the changed passage of each version)
  expect(text).toMatch(/1,250|الأول/)
  expect(text).toMatch(/1,750|الثاني/)
  expect(text).not.toMatch(/[ﺀ-ﻼ]/) // no presentation forms leaked into the extracted text
})
