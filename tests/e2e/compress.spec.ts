import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from 'pdf-lib'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { PRESETS } from '../../src/renderer/src/features/compress/pdf/options'
import { addJpegImage, addRawImage, imagesOf, jpegOf, photoRGB, placeAt } from '../unit/compressHelpers'
import { addLink, addOutline, linkTarget } from '../unit/pdfTestUtils'
import { axeViolations, launch, menuClick, quitDiscarding } from './helpers'

/**
 * Reduce File Size, driven through the real UI: presets, real before/after sizes (checked against the saved file), Apply /
 * Undo / Cancel, visual similarity (rendered by PDF.js inside the app), text and structure surviving, a 100+ MB stress file,
 * and accessibility.
 */

const N = (s: string): PDFName => PDFName.of(s)
const dir = mkdtempSync(join(tmpdir(), 'epdf-compress-'))
const REPORT = join(dir, 'report.pdf')
const STRESS = join(dir, 'stress.pdf')

/** A 3-page report: two photos (Flate + JPEG), a duplicate, a graphic, bookmarks, a link, a note, a form field, metadata. */
async function buildReport(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const ctx = doc.context
  const p1 = doc.addPage([612, 792])
  const p2 = doc.addPage([612, 792])
  const p3 = doc.addPage([612, 792])
  p1.drawText('Quarterly report: vector text must stay sharp', { x: 40, y: 740, size: 18, font, color: rgb(0, 0, 0) })
  p2.drawText('Second page with a graphic and a link', { x: 40, y: 740, size: 18, font })
  p3.drawText('Third page with a note and a form field', { x: 40, y: 740, size: 18, font })
  const w = 1500
  const h = 1000
  const photo = photoRGB(w, h, 5, 14)
  const flate = addRawImage(doc, { w, h, data: photo, cs: 'DeviceRGB' })
  placeAt(p1, flate, 90, 420, 432, 288) // 250 dpi
  const jw = 1200
  const jh = 800
  const jpg = jpegOf(photoRGB(jw, jh, 6, 12), jw, jh, 3, 95)
  placeAt(p1, addJpegImage(doc, jw, jh, 3, jpg, 'DeviceRGB'), 90, 60, 216, 144) // 400 dpi
  placeAt(p2, flate, 90, 420, 216, 144) // the same photo again (shared object)
  const g = new Uint8Array(400 * 300 * 3)
  for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) g.set(((x >> 4) + (y >> 4)) % 2 ? [30, 90, 200] : [250, 200, 40], (y * 400 + x) * 3)
  placeAt(p2, addRawImage(doc, { w: 400, h: 300, data: g, cs: 'DeviceRGB', flate: false }), 90, 100, 200, 150)
  addLink(doc, 1, 2)
  addOutline(doc, [{ title: 'Photos', page: 0 }, { title: 'Graphic', page: 1 }, { title: 'Notes', page: 2 }])
  const form = doc.getForm()
  const tf = form.createTextField('reviewer')
  tf.addToPage(p3, { x: 60, y: 600, width: 200, height: 22, font })
  tf.setText('Ada Lovelace')
  const ap = ctx.register(ctx.stream('1 1 0 rg 0 0 24 24 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 24, 24] }))
  const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 600, 324, 624], Contents: PDFString.of('remember'), AP: { N: ap }, F: 4 }))
  const annots = p3.node.lookupMaybe(N('Annots'), PDFArray) ?? ctx.obj([])
  annots.push(note)
  p3.node.set(N('Annots'), annots)
  doc.setTitle('Quarterly report')
  doc.setAuthor('Finance team')
  doc.catalog.set(N('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>' + 'meta '.repeat(400) + '</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })))
  return doc.save()
}

/** N incompressible photos: > 100 MB once written. */
async function buildStress(count: number, w: number, h: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([612, 792])
    placeAt(page, addRawImage(doc, { w, h, data: photoRGB(w, h, 100 + i, 90), cs: 'DeviceRGB' }), 40, 300, 360, 240) // 300 dpi
  }
  return doc.save()
}

