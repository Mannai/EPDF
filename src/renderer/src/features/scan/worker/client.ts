import type { Op, WorkerCall, WorkerReply, WorkerRequests, WorkerResponses } from './protocol'

/** Promise-based access to the scan Web Worker. One worker, created on first use, replaced after `terminate()`. */

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
}

class ScanWorkerClient {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 0

  private ensure(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./scanWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<WorkerReply>): void => {
      const p = this.pending.get(e.data.reqId)
      if (!p) return
      this.pending.delete(e.data.reqId)
      if (e.data.ok) p.resolve(e.data.result)
      else p.reject(new Error(e.data.error))
    }
    w.onerror = (e): void => this.failAll(new Error(e.message || 'The image worker stopped unexpectedly.'))
    this.worker = w
    return w
  }

  call<O extends Op>(op: O, payload: WorkerRequests[O], transfer: Transferable[] = []): Promise<WorkerResponses[O]> {
    return new Promise((resolve, reject) => {
      let w: Worker
      try {
        w = this.ensure()
      } catch (err) {
        return reject(err instanceof Error ? err : new Error(String(err)))
      }
      const reqId = ++this.seq
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject })
      const msg: WorkerCall<O> = { reqId, op, payload }
      w.postMessage(msg, transfer)
    })
  }

  private failAll(err: Error): void {
    const all = [...this.pending.values()]
    this.pending.clear()
    all.forEach((p) => p.reject(err))
  }

  /** Stops any running work at once (used by Cancel). Cached pictures in the worker are lost. */
  terminate(): void {
    this.worker?.terminate()
    this.worker = null
    this.failAll(new Error('Cancelled'))
  }
}

export const scanWorker = new ScanWorkerClient()
