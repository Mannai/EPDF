import * as pdfjs from 'pdfjs-dist'
import { ensureTextEngine } from './actions'
import { previewBytes as build, type PreviewRequest } from './pdf/preview'

/**
 * Live preview: ./pdf/preview builds a one-page PDF with the marks applied exactly as Apply would, and PDF.js draws
 * it on a canvas here.
 */

/** Same offline assets as the viewer (fonts and CMaps never come from the network). */
const ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/'
}

let worker: pdfjs.PDFWorker | null = null
function previewWorker(): pdfjs.PDFWorker | undefined {
  try {
    if (!worker || worker.destroyed) worker = new pdfjs.PDFWorker()
    return worker
  } catch {
    return undefined
  }
}

/** Builds the one-page preview PDF. */
export function previewBytes(r: PreviewRequest): Promise<Uint8Array> {
  ensureTextEngine()
  return build(r)
}

/** Renders page 1 of `bytes` into `canvas`, fitting `maxW` x `maxH` CSS pixels. Returns the CSS size used. */
export async function renderInto(canvas: HTMLCanvasElement, bytes: Uint8Array, maxW: number, maxH: number): Promise<{ width: number; height: number }> {
  const task = pdfjs.getDocument({ data: bytes.slice(), worker: previewWorker(), enableXfa: false, ...ASSETS })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const cssScale = Math.min(maxW / base.width, maxH / base.height)
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    const vp = page.getViewport({ scale: cssScale * dpr })
    const w = Math.max(1, Math.round(vp.width))
    const h = Math.max(1, Math.round(vp.height))
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const ctx = off.getContext('2d')
    if (!ctx) throw new Error('No drawing surface for the preview.')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    await page.render({ canvasContext: ctx, canvas: off, viewport: vp, background: 'rgb(255,255,255)' }).promise
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')?.drawImage(off, 0, 0)
    off.width = off.height = 0
    const css = { width: Math.round(base.width * cssScale), height: Math.round(base.height * cssScale) }
    canvas.style.width = `${css.width}px`
    canvas.style.height = `${css.height}px`
    page.cleanup()
    return css
  } finally {
    void task.destroy()
  }
}
