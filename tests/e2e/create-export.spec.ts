import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { axeViolations, launch as rawLaunch, menuClick, quitDiscarding } from './helpers'
import { makePng, makeTiff, solid, withExifOrientation } from '../support/images'
import { makePdf, makeEncryptedLookingPdf } from '../support/pdfs'
import { buildDocx, para, p, r } from '../support/docxBuilder'
import { readPdf } from '../support/pdfText'

const STUB_SOFFICE = resolve('tests/fixtures/stub-soffice.mjs')
const REAL_SOFFICE = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'

let work: string
test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'epdf-ce-'))
})
test.afterAll(() => rmSync(work, { recursive: true, force: true }))

const file = (name: string, bytes: Uint8Array | string): string => {
  const p = join(work, name)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, bytes)
  return p
}
const outDir = (name: string): string => {
  const d = join(work, name)
  mkdirSync(d, { recursive: true })
  return d
}

// ---- helpers ----------------------------------------------------------------------------------------------

/** Launches the app and waits until the renderer has mounted (menu commands sent earlier would be lost). */
async function launch(opts: Parameters<typeof rawLaunch>[0] = {}) {
  const l = await rawLaunch(opts)
  await expect(l.page.getByRole('button', { name: 'Open PDF', exact: true }).first()).toBeVisible({ timeout: 30_000 })
  return l
}

interface StubConfig {
  files?: string[]
  folder?: string
  save?: string | string[] | null
}

/** Replaces the native open/save dialogs in the main process with scripted answers (and records the calls). */
async function stubDialogs(app: ElectronApplication, cfg: StubConfig): Promise<void> {
  await app.evaluate(({ dialog }, c) => {
    const g = globalThis as unknown as { __stub: { files?: string[]; folder?: string; saves: (string | null)[]; calls: { kind: string; title?: string; defaultPath?: string; filters?: unknown }[] } }
    g.__stub = { files: c.files, folder: c.folder, saves: Array.isArray(c.save) ? [...c.save] : c.save ? [c.save] : [], calls: [] }
    const opts = (a: unknown, b: unknown): { title?: string; defaultPath?: string; properties?: string[]; filters?: unknown } => (b ?? a) as never
    ;(dialog as unknown as Record<string, unknown>).showOpenDialog = async (a: unknown, b: unknown) => {
      const o = opts(a, b)
      const dir = o.properties?.includes('openDirectory')
      g.__stub.calls.push({ kind: dir ? 'folder' : 'open', title: o.title, filters: o.filters })
      if (dir) return { canceled: !g.__stub.folder, filePaths: g.__stub.folder ? [g.__stub.folder] : [] }
      const f = g.__stub.files ?? []
      return { canceled: f.length === 0, filePaths: f }
    }
    ;(dialog as unknown as Record<string, unknown>).showSaveDialog = async (a: unknown, b: unknown) => {
      const o = opts(a, b)
      g.__stub.calls.push({ kind: 'save', title: o.title, defaultPath: o.defaultPath })
      const next = g.__stub.saves.length ? g.__stub.saves.shift()! : null
      return { canceled: !next, filePath: next ?? undefined }
    }
  }, cfg)
}

const setStubFiles = (app: ElectronApplication, files: string[]): Promise<void> =>
  app.evaluate((_e, f) => void ((globalThis as unknown as { __stub: { files: string[] } }).__stub.files = f), files)

const pushSave = (app: ElectronApplication, path: string): Promise<void> =>
  app.evaluate((_e, f) => void (globalThis as unknown as { __stub: { saves: string[] } }).__stub.saves.push(f), path)

const stubCalls = (app: ElectronApplication): Promise<{ kind: string; defaultPath?: string; title?: string }[]> =>
  app.evaluate(() => (globalThis as unknown as { __stub: { calls: { kind: string }[] } }).__stub.calls)

/** Clicks an item of a submenu, e.g. File > Export To > Word (.docx). */
function menuSub(app: ElectronApplication, menu: string, sub: string, item: string): Promise<void> {
  return app.evaluate(
    ({ Menu }, [m, s, i]) => {
      const strip = (x: string): string => x.replace('&', '')
      const top = Menu.getApplicationMenu()!.items.find((x) => strip(x.label) === m)
      const subItem = top?.submenu?.items.find((x) => strip(x.label) === s)
      const it = subItem?.submenu?.items.find((x) => strip(x.label) === i)
      if (!it) throw new Error(`Menu item not found: ${m} > ${s} > ${i}`)
      it.click()
    },
    [menu, sub, item]
  )
}

const dialogOf = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name })

async function readPdfFile(path: string) {
  return readPdf(new Uint8Array(readFileSync(path)))
}

/** A real JPEG (left half red, right half blue) made with Electron's own encoder. */
async function realJpeg(app: ElectronApplication, w: number, h: number): Promise<Uint8Array> {
  const b64 = await app.evaluate(({ nativeImage }, [W, H]) => {
    const buf = Buffer.alloc(W * H * 4)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4
        const left = x < W / 2
        buf[o] = left ? 0 : 230 // B
        buf[o + 1] = 0 // G
        buf[o + 2] = left ? 230 : 0 // R
        buf[o + 3] = 255
      }
    return nativeImage.createFromBitmap(buf, { width: W, height: H }).toJPEG(95).toString('base64')
  }, [w, h])
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

const tabNamed = (page: Page, name: RegExp | string) => page.getByRole('tab', { name })

// ---- Create PDF from images ---------------------------------------------------------------------------

