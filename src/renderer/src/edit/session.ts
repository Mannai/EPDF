import { PDFDocument } from 'pdf-lib'
import { create } from 'zustand'
import { useTabs } from '../state/tabs'
import { History } from './history'

/**
 * The edit pipeline every feature goes through. Each document has a linear history of full-file byte
 * snapshots; an edit produces a new snapshot, undo/redo move along the history, and the viewer reloads
 * from the current snapshot. Nothing touches the file on disk until Save.
 *
 *   await editPdf(docId, 'Rotate page', (pdf) => { pdf.getPage(0).setRotation(degrees(90)) })
 *   replaceBytes(docId, 'Compress', compressedBytes)   // for results produced elsewhere (jobs, qpdf, ...)
 */

export interface EditInfo {
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  undoLabel?: string
  redoLabel?: string
  /** Increments on every change; lets timers detect "something new to autosave". */
  version: number
}

const histories = new Map<string, History<Uint8Array>>()
/**
 * Edits are asynchronous (load → modify → serialize). They run one at a time per document, in the order
 * requested, and anything that reads the document (save, undo, close, another edit) waits for the queue,
 * so "rotate, then immediately save" always saves the rotated document.
 */
const queues = new Map<string, Promise<unknown>>()
let docBaseUrl: string | null = null

function enqueue<T>(docId: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(docId) ?? Promise.resolve()).then(work, work)
  queues.set(docId, run.catch(() => undefined))
  return run
}

/** Resolves when every edit requested so far for this document has been applied (or has failed). */
export async function whenEditsSettled(docId: string): Promise<void> {
  await queues.get(docId)
}

/** Reactive per-document edit state for the UI (undo/redo enabled, dirty dot, ...). */
export const useEdits = create<Record<string, EditInfo>>(() => ({}))

const NONE: EditInfo = { dirty: false, canUndo: false, canRedo: false, version: 0 }
export const useEditInfo = (docId: string | null): EditInfo => useEdits((s) => (docId ? (s[docId] ?? NONE) : NONE))

function publish(docId: string): void {
  const h = histories.get(docId)
  if (!h) {
    useEdits.setState((all) => {
      if (!(docId in all)) return all
      const { [docId]: _gone, ...rest } = all
      return rest
    }, true)
    return
  }
  const prev = useEdits.getState()[docId]
  useEdits.setState({
    [docId]: {
      dirty: h.dirty,
      canUndo: h.canUndo,
      canRedo: h.canRedo,
      undoLabel: h.undoLabel,
      redoLabel: h.redoLabel,
      version: (prev?.version ?? 0) + 1
    }
  })
}

function historyOf(docId: string): History<Uint8Array> {
  let h = histories.get(docId)
  if (!h) histories.set(docId, (h = new History<Uint8Array>()))
  return h
}

async function baseUrl(): Promise<string> {
  docBaseUrl ??= (await window.epdf.getAppInfo()).docBaseUrl
  return docBaseUrl
}

/** The bytes the viewer should show right now (current snapshot, or the file on disk if unedited). */
export async function currentBytes(docId: string): Promise<Uint8Array> {
  await whenEditsSettled(docId)
  return readCurrent(docId)
}

/** Like `currentBytes` but does not wait for the edit queue (used from inside queued work). */
async function readCurrent(docId: string): Promise<Uint8Array> {
  const h = historyOf(docId)
  if (h.current) return h.current
  if (!h.original) {
    const res = await fetch((await baseUrl()) + docId)
    if (!res.ok) throw new Error('Could not read the document.')
    h.original = new Uint8Array(await res.arrayBuffer())
  }
  return h.original
}

function commit(docId: string, label: string, bytes: Uint8Array): void {
  historyOf(docId).push(label, bytes)
  publish(docId)
  useTabs.getState().contentChanged(docId)
}

export class EditError extends Error {}

/**
 * Loads the current document with pdf-lib, lets `fn` modify it, and records the result as one undo step.
 * If `fn` throws, nothing changes. Rejects with an `EditError` carrying a user-presentable message.
 */
export function editPdf(
  docId: string,
  label: string,
  fn: (pdf: PDFDocument) => void | Promise<void>
): Promise<void> {
  return enqueue(docId, async () => {
    const bytes = await readCurrent(docId)
    let pdf: PDFDocument
    try {
      pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    } catch (err) {
      if (err instanceof Error && /encrypt/i.test(err.message)) {
        throw new EditError('This document is password protected. Remove the password before editing it.')
      }
      throw new EditError(`This document could not be edited: ${err instanceof Error ? err.message : String(err)}`)
    }
    await fn(pdf)
    pdf.setProducer('Epdf')
    pdf.setModificationDate(new Date())
    commit(docId, label, await pdf.save())
  })
}

/** Records externally produced bytes (a compressed/OCR'd/redacted copy, a restored version, ...) as an edit. */
export function replaceBytes(docId: string, label: string, bytes: Uint8Array): Promise<void> {
  return enqueue(docId, async () => commit(docId, label, bytes))
}

export const canUndo = (docId: string): boolean => histories.get(docId)?.canUndo ?? false
export const canRedo = (docId: string): boolean => histories.get(docId)?.canRedo ?? false

/** Undoes the last edit (after any edit still in flight has landed). Resolves false if there was nothing to undo. */
export function undo(docId: string): Promise<boolean> {
  return enqueue(docId, async () => {
    if (!histories.get(docId)?.undo()) return false
    publish(docId)
    useTabs.getState().contentChanged(docId)
    return true
  })
}

export function redo(docId: string): Promise<boolean> {
  return enqueue(docId, async () => {
    if (!histories.get(docId)?.redo()) return false
    publish(docId)
    useTabs.getState().contentChanged(docId)
    return true
  })
}

export const isDirty = (docId: string): boolean => useEdits.getState()[docId]?.dirty ?? false

export const dirtyDocIds = (): string[] =>
  Object.entries(useEdits.getState())
    .filter(([, i]) => i.dirty)
    .map(([id]) => id)

/** Call after the current bytes were written to disk. */
export function markSaved(docId: string): void {
  if (!histories.get(docId)) return
  histories.get(docId)!.markSaved()
  publish(docId)
}

/**
 * Drops all edits and returns to what is on disk (used by "Reload from disk" and "Don't save").
 * Does not touch the viewer; callers that keep the tab open should also reload it.
 */
export function discardEdits(docId: string): void {
  histories.delete(docId)
  queues.delete(docId)
  publish(docId)
}

/** Forget a document entirely (tab closed). */
export const disposeSession = discardEdits

/** Reload a tab from what is on disk, dropping any unsaved edits. */
export function reloadFromDisk(docId: string): void {
  discardEdits(docId)
  useTabs.getState().reload(docId)
}

// Free history for closed tabs.
useTabs.subscribe((state, prev) => {
  if (state.tabs.length >= prev.tabs.length) return
  const open = new Set(state.tabs.map((t) => t.docId))
  for (const t of prev.tabs) if (!open.has(t.docId)) disposeSession(t.docId)
})
