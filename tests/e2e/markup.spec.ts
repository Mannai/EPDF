import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib'
import { listLocated } from '../../src/renderer/src/features/markup/pdf/annots'
import { pdfRectToView } from '../../src/renderer/src/features/markup/pdf/geometry'
import { get, getDict, getName, getNumbers, getString } from '../../src/renderer/src/features/markup/pdf/pdfobj'
import { readAnnotations } from '../../src/renderer/src/features/markup/pdf/read'
import { axeViolations, copyFixture, gotoPage, launch, quitDiscarding } from './helpers'

const PW = 612
const PH = 792

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/markup.mjs', resolve('test-results/fixtures')], { stdio: 'inherit' })
})

// ---------------------------------------------------------------- helpers

const dot = (page: Page): Locator => page.getByTestId('unsaved-dot')
const undoButton = (page: Page, label: string): Locator => page.getByRole('button', { name: `Undo ${label}` })
const redoButton = (page: Page, label: string): Locator => page.getByRole('button', { name: `Redo ${label}` })
const tool = (page: Page, name: string): Locator => page.getByRole('toolbar', { name: 'Editing tools' }).getByRole('button', { name, exact: true })

/** Activates the Select tool and waits until the page overlay has read the document's annotations. */
async function selectTool(page: Page): Promise<void> {
  await tool(page, 'Select').click()
  await expect(page.locator('[data-testid="markup-select-layer"][data-ready="true"]').first()).toBeAttached()
}

async function openMarkup(file = 'markup.pdf', opts: Parameters<typeof launch>[0] = {}) {
  const path = copyFixture(file)
  const launched = await launch({ files: [path], ...opts })
  const { app, page } = launched
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  await expect(page.locator('[data-page="1"] .textLayer span').first()).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
  await page.getByLabel('Zoom level').selectOption('fit-page')
  await page.waitForTimeout(700) // let the re-render at the new zoom settle
  return { ...launched, path }
}

const renderVersion = async (page: Page, n = 1): Promise<number> => Number(await page.locator(`[data-page="${n}"] [data-markup-page]`).getAttribute('data-render'))

/** Runs `action`, then waits until the page has been re-rendered from the edited document (so the next mouse action hits the fresh text layer). */
async function afterEdit(page: Page, action: () => Promise<void>, n = 1): Promise<void> {
  const before = await renderVersion(page, n)
  await action()
  await expect.poll(() => renderVersion(page, n)).toBeGreaterThan(before)
  await pageBox(page, n) // wait for the layout to settle too
}

type Box = { x: number; y: number; width: number; height: number }

/** The page's box once its layout has stopped moving (page sizes of a reloaded document are discovered asynchronously). */
async function pageBox(page: Page, n = 1): Promise<Box> {
  const read = async (): Promise<Box> => (await page.locator(`[data-page="${n}"]`).boundingBox())!
  let prev = await read()
  let same = 0
  for (let i = 0; i < 40 && same < 3; i++) {
    await page.waitForTimeout(100)
    const cur = await read()
    same = cur.x === prev.x && cur.y === prev.y && cur.width === prev.width && cur.height === prev.height ? same + 1 : 0
    prev = cur
  }
  return prev
}

/** Screen position of a PDF point on an unrotated 612x792 page. */
async function pdfPoint(page: Page, n: number, x: number, y: number): Promise<{ x: number; y: number }> {
  const b = await pageBox(page, n)
  return { x: b.x + (x / PW) * b.width, y: b.y + ((PH - y) / PH) * b.height }
}

async function textBox(page: Page, n: number, text: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const span = page.locator(`[data-page="${n}"] .textLayer span`, { hasText: text }).first()
  await expect(span).toBeVisible()
  // Wait until the text has stopped moving and the page has stopped re-rendering (a new tool's options can
  // change the viewport height, which re-renders the page at a new zoom and replaces the text layer).
  let prev = (await span.boundingBox())!
  let prevRender = await renderVersion(page, n)
  for (let i = 0, same = 0; i < 60 && same < 4; i++) {
    await page.waitForTimeout(100)
    const cur = (await span.boundingBox())!
    const render = await renderVersion(page, n)
    same = cur.x === prev.x && cur.y === prev.y && cur.width === prev.width && cur.height === prev.height && render === prevRender ? same + 1 : 0
    prev = cur
    prevRender = render
  }
  return prev
}

/** Drags across the text of one text-layer span (horizontally, or vertically on rotated pages). */
async function selectText(page: Page, n: number, text: string): Promise<void> {
  const b = await textBox(page, n, text)
  const vertical = b.height > b.width
  // Stop just short of the span's far edge: Chromium extends a drag that ends exactly on the edge of an
  // absolutely positioned text-layer span to the following lines.
  const from = vertical ? { x: b.x + b.width / 2, y: b.y + 2 } : { x: b.x + 2, y: b.y + b.height / 2 }
  const to = vertical ? { x: b.x + b.width / 2, y: b.y + b.height * 0.985 } : { x: b.x + b.width * 0.985, y: b.y + b.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
}

async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dot(page)).toHaveCount(0)
}

const docOnDisk = async (path: string): Promise<PDFDocument> => PDFDocument.load(readFileSync(path))
const annotsOnDisk = async (path: string) => readAnnotations(await docOnDisk(path))
const rawAnnots = async (path: string): Promise<PDFDict[]> => listLocated(await docOnDisk(path)).map((l) => l.dict)
const subtypeOf = (d: PDFDict): string => getName(d, 'Subtype')!
const apOf = (d: PDFDict): PDFRawStream => get(getDict(d, 'AP')!, 'N') as PDFRawStream
const apText = (d: PDFDict): string => new TextDecoder().decode(apOf(d).getContents())
const byType = (ds: PDFDict[], t: string): PDFDict[] => ds.filter((d) => subtypeOf(d) === t)

