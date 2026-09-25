import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ExportFormat } from '@shared/features/export'
import { buildDocx } from './docx'
import { abortError, extractPdf } from './extract'
import type { OpsTable } from './graphics'
import { documentStats, layoutPage } from './layout'
import { DEFAULT_OPTIONS, type ExportOptions, type PageLayout } from './model'
import { buildPptx } from './pptx'
import { buildSheets, buildXlsx } from './xlsx'

export interface ExportRunOptions {
  OPS: OpsTable
  signal?: AbortSignal
  onProgress?: (fraction: number, message: string) => void
  options?: Partial<ExportOptions>
}

export interface ExportRunResult {
  bytes: Uint8Array
  warnings: string[]
  pages: number
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * PDF -> .docx/.xlsx/.pptx. Extraction reports progress per page (0..0.85) and can be cancelled through
 * `signal` at any page boundary; nothing is returned (or written) for a cancelled run.
 */
export async function exportDocument(doc: PDFDocumentProxy, format: ExportFormat, run: ExportRunOptions): Promise<ExportRunResult> {
  const options = { ...DEFAULT_OPTIONS, ...run.options }
  const { signal, onProgress } = run
  const model = await extractPdf(doc, {
    OPS: run.OPS,
    signal,
    includeImages: options.includeImages && format !== 'xlsx',
    onProgress: (f, m) => onProgress?.(f * 0.85, m)
  })
  if (signal?.aborted) throw abortError()
  onProgress?.(0.87, 'Analysing layout')
  await tick()
  // Layout page by page, yielding to the UI every few pages so a long document never freezes the window.
  const stats = documentStats(model.pages)
  const layouts: PageLayout[] = []
  for (let i = 0; i < model.pages.length; i++) {
    layouts.push(layoutPage(model.pages[i], stats))
    if (i % 8 === 7) {
      onProgress?.(0.87 + 0.05 * ((i + 1) / model.pages.length), 'Analysing layout')
      await tick()
      if (signal?.aborted) throw abortError()
    }
  }
  if (signal?.aborted) throw abortError()

  const warnings = [...model.warnings]
  if (model.pages.every((p) => p.items.length === 0)) {
    warnings.push('No selectable text was found. If this PDF is a scan, run OCR on it first; only images were exported.')
  }
  onProgress?.(0.93, `Writing ${format.toUpperCase()} file`)
  await tick()
  let bytes: Uint8Array
  if (format === 'docx') bytes = buildDocx(layouts, { title: model.title })
  else if (format === 'pptx') bytes = buildPptx(layouts, { title: model.title })
  else {
    const sheets = buildSheets(layouts, options)
    if (options.xlsxMode === 'tables' && !layouts.some((p) => p.blocks.some((b) => b.type === 'table'))) {
      warnings.push('No tables were detected, so each page became a sheet with one row per line of text.')
    }
    bytes = buildXlsx(sheets, { title: model.title })
  }
  if (signal?.aborted) throw abortError()
  onProgress?.(1, 'Done')
  return { bytes, warnings, pages: model.pages.length }
}
