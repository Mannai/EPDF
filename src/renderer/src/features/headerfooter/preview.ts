import * as pdfjs from 'pdfjs-dist'
import { PDFDocument, PDFObjectCopier, PDFRef } from 'pdf-lib'
import type { GroupSettings } from '@shared/features/headerfooter'
import { ensureTextEngine } from './actions'
import type { SourceInput } from './pdf/apply'
import { applyGroup } from './pdf/ops'

/**
 * Live preview: the chosen page is copied into a one-page document, the settings are applied to it exactly as Apply
 * would (same code, same numbering as that page of the real document), and PDF.js draws the result on a canvas.
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

export interface PreviewRequest {
  base: PDFDocument
  pageIndex: number
  gs: GroupSettings
  mode: 'replace' | 'add'
  source?: SourceInput
  fileName: string
  /** Draw the marks (false: the page as it is, e.g. outside the page range). */
  withMarks: boolean
}

/** Builds the one-page preview PDF. */
export async function previewBytes(r: PreviewRequest): Promise<Uint8Array> {
  ensureTextEngine()
  const doc = await PDFDocument.create({ updateMetadata: false })
  const [copy] = await doc.copyPages(r.base, [r.pageIndex])
  doc.addPage(copy)
  if (r.withMarks) {
    let source = r.source
    if (source && 'ref' in source) {
      // The earlier picture lives in the real document: copy it over.
      const copied = PDFObjectCopier.for(r.base.context, doc.context).copy(source.ref)
      source = copied instanceof PDFRef ? { ref: copied } : undefined
    }
    await applyGroup(doc, r.gs, { mode: r.mode, source, fileName: r.fileName, numPages: r.base.getPageCount(), only: [{ index: r.pageIndex, page: doc.getPage(0) }] })
  }
  return doc.save()
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
