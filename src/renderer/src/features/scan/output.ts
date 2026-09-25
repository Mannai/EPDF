import { PDFDocument } from 'pdf-lib'
import type { EncodedPage } from '@shared/features/scan/assemble'
import type { ScanSaveResult } from '@shared/features/scan'
import { editPdf, ensureEditable } from '../../edit/session'
import { activeTab } from '../../state/actions'
import { errorMessage, notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { getCommand, runCommand } from '../api'
import { requestOcr, type OcrDeps } from './ocr'
import { paramsFor } from './pages'
import { useScan, type QualityChoice, type ScanPage } from './store'
import { scanWorker } from './worker/client'

/** Turning the edited pages into a PDF, then saving it, opening it, or adding it to the open document. */

export const QUALITY: Record<QualityChoice, { label: string; jpeg: number; maxLong: number }> = {
  high: { label: 'High quality (larger file)', jpeg: 0.9, maxLong: 3508 },
  balanced: { label: 'Balanced', jpeg: 0.8, maxLong: 2480 },
  small: { label: 'Small file', jpeg: 0.62, maxLong: 1754 }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

export async function buildPdf(pages: ScanPage[], onProgress: (fraction: number, label: string) => void, signal: AbortSignal): Promise<Uint8Array> {
  const q = QUALITY[useScan.getState().options.quality]
  const onAbort = (): void => scanWorker.terminate()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const encoded: EncodedPage[] = []
    for (let i = 0; i < pages.length; i++) {
      if (signal.aborted) throw new CancelledError()
      onProgress(i / (pages.length + 1), `Processing page ${i + 1} of ${pages.length}`)
      const page = pages[i]
      const r = await scanWorker.call('export', { id: page.id, blob: page.blob, params: paramsFor(page), jpegQuality: q.jpeg, maxLongSide: q.maxLong })
      encoded.push(r.page)
    }
    if (signal.aborted) throw new CancelledError()
    onProgress(pages.length / (pages.length + 1), 'Building the PDF')
    const { bytes } = await scanWorker.call('assemble', { pages: encoded, title: 'Scan' })
    return bytes
  } catch (err) {
    if (signal.aborted) throw new CancelledError()
    throw err
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const ocrDeps: OcrDeps = {
  hasCommand: (id) => !!getCommand(id),
  runCommand: (id, args) => runCommand(id, args),
  waitReady: async (docId) => {
    for (let i = 0; i < 100; i++) {
      const t = useTabs.getState().tabs.find((x) => x.docId === docId)
      if (!t || t.status !== 'loading') return
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

export const ocrAvailable = (): boolean => ocrDeps.hasCommand('ocr.run')

export const defaultFileName = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`
}

/** Save dialog (main), open the file in a tab, and start OCR when asked. Returns false if the user cancelled the dialog. */
export async function saveAsNewPdf(bytes: Uint8Array, recognize: boolean): Promise<boolean> {
  const saved = await window.epdf.call<ScanSaveResult | null>('scan:save', { bytes, suggestedName: defaultFileName() })
  if (!saved) return false
  const handle = await window.epdf.openPath(saved.path)
  if (handle) {
    useTabs.getState().addHandles([handle])
    if (recognize) void requestOcr(handle.docId, ocrDeps)
  }
  notify('success', `Saved “${saved.name}”.`)
  return true
}

/** Inserts the scanned pages into an open document through the edit pipeline (one undo step). */
export async function addToCurrentDocument(docId: string, bytes: Uint8Array, position: 'end' | 'afterCurrent', recognize: boolean): Promise<number> {
  if (!(await ensureEditable(docId))) throw new Error('The document is password protected and was not unlocked, so pages could not be added.')
  const current = activeTab()
  const after = position === 'afterCurrent' && current?.docId === docId ? current.view.page : Number.POSITIVE_INFINITY
  let added = 0
  await editPdf(docId, 'Add scanned pages', async (pdf) => {
    const src = await PDFDocument.load(bytes)
    const copied = await pdf.copyPages(src, src.getPageIndices())
    const at = Math.min(pdf.getPageCount(), Number.isFinite(after) ? after : pdf.getPageCount())
    copied.forEach((p, i) => pdf.insertPage(at + i, p))
    added = copied.length
  })
  if (recognize) void requestOcr(docId, ocrDeps)
  return added
}

export function reportError(err: unknown): string {
  return err instanceof CancelledError ? 'Cancelled.' : errorMessage(err)
}
