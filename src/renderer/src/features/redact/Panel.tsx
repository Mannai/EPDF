import type { PageViewport } from 'pdfjs-dist'
import { useEffect, useId, useMemo, useState } from 'react'
import { Advanced } from '../../components/Advanced'
import { getLoaded } from '../../pdf/docCache'
import { useTabs, type Tab } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import { markLabel } from './overlay'
import type { Rect } from './logic/geom'
import { PRESETS } from './logic/patterns'
import { DEFAULT_FORM, cancelSearch, formProblem, runSearch, type SearchForm } from './searchAction'
import { pagesOf, totalRects, useDocRedact, useRedact, type SearchResult, type UiMark } from './store'

export const REDACT_PANEL = 'redact.panel'

const goTo = (docId: string, page: number): void => useTabs.getState().goToPage(docId, page)

/** PDF.js viewport of a page at scale 1 (rotation applied): converts between PDF space and the displayed page. */
function usePageViewport(docId: string, pageIndex: number): PageViewport | null {
  const [vp, setVp] = useState<PageViewport | null>(null)
  useEffect(() => {
    let cancelled = false
    setVp(null)
    const doc = getLoaded(docId)?.doc
    if (!doc || pageIndex < 0 || pageIndex >= doc.numPages) return
    void doc
      .getPage(pageIndex + 1)
      .then((p) => {
        if (!cancelled) setVp(p.getViewport({ scale: 1 }))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [docId, pageIndex])
  return vp
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10)

function viewRect(vp: PageViewport, r: Rect): { left: number; top: number; width: number; height: number } {
  const [ax, ay] = vp.convertToViewportPoint(r.x0, r.y0)
  const [bx, by] = vp.convertToViewportPoint(r.x1, r.y1)
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }
}

/** Numeric fields (points from the top-left of the displayed page) to add an area mark or edit the selected one. */
function AreaFields({ docId, tab, mode, selected }: { docId: string; tab: Tab; mode: 'add' | 'edit'; selected?: UiMark }): JSX.Element {
  const editing = mode === 'edit' && selected && selected.kind === 'area' && selected.rects.length === 1 ? selected : undefined
  const [page, setPage] = useState(tab.view.page)
  useEffect(() => {
    if (!editing) setPage(tab.view.page)
  }, [tab.view.page, editing])
  const pageIndex = editing ? editing.pageIndex : Math.min(Math.max(1, page), Math.max(1, tab.numPages)) - 1
  const vp = usePageViewport(docId, pageIndex)
  const [vals, setVals] = useState({ left: '72', top: '72', width: '144', height: '36' })
  const idBase = useId()

  // show the selected mark's numbers
  useEffect(() => {
    if (!editing || !vp) return
    const b = viewRect(vp, editing.rects[0])
    setVals({ left: fmt(b.left), top: fmt(b.top), width: fmt(b.width), height: fmt(b.height) })
  }, [editing, vp])

  const parse = (): { left: number; top: number; width: number; height: number } | null => {
    const n = { left: Number(vals.left), top: Number(vals.top), width: Number(vals.width), height: Number(vals.height) }
    if (![n.left, n.top, n.width, n.height].every(Number.isFinite) || n.width < 1 || n.height < 1) return null
    return n
  }
  const toPdf = (b: { left: number; top: number; width: number; height: number }): Rect | null => {
    if (!vp) return null
    const w = vp.width
    const h = vp.height
    const left = Math.min(Math.max(0, b.left), w - 1)
    const top = Math.min(Math.max(0, b.top), h - 1)
    const [ax, ay] = vp.convertToPdfPoint(left, top)
    const [bx, by] = vp.convertToPdfPoint(Math.min(w, left + b.width), Math.min(h, top + b.height))
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) }
  }
  const commit = (): void => {
    if (!editing) return
    const b = parse()
    const r = b ? toPdf(b) : null
    if (r) useRedact.getState().updateMark(docId, editing.id, { rects: [r], quads: [null] }, `fields:${editing.id}`)
  }
  const field = (key: 'left' | 'top' | 'width' | 'height', label: string): JSX.Element => (
    <label className="min-w-0 text-xs text-ink-muted" htmlFor={`${idBase}-${key}`}>
      {label}
      <input
        id={`${idBase}-${key}`}
        type="number"
        inputMode="decimal"
        className="field mt-0.5 w-full select-text px-1"
        aria-label={`${mode === 'add' ? 'New area' : 'Selected area'} ${label.toLowerCase()} in points`}
        value={vals[key]}
        onChange={(e) => setVals({ ...vals, [key]: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )

  return (
    <fieldset className="rounded-md border border-line p-2" data-testid={mode === 'add' ? 'redact-add-area-fields' : 'redact-edit-area-fields'}>
      <legend className="px-1 text-xs font-semibold text-ink-muted">{editing ? 'Selected area (points from top-left)' : 'Add an area (points from top-left)'}</legend>
      {!editing && (
        <label className="mb-1 flex items-center gap-2 text-xs text-ink-muted">
          Page
          <input type="number" min={1} max={tab.numPages || 1} aria-label="Page for the new area" className="field w-16 select-text px-1" value={page} onChange={(e) => setPage(Number(e.target.value) || 1)} />
        </label>
      )}
      <div className="grid grid-cols-4 gap-1">
        {field('left', 'Left')}
        {field('top', 'Top')}
        {field('width', 'Width')}
        {field('height', 'Height')}
      </div>
      {!editing && (
        <button
          type="button"
          className="btn mt-2 w-full"
          data-testid="redact-add-area"
          disabled={!vp || !parse()}
          onClick={() => {
            const b = parse()
            const r = b ? toPdf(b) : null
            if (!r) return
            useRedact.getState().addMark(docId, { kind: 'area', pageIndex, rects: [r], quads: [null] })
            useRedact.getState().announce(`Added an area mark on page ${pageIndex + 1}.`)
            goTo(docId, pageIndex + 1)
          }}
        >
          Add area mark
        </button>
      )}
    </fieldset>
  )
}

function MarksList({ docId, marks, selectedId }: { docId: string; marks: readonly UiMark[]; selectedId: string | null }): JSX.Element {
  if (marks.length === 0) {
    return (
      <p className="text-xs text-ink-muted" data-testid="redact-no-marks">
        Nothing is marked yet. Select text, drag an area, or use Find below.
      </p>
    )
  }
  return (
    <ul aria-label="Marks for redaction" className="space-y-1" data-testid="redact-marks">
      {marks.map((m) => (
        <li key={m.id} data-testid="redact-mark-row" className={`flex items-center gap-1 rounded-md border px-1 ${selectedId === m.id ? 'border-accent bg-accent/10' : 'border-line'}`}>
          <button
            type="button"
            className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-current={selectedId === m.id}
            onClick={() => {
              useRedact.getState().select(docId, m.id)
              goTo(docId, m.pageIndex + 1)
            }}
          >
            {markLabel(m)}
          </button>
          <button type="button" className="btn-icon h-7 w-7 shrink-0" aria-label={`Remove mark: ${markLabel(m)}`} title="Remove mark" onClick={() => useRedact.getState().removeMark(docId, m.id)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  )
}

function ResultRow({ docId, r }: { docId: string; r: SearchResult }): JSX.Element {
  const state = r.decision === 'accepted' ? 'Marked' : r.decision === 'rejected' ? 'Skipped' : 'To review'
  return (
    <li data-testid="redact-result" data-decision={r.decision} className="rounded-md border border-line p-1">
      <div className="flex items-center gap-1">
        <button type="button" className="min-w-0 flex-1 truncate rounded px-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => goTo(docId, r.pageIndex + 1)}>
          <span className="text-ink-muted">p. {r.pageIndex + 1}</span> <span className="select-text">{r.text.length > 48 ? `${r.text.slice(0, 45)}…` : r.text}</span>
          {r.hiddenOnly ? <span className="text-ink-muted"> (hidden text)</span> : null}
        </button>
        <span className="shrink-0 text-xs text-ink-muted">{state}</span>
      </div>
      <div className="mt-1 flex gap-1">
        <button type="button" className="btn h-7 flex-1 px-1 text-xs" aria-pressed={r.decision === 'accepted'} aria-label={`${r.decision === 'accepted' ? 'Unmark' : 'Mark'} match on page ${r.pageIndex + 1}: ${r.text}`} onClick={() => useRedact.getState().decide(docId, r.id, r.decision === 'accepted' ? 'pending' : 'accepted')}>
          {r.decision === 'accepted' ? 'Unmark' : 'Mark'}
        </button>
        <button type="button" className="btn h-7 flex-1 px-1 text-xs" aria-pressed={r.decision === 'rejected'} aria-label={`${r.decision === 'rejected' ? 'Review again' : 'Skip'} match on page ${r.pageIndex + 1}: ${r.text}`} onClick={() => useRedact.getState().decide(docId, r.id, r.decision === 'rejected' ? 'pending' : 'rejected')}>
          {r.decision === 'rejected' ? 'Review again' : 'Skip'}
        </button>
      </div>
    </li>
  )
}

const RESULT_CHUNK = 100

/** What the folded search options hold that differs from the defaults. */
function changed(f: SearchForm): string | undefined {
  const on = [
    f.mode !== 'preset' && f.caseSensitive && 'match case',
    f.mode === 'literal' && f.wholeWord && 'whole word',
    (f.from || f.to) && 'pages'
  ].filter(Boolean)
  return on.length ? on.join(', ') : undefined
}

function FindSection({ docId, tab }: { docId: string; tab: Tab }): JSX.Element {
  const [form, setForm] = useState<SearchForm>(DEFAULT_FORM)
  const d = useDocRedact(docId)
  const [show, setShow] = useState(RESULT_CHUNK)
  const [filterPage, setFilterPage] = useState(0)
  const problem = useMemo(() => (form.mode === 'literal' && !form.query ? null : formProblem(form)), [form])
  const patch = (p: Partial<SearchForm>): void => setForm((f) => ({ ...f, ...p }))
  const visible = useMemo(() => d.results.filter((r) => !filterPage || r.pageIndex + 1 === filterPage), [d.results, filterPage])
  const pendingIds = visible.filter((r) => r.decision === 'pending').map((r) => r.id)
  const markedIds = visible.filter((r) => r.decision === 'accepted').map((r) => r.id)
  const resultPages = useMemo(() => [...new Set(d.results.map((r) => r.pageIndex + 1))].sort((a, b) => a - b), [d.results])
  const submit = (): void => {
    setShow(RESULT_CHUNK)
    setFilterPage(0)
    void runSearch(docId, form)
  }
  return (
    <section aria-label="Find and mark" className="space-y-2" data-testid="redact-find">
      <h3 className="text-xs font-semibold text-ink-muted">Find and mark</h3>
      <label className="block text-xs text-ink-muted">
        Find
        <select aria-label="Search type" className="field mt-0.5 w-full" value={form.mode} onChange={(e) => patch({ mode: e.target.value as SearchForm['mode'] })}>
          <option value="literal">Text</option>
          <option value="preset">Pattern (e-mail, phone, card…)</option>
          <option value="regex">Regular expression</option>
        </select>
      </label>
      {form.mode === 'literal' && (
        <>
          <input aria-label="Text to find" type="search" className="field w-full select-text" placeholder="Text to find" value={form.query} onChange={(e) => patch({ query: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </>
      )}
      {form.mode === 'preset' && (
        <label className="block text-xs text-ink-muted">
          Pattern
          <select aria-label="Pattern" className="field mt-0.5 w-full" value={form.presetId} onChange={(e) => patch({ presetId: e.target.value })}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <span className="mt-0.5 block">{PRESETS.find((p) => p.id === form.presetId)?.description}</span>
        </label>
      )}
      {form.mode === 'regex' && (
        <>
          <input aria-label="Regular expression" className="field w-full select-text font-mono" placeholder="e.g. \b[A-Z]{2}\d{6}\b" spellCheck={false} aria-invalid={!!problem} aria-describedby="redact-regex-msg" value={form.regex} onChange={(e) => patch({ regex: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <p id="redact-regex-msg" className={`text-xs ${problem && form.regex ? 'text-danger' : 'text-ink-muted'}`} data-testid="redact-regex-message">
            {problem && form.regex ? problem : 'Runs with a step limit, so a pattern that would hang is stopped.'}
          </p>
        </>
      )}
      <Advanced id="redact-find" label="Search options" className="mt-1" summary={changed(form)}>
        <div className="space-y-2">
          {form.mode !== 'preset' && (
            <div className="flex gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={form.caseSensitive} onChange={(e) => patch({ caseSensitive: e.target.checked })} /> Match case
              </label>
              {form.mode === 'literal' && (
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={form.wholeWord} onChange={(e) => patch({ wholeWord: e.target.checked })} /> Whole word
                </label>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              Pages
              <input type="number" min={1} max={tab.numPages || 1} aria-label="First page" className="field w-14 select-text px-1" placeholder="1" value={form.from || ''} onChange={(e) => patch({ from: Number(e.target.value) || 0 })} />
            </label>
            <label className="flex items-center gap-1">
              to
              <input type="number" min={1} max={tab.numPages || 1} aria-label="Last page" className="field w-14 select-text px-1" placeholder={String(tab.numPages || 1)} value={form.to || ''} onChange={(e) => patch({ to: Number(e.target.value) || 0 })} />
            </label>
          </div>
        </div>
      </Advanced>
      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1" data-testid="redact-search" disabled={d.searching || (form.mode === 'literal' ? !form.query.trim() : !!problem)} onClick={submit}>
          {d.searching ? 'Searching…' : 'Search'}
        </button>
        {d.searching && (
          <button type="button" className="btn" onClick={() => cancelSearch(docId)}>
            Cancel
          </button>
        )}
      </div>
      <p role="status" aria-live="polite" className="text-xs text-ink-muted" data-testid="redact-search-status">
        {d.searchError ? <span className="text-danger">{d.searchError}</span> : d.searching ? 'Searching all pages…' : d.resultsLabel}
      </p>
      {d.results.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" className="btn h-7 px-2 text-xs" data-testid="redact-mark-all" disabled={pendingIds.length === 0} onClick={() => useRedact.getState().decideAll(docId, pendingIds, 'accepted')}>
              Mark all ({pendingIds.length})
            </button>
            <button type="button" className="btn h-7 px-2 text-xs" disabled={markedIds.length === 0} onClick={() => useRedact.getState().decideAll(docId, markedIds, 'rejected')}>
              Unmark all
            </button>
            <label className="ml-auto flex items-center gap-1 text-xs">
              <span className="sr-only">Show matches on page</span>
              <select aria-label="Show matches on page" className="field h-7 px-1 text-xs" value={filterPage} onChange={(e) => setFilterPage(Number(e.target.value))}>
                <option value={0}>All pages</option>
                {resultPages.map((p) => (
                  <option key={p} value={p}>
                    Page {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ul aria-label="Search results" className="space-y-1" data-testid="redact-results">
            {visible.slice(0, show).map((r) => (
              <ResultRow key={r.id} docId={docId} r={r} />
            ))}
          </ul>
          {visible.length > show && (
            <button type="button" className="btn w-full text-xs" onClick={() => setShow((n) => n + RESULT_CHUNK)}>
              Show {Math.min(RESULT_CHUNK, visible.length - show)} more of {visible.length - show}
            </button>
          )}
        </>
      )}
    </section>
  )
}

/** The Redaction panel: review marks, edit areas by number, find and mark text everywhere, and start the Apply. */
export function RedactPanel({ tab }: { tab: Tab }): JSX.Element {
  const docId = tab.docId
  const d = useDocRedact(docId)
  const pendingSave = useRedact((s) => s.pendingPurge[docId])
  const announcement = useRedact((s) => s.announcement)
  const selected = d.marks.find((m) => m.id === d.selectedId)
  const pages = pagesOf(d.marks).length
  const tool = useWorkspace((s) => s.activeTool)
  void tool
  return (
    <div className="space-y-3 p-2 text-sm" data-testid="redact-panel">
      <div className="space-y-2">
        <p className="text-xs" role="status" aria-live="polite" data-testid="redact-count">
          {d.marks.length === 0 ? 'No marks yet.' : `${d.marks.length} ${d.marks.length === 1 ? 'mark' : 'marks'} (${totalRects(d.marks)} ${totalRects(d.marks) === 1 ? 'area' : 'areas'}) on ${pages} ${pages === 1 ? 'page' : 'pages'}.`}
        </p>
        <div className="flex flex-wrap gap-1">
          <button type="button" className="btn h-7 px-2 text-xs" disabled={d.past.length === 0} onClick={() => useRedact.getState().undoMarks(docId)} data-testid="redact-undo-marks">
            Undo mark
          </button>
          <button type="button" className="btn h-7 px-2 text-xs" disabled={d.future.length === 0} onClick={() => useRedact.getState().redoMarks(docId)}>
            Redo mark
          </button>
          <button type="button" className="btn h-7 px-2 text-xs" disabled={d.marks.length === 0} data-testid="redact-clear" onClick={() => useRedact.getState().clearMarks(docId)}>
            Clear all
          </button>
        </div>
        <button type="button" className="btn-primary w-full" data-testid="redact-open-apply" disabled={d.marks.length === 0} onClick={() => useRedact.getState().openDialog(docId)}>
          Review and apply…
        </button>
        <p className="text-xs text-ink-muted">Nothing is removed until you apply. Marks can be changed or removed until then.</p>
      </div>

      {pendingSave && (
        <p role="note" className="rounded-md border border-line bg-surface-alt p-2 text-xs" data-testid="redact-unsaved-note">
          Redaction applied but not saved yet. Undo still brings the content back until you save. After you save, the file is permanently redacted, and you can purge the older versions Epdf keeps.
        </p>
      )}

      <MarksList docId={docId} marks={d.marks} selectedId={d.selectedId} />
      <FindSection docId={docId} tab={tab} />
      {/* Placing areas by exact numbers, for precise work; dragging on the page does the same. */}
      <Advanced id="redact-areas" label="Areas by exact position">
        <div className="space-y-2">
          {selected && selected.kind === 'area' && selected.rects.length === 1 && <AreaFields key={selected.id} docId={docId} tab={tab} mode="edit" selected={selected} />}
          <AreaFields docId={docId} tab={tab} mode="add" />
        </div>
      </Advanced>
      <p className="sr-only" role="status" aria-live="polite" data-testid="redact-announcer">
        {announcement}
      </p>
    </div>
  )
}