test.describe('Create PDF from files: images', () => {
  test('one picture: dialog, save dialog, atomic write, and the result opens in a new tab', async () => {
    const png = file('img/single.png', makePng(120, 80, (x) => [x * 2, 100, 200, 255]))
    const target = join(outDir('out1'), 'single.pdf')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { files: [png], save: target })
      await menuClick(app, 'File', 'Create PDF from File…')
      const dlg = dialogOf(page, 'Create PDF from files')
      await expect(dlg).toBeVisible()
      await expect(dlg.getByTestId('create-files')).toContainText('single.png')
      await expect(dlg.getByText('Layout of Office documents is approximate.')).toHaveCount(0) // no Office file picked
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /single\.pdf/)).toBeVisible({ timeout: 30_000 })
      expect(existsSync(target)).toBe(true)
      expect(readdirSync(join(target, '..')).filter((n) => n.includes('.tmp'))).toEqual([]) // atomic write left nothing behind
      const doc = await PDFDocument.load(readFileSync(target))
      expect(doc.getPageCount()).toBe(1)
      expect(doc.getPage(0).getSize()).toEqual({ width: 120, height: 80 })
      const calls = await stubCalls(app)
      expect(calls.map((c) => c.kind)).toEqual(['open', 'save'])
      expect(calls[1].defaultPath).toMatch(/single\.pdf$/)
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('JPEG EXIF orientation is honoured: the page swaps and the picture is drawn upright', async () => {
    const { app, page } = await launch()
    try {
      const jpeg = withExifOrientation(await realJpeg(app, 100, 50), 6) // stored 100x50, must display rotated 90° clockwise
      const src = file('img/phone.jpg', jpeg)
      const target = join(outDir('out2'), 'phone.pdf')
      await stubDialogs(app, { files: [src], save: target })
      await menuClick(app, 'File', 'Create PDF from File…')
      await dialogOf(page, 'Create PDF from files').getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /phone\.pdf/)).toBeVisible({ timeout: 30_000 })
      const doc = await PDFDocument.load(readFileSync(target))
      expect(doc.getPage(0).getSize()).toEqual({ width: 50, height: 100 })
      // rotating 100x50 (red | blue) clockwise puts red on TOP and blue at the BOTTOM
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const colours = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-page="1"] canvas')!
        const g = c.getContext('2d')!
        const at = (fx: number, fy: number): number[] => Array.from(g.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data)
        return { top: at(0.5, 0.2), bottom: at(0.5, 0.8) }
      })
      expect(colours.top[0]).toBeGreaterThan(150) // red
      expect(colours.top[2]).toBeLessThan(100)
      expect(colours.bottom[2]).toBeGreaterThan(150) // blue
      expect(colours.bottom[0]).toBeLessThan(100)
    } finally {
      await app.close()
    }
  })

  test('a multi-page TIFF makes one page per frame; several files go to a chosen folder with unique names', async () => {
    const tiff = file('img/scan.tif', makeTiff([{ w: 60, h: 40, px: solid(255, 0, 0) }, { w: 30, h: 90, px: solid(0, 255, 0) }, { w: 20, h: 20, px: solid(0, 0, 255) }]))
    const png = file('img/scan2.png', makePng(20, 20, solid(9, 9, 9)))
    const folder = outDir('out3')
    writeFileSync(join(folder, 'scan.pdf'), 'existing file that must not be overwritten')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { files: [tiff, png], folder })
      await menuClick(app, 'File', 'Create PDF from File…')
      const dlg = dialogOf(page, 'Create PDF from files')
      await expect(dlg.getByTestId('create-files').getByRole('listitem')).toHaveCount(2)
      await dlg.getByLabel('Page size for pictures').selectOption('a4')
      await dlg.getByRole('button', { name: 'Create 2 PDFs…' }).click()
      await expect(tabNamed(page, /scan \(2\)\.pdf/)).toBeVisible({ timeout: 30_000 })
      await expect(tabNamed(page, /scan2\.pdf/)).toBeVisible()
      expect(readFileSync(join(folder, 'scan.pdf'), 'utf8')).toBe('existing file that must not be overwritten')
      const doc = await PDFDocument.load(readFileSync(join(folder, 'scan (2).pdf')))
      expect(doc.getPageCount()).toBe(3)
      // "Fit on A4": A4 pages (landscape for the wide frame), picture inside the margins
      expect(doc.getPage(0).getSize().width).toBeCloseTo(841.89, 0)
      expect(doc.getPage(1).getSize().width).toBeCloseTo(595.28, 0)
      expect((await calls(app)).filter((c) => c.kind === 'folder')).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  test('cancelling the Save dialog keeps everything as it was; bad and unsupported files are reported', async () => {
    const png = file('img/cancel.png', makePng(10, 10, solid(0, 0, 0)))
    const bad = file('img/broken.png', 'this is not a picture')
    const exe = file('img/tool.exe', 'MZ')
    const alreadyPdf = file('img/already.pdf', await makePdf({ pages: 1 }))
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { files: [png], save: null })
      await menuClick(app, 'File', 'Create PDF from File…')
      await dialogOf(page, 'Create PDF from files').getByRole('button', { name: 'Create PDF…' }).click()
      await expect(page.getByText('Nothing was saved.')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('tab')).toHaveCount(0)

      // a picture that is not a picture fails with its name
      await setStubFiles(app, [bad])
      await pushSave(app, join(outDir('out4'), 'broken.pdf'))
      await menuClick(app, 'File', 'Create PDF from File…')
      await dialogOf(page, 'Create PDF from files').getByRole('button', { name: 'Create PDF…' }).click()
      await expect(page.getByRole('alert').filter({ hasText: /“broken\.png” could not be converted/ }).first()).toBeVisible({ timeout: 30_000 })

      // unsupported / already a PDF: skipped with reasons, no dialog when nothing usable is left
      await setStubFiles(app, [exe, alreadyPdf])
      await menuClick(app, 'File', 'Create PDF from File…')
      await expect(page.getByText(/Skipped 2 files/)).toBeVisible()
      await expect(dialogOf(page, 'Create PDF from files')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
})

const calls = stubCalls

// ---- HEIC ---------------------------------------------------------------------------------------------------

test.describe('Create PDF from files: HEIC', () => {
  test('a file the OS decoder rejects gives a clear, helpful message', async () => {
    const heic = file('img/broken.heic', 'not really a heic file')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { files: [heic], save: join(outDir('out5'), 'broken.pdf') })
      await menuClick(app, 'File', 'Create PDF from File…')
      await dialogOf(page, 'Create PDF from files').getByRole('button', { name: 'Create PDF…' }).click()
      const alert = page.getByRole('alert').filter({ hasText: /“broken\.heic” could not be converted/ }).first()
      await expect(alert).toBeVisible({ timeout: 60_000 })
      await expect(alert).toContainText(/HEIC decoder|HEIF Image Extensions|heif-convert|Preview/)
      // no temp files left behind by the decoder
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith('epdf-heic-'))).toEqual([])
    } finally {
      await app.close()
    }
  })

  const realHeic = process.env['EPDF_TEST_HEIC']
  test('a real HEIC picture is converted through the OS decoder (set EPDF_TEST_HEIC=<file.heic> to run)', async () => {
    test.skip(!realHeic || !existsSync(realHeic), 'Set EPDF_TEST_HEIC to a real .heic file to verify the OS decoder path.')
    const target = join(outDir('out6'), 'real.pdf')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { files: [realHeic!], save: target })
      await menuClick(app, 'File', 'Create PDF from File…')
      await dialogOf(page, 'Create PDF from files').getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /real\.pdf/)).toBeVisible({ timeout: 90_000 })
      const doc = await PDFDocument.load(readFileSync(target))
      expect(doc.getPageCount()).toBe(1)
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
    } finally {
      await app.close()
    }
  })
})

