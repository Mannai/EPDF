import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, describe, expect, it } from 'vitest'
import { PAGE_TEXT, scanPng, createScan1 } from '../fixtures/ocr.mjs'
import { OcrEngine, linesFromBlocks, tesseractWorkerPath } from '../../src/main/features/ocr/engine'
import { LanguageStore } from '../../src/main/features/ocr/languages'
import { runOcrJob } from '../../src/main/features/ocr/runJob'
import { OcrSession, SessionRegistry } from '../../src/main/features/ocr/session'
import { applyOcrLayers } from '../../src/renderer/src/features/ocr/pdf/apply'
import { normalizeRotation } from '../../src/renderer/src/features/ocr/pdf/layout'

/**
 * Real recognition in Node with the bundled WASM engine and the bundled English data (no Electron, no network):
 * the same code the app's `ocr:run` job uses.
 */

const roots: string[] = []
const tempRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'epdf-ocr-test-'))
  roots.push(d)
  return d
}
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true })
})
const store = (): LanguageStore => new LanguageStore({ bundledDir: join('resources', 'ocr'), userDir: tempRoot() })
const words = (r: { ok: boolean; lines?: { words: { text: string }[] }[] }): string[] => (r.lines ?? []).flatMap((l) => l.words.map((w) => w.text))

