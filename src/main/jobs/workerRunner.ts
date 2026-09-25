import { execFile, type ExecFileOptions } from 'node:child_process'
import type { Worker, WorkerOptions } from 'node:worker_threads'
import type { JobContext } from './JobManager'

/** Messages a worker posts back. Workers use `serveJob` (./serveJob.ts) so they never build these by hand. */
export type WorkerMessage =
  | { type: 'progress'; fraction: number; message?: string }
  | { type: 'result'; value: unknown }
  | { type: 'error'; message: string }

/**
 * Runs `payload` in a worker thread and resolves with its result. Progress is forwarded to the job, and
 * cancelling the job terminates the worker immediately (no cooperation needed).
 *
 * ```ts
 * import createWorker from './ocrWorker?nodeWorker'   // electron-vite bundles + resolves the worker file
 * jobs.register('ocr:run', 'Recognizing text', schema, (p, ctx) => runInWorker(createWorker, p, ctx))
 * ```
 */
export function runInWorker<R>(createWorker: (options: WorkerOptions) => Worker, payload: unknown, ctx: JobContext): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    if (ctx.signal.aborted) return reject(new Error('Cancelled'))
    const worker = createWorker({})
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      ctx.signal.removeEventListener('abort', onAbort)
      void worker.terminate()
      fn()
    }
    const onAbort = (): void => done(() => reject(new Error('Cancelled')))
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (m: WorkerMessage) => {
      if (m.type === 'progress') ctx.progress(m.fraction, m.message)
      else if (m.type === 'result') done(() => resolve(m.value as R))
      else done(() => reject(new Error(m.message)))
    })
    worker.on('error', (err) => done(() => reject(err)))
    worker.on('exit', (code) => done(() => reject(new Error(`Worker exited unexpectedly (code ${code})`))))
    worker.postMessage({ payload })
  })
}

export interface ProcessResult {
  stdout: string
  stderr: string
}

/**
 * Runs a native tool (qpdf, tesseract, soffice, ...) without blocking the main process. Rejects with the
 * tool's stderr on a non-zero exit; kills the child when the job is cancelled. Arguments are passed as an
 * array (never through a shell), so file names cannot inject commands.
 */
export function runProcess(
  file: string,
  args: string[],
  ctx: JobContext,
  options: ExecFileOptions & { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void } = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) return reject(new Error('Cancelled'))
    const { onStdout, onStderr, ...execOptions } = options
    const child = execFile(
      file,
      args,
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...execOptions, signal: ctx.signal, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const aborted = (err as NodeJS.ErrnoException).name === 'AbortError' || ctx.signal.aborted
          reject(new Error(aborted ? 'Cancelled' : `${file} failed: ${String(stderr).trim() || err.message}`))
        } else resolve({ stdout: String(stdout), stderr: String(stderr) })
      }
    )
    child.stdout?.on('data', (d: Buffer | string) => onStdout?.(String(d)))
    child.stderr?.on('data', (d: Buffer | string) => onStderr?.(String(d)))
  })
}
