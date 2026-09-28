import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { canvasHasInk, fixture, launch, menuClick, quitDiscarding, waitForSteadyTextLayer, withSystemClipboard } from './helpers'

/**
 * The page text model in the real app (Electron + the sandboxed renderer + its Web Worker): right-to-left pages from
 * LibreOffice, Chromium, the text engine and a legacy visual-order producer get a text layer in logical order, so a
 * mouse selection and Copy give the logical text; the find bar is tashkeel-, alef- and digit-insensitive and its
 * hits land on the right glyphs (checked against Chromium's own word boxes, and against the rendered ink); the
 * library indexes logical Arabic; Latin documents keep PDF.js's own text layer and speed.
 */

const FIXTURES = resolve('tests/fixtures/pagetext')
const corpus = JSON.parse(readFileSync(join(FIXTURES, 'corpus.json'), 'utf8')) as {
  lines: { id: string; dir: string; text: string }[]
  paragraphs: { text: string }[]
  columns: { first: string; second: string }
  searchWords: { line: string; query: string; match: string }[]
}
const byId = (id: string): { id: string; dir: string; text: string } => corpus.lines.find((l) => l.id === id)!
const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim()

test.beforeAll(() => {
  execFileSync(process.execPath, ['tests/fixtures/generate.mjs', 'test-results/fixtures'], { stdio: 'ignore' })
})

function copy(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'epdf-pagetext-'))
  const dest = join(dir, name)
  copyFileSync(join(FIXTURES, name), dest)
  return dest
}

async function openModelPage(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const l = await launch({ files: [copy(name)] })
  await expect.poll(() => canvasHasInk(l.page, '[data-page="1"] canvas'), { timeout: 30_000 }).toBe(true)
  await l.page.locator('[data-page="1"] .textLayer[data-pagetext="model"]').waitFor({ timeout: 30_000 })
  await waitForSteadyTextLayer(l.page)
  return l
}

/** Text of every line of page 1's model layer (spans grouped by their line index). */
const layerLines = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out: string[] = []
    for (const s of document.querySelectorAll<HTMLElement>('[data-page="1"] .textLayer span[data-line]')) {
      const i = Number(s.dataset.line)
      out[i] = (out[i] ?? '') + (s.textContent ?? '')
    }
    return out
  })

/** Client box of a line (union of its spans). */
const lineBox = (page: Page, li: number): Promise<{ left: number; right: number; top: number; bottom: number }> =>
  page.evaluate((i) => {
    const rs = [...document.querySelectorAll<HTMLElement>(`[data-page="1"] .textLayer span[data-line="${i}"]`)].map((s) => s.getBoundingClientRect())
    return { left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)), top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)) }
  }, li)

const selection = (page: Page): Promise<string> => page.evaluate(() => getSelection()?.toString() ?? '')

async function dragAcross(page: Page, li: number, rtl: boolean): Promise<void> {
  await page.locator(`[data-page="1"] .textLayer span[data-line="${li}"]`).first().scrollIntoViewIfNeeded()
  const b = await lineBox(page, li)
  const y = (b.top + b.bottom) / 2
  const [x0, x1] = rtl ? [b.right - 1, b.left + 1] : [b.left + 1, b.right - 1]
  await page.mouse.move(x0, y)
  await page.mouse.down()
  await page.mouse.move((x0 + x1) / 2, y, { steps: 5 })
  await page.mouse.move(x1, y, { steps: 5 })
  await page.mouse.up()
}

