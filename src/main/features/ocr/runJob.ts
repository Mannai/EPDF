import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { OcrEngine } from './engine'
import type { LanguageStore } from './languages'
import type { OcrSession } from './session'

export interface RunJobOptions {
  session: OcrSession
  store: LanguageStore
  /** Parent folder for the per-run temp folder (deleted afterwards). */
  tempRoot: string
  workers: number
  signal: AbortSignal
  progress(fraction: number, message?: string): void
}

/**
 * The body of the `ocr:run` job: starts the Tesseract workers, then keeps them busy with the page pictures the
 * renderer sends until every page has been answered (or the run is cancelled / ended by the renderer).
 * Cancelling terminates the worker threads at once and rejects every page still waiting.
 */
export async function runOcrJob(o: RunJobOptions): Promise<{ recognized: number }> {
  const { session, signal } = o
  session.started = true
  if (session.isClosed && !session.hasQueued) return { recognized: 0 } // the renderer had nothing to send
  const langDir = join(o.tempRoot, `epdf-ocr-${randomUUID()}`)
  let engine: OcrEngine | null = null
  const cancelled = new Error('Cancelled')
  let onAbort: (() => void) | null = null
  try {
    if (signal.aborted) throw cancelled
    o.progress(0, 'Starting the text recognition engine')
    await o.store.stageInto(langDir, session.languages)
    engine = await OcrEngine.create({ langPath: langDir, languages: session.languages, workers: o.workers })
    if (signal.aborted) throw cancelled

    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        session.fail(cancelled)
        void engine?.terminate()
        reject(cancelled)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    aborted.catch(() => undefined)

    let done = 0
    const eng = engine
    const lane = async (): Promise<void> => {
      for (;;) {
        const item = await session.next()
        if (!item) return
        const r = await eng.recognize(item.image)
        if (!item.retry) done++
        session.settle(item, r)
        o.progress(Math.min(1, done / session.total), `Recognized page ${done} of ${session.total}`)
        if (done >= session.total && !session.mayRetry) session.end()
      }
    }
    await Promise.race([Promise.all(Array.from({ length: eng.size }, lane)), aborted])
    return { recognized: done }
  } catch (err) {
    session.fail(err instanceof Error ? err : new Error(String(err)))
    throw err
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    session.end()
    await engine?.terminate()
    await rm(langDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
