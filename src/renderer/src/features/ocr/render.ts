import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { REAL_TEXT_MIN_CHARS } from '@shared/features/ocr'
import { normalizeRotation, type PageGeometry } from './pdf/layout'
import { autoContrast, estimateSkew, grayToRgba, scaleFor, shouldDeskew, toGrayscale } from './pixels'

/**
 * Turns one PDF page into the picture Tesseract reads. Pages are drawn by PDF.js one at a time (never all at
 * once), at the requested resolution but never beyond what a canvas and the recognizer can handle.
 */

/** Same offline assets the viewer uses, so fonts and CMaps never come from the network. */
const ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/'
}

export interface RenderOptions {
  dpi: number
  contrast: boolean
  deskew: boolean
}

export interface RenderedPage {
  png: Uint8Array
  geometry: PageGeometry
  deskew?: { angle: number; cx: number; cy: number }
}

export const openForOcr = (bytes: Uint8Array): Promise<PDFDocumentProxy> =>
  // PDF.js takes ownership of the buffer it is given, so it gets a copy; the edit history keeps its own.
  pdfjs.getDocument({ data: bytes.slice(), enableXfa: false, ...ASSETS }).promise

/** True when the page has extractable text (at least a few real characters), e.g. an earlier OCR layer. */
export async function pageHasText(page: PDFPageProxy): Promise<boolean> {
  const tc = await page.getTextContent()
  let n = 0
  for (const item of tc.items) {
    if ('str' in item) n += item.str.replace(/\s+/g, '').length
    if (n >= REAL_TEXT_MIN_CHARS) return true
  }
  return false
}

const toPng = (canvas: HTMLCanvasElement): Promise<Uint8Array> =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('The page picture could not be encoded.'))),
      'image/png'
    )
  )

export async function renderPage(page: PDFPageProxy, opts: RenderOptions): Promise<RenderedPage> {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: scaleFor(base.width, base.height, opts.dpi) })
  const width = Math.max(1, Math.round(viewport.width))
  const height = Math.max(1, Math.round(viewport.height))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!ctx) throw new Error('Could not create a drawing surface for text recognition.')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  await page.render({ canvasContext: ctx, canvas, viewport, intent: 'print', annotationMode: pdfjs.AnnotationMode.DISABLE, background: 'rgb(255,255,255)' }).promise

  const view = page.view as [number, number, number, number]
  const geometry: PageGeometry = { view, rotate: normalizeRotation(page.rotate), width, height }
  let deskew: RenderedPage['deskew']

  if (opts.contrast || opts.deskew) {
    const img = ctx.getImageData(0, 0, width, height)
    const gray = toGrayscale(img.data, width, height)
    if (opts.contrast) autoContrast(gray)
    let angle = 0
    if (opts.deskew) {
      const e = estimateSkew(gray, width, height)
      if (shouldDeskew(e)) angle = e.angle
    }
    img.data.set(grayToRgba(gray))
    ctx.putImageData(img, 0, 0)
    if (angle !== 0) {
      // Rotate the picture against the tilt; the layout maps recognized boxes back through `deskew`.
      const straight = document.createElement('canvas')
      straight.width = width
      straight.height = height
      const c2 = straight.getContext('2d', { alpha: false })!
      c2.fillStyle = '#fff'
      c2.fillRect(0, 0, width, height)
      c2.translate(width / 2, height / 2)
      c2.rotate(-angle)
      c2.translate(-width / 2, -height / 2)
      c2.drawImage(canvas, 0, 0)
      const png = await toPng(straight)
      straight.width = straight.height = 0
      canvas.width = canvas.height = 0
      page.cleanup()
      return { png, geometry, deskew: { angle, cx: width / 2, cy: height / 2 } }
    }
  }
  const png = await toPng(canvas)
  canvas.width = canvas.height = 0
  page.cleanup()
  return { png, geometry, deskew }
}
