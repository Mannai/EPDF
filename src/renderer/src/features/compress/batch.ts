import { create } from 'zustand'
import type { BatchPicked, BatchRead, BatchWritten } from '@shared/features/compress'
import { COMPRESS_CHANNELS } from '@shared/features/compress'
import { errorMessage, notify } from '../../state/notify'
import { CompressCancelled, compressInWorker, type Job } from './client'
import { summary } from './format'
import type { CompressResult } from './pdf/compress'
import { PRESETS, type CompressOptions, type PresetId } from './pdf/options'

/** "Reduce Several Files": pick PDFs on disk, reduce each one with a preset, write "<name> (reduced).pdf" beside it. */

export type BatchPreset = Exclude<PresetId, 'custom'>
export type FileStatus = 'waiting' | 'working' | 'done' | 'kept' | 'skipped' | 'error'

export interface BatchFile extends BatchPicked {
  status: FileStatus
  after?: number
  outName?: string
  message?: string
}

interface BatchUi {
  open: boolean
  files: BatchFile[]
  preset: BatchPreset
  running: boolean
  finished: boolean
  progress: { fraction: number; label: string }
}

const initial: BatchUi = { open: false, files: [], preset: 'balanced', running: false, finished: false, progress: { fraction: 0, label: '' } }
export const useBatchUi = create<BatchUi>(() => initial)

const patch = (p: Partial<BatchUi>): void => useBatchUi.setState(p)
const patchFile = (i: number, p: Partial<BatchFile>): void =>
  useBatchUi.setState((s) => ({ files: s.files.map((f, k) => (k === i ? { ...f, ...p } : f)) }))

let job: Job<CompressResult> | null = null
let cancelled = false
let session = 0

export async function openBatch(): Promise<void> {
  let picked: BatchPicked[] | null
  try {
    picked = await window.epdf.call<BatchPicked[] | null>(COMPRESS_CHANNELS.batchPick, {})
  } catch (err) {
    notify('error', errorMessage(err))
    return
  }
  if (!picked || picked.length === 0) return
  session++
  cancelled = false
  useBatchUi.setState({ ...initial, open: true, files: picked.map((f) => ({ ...f, status: 'waiting' })) })
}

export function closeBatch(): void {
  session++
  cancelled = true
  job?.cancel()
  job = null
  useBatchUi.setState(initial)
}

export const chooseBatchPreset = (preset: BatchPreset): void => {
  if (!useBatchUi.getState().running) patch({ preset })
}

export function removeBatchFile(token: string): void {
  if (useBatchUi.getState().running) return
  useBatchUi.setState((s) => ({ files: s.files.filter((f) => f.token !== token) }))
}

export function cancelBatch(): void {
  cancelled = true
  job?.cancel()
}

const friendly = (message: string): { status: FileStatus; message: string } =>
  /password protected/i.test(message) ? { status: 'skipped', message: 'Password protected: unlock it first' } : { status: 'error', message }

export async function runBatch(): Promise<void> {
  const s0 = useBatchUi.getState()
  if (s0.running || s0.files.length === 0) return
  const mine = session
  cancelled = false
  const options: CompressOptions = PRESETS[s0.preset]
  patch({ running: true, finished: false })
  let before = 0
  let after = 0
  let reduced = 0
  const files = useBatchUi.getState().files
  for (let i = 0; i < files.length; i++) {
    if (cancelled || mine !== session) break
    const f = files[i]
    if (f.status === 'done') continue
    patchFile(i, { status: 'working', message: undefined })
    patch({ progress: { fraction: 0, label: `${f.name} (${i + 1} of ${files.length})` } })
    try {
      const read = await window.epdf.call<BatchRead>(COMPRESS_CHANNELS.batchRead, { token: f.token })
      if (cancelled || mine !== session) break
      job = compressInWorker(read.bytes, options, (fraction, label) => {
        if (mine === session) patch({ progress: { fraction: (i + fraction) / files.length, label: `${f.name}: ${label}` } })
      })
      const r = await job.promise
      job = null
      if (r.kept === 'original') {
        patchFile(i, { status: 'kept', message: r.reason ?? 'Already as small as it can be.' })
        continue
      }
      const w = await window.epdf.call<BatchWritten>(COMPRESS_CHANNELS.batchWrite, { token: f.token, bytes: r.bytes })
      patchFile(i, { status: 'done', after: w.size, outName: w.name })
      before += f.size
      after += w.size
      reduced++
    } catch (err) {
      job = null
      if (err instanceof CompressCancelled || cancelled) {
        patchFile(i, { status: 'waiting' })
        break
      }
      patchFile(i, friendly(errorMessage(err)))
    }
  }
  if (mine !== session) return
  const stopped = cancelled
  patch({ running: false, finished: !stopped, progress: { fraction: stopped ? 0 : 1, label: '' } })
  if (reduced > 0) notify('success', `${reduced} ${reduced === 1 ? 'file' : 'files'}: ${summary(before, after)}`)
  else if (!stopped) notify('info', 'No file could be made smaller.')
}
