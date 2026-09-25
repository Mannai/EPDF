import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { currentBytes } from '../../edit/session'
import { JobCancelledError, startJob } from '../../state/jobs'
import type { PrintOutcome } from '@shared/features/print'
import { QUALITY_DPI, jobOrientation, type PrintOptions } from '@shared/features/print/options'

/**
 * The print pipeline. Rendering happens here in the renderer (PDF.js draws each page at print resolution),
 * the heavy pdf-lib work runs as a background job, and main lays the page images out and prints them.
 * Vector quality is lost when printing this way (pages are 150-300 dpi images); "Print to PDF" is
 * vector-preserving because it never rasterizes.
 */

const MAX_CANVAS_PIXELS = 32_000_000

/** Same offline assets the viewer uses (see pdf/docCache.ts), so fonts and CMaps never come from the network. */
const ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/'
}

export interface PrintProgress {
  phase: 'preparing' | 'rendering' | 'sending'
  done: number
  total: number
}

export class PrintCancelledError extends Error {
  constructor() {
    super('Printing was cancelled.')
  }
}

export interface PrintRequest {
  docId: string
  title: string
  opts: PrintOptions
  /** 0-based pages to print, in order. */
  pages: number[]
  /** Used when the file cannot be re-read with pdf-lib (password-protected): pages are drawn from this document. */
  fallbackDoc?: PDFDocumentProxy
  onProgress(p: PrintProgress): void
  signal: { cancelled: boolean }
}

async function prepare(req: PrintRequest): Promise<Uint8Array | null> {
  const bytes = await currentBytes(req.docId)
  req.onProgress({ phase: 'preparing', done: 0, total: req.pages.length })
  const job = startJob<Uint8Array>('print:prepare', { bytes, pages: req.pages, annotations: req.opts.annotations })
  const timer = setInterval(() => {
    if (req.signal.cancelled) job.cancel()
  }, 100)
  try {
    return await job.promise
  } catch (err) {
    if (err instanceof JobCancelledError) throw new PrintCancelledError()
    if (req.fallbackDoc && err instanceof Error && /password protected/i.test(err.message)) return null
    throw err
  } finally {
    clearInterval(timer)
  }
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('The page could not be encoded for printing.'))),
      'image/jpeg',
      0.92
    )
  )
}

/** Prepares, renders and prints. Resolves with what the print system reported. Throws `PrintCancelledError` on cancel. */
export async function printDocument(req: PrintRequest): Promise<PrintOutcome> {
  const prepared = await prepare(req)
  if (req.signal.cancelled) throw new PrintCancelledError()

  let doc: PDFDocumentProxy
  let owned = false
  let pageNumbers: number[]
  if (prepared) {
    doc = await pdfjs.getDocument({ data: prepared, enableXfa: false, ...ASSETS }).promise
    owned = true
    pageNumbers = req.pages.map((_, i) => i + 1)
  } else {
    doc = req.fallbackDoc!
    pageNumbers = req.pages.map((p) => p + 1)
  }
  let jobId: string | null = null
  try {
    ;({ jobId } = await window.epdf.call<{ jobId: string }>('print:begin', { pageCount: pageNumbers.length }))
    const sizes: { width: number; height: number }[] = []
    const dpiScale = QUALITY_DPI[req.opts.quality] / 72
    for (let i = 0; i < pageNumbers.length; i++) {
      if (req.signal.cancelled) throw new PrintCancelledError()
      req.onProgress({ phase: 'rendering', done: i, total: pageNumbers.length })
      const page = await doc.getPage(pageNumbers[i])
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(dpiScale, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)))
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(viewport.width))
      canvas.height = Math.max(1, Math.ceil(viewport.height))
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('Could not create a drawing surface for printing.')
      await page.render({
        canvasContext: ctx,
        canvas,
        viewport,
        intent: 'print',
        // With a prepared copy the annotations are already gone (or kept); the fallback path toggles them here.
        annotationMode: req.opts.annotations ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE,
        background: 'rgb(255,255,255)'
      }).promise
      const jpeg = await toJpeg(canvas)
      canvas.width = canvas.height = 0
      page.cleanup()
      req.onProgress({ phase: 'sending', done: i, total: pageNumbers.length })
      await window.epdf.call('print:addPage', { jobId, index: i, jpeg, widthPt: base.width, heightPt: base.height })
      sizes.push({ width: base.width, height: base.height })
      // Give the UI a chance to paint and to handle Cancel between pages.
      await new Promise((r) => setTimeout(r, 0))
    }
    if (req.signal.cancelled) throw new PrintCancelledError()
    req.onProgress({ phase: 'sending', done: pageNumbers.length, total: pageNumbers.length })
    const id = jobId
    jobId = null // main owns (and cleans up) the job from here on
    return await window.epdf.call<PrintOutcome>('print:run', {
      jobId: id,
      copies: req.opts.copies,
      scaling: req.opts.scaling,
      percent: req.opts.percent,
      orientation: jobOrientation(req.opts.orientation, sizes),
      title: req.title
    })
  } finally {
    if (jobId) void window.epdf.call('print:cancel', { jobId }).catch(() => undefined)
    if (owned) void doc.loadingTask.destroy()
  }
}
