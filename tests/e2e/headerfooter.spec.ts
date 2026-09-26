import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { summarizeMarks } from '../../src/renderer/src/features/headerfooter/pdf/remove'
import { grayPng } from '../support/png'
import { inkBox as inkBoxOf, similarity, toInk, type Ink } from '../support/textCompare'
import { seePages } from '../unit/helpers/hfPdfjs'
import { openWith } from '../unit/helpers/securityHelpers'
import { axeViolations, copyFixture, fixture, launch, menuClick, quitDiscarding } from './helpers'

/**
 * Headers & footers, Bates numbers, watermarks and backgrounds in the real app. Every visual claim is checked on the
 * rendered page (PDF.js canvas in the viewer): where the ink is and what colour it has, not just "no crash". The
 * Arabic header is additionally compared with Chromium's own rendering of the same text in the same font (the text
 * engine's harness), with a negative control that must fail.
 */

const OUT = resolve('test-results/headerfooter')

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/headerfooter.mjs', resolve('test-results/fixtures')], { stdio: 'inherit' })
  mkdirSync(OUT, { recursive: true })
})

// ---------------------------------------------------------------- helpers

async function open(file: string, opts: Parameters<typeof launch>[0] = {}): Promise<{ app: ElectronApplication; page: Page; path: string }> {
  const path = file.includes('\\') || file.includes('/') ? file : copyFixture(file)
  const launched = await launch({ files: [path], ...opts })
  await expect(launched.page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 30_000 })
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
  await launched.page.waitForTimeout(300)
  return { ...launched, path }
}

const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Headers, footers and watermarks' })

async function openDialog(app: ElectronApplication, page: Page, item: string): Promise<Locator> {
  await menuClick(app, 'Document', item)
  const d = dialog(page)
  await expect(d.getByTestId('hf-dialog')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
  return d
}

async function applyAndWait(page: Page, d: Locator, button: 'Apply' | 'Update' = 'Apply'): Promise<void> {
  await d.getByRole('button', { name: button, exact: true }).click()
  await expect(d).toHaveCount(0, { timeout: 120_000 })
  await expect(page.getByTestId('unsaved-dot')).toHaveCount(1)
}

async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
}

/** Waits until page n's canvas was re-rendered after an edit and returns its pixels. */
async function canvasPixels(page: Page, n: number): Promise<{ width: number; height: number; data: number[] }> {
  await page.waitForTimeout(700)
  return page.evaluate((num) => {
    const c = document.querySelector<HTMLCanvasElement>(`[data-page="${num}"] canvas`)!
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
    return { width: c.width, height: c.height, data: Array.from(d.data) }
  }, n)
}

