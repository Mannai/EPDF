import { randomUUID } from 'node:crypto'
import type { OcrPageResult } from '../../../shared/features/ocr'

/**
 * One OCR run. The renderer draws the pages (PDF.js lives there) and hands the pictures over one by one
 * through `add`; the job in main pulls them with `next`, recognizes them and settles the promise `add`
 * returned. Pictures are held only while they wait for a free Tesseract worker, so a 1000-page scan never
 * sits in memory as a whole.
 */

interface Waiting {
  index: number
  image: Uint8Array
  resolve(r: OcrPageResult): void
  reject(e: Error): void
}

export class OcrSession {
  readonly id = randomUUID()
  private queue: Waiting[] = []
  private takers: ((w: Waiting | null) => void)[] = []
  private pending = new Set<Waiting>()
  private closed: Error | null = null
  private ended = false
  /** Set by the job once it has started, so `ocr:end` can tell "never started" from "running". */
  started = false

  constructor(
    readonly languages: string[],
    readonly total: number
  ) {}

  get hasQueued(): boolean {
    return this.queue.length > 0
  }

  get isClosed(): boolean {
    return this.ended || this.closed !== null
  }

  /** Queues a page picture. Resolves with its recognition result. */
  add(index: number, image: Uint8Array): Promise<OcrPageResult> {
    if (this.closed) return Promise.reject(this.closed)
    if (this.ended) return Promise.reject(new Error('This recognition run has ended.'))
    return new Promise((resolve, reject) => {
      const w: Waiting = { index, image, resolve, reject }
      this.pending.add(w)
      const taker = this.takers.shift()
      if (taker) taker(w)
      else this.queue.push(w)
    })
  }

  /** The next picture to recognize, or null when the run has ended. */
  next(): Promise<Waiting | null> {
    const w = this.queue.shift()
    if (w) return Promise.resolve(w)
    if (this.closed || this.ended) return Promise.resolve(null)
    return new Promise((resolve) => this.takers.push(resolve))
  }

  settle(w: Waiting, r: OcrPageResult): void {
    this.pending.delete(w)
    w.resolve(r)
  }

  /** Normal end (the renderer has nothing more to send, or all pages are done). */
  end(): void {
    this.ended = true
    this.flush(new Error('This recognition run has ended.'))
  }

  /** Abnormal end: every waiting `add` rejects with `err`. */
  fail(err: Error): void {
    this.closed ??= err
    this.flush(err)
  }

  private flush(err: Error): void {
    for (const w of this.pending) w.reject(err)
    this.pending.clear()
    this.queue = []
    for (const t of this.takers) t(null)
    this.takers = []
  }
}

/** Registry of live sessions. Sessions the renderer never started or ended are dropped after an hour. */
export class SessionRegistry {
  private sessions = new Map<string, { session: OcrSession; created: number }>()

  create(languages: string[], total: number): OcrSession {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (now - s.created > 3600_000) {
        s.session.fail(new Error('This recognition run expired.'))
        this.sessions.delete(id)
      }
    }
    const session = new OcrSession(languages, total)
    this.sessions.set(session.id, { session, created: now })
    return session
  }

  get(id: string): OcrSession | undefined {
    return this.sessions.get(id)?.session
  }

  drop(id: string): void {
    this.sessions.delete(id)
  }

  get size(): number {
    return this.sessions.size
  }
}
