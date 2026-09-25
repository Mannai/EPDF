import { PDFDocument } from 'pdf-lib'
import { useEffect } from 'react'
import { IconClose } from '../../components/Icons'
import { currentBytes } from '../../edit/session'
import { getLoaded } from '../../pdf/docCache'
import { AnnotationMode, useViewerOptions } from '../../state/viewerOptions'
import { selectActiveTab, useTabs } from '../../state/tabs'
import { useActiveView } from '../../state/workspace'
import { extractFormModel, FILLABLE_KINDS } from './model'
import { currentOverrideVersion, settleOverrides, useForms } from './store'

/**
 * An always-mounted host (registered as a dialog) that
 *  - reads the AcroForm fields of the active document with pdf-lib whenever its content changes,
 *  - switches PDF.js to `ENABLE_FORMS` while a fillable form is showing (so the widgets aren't painted
 *    twice: our inputs replace them) and back to `ENABLE` otherwise,
 *  - shows the "This form has N fields" banner with the Highlight toggle.
 */
export function FormsHost(): JSX.Element | null {
  const tab = useTabs(selectActiveTab)
  const docId = tab?.docId ?? null
  const ready = tab?.status === 'ready'
  const seqKey = tab ? `${tab.loadSeq}:${tab.contentSeq}` : ''
  const viewId = useActiveView(docId)
  const info = useForms((s) => (docId ? s.docs[docId] : undefined))
  const highlight = useForms((s) => s.highlight)
  const dismissed = useForms((s) => (docId ? !!s.bannerDismissed[docId] : false))

  useEffect(() => {
    if (!docId || !ready) return
    if (useForms.getState().docs[docId]?.key === seqKey) return
    let cancelled = false
    void (async () => {
      const snapshot = currentOverrideVersion()
      let hasFields = true
      try {
        const loaded = getLoaded(docId)
        if (loaded) hasFields = !!(await loaded.doc.getFieldObjects())
      } catch {
        hasFields = true // let pdf-lib decide
      }
      let next = { key: seqKey, model: null as ReturnType<typeof extractFormModel> | null, encrypted: false }
      if (hasFields) {
        try {
          const bytes = await currentBytes(docId)
          const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
          next = { key: seqKey, model: extractFormModel(pdf), encrypted: false }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          next = { key: seqKey, model: { fields: [], error: message }, encrypted: /encrypt/i.test(message) }
        }
      }
      if (cancelled) return
      useForms.getState().setDoc(docId, next)
      settleOverrides(docId, snapshot)
    })()
    return () => {
      cancelled = true
    }
  }, [docId, ready, seqKey])

  // Forget documents that are no longer open.
  useEffect(
    () =>
      useTabs.subscribe((s, prev) => {
        if (s.tabs.length >= prev.tabs.length) return
        const open = new Set(s.tabs.map((t) => t.docId))
        for (const t of prev.tabs) if (!open.has(t.docId)) useForms.getState().setDoc(t.docId, null)
      }),
    []
  )

  const interactive = !!info?.model && info.model.fields.length > 0 && !info.encrypted && !viewId
  useEffect(() => {
    useViewerOptions.getState().setAnnotationMode(interactive ? AnnotationMode.ENABLE_FORMS : AnnotationMode.ENABLE)
  }, [interactive])
  useEffect(() => () => useViewerOptions.getState().setAnnotationMode(AnnotationMode.ENABLE), [])

  if (!docId || !info?.model || viewId || dismissed) return null

  if (info.encrypted) {
    return (
      <div role="region" aria-label="Form" className="fixed bottom-4 right-6 z-[45] max-w-sm rounded-lg border border-line bg-raised px-3 py-2 text-sm shadow-lg">
        This form is password protected, so it can’t be filled in. Remove the password first, then open it again.
      </div>
    )
  }
  const fields = info.model.fields
  if (fields.length === 0) return null
  const unsupported = fields.filter((f) => !FILLABLE_KINDS.includes(f.kind)).length
  return (
    <div
      role="region"
      aria-label="Form"
      data-testid="form-banner"
      className="fixed bottom-4 right-6 z-[45] flex max-w-md items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2 text-sm shadow-lg"
    >
      <span>
        This form has {fields.length} {fields.length === 1 ? 'field' : 'fields'}
        {unsupported > 0 ? ` (${unsupported} can’t be edited here)` : ''}
      </span>
      <button type="button" className="btn h-7 px-2 text-xs" aria-pressed={highlight} onClick={() => useForms.getState().toggleHighlight()}>
        Highlight fields
      </button>
      <button type="button" className="btn-icon h-7 w-7" aria-label="Dismiss form banner" onClick={() => useForms.getState().dismissBanner(docId)}>
        <IconClose />
      </button>
    </div>
  )
}