/** Average colour of a region of the rendered page canvas, given in fractions of the page (0..1, origin top-left). */
async function regionAvg(page: Page, n: number, f: [number, number, number, number]): Promise<[number, number, number]> {
  return page.evaluate(
    ({ n, f }) => {
      const c = document.querySelector<HTMLCanvasElement>(`[data-page="${n}"] canvas`)!
      const x = Math.max(0, Math.floor(f[0] * c.width))
      const y = Math.max(0, Math.floor(f[1] * c.height))
      const w = Math.max(1, Math.floor((f[2] - f[0]) * c.width))
      const h = Math.max(1, Math.floor((f[3] - f[1]) * c.height))
      const d = c.getContext('2d')!.getImageData(x, y, w, h).data
      let R = 0
      let G = 0
      let B = 0
      const px = d.length / 4
      for (let i = 0; i < d.length; i += 4) {
        R += d[i]
        G += d[i + 1]
        B += d[i + 2]
      }
      return [R / px, G / px, B / px] as [number, number, number]
    },
    { n, f }
  )
}

/** Region of an unrotated 612x792 page in PDF points → fractions of the canvas. */
const ptsRegion = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [x0 / PW, (PH - y1) / PH, x1 / PW, (PH - y0) / PH]

/** Raw RGBA pixels of a region (fractions of the page canvas), for counting how many pixels a mark changed. */
async function regionPixels(page: Page, n: number, f: [number, number, number, number]): Promise<number[]> {
  return page.evaluate(
    ({ n, f }) => {
      const c = document.querySelector<HTMLCanvasElement>(`[data-page="${n}"] canvas`)!
      const x = Math.max(0, Math.floor(f[0] * c.width))
      const y = Math.max(0, Math.floor(f[1] * c.height))
      const w = Math.max(1, Math.floor((f[2] - f[0]) * c.width))
      const h = Math.max(1, Math.floor((f[3] - f[1]) * c.height))
      return Array.from(c.getContext('2d')!.getImageData(x, y, w, h).data)
    },
    { n, f }
  )
}

/** Number of pixels that differ clearly between two renderings of the same region. */
const changedPixels = (a: number[], b: number[]): number => {
  let n = 0
  for (let i = 0; i + 3 < Math.min(a.length, b.length); i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++
  }
  return n
}

const distance = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

async function openComments(page: Page): Promise<void> {
  if ((await page.getByTestId('comments-panel').count()) === 0) await page.keyboard.press('Control+Alt+m')
  await expect(page.getByTestId('comments-panel')).toBeVisible()
}

const count = (page: Page): Locator => page.getByTestId('comment-count')
const rows = (page: Page): Locator => page.locator('[data-thread]')

/** A solid-colour PNG (no external dependency): signature + IHDR + IDAT + IEND. */
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
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
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function stubOpenDialog(app: ElectronApplication, result: { canceled: boolean; filePaths: string[] }): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    ;(dialog as unknown as { showOpenDialog: () => Promise<unknown> }).showOpenDialog = () => Promise.resolve(r)
  }, result)
}

// ---------------------------------------------------------------- tests

