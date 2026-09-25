import { create } from 'zustand'
import { parsePageRange } from '@shared/features/combine'
import type { CreateEnvironment, CreateResult, Engine, ImageOptions, PickResult, PickedFile } from '@shared/features/create'
import { startJob } from '../../state/jobs'
import { errorMessage, notify } from '../../state/notify'
import { finishJob, loadEnvironment, reportJobError, saveEngine } from '../create/shared'
import { reportSkipped } from '../create/flow'
import { moveBy, moveItem } from './reorder'

export interface CombineItem extends PickedFile {
  /** Page range text ("1-3, 5"); empty = all pages. */
  range: string
}

interface CombineUi {
  open: boolean
  items: CombineItem[]
  env: CreateEnvironment | null
  engine: Engine
  bookmarks: boolean
  images: ImageOptions
  /** Screen-reader announcement for the last reorder. */
  announcement: string
  setBookmarks(b: boolean): void
  setImages(o: ImageOptions): void
  setEngine(e: Engine): void
  setRange(id: string, range: string): void
  remove(id: string): void
  move(id: string, delta: -1 | 1): void
  moveTo(id: string, to: number): void
  add(files: PickedFile[]): void
  close(): void
}

export const useCombineUi = create<CombineUi>((set, get) => ({
  open: false,
  items: [],
  env: null,
  engine: 'builtin',
  bookmarks: true,
  images: { pageSize: 'image' },
  announcement: '',
  setBookmarks: (bookmarks) => set({ bookmarks }),
  setImages: (images) => set({ images }),
  setEngine: (engine) => {
    set({ engine })
    void saveEngine(engine).catch(() => undefined)
  },
  setRange: (id, range) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, range } : i)) })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id), announcement: `Removed ${s.items.find((i) => i.id === id)?.name ?? 'file'}.` })),
  move: (id, delta) => {
    const s = get()
    const idx = s.items.findIndex((i) => i.id === id)
    if (idx < 0) return
    const next = moveBy(s.items, idx, delta)
    const at = next.findIndex((i) => i.id === id)
    set({ items: next, announcement: at === idx ? `${s.items[idx].name} is already ${delta < 0 ? 'first' : 'last'}.` : `Moved ${s.items[idx].name} to position ${at + 1} of ${next.length}.` })
  },
  moveTo: (id, to) => {
    const s = get()
    const idx = s.items.findIndex((i) => i.id === id)
    if (idx < 0 || idx === to) return
    const next = moveItem(s.items, idx, to)
    set({ items: next, announcement: `Moved ${s.items[idx].name} to position ${next.findIndex((i) => i.id === id) + 1} of ${next.length}.` })
  },
  add: (files) => set((s) => ({ items: [...s.items, ...files.map((f) => ({ ...f, range: '' }))], announcement: `Added ${files.length} file${files.length === 1 ? '' : 's'}.` })),
  close: () => set({ open: false, items: [], announcement: '' })
}))

/** Validation message for one item, or null when it can be merged. */
export function itemProblem(i: CombineItem): string | null {
  if (i.problem) return i.problem
  if (i.range.trim()) {
    const r = parsePageRange(i.range, i.pages ?? 1_000_000)
    if (!r.ok) return r.error
  }
  return null
}

export async function openCombine(preloaded?: PickResult): Promise<void> {
  let env: CreateEnvironment | null = null
  try {
    env = await loadEnvironment()
  } catch {
    /* LibreOffice simply shows as unavailable */
  }
  useCombineUi.setState({
    open: true,
    items: (preloaded?.files ?? []).map((f) => ({ ...f, range: '' })),
    env,
    engine: env?.engine === 'libreoffice' && env.soffice ? 'libreoffice' : 'builtin',
    announcement: ''
  })
  if (preloaded) reportSkipped(preloaded)
}

export async function addCombineFiles(): Promise<void> {
  try {
    const picked = await window.epdf.call<PickResult>('create:pick', { purpose: 'combine' })
    reportSkipped(picked)
    if (picked.files.length) useCombineUi.getState().add(picked.files)
  } catch (err) {
    notify('error', errorMessage(err))
  }
}

export function runCombine(): void {
  const s = useCombineUi.getState()
  if (s.items.length === 0 || s.items.some((i) => itemProblem(i))) return
  const approximate = s.engine === 'builtin' && s.items.some((i) => i.kind === 'office')
  const payload = { items: s.items.map((i) => ({ id: i.id, range: i.range.trim() || undefined })), bookmarks: s.bookmarks, images: s.images, engine: s.engine, openInApp: false }
  useCombineUi.getState().close()
  const { promise } = startJob<CreateResult>('combine:run', payload)
  promise.then((r) => finishJob(r, 'Combine Files', approximate)).catch((err) => reportJobError(err, 'Combining the files'))
}

/** The Explorer/Finder "Combine files" verb hands its files to main, which tells the renderer to take them. */
export async function takePendingCombine(): Promise<void> {
  try {
    const pending = await window.epdf.call<PickResult | null>('combine:takePending', {})
    if (!pending || (pending.files.length === 0 && pending.skipped.length === 0)) return
    if (useCombineUi.getState().open) {
      // the screen is already showing (several launches in a row): append instead of starting over
      useCombineUi.getState().add(pending.files)
      reportSkipped(pending)
    } else await openCombine(pending)
  } catch {
    /* nothing pending */
  }
}
