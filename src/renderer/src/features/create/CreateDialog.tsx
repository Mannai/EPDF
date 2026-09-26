import { useId } from 'react'
import { Modal } from '../../components/Modal'
import { EngineChoice } from './EngineChoice'
import { describeKind, isImageLike, isOffice, runCreateFiles, runCreateWeb, urlProblem, useCreateUi } from './flow'
import { fmtSize, plural } from './shared'

const LEGACY = /\.(doc|xls|ppt)$/i

/** "Create PDF from File…": the picked files, options for pictures and Office documents, and the go button. */
export function CreateFilesDialog(): JSX.Element | null {
  const s = useCreateUi()
  const listId = useId()
  if (s.mode !== 'files') return null
  const hasOffice = s.files.some(isOffice)
  const hasImages = s.files.some(isImageLike)
  const legacy = s.engine === 'builtin' ? s.files.filter((f) => LEGACY.test(f.name)) : []
  const n = s.files.length
  return (
    <Modal title="Create PDF from files" onClose={s.close} wide>
      <p id={listId} className="mb-2 text-sm text-ink-muted">
        {n === 1 ? 'This file will be converted to a PDF.' : `Each of these ${n} files will be converted to its own PDF.`}
      </p>
      <ul aria-labelledby={listId} className="mb-3 divide-y divide-line rounded-md border border-line" data-testid="create-files">
        {s.files.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate font-medium">{f.name}</span>
              <span className="text-xs text-ink-muted">
                {describeKind(f)} · {fmtSize(f.size)}
              </span>
            </span>
            <button type="button" className="btn" onClick={() => s.remove(f.id)} aria-label={`Remove ${f.name}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {hasImages && (
        <div className="mb-3">
          <label htmlFor="create-page-size" className="mb-1 block text-sm font-medium">
            Page size for pictures
          </label>
          <select id="create-page-size" className="field" value={s.images.pageSize} onChange={(e) => s.setImages({ pageSize: e.target.value as 'image' | 'a4' | 'letter' })}>
            <option value="image">Same size as the picture</option>
            <option value="a4">Fit on A4</option>
            <option value="letter">Fit on Letter</option>
          </select>
        </div>
      )}
      {hasOffice && <EngineChoice env={s.env} engine={s.engine} onChange={s.setEngine} idPrefix="create" />}
      {legacy.length > 0 && (
        <p role="status" className="mb-3 rounded-md border border-line bg-surface-alt p-2 text-sm" data-testid="legacy-warning">
          The built-in converter cannot read old binary files ({legacy.map((f) => f.name).join(', ')}). Save them as .docx / .xlsx / .pptx in their own program first, or choose LibreOffice.
        </p>
      )}
      {hasOffice && s.engine === 'builtin' && <p className="mb-3 text-sm text-ink-muted">Layout of Office documents is approximate.</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={s.close}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={runCreateFiles} disabled={n === 0} autoFocus>
          {n === 1 ? 'Create PDF…' : `Create ${plural(n, 'PDF')}…`}
        </button>
      </div>
    </Modal>
  )
}

/** "Create PDF from Web Page…": an address field and the safety options. */
export function CreateWebDialog(): JSX.Element | null {
  const s = useCreateUi()
  if (s.mode !== 'web') return null
  const problem = urlProblem(s.url)
  return (
    <Modal title="Create PDF from web page" onClose={s.close}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (s.url.trim() && !problem) runCreateWeb()
        }}
      >
        <label htmlFor="web-url" className="mb-1 block text-sm font-medium">
          Web address
        </label>
        <input
          id="web-url"
          autoFocus
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="example.com"
          className="field mb-1 w-full select-text"
          value={s.url}
          aria-invalid={!!problem}
          aria-describedby={problem ? 'web-url-error' : 'web-url-help'}
          onChange={(e) => s.setUrl(e.target.value)}
        />
        {problem ? (
          <p id="web-url-error" role="alert" className="mb-2 text-sm text-danger">
            {problem}
          </p>
        ) : (
          <p id="web-url-help" className="mb-2 text-sm text-ink-muted">
            Only http and https addresses work. The page opens in a private, isolated window; nothing is kept.
          </p>
        )}
        <label className="mb-4 flex items-start gap-2">
          <input type="checkbox" className="mt-1 accent-accent" checked={s.javascript} onChange={(e) => s.setJavascript(e.target.checked)} />
          <span>
            Run the page’s scripts
            <span className="block text-sm text-ink-muted">Turn this off for a simpler snapshot that does not execute anything from the website.</span>
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={s.close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!s.url.trim() || !!problem}>
            Create PDF…
          </button>
        </div>
      </form>
    </Modal>
  )
}
