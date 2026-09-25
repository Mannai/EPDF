import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeText } from './diff/enrich'
import { segmentsOf, type Mark } from './diff/charDiff'
import { ALL_KINDS, KIND_LABEL, countsPerPage, filterChanges, primaryPage } from './diff/summary'
import type { Change, ChangeKind } from './diff/types'
import { SYMBOL } from './Panes'
import type { Session } from './session'
import { useCompare, type Entry } from './store'

const ROW_H = 80
const PREVIEW_CHARS = 120

/** A window of `text` (with its marks shifted) that keeps the first mark in view. */
export function clipAround(text: string, marks: Mark[], max = PREVIEW_CHARS): { text: string; marks: Mark[] } {
  if (text.length <= max) return { text, marks }
  const focus = marks[0]?.[0] ?? 0
  const start = Math.max(0, Math.min(focus - 30, text.length - max))
  const end = Math.min(text.length, start + max)
  const shifted: Mark[] = marks.filter(([s, e]) => e > start && s < end).map(([s, e]) => [Math.max(s, start) - start + (start > 0 ? 1 : 0), Math.min(e, end) - start + (start > 0 ? 1 : 0)])
  return { text: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`, marks: shifted }
}

function Marked({ text, marks, cls, markCls }: { text: string; marks: Mark[]; cls: string; markCls: string }): JSX.Element {
  const c = clipAround(text, marks)
  return (
    <span className={cls}>
      {segmentsOf(c.text, c.marks).map((s, i) =>
        s.marked ? (
          <mark key={i} className={markCls}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </span>
  )
}

export function Preview({ c, t }: { c: Change; t: ChangeText | undefined }): JSX.Element {
  if (!t) return <span />
  if (c.kind === 'removed') return <Marked text={t.oldText} marks={[]} cls="cmp-del" markCls="" />
  if (c.kind === 'added') return <Marked text={t.newText} marks={[]} cls="cmp-ins" markCls="" />
  if (c.kind === 'modified') {
    return (
      <>
        <Marked text={t.oldText} marks={t.oldMarks} cls="cmp-del" markCls="cmp-del-mark" />
        <span aria-hidden="true"> → </span>
        <span className="sr-only"> changed to </span>
        <Marked text={t.newText} marks={t.newMarks} cls="cmp-ins" markCls="cmp-ins-mark" />
      </>
    )
  }
  return <Marked text={t.newText || t.oldText} marks={t.newMarks} cls="" markCls="cmp-ins-mark" />
}

const where = (c: Change): string => (c.kind === 'moved' ? `Page ${c.old?.page} → page ${c.new?.page}` : `Page ${primaryPage(c)}`)

interface Props {
  docId: string
  session: Session
  entry: Entry
}

export function ChangeList({ docId, session, entry }: Props): JSX.Element {
  const { result, texts } = session
  const patch = useCompare((s) => s.patch)
  const jump = useCompare((s) => s.jump)
  const { filters, current } = entry
  const scroller = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(400)
  const [scrollTop, setScrollTop] = useState(0)
  const [active, setActive] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)

  const visible = useMemo(() => filterChanges(result.changes, texts, filters), [result, texts, filters])
  const perPage = useMemo(() => countsPerPage(result.changes), [result])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const indexOfId = (id: number | null): number => (id === null ? -1 : visible.findIndex((c) => c.id === id))
  const activeIdx = indexOfId(active) >= 0 ? indexOfId(active) : indexOfId(current)

  const ensureVisible = (i: number): void => {
    const el = scroller.current
    if (!el || i < 0) return
    if (i * ROW_H < el.scrollTop) el.scrollTop = i * ROW_H
    else if ((i + 1) * ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW_H - el.clientHeight
    setScrollTop(el.scrollTop)
  }

  // Keep the current change (from Next/Previous or a click in the pages) in view in the list.
  useEffect(() => {
    if (current !== null) {
      setActive(current)
      ensureVisible(visible.findIndex((c) => c.id === current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, entry.jumpSeq])

  const from = Math.max(0, Math.floor(scrollTop / ROW_H) - 3)
  const to = Math.min(visible.length, Math.ceil((scrollTop + h) / ROW_H) + 3)

  const toggleKind = (k: ChangeKind): void => {
    const kinds = new Set(filters.kinds)
    if (kinds.has(k)) kinds.delete(k)
    else kinds.add(k)
    patch(docId, { filters: { ...filters, kinds } })
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (visible.length === 0) return
    const cur = activeIdx < 0 ? 0 : activeIdx
    let next = cur
    if (e.key === 'ArrowDown') next = Math.min(visible.length - 1, cur + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, cur - 1)
    else if (e.key === 'PageDown') next = Math.min(visible.length - 1, cur + Math.max(1, Math.floor(h / ROW_H) - 1))
    else if (e.key === 'PageUp') next = Math.max(0, cur - Math.max(1, Math.floor(h / ROW_H) - 1))
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = visible.length - 1
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      jump(docId, visible[cur].id)
      return
    } else return
    e.preventDefault()
    setActive(visible[next].id)
    ensureVisible(next)
  }

  const shown = visible.length
  const total = result.changes.length
  const activeId = activeIdx >= 0 && activeIdx >= from && activeIdx < to ? `cmp-change-${visible[activeIdx].id}` : undefined

  return (
    <aside aria-label="Summary of changes" className="flex w-[22rem] shrink-0 flex-col border-l border-line bg-surface" data-testid="compare-list">
      <div className="flex flex-col gap-2 border-b border-line p-3">
        <h3 className="text-sm font-semibold">Changes</h3>
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
          <legend className="sr-only">Show these kinds of change</legend>
          {ALL_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1.5 text-sm" data-testid={`filter-${k}`}>
              <input type="checkbox" checked={filters.kinds.has(k)} onChange={() => toggleKind(k)} />
              <span aria-hidden="true">{SYMBOL[k]}</span>
              <span>
                {KIND_LABEL[k]} <span data-testid={`count-${k}`}>({result.counts[k]})</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs text-ink-muted">
            Page
            <select
              aria-label="Filter by page"
              title="Pages are numbered as in the new version (as in the old version for removed pages)"
              className="field w-full text-sm text-ink"
              value={filters.page ?? ''}
              onChange={(e) => patch(docId, { filters: { ...filters, page: e.target.value === '' ? null : Number(e.target.value) } })}
            >
              <option value="">All pages</option>
              {perPage.map((p) => (
                <option key={p.page} value={p.page}>
                  Page {p.page} ({p.total})
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-[1.4] flex-col gap-0.5 text-xs text-ink-muted">
            Search in changes
            <input
              type="search"
              className="field w-full text-sm text-ink"
              value={filters.query}
              placeholder="Text…"
              onChange={(e) => patch(docId, { filters: { ...filters, query: e.target.value } })}
            />
          </label>
        </div>
        <p role="status" className="text-xs text-ink-muted" data-testid="compare-list-count">
          {total === 0 ? 'No changes' : shown === total ? `${total} ${total === 1 ? 'change' : 'changes'}` : `Showing ${shown} of ${total} changes`}
        </p>
      </div>

      <p id="cmp-list-help" className="sr-only">
        Use the up and down arrow keys to move through the changes and Enter to show one in the pages.
      </p>
      <div
        ref={scroller}
        role="listbox"
        aria-label="Changes"
        aria-describedby="cmp-list-help"
        aria-activedescendant={activeId}
        tabIndex={0}
        data-testid="compare-changes"
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <div style={{ height: visible.length * ROW_H, position: 'relative' }}>
          {visible.slice(from, to).map((c, k) => {
            const i = from + k
            const isCurrent = c.id === current
            const isActive = focused && i === activeIdx
            return (
              <div
                key={c.id}
                id={`cmp-change-${c.id}`}
                role="option"
                aria-selected={isCurrent}
                data-testid="compare-change"
                data-change={c.id}
                data-kind={c.kind}
                onClick={() => {
                  setActive(c.id)
                  jump(docId, c.id)
                }}
                className={`cmp-option absolute left-0 right-0 cursor-pointer overflow-hidden border-b border-line px-3 py-2 ${isCurrent ? 'bg-accent/15 ring-2 ring-inset ring-accent' : 'hover:bg-surface-alt'} ${isActive ? 'outline outline-2 -outline-offset-2 outline-ink' : ''}`}
                style={{ top: i * ROW_H, height: ROW_H }}
              >
                <div className="flex items-center gap-2">
                  <span className="cmp-kind" data-kind={c.kind}>
                    <span aria-hidden="true">{SYMBOL[c.kind]}</span>
                    {KIND_LABEL[c.kind]}
                    {c.edited ? ' (edited)' : ''}
                  </span>
                  <span className="text-xs text-ink-muted">{where(c)}</span>
                  <span className="ml-auto text-xs text-ink-muted">#{c.id + 1}</span>
                </div>
                <div className="mt-1 line-clamp-2 break-words text-sm text-ink">
                  <Preview c={c} t={texts[c.id]} />
                </div>
              </div>
            )
          })}
        </div>
        {visible.length === 0 && <p className="p-4 text-sm text-ink-muted">{total === 0 ? 'The two documents have the same text.' : 'No change matches the current filters.'}</p>}
      </div>
    </aside>
  )
}
