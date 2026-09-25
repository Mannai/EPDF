import { create } from 'zustand'
import { DEFAULT_PRINT_OPTIONS, type PrintOptions } from '@shared/features/print/options'

interface PrintDialogState {
  docId: string | null
  mode: 'print' | 'pdf'
  open(docId: string, mode: 'print' | 'pdf'): void
  close(): void
}

/** Whether the print dialog is showing, and for which document ("print" = system printer, "pdf" = Print to PDF). */
export const usePrintDialog = create<PrintDialogState>((set) => ({
  docId: null,
  mode: 'print',
  open: (docId, mode) => set({ docId, mode }),
  close: () => set({ docId: null })
}))

/** The options last used, so reopening the dialog starts where the user left off (this session only). */
export const usePrintOptions = create<{ opts: PrintOptions; set(opts: PrintOptions): void }>((set) => ({
  opts: DEFAULT_PRINT_OPTIONS,
  set: (opts) => set({ opts: { ...opts, range: opts.range === 'current' ? 'all' : opts.range } })
}))
