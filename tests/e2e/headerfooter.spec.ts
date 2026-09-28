import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument, PDFName } from 'pdf-lib'
import { summarizeMarks } from '../../src/renderer/src/features/headerfooter/pdf/remove'
import { grayPng } from '../support/png'
import { inkBox as inkBoxOf, similarity, toInk, type Ink } from '../support/textCompare'
import { seePages } from '../unit/helpers/hfPdfjs'
import { openWith } from '../unit/helpers/securityHelpers'
import { axeViolations, copyFixture, fixture, gotoPage, launch, menuClick, quitDiscarding, clickTool, showAdvanced } from './helpers'

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
  await showAdvanced(d) // margins, pages, layer, visibility, presets...
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
async function canvasPixels(page: Page, n: number, widthPt = 612): Promise<{ width: number; height: number; data: Uint8Array }> {
  await page.waitForTimeout(700)
  // Scaled to 2 px per point (so pages of different sizes compare at the same scale) and sent as base64 (a plain
  // number array of a full canvas takes ~30 s to transfer).
  const r = await page.evaluate(([num, wPt]) => {
    const c = document.querySelector<HTMLCanvasElement>(`[data-page="${num}"] canvas`)!
    const k = Math.min(1, (2 * wPt) / c.width)
    const w = Math.max(1, Math.round(c.width * k))
    const h = Math.max(1, Math.round(c.height * k))
    const o = document.createElement('canvas')
    o.width = w
    o.height = h
    const ctx = o.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(c, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    let s = ''
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000))
    return { width: w, height: h, b64: btoa(s) }
  }, [n, widthPt] as const)
  return { width: r.width, height: r.height, data: new Uint8Array(Buffer.from(r.b64, 'base64')) }
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

/** Navigates to page n (pages are virtualised: only pages near the view exist) and waits for its canvas. */
async function showPage(page: Page, n: number): Promise<void> {
  await gotoPage(page, n)
  await expect(page.locator(`[data-page="${n}"] canvas`)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(500)
}

async function selectTab(d: Locator, name: string): Promise<void> {
  await d.getByRole('tab', { name }).click()
  await expect(d.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
  await showAdvanced(d)
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

/** A region (fractions) of the page canvas as a grayscale ink image. */
function pxToInk(px: Px, region: [number, number, number, number]): Ink {
  const x0 = Math.round(region[0] * px.width)
  const y0 = Math.round(region[1] * px.height)
  const w = Math.round(region[2] * px.width) - x0
  const h = Math.round(region[3] * px.height) - y0
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * px.width + x0 + x) * 4
      const d = (y * w + x) * 4
      rgba[d] = px.data[s]!
      rgba[d + 1] = px.data[s + 1]!
      rgba[d + 2] = px.data[s + 2]!
      rgba[d + 3] = 255
    }
  }
  return toInk(rgba, w, h)
}

/** Makes the next native "open file" dialog return `path` (the picker runs in main). */
const stubOpenDialog = (app: ElectronApplication, path: string): Promise<void> =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never
  }, path)

const red: Pred = (r, g, b) => r > 180 && g < 90 && b < 90
const blue: Pred = (r, g, b) => b > 170 && r < 60 && g < 110

