import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryCollection } from '@shared/features/library'
import { formatBytes } from '@shared/features/library/text'
import { Modal } from '../../components/Modal'
import { askConfirm } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { libraryApi } from './api'
import { formatCount } from './format'
import { closeAddToFolder, refreshList, refreshState, setFolderDialog, setScope, setSettingsOpen, useLibrary } from './store'

function collectionPaths(all: LibraryCollection[]): { id: number; path: string }[] {
  const byId = new Map(all.map((c) => [c.id, c]))
  const pathOf = (c: LibraryCollection): string => (c.parentId && byId.get(c.parentId) ? `${pathOf(byId.get(c.parentId)!)} / ${c.name}` : c.name)
  return all.map((c) => ({ id: c.id, path: pathOf(c) })).sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
}

/** "Add to folder…": pick a library folder (or type a new one, "Projects/Invoices" makes both levels). */
export function AddToFolderDialog(): JSX.Element | null {
  const req = useLibrary((s) => s.addToFolder)
  const collections = useLibrary((s) => s.state?.collections)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const paths = useMemo(() => collectionPaths(collections ?? []), [collections])
  useEffect(() => {
    setName('')
    setError('')
  }, [req])
  if (!req) return null

  const add = async (collectionId: number, label: string): Promise<void> => {
    setBusy(true)
    try {
      const r = await libraryApi.addToCollection(collectionId, req.refs)
      if (!r.ok) return setError(r.error)
      notify('success', r.message ?? `Added ${req.refs.length === 1 ? 'the file' : `${req.refs.length} files`} to “${label}”.`)
      closeAddToFolder()
      void refreshState()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    if (!name.trim()) return setError('Enter a name for the new folder.')
    setBusy(true)
    try {
      const r = await libraryApi.createCollection(name.trim())
      if (!r.ok || !r.id) return setError(r.ok ? 'The folder could not be created.' : r.error)
      setBusy(false)
      await add(r.id, name.trim())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Add to folder" onClose={closeAddToFolder} wide>
      {paths.length > 0 && (
        <ul className="mb-3 max-h-56 overflow-y-auto rounded-md border border-line" aria-label="Library folders">
          {paths.map((p) => (
            <li key={p.id} className="border-b border-line last:border-b-0">
              <button type="button" disabled={busy} className="w-full px-3 py-2 text-left outline-none hover:bg-surface-alt focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" onClick={() => void add(p.id, p.path)}>
                {p.path}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label className="block text-sm font-medium" htmlFor="lib-new-folder">
          New folder
        </label>
        <div className="mt-1 flex gap-2">
          <input id="lib-new-folder" className="field flex-1" value={name} placeholder="Projects/Invoices" onChange={(e) => (setName(e.target.value), setError(''))} aria-describedby="lib-new-folder-hint" />
          <button type="submit" className="btn-primary" disabled={busy}>
            Create and add
          </button>
        </div>
        <p id="lib-new-folder-hint" className="mt-1 text-xs text-ink-muted">
          Use a slash to make a folder inside another one.
        </p>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <button type="button" className="btn" onClick={closeAddToFolder}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

/** New / rename library folder. */
export function FolderNameDialog(): JSX.Element | null {
  const dlg = useLibrary((s) => s.folderDialog)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setName(dlg?.kind === 'rename' ? dlg.name : '')
    setError('')
  }, [dlg])
  if (!dlg) return null
  const close = (): void => setFolderDialog(null)
  const submit = async (): Promise<void> => {
    if (!name.trim()) return setError('Enter a name.')
    try {
      if (dlg.kind === 'new') {
        const r = await libraryApi.createCollection(name.trim(), dlg.parentId)
        if (!r.ok) return setError(r.error)
        await refreshState()
        if (r.id) setScope({ kind: 'collection', id: r.id })
      } else {
        const r = await libraryApi.renameCollection(dlg.id, name.trim())
        if (!r.ok) return setError(r.error)
        await refreshState()
      }
      close()
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Modal title={dlg.kind === 'new' ? 'New library folder' : 'Rename library folder'} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="block text-sm font-medium" htmlFor="lib-folder-name">
          Name
        </label>
        <input ref={input} id="lib-folder-name" autoFocus className="field mt-1 w-full" value={name} onChange={(e) => (setName(e.target.value), setError(''))} placeholder={dlg.kind === 'new' ? 'Projects/Invoices' : ''} aria-describedby={dlg.kind === 'new' ? 'lib-folder-hint' : undefined} />
        {dlg.kind === 'new' && (
          <p id="lib-folder-hint" className="mt-1 text-xs text-ink-muted">
            Use a slash to make a folder inside another one.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary">
            {dlg.kind === 'new' ? 'Create' : 'Rename'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Index limits, watching, statistics, and the "forget" actions. */
export function SettingsDialog(): JSX.Element | null {
  const open = useLibrary((s) => s.settingsOpen)
  const state = useLibrary((s) => s.state)
  const [mb, setMb] = useState('200')
  useEffect(() => {
    if (open && state) setMb(String(state.settings.maxFileMb))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!open || !state) return null
  const c = state.counts
  const close = (): void => setSettingsOpen(false)
  const apply = async (patch: Parameters<typeof libraryApi.settings>[0]): Promise<void> => {
    try {
      await libraryApi.settings(patch)
      await refreshState()
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const confirm = async (title: string, message: string, label: string): Promise<boolean> =>
    (await askConfirm({ title, message, buttons: [{ label, value: 'yes', variant: 'danger' }, { label: 'Cancel', value: 'no' }], cancelValue: 'no' })) === 'yes'

  return (
    <Modal title="Library settings" onClose={close} wide>
      <section aria-labelledby="lib-s-stats" className="mb-4">
        <h3 id="lib-s-stats" className="mb-1 font-semibold">
          What is indexed
        </h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
          <dt className="text-ink-muted">Files</dt>
          <dd data-testid="stat-files">{formatCount(c.all)}</dd>
          <dt className="text-ink-muted">Searchable</dt>
          <dd>{formatCount(c.indexed)}</dd>
          <dt className="text-ink-muted">Pages / words</dt>
          <dd>
            {formatCount(c.pagesIndexed)} pages · {formatCount(c.words)} words
          </dd>
          <dt className="text-ink-muted">No text (scanned)</dt>
          <dd>{formatCount(c.noText)}</dd>
          <dt className="text-ink-muted">Not readable</dt>
          <dd>{formatCount(c.notIndexable)}</dd>
          <dt className="text-ink-muted">Cloud only</dt>
          <dd>{formatCount(c.cloudOnly)}</dd>
          <dt className="text-ink-muted">Too large</dt>
          <dd>{formatCount(c.tooLarge)}</dd>
          <dt className="text-ink-muted">Database size</dt>
          <dd>{formatBytes(c.dbBytes)}</dd>
        </dl>
      </section>

      <section aria-labelledby="lib-s-opts" className="mb-4">
        <h3 id="lib-s-opts" className="mb-1 font-semibold">
          Options
        </h3>
        <div className="flex items-center gap-2">
          <label htmlFor="lib-max-mb" className="text-sm">
            Do not index files larger than
          </label>
          <input
            id="lib-max-mb"
            type="number"
            min={1}
            max={4096}
            className="field w-24"
            value={mb}
            onChange={(e) => setMb(e.target.value)}
            onBlur={() => {
              const n = Math.round(Number(mb))
              if (Number.isFinite(n) && n >= 1 && n <= 4096 && n !== state.settings.maxFileMb) void apply({ maxFileMb: n }).then(() => libraryApi.rescan())
              else setMb(String(state.settings.maxFileMb))
            }}
          />
          <span className="text-sm">MB</span>
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={state.settings.watch} onChange={(e) => void apply({ watch: e.target.checked })} />
          Watch folders for changes (otherwise they are rescanned every few minutes)
        </label>
        {state.notice && (
          <p className="mt-2 rounded-md border border-line bg-surface-alt px-3 py-2 text-sm" role="note">
            {state.notice}
          </p>
        )}
      </section>

      <section aria-labelledby="lib-s-act" className="mb-2">
        <h3 id="lib-s-act" className="mb-1 font-semibold">
          Maintenance
        </h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void libraryApi.rescan().then(() => refreshState())
            }}
          >
            Rescan all folders
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              if (!(await confirm('Rebuild the index?', 'All indexed text is deleted and every watched folder is read again. Your files, watched folders, favorites and library folders are kept.', 'Rebuild'))) return
              await libraryApi.forget(true)
              await refreshState()
              void refreshList()
            }}
          >
            Rebuild index…
          </button>
          <button
            type="button"
            className="btn text-danger"
            onClick={async () => {
              if (!(await confirm('Forget everything?', 'This clears the whole library: the watched folder list, the search index, thumbnails and your library folders. Your PDF files are not touched.', 'Forget everything'))) return
              await libraryApi.forget(false)
              await refreshState()
              void refreshList()
              close()
            }}
          >
            Forget everything…
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-muted">Everything stays on this computer: the index and thumbnails are in Epdf’s data folder and nothing is uploaded.</p>
      </section>
      <div className="mt-3 flex justify-end">
        <button type="button" className="btn-primary" onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  )
}
