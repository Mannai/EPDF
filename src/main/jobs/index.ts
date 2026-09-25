import { z } from 'zod'
import { registerFeatureChannel, sendFeatureEvent } from '../features/api'
import type { WindowManager } from '../windows/WindowManager'
import { JobManager } from './JobManager'
import { runInWorker } from './workerRunner'
import createSelfTestWorker from './selfTestWorker?nodeWorker'

/** Creates the job manager and exposes it to the renderer as `job:start` / `job:cancel` + `job:update` events. */
export function createJobs(windows: WindowManager): JobManager {
  const jobs = new JobManager()

  jobs.onUpdate = (update, owner) => {
    const target = owner === undefined ? undefined : windows.get(owner)
    if (target) sendFeatureEvent(target, 'job:update', update)
    else sendFeatureEvent('all', 'job:update', update)
  }

  registerFeatureChannel(
    'job:start',
    z.object({ kind: z.string().max(80), payload: z.unknown() }),
    ({ kind, payload }, ctx) => ({ jobId: jobs.start(kind, payload, ctx.window?.win.id) })
  )
  registerFeatureChannel('job:cancel', z.object({ jobId: z.string().max(64) }), ({ jobId }, ctx) =>
    jobs.cancel(jobId, ctx.window?.win.id)
  )

  jobs.register(
    'selftest:count',
    'Self-test',
    z.object({ steps: z.number().int().min(1).max(1000), delayMs: z.number().int().min(0).max(5000) }),
    (payload, ctx) => runInWorker<{ counted: number }>(createSelfTestWorker, payload, ctx)
  )
  return jobs
}
