import { useEffect, useState } from 'react'
import { Modal } from '../../components/Modal'
import { selectActiveTab, useTabs } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import { isBuilderTool, loadBuilder, parsePageRange, startDetect } from './actions'
import { PANEL_ID, useBuilder } from './store'

/**
 * Always-mounted host: keeps the builder's model of the active document up to date while the builder is in use,
 * marks the page while building (so the form-filling inputs stay out of the way), and shows the small dialog
 * that asks which pages to analyse for automatic field detection.
 */

function DetectScopeDialog(): JSX.Element | null {
  const scope = useBuilder((s) => s.detectScope)
  const tab = useTabs(selectActiveTab)
  const [problem, setProblem] = useState<string | null>(null)
  if (!scope.open || !tab) return null
  const set = useBuilder.getState().setDetectScope
  const close = (): void => set({ open: false })
  const start = (): void => {
    let pages: number[] | 'all'
    if (scope.scope === 'all') pages = 'all'
    else if (scope.scope === 'current') pages = [Math.max(0, tab.view.page - 1)]
    else {
      const p = parsePageRange(scope.range, tab.numPages)
      if (!p) {
        setProblem(`Enter page numbers between 1 and ${tab.numPages}, such as 1-3, 5.`)
        return
      }
      pages = p
    }
    close()
    setProblem(null)
    void startDetect(tab.docId, pages)
  }
  const radio = (value: 'current' | 'all' | 'range', label: string): JSX.Element => (
    <label className="flex items-center gap-2 py-1 text-sm">
      <input type="radio" name="fb-scope" checked={scope.scope === value} onChange={() => set({ scope: value })} />
      {label}
    </label>
  )
  return (
    <Modal title="Detect Form Fields" onClose={close}>
      <p className="mb-2 text-sm text-ink-muted">Epdf looks for lines to write on, empty boxes, check boxes, radio buttons and comb boxes next to their labels, and suggests form fields. Nothing is added until you review and create them.</p>
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Pages to analyse</legend>
        {radio('current', `This page (page ${tab.view.page})`)}
        {radio('all', `All ${tab.numPages} pages`)}
        {radio('range', 'These pages:')}
        <input
          type="text"
          className="field ml-6 w-40 select-text"
          aria-label="Page range"
          placeholder="e.g. 1-3, 5"
          value={scope.range}
          disabled={scope.scope !== 'range'}
          onChange={(e) => set({ range: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && start()}
        />
      </fieldset>
      {problem && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {problem}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn-primary" data-testid="fb-detect-start" onClick={start}>
          Detect fields
        </button>
      </div>
    </Modal>
  )
}

export function BuilderHost(): JSX.Element | null {
  const tab = useTabs(selectActiveTab)
  const docId = tab?.docId ?? null
  const ready = tab?.status === 'ready'
  const seqKey = tab ? `${tab.loadSeq}:${tab.contentSeq}` : ''
  const activeTool = useWorkspace((s) => s.activeTool)
  const panel = useWorkspace((s) => s.rightPanel)
  const reviewing = useBuilder((s) => !!s.detect && s.detect.phase !== 'running')
  const ordering = useBuilder((s) => !!s.taborder && s.mode === 'taborder')
  const needed = isBuilderTool(activeTool) || panel === PANEL_ID

  // Read the fields whenever the document changes while the builder is in use.
  useEffect(() => {
    if (!docId || !ready || !needed) return
    if (useBuilder.getState().docs[docId]?.key === seqKey) return
    let cancelled = false
    void (async () => {
      const next = await loadBuilder(docId, seqKey)
      if (cancelled) return
      const st = useBuilder.getState()
      st.setDoc(docId, next)
      st.clearOptimistic(docId)
      // Drop selections that no longer exist (deleted / renamed elsewhere, undo).
      if (st.selectionDoc === docId && st.selection.length) {
        const alive = st.selection.filter((k) => {
          const i = k.lastIndexOf('#')
          const f = next.fields.find((x) => x.name === k.slice(0, i))
          return !!f && f.widgets.some((w) => w.index === Number(k.slice(i + 1)))
        })
        if (alive.length !== st.selection.length) st.select(docId, alive)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docId, ready, needed, seqKey])

  // While building, the form-filling inputs must not take the mouse (see builder.css).
  useEffect(() => {
    const on = isBuilderTool(activeTool) || reviewing || ordering
    if (on) document.documentElement.dataset.formBuilder = 'edit'
    else delete document.documentElement.dataset.formBuilder
    return () => {
      delete document.documentElement.dataset.formBuilder
    }
  }, [activeTool, reviewing, ordering])

  // Forget closed documents.
  useEffect(
    () =>
      useTabs.subscribe((s, prev) => {
        if (s.tabs.length >= prev.tabs.length) return
        const open = new Set(s.tabs.map((t) => t.docId))
        for (const t of prev.tabs) {
          if (open.has(t.docId)) continue
          const b = useBuilder.getState()
          b.setDoc(t.docId, null)
          if (b.detect?.docId === t.docId) b.setDetect(null)
          if (b.taborder?.docId === t.docId) b.setTabOrder(null)
          if (b.selectionDoc === t.docId) b.select(t.docId, [])
        }
      }),
    []
  )

  return <DetectScopeDialog />
}