test.describe('markup: text markup', () => {
  test('highlight, underline, strikethrough and squiggly on selected text are saved as standard annotations that render', async () => {
    const { app, page, path } = await openMarkup()
    try {
      // The tools live in the Comment group of the ribbon.
      await expect(page.getByRole('group', { name: 'Comment' }).getByRole('button')).toHaveCount(13)
      const region = (y: number): [number, number, number, number] => ptsRegion(72, y - 6, 330, y + 18)
      const before = await regionAvg(page, 1, region(700))

      await tool(page, 'Highlight').click()
      await afterEdit(page, () => selectText(page, 1, 'Epdf markup fixture line one'))
      await expect(undoButton(page, 'Add highlight')).toBeEnabled()
      await expect(page.getByRole('status').filter({ hasText: 'Highlight added on page 1' })).toBeAttached()

      await tool(page, 'Underline').click()
      await afterEdit(page, () => selectText(page, 1, 'Second line for underline'))
      await expect(undoButton(page, 'Add underline')).toBeEnabled()

      await tool(page, 'Strikethrough').click()
      await afterEdit(page, () => selectText(page, 1, 'Third line for strikethrough'))
      await expect(undoButton(page, 'Add strikethrough')).toBeEnabled()

      await tool(page, 'Squiggly').click()
      await afterEdit(page, () => selectText(page, 1, 'Fourth line squiggly text'))
      await expect(undoButton(page, 'Add squiggly underline')).toBeEnabled()

      // The highlight is painted on the page canvas (yellow multiplies over the white paper).
      await expect.poll(async () => distance(await regionAvg(page, 1, region(700)), before)).toBeGreaterThan(20)

      await save(page)
      const annots = await annotsOnDisk(path)
      expect(annots.map((a) => a.subtype)).toEqual(['Highlight', 'Underline', 'StrikeOut', 'Squiggly'])
      for (const d of await rawAnnots(path)) {
        expect(getNumbers(d, 'QuadPoints')!.length).toBe(8) // exactly one line each
        expect(getString(d, 'T')).toBe(userInfo().username)
        expect(getString(d, 'M')).toMatch(/^D:\d{14}/)
        expect(getString(d, 'NM')).toMatch(/^epdf-/)
        expect(apText(d).length).toBeGreaterThan(10)
      }
      // The quads sit over the words of line one (y=700, x from 72).
      const hl = annots[0]
      expect(hl.rect[0]).toBeGreaterThan(65)
      expect(hl.rect[0]).toBeLessThan(80)
      expect(hl.rect[2]).toBeGreaterThan(250)
      expect(hl.rect[1]).toBeLessThan(703)
      expect(hl.rect[3]).toBeGreaterThan(703)
    } finally {
      await quitDiscarding(app, page)
    }

    // Reopen the saved file: the marks are drawn by PDF.js from the appearance streams.
    const again = await launch({ files: [path] })
    const base = await launch({ files: [copyFixture('markup.pdf')] })
    try {
      for (const l of [again, base]) {
        await expect(l.page.locator('[data-page="1"] canvas')).toBeVisible()
        await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
        await l.page.getByLabel('Zoom level').selectOption('fit-page')
        await pageBox(l.page) // wait for the layout to settle
      }
      for (const y of [700, 660, 620, 580]) {
        const region = ptsRegion(72, y - 6, 330, y + 18)
        const changed = changedPixels(await regionPixels(again.page, 1, region), await regionPixels(base.page, 1, region))
        expect(changed, `mark at y=${y} changes the rendering`).toBeGreaterThan(40) // a thin line still changes dozens of pixels
      }
    } finally {
      await quitDiscarding(again.app, again.page)
      await quitDiscarding(base.app, base.page)
    }
  })

  test('with no selection nothing is created; a selection made earlier is marked up by the tool shortcut', async () => {
    const { app, page } = await openMarkup()
    try {
      await tool(page, 'Highlight').click()
      // A plain click / drag over empty paper selects no text: no edit.
      const p = await pdfPoint(page, 1, 300, 200)
      await drag(page, p, { x: p.x + 60, y: p.y + 20 })
      await page.waitForTimeout(400)
      await expect(dot(page)).toHaveCount(0)
      await page.keyboard.press('Escape') // leaves the tool

      // Select text with no tool active, then press the shortcut: it applies at once.
      await selectText(page, 1, 'Fifth line for a sticky note')
      await afterEdit(page, () => page.keyboard.press('h'))
      await expect(undoButton(page, 'Add highlight')).toBeEnabled()
      // No tool is active afterwards (the shortcut marked the selection instead of toggling the tool).
      await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'false')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('markup: notes, text boxes, drawings, shapes and stamps', () => {
  test('every annotation type is created from the UI, is undoable, saved with a proper appearance and renders after reopening', async () => {
    const { app, page, path } = await openMarkup()
    const png = join(mkdtempSync(join(tmpdir(), 'epdf-stamp-')), 'logo.png')
    writeFileSync(png, makePng(16, 8, [0, 160, 0]))
    try {
      await openComments(page)
      await expect(count(page)).toHaveText('0 comments')
      let n = 0
      const added = async (label: string): Promise<void> => {
        n++
        await expect(undoButton(page, label)).toBeEnabled()
        await expect(count(page)).toHaveText(`${n} ${n === 1 ? 'comment' : 'comments'}`)
      }

      // Sticky note: click, type in the popup editor, Enter.
      await tool(page, 'Sticky note').click()
      await afterEdit(page, async () => {
        const at = await pdfPoint(page, 1, 500, 700)
        await page.mouse.click(at.x, at.y)
        const editor = page.getByRole('dialog', { name: 'New sticky note' })
        await expect(editor).toBeVisible()
        await editor.getByLabel('Note text').fill('Check this figure')
        await editor.getByRole('button', { name: 'Add note' }).click()
      })
      await added('Add sticky note')

      // Text box: drag a rectangle, type, Ctrl+Enter.
      await tool(page, 'Text box').click()
      await afterEdit(page, async () => {
        await drag(page, await pdfPoint(page, 1, 72, 490), await pdfPoint(page, 1, 250, 440))
        const box = page.getByLabel('Text box text')
        await expect(box).toBeVisible()
        await box.fill('Typed text box content that must wrap inside the box')
        await box.press('Control+Enter')
      })
      await added('Add text box')

      // Freehand drawing with several points.
      await tool(page, 'Draw').click()
      await afterEdit(page, async () => {
        const pts = [
          [300, 480],
          [330, 440],
          [360, 470],
          [390, 430],
          [420, 470],
          [450, 440]
        ]
        const first = await pdfPoint(page, 1, pts[0][0], pts[0][1])
        await page.mouse.move(first.x, first.y)
        await page.mouse.down()
        for (const [x, y] of pts.slice(1)) {
          const p = await pdfPoint(page, 1, x, y)
          await page.mouse.move(p.x, p.y, { steps: 5 })
        }
        await page.mouse.up()
      })
      await added('Add drawing')

      const drawShape = async (name: string, label: string, a: [number, number], b: [number, number]): Promise<void> => {
        await tool(page, name).click()
        await afterEdit(page, async () => drag(page, await pdfPoint(page, 1, a[0], a[1]), await pdfPoint(page, 1, b[0], b[1])))
        await added(label)
      }
      await drawShape('Rectangle', 'Add rectangle', [72, 380], [180, 320])
      await drawShape('Ellipse', 'Add ellipse', [200, 380], [300, 320])
      await drawShape('Line', 'Add line', [320, 380], [420, 340])
      await drawShape('Arrow', 'Add arrow', [440, 380], [540, 330])

      // Built-in stamp: pick one, click.
      await tool(page, 'Stamp').click()
      await page.getByRole('combobox', { name: 'Stamp' }).selectOption('Confidential')
      await afterEdit(page, async () => {
        const at = await pdfPoint(page, 1, 150, 240)
        await page.mouse.click(at.x, at.y)
      })
      await added('Add stamp')

      // Custom image stamp through the native dialog (stubbed here; the renderer never supplies a path).
      await stubOpenDialog(app, { canceled: false, filePaths: [png] })
      await page.getByRole('button', { name: 'Choose image…' }).click()
      await expect(page.getByRole('combobox', { name: 'Stamp' })).toHaveValue('__custom')
      await afterEdit(page, async () => {
        const at = await pdfPoint(page, 1, 400, 240)
        await page.mouse.click(at.x, at.y)
      })
      await added('Add stamp')
      await expect(rows(page)).toHaveCount(n)

      // Every step is one undo step: undo all, then redo all.
      const labels = ['Add stamp', 'Add stamp', 'Add arrow', 'Add line', 'Add ellipse', 'Add rectangle', 'Add drawing', 'Add text box', 'Add sticky note']
      for (const label of labels) {
        await undoButton(page, label).click()
        n--
        await expect(count(page)).toHaveText(`${n} ${n === 1 ? 'comment' : 'comments'}`)
      }
      await expect(dot(page)).toHaveCount(0) // back at the on-disk state
      for (const label of [...labels].reverse()) {
        await redoButton(page, label).click()
        n++
        await expect(count(page)).toHaveText(`${n} ${n === 1 ? 'comment' : 'comments'}`)
      }
      expect(n).toBe(9)

      await save(page)
      const raws = await rawAnnots(path)
      expect(raws.map(subtypeOf)).toEqual(['Text', 'FreeText', 'Ink', 'Square', 'Circle', 'Line', 'Line', 'Stamp', 'Stamp'])

      const [note] = byType(raws, 'Text')
      expect(getString(note, 'Contents')).toBe('Check this figure')
      expect(getName(note, 'Name')).toBe('Note')
      const [box] = byType(raws, 'FreeText')
      expect(getString(box, 'Contents')).toBe('Typed text box content that must wrap inside the box')
      expect(getString(box, 'DA')).toMatch(/\/Helv 12 Tf/)
      expect((apText(box).match(/ Tj/g) ?? []).length).toBeGreaterThan(1)
      const [ink] = byType(raws, 'Ink')
      const list = ink.lookup(PDFName.of('InkList')) as PDFArray
      expect(list.size()).toBe(1)
      expect((list.lookup(0, PDFArray).size())).toBeGreaterThan(10) // smoothed: more points than the 6 corners
      const lines = byType(raws, 'Line')
      expect(getNumbers(lines[0], 'L')!.length).toBe(4)
      const les = (d: PDFDict): string[] => (d.lookup(PDFName.of('LE')) as PDFArray).asArray().map((o) => (o as PDFName).decodeText())
      expect(les(lines[0])).toEqual(['None', 'None'])
      expect(les(lines[1])).toEqual(['None', 'OpenArrow'])
      const stamps = byType(raws, 'Stamp')
      expect(getName(stamps[0], 'Name')).toBe('Confidential')
      expect(apText(stamps[0])).toMatch(/\/HelvB/)
      expect(getName(stamps[1], 'Name')).toBe('Image')
      expect(apText(stamps[1])).toContain('/Im0 Do')
      for (const d of raws) {
        expect(getString(d, 'T')).toBe(userInfo().username)
        expect(getNumbers(d, 'Rect')!.every(Number.isFinite)).toBe(true)
        expect(getNumbers(apOf(d).dict, 'BBox')).toHaveLength(4)
      }
    } finally {
      await quitDiscarding(app, page)
    }

    // After reopening, PDF.js paints every one of them from its appearance stream.
    const again = await launch({ files: [path] })
    const base = await launch({ files: [copyFixture('markup.pdf')] })
    try {
      for (const l of [again, base]) {
        await expect(l.page.locator('[data-page="1"] canvas')).toBeVisible()
        await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
        await l.page.getByLabel('Zoom level').selectOption('fit-page')
        await pageBox(l.page) // wait for the layout to settle
      }
      const regions: [string, [number, number, number, number]][] = [
        ['sticky note', ptsRegion(488, 686, 512, 714)],
        ['text box', ptsRegion(72, 430, 250, 490)],
        ['drawing', ptsRegion(300, 425, 450, 485)],
        ['rectangle', ptsRegion(72, 318, 180, 382)],
        ['ellipse', ptsRegion(200, 318, 300, 382)],
        ['line', ptsRegion(320, 338, 420, 382)],
        ['arrow', ptsRegion(440, 326, 545, 384)],
        ['stamp', ptsRegion(80, 215, 220, 265)],
        ['image stamp', ptsRegion(350, 225, 450, 255)]
      ]
      for (const [name, r] of regions) {
        const changed = changedPixels(await regionPixels(again.page, 1, r), await regionPixels(base.page, 1, r))
        expect(changed, `${name} changes the rendering`).toBeGreaterThan(20)
      }
      // The image stamp is green.
      const [R, G, B] = await regionAvg(again.page, 1, ptsRegion(360, 232, 440, 248))
      expect(G).toBeGreaterThan(R + 20)
      expect(G).toBeGreaterThan(B + 20)
    } finally {
      await quitDiscarding(again.app, again.page)
      await quitDiscarding(base.app, base.page)
    }
  })

  test('cancelled and invalid inputs create nothing: empty text box, Escape in the note editor, cancelled and bad image pick', async () => {
    const { app, page, path } = await openMarkup()
    const bad = join(mkdtempSync(join(tmpdir(), 'epdf-bad-')), 'not-an-image.png')
    writeFileSync(bad, 'this is not a png')
    try {
      await tool(page, 'Text box').click()
      await drag(page, await pdfPoint(page, 1, 72, 490), await pdfPoint(page, 1, 250, 440))
      const box = page.getByLabel('Text box text')
      await expect(box).toBeVisible()
      await box.press('Control+Enter') // nothing typed
      await expect(box).toHaveCount(0)

      await tool(page, 'Sticky note').click()
      const at = await pdfPoint(page, 1, 400, 600)
      await page.mouse.click(at.x, at.y)
      const editor = page.getByRole('dialog', { name: 'New sticky note' })
      await editor.getByLabel('Note text').fill('discard me')
      await page.keyboard.press('Escape')
      await expect(editor).toHaveCount(0)

      await tool(page, 'Stamp').click()
      await stubOpenDialog(app, { canceled: true, filePaths: [] })
      await page.getByRole('button', { name: 'Choose image…' }).click()
      await expect(page.getByRole('combobox', { name: 'Stamp' })).not.toHaveValue('__custom')
      await stubOpenDialog(app, { canceled: false, filePaths: [bad] })
      await page.getByRole('button', { name: 'Choose image…' }).click()
      await expect(page.getByRole('alert').filter({ hasText: 'Choose a PNG or JPEG image.' })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Stamp' })).not.toHaveValue('__custom')

      await page.waitForTimeout(300)
      await expect(dot(page)).toHaveCount(0)
      expect(await annotsOnDisk(path)).toEqual([])
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the image-stamp channel takes no path from the renderer and the OS user name is offered as default author', async () => {
    const { app, page } = await openMarkup()
    try {
      const results = await page.evaluate(async () => {
        const out: Record<string, string> = {}
        const attempts: [string, () => Promise<unknown>][] = [
          ['path', () => window.epdf.call('markup:pickImage', { path: 'C:\\Windows\\win.ini' })],
          ['extra', () => window.epdf.call('markup:pickImage', { anything: 1 })],
          ['author-extra', () => window.epdf.call('markup:defaultAuthor', { x: 1 })]
        ]
        for (const [k, fn] of attempts) {
          try {
            await fn()
            out[k] = 'accepted'
          } catch {
            out[k] = 'rejected'
          }
        }
        out.author = (await window.epdf.call<string>('markup:defaultAuthor', {})) as string
        return out
      })
      expect(results.path).toBe('rejected')
      expect(results.extra).toBe('rejected')
      expect(results['author-extra']).toBe('rejected')
      expect(results.author).toBe(userInfo().username)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('markup: comments panel', () => {
  test('lists every annotation of the document with author, time and text; filters, search and click-to-select work', async () => {
    const { app, page } = await openMarkup('markup-foreign.pdf')
    try {
      await openComments(page)
      await expect(count(page)).toHaveText('5 comments') // highlight, cloud box, stamp, note (with reply), text box
      await expect(rows(page)).toHaveCount(5)
      const note = page.locator('[data-thread]', { hasText: 'Question from Alice' })
      await expect(note).toContainText('Alice')
      await expect(note).toContainText('Page 1')
      await expect(note).toContainText('2024') // the /M date, formatted in the local time zone
      await expect(note.locator('time').first()).toHaveAttribute('datetime', /^2024-01-02T/)
      // The reply is shown as part of the thread, not as its own comment.
      await expect(note).toContainText('1 reply')
      await expect(note.locator('[data-reply]')).toContainText('Bob answers')
      await expect(page.locator('[data-thread]', { hasText: 'Bob answers' })).toHaveCount(1)
      // The link on the page is not a comment.
      await expect(page.getByTestId('comments-panel')).not.toContainText('Link')

      // Filters: type, author, status, text.
      await page.getByLabel('Filter by type').selectOption('Highlight')
      await expect(rows(page)).toHaveCount(1)
      await expect(count(page)).toHaveText('1 of 5 comments')
      await page.getByLabel('Filter by type').selectOption('all')
      await page.getByLabel('Filter by author').selectOption('Carol')
      await expect(rows(page)).toHaveCount(1)
      await expect(rows(page).first()).toContainText('Draft stamp')
      await page.getByLabel('Filter by author').selectOption('Bob') // matches threads Bob replied in
      await expect(rows(page)).toHaveCount(1)
      await page.getByLabel('Filter by author').selectOption('all')
      await page.getByPlaceholder('Search comments').fill('CLOUD')
      await expect(rows(page)).toHaveCount(1)
      await page.getByPlaceholder('Search comments').fill('nothing matches this')
      await expect(page.getByTestId('comments-panel')).toContainText('No comments match these filters')
      await page.getByRole('button', { name: 'Clear filters' }).click()
      await expect(rows(page)).toHaveCount(5)
      await page.getByLabel('Filter by status').selectOption('Completed')
      await expect(rows(page)).toHaveCount(0)
      await page.getByLabel('Filter by status').selectOption('all')

      // Clicking a row selects the annotation on the page and shows its details.
      await page.getByRole('button', { name: /cloud box/ }).click()
      await expect(page.getByRole('button', { name: /cloud box/ })).toHaveAttribute('aria-current', 'true')
      await expect(page.getByTestId('markup-frame')).toBeVisible()
      await expect(page.getByTestId('comment-details')).toBeVisible()
      // Keyboard: arrows move between rows.
      await page.getByRole('button', { name: /Alice highlight/ }).focus()
      await page.keyboard.press('ArrowDown')
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-row-button'))).toBe(true)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('replies and resolve: threaded display, review-state annotations on disk, undo/redo and delete-with-confirmation', async () => {
    const { app, page, path } = await openMarkup()
    try {
      // A note created with the keyboard only: n (tool), Enter (place), type, Enter (add).
      await page.keyboard.press('n')
      await expect(tool(page, 'Sticky note')).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Enter')
      const editor = page.getByRole('dialog', { name: 'New sticky note' })
      await expect(editor).toBeVisible()
      await expect(editor.getByLabel('Note text')).toBeFocused()
      await afterEdit(page, async () => {
        await page.keyboard.type('Please review this paragraph')
        await page.keyboard.press('Enter')
      })
      await expect(undoButton(page, 'Add sticky note')).toBeEnabled()
      await page.keyboard.press('Escape')

      await openComments(page)
      const thread = rows(page).first()
      await expect(thread).toContainText('Please review this paragraph')
      await expect(thread).toContainText(userInfo().username)

      // Reply.
      await thread.getByRole('button', { name: 'Reply', exact: true }).click()
      await page.getByLabel('Reply', { exact: true }).fill('Looks fine to me')
      await page.getByRole('button', { name: 'Post reply' }).click()
      await expect(thread.locator('[data-reply]')).toContainText('Looks fine to me')
      await expect(thread).toContainText('1 reply')
      await expect(undoButton(page, 'Add reply')).toBeEnabled()
      await expect(count(page)).toHaveText('1 comment') // a reply is not a new comment

      // Edit the reply (one undo step), then put the original text back by undoing.
      await thread.getByRole('button', { name: /^Edit reply by/ }).click()
      const replyText = thread.getByLabel(/^Edit reply by/)
      await replyText.fill('Looks great to me')
      await afterEdit(page, () => replyText.press('Enter'))
      await expect(thread.locator('[data-reply]')).toContainText('Looks great to me')
      await undoButton(page, 'Edit comment').click()
      await expect(thread.locator('[data-reply]')).toContainText('Looks fine to me')

      // Resolve, then reopen.
      await thread.getByRole('button', { name: 'Resolve' }).click()
      await expect(thread.getByTestId('comment-status')).toHaveText('Completed')
      await expect(undoButton(page, 'Resolve comment')).toBeEnabled()
      await expect(thread.getByRole('button', { name: 'Reopen' })).toBeVisible()
      await page.getByLabel('Filter by status').selectOption('Completed')
      await expect(rows(page)).toHaveCount(1)
      await page.getByLabel('Filter by status').selectOption('None')
      await expect(rows(page)).toHaveCount(0)
      await page.getByLabel('Filter by status').selectOption('all')

      await save(page)
      const all = await annotsOnDisk(path)
      const parent = all.find((a) => a.subtype === 'Text' && !a.irt)!
      const reply = all.find((a) => a.contents === 'Looks fine to me')!
      const state = all.find((a) => a.stateModel === 'Review')!
      expect(reply.irt).toBe(parent.id)
      expect(reply.replyType).toBe('R')
      expect(reply.author).toBe(userInfo().username)
      expect(state.irt).toBe(parent.id)
      expect(state.state).toBe('Completed')
      const rawReply = (await rawAnnots(path)).find((d) => getString(d, 'Contents') === 'Looks fine to me')!
      expect(rawReply.get(PDFName.of('IRT'))).toBeInstanceOf(PDFRef)
      expect(getName(rawReply, 'RT')).toBe('R')

      // Undo the resolve, redo it.
      await undoButton(page, 'Resolve comment').click()
      await expect(thread.getByTestId('comment-status')).toHaveCount(0)
      await redoButton(page, 'Resolve comment').click()
      await expect(thread.getByTestId('comment-status')).toHaveText('Completed')

      // Reopen, then delete the thread: a confirmation names the replies; Cancel keeps everything.
      await thread.getByRole('button', { name: 'Reopen' }).click()
      await expect(thread.getByTestId('comment-status')).toHaveCount(0)
      await thread.locator('[data-row-button]').click()
      await page.getByTestId('comment-details').getByRole('button', { name: /Delete note/ }).click()
      const dlg = page.getByRole('dialog', { name: 'Delete this comment thread?' })
      await expect(dlg).toContainText('3 replies and status changes') // the reply, "resolved", "reopened"
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(rows(page)).toHaveCount(1)
      await page.getByTestId('comment-details').getByRole('button', { name: /Delete note/ }).click()
      await dlg.getByRole('button', { name: 'Delete thread' }).click()
      await expect(rows(page)).toHaveCount(0)
      await expect(count(page)).toHaveText('0 comments')
      await undoButton(page, 'Delete comment thread').click() // the whole thread comes back in one step
      await expect(rows(page)).toHaveCount(1)
      await expect(rows(page).first().locator('[data-reply]')).toHaveCount(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the author name is editable, remembered across launches and written into new annotations', async () => {
    const first = await openMarkup()
    const userData = first.userData
    try {
      await openComments(first.page)
      const field = first.page.getByLabel('Your name (written into new comments)')
      await expect(field).toHaveValue(userInfo().username)
      await field.fill('Ada Tester')
      await field.press('Enter')
      await first.page.keyboard.press('n')
      await first.page.keyboard.press('Enter')
      await first.page.keyboard.type('by Ada')
      await first.page.keyboard.press('Enter')
      await expect(rows(first.page)).toHaveCount(1)
      await expect(rows(first.page).first()).toContainText('Ada Tester')
      await save(first.page)
      expect((await annotsOnDisk(first.path))[0].author).toBe('Ada Tester')
    } finally {
      await quitDiscarding(first.app, first.page)
    }
    const second = await launch({ files: [copyFixture('markup.pdf')], userData })
    try {
      await expect(second.page.locator('[data-page="1"] canvas')).toBeVisible()
      await second.page.keyboard.press('Control+Alt+m')
      await expect(second.page.getByLabel('Your name (written into new comments)')).toHaveValue('Ada Tester')
    } finally {
      await quitDiscarding(second.app, second.page)
    }
  })
})

test.describe('markup: select, edit, move, resize and delete existing annotations', () => {
  test('annotations from other software can be selected, edited, moved, resized and deleted without damaging the rest; every step undoes', async () => {
    const { app, page, path } = await openMarkup('markup-foreign.pdf')
    try {
      const original = await rawAnnots(path)
      const originalStampAp = apText(byType(original, 'Stamp')[0])
      await selectTool(page)

      // Select the stamp (foreign appearance) and move it by dragging its frame.
      const stampCenter = await pdfPoint(page, 1, 360, 425)
      await page.mouse.click(stampCenter.x, stampCenter.y)
      const frame = page.getByTestId('markup-frame')
      await expect(frame).toBeVisible()
      await expect(frame).toHaveAttribute('aria-label', /Selected Stamp by Carol/)
      const fb = (await frame.boundingBox())!
      const page0 = await pageBox(page)
      await afterEdit(page, () => drag(page, { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 }, { x: fb.x + fb.width / 2 + 60, y: fb.y + fb.height / 2 + 30 }))
      await expect(undoButton(page, 'Move annotation')).toBeEnabled()
      // Compared relative to the page, which may shift a little while the reloaded document lays out.
      const moved = (await frame.boundingBox())!
      const page1 = await pageBox(page)
      expect(moved.x - page1.x - (fb.x - page0.x)).toBeGreaterThan(50)
      expect(moved.y - page1.y - (fb.y - page0.y)).toBeGreaterThan(20)

      // Resize the text box (foreign) by its south-east handle.
      const boxCenter = await pdfPoint(page, 1, 160, 320)
      await page.mouse.click(boxCenter.x, boxCenter.y)
      await expect(frame).toHaveAttribute('aria-label', /Selected Text box/)
      const handle = page.locator('[data-handle="se"]')
      await expect(handle).toBeVisible()
      await pageBox(page) // let the layout settle after the previous edit before measuring
      const hb = (await handle.boundingBox())!
      const hx = hb.x + hb.width / 2
      const hy = hb.y + hb.height / 2
      await afterEdit(page, () => drag(page, { x: hx, y: hy }, { x: hx + 50, y: hy + 20 }))
      await expect(undoButton(page, 'Resize annotation')).toBeEnabled()

      // Recolour the (foreign) highlight from the ribbon; comment text from the panel.
      const hlPoint = await pdfPoint(page, 1, 150, 708)
      await page.mouse.click(hlPoint.x, hlPoint.y)
      await expect(frame).toHaveAttribute('aria-label', /Selected Highlight by Alice/)
      const ribbon = page.getByRole('group', { name: 'Select options' })
      await afterEdit(page, () => ribbon.getByLabel('Color').fill('#00ff00'))
      await expect(undoButton(page, 'Change color')).toBeEnabled()
      // The opacity slider commits when it is released / a key press ends: one step, not one per tick.
      await afterEdit(page, () => ribbon.getByLabel('Opacity').press('ArrowLeft'))
      await expect(undoButton(page, 'Change opacity')).toBeEnabled()

      await openComments(page)
      const details = page.getByTestId('comment-details')
      await afterEdit(page, async () => {
        const text = details.getByLabel('Comment', { exact: true })
        await text.fill('')
        await text.pressSequentially('Edited by me', { delay: 15 })
        // Typing alone changes nothing: no undo step per keystroke, the document is only edited on Enter/blur.
        await page.waitForTimeout(300)
        await expect(undoButton(page, 'Change opacity')).toBeEnabled()
        await text.press('Enter')
      })
      await expect(undoButton(page, 'Edit comment')).toBeEnabled()
      await expect(page.locator('[data-thread]', { hasText: 'Edited by me' })).toHaveCount(1)
      await undoButton(page, 'Edit comment').click() // one undo step for the whole text, not one per keystroke
      await expect(undoButton(page, 'Change opacity')).toBeEnabled()
      await redoButton(page, 'Edit comment').click()
      await expect(page.locator('[data-thread]', { hasText: 'Edited by me' })).toHaveCount(1)

      // Delete the cloud box with the keyboard.
      const cloud = await pdfPoint(page, 1, 136, 440)
      await page.mouse.click(cloud.x, cloud.y)
      await expect(frame).toHaveAttribute('aria-label', /Selected Rectangle/)
      await afterEdit(page, () => page.keyboard.press('Delete'))
      await expect(undoButton(page, 'Delete rectangle')).toBeEnabled()
      await expect(count(page)).toHaveText('4 comments')
      await undoButton(page, 'Delete rectangle').click()
      await expect(count(page)).toHaveText('5 comments')
      await redoButton(page, 'Delete rectangle').click()
      await expect(count(page)).toHaveText('4 comments')
      await undoButton(page, 'Delete rectangle').click()
      await expect(count(page)).toHaveText('5 comments')

      await save(page)
      const saved = await rawAnnots(path)
      // Nothing was lost: the same annotations (plus the link) are there, in the same order.
      expect(saved.map(subtypeOf)).toEqual(original.map(subtypeOf))
      // The stamp moved and kept its foreign appearance stream untouched.
      const stamp = byType(saved, 'Stamp')[0]
      expect(getNumbers(stamp, 'Rect')![0]).toBeGreaterThan(300 + 20)
      expect(getNumbers(stamp, 'Rect')![2] - getNumbers(stamp, 'Rect')![0]).toBeCloseTo(120, 3)
      expect(apText(stamp)).toBe(originalStampAp)
      expect(getString(stamp, 'T')).toBe('Carol')
      // The text box grew; its author is unchanged.
      const freeText = byType(saved, 'FreeText')[0]
      const r = getNumbers(freeText, 'Rect')!
      expect(r[2] - r[0]).toBeGreaterThan(178 + 20)
      expect(getString(freeText, 'T')).toBe('Alice')
      // The highlight: new colour in /C and in the redrawn appearance; new comment text.
      const hl = byType(saved, 'Highlight')[0]
      expect(getNumbers(hl, 'C')).toEqual([0, 1, 0])
      expect(String(hl.lookup(PDFName.of('CA')))).toBe('0.95')
      expect(apText(hl)).toContain('0 1 0 rg')
      expect(getString(hl, 'Contents')).toBe('Edited by me')
      expect(getString(hl, 'T')).toBe('Alice')
      // The cloud square and link are untouched, byte for byte in their content.
      const square = byType(saved, 'Square')[0]
      expect(apText(square)).toBe('0 0 1 RG 2 w 73 401 126 78 re S')
      expect(byType(saved, 'Link')).toHaveLength(1)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('the selection frame is keyboard-operable: arrows move, Alt+arrows resize, Delete removes, Escape deselects', async () => {
    const { app, page, path } = await openMarkup('markup-foreign.pdf')
    try {
      await selectTool(page)
      const at = await pdfPoint(page, 1, 160, 320)
      await page.mouse.click(at.x, at.y) // the text box
      const frame = page.getByTestId('markup-frame')
      await frame.focus()
      const before = (await annotsOnDisk(path)).find((a) => a.subtype === 'FreeText')!.rect
      await afterEdit(page, () => page.keyboard.press('ArrowRight'))
      await expect(undoButton(page, 'Move annotation')).toBeEnabled()
      await afterEdit(page, () => page.keyboard.press('Shift+ArrowUp'))
      await afterEdit(page, () => page.keyboard.press('Alt+ArrowRight'))
      await expect(undoButton(page, 'Resize annotation')).toBeEnabled()
      await save(page)
      const after = (await annotsOnDisk(path)).find((a) => a.subtype === 'FreeText')!.rect
      expect(after[0]).toBeCloseTo(before[0] + 1, 3)
      expect(after[1]).toBeCloseTo(before[1] + 10, 3) // Shift+ArrowUp = 10pt up (PDF y grows upwards)
      expect(after[3]).toBeCloseTo(before[3] + 10, 3)
      expect(after[2] - after[0]).toBeCloseTo(before[2] - before[0] + 1, 3)
      await frame.focus()
      await page.keyboard.press('Escape')
      await expect(frame).toHaveCount(0)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('clicking empty paper deselects; replies and popups are not clickable on the page', async () => {
    const { app, page } = await openMarkup('markup-foreign.pdf')
    try {
      await selectTool(page)
      const hl = await pdfPoint(page, 1, 150, 708)
      await page.mouse.click(hl.x, hl.y)
      await expect(page.getByTestId('markup-frame')).toBeVisible()
      const empty = await pdfPoint(page, 1, 300, 150)
      await page.mouse.click(empty.x, empty.y)
      await expect(page.getByTestId('markup-frame')).toHaveCount(0)
      // The note (with a reply stacked on top of it) selects the note itself, not the reply.
      const note = await pdfPoint(page, 1, 462, 662)
      await page.mouse.click(note.x, note.y)
      await expect(page.getByTestId('markup-frame')).toHaveAttribute('aria-label', /Selected Note by Alice/)
    } finally {
      await quitDiscarding(app, page)
    }
  })
})

test.describe('markup: rotated pages', () => {
  test('annotations on a page with /Rotate 90 land where they are drawn and render upright', async () => {
    const { app, page, path } = await openMarkup()
    try {
      await gotoPage(page, 2)
      await expect(page.locator('[data-page="2"] .textLayer span').first()).toBeVisible()
      await page.waitForTimeout(500)
      expect((await pageBox(page, 2)).width).toBeGreaterThan((await pageBox(page, 2)).height) // displayed landscape
      // Measured when used: the layout shifts a little while page sizes of the reloaded document are discovered.
      const rotatedRect = async (fx0: number, fy0: number, fx1: number, fy1: number): Promise<[{ x: number; y: number }, { x: number; y: number }]> => {
        const b = await pageBox(page, 2)
        return [
          { x: b.x + fx0 * b.width, y: b.y + fy0 * b.height },
          { x: b.x + fx1 * b.width, y: b.y + fy1 * b.height }
        ]
      }

      // Highlight the vertical text of the rotated page.
      await tool(page, 'Highlight').click()
      await afterEdit(page, () => selectText(page, 2, 'Rotated page first line'), 2)
      await expect(undoButton(page, 'Add highlight')).toBeEnabled()
      // Regression: after an edit the reloaded document used to lay the landscape page out with page 1's
      // portrait size (the viewer's size-change counter restarted with every new document).
      await expect.poll(async () => { const b = await pageBox(page, 2); return b.width > b.height }).toBe(true)

      // Rectangle and text box drawn in the displayed (rotated) orientation.
      await tool(page, 'Rectangle').click()
      await afterEdit(
        page,
        async () => {
          const [r0, r1] = await rotatedRect(0.4, 0.45, 0.6, 0.65)
          await drag(page, r0, r1)
        },
        2
      )
      await expect(undoButton(page, 'Add rectangle')).toBeEnabled()

      await tool(page, 'Text box').click()
      await afterEdit(
        page,
        async () => {
          const [t0, t1] = await rotatedRect(0.15, 0.75, 0.55, 0.9)
          await drag(page, t0, t1)
          const ta = page.getByLabel('Text box text')
          await ta.fill('Upright on a rotated page')
          await ta.press('Control+Enter')
        },
        2
      )
      await expect(undoButton(page, 'Add text box')).toBeEnabled()
      await save(page)

      const doc = await docOnDisk(path)
      expect(doc.getPage(1).getRotation().angle).toBe(90)
      const geom = { box: [0, 0, PW, PH] as [number, number, number, number], rotation: 90 as const }
      const annots = readAnnotations(doc).filter((a) => a.pageIndex === 1)
      expect(annots.map((a) => a.subtype).sort()).toEqual(['FreeText', 'Highlight', 'Square'])
      const near = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(0.02)
      // The rectangle's rect, mapped back into the displayed page, is the rectangle that was dragged.
      const sq = annots.find((a) => a.subtype === 'Square')!
      const [vx0, vy0, vx1, vy1] = pdfRectToView(geom, sq.rect)
      near(vx0 / PH, 0.4)
      near(vy0 / PW, 0.45)
      near(vx1 / PH, 0.6)
      near(vy1 / PW, 0.65)
      // The text box is authored upright and rotated back by the appearance /Matrix.
      const ft = (await rawAnnots(path)).find((d) => subtypeOf(d) === 'FreeText')!
      expect(getNumbers(apOf(ft).dict, 'Matrix')!.slice(0, 4)).toEqual([0, 1, -1, 0])
      const ftInfo = annots.find((a) => a.subtype === 'FreeText')!
      const [fx0, fy0, fx1, fy1] = pdfRectToView(geom, ftInfo.rect)
      near(fx0 / PH, 0.15)
      near(fx1 / PH, 0.55)
      expect(fy1 / PW).toBeGreaterThan(0.85) // it may have grown downwards to fit, never upwards
      expect(fy0 / PW).toBeCloseTo(0.75, 1)
      // The text is horizontal in PDF space (it only looks vertical because of /Rotate 90), so the highlight
      // is wide and short there, and it sits on the text baseline region (y = 700, x from 72).
      const h = annots.find((a) => a.subtype === 'Highlight')!
      expect(h.rect[2] - h.rect[0]).toBeGreaterThan(150)
      expect(h.rect[3] - h.rect[1]).toBeLessThan(40)
      expect(h.rect[1]).toBeLessThan(705)
      expect(h.rect[3]).toBeGreaterThan(705)
    } finally {
      await quitDiscarding(app, page)
    }

    // Rendered after reopening: the rectangle's outline shows up where it was drawn.
    const again = await launch({ files: [path] })
    const base = await launch({ files: [copyFixture('markup.pdf')] })
    try {
      for (const l of [again, base]) {
        await expect(l.page.locator('[data-page="1"] canvas')).toBeVisible()
        await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
        await gotoPage(l.page, 2)
        await l.page.getByLabel('Zoom level').selectOption('fit-page')
        await l.page.waitForTimeout(1000)
        await expect(l.page.locator('[data-page="2"] canvas')).toBeVisible()
      }
      // Edges of the drawn rectangle (0.4..0.6 x 0.45..0.65 of the displayed page).
      const edge: [number, number, number, number] = [0.395, 0.45, 0.415, 0.65]
      expect(changedPixels(await regionPixels(again.page, 2, edge), await regionPixels(base.page, 2, edge))).toBeGreaterThan(50)
      const fill: [number, number, number, number] = [0.16, 0.76, 0.54, 0.89] // the text box
      expect(changedPixels(await regionPixels(again.page, 2, fill), await regionPixels(base.page, 2, fill))).toBeGreaterThan(50)
    } finally {
      await quitDiscarding(again.app, again.page)
      await quitDiscarding(base.app, base.page)
    }
  })
})

test.describe('markup: accessibility', () => {
  test('the ribbon options and the Comments panel have no WCAG 2.1 A/AA violations in light and dark', async () => {
    const { app, page } = await openMarkup('markup-foreign.pdf')
    try {
      const scan = async (label: string): Promise<void> => expect(await axeViolations(page, label)).toEqual([])
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light' // the OS theme of the machine running the test must not decide what "light" means
      })
      await expect(page.locator('html')).not.toHaveClass(/dark/)
      await selectTool(page)
      await openComments(page)
      await page.getByRole('button', { name: /cloud box/ }).click()
      await expect(page.getByTestId('comment-details')).toBeVisible()
      await scan('select tool + comments light')

      for (const t of ['Highlight', 'Sticky note', 'Text box', 'Draw', 'Rectangle', 'Arrow', 'Stamp']) {
        await tool(page, t).click()
        await scan(`${t} options light`)
      }
      // A reply form and filters in the panel.
      await selectTool(page)
      await rows(page).first().getByRole('button', { name: 'Reply', exact: true }).click()
      await scan('reply form light')

      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(page.locator('html')).toHaveClass(/dark/)
      await scan('reply form dark')
      for (const t of ['Highlight', 'Text box', 'Stamp', 'Select']) {
        await tool(page, t).click()
        await scan(`${t} options dark`)
      }
      await page.getByLabel('Filter by status').selectOption('Completed')
      await scan('empty filter dark')
    } finally {
      await quitDiscarding(app, page)
    }
  })
})
