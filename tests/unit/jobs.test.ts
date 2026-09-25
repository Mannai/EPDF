import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JobManager } from '../../src/main/jobs/JobManager'
import { runInWorker, runProcess } from '../../src/main/jobs/workerRunner'
import type { JobUpdate } from '../../src/shared/jobs'

const setup = () => {
  const jm = new JobManager()
  const updates: JobUpdate[] = []
  jm.onUpdate = (u) => updates.push({ ...u })
  const last = (id: string) => [...updates].reverse().find((u) => u.jobId === id)!
  const settled = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      if (last(id)?.state !== 'running') return last(id)
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('job did not settle')
  }
  return { jm, updates, last, settled }
}

describe('JobManager', () => {
  it('runs a job to completion and reports its result', async () => {
    const { jm, settled } = setup()
    jm.register('t:add', 'Add', z.object({ a: z.number(), b: z.number() }), async ({ a, b }) => a + b)
    const id = jm.start('t:add', { a: 2, b: 3 })
    const done = await settled(id)
    expect(done.state).toBe('done')
    expect(done.result).toBe(5)
    expect(done.progress).toBe(1)
    expect(jm.isRunning(id)).toBe(false)
  })

  it('rejects unknown kinds and invalid payloads before running anything', () => {
    const { jm } = setup()
    let ran = false
    jm.register('t:x', 'X', z.object({ n: z.number() }), async () => void (ran = true))
    expect(() => jm.start('t:nope', {})).toThrow(/Unknown job kind/)
    expect(() => jm.start('t:x', { n: 'no' })).toThrow(/Invalid payload/)
    expect(ran).toBe(false)
  })

  it('refuses to register the same kind twice', () => {
    const { jm } = setup()
    jm.register('t:x', 'X', z.any(), async () => 1)
    expect(() => jm.register('t:x', 'X', z.any(), async () => 1)).toThrow(/already registered/)
  })

  it('reports failures with the error message', async () => {
    const { jm, settled } = setup()
    jm.register('t:boom', 'Boom', z.any(), async () => {
      throw new Error('kaboom')
    })
    const done = await settled(jm.start('t:boom', {}))
    expect(done.state).toBe('failed')
    expect(done.error).toBe('kaboom')
  })

  it('forwards (throttled) progress and clamps it to 0..1', async () => {
    const { jm, updates, settled } = setup()
    jm.register('t:p', 'P', z.any(), async (_p, ctx) => {
      ctx.progress(-5, 'low')
      await new Promise((r) => setTimeout(r, 60))
      ctx.progress(0.5, 'half')
      await new Promise((r) => setTimeout(r, 60))
      ctx.progress(7, 'over')
    })
    const id = jm.start('t:p', {})
    await settled(id)
    const running = updates.filter((u) => u.jobId === id && u.state === 'running')
    expect(running.every((u) => u.progress >= 0 && u.progress <= 1)).toBe(true)
    expect(running.some((u) => u.message === 'half' && u.progress === 0.5)).toBe(true)
  })

  it('cancels a running job via its abort signal', async () => {
    const { jm, settled } = setup()
    jm.register('t:slow', 'Slow', z.any(), (_p, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('Cancelled')))))
    const id = jm.start('t:slow', {})
    expect(jm.cancel(id)).toBe(true)
    expect((await settled(id)).state).toBe('cancelled')
  })

  it('only the owning window may cancel a job', async () => {
    const { jm, settled } = setup()
    jm.register('t:slow', 'Slow', z.any(), (_p, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('x')))))
    const id = jm.start('t:slow', {}, 7)
    expect(jm.cancel(id, 8)).toBe(false)
    expect(jm.isRunning(id)).toBe(true)
    expect(jm.cancel(id, 7)).toBe(true)
    expect((await settled(id)).state).toBe('cancelled')
  })
})

describe('runInWorker', () => {
  const worker = () => new Worker(join(__dirname, '../fixtures/testWorker.mjs'))
  const ctx = (signal = new AbortController().signal, progress: (f: number, m?: string) => void = () => undefined) => ({ signal, progress })

  it('runs work off-thread, streams progress and returns the result', async () => {
    const seen: number[] = []
    const r = await runInWorker<{ sum: number }>(worker, { steps: 4, delayMs: 5 }, ctx(undefined, (f) => seen.push(f)))
    expect(r).toEqual({ sum: 10 })
    expect(seen[seen.length - 1]).toBe(1)
  })

  it('terminates the worker when cancelled', async () => {
    const ac = new AbortController()
    const p = runInWorker(worker, { steps: 1000, delayMs: 50 }, ctx(ac.signal))
    setTimeout(() => ac.abort(), 30)
    await expect(p).rejects.toThrow('Cancelled')
  })

  it('surfaces errors thrown inside the worker', async () => {
    await expect(runInWorker(worker, { fail: true }, ctx())).rejects.toThrow('worker exploded')
  })
})

describe('runProcess', () => {
  it('captures output and passes arguments without a shell', async () => {
    const c = { signal: new AbortController().signal, progress: () => undefined }
    const r = await runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', 'a b; echo pwned'], c)
    expect(r.stdout.trim()).toBe('a b; echo pwned')
  })
  it('rejects with stderr on a non-zero exit', async () => {
    const c = { signal: new AbortController().signal, progress: () => undefined }
    await expect(runProcess(process.execPath, ['-e', 'console.error("bad thing"); process.exit(3)'], c)).rejects.toThrow(/bad thing/)
  })
  it('kills the child when cancelled', async () => {
    const ac = new AbortController()
    const p = runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { signal: ac.signal, progress: () => undefined })
    setTimeout(() => ac.abort(), 50)
    await expect(p).rejects.toThrow('Cancelled')
  })
})
