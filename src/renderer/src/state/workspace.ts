import { create } from 'zustand'
import { getTools, getView } from '../features/api'

/** Per-window workspace state driven by the registries in features/api.ts. */
interface WorkspaceState {
  activeTool: string | null
  /** Which registered panel is showing on each side (null = none / right side closed). */
  leftPanel: string
  rightPanel: string | null
  /** Active full-tab view per document; absent = the normal page viewer. */
  viewByDoc: Record<string, string>
  setActiveTool(id: string | null, docId?: string | null): void
  setLeftPanel(id: string): void
  setRightPanel(id: string | null): void
  toggleRightPanel(id: string): void
  setView(docId: string, viewId: string | null): void
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  activeTool: null,
  leftPanel: 'thumbnails',
  rightPanel: null,
  viewByDoc: {},

  setActiveTool: (id, docId) => {
    const prev = get().activeTool
    if (prev === id) return
    const tools = getTools()
    if (docId) {
      tools.find((t) => t.id === prev)?.onDeactivate?.(docId)
      tools.find((t) => t.id === id)?.onActivate?.(docId)
    }
    set({ activeTool: id })
  },

  setLeftPanel: (leftPanel) => set({ leftPanel }),
  setRightPanel: (rightPanel) => set({ rightPanel }),
  toggleRightPanel: (id) => set((s) => ({ rightPanel: s.rightPanel === id ? null : id })),

  setView: (docId, viewId) =>
    set((s) => {
      const next = { ...s.viewByDoc }
      if (viewId && getView(viewId)) next[docId] = viewId
      else delete next[docId]
      // Tools draw on page overlays, which only exist in the page viewer.
      return { viewByDoc: next, activeTool: viewId ? null : s.activeTool }
    })
}))

export const useActiveView = (docId: string | null): string | null =>
  useWorkspace((s) => (docId ? (s.viewByDoc[docId] ?? null) : null))
