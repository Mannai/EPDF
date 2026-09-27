import { useEffect, useMemo, useRef } from 'react'
import { FILTERS, SORT_KEYS, type LibraryFilter, type LibraryItem, type SortKey } from '@shared/features/library'
import { IconClose, IconSearch } from '../../components/Icons'
import { askConfirm } from '../../state/confirm'
import { errorMessage, notify } from '../../state/notify'
import { libraryApi } from './api'
import { AddToFolderDialog, FolderNameDialog, SettingsDialog } from './Dialogs'
import { ContentResults } from './ContentResults'
import { confirmRemove, FileGrid } from './FileGrid'
import { formatCount, plural } from './format'
import { CloudIcon, GridIcon, ListIcon, SettingsIcon, WarnIcon } from './icons'
import {
  addFolder,
  addSuggested,
  applySort,
  askAddToFolder,
  closeLibrary,
  openRefs,
  refreshList,
  refreshState,
  revealRef,
  runSearch,
  selectedItems,
  setFavorite,
  setFilter,
  setFolderDialog,
  setMode,
  setQuery,
  setScope,
  setSettingsOpen,
  setView,
  useLibrary,
  type Mode
} from './store'
import { Sidebar } from './Sidebar'

const SORT_LABELS: Record<SortKey, string> = { name: 'Name', folder: 'Folder', size: 'Size', modified: 'Date modified', pages: 'Pages', added: 'Date added', opened: 'Last opened' }
const FILTER_LABELS: Record<LibraryFilter, string> = { all: 'All files', cloud: 'Cloud only', notIndexable: 'Not searchable (unreadable)', noText: 'No text (scanned)', tooLarge: 'Too large to index' }

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not(button):not(input)'

function scopeTitle(): string {
  const s = useLibrary.getState()
  const scope = s.scope
  switch (scope.kind) {
    case 'all':
      return 'All files'
    case 'recent':
      return 'Recent'
    case 'favorites':
      return 'Favorites'
    case 'root': {
      const root = s.state?.roots.find((r) => r.id === scope.rootId)
      return `${root?.label ?? 'Folder'}${scope.dir ? ` / ${scope.dir.split('/').join(' / ')}` : ''}`
    }
    case 'collection':
      return s.state?.collections.find((c) => c.id === scope.id)?.name ?? 'Folder'
  }
}

/** The files the toolbar acts on: the selection, or the row with the cursor. */
function targets(): LibraryItem[] {
  const s = useLibrary.getState()
  const sel = selectedItems()
  if (sel.length > 0) return sel
  const a = s.items[s.active]
  return a ? [a] : []
}

