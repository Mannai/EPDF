import { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { RenderTask } from 'pdfjs-dist'
import { Modal } from '../../components/Modal'
import { currentBytes } from '../../edit/session'
import { JobCancelledError, startJob } from '../../state/jobs'
import { errorMessage, notify } from '../../state/notify'
import { useTabs, type Tab } from '../../state/tabs'
import type { SavedFile } from '@shared/features/pages'
import { stemOf } from '@shared/features/pages/filenames'
import {
  MAX_COPIES,
  MAX_PERCENT,
  MIN_PERCENT,
  QUALITY_DPI,
  resolvePages,
  summarize,
  validateOptions,
  type PrintOptions
} from '@shared/features/print/options'
import { useCurrentDoc } from '../pages/useCurrentDoc'
import { PrintCancelledError, printDocument, type PrintProgress } from './pipeline'
import { usePrintDialog, usePrintOptions } from './store'

const PREVIEW_W = 220
const PREVIEW_H = 290

function Preview({ tab, pageIndex, annotations }: { tab: Tab; pageIndex: number; annotations: boolean }): JSX.Element {
  const loaded = useCurrentDoc(tab)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!loaded || pageIndex < 0 || pageIndex >= loaded.numPages) return
    let cancelled = false
    let task: RenderTask | undefined
    void (async () => {
      try {
        const page = await loaded.doc.getPage(pageIndex + 1)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(PREVIEW_W / base.width, PREVIEW_H / base.height)
        const viewport = page.getViewport({ scale })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width * dpr)
        canvas.height = Math.ceil(viewport.height * dpr)
        canvas.style.cssText = `width:${Math.ceil(viewport.width)}px;height:${Math.ceil(viewport.height)}px;display:block;background:#fff`
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        task = page.render({
          canvasContext: ctx,
          canvas,
          viewport,
          intent: 'print',
          annotationMode: annotations ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          background: 'rgb(255,255,255)'
        })
        await task.promise
        if (!cancelled) host.current?.replaceChildren(canvas)
        page.cleanup()
      } catch (err) {
        if (!(err instanceof pdfjs.RenderingCancelledException) && !cancelled) console.error('Print preview failed', err)
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [loaded, pageIndex, annotations])
  return (
    <div
      ref={host}
      role="img"
      aria-label={`Preview of page ${pageIndex + 1}`}
      data-testid="print-preview"
      className="flex items-center justify-center border border-line bg-canvas shadow"
      style={{ width: PREVIEW_W, height: PREVIEW_H }}
    />
  )
}

function PrintDialogInner({ tab, mode, close }: { tab: Tab; mode: 'print' | 'pdf'; close(): void }): JSX.Element {
  const loaded = useCurrentDoc(tab)
  const numPages = loaded?.numPages ?? tab.numPages
  const remembered = usePrintOptions((s) => s.opts)
  const [opts, setOpts] = useState<PrintOptions>({ ...remembered, copies: mode === 'pdf' ? 1 : remembered.copies })
  const [progress, setProgress] = useState<PrintProgress | null>(null)
  const [error, setError] = useState('')
  const signal = useRef({ cancelled: false })
  const cancelJob = useRef<(() => void) | null>(null)
  const running = progress !== null
  const set = (patch: Partial<PrintOptions>): void => setOpts((o) => ({ ...o, ...patch }))

  const pages = useMemo(() => resolvePages(opts, numPages, tab.view.page), [opts, numPages, tab.view.page])
  const optErr = validateOptions(opts)
  const rangeErr = opts.range === 'custom' && !pages.ok && opts.custom.trim() !== '' ? pages.error : ''
  const ready = pages.ok && !optErr && !running && numPages > 0
  const title = mode === 'print' ? 'Print' : 'Print to PDF'

  const start = async (): Promise<void> => {
    if (!pages.ok || optErr) return
    usePrintOptions.getState().set(opts)
    setError('')
    signal.current = { cancelled: false }
    setProgress({ phase: 'preparing', done: 0, total: pages.value.length })
    try {
      if (mode === 'print') {
        const outcome = await printDocument({
          docId: tab.docId,
          title: tab.name,
          opts,
          pages: pages.value,
          fallbackDoc: loaded?.doc,
          onProgress: setProgress,
          signal: signal.current
        })
        if (outcome.status === 'failed') {
          setError(outcome.message)
          return
        }
        if (outcome.status === 'printed') notify('success', 'Sent to the printer.')
        else if (outcome.status === 'saved-to-file') notify('info', 'The print output was written to the file set by EPDF_PRINT_TO_FILE.')
        close()
      } else {
        const bytes = await currentBytes(tab.docId)
        const job = startJob<Uint8Array>('print:prepare', {
          bytes,
          pages: pages.value,
          annotations: opts.annotations,
          scale: { scaling: opts.scaling, percent: opts.percent, paper: opts.paper, orientation: opts.orientation }
        })
        cancelJob.current = job.cancel
        const out = await job.promise
        cancelJob.current = null
        const saved = await window.epdf.call<SavedFile | null>('print:savePdf', { docId: tab.docId, bytes: out, suggestedName: `${stemOf(tab.name)} (print)` })
        if (saved) {
          notify('success', `Saved “${saved.name}”.`, { label: 'Open', run: () => void window.epdf.call('pages:openSaved', { token: saved.token }) })
          close()
        }
      }
    } catch (err) {
      if (err instanceof PrintCancelledError || err instanceof JobCancelledError) notify('info', 'Cancelled.')
      else setError(errorMessage(err))
    } finally {
      setProgress(null)
      cancelJob.current = null
    }
  }

  const cancel = (): void => {
    signal.current.cancelled = true
    cancelJob.current?.()
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  const phaseText = progress
    ? progress.phase === 'preparing'
      ? 'Preparing pages…'
      : mode === 'pdf'
        ? 'Saving…'
        : progress.done >= progress.total
          ? 'Opening the print dialog…'
          : `Preparing page ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
    : ''

  return (
    <Modal title={title} onClose={running ? cancel : close} wide>
      <div className="flex gap-5">
        <fieldset disabled={running} className="min-w-0 flex-1 space-y-4">
          <div>
            <p className="mb-1 text-sm font-medium" id="print-range-label">
              Pages
            </p>
            <div role="radiogroup" aria-labelledby="print-range-label" className="space-y-1">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="print-range" checked={opts.range === 'all'} onChange={() => set({ range: 'all' })} />
                All pages ({numPages})
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="print-range" checked={opts.range === 'current'} onChange={() => set({ range: 'current' })} />
                Current page ({tab.view.page})
              </label>
              <div className="flex items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="print-range" checked={opts.range === 'custom'} onChange={() => set({ range: 'custom' })} />
                  Pages
                </label>
                <input
                  className="field w-40"
                  aria-label="Page range"
                  placeholder="1-3,7"
                  value={opts.custom}
                  aria-invalid={!!rangeErr}
                  aria-describedby="print-range-error"
                  onFocus={() => set({ range: 'custom' })}
                  onChange={(e) => set({ range: 'custom', custom: e.target.value })}
                />
              </div>
            </div>
            {rangeErr && (
              <p id="print-range-error" role="alert" className="mt-1 text-sm text-red-700 dark:text-red-400">
                {rangeErr}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {mode === 'print' && (
              <div>
                <label className="block text-sm font-medium" htmlFor="print-copies">
                  Copies
                </label>
                <input
                  id="print-copies"
                  className="field mt-1 w-20"
                  inputMode="numeric"
                  value={String(opts.copies)}
                  aria-invalid={!Number.isInteger(opts.copies) || opts.copies < 1 || opts.copies > MAX_COPIES}
                  onChange={(e) => set({ copies: e.target.value === '' ? 0 : Number(e.target.value.replace(/[^0-9]/g, '')) })}
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium" htmlFor="print-scaling">
                Scaling
              </label>
              <select id="print-scaling" className="field mt-1 w-full" value={opts.scaling} onChange={(e) => set({ scaling: e.target.value as PrintOptions['scaling'] })}>
                <option value="fit">Fit to printable area</option>
                <option value="actual">Actual size</option>
                <option value="custom">Custom scale</option>
              </select>
              {opts.scaling === 'custom' && (
                <div className="mt-1 flex items-center gap-1 text-sm">
                  <label className="sr-only" htmlFor="print-percent">
                    Scale in percent
                  </label>
                  <input
                    id="print-percent"
                    className="field w-20"
                    inputMode="numeric"
                    value={String(opts.percent)}
                    aria-invalid={opts.percent < MIN_PERCENT || opts.percent > MAX_PERCENT}
                    onChange={(e) => set({ percent: e.target.value === '' ? 0 : Number(e.target.value.replace(/[^0-9]/g, '')) })}
                  />
                  %
                </div>
              )}
            </div>
            {mode === 'pdf' && (
              <div>
                <label className="block text-sm font-medium" htmlFor="print-paper">
                  Paper size
                </label>
                <select id="print-paper" className="field mt-1 w-full" value={opts.paper} onChange={(e) => set({ paper: e.target.value as PrintOptions['paper'] })}>
                  <option value="source">Same as each page</option>
                  <option value="a4">A4</option>
                  <option value="letter">Letter</option>
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium" htmlFor="print-orientation">
                Orientation
              </label>
              <select id="print-orientation" className="field mt-1 w-full" value={opts.orientation} onChange={(e) => set({ orientation: e.target.value as PrintOptions['orientation'] })}>
                <option value="auto">Automatic</option>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </div>
            {mode === 'print' && (
              <div>
                <label className="block text-sm font-medium" htmlFor="print-quality">
                  Quality
                </label>
                <select id="print-quality" className="field mt-1 w-full" value={opts.quality} onChange={(e) => set({ quality: e.target.value as PrintOptions['quality'] })}>
                  <option value="draft">Draft ({QUALITY_DPI.draft} dpi)</option>
                  <option value="standard">Standard ({QUALITY_DPI.standard} dpi)</option>
                  <option value="high">High ({QUALITY_DPI.high} dpi)</option>
                </select>
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={opts.annotations} onChange={(e) => set({ annotations: e.target.checked })} />
            Print annotations (comments, highlights, markup)
          </label>
          {optErr && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {optErr}
            </p>
          )}
        </fieldset>

        <div className="shrink-0">
          <Preview tab={tab} pageIndex={pages.ok ? pages.value[0] : 0} annotations={opts.annotations} />
          <p className="mt-1 text-center text-xs text-ink-muted" data-testid="print-summary">
            {pages.ok ? summarize(pages.value.length, mode === 'print' ? opts.copies || 1 : 1) : ' '}
          </p>
        </div>
      </div>

      {mode === 'print' && (
        <p className="mt-3 text-xs text-ink-muted">
          Pages are printed as images ({QUALITY_DPI[opts.quality]} dpi), so text is not sharp vector text on paper. Use Print to PDF to keep vector quality.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {running && (
        <div className="mt-3" data-testid="print-progress">
          <div role="progressbar" aria-label="Print progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded bg-canvas">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <p role="status" className="mt-1 text-sm">
            {phaseText}
          </p>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={running ? cancel : close}>
          Cancel
        </button>
        <button className="btn-primary" disabled={!ready} onClick={() => void start()}>
          {mode === 'print' ? 'Print…' : 'Save as PDF…'}
        </button>
      </div>
    </Modal>
  )
}

export function PrintDialog(): JSX.Element | null {
  const { docId, mode, close } = usePrintDialog()
  const tab = useTabsLookup(docId)
  useEffect(() => {
    if (docId && !tab) close()
  }, [docId, tab, close])
  if (!docId || !tab) return null
  return <PrintDialogInner key={`${docId}-${mode}`} tab={tab} mode={mode} close={close} />
}

function useTabsLookup(docId: string | null): Tab | undefined {
  return useTabs((s) => (docId ? s.tabs.find((t) => t.docId === docId) : undefined))
}
