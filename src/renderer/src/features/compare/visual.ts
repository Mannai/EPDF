import { AnnotationMode } from 'pdfjs-dist'
import type { LoadedDoc } from '../../pdf/docCache'
import { diffPixels, diffRegions, isVisualDifference, padToSize, type Region } from './diff/pixel'
import type { PixelRequest, PixelResponse } from './pixel.worker'
import PixelWorker from './pixel.worker?worker'

/**
 * The visual (pixel) comparison: both pages of a pair are rendered to canvas at the SAME scale (a smaller page is
 * padded with white), then compared in a Web Worker so the UI stays responsive.
 */

export interface PairImages {
  a: Uint8ClampedArray
  b: Uint8ClampedArray
  w: number
  h: number
}

async function renderPage(loaded: LoadedDoc, pageNo: number, scale: number): Promise<ImageData> {
  const page = await loaded.doc.getPage(pageNo)
  try {
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(viewport.width))
    canvas.height = Math.max(1, Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
    if (!ctx) throw new Error('A canvas could not be created.')
    await page.render({ canvasContext: ctx, canvas, viewport, background: 'rgb(255,255,255)', annotationMode: AnnotationMode.ENABLE }).promise
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    canvas.width = canvas.height = 0
    return data
  } finally {
    page.cleanup()
  }
}

const whiteImage = (w: number, h: number): ImageData => new ImageData(new Uint8ClampedArray(w * h * 4).fill(255), w, h)

/** Renders both pages of a pair at `scale` (CSS px per point) on a common canvas size. A missing page is blank. */
export async function renderPair(oldDoc: LoadedDoc, oldNo: number | null, newDoc: LoadedDoc, newNo: number | null, scale: number): Promise<PairImages> {
  const a = oldNo === null ? null : await renderPage(oldDoc, oldNo, scale)
  const b = newNo === null ? null : await renderPage(newDoc, newNo, scale)
  const w = Math.max(a?.width ?? 1, b?.width ?? 1)
  const h = Math.max(a?.height ?? 1, b?.height ?? 1)
  const ia = a ?? whiteImage(w, h)
  const ib = b ?? whiteImage(w, h)
  return { a: padToSize(ia.data, ia.width, ia.height, w, h), b: padToSize(ib.data, ib.width, ib.height, w, h), w, h }
}

export interface PixelResult {
  count: number
  total: number
  ratio: number
  mask?: Uint8Array
  regions?: Region[]
}

/** Client for the pixel worker (falls back to computing on the UI thread if workers are unavailable). */
export class PixelClient {
  private worker: Worker | null = null
  private nextId = 1
  private waiting = new Map<number, { resolve(r: PixelResult): void; reject(e: Error): void }>()

  constructor() {
    try {
      this.worker = new PixelWorker()
      this.worker.onmessage = (e: MessageEvent<PixelResponse>) => {
        const r = e.data
        const w = this.waiting.get(r.id)
        if (!w) return
        this.waiting.delete(r.id)
        if (r.error) w.reject(new Error(r.error))
        else w.resolve({ count: r.count, total: r.total, ratio: r.ratio, mask: r.mask, regions: r.regions })
      }
      this.worker.onerror = () => {
        this.worker?.terminate()
        this.worker = null
        for (const w of this.waiting.values()) w.reject(new Error('The pixel comparison worker failed.'))
        this.waiting.clear()
      }
    } catch {
      this.worker = null
    }
  }

  /** Compares two equally sized RGBA buffers. The buffers are copied unless `transfer` is set. */
  diff(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, sensitivity: number, wantMask: boolean, transfer = false): Promise<PixelResult> {
    if (!this.worker) {
      const d = diffPixels(a, b, w, h, sensitivity)
      return Promise.resolve({ count: d.count, total: d.total, ratio: d.ratio, mask: wantMask ? d.mask : undefined, regions: wantMask ? diffRegions(d.mask, w, h) : undefined })
    }
    const id = this.nextId++
    const req: PixelRequest = { id, a: transfer ? a : a.slice(), b: transfer ? b : b.slice(), w, h, sensitivity, wantMask }
    return new Promise<PixelResult>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.worker!.postMessage(req, [req.a.buffer, req.b.buffer])
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    for (const w of this.waiting.values()) w.reject(new Error('Cancelled'))
    this.waiting.clear()
  }
}

/** Scale used for the whole-document scan: 72 dpi keeps 500 pairs quick and still shows a changed word or picture. */
export const SCAN_SCALE = 1

export interface ScanProgress {
  done: number
  total: number
}

/**
 * Renders and compares every page pair that exists on both sides. Resolves with pair index -> differing pixels.
 * `shouldStop` is polled between pairs (cancel).
 */
export async function scanVisual(
  oldDoc: LoadedDoc,
  newDoc: LoadedDoc,
  pairs: { old: number | null; new: number | null }[],
  sensitivity: number,
  shouldStop: () => boolean,
  onProgress: (p: ScanProgress) => void
): Promise<Record<number, number>> {
  const client = new PixelClient()
  const out: Record<number, number> = {}
  const todo = pairs.map((p, i) => [p, i] as const).filter(([p]) => p.old !== null && p.new !== null)
  try {
    let done = 0
    for (const [p, i] of todo) {
      if (shouldStop()) break
      const img = await renderPair(oldDoc, p.old, newDoc, p.new, SCAN_SCALE)
      const r = await client.diff(img.a, img.b, img.w, img.h, sensitivity, false, true)
      out[i] = r.count
      done++
      onProgress({ done, total: todo.length })
    }
  } finally {
    client.dispose()
  }
  return out
}

export const differingPairs = (counts: Record<number, number>): number[] =>
  Object.entries(counts)
    .filter(([, c]) => isVisualDifference({ count: c }))
    .map(([i]) => Number(i))
    .sort((a, b) => a - b)
