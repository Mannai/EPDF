/**
 * Renderer side of the text engine (src/shared/text): no UI. It exposes one diagnostic entry point,
 * `window.__epdfTextEngine.selfTest(text, options)`, which the end-to-end tests call to prove that the engine works inside
 * the sandboxed renderer of a built (and packaged) app: WebAssembly under the CSP, resources over the `text:resource`
 * channel, fonts subset into a PDF. It returns the PDF bytes (base64) and layout facts; nothing else in the app calls it.
 * The engine itself is imported lazily, so it costs nothing at start-up.
 */

import { PDFDocument } from 'pdf-lib'

export interface TextEngineSelfTestResult {
  /** The PDF written by the engine, base64. */
  pdf: string
  lines: number
  missing: string[]
  fonts: string[]
  ms: number
}

declare global {
  interface Window {
    __epdfTextEngine?: {
      selfTest(text: string, options?: { width?: number; size?: number; fontStack?: string[] }): Promise<TextEngineSelfTestResult>
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

window.__epdfTextEngine = {
  async selfTest(text, options = {}) {
    const t0 = performance.now()
    const [engine, { useRendererResources }] = await Promise.all([import('@shared/text'), import('@shared/text/renderer')])
    useRendererResources()
    const pdf = await PDFDocument.create()
    const width = options.width ?? 320
    const page = pdf.addPage([width + 60, 420])
    const r = await engine.drawParagraph(page, text, { x: 30, y: 390, width, size: options.size ?? 16, fontStack: options.fontStack })
    const bytes = await pdf.save()
    return {
      pdf: toBase64(bytes),
      lines: r.lineCount,
      missing: r.missing.map((m) => m.char),
      fonts: engine.embeddedFontsFor(pdf).all().map((f) => f.font.family),
      ms: performance.now() - t0
    }
  }
}
