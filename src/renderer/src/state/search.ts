import { create } from 'zustand'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { searchDocument, type Match, type SearchOptions } from '../pdf/search'

export interface FlatHit {
  page: number
  index: number // index within that page's matches
}

interface SearchState {
  open: boolean
  query: string
  options: SearchOptions
  byPage: Map<number, Match[]>
  flat: FlatHit[]
  current: number
  searching: boolean
  progress: number
  /** Bumped whenever the selected hit changes; the viewer scrolls to it once per bump. */
  focusSeq: number
  setOpen(v: boolean): void
  setQuery(q: string): void
  setOptions(o: Partial<SearchOptions>): void
  run(doc: PDFDocumentProxy | null, startPage: number): void
  step(dir: 1 | -1): FlatHit | null
  reset(): void
}

let controller: AbortController | null = null
let handledFocusSeq = 0

/** Returns true exactly once per focus request, no matter how many components ask. */
export function consumeFocus(): boolean {
  const seq = useSearch.getState().focusSeq
  if (seq === handledFocusSeq) return false
  handledFocusSeq = seq
  return true
}

const empty = { byPage: new Map<number, Match[]>(), flat: [] as FlatHit[], current: -1, searching: false, progress: 0 }

export const useSearch = create<SearchState>((set, get) => ({
  open: false,
  query: '',
  options: { matchCase: false, wholeWord: false },
  focusSeq: 0,
  ...empty,

  setOpen: (open) => {
    if (!open) {
      controller?.abort()
      set({ open, ...empty, byPage: new Map() })
    } else set({ open })
  },
  setQuery: (query) => set({ query }),
  setOptions: (o) => set((s) => ({ options: { ...s.options, ...o } })),

  reset: () => {
    controller?.abort()
    set({ ...empty, byPage: new Map() })
  },

  run: (doc, startPage) => {
    controller?.abort()
    const { query, options } = get()
    set({ ...empty, byPage: new Map() })
    if (!doc || !query.trim()) return
    const ctl = new AbortController()
    controller = ctl
    set({ searching: true })
    const byPage = new Map<number, Match[]>()
    const flat: FlatHit[] = []
    let current = -1
    void searchDocument(
      doc,
      query,
      options,
      ({ page, matches }, done) => {
        if (ctl.signal.aborted) return
        if (matches.length) {
          byPage.set(page, matches)
          matches.forEach((_, index) => flat.push({ page, index }))
          // Select the first hit at or after the page the user is viewing.
          if (current === -1 && page >= startPage) current = flat.length - matches.length
        }
        if (matches.length || done % 8 === 0) {
          const first = current !== -1 && get().current === -1
          set((s) => ({
            byPage: new Map(byPage),
            flat: [...flat],
            current,
            progress: done / doc.numPages,
            focusSeq: first ? s.focusSeq + 1 : s.focusSeq
          }))
        }
      },
      ctl.signal
    ).then(() => {
      if (ctl.signal.aborted) return
      set((s) => {
        const pick = s.current === -1 && s.flat.length > 0
        return {
          searching: false,
          progress: 1,
          current: pick ? 0 : s.current,
          focusSeq: pick ? s.focusSeq + 1 : s.focusSeq
        }
      })
    })
  },

  step: (dir) => {
    const { flat, current } = get()
    if (!flat.length) return null
    const next = (current + dir + flat.length) % flat.length
    set((s) => ({ current: next, focusSeq: s.focusSeq + 1 }))
    return flat[next]
  }
}))
