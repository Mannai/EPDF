import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { create } from 'zustand'
import { EXPORT_LABEL, type ExportFormat, type ExportSaveResult } from '@shared/features/export'
import { currentBytes } from '../../edit/session'
import { getLoaded } from '../../pdf/docCache'
import { activeTab } from '../../state/actions'
import { errorMessage, notify } from '../../state/notify'
import { DEFAULT_OPTIONS, type ExportOptions } from './model'
import { exportDocument } from './run'

export type ExportPhase = 'options' | 'working' | 'saving' | 'done' | 'failed'

interface ExportUi {
  open: boolean
  format: ExportFormat
  docId: string
  docName: string
  phase: ExportPhase
  progress: number
  message: string
  options: ExportOptions
  warnings: string[]
  savedName: string
  error: string
  setOptions(patch: Partial<ExportOptions>): void
}

export const useExportUi = create<ExportUi>((set) => ({
  open: false,
  format: 'docx',
  docId: '',
  docName: '',
  phase: 'options',
  progress: 0,
  message: '',
  options: DEFAULT_OPTIONS,
  warnings: [],
  savedName: '',
  error: '',
  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } }))
}))

let controller: AbortController | null = null

/** Where PDF.js finds cMaps/fonts when we have to open a document ourselves (same folders the viewer uses). */
const ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/'
}

/** Opens File ▸ Export To ▸ … for the active document, or explains why it cannot. */
export function openExportDialog(format: ExportFormat): void {
  const tab = activeTab()
  if (!tab) return notify('error', 'Open a PDF first.')
  if (tab.status !== 'ready') return notify('error', 'Wait until the document has finished loading.')
  if (useExportUi.getState().open) return
  useExportUi.setState({
    open: true,
    format,
    docId: tab.docId,
    docName: tab.name,
    phase: 'options',
    progress: 0,
    message: '',
    warnings: [],
    savedName: '',
    error: '',
    options: { ...DEFAULT_OPTIONS }
  })
}

export function closeExportDialog(): void {
  if (controller) controller.abort()
  useExportUi.setState({ open: false })
}

/** The viewer's document (already decrypted, includes unsaved edits); otherwise a fresh one from the current bytes. */
async function obtainDoc(docId: string): Promise<{ doc: PDFDocumentProxy; dispose(): void }> {
  const loaded = getLoaded(docId)
  if (loaded && !loaded.destroyed) return { doc: loaded.doc, dispose: () => undefined }
  const bytes = await currentBytes(docId)
  const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false, ...ASSETS })
  try {
    return { doc: await task.promise, dispose: () => void task.destroy() }
  } catch (err) {
    void task.destroy()
    if (err instanceof Error && /password/i.test(err.name + err.message)) {
      throw new Error('This document is password protected. Open it in Epdf first (enter the password), then export.')
    }
    throw err
  }
}

export async function runExport(): Promise<void> {
  const s = useExportUi.getState()
  if (s.phase === 'working' || s.phase === 'saving') return
  const ac = new AbortController()
  controller = ac
  useExportUi.setState({ phase: 'working', progress: 0, message: 'Starting…', error: '', warnings: [] })
  let dispose = (): void => undefined
  try {
    const opened = await obtainDoc(s.docId)
    dispose = opened.dispose
    const result = await exportDocument(opened.doc, s.format, {
      OPS: pdfjs.OPS as unknown as Record<string, number>,
      signal: ac.signal,
      options: s.options,
      onProgress: (f, m) => useExportUi.setState({ progress: f, message: m })
    })
    if (ac.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    useExportUi.setState({ phase: 'saving', progress: 1, message: 'Choose where to save the file…', warnings: result.warnings })
    const saved = await window.epdf.call<ExportSaveResult | null>('export:save', { docId: s.docId, format: s.format, bytes: result.bytes })
    if (!saved) {
      useExportUi.setState({ open: false })
      notify('info', 'The export was not saved.')
      return
    }
    useExportUi.setState({ phase: 'done', savedName: saved.name })
    notify('success', `Exported “${saved.name}”. ${EXPORT_LABEL[s.format]} layout is approximate.`)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      useExportUi.setState({ open: false })
      notify('info', 'The export was cancelled.')
    } else {
      useExportUi.setState({ phase: 'failed', error: `The export failed: ${errorMessage(err)}` })
    }
  } finally {
    dispose()
    if (controller === ac) controller = null
  }
}

/** Cancel while working: aborts extraction at the next page boundary. */
export function cancelExport(): void {
  controller?.abort()
}

export function backToOptions(): void {
  useExportUi.setState({ phase: 'options', error: '', progress: 0, message: '' })
}
