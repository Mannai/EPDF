import { create } from 'zustand'
import { currentBytes, ensureEditable, replaceBytes } from '../../edit/session'
import { activeTab } from '../../state/actions'
import { errorMessage, notify } from '../../state/notify'
import { CompressCancelled, analyzeInWorker, compressInWorker, type Job } from './client'
import { summary } from './format'
import type { Analysis } from './pdf/analyze'
import type { CompressStats } from './pdf/compress'
import { PRESETS, presetOf, sanitizeOptions, type CompressOptions, type PresetId } from './pdf/options'

export type Phase = 'loading' | 'ready' | 'running' | 'done' | 'error'

export interface RunOutcome {
  kept: 'result' | 'original'
  reason?: string
  originalSize: number
  newSize: number
  stats: CompressStats
}

interface CompressUi {
  open: boolean
  docId: string | null
  name: string
  phase: Phase
  originalSize: number
  analysis: Analysis | null
  preset: PresetId
  options: CompressOptions
  progress: { fraction: number; label: string }
  outcome: RunOutcome | null
  error: string | null
}

const initial: CompressUi = {
  open: false,
  docId: null,
  name: '',
  phase: 'loading',
  originalSize: 0,
  analysis: null,
  preset: 'balanced',
  options: PRESETS.balanced,
  progress: { fraction: 0, label: '' },
  outcome: null,
  error: null
}

export const useCompressUi = create<CompressUi>(() => initial)

/** Parsing plus rewriting needs several times the file size in memory; refuse before the worker runs out. */
const MAX_BYTES = 1024 * 1024 * 1024

// Heavy things stay out of reactive state.
let job: Job<unknown> | null = null
let source: Uint8Array | null = null
let resultBytes: Uint8Array | null = null
let session = 0

const patch = (p: Partial<CompressUi>): void => useCompressUi.setState(p)

function stopJob(): void {
  job?.cancel()
  job = null
}

/** Opens the dialog for the active document and starts the (worker-side) analysis. */
export async function openCompress(): Promise<void> {
  const tab = activeTab()
  if (!tab || tab.status !== 'ready') return
  const docId = tab.docId
  if (!(await ensureEditable(docId))) {
    // Encrypted and not unlocked (declined, wrong password, or no way to unlock): say why nothing happened.
    notify('info', 'This document is password protected, so its size was not reduced. Unlock it first.')
    return
  }
  const mine = ++session
  stopJob()
  resultBytes = null
  useCompressUi.setState({ ...initial, open: true, docId, name: tab.name })
  try {
    source = await currentBytes(docId)
    if (mine !== session) return
    patch({ originalSize: source.length })
    if (source.length > MAX_BYTES) {
      patch({ phase: 'error', error: 'This document is too large to reduce in memory (limit 1 GB). Split it first, or use Reduce Several Files on smaller parts.' })
      return
    }
    const j = analyzeInWorker(source)
    job = j
    const analysis = await j.promise
    if (mine !== session) return
    job = null
    patch({ analysis, phase: 'ready' })
  } catch (err) {
    if (mine !== session || err instanceof CompressCancelled) return
    patch({ phase: 'error', error: errorMessage(err) })
  }
}

export function closeCompress(): void {
  session++
  stopJob()
  source = null
  resultBytes = null
  useCompressUi.setState(initial)
}

/** Picks a preset; `custom` keeps the current numbers so the user can edit them. */
export function choosePreset(id: PresetId): void {
  const s = useCompressUi.getState()
  if (s.phase === 'running') return
  patch({ preset: id, options: id === 'custom' ? s.options : PRESETS[id], ...(s.phase === 'done' ? { phase: 'ready', outcome: null } : {}) })
  if (s.phase === 'done') resultBytes = null
}

export function editOptions(change: Partial<CompressOptions>): void {
  const s = useCompressUi.getState()
  if (s.phase === 'running') return
  const options = sanitizeOptions({ ...s.options, ...change })
  patch({ options, preset: presetOf(options), ...(s.phase === 'done' ? { phase: 'ready', outcome: null } : {}) })
  if (s.phase === 'done') resultBytes = null
}

export function backToSettings(): void {
  resultBytes = null
  patch({ phase: 'ready', outcome: null })
}

/** Runs the real compression with the chosen options in a Web Worker; progress and Cancel are shown in the dialog. */
export async function runCompression(): Promise<void> {
  const s = useCompressUi.getState()
  if (!source || s.phase !== 'ready') return
  const mine = session
  patch({ phase: 'running', progress: { fraction: 0, label: 'Starting' }, error: null, outcome: null })
  const j = compressInWorker(source, s.options, (fraction, label) => {
    if (mine === session) patch({ progress: { fraction, label } })
  })
  job = j
  try {
    const r = await j.promise
    if (mine !== session) return
    job = null
    resultBytes = r.kept === 'result' ? r.bytes : null
    patch({
      phase: 'done',
      outcome: { kept: r.kept, reason: r.reason, originalSize: r.stats.originalSize, newSize: r.stats.newSize, stats: r.stats }
    })
  } catch (err) {
    if (mine !== session) return
    job = null
    if (err instanceof CompressCancelled) patch({ phase: 'ready' })
    else patch({ phase: 'error', error: errorMessage(err) })
  }
}

/** Stops a running compression and returns to the settings. */
export function cancelRun(): void {
  if (useCompressUi.getState().phase !== 'running') return
  stopJob()
  patch({ phase: 'ready' })
}

/** Applies the reduced file as ONE undo step, then closes with a toast summary. */
export async function applyResult(): Promise<void> {
  const s = useCompressUi.getState()
  if (!s.docId || !s.outcome || s.outcome.kept !== 'result' || !resultBytes) return
  const { docId, outcome } = s
  const bytes = resultBytes
  try {
    await replaceBytes(docId, 'Reduce file size', bytes)
    notify('success', summary(outcome.originalSize, outcome.newSize))
    closeCompress()
  } catch (err) {
    patch({ phase: 'error', error: errorMessage(err) })
  }
}
