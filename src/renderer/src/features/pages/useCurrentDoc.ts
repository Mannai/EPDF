import { useEffect, useRef, useState } from 'react'
import { currentBytes } from '../../edit/session'
import { loadDoc, type LoadedDoc } from '../../pdf/docCache'
import type { Tab } from '../../state/tabs'
import { useUi } from '../../state/ui'

let docBaseUrl: string | null = null
async function getDocBaseUrl(): Promise<string> {
  docBaseUrl ??= (await window.epdf.getAppInfo()).docBaseUrl
  return docBaseUrl
}

/**
 * The PDF.js document for the tab's current content, for views that replace the page viewer (which is
 * unmounted while they show, so it does not reload after edits). It uses the same cache key as the viewer, so
 * both share one loaded document. Returns null while loading.
 */
export function useCurrentDoc(tab: Tab): LoadedDoc | null {
  const [loaded, setLoaded] = useState<LoadedDoc | null>(null)
  const { docId, loadSeq, contentSeq } = tab
  const nameRef = useRef(tab.name)
  nameRef.current = tab.name

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const base = await getDocBaseUrl()
        const source = contentSeq > 0 ? { data: await currentBytes(docId) } : { url: base + docId }
        const l = await loadDoc(docId, `${loadSeq}:${contentSeq}`, source, (incorrect) => useUi.getState().askPassword(nameRef.current, incorrect))
        if (!cancelled) setLoaded(l)
      } catch (err) {
        if (!cancelled) console.error('Could not load the document for the page view', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docId, loadSeq, contentSeq])

  return loaded && loaded.docId === docId ? loaded : null
}
