import { create } from 'zustand'
import { DEFAULT_OPTIONS, type CompareOptions } from './diff/types'
import { ALL_KINDS, describeChange, filterChanges, stepChange, type Filters } from './diff/summary'
import { isAbort, releaseSide, runComparison, type Progress, type Session, type Source } from './session'
import { errorMessage } from '../../state/notify'
import { useTabs, type Tab } from '../../state/tabs'
import { DEFAULT_SENSITIVITY } from './diff/pixel'
import { differingPairs, scanVisual } from './visual'

/**
 * Compare state per document tab. It lives outside the view component so a running comparison (and its results)
 * survive switching tabs or leaving the view; it is released when the tab closes or a new comparison replaces it.
 */

export type Phase = 'choose' | 'running' | 'done'
export type ViewMode = 'side' | 'visual'

export interface VisualState {
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'failed'
  done: number
  total: number
  /** Sensitivity the scan ran with. */
  sensitivity: number
  /** Pair index -> differing pixel count, for pairs that were scanned. */
  counts: Record<number, number>
  /** Pair indexes that differ visually. */
  differing: number[]
}

export interface Entry {
  phase: Phase
  oldSource: Source | null
  newSource: Source | null
  opts: CompareOptions
  error: string | null
  progress: Progress | null
  session: Session | null
  /** The tab's content version when the comparison ran (edits afterwards make the results stale). */
  contentSeq: number
  current: number | null
  /** Bumped whenever the panes should scroll to `current`. */
  jumpSeq: number
  announcement: string
  filters: Filters
  mode: ViewMode
  onlyChanged: boolean
  listOpen: boolean
  /** Page pair shown in the visual mode. */
  visualPair: number
  sensitivity: number
  visual: VisualState
}

const NO_VISUAL: VisualState = { status: 'idle', done: 0, total: 0, sensitivity: DEFAULT_SENSITIVITY, counts: {}, differing: [] }

export const newEntry = (): Entry => ({
  phase: 'choose',
  oldSource: null,
  newSource: null,
  opts: { ...DEFAULT_OPTIONS },
  error: null,
  progress: null,
  session: null,
  contentSeq: 0,
  current: null,
  jumpSeq: 0,
  announcement: '',
  filters: { kinds: new Set(ALL_KINDS), page: null, query: '' },
  mode: 'side',
  onlyChanged: false,
  listOpen: true,
  visualPair: 0,
  sensitivity: DEFAULT_SENSITIVITY,
  visual: NO_VISUAL
})

interface CompareStore {
  byDoc: Record<string, Entry>
  /** Makes sure an entry exists for the tab (the tab itself is the default "new" version). */
  ensure(tab: Tab): void
  patch(docId: string, patch: Partial<Entry>): void
  setSource(docId: string, side: 'old' | 'new', src: Source | null): void
  swap(docId: string): void
  start(docId: string): Promise<void>
  cancel(docId: string): void
  /** Back to the choose step; the previous results are released. */
  reset(docId: string): void
  release(docId: string): void
  jump(docId: string, id: number): void
  step(docId: string, dir: 1 | -1): void
  /** Renders every page pair on both sides and counts differing pixels (in a worker). */
  startScan(docId: string): Promise<void>
  stopScan(docId: string): void
}

const controllers = new Map<string, AbortController>()
const scanStops = new Map<string, { stop: boolean }>()
export const AUTO_SCAN_MAX_PAIRS = 100

