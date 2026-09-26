import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { grayPng } from '../support/png'
import { CORPUS } from '../support/textCorpus'
import { inkBox, similarity, toInk, type Ink, type Similarity } from '../support/textCompare'

/**
 * Rendering vs Chromium: every corpus item is written into a PDF by the text engine (tests/unit/text-artifacts.test.ts
 * produces the files), rendered with PDF.js (canvas) in a real Electron window, and the same text is rendered with the
 * same fonts by Chromium's own text engine (DOM). The two images must match within a documented tolerance. The same
 * check FAILS for text drawn the way pdf-lib's drawText draws it (no bidi/shaping), which proves the comparison can
 * tell right from wrong.
 *
 * Tolerances (calibrated on this corpus, see docs/text-engine.md): NCC >= NCC_MIN over the ink box after a 2x box blur and
 * +-3 px shift search; ink width within 4 % (+2 px) and ink height within 12 % (+3 px).
 */

const NCC_MIN = 0.8
const NEGATIVE_NCC_MAX = 0.6
const root = resolve('.')
const OUT = resolve('test-results/text')
const RESULTS = resolve('test-results/text-engine-compare.json')
/** Merge one result into test-results/text-engine-compare.json (workers restart after a failed test, so append). */
function record(id: string, value: unknown): void {
  let all: Record<string, unknown> = {}
  try {
    all = JSON.parse(readFileSync(RESULTS, 'utf8'))
  } catch {
    // first result
  }
  all[id] = value
  mkdirSync('test-results', { recursive: true })
  writeFileSync(RESULTS, JSON.stringify(all, null, 2))
}

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // The engine is TypeScript with WebAssembly loaders: vitest writes the PDFs and reference descriptions.
  execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/unit/text-artifacts.test.ts'], { stdio: 'inherit' })
  app = await electron.launch({
    args: [resolve('tests/support/textHarness/main.cjs')],
    env: { ...process.env, EPDF_HARNESS_ROOT: root } as Record<string, string>
  })
  page = await app.firstWindow()
  await page.waitForFunction(() => (window as unknown as { __harness?: { ready: boolean } }).__harness?.ready === true, undefined, { timeout: 60_000 })
})

test.afterAll(async () => {
  await app?.close()
})

type Harness = { renderHtml(s: unknown): Promise<{ x: number; y: number; width: number; height: number }>; renderPdf(b: string): Promise<{ width: number; height: number; rgba: string }> }

async function renderReference(spec: unknown): Promise<Ink> {
  const rect = await page.evaluate((s) => (window as unknown as { __harness: Harness }).__harness.renderHtml(s), spec)
  const cap = await app.evaluate(async ({ BrowserWindow }, r) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const img = await win.webContents.capturePage(r)
    const size = img.getSize()
    return { width: size.width, height: size.height, data: img.toBitmap().toString('base64') }
  }, rect)
  const bgra = Buffer.from(cap.data, 'base64')
  const rgba = new Uint8Array(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2]!
    rgba[i + 1] = bgra[i + 1]!
    rgba[i + 2] = bgra[i]!
    rgba[i + 3] = bgra[i + 3]!
  }
  return toInk(rgba, cap.width, cap.height)
}

async function renderPdfJs(bytes: Uint8Array): Promise<Ink> {
  const b64 = Buffer.from(bytes).toString('base64')
  const r = await page.evaluate((b) => (window as unknown as { __harness: Harness }).__harness.renderPdf(b), b64)
  return toInk(Buffer.from(r.rgba, 'base64'), r.width, r.height)
}

/** Side-by-side picture (PDF.js on top, Chromium below) saved next to the artifacts for humans. */
function saveImages(name: string, a: Ink, b: Ink): void {
  const w = Math.max(a.width, b.width)
  const h = a.height + b.height + 4
  const data = new Float32Array(w * h)
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) data[y * w + x] = a.data[y * a.width + x]!
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) data[(a.height + 4 + y) * w + x] = b.data[y * b.width + x]!
  // 2x nearest-neighbour so details (marks, brackets) are visible when a human looks at the picture
  const W = w * 2
  const H = h * 2
  const big = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) big[y * W + x] = data[(y >> 1) * w + (x >> 1)]!
  mkdirSync(resolve(OUT, 'compare'), { recursive: true })
  writeFileSync(resolve(OUT, 'compare', `${name}.png`), grayPng(W, H, big))
}

async function compare(pdfName: string, specName: string): Promise<Similarity> {
  const pdf = readFileSync(resolve(OUT, `${pdfName}.pdf`))
  const spec = JSON.parse(readFileSync(resolve(OUT, `${specName}.json`), 'utf8'))
  const [a, b] = [await renderPdfJs(pdf), await renderReference(spec)]
  saveImages(pdfName === specName ? pdfName : `${pdfName}-vs-${specName}`, a, b)
  return similarity(a, b)
}

const report = (id: string, s: Similarity): string => `${id}: ncc ${s.ncc.toFixed(3)}  width ${s.a.width}/${s.b.width} (${s.widthRatio.toFixed(3)})  height ${s.a.height}/${s.b.height} (${s.heightRatio.toFixed(3)})`

for (const item of CORPUS.filter((c) => !c.noReference)) {
  test(`renders like Chromium: ${item.label} [${item.id}]`, async () => {
    const s = await compare(item.id, item.id)
    record(item.id, { ...s, label: item.label })
    console.log(report(item.id, s))
    expect(s.ncc, report(item.id, s)).toBeGreaterThanOrEqual(NCC_MIN)
    expect(Math.abs(s.a.width - s.b.width), report(item.id, s)).toBeLessThanOrEqual(s.b.width * 0.04 + 2)
    expect(Math.abs(s.a.height - s.b.height), report(item.id, s)).toBeLessThanOrEqual(s.b.height * 0.12 + 3)
  })
}

for (const item of CORPUS.filter((c) => c.noReference)) {
  test(`justified text fills its box: ${item.label} [${item.id}]`, async () => {
    const a = await renderPdfJs(readFileSync(resolve(OUT, `${item.id}.pdf`)))
    const box = inkBox(a)!
    saveImages(item.id, a, { width: 1, height: 1, data: new Float32Array(1) })
    // every line but the last spans the whole box (in px at 96/72): check the widest ink row group is the box width
    const px = (item.width! * 96) / 72
    expect(box.x1 - box.x0, `ink width ${box.x1 - box.x0}px vs box ${px}px`).toBeGreaterThan(px - 4)
    expect(box.x1 - box.x0).toBeLessThanOrEqual(px + 2)
  })
}

test.describe('the comparison has teeth (negative controls)', () => {
  test("pdf-lib's drawText with an embedded Arabic font FAILS the comparison", async () => {
    const bad = await compare('neg-pdf-lib', 'ar-plain')
    record('negative:pdf-lib-drawText', bad)
    console.log(report('negative pdf-lib drawText', bad))
    expect(bad.ncc, report('pdf-lib', bad)).toBeLessThan(NEGATIVE_NCC_MAX)
  })

  test('our own output with the wrong direction FAILS the comparison', async () => {
    const bad = await compare('neg-wrong-direction', 'mixed-rtl')
    record('negative:wrong-direction', bad)
    console.log(report('negative wrong direction', bad))
    expect(bad.ncc, report('wrong direction', bad)).toBeLessThan(NEGATIVE_NCC_MAX)
  })

  test('different text FAILS the comparison', async () => {
    const bad = await compare('neg-different-text', 'ar-plain')
    record('negative:different-text', bad)
    console.log(report('negative different text', bad))
    expect(bad.ncc, report('different text', bad)).toBeLessThan(0.75)
  })
})
