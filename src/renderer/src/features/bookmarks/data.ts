import { useEffect } from 'react'
import { create } from 'zustand'
import { useTabs } from '../../state/tabs'
import { readCurrent } from '../links/common'
import type { BmNode } from './pdf/model'
import { readBookmarks } from './pdf/read'

/**
 * The bookmarks of each open document, read with pdf-lib from the CURRENT bytes (edits, undo and redo
 * included), so the panel always matches what is in the document.
 */

export interface DocBookmarks {
  /** The exact snapshot these were read from (identity is used to skip redundant reloads). */
  bytes: Uint8Array | null
  roots: BmNode[]
  count: number
  warnings: string[]
  hasOutline: boolean
  error: { kind: 'encrypted' | 'failed'; message: string } | null
  /** Increments on every successful read. */
  version: number
}

export const useBookmarks = create<{ byDoc: Record<string, DocBookmarks | undefined> }>(() => ({ byDoc: {} }))

const generation = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()

/** (Re)reads the bookmarks if the document changed since the last read. Safe to call often. */
export function refreshBookmarks(docId: string): Promise<void> {
  const running = inflight.get(docId)
  if (running) return running.then(() => refreshBookmarks(docId))
  const p = (async () => {
    const gen = (generation.get(docId) ?? 0) + 1
    generation.set(docId, gen)
    const res = await readCurrent(docId)
    const prev = useBookmarks.getState().byDoc[docId]
    if (res.ok && prev?.bytes === res.bytes) return
    let next: DocBookmarks
    if (res.ok) {
      const r = readBookmarks(res.pdf)
      next = { bytes: res.bytes, roots: r.roots, count: r.count, warnings: r.warnings, hasOutline: r.hasOutline, error: null, version: (prev?.version ?? 0) + 1 }
    } else {
      next = { bytes: null, roots: [], count: 0, warnings: [], hasOutline: false, error: { kind: res.reason, message: res.message }, version: (prev?.version ?? 0) + 1 }
    }
    if (generation.get(docId) !== gen) return // a newer read started meanwhile
    useBookmarks.setState((s) => ({ byDoc: { ...s.byDoc, [docId]: next } }))
  })().finally(() => inflight.delete(docId))
  inflight.set(docId, p)
  return p
}

/** Keeps a document's bookmarks loaded while `enabled`, re-reading after every edit/undo/redo. */
export function useDocBookmarks(docId: string | null, enabled = true): DocBookmarks | undefined {
  const data = useBookmarks((s) => (docId ? s.byDoc[docId] : undefined))
  const tab = useTabs((s) => s.tabs.find((t) => t.docId === docId))
  const seq = tab ? `${tab.loadSeq}:${tab.contentSeq}:${tab.status}` : ''
  useEffect(() => {
    if (docId && enabled && tab?.status === 'ready') void refreshBookmarks(docId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, enabled, seq])
  return data
}

// Forget documents that were closed.
useTabs.subscribe((state, prev) => {
  if (state.tabs.length >= prev.tabs.length) return
  const open = new Set(state.tabs.map((t) => t.docId))
  const stale = Object.keys(useBookmarks.getState().byDoc).filter((id) => !open.has(id))
  if (stale.length) {
    useBookmarks.setState((s) => {
      const byDoc = { ...s.byDoc }
      for (const id of stale) delete byDoc[id]
      return { byDoc }
    })
  }
})