/** Fraction of `expected` words found in `got` (case-insensitive) */
const recall = (expected: string, got: string[]): number => {
  const have = new Set(got.map((g) => g.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')))
  const want = expected.toLowerCase().split(/\s+/)
  return want.filter((w) => have.has(w)).length / want.length
}

describe('tesseract.js engine (bundled, offline)', () => {
  it('finds the worker script of the installed package', () => {
    expect(tesseractWorkerPath()).toMatch(/tesseract\.js[\\/]src[\\/]worker-script[\\/]node[\\/]index\.js$/)
    expect(existsSync(tesseractWorkerPath())).toBe(true)
  })

  it('maps a packaged worker path into the unpacked asar folder', () => {
    // the transformation itself, on a made-up packaged path
    const p = 'C:\\Program Files\\Epdf\\resources\\app.asar\\node_modules\\tesseract.js\\src\\worker-script\\node\\index.js'
    expect(p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')).toContain('app.asar.unpacked\\node_modules')
  })

  it('recognizes a scanned page: words, boxes, baseline and confidence', async () => {
    const root = tempRoot()
    const s = store()
    await s.stageInto(join(root, 'lang'), ['eng'])
    const engine = await OcrEngine.create({ langPath: join(root, 'lang'), languages: ['eng'], workers: 1 })
    try {
      const r = await engine.recognize(scanPng(PAGE_TEXT[0]))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.lines.length).toBe(3)
      expect(recall(PAGE_TEXT[0].join(' '), words(r))).toBeGreaterThanOrEqual(0.9)
      expect(r.confidence).toBeGreaterThan(80)
      const first = r.lines[0]
      // "Invoice number 48213" starts near x=72pt = 200px, baseline near 110pt = 305px (200 dpi)
      expect(first.words[0].x0).toBeGreaterThan(190)
      expect(first.words[0].x0).toBeLessThan(215)
      expect(first.baseline).not.toBeNull()
      expect(Math.abs(first.baseline!.y0 - 305)).toBeLessThan(6)
      expect(first.rowHeight).toBeGreaterThan(30)
      expect(first.rowHeight).toBeLessThan(60)
    } finally {
      await engine.terminate()
    }
  }, 60_000)

  it('reports a page whose picture cannot be read as a failed page, not a crash, and keeps working', async () => {
    const root = tempRoot()
    await store().stageInto(join(root, 'lang'), ['eng'])
    const engine = await OcrEngine.create({ langPath: join(root, 'lang'), languages: ['eng'], workers: 1 })
    try {
      const bad = await engine.recognize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
      expect(bad).toEqual({ ok: false, error: 'This page picture could not be read.' })
      const good = await engine.recognize(scanPng(PAGE_TEXT[1]))
      expect(good.ok).toBe(true)
    } finally {
      await engine.terminate()
    }
  }, 60_000)

  it('refuses to start without the language data it was asked for', async () => {
    const root = tempRoot()
    await expect(OcrEngine.create({ langPath: root, languages: ['eng'], workers: 1 })).rejects.toThrow(/could not start/)
  }, 60_000)

  it('flattens Tesseract blocks and ignores blank words / unusable baselines', () => {
    const lines = linesFromBlocks([
      {
        paragraphs: [
          {
            lines: [
              {
                bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
                baseline: { x0: 0, y0: 9, x1: 0, y1: 9, has_baseline: true },
                rowAttributes: { rowHeight: 12 },
                words: [
                  { text: ' Hi ', confidence: 88, bbox: { x0: 0, y0: 0, x1: 5, y1: 10 } },
                  { text: '  ', confidence: 90, bbox: { x0: 6, y0: 0, x1: 7, y1: 10 } }
                ]
              },
              { bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, words: [{ text: '', confidence: 1, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] }
            ]
          }
        ]
      }
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].words).toEqual([{ text: 'Hi', x0: 0, y0: 0, x1: 5, y1: 10, conf: 88 }])
    expect(lines[0].baseline).toBeNull() // zero-length segment
    expect(lines[0].rowHeight).toBe(12)
    expect(linesFromBlocks(null)).toEqual([])
  })
})

describe('OCR job (session + workers + progress + cancel)', () => {
  it('recognizes several pages in parallel and reports progress per page', async () => {
    const session = new OcrSession(['eng'], 3)
    const progress: [number, string | undefined][] = []
    const temp = tempRoot()
    const job = runOcrJob({ session, store: store(), tempRoot: temp, workers: 2, signal: new AbortController().signal, progress: (f, m) => progress.push([f, m]) })
    const results = await Promise.all(PAGE_TEXT.map((_, i) => session.add(i, scanPng(PAGE_TEXT[i]))))
    await expect(job).resolves.toEqual({ recognized: 3 })
    results.forEach((r, i) => {
      expect(r.ok).toBe(true)
      expect(recall(PAGE_TEXT[i].join(' '), words(r))).toBeGreaterThanOrEqual(0.85)
    })
    const fractions = progress.map((p) => p[0])
    expect(fractions[fractions.length - 1]).toBe(1)
    expect(progress.some(([, m]) => /Recognized page 2 of 3/.test(m ?? ''))).toBe(true)
    expect(readdirSync(temp)).toEqual([]) // per-run folder removed
  }, 120_000)

  it('cancelling terminates the workers at once, rejects waiting pages and cleans up', async () => {
    const session = new OcrSession(['eng'], 5)
    const ac = new AbortController()
    const temp = tempRoot()
    const job = runOcrJob({ session, store: store(), tempRoot: temp, workers: 1, signal: ac.signal, progress: () => undefined })
    job.catch(() => undefined)
    const pngs = PAGE_TEXT.map((t) => scanPng(t))
    const pages = [0, 1, 2, 3, 4].map((i) => session.add(i, pngs[i % 3]))
    pages.forEach((p) => p.catch(() => undefined))
    await new Promise((r) => setTimeout(r, 250))
    const t0 = Date.now()
    ac.abort()
    await expect(job).rejects.toThrow('Cancelled')
    expect(Date.now() - t0).toBeLessThan(3000)
    // whatever had not been recognized yet is rejected (the last page cannot have been reached)
    await expect(pages[4]).rejects.toThrow('Cancelled')
    expect(readdirSync(temp)).toEqual([])
    await expect(session.add(9, new Uint8Array(1))).rejects.toThrow('Cancelled')
  }, 60_000)

  it('a missing language fails the run with a clear message and rejects waiting pages', async () => {
    const session = new OcrSession(['deu'], 1)
    const waiting = session.add(0, scanPng(PAGE_TEXT[0]))
    waiting.catch(() => undefined)
    await expect(runOcrJob({ session, store: store(), tempRoot: tempRoot(), workers: 1, signal: new AbortController().signal, progress: () => undefined })).rejects.toThrow(/German language data is not installed/)
    await expect(waiting).rejects.toThrow(/not installed/)
  })

  it('an already cancelled run does nothing', async () => {
    const ac = new AbortController()
    ac.abort()
    const session = new OcrSession(['eng'], 1)
    await expect(runOcrJob({ session, store: store(), tempRoot: tempRoot(), workers: 1, signal: ac.signal, progress: () => undefined })).rejects.toThrow('Cancelled')
  })

  it('the renderer ending the run early stops the job cleanly', async () => {
    const session = new OcrSession(['eng'], 10)
    const job = runOcrJob({ session, store: store(), tempRoot: tempRoot(), workers: 1, signal: new AbortController().signal, progress: () => undefined })
    const first = await session.add(0, scanPng(PAGE_TEXT[0]))
    expect(first.ok).toBe(true)
    session.end()
    await expect(job).resolves.toEqual({ recognized: 1 })
  }, 60_000)
})

describe('session registry', () => {
  it('creates, finds and drops sessions', () => {
    const reg = new SessionRegistry()
    const s = reg.create(['eng'], 2)
    expect(reg.get(s.id)).toBe(s)
    expect(reg.get('nope')).toBeUndefined()
    reg.drop(s.id)
    expect(reg.size).toBe(0)
  })

  it('ending a session rejects waiting pages and later additions', async () => {
    const s = new OcrSession(['eng'], 2)
    const p = s.add(0, new Uint8Array(1))
    s.end()
    await expect(p).rejects.toThrow(/ended/)
    await expect(s.add(1, new Uint8Array(1))).rejects.toThrow(/ended/)
    expect(s.isClosed).toBe(true)
  })
})

describe('end to end: scan -> recognize -> text layer -> PDF.js', () => {
  it('the recognized words are searchable in the PDF and sit on the words of the picture', async () => {
    const root = tempRoot()
    await store().stageInto(join(root, 'lang'), ['eng'])
    const engine = await OcrEngine.create({ langPath: join(root, 'lang'), languages: ['eng'], workers: 1 })
    let result
    try {
      result = await engine.recognize(scanPng(PAGE_TEXT[0]))
    } finally {
      await engine.terminate()
    }
    if (!result.ok) throw new Error(result.error)
    const pdf = await PDFDocument.load(await createScan1())
    const page = pdf.getPage(0)
    const applied = applyOcrLayers(pdf, [
      { pageIndex: 0, geometry: { view: [0, 0, 612, 792], rotate: normalizeRotation(page.getRotation().angle), width: 1700, height: 2200 }, lines: result.lines }
    ])
    expect(applied.words).toBeGreaterThanOrEqual(10)
    const out = await pdf.save()
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: out.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true })
    const doc = await task.promise
    const tc = await (await doc.getPage(1)).getTextContent()
    await task.destroy()
    const items = (tc.items as { str: string; transform: number[]; width: number }[]).filter((i) => i.str.trim())
    const text = items.map((i) => i.str).join(' ')
    expect(recall(PAGE_TEXT[0].join(' '), text.split(/\s+/))).toBeGreaterThanOrEqual(0.9)
    // first word: left edge 72pt, baseline 792 - 110pt = 682, and it is as wide as the word in the picture
    const inv = items.find((i) => /invoice/i.test(i.str))!
    expect(Math.abs(inv.transform[4] - 72)).toBeLessThan(2)
    expect(Math.abs(inv.transform[5] - 682)).toBeLessThan(3)
    expect(inv.width).toBeGreaterThan(30)
  }, 120_000)
})