let reportSize = 0
test.beforeAll(async () => {
  test.setTimeout(120_000)
  const bytes = await buildReport()
  writeFileSync(REPORT, bytes)
  reportSize = bytes.length
})

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Reduce file size' })
const bytesOf = async (page: Page, testId: string): Promise<number> => Number(await page.getByTestId(testId).getAttribute('data-bytes'))

async function openDialog(app: ElectronApplication, page: Page): Promise<void> {
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  await menuClick(app, 'File', 'Reduce File Size…')
  await expect(dialog(page)).toBeVisible()
  await expect(page.getByTestId('compress-run')).toBeEnabled({ timeout: 60_000 }) // analysis finished
}

/** Chooses a preset, runs the reduction and waits for the result; returns the exact new size. */
async function runPreset(page: Page, preset: 'high' | 'balanced' | 'smallest'): Promise<number> {
  await page.getByTestId(`preset-${preset}`).check()
  await page.getByTestId('compress-run').click()
  await expect(page.getByTestId('compress-apply')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('size-after')).toHaveAttribute('data-exact', 'true')
  return bytesOf(page, 'size-after')
}

async function thumbnail(page: Page, n: number): Promise<number[]> {
  await expect(page.locator(`[data-page="${n}"] canvas`)).toBeVisible()
  await page.waitForFunction((sel) => {
    const c = document.querySelector<HTMLCanvasElement>(sel)
    if (!c || c.width === 0) return false
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200) return true // something dark was drawn
    return false
  }, `[data-page="${n}"] canvas`)
  await page.waitForTimeout(600)
  const b64 = await page.evaluate((sel) => {
    const c = document.querySelector<HTMLCanvasElement>(sel)!
    const t = document.createElement('canvas')
    t.width = 640
    t.height = Math.round((640 * c.height) / c.width)
    const g = t.getContext('2d')!
    g.drawImage(c, 0, 0, t.width, t.height)
    const d = g.getImageData(0, 0, t.width, t.height).data
    let s = ''
    for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode(...d.subarray(i, i + 8192))
    return btoa(s)
  }, `[data-page="${n}"] canvas`)
  return Array.from(Buffer.from(b64, 'base64'))
}

/** Mean absolute difference (0-255) of the RGB channels of two equally sized 640-px-wide renders, optionally inside a page fraction. */
function meanDiff(a: number[], b: number[], region?: [number, number, number, number]): number {
  expect(a.length).toBe(b.length)
  const w = 640
  const h = a.length / 4 / w
  const [x0, y0, x1, y1] = region ?? [0, 0, 1, 1]
  let s = 0
  let n = 0
  for (let y = Math.floor(y0 * h); y < Math.ceil(y1 * h); y++)
    for (let x = Math.floor(x0 * w); x < Math.ceil(x1 * w); x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * w + x) * 4 + c
        s += Math.abs(a[i] - b[i])
        n++
      }
  return s / n
}

async function renderPages(path: string, pages: number[]): Promise<number[][]> {
  const { app, page } = await launch({ files: [path] })
  try {
    const out: number[][] = []
    for (const n of pages) {
      if (n > 1) await page.getByLabel('Page number').fill(String(n))
      if (n > 1) await page.getByLabel('Page number').press('Enter')
      out.push(await thumbnail(page, n))
    }
    return out
  } finally {
    await app.close()
  }
}

const originalRenders: { pages?: number[][] } = {}
/** Mean-abs-difference limits (of 255) for whole pages, and inside the 6 x 4 in photo on page 1 (PDF box 90,420 to 522,708 of 612 x 792). */
const LIMITS = { high: 1, balanced: 2, smallest: 3 } as const
const PHOTO_LIMITS = { high: 3, balanced: 5, smallest: 8 } as const
const PHOTO_BOX: [number, number, number, number] = [90 / 612, 84 / 792, 522 / 612, 372 / 792]

