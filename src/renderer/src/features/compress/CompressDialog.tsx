import { useId, useMemo } from 'react'
import { Modal } from '../../components/Modal'
import { fmtSize, savedPercent } from './format'
import { estimateSize } from './pdf/analyze'
import { PRESET_LABELS, type CompressOptions, type PresetId } from './pdf/options'
import { applyResult, backToSettings, cancelRun, choosePreset, closeCompress, editOptions, runCompression, useCompressUi } from './store'

const PRESET_ORDER: PresetId[] = ['high', 'balanced', 'smallest', 'custom']

function NumberField({ label, value, min, max, unit, onChange, disabled }: { label: string; value: number; min: number; max: number; unit?: string; onChange(v: number): void; disabled?: boolean }): JSX.Element {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <span className="flex items-center gap-1">
        <input
          id={id}
          type="number"
          className="field w-20 select-text text-right"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {unit && <span className="w-8 text-xs text-ink-muted">{unit}</span>}
      </span>
    </div>
  )
}

function Check({ label, hint, checked, onChange, disabled, testId }: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean; testId?: string }): JSX.Element {
  return (
    <label className="flex items-start gap-2 py-0.5">
      <input type="checkbox" className="mt-1 accent-accent" checked={checked} disabled={disabled} data-testid={testId} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-sm">
        {label}
        {hint && <span className="block text-xs text-ink-muted">{hint}</span>}
      </span>
    </label>
  )
}

function CustomControls({ o, disabled }: { o: CompressOptions; disabled: boolean }): JSX.Element {
  return (
    <div className="mb-3 space-y-3 rounded-md border border-line p-3" data-testid="compress-custom">
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="mb-1 text-sm font-medium">Images</legend>
        <Check label="Reduce image resolution and recompress photos" checked={o.images} onChange={(v) => editOptions({ images: v })} testId="opt-images" />
        <NumberField label="Colour and gray images: at most" value={o.colorDpi} min={36} max={1200} unit="dpi" disabled={disabled || !o.images} onChange={(v) => editOptions({ colorDpi: v })} />
        <NumberField label="Black-and-white scans: at most" value={o.monoDpi} min={72} max={2400} unit="dpi" disabled={disabled || !o.images} onChange={(v) => editOptions({ monoDpi: v })} />
        <NumberField label="Photo (JPEG) quality, 1 to 100" value={o.jpegQuality} min={1} max={100} disabled={disabled || !o.images} onChange={(v) => editOptions({ jpegQuality: v })} />
        <Check label="Recompress JPEG photos that are already small enough in resolution" checked={o.recompressJpeg} disabled={disabled || !o.images} onChange={(v) => editOptions({ recompressJpeg: v })} />
      </fieldset>
      <fieldset className="space-y-0.5" disabled={disabled}>
        <legend className="mb-1 text-sm font-medium">Structure (no visible change)</legend>
        <Check label="Merge identical fonts, images and profiles" checked={o.dedupe} onChange={(v) => editOptions({ dedupe: v })} />
        <Check label="Compress data streams at the highest level" checked={o.recompressStreams} onChange={(v) => editOptions({ recompressStreams: v })} />
        <Check label="Pack objects into compressed object streams" checked={o.objectStreams} onChange={(v) => editOptions({ objectStreams: v })} />
      </fieldset>
      <fieldset className="space-y-0.5" disabled={disabled}>
        <legend className="mb-1 text-sm font-medium">Remove</legend>
        <Check label="Document properties and XMP metadata" hint="Keeps the title and dates." checked={o.stripMetadata} onChange={(v) => editOptions({ stripMetadata: v })} testId="opt-metadata" />
        <Check label="Page thumbnails" checked={o.stripThumbnails} onChange={(v) => editOptions({ stripThumbnails: v })} />
        <Check label="Private application data (PieceInfo)" checked={o.stripPieceInfo} onChange={(v) => editOptions({ stripPieceInfo: v })} />
        <Check label="JavaScript" hint="Form calculations and formatting scripts stop working." checked={o.stripJavaScript} onChange={(v) => editOptions({ stripJavaScript: v })} />
        <Check label="Unused named destinations" hint="Other documents that link to a name in this file may stop working." checked={o.stripUnusedDests} onChange={(v) => editOptions({ stripUnusedDests: v })} />
        <Check label="Legacy extras (extensions, OPI, alternate images)" checked={o.stripExtras} onChange={(v) => editOptions({ stripExtras: v })} />
      </fieldset>
    </div>
  )
}

