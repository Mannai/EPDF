import { create } from 'zustand'

/** Panel view state (not part of the document): selection, expand/collapse, filter, inline rename, dialogs. */

export const BOOKMARKS_PANEL = 'bookmarks'

interface BookmarkUi {
  /** Selected (focused) bookmark per document. */
  selected: Record<string, string | null | undefined>
  /** Expand/collapse choices per document; an absent entry means "as the file says" (/Count sign). */
  expanded: Record<string, Record<string, boolean> | undefined>
  filter: string
  /** Id of the bookmark whose title is being edited inline. */
  editing: string | null
  /** Ask the panel to scroll an item into view (after adding one, or moving it). */
  reveal: { id: string; seq: number } | null
  /** The generate-from-headings dialog. */
  generate: { docId: string } | null
  select(docId: string, id: string | null): void
  setExpanded(docId: string, id: string, open: boolean): void
  setManyExpanded(docId: string, ids: string[], open: boolean): void
  clearExpanded(docId: string): void
  setFilter(q: string): void
  setEditing(id: string | null): void
  revealItem(id: string): void
  openGenerate(docId: string | null): void
}

export const useBookmarkUi = create<BookmarkUi>((set) => ({
  selected: {},
  expanded: {},
  filter: '',
  editing: null,
  reveal: null,
  generate: null,
  select: (docId, id) => set((s) => (s.selected[docId] === id ? s : { selected: { ...s.selected, [docId]: id } })),
  setExpanded: (docId, id, open) => set((s) => ({ expanded: { ...s.expanded, [docId]: { ...(s.expanded[docId] ?? {}), [id]: open } } })),
  setManyExpanded: (docId, ids, open) =>
    set((s) => {
      const next = { ...(s.expanded[docId] ?? {}) }
      for (const id of ids) next[id] = open
      return { expanded: { ...s.expanded, [docId]: next } }
    }),
  clearExpanded: (docId) => set((s) => ({ expanded: { ...s.expanded, [docId]: undefined } })),
  setFilter: (filter) => set({ filter }),
  setEditing: (editing) => set({ editing }),
  revealItem: (id) => set((s) => ({ reveal: { id, seq: (s.reveal?.seq ?? 0) + 1 } })),
  openGenerate: (docId) => set({ generate: docId ? { docId } : null })
}))
