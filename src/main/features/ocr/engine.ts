import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { OcrLine, OcrPageResult } from '../../../shared/features/ocr'

/**
 * The recognition engine: `tesseract.js` (WASM Tesseract, Apache-2.0) bundled with the app. Each Tesseract
 * worker is a `worker_threads` thread that tesseract.js itself spawns, so recognition never runs on the main
 * process' event loop. The engine never touches the network: languages are read from a local folder.
 */

export interface EngineOptions {
  /** Folder holding `<code>.traineddata` for every requested language. */
  langPath: string
  languages: string[]
  /** Number of parallel Tesseract workers (each holds one copy of the models in memory). */
  workers: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tess = any

/** Path of tesseract.js' Node worker script. Inside a packaged app it lives in the unpacked asar folder. */
export function tesseractWorkerPath(): string {
  const here = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
  const p = createRequire(here).resolve('tesseract.js/src/worker-script/node/index.js')
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

interface RawWord {
  text?: string
  confidence?: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}
interface RawLine {
  words?: RawWord[]
  bbox: { x0: number; y0: number; x1: number; y1: number }
  baseline?: { x0: number; y0: number; x1: number; y1: number; has_baseline?: boolean } | null
  rowAttributes?: { rowHeight?: number }
}

/** Converts Tesseract's block tree into flat lines of words. */
export function linesFromBlocks(blocks: unknown): OcrLine[] {
  const out: OcrLine[] = []
  for (const block of (blocks ?? []) as { paragraphs?: { lines?: RawLine[] }[] }[]) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const words = (line.words ?? [])
          .filter((w) => typeof w.text === 'string' && w.text.trim() !== '')
          .map((w) => ({ text: (w.text as string).trim(), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: Math.max(0, Math.min(100, w.confidence ?? 0)) }))
        if (!words.length) continue
        const b = line.baseline
        const usable = !!b && b.has_baseline !== false && Number.isFinite(b.x0 + b.y0 + b.x1 + b.y1) && b.x1 !== b.x0
        out.push({
          words,
          baseline: usable ? { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : null,
          rowHeight: Math.max(0, line.rowAttributes?.rowHeight ?? 0),
          bbox: { ...line.bbox }
        })
      }
    }
  }
  return out
}

export class OcrEngine {
  private terminated = false

  private constructor(
    private scheduler: Tess,
    readonly size: number
  ) {}

  static async create(opts: EngineOptions): Promise<OcrEngine> {
    const mod = (await import('tesseract.js')) as Tess
    const T = mod.default ?? mod
    const scheduler = T.createScheduler()
    const workerPath = tesseractWorkerPath()
    const workers: Tess[] = []
    try {
      for (let i = 0; i < opts.workers; i++) {
        const w = await T.createWorker(opts.languages, T.OEM?.LSTM_ONLY ?? 1, {
          langPath: opts.langPath,
          workerPath,
          gzip: false,
          cacheMethod: 'none', // never write into a cache; never look one up
          workerBlobURL: false,
          // Without a handler tesseract.js *throws* on a bad image from inside its message callback.
          errorHandler: () => undefined,
          logger: () => undefined
        })
        workers.push(w)
        scheduler.addWorker(w)
      }
    } catch (err) {
      await Promise.allSettled(workers.map((w) => w.terminate()))
      throw new Error(`The text recognition engine could not start: ${err instanceof Error ? err.message : String(err)}`)
    }
    return new OcrEngine(scheduler, workers.length)
  }

  /** Recognizes one page picture (PNG/JPEG/BMP bytes). Failures are reported per page, not thrown. */
  async recognize(image: Uint8Array): Promise<OcrPageResult> {
    if (this.terminated) throw new Error('Cancelled')
    try {
      const res = await this.scheduler.addJob('recognize', Buffer.from(image.buffer, image.byteOffset, image.byteLength), {}, { blocks: true, text: false })
      if (this.terminated) throw new Error('Cancelled')
      const data = res.data
      const lines = linesFromBlocks(data.blocks)
      const words = lines.flatMap((l) => l.words)
      // Picture size is not reported by Tesseract; the caller knows it. 0 marks "unknown".
      return { ok: true, lines, confidence: words.length ? words.reduce((s, w) => s + w.conf, 0) / words.length : 0, width: 0, height: 0 }
    } catch (err) {
      if (this.terminated) throw new Error('Cancelled')
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: /read image/i.test(msg) ? 'This page picture could not be read.' : `Recognition failed: ${msg}` }
    }
  }

  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    await this.scheduler.terminate().catch(() => undefined)
  }
}
