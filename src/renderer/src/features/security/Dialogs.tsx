import { useEffect, useId, useState } from 'react'
import { isRestricted, type Permissions, type PrintPermission, type ProtectSettings } from '@shared/features/security'
import { Modal } from '../../components/Modal'
import { ALGORITHM_CHOICES } from './logic'
import { useInfoDialog, usePasswordPrompt, useProtectDialog } from './store'

/** The three dialogs of the Security feature, all built on the shared accessible `Modal`. */

function PasswordPromptDialog(): JSX.Element | null {
  const req = usePasswordPrompt((s) => s.request)
  const answer = usePasswordPrompt((s) => s.answer)
  const [pw, setPw] = useState('')
  useEffect(() => setPw(''), [req])
  const errId = useId()
  if (!req) return null
  return (
    <Modal title={req.title} onClose={() => answer(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          answer(pw)
        }}
      >
        <p className="mb-3 text-ink-muted">{req.message}</p>
        <input
          autoFocus
          type="password"
          aria-label="Password"
          aria-invalid={req.incorrect}
          aria-describedby={req.incorrect ? errId : undefined}
          className="field w-full select-text"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {req.incorrect && (
          <p id={errId} role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            That password is incorrect.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!pw}>
            {req.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

const PRINT_CHOICES: { value: PrintPermission; label: string }[] = [
  { value: 'high', label: 'Allowed (high resolution)' },
  { value: 'low', label: 'Low resolution only' },
  { value: 'none', label: 'Not allowed' }
]

function validate(s: { userPassword: string; ownerPassword: string; permissions: Permissions }, confirmUser: string, confirmOwner: string): string[] {
  const errors: string[] = []
  if (!s.userPassword && !s.ownerPassword) errors.push('Enter a password to open the document, a password to edit it, or both.')
  if (s.userPassword !== confirmUser) errors.push('The two “password to open” entries do not match.')
  if (s.ownerPassword !== confirmOwner) errors.push('The two “password to edit” entries do not match.')
  if (isRestricted(s.permissions) && !s.ownerPassword) {
    errors.push('To restrict printing, copying or editing, also set a password to edit. Without it nobody could ever lift the restrictions.')
  }
  return errors
}

function ProtectDialog(): JSX.Element | null {
  const req = useProtectDialog((s) => s.request)
  const answer = useProtectDialog((s) => s.answer)
  const [s, setS] = useState<ProtectSettings | null>(null)
  const [userConfirm, setUserConfirm] = useState('')
  const [ownerConfirm, setOwnerConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const ids = useId()

  useEffect(() => {
    setS(req ? { ...req.initial, permissions: { ...req.initial.permissions } } : null)
    setUserConfirm('')
    setOwnerConfirm('')
    setShow(false)
    setErrors([])
  }, [req])

  if (!req || !s) return null
  const set = (patch: Partial<ProtectSettings>): void => setS({ ...s, ...patch })
  const setPerm = (patch: Partial<Permissions>): void => setS({ ...s, permissions: { ...s.permissions, ...patch } })
  const pwType = show ? 'text' : 'password'
  const same = !!s.userPassword && s.userPassword === s.ownerPassword

  return (
    <Modal title={req.changing ? 'Change Password Protection' : 'Protect with Password'} onClose={() => answer(null)} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const problems = validate(s, userConfirm, ownerConfirm)
          setErrors(problems)
          if (problems.length === 0) answer(s)
        }}
      >
        <p className="mb-3 text-ink-muted">
          {req.changing
            ? `Set new passwords and permissions for “${req.fileName}”. Passwords you leave empty are removed.`
            : `Choose how “${req.fileName}” is protected when you save it.`}
        </p>

        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium" htmlFor={`${ids}-alg`}>
            Encryption
          </label>
          <select id={`${ids}-alg`} className="field w-full" value={s.algorithm} onChange={(e) => set({ algorithm: e.target.value as ProtectSettings['algorithm'] })}>
            {ALGORITHM_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-x-3 gap-y-2">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor={`${ids}-user`}>
              Password to open
            </label>
            <input id={`${ids}-user`} type={pwType} autoComplete="off" className="field w-full select-text" value={s.userPassword} onChange={(e) => set({ userPassword: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor={`${ids}-user2`}>
              Confirm password to open
            </label>
            <input id={`${ids}-user2`} type={pwType} autoComplete="off" className="field w-full select-text" value={userConfirm} onChange={(e) => setUserConfirm(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor={`${ids}-owner`}>
              Password to edit
            </label>
            <input id={`${ids}-owner`} type={pwType} autoComplete="off" className="field w-full select-text" value={s.ownerPassword} onChange={(e) => set({ ownerPassword: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor={`${ids}-owner2`}>
              Confirm password to edit
            </label>
            <input id={`${ids}-owner2`} type={pwType} autoComplete="off" className="field w-full select-text" value={ownerConfirm} onChange={(e) => setOwnerConfirm(e.target.value)} />
          </div>
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show passwords
          </label>
          {same && (
            <p role="status" className="col-span-2 text-sm text-ink-muted">
              Both passwords are the same, so anyone who can open the document can also change its restrictions.
            </p>
          )}
        </div>

        <fieldset className="mb-3 rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium">Permissions (apply to people who open it with the password to open)</legend>
          <div className="mb-2 flex items-center gap-2">
            <label className="text-sm" htmlFor={`${ids}-print`}>
              Printing
            </label>
            <select id={`${ids}-print`} className="field" value={s.permissions.print} onChange={(e) => setPerm({ print: e.target.value as PrintPermission })}>
              {PRINT_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.permissions.copy} onChange={(e) => setPerm({ copy: e.target.checked })} /> Copying text and images
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.permissions.edit} onChange={(e) => setPerm({ edit: e.target.checked })} /> Editing content
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={s.permissions.annotate && s.permissions.fillForms}
                onChange={(e) => setPerm({ annotate: e.target.checked, fillForms: e.target.checked })}
              />{' '}
              Comments and filling in forms
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.permissions.assemble} onChange={(e) => setPerm({ assemble: e.target.checked })} /> Page assembly (insert, delete, rotate)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={s.permissions.accessibility} onChange={(e) => setPerm({ accessibility: e.target.checked })} /> Accessibility (screen readers)
            </label>
            {s.algorithm !== 'rc4-128' && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={s.encryptMetadata} onChange={(e) => set({ encryptMetadata: e.target.checked })} /> Encrypt document metadata
              </label>
            )}
          </div>
        </fieldset>

        <p className="mb-3 text-sm text-ink-muted">
          The password to open is what keeps the content private. Permissions are only honoured by programs that choose to respect them. Epdf cannot recover a forgotten password.
        </p>

        {errors.length > 0 && (
          <div role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
            <ul className="list-disc pl-5">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            {req.changing ? 'Apply' : 'Protect'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function InfoDialog(): JSX.Element | null {
  const info = useInfoDialog((s) => s.info)
  const close = useInfoDialog((s) => s.close)
  if (!info) return null
  return (
    <Modal title="Document Security" onClose={close} wide>
      <p className="mb-3" data-testid="security-summary">
        <span className="font-medium">{info.fileName}:</span> {info.summary}
      </p>
      {info.protectedDoc && (
        <>
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {info.rows.map((r) => (
              <div key={r.label} className="contents">
                <dt className="text-ink-muted">{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mb-1 text-sm font-medium">Permissions</h3>
          <ul className="mb-3 text-sm" aria-label="Permissions">
            {info.permissions.map((p) => (
              <li key={p.label} className="flex gap-2">
                <span aria-hidden="true">{p.allowed ? '✓' : '✗'}</span>
                <span>
                  {p.label}: {p.detail}
                </span>
              </li>
            ))}
          </ul>
          {info.notes.map((n) => (
            <p key={n} className="mb-2 text-sm text-ink-muted">
              {n}
            </p>
          ))}
        </>
      )}
      <div className="mt-3 flex justify-end">
        <button type="button" className="btn-primary" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  )
}

export function SecurityDialogs(): JSX.Element {
  return (
    <>
      <PasswordPromptDialog />
      <ProtectDialog />
      <InfoDialog />
    </>
  )
}
