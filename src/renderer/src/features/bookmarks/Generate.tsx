import { useEffect, useRef, useState } from 'react'
import { DETECT_JOB, type DetectJobResult } from '@shared/features/bookmarks'
import { DEFAULT_ACCEPT, nestHeadings, type HeadingCandidate, type HeadingTreeNode } from '@shared/features/bookmarks/headings'
import { Modal } from '../../components/Modal'
import { currentBytes } from '../../edit/session'
import { JobCancelledError, startJob, useJobs } from '../../state/jobs'
import { errorMessage } from '../../state/notify'
import { announce, unlock } from '../links/common'
import { applyGenerated } from './actions'
import { useBookmarks } from './data'
import { IconIndent, IconOutdent } from './icons'
import type { NewBookmark } from './pdf/model'
import { useBookmarkUi } from './store'

/** "Generate bookmarks from headings": runs the detector in a worker with progress and Cancel, then a review list. */

const ROW_H = 38

interface Item {
  c: HeadingCandidate
  accepted: boolean
  level: number
}

type Phase = { kind: 'working' } | { kind: 'review'; result: DetectJobResult } | { kind: 'error'; message: string } | { kind: 'empty'; scanned: boolean }

export function toNewBookmarks(items: readonly Item[]): NewBookmark[] {
  const chosen = items.filter((i) => i.accepted).map((i) => ({ ...i.c, level: i.level }))
  const conv = (n: HeadingTreeNode): NewBookmark => ({
    title: n.candidate.text,
    page: { pageIndex: n.candidate.pageIndex, tail: ['XYZ', null, n.candidate.top + n.candidate.size * 0.25, null] },
    open: n.candidate.level <= 1,
    children: n.children.map(conv)
  })
  return nestHeadings(chosen).map(conv)
}

const confidenceWord = (c: number): string => (c >= 0.75 ? 'High' : c >= DEFAULT_ACCEPT ? 'Medium' : 'Low')

export function GenerateDialog(): JSX.Element | null {
  const target = useBookmarkUi((s) => s.generate)
  if (!target) return null
  return <GenerateBody key={target.docId} docId={target.docId} />
}

