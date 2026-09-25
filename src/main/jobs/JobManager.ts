import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { JobState, JobUpdate } from '../../shared/jobs'

export interface JobContext {
  /** Report progress (0..1) and an optional human-readable step. Cheap; throttled by the manager. */
  progress(fraction: number, message?: string): void
  /** Aborted when the user cancels. Handlers must stop promptly (workers are terminated for them). */
  signal: AbortSignal
}

export type JobHandler<P, R> = (payload: P, ctx: JobContext) => Promise<R>

export type { JobState, JobUpdate }

interface JobKind {
  title: string
  schema: z.ZodType
  handler: JobHandler<never, unknown>
}

interface RunningJob {
  kind: string
  title: string
  owner: number | undefined
  abort: AbortController
  last: JobUpdate
}

/**
 * Runs long tasks off the UI thread with progress + cancellation. A handler is either plain async code
 * that awaits child processes (`runProcess`) or a worker thread (`runInWorker`); either way the Electron
 * main event loop and the renderer stay responsive.
 */
export class JobManager {
  private kinds = new Map<string, JobKind>()
  private jobs = new Map<string, RunningJob>()
  /** `owner` is the id of the window that started the job (updates are routed back to it). */
  onUpdate: (update: JobUpdate, owner: number | undefined) => void = () => undefined

  register<S extends z.ZodType, R>(kind: string, title: string, schema: S, handler: JobHandler<z.infer<S>, R>): void {
    if (this.kinds.has(kind)) throw new Error(`Job kind already registered: ${kind}`)
    this.kinds.set(kind, { title, schema, handler: handler as JobHandler<never, unknown> })
  }

  /** Validates the payload and starts the job. Returns immediately with its id. */
  start(kind: string, payload: unknown, owner?: number): string {
    const k = this.kinds.get(kind)
    if (!k) throw new Error(`Unknown job kind: ${kind}`)
    const parsed = k.schema.safeParse(payload)
    if (!parsed.success) throw new Error(`Invalid payload for job ${kind}: ${parsed.error.issues[0]?.message}`)

    const jobId = randomUUID()
    const abort = new AbortController()
    const job: RunningJob = {
      kind,
      title: k.title,
      owner,
      abort,
      last: { jobId, kind, title: k.title, state: 'running', progress: 0 }
    }
    this.jobs.set(jobId, job)
    this.emit(job, {})

    let lastEmit = 0
    const ctx: JobContext = {
      signal: abort.signal,
      progress: (fraction, message) => {
        const now = Date.now()
        // Throttle to ~20 updates/s so chatty workers cannot flood IPC.
        if (now - lastEmit < 50 && fraction < 1) return
        lastEmit = now
        this.emit(job, { progress: Math.min(1, Math.max(0, fraction)), message })
      }
    }

    void (async () => {
      try {
        const result = await k.handler(parsed.data as never, ctx)
        if (abort.signal.aborted) this.finish(jobId, job, { state: 'cancelled' })
        else this.finish(jobId, job, { state: 'done', progress: 1, result })
      } catch (err) {
        if (abort.signal.aborted) this.finish(jobId, job, { state: 'cancelled' })
        else this.finish(jobId, job, { state: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return jobId
  }

  cancel(jobId: string, owner?: number): boolean {
    const job = this.jobs.get(jobId)
    if (!job || (owner !== undefined && job.owner !== owner)) return false
    job.abort.abort()
    return true
  }

  isRunning(jobId: string): boolean {
    return this.jobs.has(jobId)
  }

  /** Aborts everything (app quit). */
  cancelAll(): void {
    for (const j of this.jobs.values()) j.abort.abort()
  }

  private emit(job: RunningJob, patch: Partial<JobUpdate>): void {
    job.last = { ...job.last, ...patch }
    this.onUpdate(job.last, job.owner)
  }

  private finish(jobId: string, job: RunningJob, patch: Partial<JobUpdate>): void {
    this.jobs.delete(jobId)
    this.emit(job, patch)
  }
}
