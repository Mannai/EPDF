import { create } from 'zustand'
import type { ContentHit, FolderSuggestion, LibraryFilter, LibraryItem, LibraryState, RootTree, Scope, SortKey } from '@shared/features/library'
import { errorMessage, notify } from '../../state/notify'
import { useSearch } from '../../state/search'
import { useTabs } from '../../state/tabs'
import { libraryApi } from './api'
import { resetThumbs } from './thumbs'

export const CHUNK = 100
export const SEARCH_PAGE = 50

export type Mode = 'names' | 'content'
export type ViewKind = 'list' | 'grid'

/** What the small text-entry dialog is for. */
export type FolderDialog = { kind: 'new'; parentId: number | null } | { kind: 'rename'; id: number; name: string } | null

interface LibraryStore {
  open: boolean
  state: LibraryState | null
  suggestions: FolderSuggestion[]
  scope: Scope
  sort: SortKey
  descending: boolean
  filter: LibraryFilter
  mode: Mode
  query: string
  view: ViewKind
  items: (LibraryItem | undefined)[]
  total: number
  loading: boolean
  hits: ContentHit[]
  hitTotal: number
  hitCapped: boolean
  hitMs: number
  hitError: string | null
  searching: boolean
  /** Selected refs (files list) or "ref#page" keys (content hits). */
  selected: string[]
  active: number
  anchor: number
  dirs: Record<number, RootTree['dirs']>
  expanded: Record<string, boolean>
  addToFolder: { refs: string[] } | null
  folderDialog: FolderDialog
  settingsOpen: boolean
  /** Screen-reader announcement (polite live region). */
  announcement: string
}

const PREFS_KEY = 'epdf.library.prefs'

interface Prefs {
  scope: Scope
  sort: SortKey
  descending: boolean
  view: ViewKind
  filter: LibraryFilter
}

function loadPrefs(): Partial<Prefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? (JSON.parse(raw) as Partial<Prefs>) : {}
  } catch {
    return {}
  }
}

function savePrefs(s: LibraryStore): void {
  try {
    const prefs: Prefs = { scope: s.scope, sort: s.sort, descending: s.descending, view: s.view, filter: s.filter }
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* storage unavailable: preferences just are not remembered */
  }
}

export const useLibrary = create<LibraryStore>(() => ({
  open: false,
  state: null,
  suggestions: [],
  scope: { kind: 'all' },
  sort: 'name',
  descending: false,
  filter: 'all',
  mode: 'names',
  query: '',
  view: 'list',
  items: [],
  total: 0,
  loading: false,
  hits: [],
  hitTotal: 0,
  hitCapped: false,
  hitMs: 0,
  hitError: null,
  searching: false,
  selected: [],
  active: -1,
  anchor: -1,
  dirs: {},
  expanded: {},
  addToFolder: null,
  folderDialog: null,
  settingsOpen: false,
  announcement: ''
}))

const set = useLibrary.setState
const get = useLibrary.getState
const announce = (announcement: string): void => set({ announcement })

// ---- opening and closing ---------------------------------------------------------------------------------------------------

export async function openLibrary(): Promise<void> {
  const prefs = loadPrefs()
  set({
    open: true,
    scope: prefs.scope ?? { kind: 'all' },
    sort: prefs.sort ?? 'name',
    descending: prefs.descending ?? false,
    view: prefs.view ?? 'list',
    filter: prefs.filter ?? 'all',
    mode: 'names',
    query: '',
    selected: [],
    active: -1,
    anchor: -1,
    hits: [],
    hitError: null
  })
  await refreshState()
  const s = get()
  // A remembered folder that no longer exists falls back to "All files".
  const gone = s.scope.kind === 'root' ? !s.state?.roots.some((r) => r.id === (s.scope as { rootId: number }).rootId) : s.scope.kind === 'collection' ? !s.state?.collections.some((c) => c.id === (s.scope as { id: number }).id) : false
  if (gone) set({ scope: { kind: 'all' } })
  void refreshList()
}