export const useCompare = create<CompareStore>((set, get) => {
  const update = (docId: string, fn: (e: Entry) => Partial<Entry>): void =>
    set((s) => {
      const e = s.byDoc[docId]
      return e ? { byDoc: { ...s.byDoc, [docId]: { ...e, ...fn(e) } } } : s
    })

  return {
    byDoc: {},

    ensure: (tab) => {
      if (get().byDoc[tab.docId]) return
      set((s) => ({ byDoc: { ...s.byDoc, [tab.docId]: { ...newEntry(), newSource: { kind: 'tab', docId: tab.docId, name: tab.name } } } }))
    },

    patch: (docId, patch) => update(docId, () => patch),

    setSource: (docId, side, src) => update(docId, () => (side === 'old' ? { oldSource: src, error: null } : { newSource: src, error: null })),

    swap: (docId) => update(docId, (e) => ({ oldSource: e.newSource, newSource: e.oldSource, error: null })),

    start: async (docId) => {
      const e = get().byDoc[docId]
      if (!e || e.phase === 'running' || !e.oldSource || !e.newSource) return
      const tab = useTabs.getState().tabs.find((t) => t.docId === docId)
      const previous = e.session
      const ctl = new AbortController()
      controllers.set(docId, ctl)
      update(docId, () => ({ phase: 'running', error: null, progress: { label: 'Starting', fraction: 0 }, session: null }))
      if (previous) {
        void releaseSide(previous.oldSide)
        void releaseSide(previous.newSide)
      }
      try {
        const session = await runComparison(e.oldSource, e.newSource, e.opts, (progress) => update(docId, () => ({ progress })), ctl.signal)
        if (!get().byDoc[docId] || ctl.signal.aborted) {
          void releaseSide(session.oldSide)
          void releaseSide(session.newSide)
          return
        }
        update(docId, () => ({
          phase: 'done',
          session,
          progress: null,
          contentSeq: tab?.contentSeq ?? 0,
          current: null,
          jumpSeq: 0,
          announcement: '',
          filters: { kinds: new Set(ALL_KINDS), page: null, query: '' },
          mode: 'side',
          visualPair: 0,
          visual: { ...NO_VISUAL, sensitivity: e.sensitivity }
        }))
        // No text differences: the interesting question is whether pictures or graphics differ, so look right away
        // (for large documents the user starts the scan on purpose).
        if (session.result.counts.total === 0 && session.result.pairs.length <= AUTO_SCAN_MAX_PAIRS) void get().startScan(docId)
      } catch (err) {
        if (isAbort(err)) update(docId, () => ({ phase: 'choose', progress: null, error: null }))
        else {
          const message = err instanceof Error ? err.message : errorMessage(err)
          update(docId, () => ({ phase: 'choose', progress: null, error: message }))
        }
      } finally {
        if (controllers.get(docId) === ctl) controllers.delete(docId)
      }
    },

    cancel: (docId) => controllers.get(docId)?.abort(),

    reset: (docId) => {
      controllers.get(docId)?.abort()
      const scan = scanStops.get(docId)
      if (scan) scan.stop = true
      const e = get().byDoc[docId]
      if (e?.session) {
        void releaseSide(e.session.oldSide)
        void releaseSide(e.session.newSide)
      }
      update(docId, () => ({ phase: 'choose', session: null, progress: null, current: null, error: null, visual: NO_VISUAL }))
    },

    release: (docId) => {
      controllers.get(docId)?.abort()
      const scan = scanStops.get(docId)
      if (scan) scan.stop = true
      const e = get().byDoc[docId]
      if (e?.session) {
        void releaseSide(e.session.oldSide)
        void releaseSide(e.session.newSide)
      }
      set((s) => {
        const { [docId]: _gone, ...rest } = s.byDoc
        return { byDoc: rest }
      })
    },

    jump: (docId, id) => {
      const e = get().byDoc[docId]
      if (!e?.session) return
      const change = e.session.result.changes[id]
      if (!change) return
      const visible = filterChanges(e.session.result.changes, e.session.texts, e.filters)
      const at = visible.findIndex((c) => c.id === id)
      const announcement = describeChange(change, at >= 0 ? at + 1 : id + 1, at >= 0 ? visible.length : e.session.result.changes.length, e.session.texts[id])
      update(docId, (x) => ({ current: id, jumpSeq: x.jumpSeq + 1, announcement, mode: x.mode }))
    },

    step: (docId, dir) => {
      const e = get().byDoc[docId]
      if (!e?.session) return
      const visible = filterChanges(e.session.result.changes, e.session.texts, e.filters)
      const at = stepChange(visible, e.current, dir)
      if (at >= 0) get().jump(docId, visible[at].id)
    },

    startScan: async (docId) => {
      const e = get().byDoc[docId]
      if (!e?.session || e.visual.status === 'running') return
      const { session } = e
      const sensitivity = e.sensitivity
      const flag = { stop: false }
      scanStops.set(docId, flag)
      const both = session.result.pairs.filter((p) => p.old !== null && p.new !== null).length
      update(docId, () => ({ visual: { status: 'running', done: 0, total: both, sensitivity, counts: {}, differing: [] } }))
      try {
        const counts = await scanVisual(
          session.oldSide.loaded,
          session.newSide.loaded,
          session.result.pairs,
          sensitivity,
          () => flag.stop || !get().byDoc[docId],
          (p) => update(docId, (x) => ({ visual: { ...x.visual, done: p.done, total: p.total } }))
        )
        update(docId, () => ({ visual: { status: flag.stop ? 'cancelled' : 'done', done: both, total: both, sensitivity, counts, differing: differingPairs(counts) } }))
      } catch (err) {
        console.error('Visual comparison failed', err)
        update(docId, (x) => ({ visual: { ...x.visual, status: 'failed' } }))
      } finally {
        if (scanStops.get(docId) === flag) scanStops.delete(docId)
      }
    },

    stopScan: (docId) => {
      const f = scanStops.get(docId)
      if (f) f.stop = true
    }
  }
})

// Release a document's comparison when its tab closes.
useTabs.subscribe((state, prev) => {
  if (state.tabs.length >= prev.tabs.length) return
  const open = new Set(state.tabs.map((t) => t.docId))
  for (const t of prev.tabs) if (!open.has(t.docId) && useCompare.getState().byDoc[t.docId]) useCompare.getState().release(t.docId)
})

export const selectEntry = (docId: string) => (s: CompareStore): Entry | undefined => s.byDoc[docId]
