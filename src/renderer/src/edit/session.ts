import { PDFDocument } from 'pdf-lib'
import { create } from 'zustand'
import { useTabs } from '../state/tabs'
import { runBeforeWrite, runDecrypt } from './hooks'
import { History, type Tagged } from './history'

export type { Tagged } from './history'

/**
 * The edit pipeline every feature goes through. Each document has a linear history of full-file byte
 * snapshots; an edit produces a new snapshot, undo/redo move along the history, and the viewer reloads
 * from the current snapshot. Nothing touches the file on disk until Save.
 *
 *   await editPdf(docId, 'Rotate page', (pdf) => { pdf.getPage(0).setRotation(degrees(90)) })
 *   replaceBytes(docId, 'Compress', compressedBytes)   // for results produced elsewhere (jobs, qpdf, ...)
 *
 * An edit can carry tags (`{ tags: ['redaction'] }`) that say what kind of change it was; they stay with the state
 * through undo/redo, and a save reports the tags of the state it wrote (its lineage), so features can react to
 * "a redaction is now on disk" whatever other edits came after it.
 */

export interface EditOptions {
  tags?: readonly string[]
}

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

function commit(docId: string, label: string, bytes: Uint8Array, opts?: EditOptions): void {
  historyOf(docId).push(label, bytes, opts?.tags)
  publish(docId)
  useTabs.getState().contentChanged(docId)
}

export class EditError extends Error {}

/**
 * Asks the registered `decrypt` hook for the plaintext of an encrypted document. On success the plaintext
 * silently becomes the document's baseline (it is NOT an edit and does not mark the tab unsaved); a
 * `beforeWrite` hook re-applies the protection whenever the document is saved.
 */
async function unlock(docId: string, encrypted: Uint8Array): Promise<Uint8Array | null> {
  const plain = await runDecrypt(docId, encrypted)
  if (!plain) return null
  historyOf(docId).replaceCurrent(plain)
  return plain
}

/** True if pdf-lib refuses to open these bytes because the document is encrypted. */
export async function isEncryptedPdf(bytes: Uint8Array): Promise<boolean> {
  try {
    await PDFDocument.load(bytes, { updateMetadata: false })
    return false
  } catch (err) {
    return err instanceof Error && /encrypt/i.test(err.message)
  }
}

/**
 * Makes sure the document can be read/edited with pdf-lib: a no-op for normal documents; for encrypted ones
 * it runs the `decrypt` hook (which may prompt for a password). Resolves false if the user declined.
 * Features that read a document themselves (annotation lists, form models, ...) call this first.
 */
export function ensureEditable(docId: string): Promise<boolean> {
  return enqueue(docId, async () => {
    const bytes = await readCurrent(docId)
    if (!(await isEncryptedPdf(bytes))) return true
    return (await unlock(docId, bytes)) !== null
  })
}

/** What `snapshotForWriting` captured: the bytes to write and exactly which state they are. */
export interface WriteSnapshot {
  bytes: Uint8Array
  /** Revision of the state the bytes were read from; pass it to `markSaved` once they are on disk. */
  revision: number
  /** The tags of every edit that led to that state (see `EditOptions`). */
  lineage: Tagged[]
}

/**
 * The bytes to write to disk for this document (current state, re-protected if needed), together with the revision
 * and lineage of the state they came from. Bytes, revision and lineage are read at the same moment, in the edit queue,
 * so an edit or undo made while the write is still running can never be mistaken for part of it.
 */
export async function snapshotForWriting(docId: string): Promise<WriteSnapshot> {
  const snap = await enqueue(docId, async () => {
    const bytes = await readCurrent(docId)
    const h = historyOf(docId)
    return { bytes, revision: h.revision, lineage: h.lineage }
  })
  // Outside the queue: a hook may itself read the document.
  return { ...snap, bytes: await runBeforeWrite(docId, snap.bytes) }
}

/** The bytes to write to disk (or the recovery folder) for this document: current state, re-protected if needed. */
export async function bytesForWriting(docId: string): Promise<Uint8Array> {
  return (await snapshotForWriting(docId)).bytes
}

/**
 * Loads the current document with pdf-lib, lets `fn` modify it, and records the result as one undo step.
 * If `fn` throws, nothing changes. Rejects with an `EditError` carrying a user-presentable message.
 */
export function editPdf(
  docId: string,
  label: string,
  fn: (pdf: PDFDocument) => void | Promise<void>,
  opts?: EditOptions
): Promise<void> {
  return enqueue(docId, async () => {
    let bytes = await readCurrent(docId)
    let pdf: PDFDocument
    try {
      pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    } catch (err) {
      if (!(err instanceof Error && /encrypt/i.test(err.message))) {
        throw new EditError(`This document could not be edited: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Encrypted: give the Security feature (via hooks) a chance to unlock it for editing.
      const plain = await unlock(docId, bytes)
      if (!plain) {
        throw new EditError('This document is password protected. Enter its password (or remove the protection) to edit it.')
      }
      bytes = plain
      pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    }
    await fn(pdf)
    pdf.setProducer('Epdf')
    pdf.setModificationDate(new Date())
    commit(docId, label, await pdf.save(), opts)
  })
}

/** Records externally produced bytes (a compressed/OCR'd/redacted copy, a restored version, ...) as an edit. */
export function replaceBytes(docId: string, label: string, bytes: Uint8Array, opts?: EditOptions): Promise<void> {
  return enqueue(docId, async () => commit(docId, label, bytes, opts))
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

/**
 * Call once the bytes of `revision` (from `snapshotForWriting`) are on disk. Returns false, and changes nothing, if
 * that revision is not part of the document's current history (its edits were discarded while it was being saved).
 */
export function markSaved(docId: string, revision: number): boolean {
  const h = histories.get(docId)
  if (!h?.markSaved(revision)) return false
  publish(docId)
  return true
}

/**
 * Drops the undo and redo steps (after any edit in flight has landed): the current state becomes the new starting
 * point. Used once something irreversible (a redaction) is on disk, so undo cannot bring the old content back. Edits
 * made since the save stay, and stay unsaved.
 */
export function clearUndoSteps(docId: string): Promise<void> {
  return enqueue(docId, async () => {
    const h = histories.get(docId)
    if (!h) return
    h.clearSteps()
    publish(docId)
  })
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
