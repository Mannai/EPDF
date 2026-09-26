import { useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/Modal'
import { notify } from '../../state/notify'
import { applyRedactions, previewRedactions, type ApplyResult, type PreviewResult } from './apply'
import { summarize } from './logic/redact'
import { Preview } from './Preview'
import { pagesOf, totalRects, useDocRedact, useRedact } from './store'

type Failure = Extract<ApplyResult, { ok: false }>

/** Options, preview (before/after) and the final Apply. Everything stays undoable until the file is saved. */
export function RedactDialog(): JSX.Element | null {
  const docId = useRedact((s) => s.dialogDoc)
  const settings = useRedact((s) => s.settings)
  const patch = useRedact((s) => s.patchSettings)
  const marks = useDocRedact(docId).marks // (a stable empty document when there is none: a fresh [] per render would loop)
  const [busy, setBusy] = useState<null | 'preview' | 'apply'>(null)
  const [progress, setProgress] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const token = useRef(0)

  useEffect(() => {
    setPreview(null)
    setFailure(null)
    setBusy(null)
    token.current++
  }, [docId])

  // Changing an option invalidates a preview made with the old ones.
  useEffect(() => {
    setPreview(null)
  }, [settings])

  if (!docId) return null
  const close = (): void => {
    if (busy === 'apply') return
    token.current++
    useRedact.getState().openDialog(null)
  }
  const pages = pagesOf(marks)
  const runPreview = async (): Promise<void> => {
    const my = ++token.current
    setBusy('preview')
    setFailure(null)
    setPreview(null)
    const r = await previewRedactions(docId, marks, (d, t) => setProgress(`Redacting page ${d} of ${t}…`))
    if (my !== token.current) return
    setBusy(null)
    setProgress('')
    if (r.ok) setPreview(r)
    else setFailure(r)
  }
  const runApply = async (): Promise<void> => {
    const my = ++token.current
    setBusy('apply')
    setFailure(null)
    const r = await applyRedactions(docId, marks, (d, t) => setProgress(`Redacting page ${d} of ${t}…`))
    if (my !== token.current) return
    setBusy(null)
    setProgress('')
    if (r.ok) {
      const s = useRedact.getState()
      s.openDialog(null)
      s.resetDoc(docId)
      s.announce(`Redaction applied. ${r.summary}`)
      notify('success', `${r.summary} Save the file to make the redaction permanent.`)
    } else setFailure(r)
  }

  return (
    <Modal title="Apply redactions" onClose={close} wide>
      <div className="space-y-3 text-sm" data-testid="redact-dialog">
        <p>
          <strong data-testid="redact-dialog-count">
            {marks.length} {marks.length === 1 ? 'mark' : 'marks'}
          </strong>{' '}
          ({totalRects(marks)} {totalRects(marks) === 1 ? 'area' : 'areas'}) on {pages.length} {pages.length === 1 ? 'page' : 'pages'} will be removed for good: the text, the parts of images and drawings under them, and matching annotations, bookmarks and metadata.
        </p>

        <fieldset className="rounded-md border border-line p-2">
          <legend className="px-1 text-xs font-semibold text-ink-muted">Appearance</legend>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1">
              <span>Fill colour</span>
              <input type="color" aria-label="Fill colour" className="h-8 w-10 rounded border border-line bg-surface" value={settings.fill} onChange={(e) => patch({ fill: e.target.value })} />
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="redact-overlay" checked={settings.overlay === 'none'} onChange={() => patch({ overlay: 'none' })} />
              <span>No text</span>
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="redact-overlay" checked={settings.overlay === 'redacted'} onChange={() => patch({ overlay: 'redacted' })} />
              <span>“REDACTED”</span>
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="redact-overlay" checked={settings.overlay === 'custom'} onChange={() => patch({ overlay: 'custom' })} />
              <span>Custom text</span>
            </label>
            <input aria-label="Custom overlay text" dir="auto" className="field w-40 select-text" disabled={settings.overlay !== 'custom'} value={settings.custom} maxLength={40} onChange={(e) => patch({ custom: e.target.value })} />
          </div>
        </fieldset>

        <fieldset className="rounded-md border border-line p-2">
          <legend className="px-1 text-xs font-semibold text-ink-muted">Also remove</legend>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={settings.removeMetadata} onChange={(e) => patch({ removeMetadata: e.target.checked })} />
            <span>
              <strong>All metadata</strong>: document properties, XMP, thumbnails and private application data. (Metadata that mentions redacted text is always cleaned.)
            </span>
          </label>
          <label className="mt-1 flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={settings.removeHidden} onChange={(e) => patch({ removeHidden: e.target.checked })} />
            <span>
              <strong>Hidden data</strong>: attachments, JavaScript, page labels, form tooltips and XFA data.
            </span>
          </label>
        </fieldset>

        <p role="note" className="rounded-md border border-line bg-surface-alt p-2 text-xs" data-testid="redact-irreversible-note">
          Applying is one undo step, but only until you save: <strong>a saved redaction cannot be undone</strong>. Epdf keeps earlier versions of a file in its version history, which still contain the original content; after you save you will be offered to purge that history.
        </p>

        <div role="status" aria-live="polite" className="min-h-5 text-xs text-ink-muted" data-testid="redact-progress">
          {busy === 'preview' ? `Preparing the preview… ${progress}` : busy === 'apply' ? `Applying… ${progress}` : ''}
        </div>

        {failure && (
          <div role="alert" className="rounded-md border border-red-600 bg-red-50 p-2 text-red-900 dark:bg-red-950 dark:text-red-100" data-testid="redact-error">
            <p className="font-semibold">{failure.kind === 'verify' ? 'Not applied: the self-check found redacted content that would remain.' : failure.kind === 'refused' ? 'Not applied: this document cannot be redacted safely.' : 'Not applied.'}</p>
            <p className="mt-1">{failure.message}</p>
            {failure.findings && (
              <ul className="mt-1 list-disc pl-5" data-testid="redact-findings">
                {failure.findings.slice(0, 12).map((f, i) => (
                  <li key={i}>
                    <span className="font-medium">{f.where}:</span> {f.detail}
                  </li>
                ))}
                {failure.findings.length > 12 && <li>…and {failure.findings.length - 12} more.</li>}
              </ul>
            )}
          </div>
        )}

        {preview && (
          <div data-testid="redact-preview-result">
            <p className="font-medium" data-testid="redact-summary">
              {summarize(preview.report)}
            </p>
            {preview.report.warnings.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-ink-muted">
                {preview.report.warnings.slice(0, 6).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <p className={`mt-1 ${preview.findings.length ? 'text-red-700 dark:text-red-400' : 'text-green-800 dark:text-green-300'}`} data-testid="redact-selfcheck">
              {preview.findings.length ? `Self-check FAILED (${preview.findings.length} finding${preview.findings.length === 1 ? '' : 's'}): applying is blocked until this is resolved.` : 'Self-check passed: the redacted text, images and metadata were not found anywhere in the result.'}
            </p>
            {preview.findings.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs" data-testid="redact-findings">
                {preview.findings.slice(0, 12).map((f, i) => (
                  <li key={i}>
                    <span className="font-medium">{f.where}:</span> {f.detail}
                  </li>
                ))}
              </ul>
            )}
            <Preview docId={docId} afterBytes={preview.bytes} marks={marks} />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={close} disabled={busy === 'apply'}>
            Cancel
          </button>
          <button type="button" className="btn" data-testid="redact-preview-button" disabled={busy !== null || marks.length === 0} onClick={() => void runPreview()}>
            Preview
          </button>
          <button type="button" className="btn-primary" data-testid="redact-apply-button" disabled={busy !== null || marks.length === 0 || (preview !== null && preview.findings.length > 0)} onClick={() => void runApply()}>
            Apply redactions
          </button>
        </div>
      </div>
    </Modal>
  )
}
