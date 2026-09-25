import type { SignatureKind, SignatureMethod } from '@shared/features/sign'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Modal } from '../../components/Modal'
import { askConfirm } from '../../state/confirm'
import { activeTab } from '../../state/actions'
import { errorMessage, notify } from '../../state/notify'
import { useUi } from '../../state/ui'
import { useWorkspace } from '../../state/workspace'
import type { SignatureImage } from './canvasUtil'
import { DrawPad, ImportPad, TypePad } from './Pads'
import { useSignatures } from './store'

/** Said everywhere a signature is created or placed: this is an image, not a certificate-based signature. */
export const VISUAL_SIGNATURE_NOTICE =
  'This is a visual signature: a picture of your signature placed on the page. It is not a cryptographic digital signature, so it does not prove who signed and does not detect later changes to the document.'

const METHODS: { id: SignatureMethod; label: string }[] = [
  { id: 'draw', label: 'Draw' },
  { id: 'type', label: 'Type' },
  { id: 'import', label: 'Import image' }
]

export function SignatureDialog(): JSX.Element | null {
  const open = useSignatures((s) => s.dialogOpen)
  const close = useSignatures((s) => s.closeDialog)
  const refresh = useSignatures((s) => s.refresh)

  useEffect(() => {
    if (open) refresh().catch((e) => notify('error', `Couldn’t load your signatures: ${errorMessage(e)}`))
  }, [open, refresh])

  if (!open) return null
  return <DialogBody close={close} />
}

function DialogBody({ close }: { close(): void }): JSX.Element {
  const items = useSignatures((s) => s.items)
  const encryptionAvailable = useSignatures((s) => s.encryptionAvailable)
  const dialogKind = useSignatures((s) => s.dialogKind)
  const save = useSignatures((s) => s.save)
  const remove = useSignatures((s) => s.remove)

  const [kind, setKind] = useState<SignatureKind>(dialogKind)
  const [method, setMethod] = useState<SignatureMethod>('draw')
  const [name, setName] = useState('')
  const [image, setImage] = useState<SignatureImage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [padKey, setPadKey] = useState(0)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const onImage = useCallback((img: SignatureImage | null) => setImage(img), [])
  const blocked = encryptionAvailable === false

  const pickMethod = (m: SignatureMethod): void => {
    setMethod(m)
    setImage(null)
    setError(null)
  }
  const onTabKey = (e: KeyboardEvent, i: number): void => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = METHODS[(i + d + METHODS.length) % METHODS.length]
    pickMethod(next.id)
    tabRefs.current[next.id]?.focus()
  }

  const onSave = async (): Promise<void> => {
    if (!image) return
    setSaving(true)
    setError(null)
    try {
      const label = name.trim() || `${kind === 'signature' ? 'Signature' : 'Initials'} ${items.filter((i) => i.kind === kind).length + 1}`
      const res = await save({ name: label, kind, method, png: image.png, width: image.width, height: image.height })
      if (!res.ok) {
        setError(res.message)
      } else {
        useUi.getState().announce(`${kind === 'signature' ? 'Signature' : 'Initials'} “${label}” saved`)
        setName('')
        setImage(null)
        setPadKey((k) => k + 1)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const use = (id: number, k: SignatureKind): void => {
    useSignatures.getState().select(k, id)
    close()
    const tab = activeTab()
    if (tab) useWorkspace.getState().setActiveTool(k === 'signature' ? 'sign.signature' : 'sign.initials', tab.docId)
  }

  const del = async (id: number, label: string): Promise<void> => {
    const answer = await askConfirm({
      title: 'Delete signature?',
      message: `“${label}” will be removed from this computer. Documents you already signed are not affected.`,
      buttons: [
        { label: 'Delete', value: 'delete', variant: 'danger' },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    })
    if (answer !== 'delete') return
    try {
      await remove(id)
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  return (
    <Modal title="Signatures" onClose={close} wide>
      <p className="mb-3 rounded-md border border-line bg-surface-alt px-3 py-2 text-sm" data-testid="visual-signature-notice">
        {VISUAL_SIGNATURE_NOTICE}
      </p>

      {blocked && (
        <p role="alert" data-testid="encryption-unavailable" className="mb-3 rounded-md border border-red-500/60 px-3 py-2 text-sm">
          Your system’s secure storage isn’t available, so a signature can’t be saved safely. Epdf never stores signatures without
          encryption. On Linux, install and unlock a keyring (for example GNOME Keyring or KWallet), then reopen this window.
        </p>
      )}

      <section aria-label="Saved signatures" className="mb-4">
        <h3 className="mb-1 text-sm font-semibold">Saved</h3>
        {items.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing saved yet. Create a signature or initials below. They are stored encrypted on this computer only.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line" data-testid="signature-list">
            {items.map((it) => (
              <li key={it.id} className="flex items-center gap-3 px-3 py-2" data-signature={it.id}>
                <img src={it.url} alt={`${it.name} (${it.kind})`} className="h-10 max-w-[9rem] rounded bg-white object-contain p-1" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{it.name}</span>
                  <span className="text-xs text-ink-muted">{it.kind === 'signature' ? 'Signature' : 'Initials'}</span>
                </span>
                <button type="button" className="btn" onClick={() => use(it.id, it.kind)}>
                  Use
                </button>
                <button type="button" className="btn" aria-label={`Delete ${it.name}`} onClick={() => void del(it.id, it.name)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Create a signature">
        <h3 className="mb-2 text-sm font-semibold">Create new</h3>
        <fieldset className="mb-3 flex gap-4">
          <legend className="sr-only">What to create</legend>
          {(['signature', 'initials'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input type="radio" name="sig-kind" autoFocus={kind === k} checked={kind === k} onChange={() => setKind(k)} />
              {k === 'signature' ? 'Signature' : 'Initials'}
            </label>
          ))}
        </fieldset>

        <div role="tablist" aria-label="How to create it" className="mb-3 flex gap-1 border-b border-line">
          {METHODS.map((m, i) => (
            <button
              key={m.id}
              ref={(el) => {
                tabRefs.current[m.id] = el
              }}
              type="button"
              role="tab"
              id={`sig-tab-${m.id}`}
              aria-selected={method === m.id}
              aria-controls="sig-panel"
              tabIndex={method === m.id ? 0 : -1}
              className="-mb-px rounded-t-md border border-b-0 border-transparent px-3 py-1.5 outline-none hover:bg-surface-alt focus-visible:ring-2 focus-visible:ring-accent aria-selected:border-line aria-selected:bg-raised aria-selected:font-medium"
              onClick={() => pickMethod(m.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div id="sig-panel" role="tabpanel" aria-labelledby={`sig-tab-${method}`}>
          {method === 'draw' && <DrawPad key={`d${padKey}`} onChange={onImage} />}
          {method === 'type' && <TypePad key={`t${padKey}`} onChange={onImage} />}
          {method === 'import' && <ImportPad key={`i${padKey}`} onChange={onImage} />}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex min-w-[12rem] flex-1 flex-col text-xs">
            Name
            <input className="field mt-1" value={name} maxLength={60} placeholder={kind === 'signature' ? 'My signature' : 'My initials'} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <button type="button" className="btn-primary" disabled={!image || blocked || saving} onClick={() => void onSave()}>
            Save {kind === 'signature' ? 'signature' : 'initials'}
          </button>
        </div>
        {error && (
          <p role="alert" data-testid="signature-error" className="mt-2 text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </section>

      <div className="mt-5 flex justify-end">
        <button type="button" className="btn" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  )
}
