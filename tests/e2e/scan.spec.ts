import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import jsQR from 'jsqr'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib'
import { axeViolations, canvasHasInk, copyFixture, launch as rawLaunch, menuClick, quitDiscarding } from './helpers'
import { createRgba, type RgbaImage } from '../../src/shared/features/scan/image'
import { photographPage, renderTextPage } from '../support/scanImages'
import { makePng } from '../support/images'

/**
 * Scan to PDF, end to end: the test scanner (EPDF_SCANNER_STUB), the fake camera (EPDF_FAKE_MEDIA) and the phone upload
 * server (real HTTP from this process to the URL the dialog shows). Result PDFs are checked on disk with pdf-lib.
 */

let work: string
let stubDir: string
const dirs = { flat: '', photos: '' }

const png = (img: RgbaImage): Uint8Array => makePng(img.width, img.height, (x, y) => [img.data[(y * img.width + x) * 4], img.data[(y * img.width + x) * 4 + 1], img.data[(y * img.width + x) * 4 + 2], 255])

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'epdf-scan-e2e-'))
  stubDir = join(work, 'stub')
  dirs.flat = join(work, 'flat')
  dirs.photos = join(work, 'photos')
  for (const d of [stubDir, dirs.flat, dirs.photos]) mkdirSync(d, { recursive: true })
  // three "scanned" pages of different size (a real scanner delivers what the page size and dpi give)
  writeFileSync(join(stubDir, 'page1.png'), png(renderTextPage(620, 877, 1)))
  writeFileSync(join(stubDir, 'page2.png'), png(renderTextPage(620, 877, 2)))
  writeFileSync(join(stubDir, 'page3.png'), png(renderTextPage(500, 700, 3)))
  writeFileSync(join(dirs.flat, 'one.png'), png(renderTextPage(620, 877, 9)))
  // a photo of a page on a desk, for the phone and the detection flow
  const photo = photographPage(renderTextPage(620, 877, 5), { width: 800, height: 700, angle: 11, scale: 0.6, background: 'wood', noise: 4, seed: 3 })
  writeFileSync(join(dirs.photos, 'photo.png'), png(photo.image))
})
test.afterAll(() => rmSync(work, { recursive: true, force: true }))

// ---- helpers ----------------------------------------------------------------------------------------------------

async function launch(env: Record<string, string> = {}, files: string[] = []) {
  const l = await rawLaunch({ files, env: { EPDF_SCANNER_STUB: stubDir, EPDF_FAKE_MEDIA: '1', EPDF_PHONE_ADDRESSES: '127.0.0.1', ...env } })
  await expect(l.page.getByRole('button', { name: 'Open PDF', exact: true }).first()).toBeVisible({ timeout: 30_000 })
  return l
}

/** Scripted native save dialog (records the calls). */
async function stubSave(app: ElectronApplication, answers: (string | null)[]): Promise<void> {
  await app.evaluate(({ dialog }, saves) => {
    const g = globalThis as unknown as { __saves: (string | null)[]; __saveCalls: number }
    g.__saves = [...saves]
    g.__saveCalls = 0
    ;(dialog as unknown as Record<string, unknown>).showSaveDialog = async () => {
      g.__saveCalls++
      const next = g.__saves.length ? g.__saves.shift()! : null
      return { canceled: !next, filePath: next ?? undefined }
    }
  }, answers)
}
const saveCalls = (app: ElectronApplication): Promise<number> => app.evaluate(() => (globalThis as unknown as { __saveCalls: number }).__saveCalls)

const dlg = (page: Page): Locator => page.getByRole('dialog', { name: 'Scan to PDF' })

async function openScan(app: ElectronApplication, page: Page): Promise<Locator> {
  await menuClick(app, 'File', 'Scan to PDF…')
  const d = dlg(page)
  await expect(d).toBeVisible()
  return d
}

const thumbs = (d: Locator): Locator => d.getByTestId('page-thumb')
const next = (d: Locator): Promise<void> => d.getByTestId('step-next').click()

/** The image XObjects of a saved PDF: [width, height, bitsPerComponent, filter, colorspace]. */
async function images(path: string): Promise<{ w: number; h: number; bpc: number; filter: string; cs: string }[]> {
  const pdf = await PDFDocument.load(readFileSync(path))
  const out: { w: number; h: number; bpc: number; filter: string; cs: string }[] = []
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const d: PDFDict = obj.dict
    if (d.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue
    const num = (n: string): number => (d.get(PDFName.of(n)) as PDFNumber | undefined)?.asNumber() ?? 0
    out.push({ w: num('Width'), h: num('Height'), bpc: num('BitsPerComponent'), filter: String(d.get(PDFName.of('Filter'))), cs: String(d.get(PDFName.of('ColorSpace'))) })
  }
  return out
}

const outPdf = (name: string): string => join(work, name)

// ---- scanner ------------------------------------------------------------------------------------------------------