const imageWidths = async (path: string): Promise<number[]> => {
  const doc = await PDFDocument.load(readFileSync(path))
  return imagesOf(doc)
    .map(({ dict }) => (dict.get(N('Width')) as PDFNumber).asNumber())
    .sort((a, b) => a - b)
}

test.describe('Reduce File Size', () => {
  test('File menu item opens the dialog with the real current size and an estimate; Cancel changes nothing', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'epdf-c1-')), 'report.pdf')
    copyFileSync(REPORT, path)
    const { app, page } = await launch({ files: [path] })
    try {
      await openDialog(app, page)
      expect(await bytesOf(page, 'size-before')).toBe(reportSize)
      await expect(page.getByTestId('size-after')).toHaveAttribute('data-exact', 'false')
      const est = await bytesOf(page, 'size-after')
      expect(est).toBeGreaterThan(0)
      expect(est).toBeLessThan(reportSize)
      await expect(page.getByTestId('size-saved')).toContainText('%')
      await page.getByTestId('compress-cancel').click()
      await expect(dialog(page)).toHaveCount(0)
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  for (const preset of ['high', 'balanced', 'smallest'] as const) {
    test(`${preset}: the size shown is the size saved; Apply is one undo step; text, links, bookmarks survive; pages look the same`, async () => {
      test.setTimeout(300_000)
      const path = join(mkdtempSync(join(tmpdir(), `epdf-${preset}-`)), 'report.pdf')
      copyFileSync(REPORT, path)
      const { app, page } = await launch({ files: [path] })
      try {
        await openDialog(app, page)
        const after = await runPreset(page, preset)
        const before = await bytesOf(page, 'size-before')
        expect(after).toBeLessThan(before)
        await expect(page.getByTestId('size-saved')).toHaveText(new RegExp(`^${Math.round(((before - after) / before) * 100)}%$`))
        await expect(page.getByTestId('compress-details')).toContainText('images reduced')
        await page.getByTestId('compress-apply').click()
        await expect(dialog(page)).toHaveCount(0)
        await expect(page.getByRole('status').filter({ hasText: 'saved' }).first()).toContainText(/→/)
        await expect(page.getByRole('button', { name: 'Undo Reduce file size' })).toBeEnabled()
        await expect(page.getByTestId('unsaved-dot')).toBeVisible()
        // the text is still real text
        await expect(page.locator('[data-page="1"] .textLayer')).toContainText('vector text must stay sharp')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
        expect(statSync(path).size).toBe(after)

        const disk = await PDFDocument.load(readFileSync(path))
        expect(disk.getPageCount()).toBe(3)
        expect(linkTarget(disk, 1)).toBe(2)
        expect(String(disk.catalog.lookup(N('Outlines'), PDFDict).get(N('Count')))).toBe('3')
        expect(disk.getForm().getTextField('reviewer').getText()).toBe('Ada Lovelace')
        expect(disk.getPage(2).node.lookup(N('Annots'), PDFArray).size()).toBeGreaterThanOrEqual(2)
        const widths = await imageWidths(path)
        // High keeps 300 dpi: the 250 dpi photo (1500 px) and the 144 dpi graphic (400 px) stay, the 400 dpi JPEG (1200 px) drops to 900.
        if (preset === 'high') expect(widths).toEqual([400, 900, 1500])
        else expect(Math.max(...widths)).toBeLessThan(1200)
        if (preset === 'smallest') expect(disk.getAuthor()).toBeUndefined()
        else expect(disk.getAuthor()).toBe('Finance team')

        // Undo restores the exact original bytes as the current state (nothing new to save)
        await page.getByRole('button', { name: 'Undo Reduce file size' }).click()
        await expect(page.getByTestId('unsaved-dot')).toBeVisible() // differs from what is now on disk
        await page.getByRole('button', { name: /^Redo/ }).click()
        await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      } finally {
        await quitDiscarding(app, page)
      }

      // Visual check of the file this run really produced (Chromium codec + worker): render it and the original in fresh
      // app instances with PDF.js and compare the pixels.
      originalRenders.pages ??= await renderPages(REPORT, [1, 2, 3])
      const rendered = await renderPages(path, [1, 2, 3])
      rendered.forEach((t, i) => {
        const d = meanDiff(originalRenders.pages![i], t)
        console.log(`[visual] ${preset} page ${i + 1}: mean abs diff ${d.toFixed(2)} / 255`)
        expect(d, `${preset} page ${i + 1}`).toBeLessThan(LIMITS[preset])
      })
      const local = meanDiff(originalRenders.pages![0], rendered[0], PHOTO_BOX)
      console.log(`[visual] ${preset} photo region: mean abs diff ${local.toFixed(2)} / 255`)
      expect(local, `${preset} photo region`).toBeLessThan(PHOTO_LIMITS[preset])
    })
  }

  test('undo returns to the original document and clears the unsaved state', async () => {
    test.setTimeout(120_000)
    const path = join(mkdtempSync(join(tmpdir(), 'epdf-undo-')), 'report.pdf')
    copyFileSync(REPORT, path)
    const { app, page } = await launch({ files: [path] })
    try {
      await openDialog(app, page)
      await runPreset(page, 'balanced')
      await page.getByTestId('compress-apply').click()
      await expect(page.getByTestId('unsaved-dot')).toBeVisible()
      await page.getByRole('button', { name: 'Undo Reduce file size' }).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      expect(statSync(path).size).toBe(reportSize)
      await openDialog(app, page)
      expect(await bytesOf(page, 'size-before')).toBe(reportSize) // the dialog sees the restored document
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('running it on a file that is already small keeps the original and says so', async () => {
    test.setTimeout(120_000)
    const small = await compressPdf(new Uint8Array(readFileSync(REPORT)), PRESETS.smallest, { codec: pureCodec })
    const path = join(mkdtempSync(join(tmpdir(), 'epdf-small-')), 'small.pdf')
    writeFileSync(path, small.bytes)
    const { app, page } = await launch({ files: [path] })
    try {
      await openDialog(app, page)
      await page.getByTestId('preset-smallest').check()
      await page.getByTestId('compress-run').click()
      await expect(page.getByTestId('compress-kept')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('compress-kept')).toContainText(/already as small|left as it is/)
      await expect(page.getByTestId('compress-apply')).toHaveCount(0)
      await expect(page.getByTestId('size-saved')).toHaveText('0%')
      await page.getByTestId('compress-cancel').click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('Custom: chosen resolution and quality apply, removal toggles work', async () => {
    test.setTimeout(180_000)
    const path = join(mkdtempSync(join(tmpdir(), 'epdf-custom-')), 'report.pdf')
    copyFileSync(REPORT, path)
    const { app, page } = await launch({ files: [path] })
    try {
      await openDialog(app, page)
      await page.getByTestId('preset-custom').check()
      await expect(page.getByTestId('compress-custom')).toBeVisible()
      await page.getByLabel('Colour and gray images: at most').fill('72')
      await page.getByLabel(/Photo \(JPEG\) quality/).fill('30')
      await page.getByTestId('opt-metadata').check()
      await expect(page.getByTestId('preset-custom')).toBeChecked()
      await page.getByTestId('compress-run').click()
      await expect(page.getByTestId('compress-apply')).toBeVisible({ timeout: 120_000 })
      await page.getByTestId('compress-apply').click()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)
      const widths = await imageWidths(path)
      // 72 dpi: the photo shown up to 6 in wide becomes 432 px, the JPEG (3 in) 216 px, the 144 dpi graphic is above 90 dpi too (200 pt = 2.8 in: 200 px)
      expect(widths).toEqual([200, 216, 432])
      const disk = await PDFDocument.load(readFileSync(path), { updateMetadata: false })
      expect(disk.getAuthor()).toBeUndefined()
      expect(disk.getTitle()).toBe('Quarterly report')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('accessibility: the dialog has no WCAG A/AA violations (light and dark, presets, custom, result)', async () => {
    test.setTimeout(240_000)
    const path = join(mkdtempSync(join(tmpdir(), 'epdf-axe-')), 'report.pdf')
    copyFileSync(REPORT, path)
    const { app, page } = await launch({ files: [path] })
    const bad: string[] = []
    const scan = async (label: string): Promise<void> => void bad.push(...(await axeViolations(page, label)))
    try {
      await openDialog(app, page)
      await scan('ready light')
      await page.getByTestId('preset-custom').check()
      await scan('custom light')
      await page.getByTestId('preset-balanced').check()
      await page.getByTestId('compress-run').click()
      await expect(page.getByTestId('compress-apply')).toBeVisible({ timeout: 120_000 })
      await scan('done light')
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      await scan('done dark')
      await page.getByTestId('compress-change').click()
      await scan('ready dark')
      await page.getByTestId('preset-custom').check()
      await scan('custom dark')
      expect(bad).toEqual([])
    } finally {
      await app.close()
    }
  })

  test('a 100+ MB document is reduced without freezing the UI, and Cancel stops a running job', async () => {
    test.setTimeout(600_000)
    const t0 = Date.now()
    const bytes = await buildStress(24, 1800, 1200)
    mkdirSync(dir, { recursive: true })
    writeFileSync(STRESS, bytes)
    const genSeconds = (Date.now() - t0) / 1000
    test.skip(genSeconds > 240, `fixture generation took ${genSeconds.toFixed(0)} s: machine too busy for the stress test`)
    expect(bytes.length).toBeGreaterThan(100 * 1024 * 1024)
    const path = join(mkdtempSync(join(tmpdir(), 'epdf-stress-')), 'stress.pdf')
    copyFileSync(STRESS, path)
    const { app, page } = await launch({ files: [path] })
    try {
      await expect(page.locator('[data-page="1"]')).toBeVisible({ timeout: 120_000 })
      await menuClick(app, 'File', 'Reduce File Size…')
      await expect(page.getByTestId('compress-run')).toBeEnabled({ timeout: 180_000 })

      // First: start, then cancel while it is running.
      await page.getByTestId('preset-balanced').check()
      await page.getByTestId('compress-run').click()
      await expect(page.getByRole('progressbar')).toBeVisible()
      await page.getByTestId('compress-cancel-run').click()
      await expect(page.getByTestId('compress-run')).toBeEnabled()
      await expect(page.getByRole('progressbar')).toHaveCount(0)
      await expect(page.getByTestId('unsaved-dot')).toHaveCount(0)

      // Then a full run; measure the longest gap between animation frames while it works.
      await page.evaluate(() => {
        const w = window as unknown as { __gap: number }
        w.__gap = 0
        let last = performance.now()
        const tick = (): void => {
          const now = performance.now()
          w.__gap = Math.max(w.__gap, now - last)
          last = now
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      const started = Date.now()
      await page.getByTestId('compress-run').click()
      await expect(page.getByTestId('compress-apply')).toBeVisible({ timeout: 480_000 })
      const seconds = (Date.now() - started) / 1000
      const gap = await page.evaluate(() => (window as unknown as { __gap: number }).__gap)
      const before = await bytesOf(page, 'size-before')
      const after = await bytesOf(page, 'size-after')
      const note = `${(before / 1048576).toFixed(0)} MB -> ${(after / 1048576).toFixed(1)} MB in ${seconds.toFixed(0)} s, longest frame gap ${gap.toFixed(0)} ms`
      test.info().annotations.push({ type: 'stress', description: note })
      console.log('[stress]', note)
      expect(after).toBeLessThan(before * 0.2)
      expect(gap).toBeLessThan(1500) // the renderer stayed responsive while a worker did the job
      await page.getByTestId('compress-apply').click()
      await expect(page.getByRole('button', { name: 'Undo Reduce file size' })).toBeEnabled()
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
    } finally {
      await quitDiscarding(app, page)
    }
  })
})
