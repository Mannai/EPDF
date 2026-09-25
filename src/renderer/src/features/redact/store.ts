import { create } from 'zustand'
import type { Quad, Rect } from './logic/geom'
import type { RedactOptions } from './logic/redact'

/** Marks (what will be removed on Apply), search results awaiting review, and the apply dialog. */

export type MarkKind = 'text' | 'area' | 'search'

export interface UiMark {
  id: string
  pageIndex: number
  rects: Rect[]
  /** Exact shapes of rotated text (parallel to `rects`, null = the rect itself). */
  quads: (Quad | null)[]
  /** The text this mark stands for, when it came from text. */
  text?: string
  kind: MarkKind
}

export interface SearchResult {
  id: string
  pageIndex: number
  text: string
  rects: Rect[]
  quads: (Quad | null)[]
  hiddenOnly: boolean
  decision: 'pending' | 'accepted' | 'rejected'
}

export interface DocRedact {
  marks: UiMark[]
  past: UiMark[][]
  future: UiMark[][]
  selectedId: string | null
  results: SearchResult[]
  resultsLabel: string
  searching: boolean
  searchError: string | null
}

const empty = (): DocRedact => ({ marks: [], past: [], future: [], selectedId: null, results: [], resultsLabel: '', searching: false, searchError: null })

export interface ApplySettings {
  fill: string
  overlay: 'none' | 'redacted' | 'custom'
  custom: string
  removeMetadata: boolean
  removeHidden: boolean
}

export const DEFAULT_SETTINGS: ApplySettings = { fill: '#000000', overlay: 'none', custom: '', removeMetadata: false, removeHidden: false }

export function settingsToOptions(s: ApplySettings): RedactOptions {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s.fill)
  const fill: [number, number, number] = m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0]
  return {
    fill,
    overlayText: s.overlay === 'redacted' ? 'REDACTED' : s.overlay === 'custom' ? s.custom.trim() : '',
    removeMetadata: s.removeMetadata,
    removeHidden: s.removeHidden
  }
}

interface RedactState {
  docs: Record<string, DocRedact>
  settings: ApplySettings
  dialogDoc: string | null
  /** Documents whose applied redaction has not been saved yet (with the tab's path at that time). */
  pendingPurge: Record<string, { path: string }>
  announcement: string
  patchSettings(p: Partial<ApplySettings>): void
  openDialog(docId: string | null): void
  announce(msg: string): void

  addMark(docId: string, m: Omit<UiMark, 'id'>, select?: boolean): string
  addMarks(docId: string, ms: Omit<UiMark, 'id'>[]): string[]
  updateMark(docId: string, id: string, patch: Partial<Pick<UiMark, 'rects' | 'quads'>>, coalesceKey?: string): void
  removeMark(docId: string, id: string): void
  clearMarks(docId: string): void
  /** Forgets everything about a document (after its redaction was applied). */
  resetDoc(docId: string): void
  select(docId: string, id: string | null): void
  undoMarks(docId: string): void
  redoMarks(docId: string): void

  setResults(docId: string, results: SearchResult[], label: string): void
  decide(docId: string, resultId: string, decision: 'accepted' | 'rejected' | 'pending'): void
  decideAll(docId: string, ids: string[], decision: 'accepted' | 'rejected'): void
  setSearching(docId: string, searching: boolean, error?: string | null): void
  markPending(docId: string, path: string | null): void
}

let counter = 1
export const newId = (p: string): string => `${p}${counter++}`

const MAX_UNDO = 100

function withDoc(s: RedactState, docId: string, fn: (d: DocRedact) => DocRedact): Pick<RedactState, 'docs'> {
  return { docs: { ...s.docs, [docId]: fn(s.docs[docId] ?? empty()) } }
}

/** A change to the mark list that can be undone (pushes the previous list onto the undo stack). */
const commitMarks = (d: DocRedact, marks: UiMark[], selectedId: string | null = d.selectedId): DocRedact => ({
  ...d,
  marks,
  past: [...d.past.slice(-(MAX_UNDO - 1)), d.marks],
  future: [],
  selectedId: selectedId && marks.some((m) => m.id === selectedId) ? selectedId : null
})

let lastCoalesce: { key: string; at: number } | null = null