function GenerateBody({ docId }: { docId: string }): JSX.Element {
  const close = (): void => useBookmarkUi.getState().openGenerate(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'working' })
  const [items, setItems] = useState<Item[]>([])
  const [mode, setMode] = useState<'replace' | 'append'>(useBookmarks.getState().byDoc[docId]?.hasOutline ? 'append' : 'replace')
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<() => void>(() => undefined)
  const closed = useRef(false)

  const job = useJobs((s) => {
    const running = Object.values(s.jobs).filter((j) => j.kind === DETECT_JOB)
    return running[running.length - 1]
  })

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        if (!(await unlock(docId))) {
          if (alive) close()
          return
        }
        const bytes = await currentBytes(docId)
        const handle = startJob<DetectJobResult>(DETECT_JOB, { bytes })
        cancelRef.current = handle.cancel
        const result = await handle.promise
        if (!alive) return
        if (result.candidates.length === 0) {
          setPhase({ kind: 'empty', scanned: result.pagesWithText === 0 })
          announce('No headings were found')
          return
        }
        setItems(result.candidates.map((c) => ({ c, accepted: c.confidence >= DEFAULT_ACCEPT, level: c.level })))
        setPhase({ kind: 'review', result })
        announce(`${result.candidates.length} possible headings found. Review them, then create the bookmarks.`)
      } catch (err) {
        if (!alive || err instanceof JobCancelledError) return
        setPhase({ kind: 'error', message: errorMessage(err) })
      }
    })()
    return () => {
      alive = false
      cancelRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  const acceptedCount = items.filter((i) => i.accepted).length
  const patch = (idx: number, p: Partial<Item>): void => setItems((list) => list.map((it, i) => (i === idx ? { ...it, ...p } : it)))
  const setAll = (fn: (it: Item) => boolean): void => setItems((list) => list.map((it) => ({ ...it, accepted: fn(it) })))

  const create = async (): Promise<void> => {
    setBusy(true)
    const n = await applyGenerated(docId, toNewBookmarks(items), mode)
    setBusy(false)
    if (n !== undefined && !closed.current) {
      closed.current = true
      close()
    }
  }

  const title = 'Generate bookmarks from headings'
  return (
    <Modal
      title={title}
      wide
      onClose={() => {
        cancelRef.current()
        close()
      }}
    >
      {phase.kind === 'working' && (
        <div className="flex flex-col gap-3" data-testid="generate-working">
          <p role="status">{job?.message ?? 'Starting…'}</p>
          <progress className="h-2 w-full" value={job?.progress ?? 0} max={1} aria-label="Analysis progress" />
          <div className="flex justify-end">
            <button
              className="btn"
              onClick={() => {
                cancelRef.current()
                close()
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'error' && (
        <div className="flex flex-col gap-3">
          <p role="alert">The headings could not be analysed: {phase.message}</p>
          <div className="flex justify-end">
            <button className="btn-primary" onClick={close}>
              Close
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'empty' && (
        <div className="flex flex-col gap-3" data-testid="generate-empty">
          <p role="status">
            {phase.scanned
              ? 'No text was found in this document. It looks like a scan: run OCR first, then try again.'
              : 'No headings were found. Headings are recognised by a larger or bold font, by numbering such as “1.2” or “Chapter 3”, and by all-capital lines.'}
          </p>
          <div className="flex justify-end">
            <button className="btn-primary" onClick={close}>
              Close
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'review' && (
        <ReviewList
          result={phase.result}
          items={items}
          mode={mode}
          setMode={setMode}
          patch={patch}
          setAll={setAll}
          acceptedCount={acceptedCount}
          busy={busy}
          hasOutline={!!useBookmarks.getState().byDoc[docId]?.hasOutline}
          onCreate={() => void create()}
          onCancel={close}
        />
      )}
    </Modal>
  )
}

function ReviewList({
  result,
  items,
  mode,
  setMode,
  patch,
  setAll,
  acceptedCount,
  busy,
  hasOutline,
  onCreate,
  onCancel
}: {
  result: DetectJobResult
  items: Item[]
  mode: 'replace' | 'append'
  setMode(m: 'replace' | 'append'): void
  patch(idx: number, p: Partial<Item>): void
  setAll(fn: (it: Item) => boolean): void
  acceptedCount: number
  busy: boolean
  hasOutline: boolean
  onCreate(): void
  onCancel(): void
}): JSX.Element {
  const [scrollTop, setScrollTop] = useState(0)
  const box = 320
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 4)
  const last = Math.min(items.length - 1, Math.ceil((scrollTop + box) / ROW_H) + 4)
  return (
    <div className="flex flex-col gap-3" data-testid="generate-review">
      <p className="text-ink-muted">
        {items.length} possible headings found in {result.pagesWithText} of {result.pagesTotal} pages (body text about {result.stats.bodySize} pt). Untick what is not a heading; use the arrows to change how deeply a heading is nested.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn h-7 px-2 text-xs" onClick={() => setAll(() => true)}>
          Select all
        </button>
        <button className="btn h-7 px-2 text-xs" onClick={() => setAll(() => false)}>
          Select none
        </button>
        <button className="btn h-7 px-2 text-xs" onClick={() => setAll((it) => it.c.confidence >= DEFAULT_ACCEPT)}>
          Likely headings only
        </button>
        <span className="ms-auto text-xs text-ink-muted" role="status">
          {acceptedCount} of {items.length} selected
        </span>
      </div>
      <div className="h-80 overflow-y-auto rounded-md border border-line" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="generate-list">
        <ul aria-label="Detected headings" className="relative m-0 list-none p-0" style={{ height: items.length * ROW_H }}>
          {items.slice(first, last + 1).map((it, k) => {
            const idx = first + k
            return (
              <li
                key={it.c.id}
                data-testid="generate-item"
                data-accepted={it.accepted}
                className="absolute inset-x-0 flex items-center gap-2 border-b border-line px-2"
                style={{ top: idx * ROW_H, height: ROW_H, paddingInlineStart: 8 + (it.level - 1) * 18 }}
              >
                <input
                  type="checkbox"
                  checked={it.accepted}
                  aria-label={`Include “${it.c.text}”`}
                  onChange={(e) => patch(idx, { accepted: e.target.checked })}
                />
                <span dir="auto" style={{ unicodeBidi: 'isolate' }} className={`min-w-0 flex-1 truncate text-start ${it.level === 1 ? 'font-semibold' : ''}`} title={it.c.text}>
                  {it.c.text}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-ink-muted">p. {it.c.pageIndex + 1}</span>
                <span className="shrink-0 text-xs text-ink-muted" title={it.c.reasons.join('; ')}>
                  {confidenceWord(it.c.confidence)} ({Math.round(it.c.confidence * 100)}%)
                </span>
                <button className="btn-icon h-6 w-6" aria-label={`Promote “${it.c.text}” (less nested)`} title="Promote (less nested)" disabled={it.level <= 1} onClick={() => patch(idx, { level: it.level - 1 })}>
                  <IconOutdent />
                </button>
                <button className="btn-icon h-6 w-6" aria-label={`Demote “${it.c.text}” (more nested)`} title="Demote (more nested)" disabled={it.level >= 6} onClick={() => patch(idx, { level: it.level + 1 })}>
                  <IconIndent />
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 font-medium">When creating</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="gen-mode" checked={mode === 'append'} onChange={() => setMode('append')} disabled={!hasOutline} />
          <span>Add after the existing bookmarks</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="gen-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
          <span>{hasOutline ? 'Replace the existing bookmarks' : 'Create the bookmarks'}</span>
        </label>
      </fieldset>
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-primary" disabled={acceptedCount === 0 || busy} onClick={onCreate}>
          {busy ? 'Creating…' : `Create ${acceptedCount} ${acceptedCount === 1 ? 'bookmark' : 'bookmarks'}`}
        </button>
      </div>
    </div>
  )
}
