import * as pdfjs from 'pdfjs-dist'
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