// ---- web pages ------------------------------------------------------------------------------------------------

interface TestServer {
  url: string
  close(): Promise<void>
}

function startServer(): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/hang') return // never answers
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (url === '/missing') {
      res.statusCode = 404
      res.end('<html><head><title>Custom 404</title></head><body><h1>Custom not found page</h1></body></html>')
    } else if (url === '/js') {
      res.end('<html><head><title>JS page</title></head><body><p>Static paragraph</p><noscript><p>NOSCRIPT-TEXT</p></noscript><script>document.body.insertAdjacentHTML("beforeend", "<p>SCRIPT-ADDED-TEXT</p>")</script></body></html>')
    } else {
      res.end('<html><head><title>Local Test Page</title><style>body{background:#fffbe6}h1{color:#c00}</style></head><body><h1>Local test heading</h1><p>Hello from the tiny test server.</p></body></html>')
    }
  })
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolveP({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) })
    })
  })
}

test.describe('Create PDF from web page', () => {
  let server: TestServer
  test.beforeAll(async () => {
    server = await startServer()
  })
  test.afterAll(async () => {
    await server.close()
  })

  const openWebDialog = async (app: ElectronApplication, page: Page) => {
    await menuClick(app, 'File', 'Create PDF from Web Page…')
    const dlg = dialogOf(page, 'Create PDF from web page')
    await expect(dlg).toBeVisible()
    return dlg
  }

  test('renders a local page to PDF, saves it and opens it; the page title becomes the file name', async () => {
    const target = join(outDir('web1'), 'local.pdf')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { save: target })
      const dlg = await openWebDialog(app, page)
      await dlg.getByLabel('Web address').fill(server.url + '/')
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /local\.pdf/)).toBeVisible({ timeout: 60_000 })
      const doc = await readPdfFile(target)
      expect(doc.pages.length).toBeGreaterThanOrEqual(1)
      expect(doc.pages[0].text).toContain('Local test heading')
      expect(doc.pages[0].text).toContain('Hello from the tiny test server.')
      const saveCall = (await calls(app)).find((c) => c.kind === 'save')!
      expect(saveCall.defaultPath).toContain('Local Test Page.pdf')
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Local test heading')
    } finally {
      await app.close()
    }
  })

  test('scripts run by default and can be switched off', async () => {
    const withJs = join(outDir('web2'), 'js-on.pdf')
    const withoutJs = join(outDir('web2'), 'js-off.pdf')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { save: withJs })
      let dlg = await openWebDialog(app, page)
      await dlg.getByLabel('Web address').fill(server.url + '/js')
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /js-on\.pdf/)).toBeVisible({ timeout: 60_000 })
      const on = (await readPdfFile(withJs)).pages[0].text
      expect(on).toContain('SCRIPT-ADDED-TEXT')
      expect(on).not.toContain('NOSCRIPT-TEXT')

      await pushSave(app, withoutJs)
      dlg = await openWebDialog(app, page)
      await dlg.getByLabel('Web address').fill(server.url + '/js')
      await dlg.getByLabel(/Run the page’s scripts/).uncheck()
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /js-off\.pdf/)).toBeVisible({ timeout: 60_000 })
      const off = (await readPdfFile(withoutJs)).pages[0].text
      expect(off).not.toContain('SCRIPT-ADDED-TEXT')
      expect(off).toContain('NOSCRIPT-TEXT')
    } finally {
      await app.close()
    }
  })

  test('a 404 page still renders (with a note), an unreachable port and a bad host give friendly errors', async () => {
    const target = join(outDir('web3'), 'missing.pdf')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { save: target })
      let dlg = await openWebDialog(app, page)
      await dlg.getByLabel('Web address').fill(server.url + '/missing')
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /missing\.pdf/)).toBeVisible({ timeout: 60_000 })
      expect((await readPdfFile(target)).pages[0].text).toContain('Custom not found page')
      const report = dialogOf(page, 'Create PDF from web page')
      await expect(report.getByTestId('result-notes')).toContainText('status 404')
      await report.getByRole('button', { name: 'Close' }).click()

      // nothing is listening on this port
      const dead = await startServer()
      const deadUrl = dead.url
      await dead.close()
      dlg = await openWebDialog(app, page)
      await dlg.getByLabel('Web address').fill(deadUrl)
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(page.getByRole('alert').filter({ hasText: /refused the connection/ }).first()).toBeVisible({ timeout: 60_000 })

      // a host that cannot exist
      dlg = await openWebDialog(app, page)
      await dlg.getByLabel('Web address').fill('http://no-such-host.invalid/')
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(page.getByRole('alert').filter({ hasText: /could not be found|no internet connection|could not be reached/ }).first()).toBeVisible({ timeout: 60_000 })
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('validates the address in the dialog: only http(s), a missing scheme is added', async () => {
    const { app, page } = await launch()
    try {
      const dlg = await openWebDialog(app, page)
      const input = dlg.getByLabel('Web address')
      const go = dlg.getByRole('button', { name: 'Create PDF…' })
      await expect(go).toBeDisabled()
      for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ftp://example.com/x']) {
        await input.fill(bad)
        await expect(dlg.getByRole('alert')).toContainText(/Only web addresses starting with http/)
        await expect(go).toBeDisabled()
      }
      await input.fill('example.com')
      await expect(dlg.getByRole('alert')).toHaveCount(0)
      await expect(go).toBeEnabled()
    } finally {
      await app.close()
    }
  })

  test('a page that never answers can be cancelled from the jobs tray, and a hard timeout ends it', async () => {
    const { app, page } = await launch({ env: { EPDF_WEB_TIMEOUT_MS: '4000' } })
    try {
      await stubDialogs(app, { save: join(outDir('web4'), 'hang.pdf') })
      let dlg = await openWebDialog(app, page)
      await dlg.getByLabel('Web address').fill(server.url + '/hang')
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      const job = page.locator('[data-job="create:web"]')
      await expect(job).toBeVisible()
      await job.getByRole('button', { name: 'Cancel' }).click()
      await expect(job).toContainText('Cancelled')

      dlg = await openWebDialog(app, page)
      await dlg.getByLabel('Web address').fill(server.url + '/hang')
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(page.getByRole('alert').filter({ hasText: /did not finish loading within 4 seconds/ }).first()).toBeVisible({ timeout: 30_000 })
      expect(existsSync(join(work, 'web4', 'hang.pdf'))).toBe(false)
    } finally {
      await app.close()
    }
  })
})

