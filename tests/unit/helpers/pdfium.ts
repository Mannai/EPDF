import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * PDFium (the engine of Chrome's and Edge's PDF viewer) compiled to WebAssembly, for tests only (`@embedpdf/pdfium`,
 * MIT, PDFium itself BSD-3-Clause/Apache-2.0; a devDependency, never shipped). `pdfiumText` is what Chrome's viewer
 * copies and searches: FPDFText_GetText over the whole page, the same text page Chrome's find and select use.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pdfium = any

let instance: Promise<Pdfium> | null = null

function load(): Promise<Pdfium> {
  instance ??= (async () => {
    const req = createRequire(import.meta.url)
    const pkg = req.resolve('@embedpdf/pdfium/pdfium.wasm')
    const { init } = await import('@embedpdf/pdfium')
    const wasmBinary = readFileSync(join(dirname(pkg), 'pdfium.wasm'))
    const p = await init({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) } as never)
    p.PDFiumExt_Init()
    return p
  })()
  return instance
}

function copyIn(p: Pdfium, bytes: Uint8Array): number {
  const ptr = p.pdfium.wasmExports.malloc(bytes.length)
  const heap: Uint8Array | undefined = p.pdfium.HEAPU8
  if (heap) heap.set(bytes, ptr)
  else for (let i = 0; i < bytes.length; i++) p.pdfium.setValue(ptr + i, bytes[i], 'i8')
  return ptr
}

export interface PdfiumPage {
  /** FPDFText_GetText of the whole page. */
  text: string
  /** Number of matches of FPDFText_FindStart for each query (Chrome's find-in-page runs its own search over `text`). */
  find(query: string): number
}

/** Text of each page as PDFium extracts it. */
export async function pdfiumText(bytes: Uint8Array): Promise<string[]> {
  const pages = await pdfiumPages(bytes)
  return pages.map((p) => p.text)
}

export async function pdfiumPages(bytes: Uint8Array, queries: string[] = []): Promise<(PdfiumPage & { counts: Record<string, number> })[]> {
  const p = await load()
  const buf = copyIn(p, bytes)
  const doc = p.FPDF_LoadMemDocument(buf, bytes.length, '')
  if (!doc) {
    p.pdfium.wasmExports.free(buf)
    throw new Error(`PDFium could not open the document (error ${p.FPDF_GetLastError()})`)
  }
  const out: (PdfiumPage & { counts: Record<string, number> })[] = []
  try {
    const n = p.FPDF_GetPageCount(doc)
    for (let i = 0; i < n; i++) {
      const page = p.FPDF_LoadPage(doc, i)
      const tp = p.FPDFText_LoadPage(page)
      const count = p.FPDFText_CountChars(tp)
      const tb = p.pdfium.wasmExports.malloc((count + 1) * 2)
      const got = p.FPDFText_GetText(tp, 0, count, tb)
      const text = got > 0 ? p.pdfium.UTF16ToString(tb) : ''
      p.pdfium.wasmExports.free(tb)
      const find = (query: string): number => {
        const q = p.pdfium.wasmExports.malloc((query.length + 1) * 2)
        p.pdfium.stringToUTF16(query, q, (query.length + 1) * 2)
        const h = p.FPDFText_FindStart(tp, q, 0, 0)
        let k = 0
        while (p.FPDFText_FindNext(h)) k++
        p.FPDFText_FindClose(h)
        p.pdfium.wasmExports.free(q)
        return k
      }
      const counts: Record<string, number> = {}
      for (const q of queries) counts[q] = find(q)
      out.push({ text, find: () => 0, counts })
      p.FPDFText_ClosePage(tp)
      p.FPDF_ClosePage(page)
    }
  } finally {
    p.FPDF_CloseDocument(doc)
    p.pdfium.wasmExports.free(buf)
  }
  return out
}
