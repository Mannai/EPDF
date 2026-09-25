import { readFile } from 'node:fs/promises'
import { mergePdfs, probePdf } from '../combine/merge'
import { addImageToPdf, imagesToPdf, type ImageOptions } from './images'
import { convertOffice } from './office'
import { PDFDocument } from 'pdf-lib'

/**
 * Heavy operations that run in a worker thread (see worker.ts) so the Electron main process never blocks:
 * probing files, image/TIFF -> PDF, the built-in Office converter and the PDF merge. The same functions are
 * called directly by unit tests.
 */

export type Report = (fraction: number, message?: string) => void

export type WorkerRequest =
  | { op: 'probe'; files: { path: string; name: string }[] }
  | { op: 'images'; files: { path: string; name: string }[]; options: ImageOptions }
  | { op: 'imageBytes'; name: string; bytes: Uint8Array; options: ImageOptions }
  | { op: 'office'; path: string; name: string; fontsDir: string; page?: { width: number; height: number } }
  | { op: 'merge'; items: { name: string; path?: string; bytes?: Uint8Array; range?: string }[]; bookmarks: boolean }
  | { op: 'pageCount'; bytes: Uint8Array }

export interface PdfResult {
  bytes: Uint8Array
  pages: number
  warnings: string[]
}

export type ProbeResult = ({ pages: number } | { problem: string })[]

export async function runOp(req: Extract<WorkerRequest, { op: 'probe' }>, report?: Report): Promise<ProbeResult>
export async function runOp(req: Exclude<WorkerRequest, { op: 'probe' }>, report?: Report): Promise<PdfResult>
export async function runOp(req: WorkerRequest, report: Report = () => undefined): Promise<ProbeResult | PdfResult> {
  switch (req.op) {
    case 'probe': {
      const out: ProbeResult = []
      for (let i = 0; i < req.files.length; i++) {
        report(i / req.files.length)
        const f = req.files[i]
        out.push(await probePdf(f.name, new Uint8Array(await readFile(f.path))))
      }
      return out
    }
    case 'images': {
      const inputs = []
      for (const f of req.files) inputs.push({ name: f.name, bytes: new Uint8Array(await readFile(f.path)) })
      const r = await imagesToPdf(inputs, req.options, report)
      return { ...r, warnings: [] }
    }
    case 'imageBytes': {
      const pdf = await PDFDocument.create()
      const pages = await addImageToPdf(pdf, req.name, req.bytes, req.options)
      pdf.setProducer('Epdf')
      return { bytes: await pdf.save(), pages, warnings: [] }
    }
    case 'office': {
      const bytes = new Uint8Array(await readFile(req.path))
      const r = await convertOffice({ name: req.name, bytes }, { fontsDir: req.fontsDir, page: req.page, onProgress: report })
      return { bytes: r.bytes, pages: r.pages, warnings: r.warnings }
    }
    case 'merge': {
      const inputs = []
      for (const it of req.items) {
        const bytes = it.bytes ?? new Uint8Array(await readFile(it.path!))
        inputs.push({ name: it.name, bytes, rangeText: it.range })
      }
      const r = await mergePdfs(inputs, { bookmarks: req.bookmarks }, report)
      const warnings = r.renamedFields.map((f) => `Form field “${f.from}” in “${f.file}” was renamed to “${f.to}” because another file already used that name.`)
      return { bytes: r.bytes, pages: r.pageCount, warnings }
    }
    case 'pageCount': {
      const d = await PDFDocument.load(req.bytes, { updateMetadata: false })
      return { bytes: new Uint8Array(0), pages: d.getPageCount(), warnings: [] }
    }
  }
}
