import { useEffect, useMemo, useState } from 'react'
import type { SavedReport } from '@shared/features/compare'
import { stemOf } from '@shared/features/pages/filenames'
import { errorMessage, notify } from '../../state/notify'
import type { Tab } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import { ChangeList } from './ChangeList'
import { Choose } from './Choose'
import { describeCounts, filterChanges } from './diff/summary'
import { Panes } from './Panes'
import { buildReportPdf, csvBytes } from './report'
import { useCompare, newEntry, type Entry } from './store'
import { VisualDiff } from './VisualDiff'
import './compare.css'

function Running({ docId, entry }: { docId: string; entry: Entry }): JSX.Element {
  const cancel = useCompare((s) => s.cancel)
  const pct = Math.round((entry.progress?.fraction ?? 0) * 100)
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-8" data-testid="compare-running">
      <h2 className="text-lg font-semibold">Comparing…</h2>
      <div className="h-3 w-full overflow-hidden rounded-full bg-surface-alt ring-1 ring-line" role="progressbar" aria-label="Comparison progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-testid="compare-progress">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p role="status" className="text-sm" data-testid="compare-progress-label">
        {entry.progress?.label ?? 'Starting'} ({pct}%)
      </p>
      <div>
        <button className="btn" onClick={() => cancel(docId)} data-testid="compare-cancel">
          Cancel
        </button>
      </div>
    </div>
  )
}

