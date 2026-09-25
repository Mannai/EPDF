// A plain worker speaking the same protocol as src/main/jobs/serveJob.ts, for unit-testing runInWorker.
import { parentPort } from 'node:worker_threads'

parentPort.once('message', async ({ payload }) => {
  try {
    if (payload.fail) throw new Error('worker exploded')
    let sum = 0
    for (let i = 1; i <= payload.steps; i++) {
      await new Promise((r) => setTimeout(r, payload.delayMs))
      sum += i
      parentPort.postMessage({ type: 'progress', fraction: i / payload.steps })
    }
    parentPort.postMessage({ type: 'result', value: { sum } })
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err.message })
  }
})