type Px = Awaited<ReturnType<typeof canvasPixels>>
type Pred = (r: number, g: number, b: number) => boolean
const dark: Pred = (r, g, b) => r + g + b < 300
/** Bounding box (fractions of the page) of pixels matching `pred` inside `region` (fractions). */
function inkIn(px: Px, pred: Pred, region: [number, number, number, number] = [0, 0, 1, 1]): { x0: number; y0: number; x1: number; y1: number; count: number } | null {
  const [rx0, ry0, rx1, ry1] = [region[0] * px.width, region[1] * px.height, region[2] * px.width, region[3] * px.height].map(Math.round)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  let count = 0
  for (let y = ry0!; y < ry1!; y++) {
    for (let x = rx0!; x < rx1!; x++) {
      const i = (y * px.width + x) * 4
      if (pred(px.data[i]!, px.data[i + 1]!, px.data[i + 2]!)) {
        count++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0: x0 / px.width, y0: y0 / px.height, x1: (x1 + 1) / px.width, y1: (y1 + 1) / px.height, count }
}
const pixelAt = (px: Px, fx: number, fy: number): [number, number, number] => {
  const i = (Math.round(fy * (px.height - 1)) * px.width + Math.round(fx * (px.width - 1))) * 4
  return [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!]
}

async function selectTab(d: Locator, name: string): Promise<void> {
  await d.getByRole('tab', { name }).click()
  await expect(d.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
}

// ---------------------------------------------------------------- Arabic header: position and shaping

test.describe('headers and footers', () => {
  test('Arabic header "صفحة ١ من ٣": placed at the top centre, shaped like Chromium renders it, saved correctly', async () => {
    const { app, page, path } = await open('hf-basic.pdf')
    try {
      const d = await openDialog(app, page, 'Header and Footer…')
      await d.getByLabel('Footer center').fill('')
      await d.getByLabel('Header center').fill('صفحة {page} من {pages}')
      await d.getByLabel('Page numbers').selectOption('arabic-indic')
      await d.getByLabel('Font', { exact: true }).selectOption('Noto Naskh Arabic')
      await d.getByLabel('Size', { exact: true }).fill('18')
      await expect(d.getByTestId('hf-preview')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
      await applyAndWait(page, d)
      await expect(page.getByRole('button', { name: 'Undo Add header and footer' })).toBeVisible()

      // In the viewer: the only ink in the top band is the header, centred between the margins, just below 36 pt.
      const px = await canvasPixels(page, 1)
      const box = inkIn(px, dark, [0, 0, 1, 0.2])!
      expect(box, 'header ink in the top band').toBeTruthy()
      const cx = (box.x0 + box.x1) / 2
      expect(Math.abs(cx - 0.5), `centre ${cx}`).toBeLessThan(0.01)
      expect(box.y0 * 792, `top of the ink ${box.y0 * 792} pt`).toBeGreaterThan(36)
      expect(box.y1 * 792).toBeLessThan(36 + 34)
      expect((box.x1 - box.x0) * 612, 'plausible width for 4 short words at 18 pt').toBeGreaterThan(60)
      await save(page)
    } finally {
      await quitDiscarding(app, page)
    }

    // On disk: marks found, PDF.js extracts the logical Arabic text on each page.
    const bytes = new Uint8Array(readFileSync(path))
    const pdf = await PDFDocument.load(bytes)
    expect(summarizeMarks(pdf).headerfooter.pages).toBe(3)
    const seen = await seePages(bytes)
    expect(seen.map((p) => p.items.find((t) => /[؀-ۿ]/.test(t.str))?.str)).toEqual(['صفحة ١ من ٣', 'صفحة ٢ من ٣', 'صفحة ٣ من ٣'])
    writeFileSync(join(OUT, 'arabic-header.pdf'), bytes)

    // Shaping and order against Chromium's own rendering of the same line, same font, same size.
    const harness = await electron.launch({ args: [resolve('tests/support/textHarness/main.cjs')], env: { ...process.env, EPDF_HARNESS_ROOT: resolve('.') } as Record<string, string> })
    try {
      const hp = await harness.firstWindow()
      await hp.waitForFunction(() => (window as unknown as { __harness?: { ready: boolean } }).__harness?.ready === true, undefined, { timeout: 60_000 })
      const rendered = await hp.evaluate((b) => (window as unknown as { __harness: { renderPdf(b: string): Promise<{ width: number; height: number; rgba: string }> } }).__harness.renderPdf(b), Buffer.from(bytes).toString('base64'))
      const full = toInk(Buffer.from(rendered.rgba, 'base64'), rendered.width, rendered.height)
      const header = cropInk(full, 0, 0, full.width, Math.round(full.height * 0.2))
      const fontUrl = (dir: string, file: string): string => 'file:///' + resolve('resources', dir, file).replace(/\\/g, '/')
      const fonts = [
        { name: 'HF-Naskh', url: fontUrl('textfonts', 'NotoNaskhArabic-Regular.ttf') },
        { name: 'HF-Sans', url: fontUrl('fonts', 'NotoSans-Regular.ttf') }
      ]
      const reference = async (text: string, dir: 'rtl' | 'ltr'): Promise<Ink> => {
        const rect = await hp.evaluate(
          (s) => (window as unknown as { __harness: { renderHtml(s: unknown): Promise<{ x: number; y: number; width: number; height: number }> } }).__harness.renderHtml(s),
          { fonts, families: fonts.map((f) => f.name), sizePt: 18, boxWidth: 400, lines: [{ text, dir, height: 40, align: 'center' }] }
        )
        const cap = await harness.evaluate(async ({ BrowserWindow }, r) => {
          const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(r)
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
      const good = await reference('صفحة ١ من ٣', 'rtl')
      const s = similarity(header, good)
      saveSideBySide('arabic-header-vs-chromium', header, good)
      console.log(`Arabic header vs Chromium: ncc ${s.ncc.toFixed(3)} width ${s.a.width}/${s.b.width} height ${s.a.height}/${s.b.height}`)
      expect(s.ncc).toBeGreaterThanOrEqual(0.8)
      expect(Math.abs(s.a.width - s.b.width)).toBeLessThanOrEqual(s.b.width * 0.04 + 2)
      // Negative controls: unjoined letters in the wrong order (what pdf-lib's drawText would produce), and the
      // numbers swapped, must NOT match as well.
      const unjoined = await reference(Array.from('صفحة ١ من ٣').join('‌'), 'ltr')
      const bad = similarity(header, unjoined)
      console.log(`negative (unjoined, LTR): ncc ${bad.ncc.toFixed(3)}`)
      expect(bad.ncc).toBeLessThan(0.75)
      const swapped = similarity(header, await reference('صفحة ٣ من ١', 'rtl'))
      console.log(`negative (numbers swapped): ncc ${swapped.ncc.toFixed(3)}`)
      expect(swapped.ncc).toBeLessThan(s.ncc)
    } finally {
      await harness.close()
    }
  })
})

function cropInk(img: Ink, x: number, y: number, w: number, h: number): Ink {
  const data = new Float32Array(w * h)
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) data[yy * w + xx] = img.data[(y + yy) * img.width + (x + xx)]!
  return { width: w, height: h, data }
}

function saveSideBySide(name: string, a: Ink, b: Ink): void {
  const ba = inkBoxOf(a) ?? { x0: 0, y0: 0, x1: a.width, y1: a.height }
  const bb = inkBoxOf(b) ?? { x0: 0, y0: 0, x1: b.width, y1: b.height }
  const ca = cropInk(a, ba.x0, ba.y0, ba.x1 - ba.x0, ba.y1 - ba.y0)
  const cb = cropInk(b, bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0)
  const w = Math.max(ca.width, cb.width) + 8
  const h = ca.height + cb.height + 12
  const data = new Float32Array(w * h)
  for (let y = 0; y < ca.height; y++) for (let x = 0; x < ca.width; x++) data[(y + 4) * w + x + 4] = ca.data[y * ca.width + x]!
  for (let y = 0; y < cb.height; y++) for (let x = 0; x < cb.width; x++) data[(ca.height + 8 + y) * w + x + 4] = cb.data[y * cb.width + x]!
  writeFileSync(join(OUT, `${name}.png`), grayPng(w, h, data))
}

export { canvasPixels, inkIn, pixelAt, dark, selectTab, open, openDialog, applyAndWait, save, mkdtempSync, tmpdir, fixture, openWith, axeViolations }