export function closeLibrary(): void {
  resetThumbs()
  set({ open: false, items: [], hits: [], addToFolder: null, folderDialog: null, settingsOpen: false })
}

export async function refreshState(): Promise<void> {
  try {
    const [state, suggestions] = await Promise.all([libraryApi.state(), libraryApi.suggestions()])
    set({ state, suggestions })
  } catch (err) {
    notify('error', `The library could not be loaded: ${errorMessage(err)}`)
  }
}

// ---- the file list (paged from main, kept sparse) ----------------------------------------------------------------------------

let listSeq = 0
const loadedChunks = new Set<number>()
const loadingChunks = new Set<number>()

const listRequest = (offset: number) => {
  const s = get()
  return { scope: s.scope, name: s.mode === 'names' && s.query.trim() ? s.query : undefined, sort: s.sort, descending: s.descending, filter: s.filter, offset, limit: CHUNK }
}

/** Reloads the list. `quiet` keeps what is on screen (used after background changes) and refetches the loaded pages. */
export async function refreshList(quiet = false): Promise<void> {
  if (get().mode === 'content' && get().query.trim()) return
  const seq = ++listSeq
  const chunks = quiet ? [...loadedChunks].filter((c) => c !== 0) : []
  if (!quiet) {
    loadedChunks.clear()
    loadingChunks.clear()
    set({ loading: true })
  }
  try {
    const first = await libraryApi.list(listRequest(0))
    if (seq !== listSeq) return
    const items: (LibraryItem | undefined)[] = new Array<LibraryItem | undefined>(first.total).fill(undefined)
    first.items.forEach((it, i) => (items[i] = it))
    const next = new Set<number>([0])
    await Promise.all(
      chunks
        .filter((c) => c * CHUNK < first.total)
        .map(async (c) => {
          const r = await libraryApi.list(listRequest(c * CHUNK))
          r.items.forEach((it, i) => (items[c * CHUNK + i] = it))
          next.add(c)
        })
    )
    if (seq !== listSeq) return
    loadedChunks.clear()
    next.forEach((c) => loadedChunks.add(c))
    const prev = get()
    // Keep the selection only for files that are still listed.
    const present = new Set(items.filter(Boolean).map((i) => i!.ref))
    const selected = prev.selected.filter((r) => present.has(r) || !quiet)
    set({ items, total: first.total, loading: false, selected: quiet ? selected : [], active: quiet ? Math.min(prev.active, first.total - 1) : first.total > 0 ? 0 : -1, anchor: quiet ? prev.anchor : 0 })
    if (!quiet) announce(`${first.total.toLocaleString('en-US')} file${first.total === 1 ? '' : 's'}`)
  } catch (err) {
    if (seq === listSeq) {
      set({ loading: false })
      notify('error', `The list could not be loaded: ${errorMessage(err)}`)
    }
  }
}

/** Loads the pages of the list that cover rows [first, last] (called while scrolling). */
export function ensureRange(first: number, last: number): void {
  const total = get().total
  if (total === 0) return
  const seq = listSeq
  for (let c = Math.floor(Math.max(0, first) / CHUNK); c <= Math.floor(Math.min(total - 1, last) / CHUNK); c++) {
    if (loadedChunks.has(c) || loadingChunks.has(c)) continue
    loadingChunks.add(c)
    void libraryApi
      .list(listRequest(c * CHUNK))
      .then((r) => {
        if (seq !== listSeq) return
        loadedChunks.add(c)
        set((s) => {
          const items = s.items.slice()
          r.items.forEach((it, i) => (items[c * CHUNK + i] = it))
          return { items }
        })
      })
      .catch(() => undefined)
      .finally(() => loadingChunks.delete(c))
  }
}

// ---- content search --------------------------------------------------------------------------------------------------------

let searchSeq = 0

