import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Reads PDFs back with PDF.js (legacy build, runs in Node) so tests can assert on what a real reader extracts. */

export interface TextItem {
  str: string
  /** Advance width of the item in points. */
  w: number
  x: number
  y: number
  size: number
  font: string
}

export interface PdfPageText {
  width: number
  height: number
  items: TextItem[]
  /** Text in reading order: items grouped into lines by y, lines top to bottom, left to right. */
  text: string
  fontNames: string[]
  imageCount: number
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null
const loadPdfjs = (): Promise<typeof import('pdfjs-dist')> => {
  pdfjsPromise ??= import(/* @vite-ignore */ pathToFileURL(resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href) as Promise<typeof import('pdfjs-dist')>
  return pdfjsPromise
}

export async function readPdf(bytes: Uint8Array): Promise<{ pages: PdfPageText[]; embeddedFonts: string[] }> {
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts').replace(/\\/g, '/') + '/',
    useSystemFonts: false
  })
  const doc = await task.promise
  const pages: PdfPageText[] = []
  const embedded = new Set<string>()
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const ol = await page.getOperatorList()
    let imageCount = 0
    for (const fn of ol.fnArray) if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) imageCount++
    const fontNames = new Set<string>()
    const items: TextItem[] = []
    for (const it of tc.items as { str: string; transform: number[]; fontName: string; height: number; width: number }[]) {
      if (!('str' in it)) continue
      const font = (await new Promise<{ name?: string } | undefined>((res) => page.commonObjs.get(it.fontName, res)))?.name ?? it.fontName
      fontNames.add(font)
      embedded.add(font)
      items.push({ str: it.str, w: it.width, x: it.transform[4], y: vp.height - it.transform[5], size: Math.hypot(it.transform[2], it.transform[3]), font })
    }
    // group into lines
    const sorted = [...items].filter((t) => t.str.length > 0).sort((a, b) => a.y - b.y || a.x - b.x)
    const lines: TextItem[][] = []
    for (const it of sorted) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(last[0].y - it.y) < Math.max(2, it.size * 0.4)) last.push(it)
      else lines.push([it])
    }
    const text = lines.map((l) => l.sort((a, b) => a.x - b.x).map((t) => t.str).join('')).join('\n')
    pages.push({ width: vp.width, height: vp.height, items, text, fontNames: [...fontNames], imageCount })
    page.cleanup()
  }
  await task.destroy()
  return { pages, embeddedFonts: [...embedded] }
}

/** All text of a PDF with whitespace collapsed, for "no text lost" assertions. */
export const flattenText = (pages: PdfPageText[]): string => pages.map((p) => p.text).join('\n').replace(/\s+/g, ' ').trim()
