import { useEffect } from 'react'
import { Dialogs } from './components/DialogsHost'
import { EmptyState } from './components/EmptyState'
import { ConfirmHost, JobsTray, Toasts } from './components/Overlays'
import { SearchBar } from './components/SearchBar'
import { Ribbon, RibbonTabs } from './components/Ribbon'
import { LeftSidebar, RightSidebar } from './components/SidePanels'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { isDirty, useEdits } from './edit/session'
import { getCommands, getView, runCommand } from './features/api'
import { isEditableTarget, matchesShortcut } from './features/keys'
import { runMenuAction } from './state/actions'
import { useSearch } from './state/search'
import { selectActiveTab, useTabs } from './state/tabs'
import { useUi } from './state/ui'
import { useActiveView, useWorkspace } from './state/workspace'
import { Viewer } from './viewer/Viewer'

/** Mirrors open tabs (and which have unsaved edits) to main for crash recovery and the close guard. */
function useSessionReporting(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      const { tabs, activeId } = useTabs.getState()
      void window.epdf.reportTabs({
        tabs: tabs.map((t) => ({ docId: t.docId, path: t.path, view: t.view, dirty: isDirty(t.docId) })),
        activeDocId: activeId
      })
    }
    const schedule = (delay: number): void => {
      clearTimeout(timer)
      timer = setTimeout(flush, delay)
    }
    // `subscribe` only fires on change, so the initial empty state is never reported.
    const unsubTabs = useTabs.subscribe((s, prev) => {
      if (s.tabs !== prev.tabs || s.activeId !== prev.activeId) schedule(400)
    })
    // Dirty state gates window close in main, so it is reported promptly.
    const unsubEdits = useEdits.subscribe((s, prev) => {
      const changed = Object.keys({ ...s, ...prev }).some((id) => s[id]?.dirty !== prev[id]?.dirty)
      if (changed) schedule(50)
    })
    return () => {
      unsubTabs()
      unsubEdits()
      clearTimeout(timer)
    }
  }, [])
}

function useAppBootstrap(): void {
  useEffect(() => {
    const api = window.epdf
    const offs = [
      api.on('doc:open', (docs) => useTabs.getState().addDocs(docs)),
      api.on('doc:changedOnDisk', ({ docId }) => useTabs.getState().patchTab(docId, { changedOnDisk: true })),
      api.on('menu:action', runMenuAction),
      api.on('theme:changed', ({ darkMode }) => useUi.getState().setDarkMode(darkMode))
    ]
    void (async () => {
      const [settings, info] = await Promise.all([api.getSettings(), api.getAppInfo()])
      useTabs.getState().setSettings(settings)
      useUi.getState().setSidebarOpen(settings.sidebarOpen)
      useUi.getState().setDarkMode(info.darkMode)
      useUi.getState().setCustomTitleBar(info.platform === 'win32')
      // Full-window overlays keep their content below the Windows title bar (see index.css, "Overlays").
      if (info.platform === 'win32') document.documentElement.style.setProperty('--titlebar-h', '40px')
      // Only now can main safely deliver queued documents.
      await api.ready()
      performance.mark('epdf:interactive') // read by scripts/perf.mjs (launch-time measurement)
    })()
    return () => offs.forEach((off) => off())
  }, [])
}

/** Renderer-side shortcuts declared by commands, and Escape to leave the active tool. */
function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') {
        const ws = useWorkspace.getState()
        if (ws.activeTool && !isEditableTarget(e.target)) ws.setActiveTool(null, useTabs.getState().activeId)
        return
      }
      for (const c of getCommands()) {
        if (!c.shortcut || !matchesShortcut(e, c.shortcut)) continue
        // Bare-letter shortcuts must not steal typing.
        if (isEditableTarget(e.target) && !/(mod|ctrl|meta|alt)\+/.test(c.shortcut.toLowerCase())) continue
        e.preventDefault()
        void runCommand(c.id)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function useDropFiles(): { onDragOver(e: React.DragEvent): void; onDragLeave(e: React.DragEvent): void; onDrop(e: React.DragEvent): void } {
  const setDragging = useUi((s) => s.setDragging)
  const hasFiles = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')
  return {
    onDragOver: (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    },
    onDragLeave: (e) => {
      if (e.currentTarget === e.target) setDragging(false)
    },
    onDrop: (e) => {
      setDragging(false)
      if (!hasFiles(e)) return
      e.preventDefault()
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => window.epdf.getPathForFile(f))
        .filter(Boolean)
      if (paths.length) void window.epdf.openDropped(paths).then((h) => h.length && useTabs.getState().addHandles(h))
    }
  }
}

export function App(): JSX.Element {
  useAppBootstrap()
  useSessionReporting()
  useGlobalKeys()
  const drop = useDropFiles()

  const tab = useTabs(selectActiveTab)
  const hasTabs = useTabs((s) => s.tabs.length > 0)
  const dirty = useEdits((s) => (tab ? (s[tab.docId]?.dirty ?? false) : false))
  const dark = useUi((s) => s.darkMode)
  const sidebarOpen = useUi((s) => s.sidebarOpen)
  const dragging = useUi((s) => s.dragging)
  const announcement = useUi((s) => s.announcement)
  const viewId = useActiveView(tab?.docId ?? null)
  const view = viewId ? getView(viewId) : undefined
  const CustomView = view?.Component

  useEffect(() => {
    // Switch the theme in one step: without this, every control's colour transition would fade from the old palette.
    const root = document.documentElement
    root.classList.add('theme-switching')
    root.classList.toggle('dark', dark)
    void root.offsetHeight // apply the new colours before transitions come back
    const id = requestAnimationFrame(() => root.classList.remove('theme-switching'))
    return () => cancelAnimationFrame(id)
  }, [dark])

  useEffect(() => {
    document.title = tab ? `${dirty ? '• ' : ''}${tab.name} – Epdf` : 'Epdf'
  }, [tab?.name, dirty]) // eslint-disable-line react-hooks/exhaustive-deps

  // Switching documents invalidates search results (they belong to the previous document).
  useEffect(() => {
    useSearch.getState().reset()
  }, [tab?.docId])

  return (
    <div className="flex h-full flex-col bg-chrome" {...drop}>
      <TitleBar tab={tab ?? null} quickAccess={!view?.hideToolbar} />
      <RibbonTabs tab={tab && !view ? tab : null} />
      {tab && !view && <Ribbon tab={tab} />}
      <main
        id="doc-panel"
        role="tabpanel"
        aria-labelledby={tab ? `tab-${tab.docId}` : undefined}
        className="relative flex min-h-0 flex-1 border-t border-black/[.06] bg-surface dark:border-white/[.06]"
      >
        {tab && !view && sidebarOpen && tab.status === 'ready' && <LeftSidebar tab={tab} />}
        <div className="relative min-w-0 flex-1">
          {tab && CustomView ? (
            <CustomView tab={tab} />
          ) : tab ? (
            <>
              <Viewer tab={tab} />
              <SearchBar tab={tab} />
            </>
          ) : (
            <EmptyState />
          )}
        </div>
        {tab && !view && tab.status === 'ready' && <RightSidebar tab={tab} />}
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-popover flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10 text-heading text-accent">
            Drop PDF files to open
          </div>
        )}
      </main>
      {tab && !view?.hideToolbar && <StatusBar tab={tab} />}
      <div className="sr-only" role="status" aria-live="polite">
        {hasTabs ? announcement : ''}
      </div>
      <Dialogs />
      <ConfirmHost />
      <Toasts />
      <JobsTray />
    </div>
  )
}
