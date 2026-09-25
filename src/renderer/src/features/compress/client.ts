import type { Analysis } from './pdf/analyze'
import type { CompressResult } from './pdf/compress'
import type { CompressOptions } from './pdf/options'
import type { WorkerRequest, WorkerResponse } from './protocol'
import CompressWorker from './worker?worker'

/** Runs one job in a fresh Web Worker. `cancel()` terminates it (memory is released immediately). */

export class CompressCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

export interface Job<T> {
  promise: Promise<T>
  cancel(): void
}

let nextId = 1

function start<T>(req: WorkerRequest, onProgress: ((fraction: number, label: string) => void) | undefined, pick: (r: WorkerResponse) => T | undefined): Job<T> {
  const worker = new CompressWorker()
  let settled = false
  let rejectFn: (e: Error) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    rejectFn = reject
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data
      if (m.id !== req.id) return
      if (m.type === 'progress') return onProgress?.(m.fraction, m.label)
      settled = true
      worker.terminate()
      if (m.type === 'error') return reject(new Error(m.message))
      const v = pick(m)
      if (v === undefined) reject(new Error('Unexpected reply from the compression worker.'))
      else resolve(v)
    }
    worker.onerror = (e) => {
      if (settled) return
      settled = true
      worker.terminate()
      reject(new Error(e.message ? `Compression stopped: ${e.message}` : 'Compression stopped unexpectedly (the document may be too large for the memory available).'))
    }
    worker.onmessageerror = () => {
      if (settled) return
      settled = true
      worker.terminate()
      reject(new Error('Compression could not exchange data with its worker.'))
    }
    worker.postMessage(req)
  })
  return {
    promise,
    cancel: () => {
      if (settled) return
      settled = true
      worker.terminate()
      rejectFn(new CompressCancelled())
    }
  }
}

export function analyzeInWorker(bytes: Uint8Array): Job<Analysis> {
  return start({ type: 'analyze', id: nextId++, bytes }, undefined, (r) => (r.type === 'analysis' ? r.analysis : undefined))
}

export function compressInWorker(bytes: Uint8Array, options: CompressOptions, onProgress: (fraction: number, label: string) => void): Job<CompressResult> {
  return start({ type: 'compress', id: nextId++, bytes, options }, onProgress, (r) => (r.type === 'result' ? r.result : undefined))
}
