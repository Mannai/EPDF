import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PageSize } from '../viewer/layout'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Fonts, CMaps and WASM decoders are bundled in /pdfjs so nothing is fetched from the network. */
const ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/'
}

export class PasswordCancelledError extends Error {
  constructor() {
    super('A password is required to open this document.')
  }
}

export interface LoadedDoc {
  docId: string
  doc: PDFDocumentProxy
  numPages: number
  /** Page sizes in PDF points at scale 1 (rotation applied). Entries fill in lazily; null = unknown. */
  sizes: (PageSize | null)[]
  /** Bumped whenever `sizes` gains entries so views can re-layout. */
  sizesVersion: number
  destroyed: boolean
  listeners: Set<() => void>
}

/** Where PDF.js reads the document from: the file on disk (streamed, range requests) or in-memory bytes. */
export type DocSource = { url: string } | { data: Uint8Array }

const pending = new Map<string, Promise<LoadedDoc>>()
/** The newest loaded document per docId. Older ones are retired shortly after a newer one is ready. */
const loaded = new Map<string, LoadedDoc>()
let loadCounter = 0
const RETIRE_DELAY_MS = 1500

export const getLoaded = (docId: string): LoadedDoc | undefined => loaded.get(docId)

/**
 * The password PDF.js last accepted for a document, kept in memory only (never persisted) so that unlocking the
 * document for editing (Security feature) does not ask for it a second time. Forgotten when the document is destroyed.
 */
const acceptedPasswords = new Map<string, string>()
export const getAcceptedPassword = (docId: string): string | undefined => acceptedPasswords.get(docId)

export type PasswordPrompter = (incorrect: boolean) => Promise<string | null>

async function destroyEntry(entry: LoadedDoc): Promise<void> {
  entry.destroyed = true
  entry.listeners.clear()
  await entry.doc.loadingTask.destroy().catch(() => undefined)
}

/**
 * Loads a document. `key` identifies this version of the content (e.g. `"0:3"` = load 0, edit 3); asking
 * again for the same key returns the same promise. When a newer version finishes loading it replaces the
 * older one, which is destroyed after a short grace period so pages still mid-render can finish cleanly.
 */
export function loadDoc(docId: string, key: string, source: DocSource, askPassword: PasswordPrompter): Promise<LoadedDoc> {
  const pendingKey = `${docId}:${key}`
  const existing = pending.get(pendingKey)
  if (existing) return existing
  const order = ++loadCounter

  const task = (async () => {
    const loadingTask = pdfjs.getDocument({
      // PDF.js takes ownership of `data`'s buffer, so hand it a copy: the edit history keeps its own.
      ...('url' in source ? { url: source.url } : { data: source.data.slice() }),
      rangeChunkSize: 1 << 20,
      disableAutoFetch: true, // only fetch the byte ranges pages actually need
      enableXfa: false, // XFA forms embed scripts; PDF scripting is never enabled in Epdf
      ...ASSETS
    })
    let cancelled = false
    let usedPassword: string | undefined
    loadingTask.onPassword = (update: (pw: string) => void, reason: number) => {
      void askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (pw === null) {
          cancelled = true
          void loadingTask.destroy()
        } else {
          usedPassword = pw
          update(pw)
        }
      })
    }
    let doc: PDFDocumentProxy
    try {
      doc = await loadingTask.promise
    } catch (err) {
      if (cancelled) throw new PasswordCancelledError()
      throw err
    }
    if (usedPassword !== undefined) acceptedPasswords.set(docId, usedPassword)
    const first = await doc.getPage(1)
    const vp = first.getViewport({ scale: 1 })
    const sizes: (PageSize | null)[] = new Array<PageSize | null>(doc.numPages).fill(null)
    sizes[0] = { w: vp.width, h: vp.height }
    const entry: LoadedDoc = {
      docId,
      doc,
      numPages: doc.numPages,
      sizes,
      sizesVersion: 1,
      destroyed: false,
      listeners: new Set()
    }
    const prev = loaded.get(docId)
    if (prev && (loadOrder.get(prev) ?? 0) > order) {
      // A newer load already finished first (rapid edits): this one is obsolete.
      void destroyEntry(entry)
      return entry
    }
    loaded.set(docId, entry)
    loadOrder.set(entry, order)
    if (prev) setTimeout(() => void destroyEntry(prev), RETIRE_DELAY_MS)
    void prefetchSizes(entry)
    return entry
  })()

  pending.set(pendingKey, task)
  task.catch(() => pending.delete(pendingKey))
  return task
}

/** Monotonic id of the load that produced each entry, so a slow older load can't replace a newer one. */
const loadOrder = new WeakMap<LoadedDoc, number>()

/** Reads every page's size in small batches, yielding to the UI thread between batches. */
async function prefetchSizes(entry: LoadedDoc): Promise<void> {
  const BATCH = 24
  for (let start = 1; start < entry.numPages && !entry.destroyed; start += BATCH) {
    const end = Math.min(start + BATCH, entry.numPages)
    try {
      await Promise.all(
        Array.from({ length: end - start }, async (_, i) => {
          const pageNo = start + i + 1
          const page = await entry.doc.getPage(pageNo)
          const vp = page.getViewport({ scale: 1 })
          entry.sizes[pageNo - 1] = { w: vp.width, h: vp.height }
          page.cleanup()
        })
      )
    } catch {
      return // damaged page tree: keep estimates for the remainder
    }
    if (entry.destroyed) return
    entry.sizesVersion++
    entry.listeners.forEach((l) => l())
    await new Promise((r) => setTimeout(r, 0))
  }
}

/** Destroys the newest loaded version of a document and forgets every pending load for it. */
export async function destroyDoc(docId: string): Promise<void> {
  const entry = loaded.get(docId)
  for (const k of [...pending.keys()]) if (k.startsWith(`${docId}:`)) pending.delete(k)
  loaded.delete(docId)
  acceptedPasswords.delete(docId)
  if (entry) await destroyEntry(entry)
}