function ScopeBar(): JSX.Element {
  const scope = useLibrary((s) => s.scope)
  const state = useLibrary((s) => s.state)
  const sort = useLibrary((s) => s.sort)
  const descending = useLibrary((s) => s.descending)
  const filter = useLibrary((s) => s.filter)
  const view = useLibrary((s) => s.view)
  const mode = useLibrary((s) => s.mode)
  const total = useLibrary((s) => s.total)
  useLibrary((s) => s.state?.collections)
  const title = scopeTitle()
  const root = scope.kind === 'root' ? state?.roots.find((r) => r.id === scope.rootId) : undefined

  const removeFolder = async (): Promise<void> => {
    if (!root) return
    const c = await askConfirm({
      title: `Remove “${root.label}” from the library?`,
      message: 'Its files disappear from the library and from search results, and their index is deleted. The folder and its PDFs on your computer are not touched.',
      buttons: [{ label: 'Remove folder', value: 'remove', variant: 'danger' }, { label: 'Cancel', value: 'cancel' }],
      cancelValue: 'cancel'
    })
    if (c !== 'remove') return
    try {
      await libraryApi.removeFolder(root.id)
      setScope({ kind: 'all' })
      await refreshState()
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  const collection = scope.kind === 'collection' ? state?.collections.find((c) => c.id === scope.id) : undefined
  const deleteCollection = async (): Promise<void> => {
    if (!collection) return
    const c = await askConfirm({
      title: `Delete the folder “${collection.name}”?`,
      message: 'Only the folder (and any folders inside it) is deleted from the library. The files stay in the library and on your computer.',
      buttons: [{ label: 'Delete folder', value: 'delete', variant: 'danger' }, { label: 'Cancel', value: 'cancel' }],
      cancelValue: 'cancel'
    })
    if (c !== 'delete') return
    try {
      const r = await libraryApi.deleteCollection(collection.id)
      if (!r.ok) notify('error', r.error)
      setScope({ kind: 'all' })
      await refreshState()
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  return (
    <div className="border-b border-line px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="min-w-0 truncate text-base font-semibold" data-testid="scope-title">
          {title}
        </h3>
        <span className="text-sm text-ink-muted" data-testid="scope-count">
          {mode === 'names' ? plural(total, 'file') : ''}
        </span>
        {root && (
          <>
            <button type="button" className="btn h-7 px-2 text-xs" onClick={() => void libraryApi.rescan(root.id)}>
              Rescan
            </button>
            <button type="button" className="btn h-7 px-2 text-xs" onClick={() => void removeFolder()}>
              Remove folder…
            </button>
          </>
        )}
        {collection && (
          <>
            <button type="button" className="btn h-7 px-2 text-xs" onClick={() => setFolderDialog({ kind: 'rename', id: collection.id, name: collection.name })}>
              Rename…
            </button>
            <button type="button" className="btn h-7 px-2 text-xs" onClick={() => setFolderDialog({ kind: 'new', parentId: collection.id })}>
              New folder inside…
            </button>
            <button type="button" className="btn h-7 px-2 text-xs" onClick={() => void deleteCollection()}>
              Delete folder…
            </button>
          </>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-sm">
            <span className="text-ink-muted">Sort</span>
            <select className="field" value={sort} onChange={(e) => applySort(e.target.value as SortKey, false)} aria-label="Sort by" disabled={mode === 'content'}>
              {SORT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-icon" aria-pressed={descending} aria-label="Descending order" title="Descending order" onClick={() => applySort(sort, !descending)} disabled={mode === 'content'}>
            <span aria-hidden="true">{descending ? '▼' : '▲'}</span>
          </button>
          <label className="flex items-center gap-1 text-sm">
            <span className="text-ink-muted">Show</span>
            <select className="field" value={filter} onChange={(e) => setFilter(e.target.value as LibraryFilter)} aria-label="Show only" disabled={mode === 'content'}>
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {FILTER_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <div role="group" aria-label="View" className="flex">
            <button type="button" className="btn-icon" aria-pressed={view === 'list'} aria-label="List view" title="List view" onClick={() => setView('list')}>
              <ListIcon />
            </button>
            <button type="button" className="btn-icon" aria-pressed={view === 'grid'} aria-label="Thumbnail view" title="Thumbnail view" onClick={() => setView('grid')}>
              <GridIcon />
            </button>
          </div>
        </div>
      </div>
      {root && root.status !== 'ok' && (
        <p className="mt-1 flex items-center gap-1 text-sm text-danger" role="alert">
          <WarnIcon />
          {root.status === 'missing' ? 'This folder is not available right now (is the drive connected?). Its files are kept and searchable; they cannot be opened until it is back.' : 'This folder cannot be read.'} {root.note}
        </p>
      )}
      {root && root.status === 'ok' && root.note && <p className="mt-1 text-xs text-ink-muted">{root.note}</p>}
    </div>
  )
}

function ActionBar(): JSX.Element {
  const mode = useLibrary((s) => s.mode)
  const scope = useLibrary((s) => s.scope)
  const selected = useLibrary((s) => s.selected)
  const active = useLibrary((s) => s.active)
  const items = useLibrary((s) => s.items)
  const hits = useLibrary((s) => s.hits)
  useLibrary((s) => s.total)

  const t = useMemo(() => targets(), [selected, active, items]) // eslint-disable-line react-hooks/exhaustive-deps
  const hit = mode === 'content' ? hits[active] : undefined
  const n = mode === 'content' ? (hit ? 1 : 0) : t.length
  const one = n === 1 ? (mode === 'content' ? undefined : t[0]) : undefined
  const allFav = t.length > 0 && t.every((i) => i.favorite)
  const canLib = t.some((i) => i.inLibrary)

  return (
    <div role="toolbar" aria-label="File actions" className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-alt px-4 py-1.5">
      <button
        type="button"
        className="btn-primary"
        disabled={n === 0}
        onClick={() => (hit ? void openRefs([hit.ref], { page: hit.page, term: hit.term }) : void openRefs(t.map((i) => i.ref)))}
      >
        {n > 1 ? `Open ${n} files` : hit ? `Open at page ${hit.page}` : 'Open'}
      </button>
      <button type="button" className="btn" disabled={n !== 1} onClick={() => void revealRef(hit ? hit.ref : one!.ref)}>
        Show in folder
      </button>
      {mode === 'names' && (
        <>
          <button type="button" className="btn" aria-pressed={allFav} disabled={t.length === 0} onClick={() => void setFavorite(t.map((i) => i.ref), !allFav)}>
            {allFav ? 'Unfavorite' : 'Favorite'}
          </button>
          <button type="button" className="btn" disabled={!canLib} onClick={() => askAddToFolder(t.filter((i) => i.inLibrary).map((i) => i.ref))} title={t.length > 0 && !canLib ? 'Only files in a watched folder can be added to library folders' : undefined}>
            Add to folder…
          </button>
          {scope.kind === 'collection' && (
            <button
              type="button"
              className="btn"
              disabled={t.length === 0}
              onClick={async () => {
                const r = await libraryApi.removeFromCollection(scope.id, t.map((i) => i.ref))
                if (!r.ok) notify('error', r.error)
                await refreshList(true)
                void refreshState()
              }}
            >
              Remove from this folder
            </button>
          )}
          {one && one.state === 'too_large' && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void libraryApi.indexAnyway(one.ref).catch((e) => notify('error', errorMessage(e)))
              }}
            >
              Index anyway
            </button>
          )}
          <button type="button" className="btn" disabled={t.length === 0} onClick={() => void confirmRemove(t)}>
            Remove from library…
          </button>
        </>
      )}
      <span className="ml-auto text-sm text-ink-muted" aria-hidden="true">
        {mode === 'names' ? (selected.length > 1 ? `${selected.length} selected` : '') : ''}
      </span>
    </div>
  )
}

function StatusBar(): JSX.Element {
  const state = useLibrary((s) => s.state)
  const st = state?.status
  const c = state?.counts
  return (
    <footer className="flex items-center gap-3 border-t border-line bg-surface-alt px-4 py-1.5 text-sm">
      <div role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-3" data-testid="library-status">
        {st?.running ? (
          <>
            <progress className="h-1.5 w-40 shrink-0" value={st.total > 0 ? st.done : undefined} max={st.total > 0 ? st.total : undefined} aria-label="Indexing progress" />
            <span className="truncate" data-testid="indexing-message">
              {st.message || 'Indexing…'}
            </span>
            <button type="button" className="btn h-7 px-2 text-xs" onClick={() => void libraryApi.cancel()}>
              Cancel indexing
            </button>
          </>
        ) : (
          <span className="truncate text-ink-muted" data-testid="idle-message">
            {st?.message ?? ''}
          </span>
        )}
      </div>
      {c && (
        <span className="shrink-0 text-ink-muted" data-testid="library-counts">
          {formatCount(c.indexed)} of {plural(c.all, 'file')} searchable
          {c.noText + c.notIndexable > 0 ? ` · ${formatCount(c.noText + c.notIndexable)} not searchable` : ''}
          {c.cloudOnly > 0 ? ` · ${formatCount(c.cloudOnly)} cloud only` : ''}
        </span>
      )}
    </footer>
  )
}

function Welcome(): JSX.Element {
  const suggestions = useLibrary((s) => s.suggestions).filter((s) => !s.added)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10" data-testid="library-welcome">
      <h3 className="text-xl font-semibold">Your library is empty</h3>
      <p className="mt-2 max-w-lg text-center text-ink-muted">Add the folders where your PDFs live. Epdf indexes their names and text on this computer so you can find any file, and any page, instantly. Nothing leaves your computer.</p>
      <button type="button" className="btn-primary mt-5 h-10 px-5" onClick={() => void addFolder()}>
        Add folder…
      </button>
      {suggestions.length > 0 && (
        <section aria-labelledby="lib-welcome-suggest" className="mt-8 w-full max-w-xl">
          <h4 id="lib-welcome-suggest" className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Folders found on this computer
          </h4>
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {suggestions.map((s) => (
              <li key={s.key} className="flex items-center gap-3 px-3 py-2">
                <span className="text-ink-muted">{s.cloud ? <CloudIcon /> : null}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.label}</span>
                  <span className="block truncate text-xs text-ink-muted">{s.path}</span>
                </span>
                <button type="button" className="btn" aria-label={`Add ${s.label} (${s.path}) to the library`} onClick={() => void addSuggested(s.key)}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export function LibraryDialog(): JSX.Element | null {
  const open = useLibrary((s) => s.open)
  const mode = useLibrary((s) => s.mode)
  const query = useLibrary((s) => s.query)
  const total = useLibrary((s) => s.total)
  const loading = useLibrary((s) => s.loading)
  const state = useLibrary((s) => s.state)
  const scope = useLibrary((s) => s.scope)
  const announcement = useLibrary((s) => s.announcement)
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<Element | null>(null)
  const firstRun = useRef(true)

  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement
    firstRun.current = true
    return () => (returnFocus.current as HTMLElement | null)?.focus?.()
  }, [open])

  // Typing: names filter the list at once; content searches run a moment after typing stops.
  useEffect(() => {
    if (!open) return
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const t = setTimeout(() => (mode === 'names' ? void refreshList() : void runSearch()), mode === 'names' ? 120 : 300)
    return () => clearTimeout(t)
  }, [query, open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const el = root.current
    if (!el) return
    if ((e.target as HTMLElement).closest('[role="dialog"]') !== el) return // a nested dialog looks after itself
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (e.target === search.current && query) setQuery('')
      else closeLibrary()
    } else if (e.key === 'Tab') {
      // Radio buttons: only the checked one of a group is reachable with Tab.
      const f = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => (x.offsetParent !== null || x === document.activeElement) && !(x instanceof HTMLInputElement && x.type === 'radio' && !x.checked))
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const empty = state && total === 0 && !loading && mode === 'names'
  const noRoots = !!state && state.roots.length === 0 && scope.kind === 'all' && !query.trim() && state.counts.recent === 0
  const emptyText =
    query.trim() ? `No files match “${query.trim()}”.` : scope.kind === 'recent' ? 'Files you open show up here.' : scope.kind === 'favorites' ? 'Star a file to keep it here.' : scope.kind === 'collection' ? 'This folder is empty. Drag files onto it, or select files and choose “Add to folder…”.' : 'No files here.'

  return (
    <>
    {/* Windows: keep the title bar strip draggable but inert while the library covers the window (index.css). */}
    <div aria-hidden="true" className="overlay-titlebar-guard z-50" />
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="Library"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="app-overlay fixed inset-0 z-50 flex flex-col bg-surface text-ink"
      data-testid="library"
    >
      <header className="flex items-center gap-3 border-b border-line px-4 py-2">
        <h2 className="text-lg font-semibold">Library</h2>
        <div role="search" aria-label="Search the library" className="flex min-w-0 flex-1 items-center gap-3">
          <div className="relative min-w-0 max-w-xl flex-1">
            <label htmlFor="lib-search" className="sr-only">
              {mode === 'names' ? 'Search file names' : 'Search text inside files'}
            </label>
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted">
              <IconSearch />
            </span>
            <input
              id="lib-search"
              ref={search}
              autoFocus
              type="text"
              autoComplete="off"
              spellCheck={false}
              className="field w-full pl-8"
              placeholder={mode === 'names' ? 'Search file names' : 'Search text inside your files'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && mode === 'content') {
                  e.preventDefault()
                  void runSearch()
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  document.querySelector<HTMLElement>('[role="grid"][aria-label="Files"], [role="listbox"][aria-label="Search results"]')?.focus()
                }
              }}
            />
          </div>
          <fieldset className="flex shrink-0 items-center gap-1">
            <legend className="sr-only">Search in</legend>
            {(['names', 'content'] as Mode[]).map((m) => (
              <label key={m} className="relative">
                <input type="radio" name="lib-mode" className="peer sr-only" checked={mode === m} onChange={() => setMode(m)} />
                <span className="inline-flex h-8 cursor-pointer items-center rounded-md border border-line px-3 peer-checked:border-accent peer-checked:bg-accent/15 peer-checked:font-semibold peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
                  {m === 'names' ? 'File names' : 'Text inside files'}
                </span>
              </label>
            ))}
          </fieldset>
        </div>
        <button type="button" className="btn-icon" aria-label="Library settings" title="Library settings" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon />
        </button>
        <button type="button" className="btn" onClick={closeLibrary}>
          <IconClose />
          Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <ScopeBar />
          <ActionBar />
          {mode === 'content' ? (
            <ContentResults />
          ) : noRoots && empty ? (
            <Welcome />
          ) : empty ? (
            <p className="px-6 py-10 text-center text-ink-muted" data-testid="library-empty">
              {emptyText}
            </p>
          ) : (
            <FileGrid />
          )}
        </main>
      </div>
      <StatusBar />
      <div className="sr-only" role="status" aria-live="polite" data-testid="library-announce">
        {announcement}
      </div>
      <AddToFolderDialog />
      <FolderNameDialog />
      <SettingsDialog />
    </div>
    </>
  )
}