test.describe('headers and footers (more)', () => {
  test('Hebrew and mixed headers on a rotated page and a page with CropBox/MediaBox offsets: upright, at the top of what the reader sees', async () => {
    const { app, page, path } = await open('hf-geometry.pdf')
    try {
      const d = await openDialog(app, page, 'Header and Footer…')
      await d.getByLabel('Header center').fill('עמוד {page} מתוך {pages}')
      await d.getByLabel('Footer center').fill('')
      await d.getByLabel('Footer right').fill('Version 2 גרסה')
      // preview the rotated page
      await d.getByLabel('Preview page').fill('2')
      await expect(d.getByTestId('hf-preview')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
      await applyAndWait(page, d)
      const p1 = await canvasPixels(page, 1)
      await showPage(page, 2)
      const p2 = await canvasPixels(page, 2, 792)
      expect(p2.width, 'the rotated page is shown landscape').toBeGreaterThan(p2.height)
      const h1 = inkIn(p1, dark, [0, 0, 1, 0.15])!
      const h2 = inkIn(p2, dark, [0, 0, 1, 0.15])!
      expect(h1 && h2, 'header ink on both pages').toBeTruthy()
      expect(Math.abs((h2.x0 + h2.x1) / 2 - 0.5), 'rotated page: header centred horizontally as seen').toBeLessThan(0.01)
      expect(h2.y0 * 612).toBeGreaterThan(36)
      expect((h2.x1 - h2.x0) * p2.width, 'horizontal text is wider than tall').toBeGreaterThan((h2.y1 - h2.y0) * p2.height * 3)
      // same text (only the digit differs) looks the same on both pages: not rotated, not mirrored
      const a = pxToInk(p1, [h1.x0 - 0.01, h1.y0 - 0.005, h1.x1 + 0.01, h1.y1 + 0.005])
      const b = pxToInk(p2, [h2.x0 - 0.01, h2.y0 - 0.005, h2.x1 + 0.01, h2.y1 + 0.005])
      const s = similarity(a, b)
      console.log(`header page 1 vs rotated page 2: ncc ${s.ncc.toFixed(3)}`)
      expect(s.ncc).toBeGreaterThan(0.85)
      // negative control: the same header turned upside down does not match
      const flipped = similarity(a, { width: b.width, height: b.height, data: b.data.slice().reverse() })
      console.log(`negative (upside down): ncc ${flipped.ncc.toFixed(3)}`)
      expect(flipped.ncc).toBeLessThan(0.8)
      // footer right ends at the right margin (72 pt) of the landscape view
      const f2 = inkIn(p2, dark, [0.5, 0.85, 1, 1])!
      expect(Math.abs(f2.x1 * 792 - (792 - 72)), `footer right edge ${f2.x1 * 792}`).toBeLessThan(4)
      // the cropped page: MediaBox [-50 -50 650 850], CropBox [100 100 500 600]: only 400 x 500 pt are visible;
      // the header is centred on that and 36 pt below its top
      await showPage(page, 3)
      const p3 = await canvasPixels(page, 3, 400)
      expect(p3.width / p3.height).toBeCloseTo(400 / 500, 2)
      const h3 = inkIn(p3, dark, [0, 0, 1, 0.2])!
      expect(Math.abs((h3.x0 + h3.x1) / 2 - 0.5)).toBeLessThan(0.015)
      expect(h3.y0 * 500).toBeGreaterThan(36)
      expect(h3.y1 * 500).toBeLessThan(36 + 20)
      await save(page)
    } finally {
      await quitDiscarding(app, page)
    }
    const seen = await seePages(new Uint8Array(readFileSync(path)))
    expect(seen.map((p) => p.items.find((t) => t.str.startsWith('עמוד'))?.str)).toEqual(['עמוד 1 מתוך 3', 'עמוד 2 מתוך 3', 'עמוד 3 מתוך 3'])
    expect(seen.every((p) => p.text.includes('גרסה'))).toBe(true)
    for (const p of seen) {
      const t = p.items.find((i) => i.str.startsWith('עמוד'))!
      expect(t.dir[0], 'upright in PDF.js too').toBeCloseTo(1, 5)
    }
  })

  test('Bates numbering on 3 pages from the ribbon', async () => {
    const { page, app, path } = await open('hf-basic.pdf')
    try {
      await clickTool(page, 'Bates…')
      const d = dialog(page)
      await expect(d.getByTestId('hf-dialog')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
      await expect(d.getByRole('tab', { name: 'Bates numbering' })).toHaveAttribute('aria-selected', 'true')
      await expect(d.getByLabel('Footer right')).toHaveValue('{bates}')
      await d.getByLabel('Prefix').fill('CASE-')
      await d.getByLabel('Digits').fill('4')
      await d.getByLabel('Start number').fill('7')
      await applyAndWait(page, d)
      await expect(page.getByRole('button', { name: 'Undo Add Bates numbers' })).toBeVisible()
      for (const n of [1, 2, 3]) {
        if (n > 1) await showPage(page, n)
        const px = await canvasPixels(page, n)
        const box = inkIn(px, dark, [0.5, 0.9, 1, 1])!
        expect(box, `Bates ink on page ${n}`).toBeTruthy()
        expect(Math.abs(box.x1 * 612 - (612 - 36))).toBeLessThan(3)
      }
      await save(page)
    } finally {
      await quitDiscarding(app, page)
    }
    const seen = await seePages(new Uint8Array(readFileSync(path)))
    expect(seen.map((p) => p.items.find((t) => t.str.startsWith('CASE-'))?.str)).toEqual(['CASE-0007', 'CASE-0008', 'CASE-0009'])
    expect(summarizeMarks(await PDFDocument.load(readFileSync(path))).bates.pages).toBe(3)
  })
})

test.describe('watermarks and backgrounds', () => {
  test('a red text watermark BEHIND the content is hidden by it; a blue picture IN FRONT covers it', async () => {
    const { app, page } = await open('hf-overlap.pdf')
    try {
      let d = await openDialog(app, page, 'Watermark…')
      await d.getByLabel('Watermark text (any language; new lines are kept)').fill('BEHIND')
      await d.getByLabel('Color').fill('#ff0000')
      await d.getByLabel('Opacity').fill('100')
      await d.getByLabel('Rotation').fill('0')
      await d.getByLabel('Percent').fill('90')
      await d.getByLabel('Layer').selectOption('behind')
      await applyAndWait(page, d)
      let px = await canvasPixels(page, 1)
      // the block covers 106..506 x 246..546 pt (from the bottom); in page fractions (from the top):
      const block: [number, number, number, number] = [106 / 612 + 0.01, (792 - 546) / 792 + 0.01, 506 / 612 - 0.01, (792 - 246) / 792 - 0.01]
      expect(inkIn(px, red, block), 'no red inside the opaque block').toBeNull()
      const redBox = inkIn(px, red)!
      expect(redBox, 'the watermark shows where the page is empty').toBeTruthy()
      expect(redBox.x0).toBeLessThan(block[0])
      expect(redBox.x1).toBeGreaterThan(block[2])

      d = await openDialog(app, page, 'Watermark…')
      await expect(d.getByTestId('hf-existing')).toBeVisible()
      await d.getByRole('radio', { name: 'Keep them and add another' }).check()
      await d.getByRole('radio', { name: 'Picture' }).check()
      await stubOpenDialog(app, fixture('hf-logo.png'))
      await d.getByRole('button', { name: 'Choose picture…' }).click()
      await expect(d.getByTestId('hf-source-name')).toHaveText('hf-logo.png')
      await d.getByLabel('Scale').selectOption('absolute')
      await d.getByLabel('Percent').fill('100')
      await d.getByLabel('Rotation').fill('0')
      await d.getByLabel('Opacity').fill('100')
      await d.getByLabel('Layer').selectOption('front')
      // the preview shows the blue picture before anything is applied
      await expect(d.getByTestId('hf-preview')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
      await page.waitForTimeout(600)
      await expect(d.getByTestId('hf-preview')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
      const prev = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-testid="hf-preview"]')!
        const x = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
        return [x[0], x[1], x[2]]
      })
      expect(prev[2]! > 170 && prev[0]! < 60, `preview centre ${prev}`).toBe(true)
      await applyAndWait(page, d)
      px = await canvasPixels(page, 1)
      const b = inkIn(px, blue)!
      expect(b, 'the picture is drawn').toBeTruthy()
      // 200 x 100 pt, centred, over the block
      expect((b.x1 - b.x0) * 612).toBeCloseTo(200, -1)
      expect((b.y1 - b.y0) * 792).toBeCloseTo(100, -1)
      expect(Math.abs((b.x0 + b.x1) / 2 - 0.5)).toBeLessThan(0.01)
      const c = pixelAt(px, 0.5, 0.5)
      expect(blue(...c), `centre pixel ${c}`).toBe(true)
      // the red watermark is still there (kept) and still hidden inside the block
      expect(inkIn(px, red)).toBeTruthy()
      expect(inkIn(px, red, block)).toBeNull()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a background colour fills the page behind the content', async () => {
    const { app, page, path } = await open('hf-basic.pdf')
    try {
      const d = await openDialog(app, page, 'Background…')
      await expect(d.getByRole('tab', { name: 'Background' })).toHaveAttribute('aria-selected', 'true')
      await d.getByLabel('Background color').fill('#ffd0d0')
      await d.getByLabel('Page range (empty = all)').fill('1-2')
      await applyAndWait(page, d)
      const px = await canvasPixels(page, 1)
      const corner = pixelAt(px, 0.02, 0.02)
      expect(corner[0]).toBeGreaterThan(245)
      expect(Math.abs(corner[1] - 0xd0)).toBeLessThan(8)
      expect(Math.abs(corner[2] - 0xd0)).toBeLessThan(8)
      expect(inkIn(px, dark, [0, 0.45, 1, 0.55]), 'the body text is drawn over it').toBeTruthy()
      await showPage(page, 3)
      const p3 = await canvasPixels(page, 3)
      expect(pixelAt(p3, 0.02, 0.02)).toEqual([255, 255, 255]) // page 3 is outside the range
      await save(page)
    } finally {
      await quitDiscarding(app, page)
    }
    expect(summarizeMarks(await PDFDocument.load(readFileSync(path))).background.pages).toBe(2)
  })

  test('"show when printing" only: hidden in the viewer (optional content); a page of another PDF as the watermark', async () => {
    const { app, page, path } = await open('hf-overlap.pdf')
    try {
      let d = await openDialog(app, page, 'Watermark…')
      await d.getByLabel('Watermark text (any language; new lines are kept)').fill('PRINT ONLY')
      await d.getByLabel('Color').fill('#ff0000')
      await d.getByLabel('Opacity').fill('100')
      await d.getByRole('checkbox', { name: 'Show on screen' }).uncheck()
      await applyAndWait(page, d)
      expect(inkIn(await canvasPixels(page, 1), red), 'no red on screen').toBeNull()

      d = await openDialog(app, page, 'Watermark…')
      await d.getByRole('radio', { name: 'Keep them and add another' }).check()
      await d.getByRole('radio', { name: 'PDF page' }).check()
      await stubOpenDialog(app, fixture('hf-basic.pdf'))
      await d.getByRole('button', { name: 'Choose PDF…' }).click()
      await expect(d.getByTestId('hf-source-name')).toHaveText('hf-basic.pdf')
      await d.getByLabel('Page of that PDF').fill('2')
      // the dialog starts from the existing watermark's settings (print only): show this one on screen
      await expect(d.getByRole('checkbox', { name: 'Show on screen' })).not.toBeChecked()
      await d.getByRole('checkbox', { name: 'Show on screen' }).check()
      await d.getByLabel('Rotation').fill('0')
      await d.getByLabel('Opacity').fill('100')
      await d.getByLabel('Percent').fill('100')
      await applyAndWait(page, d)
      // the source page ("Body of page 2" at 72 pt, 400 pt from the bottom) drawn full size over the page
      const px = await canvasPixels(page, 1)
      const text = inkIn(px, dark, [0.05, 0.4, 0.5, 0.52])
      expect(text, 'the other PDF page is drawn').toBeTruthy()
      await save(page)
    } finally {
      await quitDiscarding(app, page)
    }
    const bytes = new Uint8Array(readFileSync(path))
    const seen = await seePages(bytes)
    expect(seen[0]!.text).toContain('Body of page 2')
    expect(seen[0]!.text).toContain('PRINT ONLY') // it is in the file, only hidden on screen
  })

  test("Epdf's printing: a print-only watermark is printed, a screen-only one is not", async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'epdf-hf-print-')), 'printed.pdf')
    const { app, page } = await open('hf-basic.pdf', { env: { EPDF_PRINT_TO_FILE: out } })
    try {
      let d = await openDialog(app, page, 'Watermark…')
      await d.getByLabel('Watermark text (any language; new lines are kept)').fill('ON PAPER')
      await d.getByLabel('Color').fill('#ff0000')
      await d.getByLabel('Opacity').fill('100')
      await d.getByRole('checkbox', { name: 'Show on screen' }).uncheck()
      await applyAndWait(page, d)
      d = await openDialog(app, page, 'Watermark…')
      await d.getByRole('radio', { name: 'Keep them and add another' }).check()
      await d.getByLabel('Watermark text (any language; new lines are kept)').fill('ON SCREEN')
      await d.getByLabel('Color').fill('#0040ff')
      await d.getByRole('checkbox', { name: 'Show on screen' }).check()
      await d.getByRole('checkbox', { name: 'Show when printing' }).uncheck()
      await d.getByLabel('Rotation').fill('-45')
      await applyAndWait(page, d)
      const screen = await canvasPixels(page, 1)
      expect(inkIn(screen, blue), 'screen: the screen-only mark').toBeTruthy()
      expect(inkIn(screen, red), 'screen: no print-only mark').toBeNull()
      await menuClick(app, 'File', 'Print…')
      const dlg = page.getByRole('dialog', { name: 'Print' })
      await expect(dlg).toBeVisible()
      await dlg.getByLabel('Page range').fill('1')
      await dlg.getByRole('button', { name: 'Print…' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 60_000 })
    } finally {
      await quitDiscarding(app, page)
    }
    // Open what was sent to the printer and look at it.
    const printed = await open(out)
    try {
      const px = await canvasPixels(printed.page, 1)
      expect(inkIn(px, red), 'paper: the print-only mark').toBeTruthy()
      expect(inkIn(px, blue), 'paper: no screen-only mark').toBeNull()
    } finally {
      await quitDiscarding(printed.app, printed.page)
    }
  })

  test('a file that is not a picture is refused with a clear message', async () => {
    const { app, page } = await open('hf-basic.pdf')
    try {
      const d = await openDialog(app, page, 'Watermark…')
      await d.getByRole('radio', { name: 'Picture' }).check()
      await stubOpenDialog(app, fixture('hf-not-a-picture.png'))
      await d.getByRole('button', { name: 'Choose picture…' }).click()
      await expect(d.getByRole('alert')).toContainText('is not a PNG or JPEG picture')
      await expect(d.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
      await d.getByRole('button', { name: 'Cancel' }).click()
      await expect(d).toHaveCount(0)
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('edit pipeline, files and protection', () => {
  test('undo and redo an applied header', async () => {
    const { app, page } = await open('hf-basic.pdf')
    try {
      const d = await openDialog(app, page, 'Header and Footer…')
      await d.getByLabel('Header center').fill('UNDO ME')
      await d.getByLabel('Footer center').fill('')
      await applyAndWait(page, d)
      expect(inkIn(await canvasPixels(page, 1), dark, [0, 0, 1, 0.15])).toBeTruthy()
      await page.getByRole('button', { name: 'Undo Add header and footer' }).click()
      await expect(page.getByRole('button', { name: 'Redo Add header and footer' })).toBeEnabled()
      await page.waitForTimeout(800)
      expect(inkIn(await canvasPixels(page, 1), dark, [0, 0, 1, 0.15]), 'gone after undo').toBeNull()
      await page.getByRole('button', { name: 'Redo Add header and footer' }).click()
      await page.waitForTimeout(800)
      expect(inkIn(await canvasPixels(page, 1), dark, [0, 0, 1, 0.15]), 'back after redo').toBeTruthy()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('save, reopen, update (settings are read back from the file), then remove', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-hf-'))
    const path = join(dir, 'doc.pdf')
    writeFileSync(path, readFileSync(fixture('hf-basic.pdf')))
    let { app, page } = await open(path)
    const userData = (await app.evaluate(({ app: a }) => a.getPath('userData'))) as string
    try {
      const d = await openDialog(app, page, 'Header and Footer…')
      await d.getByLabel('Header left').fill('FIRST {page}')
      await d.getByLabel('Footer center').fill('')
      // a preset, to check it survives the restart
      await d.getByLabel('Save these settings as').fill('My header')
      await d.getByRole('button', { name: 'Save preset' }).click()
      await expect(d.getByTestId('hf-presets')).toContainText('Saved “My header”.')
      await applyAndWait(page, d)
      await save(page)
    } finally {
      await quitDiscarding(app, page)
    }
    ;({ app, page } = await open(path, { userData }))
    try {
      const d = await openDialog(app, page, 'Header and Footer…')
      await expect(d.getByTestId('hf-existing')).toContainText('already has headers and footers added by Epdf on 3 pages')
      await expect(d.getByLabel('Header left')).toHaveValue('FIRST {page}')
      await d.getByLabel('Header left').fill('SECOND {page}')
      await expect(d.getByLabel('Saved presets')).toHaveValue(/.+/)
      await applyAndWait(page, d, 'Update')
      await expect(page.getByRole('button', { name: 'Undo Update header and footer' })).toBeVisible()
      await save(page)
      let seen = await seePages(new Uint8Array(readFileSync(path)))
      expect(seen.map((p) => p.text).join('|')).not.toContain('FIRST')
      expect(seen.map((p) => p.items.find((t) => t.str.startsWith('SECOND'))?.str)).toEqual(['SECOND 1', 'SECOND 2', 'SECOND 3'])
      // load the preset back into the dialog
      const d2 = await openDialog(app, page, 'Header and Footer…')
      await d2.getByRole('button', { name: 'Load' }).click()
      await expect(d2.getByLabel('Header left')).toHaveValue('FIRST {page}')
      await d2.getByRole('button', { name: 'Cancel' }).click()
      // remove from the menu
      await menuClick(app, 'Document', 'Remove Headers and Footers')
      await expect(page.getByRole('button', { name: 'Undo Remove headers and footers' })).toBeVisible()
      await save(page)
      seen = await seePages(new Uint8Array(readFileSync(path)))
      expect(seen.map((p) => p.text.replace(/\s+/g, ' ').trim())).toEqual(['Body of page 1', 'Body of page 2', 'Body of page 3'])
      const text = Buffer.from(readFileSync(path)).toString('latin1')
      expect(text).not.toContain('EpdfPageMarks')
      // removing again says there is nothing to remove, and makes no edit
      await menuClick(app, 'Document', 'Remove Headers and Footers')
      await expect(page.getByText('This document has no headers and footers to remove.')).toBeVisible()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a password-protected document: unlock, add a watermark, Save keeps it encrypted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-hf-enc-'))
    const path = join(dir, 'protected.pdf')
    writeFileSync(path, readFileSync(resolve('tests/fixtures/security/aes-256-r6.pdf')))
    const { app, page } = await launch({ files: [path] })
    try {
      const prompt = page.getByRole('dialog', { name: 'Password required' })
      await expect(prompt).toBeVisible()
      await prompt.getByLabel('Document password').fill('user256')
      await prompt.getByRole('button', { name: 'Open' }).click()
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const d = await openDialog(app, page, 'Watermark…')
      await d.getByLabel('Watermark text (any language; new lines are kept)').fill('سري للغاية')
      await applyAndWait(page, d)
      await save(page)
    } finally {
      await quitDiscarding(app, page)
    }
    const bytes = new Uint8Array(readFileSync(path))
    expect(Buffer.from(bytes).toString('latin1')).toContain('/Encrypt')
    await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypt/i)
    const plain = (await openWith(bytes, 'user256')).plain
    const pdf = await PDFDocument.load(plain)
    expect(summarizeMarks(pdf).watermark.pages).toBe(pdf.getPageCount())
    expect(pdf.catalog.get(PDFName.of('EpdfSecurity'))).toBeUndefined()
    const seen = await seePages(plain)
    expect(seen[0]!.text).toContain('سري للغاية')
  })
})

test.describe('large documents', () => {
  test('500 pages: progress, reasonable time, correct numbers on the last page; Cancel leaves the document unchanged', async () => {
    const { app, page, path } = await open('large.pdf')
    try {
      // Cancel first
      let d = await openDialog(app, page, 'Header and Footer…')
      await d.getByRole('button', { name: 'Apply', exact: true }).click()
      await expect(d.getByTestId('hf-progress')).toBeVisible()
      await d.getByRole('button', { name: 'Cancel' }).click()
      await expect(d.getByRole('alert')).toContainText('Cancelled. The document was not changed.', { timeout: 60_000 })
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      await d.getByRole('button', { name: 'Cancel' }).click()
      // then the real run
      d = await openDialog(app, page, 'Header and Footer…')
      await d.getByLabel('Header right').fill('تقرير {page}')
      const t0 = Date.now()
      await d.getByRole('button', { name: 'Apply', exact: true }).click()
      await expect(d.getByTestId('hf-progress')).toContainText(/page \d+ of 500/)
      await expect(d).toHaveCount(0, { timeout: 180_000 })
      const ms = Date.now() - t0
      console.log(`500 pages applied in the app in ${ms} ms`)
      expect(ms).toBeLessThan(90_000)
      await save(page)
    } finally {
      await quitDiscarding(app, page)
    }
    const pdf = await PDFDocument.load(readFileSync(path))
    expect(summarizeMarks(pdf).headerfooter.pages).toBe(500)
    // PDF.js on the last page only (the whole file would be slow)
    const last = await PDFDocument.create()
    const [p] = await last.copyPages(pdf, [499])
    last.addPage(p)
    const seen = await seePages(await last.save())
    expect(seen[0]!.text).toContain('Page 500 of 500')
    expect(seen[0]!.text).toContain('تقرير 500')
  })
})

test.describe('dialog accessibility and keyboard', () => {
  test('axe-clean in light and dark on every tab; tabs work with the arrow keys; Escape closes', async () => {
    const { app, page } = await open('hf-basic.pdf')
    try {
      const found: string[] = []
      for (const theme of ['light', 'dark'] as const) {
        await app.evaluate(({ nativeTheme }, t) => void (nativeTheme.themeSource = t), theme)
        await page.waitForTimeout(300)
        const d = await openDialog(app, page, 'Header and Footer…')
        for (const tab of ['Header and footer', 'Bates numbering', 'Watermark', 'Background']) {
          await selectTab(d, tab)
          await expect(d.getByTestId('hf-preview')).toHaveAttribute('data-state', /ready|error/, { timeout: 20_000 })
          await page.waitForTimeout(250)
          found.push(...(await axeViolations(page, `${theme} ${tab}`)))
          // for people reviewing the UI
          await d.screenshot({ path: join(OUT, `dialog-${theme}-${tab.replace(/\s+/g, '-').toLowerCase()}.png`) })
        }
        // keyboard: arrows move between tabs
        await d.getByRole('tab', { name: 'Background' }).focus()
        await page.keyboard.press('ArrowLeft')
        await expect(d.getByRole('tab', { name: 'Watermark' })).toHaveAttribute('aria-selected', 'true')
        await expect(d.getByRole('tab', { name: 'Watermark' })).toBeFocused()
        await page.keyboard.press('Home')
        await expect(d.getByRole('tab', { name: 'Header and footer' })).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(d).toHaveCount(0)
      }
      expect(found).toEqual([])
    } finally {
      await app.evaluate(({ nativeTheme }) => void (nativeTheme.themeSource = 'system')).catch(() => undefined)
      await quitDiscarding(app, page)
    }
  })
})