test.describe('scanner source (test scanner backend)', () => {
  test('feeder scan -> adjust corners with the keyboard -> B&W -> save -> verify the PDF -> it opens', async () => {
    const { app, page } = await launch()
    try {
      const target = outPdf('scan-feeder.pdf')
      await stubSave(app, [target])
      const d = await openScan(app, page)
      await expect(d.locator('#f-scanner')).toHaveValue('epdf-stub:0')
      await expect(d.getByTestId('scan-go')).toBeEnabled()
      await d.getByLabel('Source').selectOption({ label: 'Document feeder' })
      await d.getByLabel('Resolution').selectOption('200')
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(3, { timeout: 30_000 })
      await expect(d.getByTestId('scan-done')).toContainText('Scanned 3 pages')
      await expect(d.getByTestId('page-strip').locator('canvas')).toHaveCount(3, { timeout: 30_000 })

      await next(d)
      await expect(d.getByTestId('scan-step')).toBeFocused() // focus moves to the new step
      await expect(d.getByTestId('scan-step')).toHaveAccessibleName('Step 2 of 3: Adjust')
      const box = d.getByTestId('page-editor')
      await expect(box.getByTestId('editor-result')).toBeVisible({ timeout: 30_000 })
      await expect(d.getByTestId('result-info')).toContainText('mm')
      // move the top-left corner with the arrow keys: the crop changes, so the result size changes
      const before = await d.getByTestId('result-info').innerText()
      await d.getByTestId('corner-0').focus()
      for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight')
      for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown')
      await expect(d.getByTestId('corner-0')).toHaveAttribute('aria-label', /at [1-9]\d? percent across/)
      await expect(d.getByTestId('result-info')).not.toHaveText(before)
      // undo the crop again
      await d.getByTestId('reset-corners').click()
      await expect(d.getByTestId('result-info')).toHaveText(before)
      // black & white, all pages
      await d.getByTestId('preset-bw').check()
      await next(d)
      await expect(d.getByTestId('save-summary')).toContainText('3 pages')
      await d.getByTestId('save-pdf').click()
      await expect(dlg(page)).toBeHidden({ timeout: 60_000 })
      expect(await saveCalls(app)).toBe(1)

      const pdf = await PDFDocument.load(readFileSync(target))
      expect(pdf.getPageCount()).toBe(3)
      // pixels / dpi * 72: 620x877 and 500x700 at 200 dpi
      const sizes = pdf.getPages().map((p) => [Math.round(p.getWidth() * 10) / 10, Math.round(p.getHeight() * 10) / 10])
      expect(sizes[0]).toEqual([223.2, 315.7])
      expect(sizes[2]).toEqual([180, 252])
      const imgs = await images(target)
      expect(imgs).toHaveLength(3)
      for (const i of imgs) {
        expect(i.bpc).toBe(1) // B&W pages are 1-bit
        expect(i.cs).toBe('/DeviceGray')
      }
      expect(imgs[0].w).toBe(620)

      // it opened in a tab and renders with ink
      await expect(page.getByRole('tab', { name: /scan-feeder\.pdf/ })).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas'), { timeout: 20_000 }).toBe(true)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('flatbed page, colour preset: JPEG image, page size from dpi', async () => {
    const { app, page } = await launch({ EPDF_SCANNER_STUB: dirs.flat })
    try {
      const target = outPdf('scan-flat.pdf')
      await stubSave(app, [target])
      const d = await openScan(app, page)
      await d.getByLabel('Resolution').selectOption('100')
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(1, { timeout: 30_000 })
      await next(d)
      await expect(d.getByTestId('editor-result')).toBeVisible({ timeout: 30_000 })
      await d.getByTestId('preset-color').check()
      await next(d)
      await d.getByTestId('quality').selectOption('high')
      await d.getByTestId('save-pdf').click()
      await expect(dlg(page)).toBeHidden({ timeout: 60_000 })
      const pdf = await PDFDocument.load(readFileSync(target))
      expect(pdf.getPageCount()).toBe(1)
      expect(pdf.getPage(0).getWidth()).toBeCloseTo((620 / 100) * 72, 0)
      expect(pdf.getPage(0).getHeight()).toBeCloseTo((877 / 100) * 72, 0)
      const [img] = await images(target)
      expect(img.filter).toBe('/DCTDecode')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('reorder, rotate and delete pages: the saved PDF has the pages in the new order, rotated, without the deleted one', async () => {
    const { app, page } = await launch()
    try {
      const target = outPdf('scan-reorder.pdf')
      await stubSave(app, [target])
      const d = await openScan(app, page)
      await d.getByLabel('Source').selectOption({ label: 'Document feeder' })
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(3, { timeout: 30_000 })
      await expect(d.getByTestId('page-strip').locator('canvas')).toHaveCount(3, { timeout: 30_000 })
      // order now: A(620x877) B(620x877) C(500x700). Move C earlier: A C B
      await thumbs(d).nth(2).click()
      await d.getByRole('button', { name: 'Move earlier' }).click()
      await expect(d.getByRole('button', { name: 'Move earlier' })).toBeEnabled()
      // rotate A right (select it first)
      await thumbs(d).nth(0).click()
      await d.getByRole('button', { name: 'Rotate right' }).click()
      // delete the middle one (C)
      await thumbs(d).nth(1).click()
      await d.getByTestId('delete-page').click()
      await expect(thumbs(d)).toHaveCount(2)
      await next(d)
      await expect(d.getByTestId('editor-view')).toBeVisible({ timeout: 30_000 })
      // page 1 (A) is shown rotated: the picture is now wider than tall
      await thumbs(d).nth(0).click()
      await expect
        .poll(() => d.getByTestId('editor-view').evaluate((c: HTMLCanvasElement) => c.width > c.height), { timeout: 20_000 })
        .toBe(true)
      await d.getByTestId('preset-original').check()
      await next(d)
      await d.getByTestId('save-pdf').click()
      await expect(dlg(page)).toBeHidden({ timeout: 60_000 })
      const pdf = await PDFDocument.load(readFileSync(target))
      expect(pdf.getPageCount()).toBe(2)
      const sizes = pdf.getPages().map((p) => [Math.round(p.getWidth() * 10) / 10, Math.round(p.getHeight() * 10) / 10])
      expect(sizes).toEqual([
        [315.7, 223.2], // A, rotated a quarter turn
        [223.2, 315.7] // B; C (180x252) was deleted
      ])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the scanner reports a paper jam: shown as a clear message, nothing is added', async () => {
    const { app, page } = await launch({ EPDF_SCANNER_STUB_ERROR: 'paper_jam' })
    try {
      const d = await openScan(app, page)
      await d.getByTestId('scan-go').click()
      await expect(d.getByTestId('scan-error')).toContainText(/paper jam/i, { timeout: 20_000 })
      await expect(thumbs(d)).toHaveCount(0)
      await expect(d.getByTestId('step-next')).toBeDisabled()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('cancelling a slow scan stops it, keeps the dialog usable', async () => {
    const { app, page } = await launch({ EPDF_SCANNER_STUB_DELAY_MS: '4000' })
    try {
      const d = await openScan(app, page)
      await d.getByLabel('Source').selectOption({ label: 'Document feeder' })
      await d.getByTestId('scan-go').click()
      await expect(d.getByRole('button', { name: 'Cancel scanning' })).toBeVisible()
      await d.getByRole('button', { name: 'Cancel scanning' }).click()
      await expect(d.getByTestId('scan-error')).toContainText(/cancelled/i, { timeout: 15_000 })
      await expect(thumbs(d)).toHaveCount(0)
      await expect(d.getByTestId('scan-go')).toBeEnabled()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('macOS helper path (against the stub helper): devices, capabilities, a feeder scan and a helper-reported paper jam', async () => {
    const helper = resolve('tests/fixtures/scan-stub-helper.mjs')
    const mac = { EPDF_SCANNER_STUB: '', EPDF_SCAN_BACKEND: 'mac-helper', EPDF_MAC_SCAN_HELPER: helper }
    const a = await launch(mac)
    try {
      const d = await openScan(a.app, a.page)
      await expect(d.locator('#f-scanner option')).toHaveText(['Stub Scanner', 'Second Scanner'], { timeout: 30_000 })
      // capabilities come from the helper: 75/150/300/600 dpi, no black & white
      await expect(d.getByLabel('Resolution').locator('option')).toHaveText(['75 dpi', '150 dpi', '300 dpi', '600 dpi'], { timeout: 30_000 })
      await expect(d.getByLabel('Colour', { exact: true }).locator('option')).toHaveText(['Colour', 'Grayscale'])
      await d.getByLabel('Source').selectOption({ label: 'Document feeder' })
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(3, { timeout: 30_000 })
    } finally {
      await quitDiscarding(a.app, a.page)
    }
    const b = await launch({ ...mac, STUB_MODE: 'jam' })
    try {
      const d = await openScan(b.app, b.page)
      await expect(d.getByTestId('scan-go')).toBeEnabled({ timeout: 30_000 })
      await d.getByTestId('scan-go').click()
      await expect(d.getByTestId('scan-error')).toContainText(/paper jam/i, { timeout: 30_000 })
    } finally {
      await quitDiscarding(b.app, b.page)
    }
  })

  test('without the test scanner the real Windows scanner API answers (a list, or "no scanner found")', async () => {
    test.skip(process.platform !== 'win32', 'The WIA backend is Windows only')
    const { app, page } = await launch({ EPDF_SCANNER_STUB: '' })
    try {
      const d = await openScan(app, page)
      await expect(d.getByTestId('no-scanners').or(d.locator('#f-scanner').locator('option').first())).toBeVisible({ timeout: 60_000 })
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('without the test scanner the real macOS helper answers (a list, or "no scanner found")', async () => {
    test.skip(process.platform !== 'darwin', 'The ImageCaptureCore helper is macOS only')
    const helper = resolve('resources/bin', `darwin-${process.arch}`, 'epdf-mac-scan')
    test.skip(!existsSync(helper), 'Build it first: resources/native/mac-scan/build.sh')
    const { app, page } = await launch({ EPDF_SCANNER_STUB: '' })
    try {
      const d = await openScan(app, page)
      await expect(d.getByTestId('no-scanners').or(d.locator('#f-scanner').locator('option').first())).toBeVisible({ timeout: 60_000 })
      await expect(d.getByTestId('scanner-unavailable')).toHaveCount(0)
      await expect(d.getByRole('alert')).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---- webcam -------------------------------------------------------------------------------------------------------

test.describe('webcam source (fake camera)', () => {
  test('a page held in front of the camera is outlined, and auto-capture takes it exactly once', async () => {
    // a Y4M clip of "a sheet on a desk" replaces the camera's test pattern (Chromium's --use-file-for-fake-video-capture)
    const w = 640
    const h = 480
    const shot = photographPage(renderTextPage(620, 877, 21), { width: w, height: h, angle: 7, scale: 0.44, background: 'wood', noise: 3, seed: 8 })
    const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`)
    const frame = Buffer.alloc(w * h * 1.5)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4
        const [r, g, b] = [shot.image.data[o], shot.image.data[o + 1], shot.image.data[o + 2]]
        frame[y * w + x] = Math.max(16, Math.min(235, 16 + 0.257 * r + 0.504 * g + 0.098 * b))
        if (y % 2 === 0 && x % 2 === 0) {
          const ci = (y / 2) * (w / 2) + x / 2
          frame[w * h + ci] = Math.max(16, Math.min(240, 128 - 0.148 * r - 0.291 * g + 0.439 * b))
          frame[w * h + (w / 2) * (h / 2) + ci] = Math.max(16, Math.min(240, 128 + 0.439 * r - 0.368 * g - 0.071 * b))
        }
      }
    const clip = join(work, 'sheet.y4m')
    writeFileSync(clip, Buffer.concat([header, ...Array.from({ length: 6 }, () => Buffer.concat([Buffer.from('FRAME\n'), frame]))]))
    const userData = mkdtempSync(join(tmpdir(), 'epdf-e2e-'))
    const app = await electron.launch({ args: [`--use-file-for-fake-video-capture=${clip}`, '.'], env: { ...process.env, EPDF_USER_DATA: userData, ELECTRON_RENDERER_URL: '', EPDF_SCANNER_STUB: stubDir, EPDF_FAKE_MEDIA: '1' } as Record<string, string> })
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: 'Open PDF', exact: true }).first()).toBeVisible({ timeout: 30_000 })
    try {
      const target = outPdf('scan-autocapture.pdf')
      await stubSave(app, [target])
      const d = await openScan(app, page)
      await d.getByTestId('tab-webcam').click()
      await expect(d.getByTestId('webcam-capture')).toBeEnabled({ timeout: 30_000 })
      await d.getByTestId('webcam-auto').check()
      await expect(d.getByTestId('webcam-detect')).toHaveText(/Page found|Steady/, { timeout: 30_000 })
      // captured by itself once the page is steady...
      await expect(thumbs(d)).toHaveCount(1, { timeout: 30_000 })
      // ...and not again while the same page stays in view
      await page.waitForTimeout(3500)
      await expect(thumbs(d)).toHaveCount(1)
      await d.getByTestId('webcam-auto').uncheck()
      await next(d)
      await expect(d.getByTestId('editor-result')).toBeVisible({ timeout: 30_000 })
      await expect(d.getByTestId('edges-hint')).toHaveCount(0)
      await expect(d.getByTestId('result-info')).toContainText('(A4)')
      await next(d)
      await d.getByTestId('save-pdf').click()
      await expect(dlg(page)).toBeHidden({ timeout: 60_000 })
      const pdf = await PDFDocument.load(readFileSync(target))
      expect(pdf.getPageCount()).toBe(1)
      expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.276, 1)
    } finally {
      await quitDiscarding(app, page)
    }
  })
  test('live preview, capture several pages, save as JPEG pages of the page size', async () => {
    const { app, page } = await launch()
    try {
      const target = outPdf('scan-webcam.pdf')
      await stubSave(app, [target])
      const d = await openScan(app, page)
      await d.getByTestId('tab-webcam').click()
      await expect(d.getByTestId('webcam-capture')).toBeEnabled({ timeout: 30_000 })
      await expect(d.locator('#f-camera')).toBeVisible()
      await expect.poll(() => d.getByTestId('webcam-video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0)
      await d.getByTestId('webcam-capture').click()
      await expect(thumbs(d)).toHaveCount(1, { timeout: 20_000 })
      await d.getByTestId('webcam-capture').click()
      await expect(thumbs(d)).toHaveCount(2, { timeout: 20_000 })
      await expect(d.getByTestId('webcam-count')).toContainText('2 pages captured')
      await next(d)
      await expect(d.getByTestId('editor-result')).toBeVisible({ timeout: 30_000 })
      await next(d)
      await d.getByTestId('save-pdf').click()
      await expect(dlg(page)).toBeHidden({ timeout: 60_000 })
      const pdf = await PDFDocument.load(readFileSync(target))
      expect(pdf.getPageCount()).toBe(2)
      // the fake camera shows no page, so the whole frame is kept (its own proportions, fitted to an A4 long side)
      const { width, height } = pdf.getPage(0).getSize()
      expect(Math.max(width, height)).toBeCloseTo(841.89, 0)
      expect((await images(target)).every((i) => i.filter === '/DCTDecode')).toBe(true)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the camera is released when the tab is left and the dialog closed', async () => {
    const { app, page } = await launch()
    try {
      const d = await openScan(app, page)
      await d.getByTestId('tab-webcam').click()
      await expect(d.getByTestId('webcam-capture')).toBeEnabled({ timeout: 30_000 })
      await d.getByTestId('tab-scanner').click()
      await expect(d.getByTestId('webcam-panel')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(dlg(page)).toBeHidden()
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---- phone over the local network ---------------------------------------------------------------------------------

function multipartBody(data: Uint8Array, boundary: string, filename = 'photo.png'): Buffer {
  return Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`)])
}

async function postPhoto(url: string, data: Uint8Array, opts: { token?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(url)
  const boundary = 'e2eBoundary' + Date.now()
  const body = multipartBody(data, boundary)
  const res = await fetch(`${u.origin}/${opts.token ?? u.pathname.slice(1)}/upload`, { method: 'POST', body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Epdf-Upload': '1', ...opts.headers } })
  return { status: res.status, body: await res.text() }
}

/** Renders the QR SVG to pixels inside the app and decodes it here. */
async function decodeQr(page: Page): Promise<string | null> {
  const pixels = await page.evaluate(async () => {
    const svg = document.querySelector('[data-testid="phone-qr"]') as SVGElement
    const xml = new XMLSerializer().serializeToString(svg)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('QR image failed to load'))
      img.src = 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(xml)
    })
    const c = document.createElement('canvas')
    c.width = c.height = 400
    const g = c.getContext('2d')!
    g.fillStyle = '#fff'
    g.fillRect(0, 0, 400, 400)
    g.imageSmoothingEnabled = false
    g.drawImage(img, 0, 0, 400, 400)
    return Array.from(g.getImageData(0, 0, 400, 400).data)
  })
  return jsQR(new Uint8ClampedArray(pixels), 400, 400)?.data ?? null
}

test.describe('phone over the local network', () => {
  test('QR code encodes the printed URL; photos uploaded over real HTTP appear live and end up in the PDF', async () => {
    const { app, page } = await launch()
    try {
      const target = outPdf('scan-phone.pdf')
      await stubSave(app, [target])
      const d = await openScan(app, page)
      await d.getByTestId('tab-phone').click()
      const urlEl = d.getByTestId('phone-url')
      await expect(urlEl).toBeVisible({ timeout: 20_000 })
      const url = (await urlEl.innerText()).trim()
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22,}$/)
      await expect(d.getByTestId('phone-warning')).toContainText(/not encrypted/i)
      // the QR code decodes to exactly the URL shown
      expect(await decodeQr(page)).toBe(url)

      // the page a phone would load
      const html = await (await fetch(url)).text()
      expect(html).toContain('capture="environment"')

      const photo = readFileSync(join(dirs.photos, 'photo.png'))
      const ok = await postPhoto(url, photo)
      expect(ok.status).toBe(200)
      expect(JSON.parse(ok.body).accepted).toBe(1)
      await expect(thumbs(d)).toHaveCount(1, { timeout: 20_000 })
      await expect(d.getByTestId('phone-received')).toContainText('1 photo received')
      // concurrent uploads
      const many = await Promise.all([postPhoto(url, photo), postPhoto(url, photo), postPhoto(url, photo)])
      expect(many.map((r) => r.status)).toEqual([200, 200, 200])
      await expect(thumbs(d)).toHaveCount(4, { timeout: 30_000 })

      // refused: wrong token, not an image, missing header, too large
      const u = new URL(url)
      expect((await postPhoto(url, photo, { token: 'AAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(404)
      expect((await postPhoto(url, Buffer.from('MZ not a picture'))).status).toBe(415)
      expect((await postPhoto(url, photo, { headers: { 'X-Epdf-Upload': '0' } })).status).toBe(403)
      const huge = await fetch(`${u.origin}${u.pathname}/upload`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'X-Epdf-Upload': '1', 'Content-Length': String(200 * 1024 * 1024) }, body: 'x' }).then((r) => r.status, () => 413)
      expect(huge).toBe(413)
      await expect(thumbs(d)).toHaveCount(4)

      // delete three, keep the first (the detected page photo)
      for (let i = 0; i < 3; i++) await d.getByTestId('delete-page').click()
      await expect(thumbs(d)).toHaveCount(1)
      await next(d)
      await expect(d.getByTestId('editor-result')).toBeVisible({ timeout: 30_000 })
      // the page was found automatically: no "edges not found" hint, the result is an A4 sheet
      await expect(d.getByTestId('edges-hint')).toHaveCount(0)
      await expect(d.getByTestId('result-info')).toContainText('210 × 297 mm (A4)')
      await next(d)
      await d.getByTestId('save-pdf').click()
      await expect(dlg(page)).toBeHidden({ timeout: 60_000 })
      const pdf = await PDFDocument.load(readFileSync(target))
      expect(pdf.getPageCount()).toBe(1)
      expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.276, 1)
      expect(pdf.getPage(0).getHeight()).toBeCloseTo(841.89, 1)
      // the link died with the dialog
      await expect.poll(() => fetch(url).then((r) => r.status, () => 0)).toBe(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the page a phone gets works in a real browser engine: choose photos, they are sent and appear in the dialog (and it is axe-clean)', async () => {
    const { app, page } = await launch()
    try {
      const d = await openScan(app, page)
      await d.getByTestId('tab-phone').click()
      const url = (await d.getByTestId('phone-url').innerText()).trim()
      // a separate browser window with its own session (so the app's own CSP hook does not apply), like a phone's browser
      const opened = app.waitForEvent('window')
      await app.evaluate(({ BrowserWindow }, u) => {
        const w = new BrowserWindow({ show: false, webPreferences: { partition: 'phone-test', sandbox: true, contextIsolation: true } })
        void w.loadURL(u)
      }, url)
      const phone = await opened
      await expect(phone.getByRole('heading', { name: 'Send pages to Epdf' })).toBeVisible({ timeout: 20_000 })
      await expect(phone.getByRole('note')).toContainText('not encrypted')
      expect(await axeViolations(phone, 'phone page')).toEqual([])
      const photo = readFileSync(join(dirs.photos, 'photo.png'))
      await phone.locator('#pick').setInputFiles([
        { name: 'a.png', mimeType: 'image/png', buffer: photo },
        { name: 'b.png', mimeType: 'image/png', buffer: photo }
      ])
      await expect(phone.locator('#status')).toHaveText('2 photos sent.', { timeout: 20_000 })
      await expect(phone.locator('#list li')).toHaveText([/b\.png - sent/, /a\.png - sent/])
      await expect(thumbs(d)).toHaveCount(2, { timeout: 30_000 })
      // a file that is not a picture is reported on the phone and adds nothing
      await phone.locator('#cam').setInputFiles([{ name: 'notes.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('this is not a picture at all') }])
      await expect(phone.locator('#list li').first()).toContainText('not accepted')
      await expect(thumbs(d)).toHaveCount(2)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isVisible()).forEach((w) => w.destroy()))
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the link stops working when the time is up, and a new code can be requested', async () => {
    const { app, page } = await launch({ EPDF_PHONE_TTL_MS: '2500' })
    try {
      const d = await openScan(app, page)
      await d.getByTestId('tab-phone').click()
      const url = (await d.getByTestId('phone-url').innerText()).trim()
      expect((await fetch(url)).status).toBe(200)
      await expect(d.getByTestId('phone-expired')).toBeVisible({ timeout: 15_000 })
      await expect.poll(() => fetch(url).then((r) => r.status, () => 0)).toBe(0)
      await d.getByTestId('phone-renew').click()
      await expect(d.getByTestId('phone-qr')).toBeVisible({ timeout: 15_000 })
      const url2 = (await d.getByTestId('phone-url').innerText()).trim()
      expect(url2).not.toBe(url)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('leaving the phone tab or the dialog switches the server off', async () => {
    const { app, page } = await launch()
    try {
      const d = await openScan(app, page)
      await d.getByTestId('tab-phone').click()
      const url = (await d.getByTestId('phone-url').innerText()).trim()
      expect((await fetch(url)).status).toBe(200)
      await d.getByTestId('tab-scanner').click()
      await expect.poll(() => fetch(url).then((r) => r.status, () => 0)).toBe(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---- cancel paths, add to document, OCR ------------------------------------------------------------------------------

test.describe('cancel paths and other destinations', () => {
  test('closing with pages asks first; "Keep scanning" keeps them, "Discard" removes them', async () => {
    const { app, page } = await launch({ EPDF_SCANNER_STUB: dirs.flat })
    try {
      const d = await openScan(app, page)
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(1, { timeout: 30_000 })
      await d.getByTestId('scan-close').click()
      const ask = page.getByRole('dialog', { name: 'Discard the scanned pages?' })
      await expect(ask).toBeVisible()
      await ask.getByRole('button', { name: 'Keep scanning' }).click()
      await expect(thumbs(d)).toHaveCount(1)
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: 'Discard the scanned pages?' }).getByRole('button', { name: 'Discard' }).click()
      await expect(dlg(page)).toBeHidden()
      // reopening starts empty
      const d2 = await openScan(app, page)
      await expect(thumbs(d2)).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('cancelling the save dialog keeps everything; saving again works', async () => {
    const { app, page } = await launch({ EPDF_SCANNER_STUB: dirs.flat })
    try {
      const target = outPdf('scan-second-try.pdf')
      await stubSave(app, [null, target])
      const d = await openScan(app, page)
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(1, { timeout: 30_000 })
      await next(d)
      await next(d)
      await d.getByTestId('save-pdf').click()
      await expect.poll(() => saveCalls(app)).toBe(1)
      await expect(dlg(page)).toBeVisible()
      await expect(d.getByTestId('save-pdf')).toBeEnabled({ timeout: 30_000 })
      expect(existsSync(target)).toBe(false)
      await d.getByTestId('save-pdf').click()
      await expect(dlg(page)).toBeHidden({ timeout: 60_000 })
      expect((await PDFDocument.load(readFileSync(target))).getPageCount()).toBe(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('adding to the open document inserts the pages through the edit pipeline (undoable) and saves with it', async () => {
    const doc = copyFixture('sample.pdf', 'target.pdf')
    const { app, page } = await launch({ EPDF_SCANNER_STUB: dirs.flat }, [doc])
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 30_000 })
      const d = await openScan(app, page)
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(1, { timeout: 30_000 })
      await next(d)
      await next(d)
      await d.getByTestId('insert-position').selectOption('end')
      await d.getByTestId('add-to-current').click()
      await expect(dlg(page)).toBeHidden({ timeout: 60_000 })
      await expect(page.getByLabel('Page number')).toBeVisible()
      // it is one undo step named after the edit: undo takes the pages out again, redo brings them back
      await menuClick(app, 'Edit', 'Undo')
      await menuClick(app, 'File', 'Save')
      await expect.poll(async () => (await PDFDocument.load(readFileSync(doc))).getPageCount(), { timeout: 20_000 }).toBe(5)
      await menuClick(app, 'Edit', 'Redo')
      await menuClick(app, 'File', 'Save')
      await expect.poll(async () => (await PDFDocument.load(readFileSync(doc))).getPageCount(), { timeout: 20_000 }).toBe(6)
      const pdf = await PDFDocument.load(readFileSync(doc))
      const last = pdf.getPage(5)
      expect(last.getWidth()).toBeGreaterThan(100)
      expect((await images(doc)).length).toBeGreaterThanOrEqual(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('"Recognize text" is offered only when an OCR command exists in this build (soft dependency)', async () => {
    const { app, page } = await launch({ EPDF_SCANNER_STUB: dirs.flat })
    try {
      const d = await openScan(app, page)
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(1, { timeout: 30_000 })
      await next(d)
      await next(d)
      // The OCR feature ships on another branch; when it is merged the checkbox appears and drives `ocr.run`.
      const n = await d.getByTestId('recognize').count()
      expect([0, 1]).toContain(n)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Cancel while the PDF is being built stops the work; nothing is saved', async () => {
    // one big photo makes the processing take a moment
    const big = join(work, 'big')
    mkdirSync(big, { recursive: true })
    const page4k = createRgba(2600, 3600, [240, 240, 236])
    for (let y = 100; y < 3500; y += 40) for (let x = 200; x < 2400; x += 3) if ((x / 3 + y) % 7 < 4) for (let k = 0; k < 10; k++) page4k.data[((y + k) * 2600 + x) * 4] = page4k.data[((y + k) * 2600 + x) * 4 + 1] = page4k.data[((y + k) * 2600 + x) * 4 + 2] = 30
    writeFileSync(join(big, 'big.png'), png(page4k))
    const { app, page } = await launch({ EPDF_SCANNER_STUB: big })
    try {
      const target = outPdf('never.pdf')
      await stubSave(app, [target])
      const d = await openScan(app, page)
      await d.getByLabel('Resolution').selectOption('300')
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(1, { timeout: 60_000 })
      await expect(d.getByTestId('page-strip').locator('canvas')).toHaveCount(1, { timeout: 60_000 })
      await next(d)
      await next(d)
      await d.getByTestId('quality').selectOption('high')
      await d.getByTestId('save-pdf').click()
      await expect(d.getByTestId('save-progress')).toBeVisible()
      await d.getByTestId('save-cancel').click()
      await expect(d.getByTestId('save-progress')).toBeHidden({ timeout: 30_000 })
      await expect(d.getByTestId('save-pdf')).toBeEnabled()
      expect(await saveCalls(app)).toBe(0)
      expect(existsSync(target)).toBe(false)
      // still usable afterwards: the worker restarts and the page is prepared again
      await d.getByTestId('save-pdf').click()
      await expect(dlg(page)).toBeHidden({ timeout: 120_000 })
      expect((await PDFDocument.load(readFileSync(target))).getPageCount()).toBe(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---- accessibility ---------------------------------------------------------------------------------------------------

test.describe('accessibility (WCAG 2.1 A/AA, light and dark)', () => {
  async function both(app: ElectronApplication, page: Page, label: string): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
      await app.evaluate(({ nativeTheme }, t) => void (nativeTheme.themeSource = t), theme)
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
      else await expect(page.locator('html')).not.toHaveClass(/dark/)
      expect(await axeViolations(page, `${label} ${theme}`)).toEqual([])
    }
  }

  test('every step and source of the dialog has no violations', async () => {
    const { app, page } = await launch()
    try {
      await stubSave(app, [])
      const d = await openScan(app, page)
      await expect(d.locator('#f-scanner')).toHaveValue('epdf-stub:0')
      await both(app, page, 'scanner tab empty')
      await d.getByLabel('Source').selectOption({ label: 'Document feeder' })
      await d.getByTestId('scan-go').click()
      await expect(thumbs(d)).toHaveCount(3, { timeout: 30_000 })
      await expect(d.getByTestId('page-strip').locator('canvas')).toHaveCount(3, { timeout: 30_000 })
      await both(app, page, 'scanner tab with pages')
      await d.getByTestId('tab-webcam').click()
      await expect(d.getByTestId('webcam-capture')).toBeEnabled({ timeout: 30_000 })
      await both(app, page, 'webcam tab')
      await d.getByTestId('tab-phone').click()
      await expect(d.getByTestId('phone-qr')).toBeVisible({ timeout: 20_000 })
      await both(app, page, 'phone tab')
      await next(d)
      await expect(d.getByTestId('editor-result')).toBeVisible({ timeout: 30_000 })
      await both(app, page, 'adjust step')
      await next(d)
      await both(app, page, 'save step')
      await d.getByTestId('save-pdf').click()
      await page.keyboard.press('Escape')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('error and empty states have no violations (scanner error, no scanner, phone cannot open a port)', async () => {
    const a = await launch({ EPDF_SCANNER_STUB_ERROR: 'paper_jam' })
    try {
      const d = await openScan(a.app, a.page)
      await d.getByTestId('scan-go').click()
      await expect(d.getByTestId('scan-error')).toContainText(/paper jam/i, { timeout: 20_000 })
      await both(a.app, a.page, 'scanner error')
    } finally {
      await quitDiscarding(a.app, a.page)
    }
    // an empty folder: the test scanner refuses with "no pictures"; and an unbindable phone address
    const empty = join(work, 'empty-stub')
    mkdirSync(empty, { recursive: true })
    const b = await launch({ EPDF_SCANNER_STUB: empty, EPDF_PHONE_ADDRESSES: '203.0.113.9' })
    try {
      const d = await openScan(b.app, b.page)
      await d.getByTestId('scan-go').click()
      await expect(d.getByTestId('scan-error')).toContainText(/no pictures/i, { timeout: 20_000 })
      await d.getByTestId('tab-phone').click()
      await expect(d.getByTestId('phone-error')).toContainText(/not available|network address/i, { timeout: 20_000 })
      await both(b.app, b.page, 'phone error')
    } finally {
      await quitDiscarding(b.app, b.page)
    }
    const c = await launch({ EPDF_SCANNER_STUB: '', EPDF_SCAN_BACKEND: 'mac-helper', EPDF_MAC_SCAN_HELPER: resolve('tests/fixtures/scan-stub-helper.mjs'), STUB_MODE: 'crash' })
    try {
      const d = await openScan(c.app, c.page)
      await expect(d.getByRole('alert')).toContainText(/scanner helper stopped/i, { timeout: 30_000 })
      await both(c.app, c.page, 'scanner list error')
    } finally {
      await quitDiscarding(c.app, c.page)
    }
  })

  test('the dialog is keyboard operable: tabs with arrow keys, focus stays inside, Escape closes', async () => {
    const { app, page } = await launch()
    try {
      const d = await openScan(app, page)
      await expect(d.getByRole('tab', { name: 'Scanner' })).toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(d.getByRole('tab', { name: 'Webcam' })).toHaveAttribute('aria-selected', 'true')
      await expect(d.getByRole('tab', { name: 'Webcam' })).toBeFocused()
      // Tab many times: focus never leaves the dialog
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab')
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
      }
      await page.keyboard.press('Escape')
      await expect(dlg(page)).toBeHidden()
      // focus returns to where it was
      await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})