export const useRedact = create<RedactState>((set) => ({
  docs: {},
  settings: DEFAULT_SETTINGS,
  dialogDoc: null,
  pendingPurge: {},
  announcement: '',
  patchSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),
  openDialog: (dialogDoc) => set({ dialogDoc }),
  announce: (announcement) => set({ announcement }),

  addMark: (docId, m, select = true) => {
    const id = newId('m')
    set((s) => withDoc(s, docId, (d) => commitMarks(d, [...d.marks, { ...m, id }], select ? id : d.selectedId)))
    return id
  },
  addMarks: (docId, ms) => {
    const ids = ms.map(() => newId('m'))
    set((s) => withDoc(s, docId, (d) => commitMarks(d, [...d.marks, ...ms.map((m, i) => ({ ...m, id: ids[i] }))])))
    return ids
  },
  updateMark: (docId, id, patch, coalesceKey) =>
    set((s) =>
      withDoc(s, docId, (d) => {
        const marks = d.marks.map((m) => (m.id === id ? { ...m, ...patch } : m))
        // consecutive nudges of the same mark form one undo step
        const now = Date.now()
        const same = coalesceKey && lastCoalesce && lastCoalesce.key === coalesceKey && now - lastCoalesce.at < 1200
        lastCoalesce = coalesceKey ? { key: coalesceKey, at: now } : null
        if (same) return { ...d, marks, future: [] }
        return commitMarks(d, marks)
      })
    ),
  removeMark: (docId, id) =>
    set((s) =>
      withDoc(s, docId, (d) => {
        const gone = d.marks.find((m) => m.id === id)
        const next = commitMarks(
          d,
          d.marks.filter((m) => m.id !== id)
        )
        // a removed search hit goes back to pending so it can be reviewed again
        return gone ? { ...next, results: next.results.map((r) => (r.id === id ? { ...r, decision: 'pending' as const } : r)) } : next
      })
    ),
  clearMarks: (docId) => set((s) => withDoc(s, docId, (d) => (d.marks.length ? { ...commitMarks(d, []), results: d.results.map((r) => (r.decision === 'accepted' ? { ...r, decision: 'pending' as const } : r)) } : d))),
  resetDoc: (docId) =>
    set((s) => {
      const { [docId]: _gone, ...rest } = s.docs
      return { docs: rest }
    }),
  select: (docId, id) => set((s) => withDoc(s, docId, (d) => ({ ...d, selectedId: id }))),
  undoMarks: (docId) =>
    set((s) =>
      withDoc(s, docId, (d) => {
        const prev = d.past[d.past.length - 1]
        if (!prev) return d
        return syncResults({ ...d, marks: prev, past: d.past.slice(0, -1), future: [d.marks, ...d.future], selectedId: prev.some((m) => m.id === d.selectedId) ? d.selectedId : null })
      })
    ),
  redoMarks: (docId) =>
    set((s) =>
      withDoc(s, docId, (d) => {
        const next = d.future[0]
        if (!next) return d
        return syncResults({ ...d, marks: next, past: [...d.past, d.marks], future: d.future.slice(1), selectedId: next.some((m) => m.id === d.selectedId) ? d.selectedId : null })
      })
    ),

  setResults: (docId, results, resultsLabel) => set((s) => withDoc(s, docId, (d) => ({ ...d, results, resultsLabel, searching: false, searchError: null }))),
  decide: (docId, resultId, decision) =>
    set((s) =>
      withDoc(s, docId, (d) => {
        const r = d.results.find((x) => x.id === resultId)
        if (!r) return d
        let marks = d.marks
        const had = marks.some((m) => m.id === resultId)
        if (decision === 'accepted' && !had) marks = [...marks, { id: resultId, pageIndex: r.pageIndex, rects: r.rects, quads: r.quads, text: r.text, kind: 'search' }]
        else if (decision !== 'accepted' && had) marks = marks.filter((m) => m.id !== resultId)
        const results = d.results.map((x) => (x.id === resultId ? { ...x, decision } : x))
        return marks === d.marks ? { ...d, results } : { ...commitMarks(d, marks), results }
      })
    ),
  decideAll: (docId, ids, decision) =>
    set((s) =>
      withDoc(s, docId, (d) => {
        const want = new Set(ids)
        let marks = d.marks
        if (decision === 'accepted') {
          const add = d.results.filter((r) => want.has(r.id) && !marks.some((m) => m.id === r.id)).map((r): UiMark => ({ id: r.id, pageIndex: r.pageIndex, rects: r.rects, quads: r.quads, text: r.text, kind: 'search' }))
          if (add.length) marks = [...marks, ...add]
        } else marks = marks.filter((m) => !want.has(m.id))
        const results = d.results.map((r) => (want.has(r.id) ? { ...r, decision } : r))
        return marks === d.marks ? { ...d, results } : { ...commitMarks(d, marks), results }
      })
    ),
  setSearching: (docId, searching, error = null) => set((s) => withDoc(s, docId, (d) => ({ ...d, searching, searchError: error }))),
  markPending: (docId, path) =>
    set((s) => {
      const next = { ...s.pendingPurge }
      if (path === null) delete next[docId]
      else next[docId] = { path }
      return { pendingPurge: next }
    })
}))

/** After an undo/redo of the mark list, accepted search results follow the marks that exist. */
function syncResults(d: DocRedact): DocRedact {
  const ids = new Set(d.marks.map((m) => m.id))
  return { ...d, results: d.results.map((r) => (ids.has(r.id) ? { ...r, decision: 'accepted' as const } : r.decision === 'accepted' ? { ...r, decision: 'pending' as const } : r)) }
}

export const EMPTY_DOC: DocRedact = empty()
export const useDocRedact = (docId: string | null): DocRedact => useRedact((s) => (docId ? (s.docs[docId] ?? EMPTY_DOC) : EMPTY_DOC))

export const marksOf = (docId: string): UiMark[] => useRedact.getState().docs[docId]?.marks ?? []
export const totalRects = (marks: readonly UiMark[]): number => marks.reduce((n, m) => n + m.rects.length, 0)
export const pagesOf = (marks: readonly UiMark[]): number[] => [...new Set(marks.map((m) => m.pageIndex))].sort((a, b) => a - b)
