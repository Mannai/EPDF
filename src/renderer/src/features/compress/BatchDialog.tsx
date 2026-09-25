import { useId } from 'react'
import { Modal } from '../../components/Modal'
import { cancelBatch, chooseBatchPreset, closeBatch, removeBatchFile, runBatch, useBatchUi, type BatchFile, type BatchPreset } from './batch'
import { fmtSize, savedPercent } from './format'
import { PRESET_LABELS } from './pdf/options'

const PRESETS: BatchPreset[] = ['high', 'balanced', 'smallest']

function statusText(f: BatchFile): string {
  switch (f.status) {
    case 'waiting':
      return 'Waiting'
    case 'working':
      return 'Working…'
    case 'done':
      return `Saved as ${f.outName}: ${fmtSize(f.after ?? 0)} (${savedPercent(f.size, f.after ?? f.size)}% smaller)`
    case 'kept':
      return f.message ?? 'Already as small as it can be'
    case 'skipped':
      return `Skipped. ${f.message ?? ''}`
    case 'error':
      return `Failed: ${f.message ?? 'unknown error'}`
  }
}

/** File > Reduce Several Files...: a list of PDFs, one preset for all, results per file. Originals are never modified. */
export function BatchDialog(): JSX.Element | null {
  const s = useBatchUi()
  const legendId = useId()
  if (!s.open) return null
  const pct = Math.round(s.progress.fraction * 100)
  const total = s.files.reduce((a, f) => a + f.size, 0)
  return (
    <Modal title="Reduce several files" onClose={closeBatch} wide>
      <p className="mb-2 text-sm text-ink-muted" data-testid="batch-count">
        {s.files.length} {s.files.length === 1 ? 'file' : 'files'} · {fmtSize(total)}. Each reduced copy is saved next to its original as &ldquo;name (reduced).pdf&rdquo;; the originals are not changed.
      </p>
      <ul className="mb-3 max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line" aria-label="Files to reduce" data-testid="batch-files">
        {s.files.map((f) => (
          <li key={f.token} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate font-medium">{f.name}</span>
              <span className="block text-xs text-ink-muted" data-testid={`batch-status-${f.name}`} data-status={f.status}>
                {fmtSize(f.size)} · {statusText(f)}
              </span>
            </span>
            {!s.running && f.status === 'waiting' && (
              <button type="button" className="btn" onClick={() => removeBatchFile(f.token)} aria-label={`Remove ${f.name}`}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      <div role="radiogroup" aria-labelledby={legendId} className="mb-3">
        <div id={legendId} className="mb-1 text-sm font-medium">
          Quality
        </div>
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map((id) => (
            <label key={id} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 ${s.preset === id ? 'border-accent bg-surface-alt' : 'border-line'}`}>
              <input type="radio" name="batch-preset" className="mt-1 accent-accent" checked={s.preset === id} disabled={s.running} onChange={() => chooseBatchPreset(id)} data-testid={`batch-preset-${id}`} />
              <span className="text-sm">
                <span className="block font-medium">{PRESET_LABELS[id].label}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-muted">{PRESET_LABELS[s.preset].blurb}</p>
      </div>

      {s.running && (
        <div className="mb-3">
          <div className="mb-1 flex justify-between gap-3 text-sm">
            <span className="truncate" data-testid="batch-progress-label">
              {s.progress.label}
            </span>
            <span>{pct}%</span>
          </div>
          <div role="progressbar" aria-label="Reducing files" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded bg-surface-alt">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        {s.running ? (
          <button type="button" className="btn" onClick={cancelBatch} autoFocus data-testid="batch-cancel-run">
            Cancel
          </button>
        ) : (
          <button type="button" className="btn" onClick={closeBatch} data-testid="batch-close">
            {s.finished ? 'Close' : 'Cancel'}
          </button>
        )}
        <button type="button" className="btn-primary" onClick={() => void runBatch()} disabled={s.running || s.finished || s.files.length === 0} data-testid="batch-run">
          {s.running ? 'Working…' : s.files.length === 1 ? 'Reduce file' : `Reduce ${s.files.length} files`}
        </button>
      </div>
    </Modal>
  )
}