export async function runSearch(append = false): Promise<void> {
  const s = get()
  const query = s.query.trim()
  if (s.mode !== 'content') return
  const seq = ++searchSeq
  if (!query) {
    set({ hits: [], hitTotal: 0, hitError: null, searching: false, selected: [], active: -1 })
    return
  }
  set({ searching: true, ...(append ? {} : { hitError: null }) })
  try {
    const r = await libraryApi.search({ query, scope: s.scope, offset: append ? s.hits.length : 0, limit: SEARCH_PAGE })
    if (seq !== searchSeq) return
    if (!r.ok) {
      set({ hits: append ? s.hits : [], hitTotal: 0, hitError: r.error, searching: false })
      return
    }
    const hits = append ? [...get().hits, ...r.hits] : r.hits
    set({ hits, hitTotal: r.total, hitCapped: r.capped, hitMs: r.tookMs, hitError: null, searching: false, ...(append ? {} : { selected: [], active: hits.length ? 0 : -1, anchor: 0 }) })
    if (!append) announce(r.total === 0 ? 'No results' : `${r.total.toLocaleString('en-US')}${r.capped ? '+' : ''} result${r.total === 1 ? '' : 's'}`)
  } catch (err) {
    if (seq === searchSeq) set({ searching: false, hitError: errorMessage(err) })
  }
}

// ---- navigation and view options ---------------------------------------------------------------------------------------------

export function setScope(scope: Scope): void {
  set({ scope, selected: [], active: -1, anchor: -1 })
  savePrefs(get())
  if (get().mode === 'content' && get().query.trim()) void runSearch()
  else void refreshList()
}

export function setQuery(query: string): void {
  set({ query })
}

export function setMode(mode: Mode): void {
  set({ mode, selected: [], active: -1, anchor: -1 })
  if (mode === 'content') void runSearch()
  else {
    searchSeq++
    set({ searching: false })
    void refreshList()
  }
}

export function applySort(sort: SortKey, descending?: boolean): void {
  const s = get()
  set({ sort, descending: descending ?? (s.sort === sort ? !s.descending : false) })
  savePrefs(get())
  void refreshList()
}

export function setFilter(filter: LibraryFilter): void {
  set({ filter })
  savePrefs(get())
  void refreshList()
}

export function setView(view: ViewKind): void {
  set({ view })
  savePrefs(get())
}

export async function loadTree(rootId: number): Promise<void> {
  try {
    const t = await libraryApi.tree(rootId)
    set((s) => ({ dirs: { ...s.dirs, [rootId]: t.dirs } }))
  } catch {
    /* the folder list is a convenience */
  }
}

export function toggleExpanded(key: string, dflt: boolean): void {
  set((s) => ({ expanded: { ...s.expanded, [key]: !(s.expanded[key] ?? dflt) } }))
}

// ---- selection ----------------------------------------------------------------------------------------------------------------

export const itemAt = (i: number): LibraryItem | undefined => get().items[i]

export function selectOnly(index: number): void {
  const it = get().items[index]
  set({ selected: it ? [it.ref] : [], active: index, anchor: index })
}

export function toggleSelect(index: number): void {
  const it = get().items[index]
  if (!it) return
  set((s) => ({ selected: s.selected.includes(it.ref) ? s.selected.filter((r) => r !== it.ref) : [...s.selected, it.ref], active: index, anchor: index }))
}

export function selectRange(index: number): void {
  const s = get()
  const from = s.anchor < 0 ? index : s.anchor
  const [a, b] = from < index ? [from, index] : [index, from]
  const refs: string[] = []
  for (let i = a; i <= b; i++) {
    const it = s.items[i]
    if (it) refs.push(it.ref)
  }
  set({ selected: refs, active: index })
}

export function selectAll(): void {
  set({ selected: get().items.filter(Boolean).map((i) => i!.ref) })
}