/** File > Reduce File Size...: presets, size before/after, progress with Cancel, and Apply as one undo step. */
export function CompressDialog(): JSX.Element | null {
  const s = useCompressUi()
  const legendId = useId()
  const estimate = useMemo(() => (s.analysis ? estimateSize(s.analysis, s.options) : null), [s.analysis, s.options])
  if (!s.open) return null
  const busy = s.phase === 'running' || s.phase === 'loading'
  const pct = Math.round(s.progress.fraction * 100)
  const out = s.outcome
  const afterBytes = out ? out.newSize : (estimate?.bytes ?? s.originalSize)

  return (
    <Modal title="Reduce file size" onClose={closeCompress} wide>
      <p className="mb-3 text-sm text-ink-muted">
        <span className="font-medium text-ink" data-testid="compress-name">
          {s.name}
        </span>
        {' '}
        {s.analysis ? `· ${s.analysis.pages} ${s.analysis.pages === 1 ? 'page' : 'pages'}` : ''}
      </p>

      <div role="radiogroup" aria-labelledby={legendId} className="mb-3">
        <div id={legendId} className="mb-1 text-sm font-medium">
          Quality
        </div>
        <div className="grid grid-cols-2 gap-2">
          {PRESET_ORDER.map((id) => (
            <label key={id} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 ${s.preset === id ? 'border-accent bg-surface-alt' : 'border-line'}`}>
              <input type="radio" name="compress-preset" className="mt-1 accent-accent" checked={s.preset === id} disabled={s.phase === 'running' || s.phase === 'loading'} onChange={() => choosePreset(id)} data-testid={`preset-${id}`} />
              <span className="text-sm">
                <span className="block font-medium">{PRESET_LABELS[id].label}</span>
                <span className="block text-xs text-ink-muted">{PRESET_LABELS[id].blurb}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {s.preset === 'custom' && <CustomControls o={s.options} disabled={busy} />}

      {s.analysis?.signed && (
        <p className="mb-3 rounded-md border border-line bg-surface-alt p-2 text-sm" data-testid="compress-signed">
          This document is digitally signed. Reducing its size changes the file, so the signature will no longer verify.
        </p>
      )}

      <div className="mb-3 rounded-md border border-line p-3" aria-live="polite" data-testid="compress-sizes">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Current size</dt>
          <dd data-testid="size-before" data-bytes={s.originalSize}>
            {fmtSize(s.originalSize)}
          </dd>
          <dt className="text-ink-muted">{out ? 'New size' : 'Estimated size'}</dt>
          <dd data-testid="size-after" data-bytes={afterBytes} data-exact={out ? 'true' : 'false'}>
            {s.phase === 'loading' ? 'Analysing…' : out?.kept === 'original' ? `${fmtSize(out.originalSize)} (unchanged)` : `${out ? '' : '≈ '}${fmtSize(afterBytes)}`}
          </dd>
          <dt className="text-ink-muted">Saved</dt>
          <dd data-testid="size-saved" className="font-medium">
            {s.phase === 'loading' ? '-' : `${out ? '' : '≈ '}${out?.kept === 'original' ? 0 : savedPercent(s.originalSize, afterBytes)}%`}
          </dd>
        </dl>
        {!out && s.phase === 'ready' && <p className="mt-2 text-xs text-ink-muted">This is an estimate. The exact size is shown after the file has been reduced.</p>}
        {out?.kept === 'result' && (
          <p className="mt-2 text-xs text-ink-muted" data-testid="compress-details">
            {out.stats.images.replaced} of {out.stats.images.total} images reduced
            {out.stats.dedupe.merged ? `, ${out.stats.dedupe.merged} duplicate objects merged` : ''}
            {out.stats.unreachable.objects ? `, ${out.stats.unreachable.objects} unused objects removed` : ''}.
          </p>
        )}
        {out?.kept === 'original' && (
          <p role="status" className="mt-2 text-sm" data-testid="compress-kept">
            {out.reason ?? 'The file could not be made smaller, so it was left as it is.'}
          </p>
        )}
      </div>

      {s.phase === 'running' && (
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-sm">
            <span data-testid="compress-progress-label">{s.progress.label}</span>
            <span>{pct}%</span>
          </div>
          <div role="progressbar" aria-label="Reducing file size" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded bg-surface-alt">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {s.phase === 'error' && (
        <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400" data-testid="compress-error">
          {s.error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {s.phase === 'running' ? (
          <button type="button" className="btn" onClick={cancelRun} data-testid="compress-cancel-run">
            Cancel
          </button>
        ) : (
          <button type="button" className="btn" onClick={closeCompress} data-testid="compress-cancel">
            Cancel
          </button>
        )}
        {s.phase === 'done' && (
          <button type="button" className="btn" onClick={backToSettings} data-testid="compress-change">
            Change settings
          </button>
        )}
        {s.phase === 'done' && out?.kept === 'result' ? (
          <button type="button" className="btn-primary" onClick={() => void applyResult()} autoFocus data-testid="compress-apply">
            Apply
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={() => void runCompression()} disabled={s.phase !== 'ready'} data-testid="compress-run">
            {s.phase === 'running' ? 'Working…' : 'Reduce file size'}
          </button>
        )}
      </div>
    </Modal>
  )
}
