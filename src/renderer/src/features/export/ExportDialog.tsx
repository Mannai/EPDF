import { EXPORT_LABEL } from '@shared/features/export'
import { Modal } from '../../components/Modal'
import { backToOptions, cancelExport, closeExportDialog, runExport, useExportUi } from './flow'

const FORMAT_TITLE = { docx: 'Word (.docx)', xlsx: 'Excel (.xlsx)', pptx: 'PowerPoint (.pptx)' } as const

const WHAT = {
  docx: 'Text becomes paragraphs (with fonts, sizes and colours), headings, tables, pictures and links. Each PDF page starts a new page.',
  xlsx: 'Tables become cell grids with numbers stored as numbers. Everything else becomes one row per line of text.',
  pptx: 'Each PDF page becomes one slide, with text in positioned text boxes and pictures where they were.'
} as const

/** The "Export To" dialog: options, then progress with Cancel, then the result. */
export function ExportDialogHost(): JSX.Element | null {
  const s = useExportUi()
  if (!s.open) return null
  const working = s.phase === 'working' || s.phase === 'saving'
  const title = `Export to ${FORMAT_TITLE[s.format]}`
  const close = (): void => (working ? cancelExport() : closeExportDialog())

  return (
    <Modal title={title} onClose={close}>
      {s.phase === 'options' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void runExport()
          }}
        >
          <p className="mb-2 text-ink-muted">
            Creates an editable {EXPORT_LABEL[s.format]} from “{s.docName}”, including your unsaved changes. The PDF itself is not changed.
          </p>
          <p className="mb-3 text-sm text-ink-muted">{WHAT[s.format]}</p>
          {s.format === 'xlsx' ? (
            <fieldset className="mb-3">
              <legend className="mb-1 text-sm font-medium">Sheets</legend>
              <label className="mb-1 flex items-start gap-2">
                <input
                  type="radio"
                  name="xlsx-mode"
                  className="mt-1 accent-accent"
                  checked={s.options.xlsxMode === 'tables'}
                  onChange={() => s.setOptions({ xlsxMode: 'tables' })}
                />
                <span>One sheet per detected table (one per page if none is found)</span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="xlsx-mode"
                  className="mt-1 accent-accent"
                  checked={s.options.xlsxMode === 'pages'}
                  onChange={() => s.setOptions({ xlsxMode: 'pages' })}
                />
                <span>One sheet per page</span>
              </label>
            </fieldset>
          ) : (
            <label className="mb-3 flex items-center gap-2">
              <input type="checkbox" className="accent-accent" checked={s.options.includeImages} onChange={(e) => s.setOptions({ includeImages: e.target.checked })} />
              <span>Include pictures</span>
            </label>
          )}
          <p className="mb-4 rounded-md border border-line bg-surface-alt p-2 text-sm" data-testid="export-approximate">
            Layout is approximate: complex layouts, columns and unusual fonts may not convert exactly.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={closeExportDialog}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" autoFocus>
              Export…
            </button>
          </div>
        </form>
      )}

      {working && (
        <div>
          <progress className="mb-2 h-2 w-full accent-accent" max={1} value={s.progress} aria-label="Export progress" />
          <p role="status" aria-live="polite" className="mb-4 text-ink-muted" data-testid="export-status">
            {s.message}
          </p>
          <div className="flex justify-end">
            <button type="button" className="btn" onClick={cancelExport} disabled={s.phase === 'saving'} autoFocus>
              Cancel
            </button>
          </div>
        </div>
      )}

      {s.phase === 'done' && (
        <div>
          <p role="status" className="mb-2" data-testid="export-done">
            Saved “{s.savedName}”. Open it in {s.format === 'docx' ? 'Word' : s.format === 'xlsx' ? 'Excel' : 'PowerPoint'} to keep editing.
          </p>
          <p className="mb-3 text-sm text-ink-muted">Layout is approximate; check the result before sharing it.</p>
          {s.warnings.length > 0 && (
            <div className="mb-3">
              <h3 className="mb-1 text-sm font-medium">Notes</h3>
              <ul className="list-disc pl-5 text-sm text-ink-muted">
                {s.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={closeExportDialog} autoFocus>
              Close
            </button>
          </div>
        </div>
      )}

      {s.phase === 'failed' && (
        <div>
          <p role="alert" className="mb-4 text-red-600 dark:text-red-400">
            {s.error}
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={closeExportDialog}>
              Close
            </button>
            <button type="button" className="btn-primary" onClick={backToOptions} autoFocus>
              Back
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