function Results({ tab, entry }: { tab: Tab; entry: Entry }): JSX.Element {
  const { docId } = tab
  const session = entry.session!
  const { result, texts } = session
  const patch = useCompare((s) => s.patch)
  const step = useCompare((s) => s.step)
  const jump = useCompare((s) => s.jump)
  const reset = useCompare((s) => s.reset)
  const visible = useMemo(() => filterChanges(result.changes, texts, entry.filters), [result, texts, entry.filters])
  const start = useCompare((s) => s.start)
  const [exporting, setExporting] = useState(false)

  const shown = visible.length
  const at = entry.current === null ? -1 : visible.findIndex((c) => c.id === entry.current)
  const counter =
    result.counts.total === 0
      ? 'No text changes'
      : shown === 0
        ? 'No change matches the filters'
        : at >= 0
          ? `Change ${at + 1} of ${shown}`
          : `${shown} ${shown === 1 ? 'change' : 'changes'}${shown !== result.counts.total ? ` (of ${result.counts.total})` : ''}`

  const stale = entry.newSource?.kind === 'tab' && entry.newSource.docId === docId && tab.contentSeq !== entry.contentSeq
  const { visual } = entry
  const pairs = result.pairs
  const addedPages = pairs.filter((p) => p.old === null).length
  const removedPages = pairs.filter((p) => p.new === null).length
  const movedPages = pairs.filter((p) => p.moved).length

  let verdict: string
  if (result.counts.total > 0) {
    verdict = `${describeCounts(result.counts)} on ${result.changedPairs} of ${pairs.length} page ${pairs.length === 1 ? 'pair' : 'pairs'}.`
    if (visual.status === 'done' && visual.differing.length > 0) verdict += ` ${visual.differing.length} page pair${visual.differing.length === 1 ? '' : 's'} also differ visually.`
  } else if (visual.status === 'running') verdict = 'No text differences. Checking pictures and graphics…'
  else if (visual.status === 'done') {
    verdict =
      visual.differing.length > 0
        ? `No text differences, but ${visual.differing.length} page${visual.differing.length === 1 ? '' : 's'} differ${visual.differing.length === 1 ? 's' : ''} visually.`
        : addedPages + removedPages + movedPages > 0
          ? 'No text differences and no visual differences on the pages that exist in both versions.'
          : 'No differences found: the text and the appearance of every page are the same.'
  } else verdict = 'No text differences.'
  const notes: string[] = []
  if (addedPages + removedPages + movedPages > 0) notes.push(`Pages: ${addedPages} added, ${removedPages} removed, ${movedPages} moved.`)
  if (session.noText) notes.push('Neither file has selectable text (scanned pages?), so only the visual comparison can find differences.')
  if (session.failed.old.length + session.failed.new.length > 0) notes.push(`The text of ${session.failed.old.length + session.failed.new.length} page(s) could not be read.`)

  const exportAs = async (kind: 'pdf' | 'csv'): Promise<void> => {
    setExporting(true)
    try {
      const oldName = session.oldSide.name
      const newName = session.newSide.name
      const bytes =
        kind === 'pdf'
          ? await buildReportPdf({
              oldName,
              newName,
              result,
              texts,
              opts: session.opts,
              visualPages: visual.status === 'done' ? visual.differing.map((i) => ({ old: pairs[i].old, new: pairs[i].new })) : null
            })
          : csvBytes(result, texts)
      const saved = await window.epdf.call<SavedReport | null>('compare:saveReport', { docId, kind, bytes, suggestedName: `Comparison - ${stemOf(oldName)} vs ${stemOf(newName)}` })
      if (saved) {
        patch(docId, { announcement: `Saved ${kind === 'pdf' ? 'the report' : 'the change list'} as ${saved.name}.` })
        notify('success', `Saved ${saved.name}`)
      }
    } catch (err) {
      notify('error', `Couldn’t save the ${kind === 'pdf' ? 'report' : 'change list'}: ${errorMessage(err)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <div role="toolbar" aria-label="Comparison actions" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-surface px-3 py-2">
        <button className="btn-icon" onClick={() => step(docId, -1)} disabled={shown === 0} aria-label="Previous change" aria-keyshortcuts="Shift+F8" title="Previous change (Shift+F8)" data-testid="compare-prev">
          <span aria-hidden="true">↑</span>
        </button>
        <button className="btn-icon" onClick={() => step(docId, 1)} disabled={shown === 0} aria-label="Next change" aria-keyshortcuts="F8" title="Next change (F8)" data-testid="compare-next">
          <span aria-hidden="true">↓</span>
        </button>
        <span className="min-w-[9rem] px-1 text-sm font-medium tabular-nums" data-testid="compare-counter">
          {counter}
        </span>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <fieldset className="flex items-center gap-3">
          <legend className="sr-only">View</legend>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" name={`mode-${docId}`} checked={entry.mode === 'side'} onChange={() => patch(docId, { mode: 'side' })} data-testid="mode-side" />
            Side by side
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" name={`mode-${docId}`} checked={entry.mode === 'visual'} onChange={() => patch(docId, { mode: 'visual' })} data-testid="mode-visual" />
            Visual differences
          </label>
        </fieldset>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <button className="btn" aria-pressed={entry.listOpen} onClick={() => patch(docId, { listOpen: !entry.listOpen })}>
          Summary list
        </button>
        <button className="btn" disabled={exporting} onClick={() => void exportAs('pdf')} data-testid="export-pdf">
          Export report (PDF)…
        </button>
        <button className="btn" disabled={exporting} onClick={() => void exportAs('csv')} data-testid="export-csv">
          Export changes (CSV)…
        </button>
        <button className="btn ml-auto" onClick={() => reset(docId)} data-testid="compare-new">
          New comparison…
        </button>
      </div>
      <div className="shrink-0 border-b border-line bg-surface px-3 py-1.5 text-sm" data-testid="compare-verdict-bar">
        <p className="font-medium" data-testid="compare-verdict">
          {verdict}
        </p>
        {notes.map((n) => (
          <p key={n} className="text-xs text-ink-muted">
            {n}
          </p>
        ))}
        {stale && (
          <p className="mt-1 flex items-center gap-2 text-xs" role="alert">
            The open document has changed since this comparison.
            <button className="btn h-6 px-2 text-xs" onClick={() => void start(docId)}>
              Compare again
            </button>
          </p>
        )}
      </div>
      <div className="sr-only" role="status" aria-live="polite" data-testid="compare-announce">
        {entry.announcement}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {entry.mode === 'side' ? (
            <Panes docId={docId} session={session} current={entry.current} jumpSeq={entry.jumpSeq} onlyChanged={entry.onlyChanged} onSelect={(id) => jump(docId, id)} />
          ) : (
            <VisualDiff docId={docId} session={session} entry={entry} />
          )}
        </div>
        {entry.listOpen && <ChangeList docId={docId} session={session} entry={entry} />}
      </div>
    </>
  )
}

/** The full-tab Compare Files view: choose two versions, watch the progress, then browse the differences. */
export function CompareView({ tab }: { tab: Tab }): JSX.Element {
  const { docId } = tab
  const ensure = useCompare((s) => s.ensure)
  const stored = useCompare((s) => s.byDoc[docId])
  const entry = stored ?? newEntry()
  const setView = useWorkspace((s) => s.setView)

  useEffect(() => {
    ensure(tab)
  }, [ensure, tab])

  return (
    <div className="cmp-root flex h-full flex-col bg-surface" data-testid="compare" aria-busy={entry.phase === 'running'}>
      {entry.phase !== 'done' && (
        <div role="toolbar" aria-label="Compare files" className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <button className="btn-primary" onClick={() => setView(docId, null)}>
            Done
          </button>
          <h2 className="mx-2 text-sm font-semibold">Compare files</h2>
        </div>
      )}
      {entry.phase === 'done' && entry.session && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <button className="btn-primary" onClick={() => setView(docId, null)}>
            Done
          </button>
          <h2 className="mx-2 min-w-0 truncate text-sm font-semibold" data-testid="compare-title">
            Compare files: {entry.session.oldSide.name} → {entry.session.newSide.name}
          </h2>
        </div>
      )}
      {entry.phase === 'choose' && (
        <div className="min-h-0 flex-1 overflow-auto">
          <Choose tab={tab} entry={entry} />
        </div>
      )}
      {entry.phase === 'running' && <Running docId={docId} entry={entry} />}
      {entry.phase === 'done' && entry.session && <Results tab={tab} entry={entry} />}
    </div>
  )
}
