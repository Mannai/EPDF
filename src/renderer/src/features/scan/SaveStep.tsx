import { useRef, useState } from 'react'
import { notify } from '../../state/notify'
import { selectActiveTab, useTabs } from '../../state/tabs'
import { CancelledError, QUALITY, addToCurrentDocument, buildPdf, ocrAvailable, reportError, saveAsNewPdf } from './output'
import { announce, closeScanDialog } from './pages'
import { useScan, type QualityChoice } from './store'
import { Field, plural } from './ui'

/** Step 3: output options and the Save / Add buttons. Also owns the "assembling" progress + Cancel. */

const PRESET_LABEL = { color: 'Colour', gray: 'Grayscale', bw: 'Black & white', original: 'Original pictures' } as const

export function SaveStep(): JSX.Element {
  const pages = useScan((s) => s.pages)
  const options = useScan((s) => s.options)
  const busy = useScan((s) => s.busy)
  const error = useScan((s) => s.error)
  const tab = useTabs(selectActiveTab)
  const [position, setPosition] = useState<'end' | 'afterCurrent'>('end')
  const abortRef = useRef<AbortController | null>(null)
  const usable = pages.filter((p) => p.state === 'ready')
  const skipped = pages.length - usable.length
  const waiting = pages.some((p) => p.state === 'preparing')
  const canAdd = !!tab && tab.status === 'ready'
  const setOptions = (patch: Partial<typeof options>): void => useScan.setState((s) => ({ options: { ...s.options, ...patch } }))

  const run = async (mode: 'new' | 'current'): Promise<void> => {
    if (usable.length === 0 || busy) return
    const ac = new AbortController()
    abortRef.current = ac
    useScan.setState({ busy: { label: 'Starting…', fraction: 0 }, error: null })
    try {
      const bytes = await buildPdf(usable, (fraction, label) => useScan.setState({ busy: { label, fraction } }), ac.signal)
      useScan.setState({ busy: { label: mode === 'new' ? 'Saving…' : 'Adding the pages…', fraction: 0.97 } })
      if (mode === 'new') {
        if (!(await saveAsNewPdf(bytes, options.recognize))) {
          announce('The PDF was not saved.')
          useScan.setState({ busy: null })
          return
        }
      } else {
        const n = await addToCurrentDocument(tab!.docId, bytes, position, options.recognize)
        notify('success', `Added ${plural(n, 'page')} to “${tab!.name}”.`)
      }
      useScan.setState({ busy: null })
      await closeScanDialog()
    } catch (err) {
      useScan.setState({ busy: null, error: err instanceof CancelledError ? null : reportError(err) })
      if (err instanceof CancelledError) announce('Cancelled. Nothing was saved.')
    } finally {
      abortRef.current = null
    }
  }

  return (
    <div data-testid="save-step">
      <p className="mb-3 text-sm" data-testid="save-summary">
        {plural(usable.length, 'page')} · {PRESET_LABEL[options.preset]} · {QUALITY[options.quality].label.toLowerCase()}
        {skipped > 0 && <span className="block text-ink-muted">{plural(skipped, 'page')} that could not be read will be left out.</span>}
      </p>
      <div className="grid gap-x-6 sm:grid-cols-2">
        <Field label="File size" hint={options.preset === 'bw' ? 'Black & white pages are stored as compact 1-bit images.' : 'Pictures are stored as JPEG.'}>
          {(id) => (
            <select id={id} className="field w-full" value={options.quality} disabled={!!busy} onChange={(e) => setOptions({ quality: e.target.value as QualityChoice })} data-testid="quality">
              {(Object.keys(QUALITY) as QualityChoice[]).map((q) => (
                <option key={q} value={q}>
                  {QUALITY[q].label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {canAdd && (
          <Field label="When adding to the open document">
            {(id) => (
              <select id={id} className="field w-full" value={position} disabled={!!busy} onChange={(e) => setPosition(e.target.value as 'end' | 'afterCurrent')} data-testid="insert-position">
                <option value="end">Add the pages at the end</option>
                <option value="afterCurrent">Add after page {tab!.view.page}</option>
              </select>
            )}
          </Field>
        )}
      </div>
      {ocrAvailable() && (
        <label className="mb-3 flex items-start gap-2">
          <input type="checkbox" className="mt-1 accent-accent" checked={options.recognize} disabled={!!busy} onChange={(e) => setOptions({ recognize: e.target.checked })} data-testid="recognize" />
          <span>
            Recognize text (OCR) after saving
            <span className="block text-xs text-ink-muted">Makes the scanned text searchable and selectable.</span>
          </span>
        </label>
      )}
      {busy && (
        <div className="mb-3" data-testid="save-progress">
          <div role="progressbar" aria-label="Building the PDF" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(busy.fraction * 100)} className="h-2 w-full overflow-hidden rounded bg-surface-alt">
            <div className="h-full bg-accent" style={{ width: `${Math.round(busy.fraction * 100)}%` }} />
          </div>
          <p role="status" className="mt-1 text-sm text-ink-muted">
            {busy.label}
          </p>
          <button type="button" className="btn mt-2" onClick={() => abortRef.current?.abort()} data-testid="save-cancel">
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mb-3 rounded-md border border-danger-line p-3 text-sm text-danger" data-testid="save-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {canAdd && (
          <button type="button" className="btn" disabled={!!busy || usable.length === 0 || waiting} onClick={() => void run('current')} data-testid="add-to-current">
            Add to “{tab!.name}”
          </button>
        )}
        <button type="button" className="btn-primary" disabled={!!busy || usable.length === 0 || waiting} onClick={() => void run('new')} data-testid="save-pdf">
          Save as new PDF…
        </button>
      </div>
    </div>
  )
}