export const selectedItems = (): LibraryItem[] => {
  const s = get()
  const by = new Map<string, LibraryItem>()
  for (const it of s.items) if (it) by.set(it.ref, it)
  return s.selected.map((r) => by.get(r)).filter((i): i is LibraryItem => !!i)
}

// ---- actions ----------------------------------------------------------------------------------------------------------------

/** Opens files in new tabs (Enter / double click / Open). With `hit`, goes to that page and searches for the term. */
export async function openRefs(refs: string[], hit?: { page: number; term: string }): Promise<void> {
  if (refs.length === 0) return
  try {
    const res = await libraryApi.open(refs)
    for (const f of res.failed) notify('error', `“${f.name}” could not be opened: ${f.reason}`)
    if (res.handles.length > 0) {
      const tabs = useTabs.getState()
      tabs.addHandles(res.handles)
      if (hit) {
        const last = res.handles[res.handles.length - 1]
        const tab = useTabs.getState().tabs.find((t) => t.path === last.path)
        if (tab) useTabs.getState().goToPage(tab.docId, hit.page)
        if (hit.term) {
          useSearch.getState().setQuery(hit.term)
          useSearch.getState().setOpen(true)
        }
      }
      if (res.downloaded > 0) notify('info', `${res.downloaded === 1 ? 'The file was' : `${res.downloaded} files were`} stored in the cloud: your sync app is downloading ${res.downloaded === 1 ? 'it' : 'them'} now.`)
      closeLibrary()
    } else {
      // Something was wrong with every file (deleted, moved): the list may have changed.
      void refreshList(true)
      void refreshState()
    }
  } catch (err) {
    notify('error', errorMessage(err))
  }
}

export async function revealRef(ref: string): Promise<void> {
  try {
    await libraryApi.reveal(ref)
  } catch (err) {
    notify('error', errorMessage(err))
  }
}

export async function setFavorite(refs: string[], value: boolean): Promise<void> {
  try {
    await libraryApi.favorite(refs, value)
    announce(value ? 'Added to favorites' : 'Removed from favorites')
    await refreshList(true)
    void refreshState()
  } catch (err) {
    notify('error', errorMessage(err))
  }
}

export async function removeRefs(refs: string[]): Promise<void> {
  try {
    await libraryApi.removeFiles(refs)
    announce(`Removed ${refs.length} file${refs.length === 1 ? '' : 's'} from the library`)
    set({ selected: [] })
    await refreshList(true)
    void refreshState()
  } catch (err) {
    notify('error', errorMessage(err))
  }
}

export async function addFolder(): Promise<void> {
  try {
    const r = await libraryApi.addFolder()
    if (!r.ok) notify('error', r.error)
    else if (r.message !== 'cancelled') {
      announce('Folder added. Indexing has started.')
      await refreshState()
      void refreshList(true)
    }
  } catch (err) {
    notify('error', errorMessage(err))
  }
}

export async function addSuggested(key: string): Promise<void> {
  try {
    const r = await libraryApi.addSuggested(key)
    if (!r.ok) notify('error', r.error)
    else {
      announce('Folder added. Indexing has started.')
      await refreshState()
      void refreshList(true)
    }
  } catch (err) {
    notify('error', errorMessage(err))
  }
}

export async function onLibraryChanged(): Promise<void> {
  if (!get().open) return
  await refreshState()
  for (const [key, open] of Object.entries(get().expanded)) if (open && /^r\d+$/.test(key)) void loadTree(Number(key.slice(1)))
  if (get().mode === 'content' && get().query.trim()) void runSearch()
  else await refreshList(true)
}

export function askAddToFolder(refs: string[]): void {
  if (refs.length > 0) set({ addToFolder: { refs } })
}

export function closeAddToFolder(): void {
  set({ addToFolder: null })
}
export function setFolderDialog(folderDialog: FolderDialog): void {
  set({ folderDialog })
}
export function setSettingsOpen(settingsOpen: boolean): void {
  set({ settingsOpen })
}
