import { PDFDocument } from 'pdf-lib'
import { useEffect } from 'react'
import { create } from 'zustand'
import { currentBytes } from '../../edit/session'
import { useTabs } from '../../state/tabs'
import type { AnnotInfo } from './pdf/model'
import { readAnnotations } from './pdf/read'
import { buildThreads, type Thread } from './pdf/threads'

/**
 * The annotations of each open document, read with pdf-lib from the CURRENT bytes (edits, undo and redo
 * included), so the panel and the page overlays always match what is in the document.
 */

export interface DocAnnots {
  /** The exact snapshot these were read from (identity is used to skip redundant reloads). */
  bytes: Uint8Array
  annots: AnnotInfo[]
  threads: Thread[]
  error: string | null
}

export const useAnnots = create<{ byDoc: Record<string, DocAnnots | undefined> }>(() => ({ byDoc: {} }))

const generation = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()

/** (Re)reads the annotations if the document changed since the last read. Safe to call often. */
export function refreshAnnots(docId: string): Promise<void> {
  const running = inflight.get(docId)
  if (running) return running.then(() => refreshAnnots(docId))
  const p = (async () => {
    const gen = (generation.get(docId) ?? 0) + 1
    generation.set(docId, gen)
    let bytes: Uint8Array
    try {
      bytes = await currentBytes(docId)
    } catch {
      return
    }
    if (useAnnots.getState().byDoc[docId]?.bytes === bytes) return
    let next: DocAnnots
    try {
      // Reading is a low-level walk over annotation dictionaries; nothing is written.
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false })
      const annots = readAnnotations(pdf)
      next = { bytes, annots, threads: buildThreads(annots), error: null }
    } catch (err) {
      const encrypted = err instanceof Error && /encrypt/i.test(err.message)
      next = {
        bytes,
        annots: [],
        threads: [],
        error: encrypted ? 'Comments in password-protected documents cannot be listed.' : 'The comments of this document could not be read.'
      }
    }
    if (generation.get(docId) !== gen) return // a newer read started meanwhile
    useAnnots.setState((s) => ({ byDoc: { ...s.byDoc, [docId]: next } }))
  })().finally(() => inflight.delete(docId))
  inflight.set(docId, p)
  return p
}

/** Keeps a document's annotations loaded while `enabled`, re-reading after every edit/undo/redo. */
export function useDocAnnots(docId: string | null, enabled = true): DocAnnots | undefined {
  const data = useAnnots((s) => (docId ? s.byDoc[docId] : undefined))
  const tab = useTabs((s) => s.tabs.find((t) => t.docId === docId))
  const seq = tab ? `${tab.loadSeq}:${tab.contentSeq}:${tab.status}` : ''
  useEffect(() => {
    if (docId && enabled && tab?.status === 'ready') void refreshAnnots(docId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, enabled, seq])
  return data
}

// Forget documents that were closed.
useTabs.subscribe((state, prev) => {
  if (state.tabs.length >= prev.tabs.length) return
  const open = new Set(state.tabs.map((t) => t.docId))
  const stale = Object.keys(useAnnots.getState().byDoc).filter((id) => !open.has(id))
  if (stale.length) {
    useAnnots.setState((s) => {
      const byDoc = { ...s.byDoc }
      for (const id of stale) delete byDoc[id]
      return { byDoc }
    })
  }
})
