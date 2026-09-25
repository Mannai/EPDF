import { create } from 'zustand'
import type { JobUpdate } from '@shared/jobs'

interface JobsState {
  jobs: Record<string, JobUpdate>
  /** Ids in start order, for stable display. */
  order: string[]
  remove(jobId: string): void
}

export const useJobs = create<JobsState>((set) => ({
  jobs: {},
  order: [],
  remove: (jobId) =>
    set((s) => {
      const { [jobId]: _gone, ...jobs } = s.jobs
      return { jobs, order: s.order.filter((id) => id !== jobId) }
    })
}))

export class JobCancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

const waiters = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>()
let subscribed = false

/** Subscribes to job updates from main. Called once at startup. */
export function initJobs(): () => void {
  if (subscribed) return () => undefined
  subscribed = true
  return window.epdf.onFeature('job:update', (payload) => {
    const u = payload as JobUpdate
    useJobs.setState((s) => ({
      jobs: { ...s.jobs, [u.jobId]: u },
      order: s.order.includes(u.jobId) ? s.order : [...s.order, u.jobId]
    }))
    if (u.state === 'running') return
    const w = waiters.get(u.jobId)
    if (w) {
      waiters.delete(u.jobId)
      if (u.state === 'done') w.resolve(u.result)
      else if (u.state === 'cancelled') w.reject(new JobCancelledError())
      else w.reject(new Error(u.error ?? 'The task failed.'))
    }
    // Finished jobs linger briefly in the tray so the outcome is visible, then go away.
    setTimeout(() => useJobs.getState().remove(u.jobId), u.state === 'failed' ? 15000 : 4000)
  })
}

export interface JobHandle<R> {
  promise: Promise<R>
  cancel(): void
}

/**
 * Starts a background job in the main process (see `jobs.register` in src/main/jobs) and returns a
 * promise for its result. Progress and a Cancel button appear in the jobs tray automatically.
 * Rejects with `JobCancelledError` if the user cancels.
 *
 *   const { promise } = startJob<{ counted: number }>('selftest:count', { steps: 10, delayMs: 50 })
 */
export function startJob<R = unknown>(kind: string, payload: unknown): JobHandle<R> {
  let jobId: string | null = null
  let cancelRequested = false
  const promise = new Promise<R>((resolve, reject) => {
    void window.epdf
      .call<{ jobId: string }>('job:start', { kind, payload })
      .then(({ jobId: id }) => {
        jobId = id
        const seen = useJobs.getState().jobs[id]
        if (seen && seen.state !== 'running') {
          // It finished before we could register a waiter.
          if (seen.state === 'done') resolve(seen.result as R)
          else if (seen.state === 'cancelled') reject(new JobCancelledError())
          else reject(new Error(seen.error ?? 'The task failed.'))
          return
        }
        waiters.set(id, { resolve: resolve as (v: unknown) => void, reject })
        if (cancelRequested) void window.epdf.call('job:cancel', { jobId: id })
      })
      .catch(reject)
  })
  return {
    promise,
    cancel: () => {
      cancelRequested = true
      if (jobId) void window.epdf.call('job:cancel', { jobId })
    }
  }
}

export const cancelJob = (jobId: string): void => void window.epdf.call('job:cancel', { jobId })
