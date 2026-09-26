import * as pdfjs from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'
import { buildPageText, needsPageModel, type PageTextModel } from '@shared/pagetext'
import '../../pdf/docCache' // configures the PDF.js worker

/** Fonts, CMaps and WASM decoders are bundled in /pdfjs (same as the viewer), so nothing is fetched. */
export const PDFJS_ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/'
}

/** Opens bytes with PDF.js (no scripting, no XFA). The caller destroys the task. */
export function openWithPdfjs(bytes: Uint8Array): pdfjs.PDFDocumentLoadingTask {
  return pdfjs.getDocument({ data: bytes.slice(), enableXfa: false, ...PDFJS_ASSETS })
}

/**
 * The page text models (logical order, glyph geometry) of the pages whose PDF.js text has right-to-left or
 * complex-script characters, for the self-check's second reader; null for every other page. Yields to the UI
 * between pages.
 */
export async function modelPageTexts(bytes: Uint8Array, pdfjsTexts: readonly string[]): Promise<(PageTextModel | null)[]> {
  if (!pdfjsTexts.some(needsPageModel)) return pdfjsTexts.map(() => null)
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const out: (PageTextModel | null)[] = []
  for (let i = 0; i < pdf.getPageCount(); i++) {
    if (!needsPageModel(pdfjsTexts[i] ?? '')) {
      out.push(null)
      continue
    }
    try {
      out.push(buildPageText(pdf, i))
    } catch {
      out.push(null)
    }
    await new Promise((r) => setTimeout(r, 0))
  }
  return out
}

/** The text PDF.js extracts from every page of `bytes` (for the independent self-check). */
export async function pdfjsPageTexts(bytes: Uint8Array): Promise<string[]> {
  const task = openWithPdfjs(bytes)
  try {
    const doc = await task.promise
    const out: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      out.push((tc.items as { str?: string }[]).map((it) => it.str ?? '').join('\n'))
      page.cleanup()
    }
    return out
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