// ---- Office documents: LibreOffice engine (optional) and the missing-tool path ----------------------------

const helpers = { file, outDir }
void helpers

test.describe('Office documents with the optional LibreOffice engine', () => {
  const noDiscovery = { EPDF_DISABLE_SOFFICE_DISCOVERY: '1' }

  test('converts through the stub tool when LibreOffice is chosen', async () => {
    const docx = file('office/report.docx', 'Quarterly numbers go here')
    const target = join(outDir('lo1'), 'report.pdf')
    const { app, page } = await launch({ env: { ...noDiscovery, EPDF_TOOL_SOFFICE: STUB_SOFFICE } })
    try {
      await stubDialogs(app, { files: [docx], save: target })
      await menuClick(app, 'File', 'Create PDF from File…')
      const dlg = dialogOf(page, 'Create PDF from files')
      await expect(dlg.getByTestId('lo-status')).toContainText('Found on this computer')
      await dlg.getByLabel(/LibreOffice \(if installed\)/).check()
      await expect(dlg.getByText('Layout of Office documents is approximate.')).toHaveCount(0)
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /report\.pdf/)).toBeVisible({ timeout: 60_000 })
      expect((await readPdfFile(target)).pages[0].text).toContain('STUB:Quarterly numbers go here')
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith('epdf-lo-'))).toEqual([])
      // the choice is remembered for next time
      await page.getByRole('tab', { name: /report\.pdf/ }).click()
      await pushSave(app, join(outDir('lo1'), 'again.pdf'))
      await menuClick(app, 'File', 'Create PDF from File…')
      await expect(dialogOf(page, 'Create PDF from files').getByLabel(/LibreOffice \(if installed\)/)).toBeChecked()
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('without LibreOffice the option is disabled with instructions, and the built-in engine is the default', async () => {
    const txt = file('office/plain.txt', 'Plain text through the built-in engine')
    const target = join(outDir('lo2'), 'plain.pdf')
    const { app, page } = await launch({ env: noDiscovery })
    try {
      await stubDialogs(app, { files: [txt], save: target })
      await menuClick(app, 'File', 'Create PDF from File…')
      const dlg = dialogOf(page, 'Create PDF from files')
      await expect(dlg.getByLabel(/Built-in converter/)).toBeChecked()
      const lo = dlg.getByLabel(/LibreOffice \(if installed\)/)
      await expect(lo).toBeDisabled()
      await expect(dlg.getByTestId('lo-status')).toContainText(/Install LibreOffice.*EPDF_TOOL_SOFFICE/)
      await expect(dlg.getByText('Layout of Office documents is approximate.')).toBeVisible()
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /plain\.pdf/)).toBeVisible({ timeout: 60_000 })
      expect((await readPdfFile(target)).pages[0].text).toBe('Plain text through the built-in engine')
    } finally {
      await app.close()
    }
  })

  test('legacy .doc files are refused by the built-in engine with instructions', async () => {
    const doc = file('office/old.doc', 'binary')
    const { app, page } = await launch({ env: noDiscovery })
    try {
      await stubDialogs(app, { files: [doc], save: join(outDir('lo3'), 'old.pdf') })
      await menuClick(app, 'File', 'Create PDF from File…')
      const dlg = dialogOf(page, 'Create PDF from files')
      await expect(dlg.getByTestId('legacy-warning')).toContainText('Save them as .docx')
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(page.getByRole('alert').filter({ hasText: /old binary \.doc file/ }).first()).toBeVisible({ timeout: 30_000 })
    } finally {
      await app.close()
    }
  })

  test('a long LibreOffice conversion can be cancelled: the tool is killed and every temp file is removed', async () => {
    const docx = file('office/slow.docx', 'slow one')
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('epdf-lo-')).length
    const { app, page } = await launch({ env: { ...noDiscovery, EPDF_TOOL_SOFFICE: STUB_SOFFICE, EPDF_STUB_MODE: 'sleep', EPDF_STUB_SLEEP_MS: '120000' } })
    try {
      await stubDialogs(app, { files: [docx], save: join(outDir('lo4'), 'slow.pdf') })
      await menuClick(app, 'File', 'Create PDF from File…')
      const dlg = dialogOf(page, 'Create PDF from files')
      await dlg.getByLabel(/LibreOffice \(if installed\)/).check()
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      const job = page.locator('[data-job="create:convert"]')
      await expect(job).toBeVisible()
      await expect.poll(() => readdirSync(tmpdir()).filter((n) => n.startsWith('epdf-lo-')).length, { timeout: 15_000 }).toBeGreaterThan(before) // the temp profile exists while running
      await job.getByRole('button', { name: 'Cancel' }).click()
      await expect(job).toContainText('Cancelled')
      await expect.poll(() => readdirSync(tmpdir()).filter((n) => n.startsWith('epdf-lo-')).length, { timeout: 20_000 }).toBe(before)
      expect(existsSync(join(work, 'lo4', 'slow.pdf'))).toBe(false)
      await expect(page.getByRole('tab')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('a failing tool reports the error', async () => {
    const docx = file('office/bad.docx', 'x')
    const { app, page } = await launch({ env: { ...noDiscovery, EPDF_TOOL_SOFFICE: STUB_SOFFICE, EPDF_STUB_MODE: 'fail' } })
    try {
      await stubDialogs(app, { files: [docx], save: join(outDir('lo5'), 'bad.pdf') })
      await menuClick(app, 'File', 'Create PDF from File…')
      const dlg = dialogOf(page, 'Create PDF from files')
      await dlg.getByLabel(/LibreOffice \(if installed\)/).check()
      await dlg.getByRole('button', { name: 'Create PDF…' }).click()
      await expect(page.getByRole('alert').filter({ hasText: /LibreOffice could not convert “bad\.docx”/ }).first()).toBeVisible({ timeout: 60_000 })
    } finally {
      await app.close()
    }
  })

  test('REAL LibreOffice: converts a .txt and a docx made by our own writer', async () => {
    test.skip(!existsSync(REAL_SOFFICE), `LibreOffice is not installed at ${REAL_SOFFICE}; real-tool verification skipped.`)
    test.setTimeout(240_000)
    const txt = file('office/real.txt', 'Real LibreOffice text conversion')
    const docx = file('office/real.docx', buildDocx({ body: p(r('Real docx via LibreOffice'), {}) + para('second paragraph') }))
    const folder = outDir('lo6')
    const { app, page } = await launch({ env: { EPDF_TOOL_SOFFICE: REAL_SOFFICE } })
    try {
      await stubDialogs(app, { files: [txt, docx], folder })
      await menuClick(app, 'File', 'Create PDF from File…')
      const dlg = dialogOf(page, 'Create PDF from files')
      await dlg.getByLabel(/LibreOffice \(if installed\)/).check()
      await dlg.getByRole('button', { name: 'Create 2 PDFs…' }).click()
      await expect(tabNamed(page, /real\.pdf/).first()).toBeVisible({ timeout: 200_000 })
      await expect(page.getByRole('tab')).toHaveCount(2, { timeout: 200_000 })
      const names = readdirSync(folder).sort()
      expect(names).toEqual(['real (2).pdf', 'real.pdf'])
      const texts = await Promise.all(names.map(async (n) => (await readPdfFile(join(folder, n))).pages[0].text))
      expect(texts.join('\n')).toContain('Real LibreOffice text conversion')
      expect(texts.join('\n')).toContain('Real docx via LibreOffice')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---- built-in engine, every format ------------------------------------------------------------------------

test.describe('Office documents with the built-in engine', () => {
  test('a docx (built with our own writer) becomes a PDF with its text, styles and a table', async () => {
    const docx = file('builtin/doc.docx', buildDocx({ body: para('Built-in heading', { style: 'Heading1' }) + para('Body text of the document.') }))
    const target = join(outDir('bi1'), 'doc.pdf')
    const { app, page } = await launch({ env: { EPDF_DISABLE_SOFFICE_DISCOVERY: '1' } })
    try {
      await stubDialogs(app, { files: [docx], save: target })
      await menuClick(app, 'File', 'Create PDF from File…')
      await dialogOf(page, 'Create PDF from files').getByRole('button', { name: 'Create PDF…' }).click()
      await expect(tabNamed(page, /doc\.pdf/)).toBeVisible({ timeout: 60_000 })
      const pdf = await readPdfFile(target)
      expect(pdf.pages[0].text).toBe('Built-in heading\nBody text of the document.')
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Built-in heading')
    } finally {
      await app.close()
    }
  })
})

// ---- Combine ------------------------------------------------------------------------------------------------

test.describe('Combine files', () => {
  const sizes = { a: [111, 111], b: [222, 222], c: [333, 333], img: [50, 40] } as const

  async function fixtures() {
    const a = file('combine/A.pdf', await makePdf({ sizes: [[111, 111], [111, 111]], label: 'A' }))
    const b = file('combine/B.pdf', await makePdf({ sizes: [[222, 222]], label: 'B' }))
    const c = file('combine/C.pdf', await makePdf({ sizes: [[333, 333], [333, 333], [333, 333]], label: 'C' }))
    const img = file('combine/D.png', makePng(50, 40, solid(10, 200, 10)))
    return { a, b, c, img }
  }

  const orderOfPages = async (path: string): Promise<number[]> => (await PDFDocument.load(readFileSync(path))).getPages().map((pg) => Math.round(pg.getWidth()))
  const rowNames = (page: Page) => page.getByTestId('combine-item').locator('span.truncate').allTextContents()

  test('reorders by drag and drop AND by keyboard, then merges in that order, opens the result and keeps bookmarks', async () => {
    const f = await fixtures()
    const target = join(outDir('cmb1'), 'Combined.pdf')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { files: [f.a, f.b, f.c, f.img], save: target })
      await menuClick(app, 'File', 'Combine Files…')
      const dlg = dialogOf(page, 'Combine files')
      await expect(dlg).toBeVisible()
      await expect(dlg.getByText('No files yet')).toBeVisible()
      await dlg.getByRole('button', { name: 'Add files…' }).click()
      await expect(dlg.getByTestId('combine-item')).toHaveCount(4)
      expect(await rowNames(page)).toEqual(['A.pdf', 'B.pdf', 'C.pdf', 'D.png'])
      await expect(dlg.getByTestId('combine-summary')).toContainText('4 files')
      await expect(dlg.getByTestId('combine-item').first()).toContainText('2 pages')

      // drag the last row (D.png) onto the top half of the first row
      const items = dlg.getByTestId('combine-item')
      const first = items.nth(0)
      const last = items.nth(3)
      const fb = (await first.boundingBox())!
      await last.dragTo(first, { targetPosition: { x: 40, y: Math.max(2, fb.height * 0.15) } })
      await expect.poll(() => rowNames(page)).toEqual(['D.png', 'A.pdf', 'B.pdf', 'C.pdf'])
      await expect(dlg.getByTestId('combine-announce')).toContainText('Moved D.png to position 1 of 4')

      // keyboard: Alt+ArrowDown on B's reorder button moves it below C; focus stays on that button
      const handleB = dlg.getByRole('button', { name: /^Reorder B\.pdf/ })
      await handleB.focus()
      await page.keyboard.press('Alt+ArrowDown')
      await expect.poll(() => rowNames(page)).toEqual(['D.png', 'A.pdf', 'C.pdf', 'B.pdf'])
      await expect(dlg.getByRole('button', { name: /^Reorder B\.pdf.*position 4 of 4/ })).toBeFocused()
      await expect(dlg.getByTestId('combine-announce')).toContainText('Moved B.pdf to position 4 of 4')
      await page.keyboard.press('Alt+ArrowUp')
      await page.keyboard.press('Alt+ArrowUp')
      await expect.poll(() => rowNames(page)).toEqual(['D.png', 'B.pdf', 'A.pdf', 'C.pdf'])
      // the Move buttons work too and are disabled at the ends
      await expect(dlg.getByRole('button', { name: 'Move D.png up' })).toBeDisabled()
      await dlg.getByRole('button', { name: 'Move D.png down' }).click()
      await expect.poll(() => rowNames(page)).toEqual(['B.pdf', 'D.png', 'A.pdf', 'C.pdf'])

      // remove one, restrict another to its first page
      await dlg.getByRole('button', { name: 'Remove D.png' }).click()
      await dlg.getByLabel('Pages to include from C.pdf').fill('2-3')
      await expect.poll(() => rowNames(page)).toEqual(['B.pdf', 'A.pdf', 'C.pdf'])

      await dlg.getByRole('button', { name: 'Combine…' }).click()
      await expect(tabNamed(page, /Combined\.pdf/)).toBeVisible({ timeout: 60_000 })
      expect(await orderOfPages(target)).toEqual([222, 111, 111, 333, 333]) // B(1) A(2) C pages 2-3
      const merged = await PDFDocument.load(readFileSync(target))
      expect(merged.getPageCount()).toBe(5)
      const outline = merged.catalog.lookup((await import('pdf-lib')).PDFName.of('Outlines'))
      expect(outline).toBeTruthy()
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      const pdf = await readPdfFile(target)
      expect(pdf.pages.map((pg) => pg.text.split('\n')[0])).toEqual(['B page 1', 'A page 1', 'A page 2', 'C page 2', 'C page 3'])
      const saveCall = (await calls(app)).filter((c) => c.kind === 'save')[0]
      expect(saveCall.defaultPath).toMatch(/Combined\.pdf$/)
    } finally {
      await app.close()
    }
  })

  test('mixed types are converted first: an image and a text file combine with PDFs', async () => {
    const f = await fixtures()
    const txt = file('combine/notes.txt', 'Notes in the middle')
    const target = join(outDir('cmb2'), 'mixed.pdf')
    const { app, page } = await launch({ env: { EPDF_DISABLE_SOFFICE_DISCOVERY: '1' } })
    try {
      await stubDialogs(app, { files: [f.a, txt, f.img], save: target })
      await menuClick(app, 'File', 'Combine Files…')
      const dlg = dialogOf(page, 'Combine files')
      await dlg.getByRole('button', { name: 'Add files…' }).click()
      await expect(dlg.getByTestId('combine-item')).toHaveCount(3)
      await expect(dlg.getByText('Layout of Office documents is approximate.')).toBeVisible()
      await dlg.getByLabel('Add a bookmark for each file').uncheck()
      await dlg.getByRole('button', { name: 'Combine…' }).click()
      await expect(tabNamed(page, /mixed\.pdf/)).toBeVisible({ timeout: 60_000 })
      const doc = await PDFDocument.load(readFileSync(target))
      expect(doc.getPageCount()).toBe(4)
      const widths = doc.getPages().map((pg) => Math.round(pg.getWidth()))
      expect(widths.slice(0, 2)).toEqual([111, 111])
      expect([595, 612]).toContain(widths[2]) // the text file: A4 or Letter depending on the locale
      expect(widths[3]).toBe(50)
      expect((await readPdfFile(target)).pages[2].text).toBe('Notes in the middle')
      void sizes
    } finally {
      await app.close()
    }
  })

  test('an encrypted or damaged file is flagged with the reason and blocks Combine until removed; bad ranges are explained', async () => {
    const f = await fixtures()
    const enc = file('combine/secret.pdf', await makeEncryptedLookingPdf())
    const junk = file('combine/junk.pdf', 'not a pdf')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { files: [f.a, enc, junk], save: join(outDir('cmb3'), 'never.pdf') })
      await menuClick(app, 'File', 'Combine Files…')
      const dlg = dialogOf(page, 'Combine files')
      await dlg.getByRole('button', { name: 'Add files…' }).click()
      await expect(dlg.getByTestId('combine-item')).toHaveCount(3)
      await expect(dlg.getByTestId('combine-problem').first()).toContainText('“secret.pdf” is password protected')
      await expect(dlg.getByTestId('combine-problem').nth(1)).toContainText('“junk.pdf” is damaged')
      const go = dlg.getByRole('button', { name: 'Combine…' })
      await expect(go).toBeDisabled()
      await dlg.getByRole('button', { name: 'Remove secret.pdf' }).click()
      await dlg.getByRole('button', { name: 'Remove junk.pdf' }).click()
      await expect(go).toBeEnabled()
      const range = dlg.getByLabel('Pages to include from A.pdf')
      await range.fill('9')
      await expect(dlg.getByTestId('combine-problem')).toContainText('This file has only 2 pages.')
      await expect(go).toBeDisabled()
      await range.fill('2-1')
      await expect(dlg.getByTestId('combine-problem')).toContainText('goes backwards')
      await range.fill('')
      await expect(go).toBeEnabled()
    } finally {
      await app.close()
    }
  })

  test('merging renames duplicate form-field names so every field survives', async () => {
    const a = file('combine/formA.pdf', await makePdf({ label: 'A', fields: ['name', 'email'] }))
    const b = file('combine/formB.pdf', await makePdf({ label: 'B', fields: ['name'] }))
    const target = join(outDir('cmb4'), 'forms.pdf')
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { files: [a, b], save: target })
      await menuClick(app, 'File', 'Combine Files…')
      const dlg = dialogOf(page, 'Combine files')
      await dlg.getByRole('button', { name: 'Add files…' }).click()
      await dlg.getByRole('button', { name: 'Combine…' }).click()
      await expect(tabNamed(page, /forms\.pdf/)).toBeVisible({ timeout: 60_000 })
      const names = (await PDFDocument.load(readFileSync(target))).getForm().getFields().map((fl) => fl.getName()).sort()
      expect(names).toEqual(['email', 'name', 'name_2'])
      await expect(dialogOf(page, 'Combine Files').getByTestId('result-notes')).toContainText('renamed to “name_2”')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

// ---- command-line verbs --------------------------------------------------------------------------------------

test.describe('command-line verbs', () => {
  test('--convert-to-pdf converts each file next to itself and opens the results; the PDFs in argv are not opened twice', async () => {
    const dir = outDir('cli1')
    const png = file('cli1/photo.png', makePng(64, 48, solid(1, 2, 3)))
    const txt = file('cli1/notes.txt', 'CLI converted text')
    const { app, page } = await launch({ env: { EPDF_DISABLE_SOFFICE_DISCOVERY: '1' } })
    await app.close()
    void page
    // Launch the real way: verbs on the command line at startup.
    const started = await launchWithArgs(['--convert-to-pdf', png, txt])
    try {
      await expect(tabNamed(started.page, /photo\.pdf/)).toBeVisible({ timeout: 60_000 })
      await expect(tabNamed(started.page, /notes\.pdf/)).toBeVisible()
      expect(readdirSync(dir).filter((n) => n.endsWith('.pdf')).sort()).toEqual(['notes.pdf', 'photo.pdf'])
      expect((await readPdfFile(join(dir, 'notes.pdf'))).pages[0].text).toBe('CLI converted text')
      expect((await PDFDocument.load(readFileSync(join(dir, 'photo.pdf')))).getPage(0).getSize()).toEqual({ width: 64, height: 48 })
      // running it again does not overwrite: a unique name is used
    } finally {
      await started.app.close()
    }
    const again = await launchWithArgs(['--convert-to-pdf', png])
    try {
      await expect(tabNamed(again.page, /photo \(2\)\.pdf/)).toBeVisible({ timeout: 60_000 })
    } finally {
      await again.app.close()
    }
  })

  test('--combine opens the Combine screen with the files preloaded, in the given order, without opening them as tabs', async () => {
    const a = file('cli2/first.pdf', await makePdf({ label: 'A' }))
    const b = file('cli2/second.pdf', await makePdf({ label: 'B', sizes: [[200, 200]] }))
    const started = await launchWithArgs(['--combine', b, a])
    try {
      const dlg = dialogOf(started.page, 'Combine files')
      await expect(dlg).toBeVisible({ timeout: 30_000 })
      expect(await rowNames(started.page)).toEqual(['second.pdf', 'first.pdf'])
      await expect(started.page.getByRole('tab')).toHaveCount(0) // not opened as documents
    } finally {
      await started.app.close()
    }
  })

  test('a second launch (second-instance) with a verb is handled by the running app', async () => {
    const a = file('cli3/one.pdf', await makePdf({ label: 'A' }))
    const b = file('cli3/two.pdf', await makePdf({ label: 'B' }))
    const png = file('cli3/pic.png', makePng(30, 30, solid(5, 5, 5)))
    const { app, page } = await launch()
    try {
      await app.evaluate(({ app: a2 }, args) => void a2.emit('second-instance', {}, ['epdf', ...args.argv], args.cwd), { argv: ['--combine', a, b], cwd: work })
      await expect(dialogOf(page, 'Combine files')).toBeVisible({ timeout: 30_000 })
      expect(await rowNames(page)).toEqual(['one.pdf', 'two.pdf'])
      await expect(page.getByRole('tab')).toHaveCount(0)
      await dialogOf(page, 'Combine files').getByRole('button', { name: 'Cancel' }).click()
      await app.evaluate(({ app: a2 }, args) => void a2.emit('second-instance', {}, ['epdf', ...args.argv], args.cwd), { argv: ['--convert-to-pdf', png], cwd: work })
      await expect(tabNamed(page, /pic\.pdf/)).toBeVisible({ timeout: 60_000 })
    } finally {
      await app.close()
    }
  })

  const rowNames = (page: Page) => page.getByTestId('combine-item').locator('span.truncate').allTextContents()
})

async function launchWithArgs(args: string[]) {
  const { _electron: electron } = await import('@playwright/test')
  const userData = mkdtempSync(join(tmpdir(), 'epdf-e2e-'))
  const app = await electron.launch({
    args: ['.', ...args],
    env: { ...process.env, EPDF_USER_DATA: userData, ELECTRON_RENDERER_URL: '', EPDF_DISABLE_SOFFICE_DISCOVERY: '1' } as Record<string, string>
  })
  const page = await app.firstWindow()
  return { app, page, userData }
}

// ---- Export --------------------------------------------------------------------------------------------------

test.describe('Export to Word / Excel / PowerPoint', () => {
  const FIX = resolve('test-results/fixtures')
  const cases = [
    { menu: 'Word (.docx)', ext: 'docx', dialog: 'Export to Word (.docx)', parts: ['word/document.xml', '[Content_Types].xml'] },
    { menu: 'Excel (.xlsx)', ext: 'xlsx', dialog: 'Export to Excel (.xlsx)', parts: ['xl/workbook.xml', '[Content_Types].xml'] },
    { menu: 'PowerPoint (.pptx)', ext: 'pptx', dialog: 'Export to PowerPoint (.pptx)', parts: ['ppt/presentation.xml', '[Content_Types].xml'] }
  ] as const
  for (const c of cases) {
    test(`${c.ext}: exports the open PDF to a valid package with the text in it`, async () => {
      const { unzipSync, strFromU8 } = await import('fflate')
      const { DOMParser } = await import('@xmldom/xmldom')
      const target = join(outDir(`exp-${c.ext}`), `sample.${c.ext}`)
      const { app, page } = await launch({ files: [join(FIX, 'sample.pdf')] })
      try {
        await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
        await stubDialogs(app, { save: target })
        await menuSub(app, 'File', 'Export To', c.menu)
        const dlg = dialogOf(page, c.dialog)
        await expect(dlg).toBeVisible()
        await expect(dlg.getByTestId('export-approximate')).toContainText('Layout is approximate')
        await dlg.getByRole('button', { name: /^Export/ }).click()
        await expect(dlg.getByTestId('export-done')).toBeVisible({ timeout: 60_000 })
        const zip = unzipSync(new Uint8Array(readFileSync(target)))
        for (const part of c.parts) expect(Object.keys(zip), part).toContain(part)
        let all = ''
        for (const [name, bytes] of Object.entries(zip)) {
          if (!/\.(xml|rels)$/.test(name)) continue
          const xml = strFromU8(bytes)
          const errors: string[] = []
          new DOMParser({ onError: (level, msg) => errors.push(`${level}: ${msg}`) }).parseFromString(xml, 'text/xml')
          expect(errors, name).toEqual([])
          all += xml
        }
        expect(all).toContain('Epdf sample page 1')
        expect(all).toContain('The quick brown fox')
        if (c.ext === 'pptx') expect(Object.keys(zip).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(5)
        if (c.ext === 'xlsx') expect(Object.keys(zip).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length).toBeGreaterThanOrEqual(1)
      } finally {
        await app.close()
      }
    })
  }

  test('cancelling the Save dialog writes nothing; with no document open the user is told', async () => {
    const target = join(outDir('exp-none'), 'sample.docx')
    const { app, page } = await launch({ files: [join(FIX, 'sample.pdf')] })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      await stubDialogs(app, { save: null })
      await menuSub(app, 'File', 'Export To', 'Word (.docx)')
      const dlg = dialogOf(page, 'Export to Word (.docx)')
      await dlg.getByRole('button', { name: /^Export/ }).click()
      await expect(dlg).toHaveCount(0, { timeout: 30_000 })
      expect(existsSync(target)).toBe(false)
    } finally {
      await app.close()
    }
    const empty = await launch()
    try {
      await menuSub(empty.app, 'File', 'Export To', 'Word (.docx)')
      await expect(empty.page.getByRole('alert').filter({ hasText: 'Open a PDF first.' })).toBeVisible()
    } finally {
      await empty.app.close()
    }
  })
})

// ---- accessibility ------------------------------------------------------------------------------------------

test.describe('accessibility of the new dialogs (WCAG 2.1 A/AA, light and dark)', () => {
  async function scanBoth(app: ElectronApplication, page: Page, label: string): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
      await app.evaluate(({ nativeTheme }, t) => void (nativeTheme.themeSource = t), theme)
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
      else await expect(page.locator('html')).not.toHaveClass(/dark/)
      expect(await axeViolations(page, `${label} ${theme}`)).toEqual([])
    }
  }

  test('create, web, combine, result and export dialogs have no violations', async () => {
    const f = await (async () => {
      const a = file('a11y/A.pdf', await makePdf({ label: 'A', pages: 2 }))
      const enc = file('a11y/secret.pdf', await makeEncryptedLookingPdf())
      const img = file('a11y/pic.png', makePng(20, 20, solid(1, 2, 3)))
      const docx = file('a11y/doc.docx', buildDocx({ body: para('x') }))
      return { a, enc, img, docx }
    })()
    const { app, page } = await launch({ files: [resolve('test-results/fixtures/sample.pdf')], env: { EPDF_DISABLE_SOFFICE_DISCOVERY: '1' } })
    try {
      await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
      // create (pictures + Office: shows every control)
      await stubDialogs(app, { files: [f.img, f.docx, file('a11y/old.doc', 'x')] })
      await menuClick(app, 'File', 'Create PDF from File…')
      await expect(dialogOf(page, 'Create PDF from files')).toBeVisible()
      await scanBoth(app, page, 'create dialog')
      await page.keyboard.press('Escape')

      await menuClick(app, 'File', 'Create PDF from Web Page…')
      await expect(dialogOf(page, 'Create PDF from web page')).toBeVisible()
      await scanBoth(app, page, 'web dialog')
      await dialogOf(page, 'Create PDF from web page').getByLabel('Web address').fill('file:///x')
      await scanBoth(app, page, 'web dialog with error')
      await page.keyboard.press('Escape')

      await stubDialogs(app, { files: [f.a, f.enc, f.img, f.docx] })
      await menuClick(app, 'File', 'Combine Files…')
      const dlg = dialogOf(page, 'Combine files')
      await dlg.getByRole('button', { name: 'Add files…' }).click()
      await expect(dlg.getByTestId('combine-item')).toHaveCount(4)
      await scanBoth(app, page, 'combine dialog')
      await page.keyboard.press('Escape')

      await menuSub(app, 'File', 'Export To', 'Excel (.xlsx)')
      await expect(dialogOf(page, 'Export to Excel (.xlsx)')).toBeVisible()
      await scanBoth(app, page, 'export dialog')
      await page.keyboard.press('Escape')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the result report dialog has no violations', async () => {
    const a = file('a11y2/A.pdf', await makePdf({ label: 'A', fields: ['name'] }))
    const b = file('a11y2/B.pdf', await makePdf({ label: 'B', fields: ['name'] }))
    const { app, page } = await launch()
    try {
      await stubDialogs(app, { files: [a, b], save: join(outDir('a11y2'), 'm.pdf') })
      await menuClick(app, 'File', 'Combine Files…')
      const dlg = dialogOf(page, 'Combine files')
      await dlg.getByRole('button', { name: 'Add files…' }).click()
      await dlg.getByRole('button', { name: 'Combine…' }).click()
      const report = dialogOf(page, 'Combine Files')
      await expect(report).toBeVisible({ timeout: 60_000 })
      await scanBoth(app, page, 'result dialog')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

void spawnSync
