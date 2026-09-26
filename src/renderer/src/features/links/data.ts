import { useEffect } from 'react'
import { create } from 'zustand'
import { DestinationResolver } from '@shared/features/destinations'
import { useTabs } from '../../state/tabs'
import { readCurrent } from './common'
import type { LinkInfo } from './pdf/model'
import { readLinks } from './pdf/read'

/**
 * The links of each open document, read with pdf-lib from the CURRENT bytes (edits, undo and redo included),
 * so the overlays and the link list always match what is in the document.
 */

export interface DocLinks {
  bytes: Uint8Array | null
  links: LinkInfo[]
  /** Named destinations of the document (for the "named destination" choice). */
  names: { name: string; pageIndex: number | null }[]
  error: { kind: 'encrypted' | 'failed'; message: string } | null
}

export const useLinks = create<{ byDoc: Record<string, DocLinks | undefined> }>(() => ({ byDoc: {} }))

const generation = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()

export function refreshLinks(docId: string): Promise<void> {
  const running = inflight.get(docId)
  if (running) return running.then(() => refreshLinks(docId))
  const p = (async () => {
    const gen = (generation.get(docId) ?? 0) + 1
    generation.set(docId, gen)
    const res = await readCurrent(docId)
    if (res.ok && useLinks.getState().byDoc[docId]?.bytes === res.bytes) return
    const next: DocLinks = res.ok
      ? { bytes: res.bytes, links: readLinks(res.pdf), names: new DestinationResolver(res.pdf).namedDestinations(), error: null }
      : { bytes: null, links: [], names: [], error: { kind: res.reason, message: res.message } }
    if (generation.get(docId) !== gen) return
    useLinks.setState((s) => ({ byDoc: { ...s.byDoc, [docId]: next } }))
  })().finally(() => inflight.delete(docId))
  inflight.set(docId, p)
  return p
}

/** Keeps a document's links loaded while `enabled`, re-reading after every edit/undo/redo. */
export function useDocLinks(docId: string | null, enabled = true): DocLinks | undefined {
  const data = useLinks((s) => (docId ? s.byDoc[docId] : undefined))
  const tab = useTabs((s) => s.tabs.find((t) => t.docId === docId))
  const seq = tab ? `${tab.loadSeq}:${tab.contentSeq}:${tab.status}` : ''
  useEffect(() => {
    if (docId && enabled && tab?.status === 'ready') void refreshLinks(docId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, enabled, seq])
  return data
}

useTabs.subscribe((state, prev) => {
  if (state.tabs.length >= prev.tabs.length) return
  const open = new Set(state.tabs.map((t) => t.docId))
  const stale = Object.keys(useLinks.getState().byDoc).filter((id) => !open.has(id))
  if (stale.length) {
    useLinks.setState((s) => {
      const byDoc = { ...s.byDoc }
      for (const id of stale) delete byDoc[id]
      return { byDoc }
    })
  }
})
