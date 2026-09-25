import { useEffect, useState } from 'react'
import { activeTab } from '../state/actions'
import { useTabs } from '../state/tabs'
import { useUi } from '../state/ui'
import { Modal } from './Modal'

export function PasswordDialog(): JSX.Element | null {
  const req = useUi((s) => s.passwordRequest)
  const answer = useUi((s) => s.answerPassword)
  const [pw, setPw] = useState('')
  useEffect(() => setPw(''), [req])
  if (!req) return null
  return (
    <Modal title="Password required" onClose={() => answer(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          answer(pw)
        }}
      >
        <p className="mb-3 text-ink-muted">“{req.fileName}” is password protected.</p>
        <input
          autoFocus
          type="password"
          aria-label="Document password"
          aria-invalid={req.incorrect}
          aria-describedby={req.incorrect ? 'pw-error' : undefined}
          className="field w-full select-text"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {req.incorrect && (
          <p id="pw-error" role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            That password is incorrect.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!pw}>
            Open
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function GoToPageDialog(): JSX.Element | null {
  const open = useUi((s) => s.goToPageOpen)
  const setOpen = useUi((s) => s.setGoToPageOpen)
  const [value, setValue] = useState('')
  if (!open) return null
  const tab = activeTab()
  const close = (): void => {
    setOpen(false)
    setValue('')
  }
  return (
    <Modal title="Go to page" onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const n = parseInt(value, 10)
          if (tab && Number.isFinite(n)) useTabs.getState().goToPage(tab.docId, n)
          close()
        }}
      >
        <label className="mb-1 block text-sm text-ink-muted" htmlFor="goto-input">
          Page number (1–{tab?.numPages ?? 1})
        </label>
        <input id="goto-input" autoFocus inputMode="numeric" className="field w-full" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!value}>
            Go
          </button>
        </div>
      </form>
    </Modal>
  )
}
