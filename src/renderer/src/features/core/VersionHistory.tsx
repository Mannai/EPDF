import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { VersionInfo } from '@shared/types'
import { Modal } from '../../components/Modal'
import { replaceBytes } from '../../edit/session'
import { errorMessage, notify } from '../../state/notify'

export const useVersionHistory = create<{ docId: string | null; open(docId: string): void; close(): void }>((set) => ({
  docId: null,
  open: (docId) => set({ docId }),
  close: () => set({ docId: null })
}))

const fmtSize = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Lists the on-disk versions Epdf kept before each save, and restores one as an (undoable) edit. */
export function VersionHistoryDialog(): JSX.Element | null {
  const docId = useVersionHistory((s) => s.docId)
  const close = useVersionHistory((s) => s.close)
  const [versions, setVersions] = useState<VersionInfo[] | null>(null)

  useEffect(() => {
    setVersions(null)
    if (!docId) return
    window.epdf.listVersions(docId).then(setVersions, (e) => {
      notify('error', errorMessage(e))
      close()
    })
  }, [docId, close])

  if (!docId) return null

  const restore = async (v: VersionInfo): Promise<void> => {
    const bytes = await window.epdf.readVersion(docId, v.id)
    if (!bytes) return void notify('error', 'That version is no longer available.')
    replaceBytes(docId, `Restore version from ${new Date(v.savedAt).toLocaleString()}`, bytes)
    notify('info', 'Version restored. Save to keep it, or Undo to go back.')
    close()
  }

  return (
    <Modal title="Version history" onClose={close} wide>
      <p className="mb-3 text-sm text-ink-muted">
        Epdf keeps a copy of the file as it was before each save. Restoring a version is an unsaved change you can undo.
      </p>
      {versions === null ? (
        <p role="status">Loading…</p>
      ) : versions.length === 0 ? (
        <p>No earlier versions yet. They appear after you save changes.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {versions.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>
                <span className="block font-medium">{new Date(v.savedAt).toLocaleString()}</span>
                <span className="text-xs text-ink-muted">{fmtSize(v.size)}</span>
              </span>
              <button className="btn" onClick={() => void restore(v)}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end">
        <button className="btn-primary" onClick={close} autoFocus>
          Close
        </button>
      </div>
    </Modal>
  )
}