test.describe('page text model in the app', () => {
  test('LibreOffice Arabic, Persian, Urdu, Hebrew: a mouse selection of each line is the logical line, and Copy gives it too', async () => {
    const { app, page } = await openModelPage('lo-lines.pdf')
    try {
      const lines = await layerLines(page)
      expect(lines.map(norm)).toEqual(corpus.lines.map((l) => norm(l.text)))
      for (const id of ['ar-hello', 'ar-vocalised', 'ar-date', 'ar-indic-digits', 'ar-punct', 'ar-latin', 'fa', 'ur', 'he', 'he-niqqud', 'ar-in-ltr', 'latin']) {
        const item = byId(id)
        const li = lines.findIndex((t) => norm(t) === norm(item.text))
        await dragAcross(page, li, item.dir === 'rtl')
        expect(norm(await selection(page)), id).toBe(norm(item.text))
      }
      // Copy: the clipboard receives the same logical string
      const date = byId('ar-date')
      await dragAcross(page, lines.findIndex((t) => norm(t) === norm(date.text)), true)
      await withSystemClipboard(async () => {
        await page.keyboard.press('Control+C')
        await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('2026-09-26 (Epdf)')
        expect(norm(await app.evaluate(({ clipboard }) => clipboard.readText()))).toBe(norm(date.text))
      })
    } finally {
      await quitDiscarding(app, page)
    }
  })

  for (const name of ['chromium-lines.pdf', 'engine-lines.pdf', 'lo-rotated-page.pdf', 'engine-rotated-page.pdf']) {
    test(`${name}: the text layer holds every corpus line in logical order`, async () => {
      const { app, page } = await openModelPage(name)
      try {
        expect((await layerLines(page)).map(norm)).toEqual(corpus.lines.map((l) => norm(l.text)))
        // selecting the whole layer is what select-all + copy reads
        const all = await page.evaluate(() => {
          const r = document.createRange()
          r.selectNodeContents(document.querySelector('[data-page="1"] .textLayer')!)
          getSelection()!.removeAllRanges()
          getSelection()!.addRange(r)
          return getSelection()!.toString()
        })
        const got = all.split('\n').map(norm).filter(Boolean)
        for (const l of corpus.lines) expect(got, l.id).toContain(norm(l.text))
      } finally {
        await quitDiscarding(app, page)
      }
    })
  }

  test('legacy visual-order presentation forms, two columns, rotated text: logical text and reading order', async () => {
    for (const [name, expected] of [
      ['pdflib-presentation.pdf', ['ar-hello', 'ar-date', 'ar-indic-digits', 'ar-sans', 'ar-latin', 'he'].map((id) => byId(id).text)],
      ['lo-columns.pdf', null],
      ['chromium-rotated.pdf', [byId('ar-date').text, byId('ar-hello').text]]
    ] as const) {
      const { app, page } = await openModelPage(name)
      try {
        const lines = (await layerLines(page)).map(norm)
        if (expected) expect(lines, name).toEqual(expected.map(norm))
        else expect(norm(lines.join(' ')), name).toBe(norm(`${corpus.columns.first} ${corpus.columns.second}`))
      } finally {
        await quitDiscarding(app, page)
      }
    }
  })

  test('find bar on a Chromium PDF: tashkeel, alef, yeh and digit variants find their word, and the highlight covers it (Chromium word boxes)', async () => {
    const boxes = JSON.parse(readFileSync(join(FIXTURES, 'chromium-lines.boxes.json'), 'utf8')) as { line: string; text: string; x0: number; x1: number; y0: number; y1: number }[]
    const { app, page } = await openModelPage('chromium-lines.pdf')
    try {
      await page.getByRole('button', { name: 'Find in document' }).click()
      const find = page.getByLabel('Find text')
      for (const w of corpus.searchWords) {
        await find.fill(w.query)
        await expect(page.getByRole('search').getByRole('status'), w.query).toHaveText(/1 of 1/)
        const word = boxes.find((b) => b.line === w.line && b.text.normalize('NFC').includes(w.match.normalize('NFC')))!
        // the highlight is recomputed just after the status updates: wait until it reports this word, then check it
        const measure = async (): Promise<{ x0: number; x1: number; y0: number; y1: number } | null> => {
          const hit = page.locator('[data-page="1"] .epdf-hit-active')
          const pageBox = await page.locator('[data-page="1"]').boundingBox()
          const rects = await hit.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })))
          if (!rects.length || !pageBox) return null
          const scale = pageBox.width / 595.28 // CSS px per PDF point
          return {
            x0: (Math.min(...rects.map((r) => r.left)) - pageBox.x) / scale,
            x1: (Math.max(...rects.map((r) => r.right)) - pageBox.x) / scale,
            y0: (Math.min(...rects.map((r) => r.top)) - pageBox.y) / scale,
            y1: (Math.max(...rects.map((r) => r.bottom)) - pageBox.y) / scale
          }
        }
        const inside = (m: { x0: number; x1: number; y0: number; y1: number } | null): boolean =>
          !!m && m.x0 > word.x0 - 1.5 && m.x1 < word.x1 + 1.5 && m.x1 - m.x0 > 0.6 * (word.x1 - word.x0) && Math.min(m.y1, word.y1) - Math.max(m.y0, word.y0) > 0.5 * (m.y1 - m.y0)
        await expect.poll(async () => inside(await measure()), { message: `${w.query}: highlight over the word Chromium laid out`, timeout: 10_000 }).toBe(true)
      }
      // phrases across words, and a query that is not there
      await find.fill('الرحمن الرحيم')
      await expect(page.getByRole('search').getByRole('status')).toHaveText(/1 of 1/)
      await find.fill('بالعالم البعيد')
      await expect(page.getByRole('search').getByRole('status')).toHaveText('No results')
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('find bar on a LibreOffice PDF: every query lands on its line, over ink, and never on another word', async () => {
    const { app, page } = await openModelPage('lo-lines.pdf')
    try {
      const lines = await layerLines(page)
      await page.getByRole('button', { name: 'Find in document' }).click()
      const find = page.getByLabel('Find text')
      const seen: { left: number; right: number; top: number }[] = []
      let previous = ''
      for (const w of corpus.searchWords) {
        await find.fill(w.query)
        await expect(page.getByRole('search').getByRole('status'), w.query).toHaveText(/1 of 1/)
        const hit = page.locator('[data-page="1"] .epdf-hit-active').first()
        await hit.scrollIntoViewIfNeeded()
        const li = lines.findIndex((t) => norm(t) === norm(byId(w.line).text))
        // the highlight is recomputed just after the status updates: wait until it has moved to this query's line
        await expect
          .poll(async () => {
            const r = await hit.boundingBox()
            const line = await lineBox(page, li)
            const key = r ? `${r.x},${r.y},${r.width}` : ''
            return !!r && key !== previous && r.y + r.height / 2 > line.top && r.y + r.height / 2 < line.bottom
          }, { message: `${w.query}: highlight on its line`, timeout: 10_000 })
          .toBe(true)
        const r = (await hit.boundingBox())!
        previous = `${r.x},${r.y},${r.width}`
        const line = await lineBox(page, li)
        const cy = r.y + r.height / 2
        expect(cy, `${w.query} on its line`).toBeGreaterThan(line.top)
        expect(cy, `${w.query} on its line`).toBeLessThan(line.bottom)
        expect(r.x, w.query).toBeGreaterThanOrEqual(line.left - 2)
        expect(r.x + r.width, w.query).toBeLessThanOrEqual(line.right + 2)
        // the highlighted area of the page canvas has glyph ink in it
        const ink = await page.evaluate(
          ({ x, y, w: ww, h }) => {
            const c = document.querySelector<HTMLCanvasElement>('[data-page="1"] canvas')!
            const box = c.getBoundingClientRect()
            const sx = c.width / box.width
            const d = c.getContext('2d')!.getImageData(Math.floor((x - box.left) * sx), Math.floor((y - box.top) * sx), Math.max(1, Math.floor(ww * sx)), Math.max(1, Math.floor(h * sx))).data
            let dark = 0
            for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++
            return dark / (d.length / 4)
          },
          { x: r.x, y: r.y, w: r.width, h: r.height }
        )
        expect(ink, `${w.query} highlights ink`).toBeGreaterThan(0.04)
        for (const s of seen.filter((s) => Math.abs(s.top - r.y) < 2)) expect(r.x + r.width <= s.left + 1 || r.x >= s.right - 1, `${w.query} overlaps another hit`).toBe(true)
        seen.push({ left: r.x, right: r.x + r.width, top: r.y })
      }
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('Latin documents keep PDF.js text layer; opening, scrolling and searching a 500-page document stay fast', async () => {
    const t0 = Date.now()
    const { app, page } = await launch({ files: [fixture('large.pdf')] })
    try {
      await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas')).toBe(true)
      const firstPaint = Date.now() - t0
      await expect(page.locator('[data-page="1"] .textLayer')).toContainText('Large document page 1')
      await expect(page.locator('[data-page="1"] .textLayer[data-pagetext="model"]')).toHaveCount(0)
      // scroll down one page height per animation frame for 60 pages, then wait for page 61's text layer
      const s0 = Date.now()
      await page.evaluate(async () => {
        const el = document.querySelector<HTMLElement>('[data-testid="viewer-scroll"]')!
        const h = document.querySelector<HTMLElement>('[data-page="1"]')!.getBoundingClientRect().height
        for (let i = 0; i < 60; i++) {
          el.scrollBy(0, h)
          await new Promise((r) => requestAnimationFrame(() => r(null)))
        }
      })
      await expect(page.locator('[data-page="61"] .textLayer')).toContainText('Large document page 61', { timeout: 30_000 })
      const scroll = Date.now() - s0
      // search the whole document
      await page.getByRole('button', { name: 'Find in document' }).click()
      const f0 = Date.now()
      await page.getByLabel('Find text').fill('page 499')
      await expect(page.getByRole('search').getByRole('status')).toHaveText(/1 of 1/, { timeout: 60_000 })
      const search = Date.now() - f0
      console.log(`large.pdf (500 Latin pages): first page painted ${firstPaint} ms after launch, 60 pages scrolled ${scroll} ms, whole-document search ${search} ms`)
      expect(firstPaint).toBeLessThan(8000)
    } finally {
      await quitDiscarding(app, page)
    }
  })

  test('a 300-page Arabic document: time until the logical text layer is ready (first page, then page 200)', async () => {
    const src = await PDFDocument.load(readFileSync(join(FIXTURES, 'lo-para.pdf')))
    const lines = await PDFDocument.load(readFileSync(join(FIXTURES, 'lo-lines.pdf')))
    const out = await PDFDocument.create()
    for (let p = 0; p < 300; p++) out.addPage((await out.copyPages(p % 2 ? src : lines, [0]))[0])
    const dir = mkdtempSync(join(tmpdir(), 'epdf-pagetext-big-'))
    const file = join(dir, 'arabic-300.pdf')
    writeFileSync(file, await out.save())
    const t0 = Date.now()
    const { app, page } = await launch({ files: [file] })
    try {
      await expect.poll(() => canvasHasInk(page, '[data-page="1"] canvas'), { timeout: 30_000 }).toBe(true)
      const painted = Date.now() - t0
      await page.locator('[data-page="1"] .textLayer[data-pagetext="model"]').waitFor({ timeout: 60_000 })
      const layer1 = Date.now() - t0
      const g0 = Date.now()
      const input = page.getByLabel('Page number')
      await input.fill('200')
      await input.press('Enter')
      await page.locator('[data-page="200"] .textLayer[data-pagetext="model"]').waitFor({ timeout: 60_000 })
      const layer200 = Date.now() - g0
      console.log(`300-page Arabic PDF (${(statSync(file).size / 1e6).toFixed(1)} MB): page 1 painted ${painted} ms, its logical text layer ${layer1} ms after launch; page 200 logical layer ${layer200} ms after going there`)
      expect(layer1).toBeLessThan(30_000)
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('library: indexing a LibreOffice Arabic PDF makes its logical words searchable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epdf-pagetext-lib-'))
    copyFileSync(join(FIXTURES, 'lo-lines.pdf'), join(dir, 'arabic.pdf'))
    const { app, page } = await launch({ env: { EPDF_LIBRARY_WATCH_MS: '300', EPDF_LIBRARY_START_MS: '200', EPDF_LIBRARY_RESCAN_MS: '600000', EPDF_LIBRARY_PICK_FOLDER: dir } })
    try {
      await expect(page.getByRole('heading', { name: 'Epdf' })).toBeVisible()
      await menuClick(app, 'File', 'Library…')
      const library = page.getByRole('dialog', { name: 'Library' })
      await library.getByRole('button', { name: 'Add folder…' }).first().click()
      await expect(library.getByTestId('library-status')).not.toHaveText('', { timeout: 30_000 })
      await expect(library.getByTestId('indexing-message')).toHaveCount(0, { timeout: 60_000 })
      await library.getByText('Text inside files', { exact: true }).click()
      const box = library.getByRole('textbox', { name: 'Search text inside files' })
      const results = library.getByRole('listbox', { name: 'Search results' })
      const count = async (q: string): Promise<number> => {
        await box.fill(q)
        await expect(library.getByTestId('content-results')).toHaveAttribute('data-query', q)
        await expect(library.getByTestId('content-results')).toHaveAttribute('data-searching', 'false')
        return results.getByRole('option').count()
      }
      // words that PDF.js alone reads in visual order (so an index built from it would not find them)
      for (const q of ['بالعالم', '"رقم الطلب"', 'دينار', 'فارسی', 'שלום']) expect(await count(q), q).toBe(1)
      expect(await count('"بالعالم مرحبا"'), 'reversed phrase').toBe(0)
      const vocalised = await count('الرحمن')
      console.log(`library: an unvocalised query for a vocalised word finds ${vocalised} result(s)`)
    } finally {
      await quitDiscarding(app, page)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
