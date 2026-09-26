import { useId } from 'react'
import { MAX_LANGUAGES_PER_RUN, OCR_DPI_CHOICES, formatBytes, selectPages } from '@shared/features/ocr'
import { Modal } from '../../components/Modal'
import { useJobs } from '../../state/jobs'
import { blocker, scopeOf, useOcrUi } from './store'

/** "Recognize Text (OCR)…": pages, languages (with on-demand downloads), options. */
export function OcrDialog(): JSX.Element | null {
  const s = useOcrUi()
  const dl = useJobs((j) => Object.values(j.jobs).find((x) => x.kind === 'ocr:download' && x.state === 'running'))
  const uid = useId()
  if (!s.open) return null

  const why = blocker(s)
  const rangeCheck = s.scopeMode === 'range' ? selectPages(scopeOf(s), s.numPages) : null
  const rangeError = rangeCheck && !rangeCheck.ok && s.rangeText.trim() !== '' ? rangeCheck.error : null
  const pageCount = selectPages(scopeOf(s), s.numPages)
  const atLimit = s.prefs.languages.length >= MAX_LANGUAGES_PER_RUN

  return (
    <Modal title="Recognize text (OCR)" onClose={s.close} wide>
      <p className="mb-3 text-sm text-ink-muted">
        Adds invisible, searchable text to scanned pages. The pictures are not changed. Recognition runs on this computer; nothing is uploaded.
      </p>

      <fieldset className="mb-3">
        <legend className="mb-1 text-sm font-medium">Pages</legend>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <label className="flex items-center gap-2">
            <input type="radio" name={`${uid}-scope`} className="accent-accent" checked={s.scopeMode === 'all'} onChange={() => s.setScopeMode('all')} />
            All pages ({s.numPages})
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${uid}-scope`} className="accent-accent" checked={s.scopeMode === 'current'} onChange={() => s.setScopeMode('current')} />
            Current page ({s.currentPage})
          </label>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2">
              <input type="radio" name={`${uid}-scope`} className="accent-accent" checked={s.scopeMode === 'range'} onChange={() => s.setScopeMode('range')} />
              Pages
            </label>
            <input
              type="text"
              aria-label="Page range"
              aria-invalid={!!rangeError}
              aria-describedby={rangeError ? `${uid}-range-error` : undefined}
              placeholder="e.g. 1-3, 7, 9-"
              className="field w-40 select-text"
              value={s.rangeText}
              onChange={(e) => s.setRangeText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {rangeError && (
            <p id={`${uid}-range-error`} role="alert" className="text-sm text-danger">
              {rangeError}
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className="mb-3">
        <legend className="mb-1 text-sm font-medium">Languages</legend>
        <p id={`${uid}-lang-help`} className="mb-1 text-sm text-ink-muted">
          Choose up to {MAX_LANGUAGES_PER_RUN}. English is built in; others are downloaded once from the official Tesseract repository (1 to 6 MB) and then work offline.
        </p>
        <ul aria-describedby={`${uid}-lang-help`} data-testid="ocr-languages" className="max-h-40 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {s.languages.map((l) => {
            const checked = s.prefs.languages.includes(l.code)
            const downloading = s.download?.language === l.code
            const pct = downloading && dl ? Math.round(dl.progress * 100) : 0
            return (
              <li key={l.code} className="flex items-center justify-between gap-3 px-3 py-1.5" data-lang={l.code}>
                <label className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={checked}
                    disabled={!checked && atLimit}
                    onChange={() => s.toggleLanguage(l.code)}
                  />
                  <span className="truncate">
                    {l.name}
                    {l.nativeName !== l.name && <span className="text-ink-muted"> ({l.nativeName})</span>}
                  </span>
                </label>
                <span className="flex shrink-0 items-center gap-2 text-sm">
                  {downloading ? (
                    <>
                      <span role="status" className="text-ink-muted">
                        Downloading… {pct}%
                      </span>
                      <button type="button" className="btn h-7 px-2 text-xs" onClick={s.download!.cancel}>
                        Cancel<span className="sr-only"> download of {l.name}</span>
                      </button>
                    </>
                  ) : l.installed ? (
                    <>
                      <span className="text-ink-muted">{l.bundled ? 'Built in' : 'Downloaded'}</span>
                      {!l.bundled && (
                        <button type="button" className="btn h-7 px-2 text-xs" onClick={() => void s.removeLanguage(l.code)}>
                          Remove<span className="sr-only"> {l.name} language data</span>
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-ink-muted">Not downloaded · {formatBytes(l.size)}</span>
                      <button type="button" className="btn h-7 px-2 text-xs" disabled={!!s.download} onClick={() => void s.downloadLanguage(l.code)}>
                        Download<span className="sr-only"> {l.name} language data ({formatBytes(l.size)})</span>
                      </button>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
        {s.downloadError && (
          <p role="alert" className="mt-1 text-sm text-danger" data-testid="ocr-download-error">
            {s.downloadError}
          </p>
        )}
      </fieldset>

      <fieldset className="mb-3">
        <legend className="mb-1 text-sm font-medium">Options</legend>
        <div className="mb-1 flex items-center gap-2">
          <label htmlFor={`${uid}-dpi`}>Resolution</label>
          <select id={`${uid}-dpi`} className="field" value={s.prefs.dpi} onChange={(e) => s.setPref('dpi', Number(e.target.value))}>
            {OCR_DPI_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d} dpi{d === 300 ? ' (recommended)' : ''}
              </option>
            ))}
          </select>
        </div>
        <label className="mb-1 flex items-center gap-2">
          <input type="checkbox" className="accent-accent" checked={s.prefs.contrast} onChange={(e) => s.setPref('contrast', e.target.checked)} />
          Improve contrast (grayscale)
        </label>
        <label className="mb-1 flex items-center gap-2">
          <input type="checkbox" className="accent-accent" checked={s.prefs.deskew} onChange={(e) => s.setPref('deskew', e.target.checked)} />
          Straighten tilted pages
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-accent" checked={s.prefs.force} onChange={(e) => s.setPref('force', e.target.checked)} />
          Recognize pages that already contain text
        </label>
      </fieldset>

      {why && !rangeError && (
        <p role="status" className="mb-2 text-sm text-ink-muted" data-testid="ocr-blocker">
          {why}
        </p>
      )}
      {/* stays visible while the (scrollable) dialog is taller than the window */}
      <div className="sticky -bottom-5 -mx-5 -mb-5 flex justify-end gap-2 border-t border-line bg-raised px-5 py-3">
        <button type="button" className="btn" onClick={s.close}>
          Cancel
        </button>
        <button type="button" className="btn-primary disabled:pointer-events-none disabled:opacity-40" disabled={!!why} onClick={() => void s.start()}>
          {pageCount.ok && pageCount.pages.length > 1 ? `Recognize ${pageCount.pages.length} pages` : 'Recognize'}
        </button>
      </div>
    </Modal>
  )
}
