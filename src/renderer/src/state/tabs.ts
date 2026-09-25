import { create } from 'zustand'
import type { DocHandle, DocViewState, OpenedDoc, Settings, ViewMode } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { destroyDoc } from '../pdf/docCache'

export type TabStatus = 'loading' | 'ready' | 'error'

export interface Tab {
  docId: string
  path: string
  name: string
  view: DocViewState
  status: TabStatus
  error?: string
  numPages: number
  /** Increment to (re)load the document from disk, e.g. after it changed there. Remounts the viewer. */
  loadSeq: number
  /** Increments when the edited content changes (edit/undo/redo); the viewer swaps documents in place. */
  contentSeq: number
  changedOnDisk: boolean
  /** A goto request: the viewer scrolls to `navPage` whenever `navSeq` changes. */
  navPage: number
  navSeq: number
}

interface TabsState {
  tabs: Tab[]
  activeId: string | null
  settings: Settings
  setSettings(s: Settings): void
  addDocs(docs: OpenedDoc[]): void
  addHandles(handles: DocHandle[]): void
  closeTab(docId: string): void
  setActive(docId: string): void
  cycle(dir: 1 | -1): void
  moveTab(docId: string, toIndex: number): void
  patchView(docId: string, patch: Partial<DocViewState>): void
  patchTab(docId: string, patch: Partial<Tab>): void
  goToPage(docId: string, page: number): void
  reload(docId: string): void
  contentChanged(docId: string): void
}

export interface TabAddedInfo {
  hasRecovery?: boolean
  autoRecover?: boolean
}

/** Notified whenever a tab is created (used by crash recovery to offer autosaved edits). */
export const tabAddedListeners = new Set<(tab: Tab, info: TabAddedInfo) => void>()

const defaultView = (s: Settings, page = 1): DocViewState => ({
  page,
  zoom: 1,
  zoomMode: s.defaultZoomMode,
  viewMode: s.defaultViewMode
})

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  settings: DEFAULT_SETTINGS,

  setSettings: (settings) => set({ settings }),

  addHandles: (handles) =>
    get().addDocs(
      handles.map((h, i) => ({
        handle: h,
        view: defaultView(get().settings, h.lastPage ?? 1),
        activate: i === handles.length - 1
      }))
    ),

  addDocs: (docs) => {
    const state = get()
    const tabs = [...state.tabs]
    let activeId = state.activeId
    const added: [Tab, TabAddedInfo][] = []
    for (const { handle, view, activate, autoRecover } of docs) {
      const existing = tabs.find((t) => t.path === handle.path)
      if (existing) {
        // Already open in this window: main handed us an extra reference, give it back.
        void window.epdf.closeDoc(handle.docId)
        if (activate) activeId = existing.docId
        continue
      }
      const tab: Tab = {
        docId: handle.docId,
        path: handle.path,
        name: handle.name,
        view: view ?? defaultView(state.settings, handle.lastPage ?? 1),
        status: 'loading',
        numPages: 0,
        loadSeq: 0,
        contentSeq: 0,
        changedOnDisk: false,
        navPage: view?.page ?? handle.lastPage ?? 1,
        navSeq: 1
      }
      tabs.push(tab)
      added.push([tab, { hasRecovery: handle.hasRecovery, autoRecover }])
      if (activate || activeId === null) activeId = handle.docId
    }
    set({ tabs, activeId })
    for (const [tab, info] of added) tabAddedListeners.forEach((l) => l(tab, info))
  },

  closeTab: (docId) => {
    const { tabs, activeId } = get()
    const idx = tabs.findIndex((t) => t.docId === docId)
    if (idx < 0) return
    const next = tabs.filter((t) => t.docId !== docId)
    let nextActive = activeId
    if (activeId === docId) nextActive = next.length ? next[Math.min(idx, next.length - 1)].docId : null
    set({ tabs: next, activeId: nextActive })
    void destroyDoc(docId)
    void window.epdf.closeDoc(docId)
  },

  setActive: (docId) => set({ activeId: docId }),

  cycle: (dir) => {
    const { tabs, activeId } = get()
    if (tabs.length < 2) return
    const i = tabs.findIndex((t) => t.docId === activeId)
    set({ activeId: tabs[(i + dir + tabs.length) % tabs.length].docId })
  },

  moveTab: (docId, toIndex) => {
    const tabs = [...get().tabs]
    const from = tabs.findIndex((t) => t.docId === docId)
    if (from < 0) return
    const [t] = tabs.splice(from, 1)
    tabs.splice(Math.min(Math.max(toIndex, 0), tabs.length), 0, t)
    set({ tabs })
  },

  patchView: (docId, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.docId === docId ? { ...t, view: { ...t.view, ...patch } } : t)) })),

  patchTab: (docId, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.docId === docId ? { ...t, ...patch } : t)) })),

  goToPage: (docId, page) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.docId !== docId) return t
        const p = Math.min(Math.max(1, Math.round(page)), Math.max(1, t.numPages || page))
        return { ...t, view: { ...t.view, page: p }, navPage: p, navSeq: t.navSeq + 1 }
      })
    })),

  reload: (docId) => {
    void destroyDoc(docId)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.docId === docId
          ? {
              ...t,
              status: 'loading',
              error: undefined,
              changedOnDisk: false,
              loadSeq: t.loadSeq + 1,
              contentSeq: 0,
              navPage: t.view.page,
              navSeq: t.navSeq + 1
            }
          : t
      )
    }))
  },

  contentChanged: (docId) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.docId === docId ? { ...t, contentSeq: t.contentSeq + 1 } : t)) }))
}))

export const selectActiveTab = (s: TabsState): Tab | undefined => s.tabs.find((t) => t.docId === s.activeId)
export type { ViewMode }
