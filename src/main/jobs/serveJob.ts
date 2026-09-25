import { parentPort } from 'node:worker_threads'
import type { WorkerMessage } from './workerRunner'

/**
 * Entry point for worker files. The worker receives one `{ payload }` message, runs `fn`, and posts
 * progress/result/error messages that `runInWorker` understands.
 *
 * ```ts
 * // ocrWorker.ts
 * import { serveJob } from '../jobs/serveJob'
 * serveJob<{ pages: number }, string>(async ({ pages }, report) => { report(0.5, 'Halfway'); return 'done' })
 * ```
 */
export function serveJob<P, R>(fn: (payload: P, report: (fraction: number, message?: string) => void) => Promise<R> | R): void {
  if (!parentPort) throw new Error('serveJob must be called from a worker thread')
  const port = parentPort
  const post = (m: WorkerMessage): void => port.postMessage(m)
  port.once('message', async ({ payload }: { payload: P }) => {
    try {
      const value = await fn(payload, (fraction, message) => post({ type: 'progress', fraction, message }))
      post({ type: 'result', value })
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  })
}
