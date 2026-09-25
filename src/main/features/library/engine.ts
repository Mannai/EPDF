import type { Worker } from 'node:worker_threads'
import type { ExtractRequest, ExtractResult } from './extract'
import type { ScanOptions, ScanResult } from './scanner'

/**
 * The heavy half of indexing (folder scans, text extraction) behind an interface, so the orchestration in
 * indexer.ts is testable without threads. `WorkerEngine` runs it in a worker thread; tests use an in-process
 * engine that calls the same functions directly.
 */
export interface IndexEngine {
  scan(root: string, options: Pick<ScanOptions, 'maxDepth' | 'maxFiles'>, onProgress: (found: number) => void, signal: AbortSignal): Promise<ScanResult>
  extract(request: ExtractRequest, signal: AbortSignal): Promise<ExtractResult>
  hash(path: string, signal: AbortSignal): Promise<{ hash: string; size: number } | null>
  close(): Promise<void>
}

export type WorkerRequest =
  | { op: 'scan'; id: number; root: string; options: Pick<ScanOptions, 'maxDepth' | 'maxFiles'> }
  | { op: 'extract'; id: number; request: ExtractRequest }
  | { op: 'hash'; id: number; path: string }
  | { op: 'abort'; target: number }

export type WorkerReply =
  | { id: number; type: 'progress'; found: number; dir: string }
  | { id: number; type: 'result'; value: unknown }
  | { id: number; type: 'error'; message: string }

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  onProgress?: (found: number) => void
}

export class WorkerEngine implements IndexEngine {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()

  /** `extractTimeoutMs`: one file that takes longer than this is abandoned (the worker is replaced). */
  constructor(
    private create: () => Worker,
    private extractTimeoutMs = 90_000
  ) {}

  private ensure(): Worker {
    if (this.worker) return this.worker
    const w = this.create()
    w.on('message', (m: WorkerReply) => {
      const p = this.pending.get(m.id)
      if (!p) return
      if (m.type === 'progress') p.onProgress?.(m.found)
      else {
        this.pending.delete(m.id)
        if (m.type === 'result') p.resolve(m.value)
        else p.reject(new Error(m.message))
      }
    })
    const dead = (reason: string): void => {
      if (this.worker === w) this.worker = null
      for (const [id, p] of [...this.pending]) {
        this.pending.delete(id)
        p.reject(new Error(reason))
      }
    }
    w.on('error', (err: Error) => dead(`The index worker failed: ${err.message}`))
    w.on('exit', () => dead('The index worker stopped.'))
    this.worker = w
    return w
  }

  private kill(reason = 'Cancelled'): void {
    const w = this.worker
    this.worker = null
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id)
      p.reject(new Error(reason))
    }
    if (w) void w.terminate()
  }

  private request<T>(build: (id: number) => WorkerRequest, signal: AbortSignal, opts: { onProgress?: (n: number) => void; timeoutMs?: number; softAbort?: boolean } = {}): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error('Cancelled'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        if (opts.softAbort && this.worker) this.worker.postMessage({ op: 'abort', target: id } satisfies WorkerRequest)
        else this.kill('Cancelled')
      }
      this.pending.set(id, {
        resolve: (v) => (cleanup(), resolve(v as T)),
        reject: (e) => (cleanup(), reject(e)),
        onProgress: opts.onProgress
      })
      signal.addEventListener('abort', onAbort, { once: true })
      if (opts.timeoutMs) timer = setTimeout(() => this.kill(`Timed out after ${Math.round(opts.timeoutMs! / 1000)} s`), opts.timeoutMs)
      try {
        this.ensure().postMessage(build(id))
      } catch (err) {
        this.pending.delete(id)
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  scan(root: string, options: Pick<ScanOptions, 'maxDepth' | 'maxFiles'>, onProgress: (found: number) => void, signal: AbortSignal): Promise<ScanResult> {
    return this.request<ScanResult>((id) => ({ op: 'scan', id, root, options }), signal, { onProgress, softAbort: true })
  }

  extract(request: ExtractRequest, signal: AbortSignal): Promise<ExtractResult> {
    return this.request<ExtractResult>((id) => ({ op: 'extract', id, request }), signal, { timeoutMs: this.extractTimeoutMs })
  }

  hash(path: string, signal: AbortSignal): Promise<{ hash: string; size: number } | null> {
    return this.request((id) => ({ op: 'hash', id, path }), signal, { timeoutMs: 30_000 })
  }

  async close(): Promise<void> {
    this.kill('Closed')
  }
}
