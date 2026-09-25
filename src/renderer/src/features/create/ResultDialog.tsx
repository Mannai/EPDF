import { Modal } from '../../components/Modal'
import { plural, useResultReport } from './shared'

/** Lists what was saved, which files failed and every note about approximated or unsupported content. */
export function ResultDialogHost(): JSX.Element | null {
  const report = useResultReport((s) => s.report)
  const close = useResultReport((s) => s.close)
  if (!report) return null
  const { result } = report
  return (
    <Modal title={report.title} onClose={close} wide>
      {result.saved.length > 0 && (
        <div className="mb-3">
          <h3 className="mb-1 text-sm font-medium">Saved</h3>
          <ul className="list-disc pl-5" data-testid="result-saved">
            {result.saved.map((s) => (
              <li key={s.path}>
                {s.name}
                {s.pages ? <span className="text-ink-muted"> ({plural(s.pages, 'page')})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.failed.length > 0 && (
        <div className="mb-3">
          <h3 className="mb-1 text-sm font-medium">Could not be converted</h3>
          <ul className="list-disc pl-5" data-testid="result-failed">
            {result.failed.map((f) => (
              <li key={f.name}>
                <strong>{f.name}</strong>: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.notes.length > 0 && (
        <div className="mb-3">
          <h3 className="mb-1 text-sm font-medium">Notes</h3>
          <ul className="list-disc pl-5 text-sm text-ink-muted" data-testid="result-notes">
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {report.approximate && <p className="mb-3 text-sm text-ink-muted">The built-in converter approximates the layout of Office documents. Check the result before sharing it.</p>}
      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={close} autoFocus>
          Close
        </button>
      </div>
    </Modal>
  )
}
