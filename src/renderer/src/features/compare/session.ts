import { currentBytes } from '../../edit/session'
import { PasswordCancelledError, destroyDoc, loadDoc, type LoadedDoc } from '../../pdf/docCache'
import { useUi } from '../../state/ui'
import { runCompare } from './diff/engine'
import { changeText, type ChangeText } from './diff/enrich'
import type { CompareOptions, CompareResult, PageModel } from './diff/types'
import type { EngineMessage } from './engine.worker'
import EngineWorker from './engine.worker?worker'
import { extractDocument } from './extract'

/**
 * One comparison, start to finish: open both documents (private copies, so edits or closing a tab cannot pull a
 * document out from under the comparison), read their text page by page with progress, run the engine in a Web
 * Worker and attach the readable texts. Everything is cancellable through an AbortSignal.
 */

export type Source = { kind: 'tab'; docId: string; name: string } | { kind: 'file'; name: string; bytes: Uint8Array }

/** A problem with one of the inputs that the user can act on; the message is shown as is. */
export class CompareInputError extends Error {}

export interface Side {
  name: string
  /** The private document id this side is registered under in the PDF.js document cache. */
  docId: string
  loaded: LoadedDoc
}

export interface Progress {
  label: string
  /** 0..1 over the whole run. */
  fraction: number
}

export interface Session {
  oldSide: Side
  newSide: Side
  oldPages: PageModel[]
  newPages: PageModel[]
  result: CompareResult
  /** Readable text of each change, indexed by change id. */
  texts: ChangeText[]
  opts: CompareOptions
  /** Pages whose text PDF.js could not read (treated as empty). */
  failed: { old: number[]; new: number[] }
  /** Neither document has selectable text (scans): only the visual comparison can find differences. */
  noText: boolean
}

let counter = 0

const isPasswordError = (err: unknown): boolean => err instanceof PasswordCancelledError || (err as { name?: string } | null)?.name === 'PasswordException'

/** Turns whatever PDF.js threw into a sentence for the user. */
export function describeOpenError(err: unknown, name: string): string {
  if (isPasswordError(err)) {
    return `“${name}” is password protected and no password was given. Open it in Epdf and enter its password, then choose it again from the open tabs.`
  }
  const n = (err as { name?: string } | null)?.name ?? ''
  if (/InvalidPDF|Format|MissingPDF|UnexpectedResponse/i.test(n) || /Invalid PDF|not a PDF|XRef|Missing PDF/i.test(String((err as Error)?.message ?? ''))) {
    return `“${name}” could not be read: it is damaged or is not a PDF file.`
  }
  return `“${name}” could not be opened: ${err instanceof Error ? err.message : String(err)}`
}

export async function openSide(src: Source): Promise<Side> {
  const docId = `compare-${++counter}`
  try {
    const bytes = src.kind === 'tab' ? await currentBytes(src.docId) : src.bytes
    const loaded = await loadDoc(docId, '0', { data: bytes }, (incorrect) => useUi.getState().askPassword(src.name, incorrect))
    return { name: src.name, docId, loaded }
  } catch (err) {
    await destroyDoc(docId)
    throw new CompareInputError(describeOpenError(err, src.name))
  }
}

export const releaseSide = (s: Side): Promise<void> => destroyDoc(s.docId)

const abortError = (): DOMException => new DOMException('Cancelled', 'AbortError')
export const isAbort = (err: unknown): boolean => (err as { name?: string } | null)?.name === 'AbortError'

/** Runs the engine in a worker; falls back to the calling thread if workers are unavailable. */
export function runEngine(oldKeys: string[][], newKeys: string[][], opts: CompareOptions, signal: AbortSignal, onProgress: (phase: string, fraction: number) => void): Promise<CompareResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    let worker: Worker | null = null
    const inline = (): void => {
      try {
        resolve(runCompare(oldKeys, newKeys, opts))
      } catch (err) {
        reject(err)
      }
    }
    try {
      worker = new EngineWorker()
    } catch {
      return inline()
    }
    const w = worker
    signal.addEventListener(
      'abort',
      () => {
        w.terminate()
        reject(abortError())
      },
      { once: true }
    )
    w.onmessage = (e: MessageEvent<EngineMessage>) => {
      const m = e.data
      if (m.type === 'progress') onProgress(m.phase, m.total ? m.done / m.total : 1)
      else if (m.type === 'result') {
        w.terminate()
        resolve(m.result)
      } else {
        w.terminate()
        reject(new Error(m.message))
      }
    }
    w.onerror = () => {
      w.terminate()
      inline()
    }
    w.postMessage({ type: 'run', old: oldKeys, new: newKeys, opts })
  })
}

/** Attaches text and character marks to every change. */
export function textsFor(result: CompareResult, oldPages: PageModel[], newPages: PageModel[]): ChangeText[] {
  return result.changes.map((c) => {
    const o = c.old ? oldPages[result.pairs[c.old.pair].old! - 1] : undefined
    const n = c.new ? newPages[result.pairs[c.new.pair].new! - 1] : undefined
    return changeText(c, o, n)
  })
}

/**
 * Compares two sources. Rejects with a `CompareInputError` for an unreadable input, or an AbortError when
 * `signal` aborts (in which case everything that was opened is released again).
 */
export async function runComparison(oldSrc: Source, newSrc: Source, opts: CompareOptions, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<Session> {
  const opened: Side[] = []
  try {
    onProgress({ label: 'Opening the documents', fraction: 0.01 })
    const oldSide = await openSide(oldSrc)
    opened.push(oldSide)
    if (signal.aborted) throw abortError()
    const newSide = await openSide(newSrc)
    opened.push(newSide)
    if (signal.aborted) throw abortError()

    const nOld = oldSide.loaded.numPages
    const nNew = newSide.loaded.numPages
    const total = nOld + nNew
    const reading = (which: string, done: number, offset: number): void =>
      onProgress({ label: `Reading the ${which} version: page ${done} of ${which === 'old' ? nOld : nNew}`, fraction: 0.02 + 0.8 * ((offset + done) / Math.max(1, total)) })
    const o = await extractDocument(oldSide.loaded.doc, opts, signal, (done) => reading('old', done, 0))
    const n = await extractDocument(newSide.loaded.doc, opts, signal, (done) => reading('new', done, nOld))

    const result = await runEngine(
      o.pages.map((p) => p.keys),
      n.pages.map((p) => p.keys),
      opts,
      signal,
      (phase, f) => {
        const base = phase === 'align' ? 0.82 : phase === 'diff' ? 0.85 : 0.97
        const span = phase === 'align' ? 0.03 : phase === 'diff' ? 0.12 : 0.03
        onProgress({ label: phase === 'align' ? 'Matching pages' : phase === 'diff' ? 'Comparing the text' : 'Looking for moved text', fraction: base + span * f })
      }
    )
    if (signal.aborted) throw abortError()
    const texts = textsFor(result, o.pages, n.pages)
    const noText = o.pages.every((p) => p.keys.length === 0) && n.pages.every((p) => p.keys.length === 0)
    onProgress({ label: 'Done', fraction: 1 })
    return { oldSide, newSide, oldPages: o.pages, newPages: n.pages, result, texts, opts, failed: { old: o.failed, new: n.failed }, noText }
  } catch (err) {
    for (const s of opened) void releaseSide(s)
    throw err
  }
}
