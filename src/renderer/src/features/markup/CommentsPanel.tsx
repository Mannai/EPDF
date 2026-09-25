import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTabs, type Tab } from '../../state/tabs'
import { AnnotProperties, CommitTextarea } from './Controls'
import { announce, deleteAnnot, editComment, replyTo, setStatus } from './actions'
import { useDocAnnots } from './data'
import { IconCheck, IconFor } from './icons'
import { subtypeLabel, type AnnotInfo, type ReviewState } from './pdf/model'
import {
  STATE_LABEL,
  authorsOf,
  filterThreads,
  isResolved,
  previewOf,
  timeOf,
  typesOf,
  type Thread
} from './pdf/threads'
import { placeDefault } from './placement'
import { useMarkup } from './store'

/** "Sep 25, 2026, 12:00 PM" in the user's locale. */
export function formatWhen(ms: number | null): string {
  if (ms === null) return ''
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return new Date(ms).toISOString()
  }
}

const STATES: ReviewState[] = ['None', 'Accepted', 'Rejected', 'Completed', 'Cancelled']

export function CommentsPanel({ tab }: { tab: Tab }): JSX.Element {
  const docId = tab.docId
  const data = useDocAnnots(docId, true)
  const filters = useMarkup((s) => s.filters)
  const setFilters = useMarkup((s) => s.setFilters)
  const selection = useMarkup((s) => s.selection)
  const listRef = useRef<HTMLUListElement>(null)

  const threads = data?.threads ?? []
  const shown = useMemo(() => filterThreads(threads, filters), [threads, filters])
  const annots = data?.annots ?? []
  const authors = useMemo(() => authorsOf(annots), [annots])
  const types = useMemo(() => typesOf(annots), [annots])
  const total = threads.length
  const filtered = filters.type !== 'all' || filters.author !== 'all' || filters.status !== 'all' || filters.query.trim() !== ''

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-row-button]') ?? [])
    const i = rows.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  return (
    <div className="flex flex-col text-sm" data-testid="comments-panel">
      <div className="space-y-2 border-b border-line p-2">
        <AuthorField />
        <button type="button" className="btn w-full" onClick={() => void placeDefault('note')}>
          Add sticky note to page {tab.view.page}
        </button>
        <label className="block">
          <span className="sr-only">Search comments</span>
          <input
            type="search"
            className="field w-full"
            placeholder="Search comments"
            value={filters.query}
            onChange={(e) => setFilters({ query: e.target.value })}
          />
        </label>
        <div className="grid grid-cols-3 gap-1">
          <label className="min-w-0 text-xs text-ink-muted">
            <span className="sr-only">Filter by type</span>
            <select aria-label="Filter by type" className="field w-full px-1 text-xs" value={filters.type} onChange={(e) => setFilters({ type: e.target.value })}>
              <option value="all">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {subtypeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-xs text-ink-muted">
            <span className="sr-only">Filter by author</span>
            <select aria-label="Filter by author" className="field w-full px-1 text-xs" value={filters.author} onChange={(e) => setFilters({ author: e.target.value })}>
              <option value="all">All authors</option>
              {authors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-xs text-ink-muted">
            <span className="sr-only">Filter by status</span>
            <select aria-label="Filter by status" className="field w-full px-1 text-xs" value={filters.status} onChange={(e) => setFilters({ status: e.target.value })}>
              <option value="all">Any status</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {filtered && (
          <button type="button" className="rounded text-xs text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setFilters({ type: 'all', author: 'all', status: 'all', query: '' })}>
            Clear filters
          </button>
        )}
        <p role="status" aria-live="polite" className="text-xs text-ink-muted" data-testid="comment-count">
          {data ? (filtered ? `${shown.length} of ${total} ${total === 1 ? 'comment' : 'comments'}` : `${total} ${total === 1 ? 'comment' : 'comments'}`) : 'Loading comments…'}
        </p>
      </div>

      {data?.error && (
        <p role="alert" className="p-3 text-ink-muted">
          {data.error}
        </p>
      )}
      {data && !data.error && total === 0 && (
        <p className="p-3 text-ink-muted">No comments yet. Use the Comment tools above to add highlights, notes, drawings and stamps.</p>
      )}
      {data && total > 0 && shown.length === 0 && <p className="p-3 text-ink-muted">No comments match these filters.</p>}

      <ul ref={listRef} role="list" aria-label="Comments" className="divide-y divide-line" onKeyDown={onListKey}>
        {shown.map((t) => (
          <ThreadItem key={t.root.id} docId={docId} thread={t} selected={selection?.docId === docId && selection.id === t.root.id} />
        ))}
      </ul>
    </div>
  )
}

function AuthorField(): JSX.Element {
  const author = useMarkup((s) => s.author)
  const setAuthor = useMarkup((s) => s.setAuthor)
  const [local, setLocal] = useState(author)
  useEffect(() => setLocal(author), [author])
  const id = useId()
  const commit = (): void => {
    if (local.trim() !== author) setAuthor(local)
    else setLocal(author)
  }
  return (
    <div>
      <label htmlFor={id} className="mb-0.5 block text-xs font-medium text-ink-muted">
        Your name (written into new comments)
      </label>
      <input
        id={id}
        className="field w-full"
        value={local}
        maxLength={80}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
            e.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

function ThreadItem({ docId, thread, selected }: { docId: string; thread: Thread; selected: boolean }): JSX.Element {
  const { root, replies, state } = thread
  const select = useMarkup((s) => s.select)
  const [replying, setReplying] = useState(false)
  const rowRef = useRef<HTMLLIElement>(null)
  const resolved = isResolved(state)
  const replyCount = replies.length

  const open = (a: AnnotInfo): void => {
    select(docId, a.id, { reveal: true })
    useTabs.getState().goToPage(docId, a.pageIndex + 1)
  }

  // Selecting from the page (or by keyboard elsewhere) brings the row into view in the list.
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <li ref={rowRef} data-thread={root.id} data-state={state} className={selected ? 'bg-accent/10' : ''}>
      <div className="p-2">
        <button
          type="button"
          data-row-button
          aria-current={selected ? 'true' : undefined}
          className="flex w-full items-start gap-2 rounded-md p-1 text-left outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => open(root)}
          onKeyDown={(e) => {
            if (e.key === 'Delete') {
              e.preventDefault()
              void deleteAnnot(docId, root)
            }
          }}
        >
          <span className="mt-0.5 shrink-0 text-ink-muted">
            <IconFor annot={root} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-ink-muted">
              <span>
                <span className="font-medium text-ink">{subtypeLabel(root.subtype)}</span> · Page {root.pageIndex + 1}
              </span>
              <time dateTime={timeOf(root) ? new Date(timeOf(root)).toISOString() : undefined}>{formatWhen(root.modified ?? root.created)}</time>
            </span>
            <span className="block text-xs text-ink-muted">{root.author || 'Unknown author'}</span>
            <span className={`block break-words ${resolved ? 'text-ink-muted line-through decoration-1' : ''}`} data-testid="comment-preview">
              {previewOf(root)}
            </span>
            {(state !== 'None' || replyCount > 0) && (
              <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                {state !== 'None' && (
                  <span className="inline-flex items-center gap-1 rounded border border-line px-1" data-testid="comment-status">
                    {resolved && <IconCheck />}
                    {STATE_LABEL[state]}
                  </span>
                )}
                {replyCount > 0 && (
                  <span>
                    {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                  </span>
                )}
              </span>
            )}
          </span>
        </button>

        {replies.length > 0 && (
          <ul role="list" aria-label={`Replies to ${subtypeLabel(root.subtype)} on page ${root.pageIndex + 1}`} className="mt-1 space-y-1 border-l-2 border-line pl-2" style={{ marginLeft: 12 }}>
            {replies.map(({ annot, depth }) => (
              <ReplyItem key={annot.id} docId={docId} annot={annot} depth={depth} />
            ))}
          </ul>
        )}

        <div className="mt-1 flex flex-wrap gap-1 pl-1">
          <button type="button" className="btn h-7 px-2 text-xs" onClick={() => setReplying((v) => !v)} aria-expanded={replying}>
            Reply
          </button>
          <button
            type="button"
            className="btn h-7 px-2 text-xs"
            onClick={() => void setStatus(docId, root.id, resolved ? 'None' : 'Completed')}
          >
            {resolved ? 'Reopen' : 'Resolve'}
          </button>
        </div>

        {replying && <ReplyForm docId={docId} parent={root} onDone={() => setReplying(false)} />}

        {selected && (
          <div className="mt-2 border-t border-line pt-2" data-testid="comment-details">
            <AnnotProperties docId={docId} annot={root} variant="panel" />
            <label className="mt-2 flex items-center gap-2 text-xs text-ink">
              <span>Status</span>
              <select
                className="field text-xs"
                value={state}
                onChange={(e) => void setStatus(docId, root.id, e.target.value as ReviewState)}
              >
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            {thread.stateBy && state !== 'None' && (
              <p className="mt-1 text-xs text-ink-muted">
                {STATE_LABEL[state]} by {thread.stateBy}
                {thread.stateAt ? ` on ${formatWhen(thread.stateAt)}` : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function ReplyItem({ docId, annot, depth }: { docId: string; annot: AnnotInfo; depth: number }): JSX.Element {
  const [editing, setEditing] = useState(false)
  return (
    <li data-reply={annot.id} style={{ marginLeft: Math.max(0, depth - 1) * 12 }} className="text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-ink-muted">
        <span className="font-medium text-ink">{annot.author || 'Unknown author'}</span>
        <time dateTime={timeOf(annot) ? new Date(timeOf(annot)).toISOString() : undefined}>{formatWhen(annot.modified ?? annot.created)}</time>
      </div>
      {editing ? (
        <CommitTextarea
          label={`Edit reply by ${annot.author || 'unknown author'}`}
          hideLabel
          value={annot.contents}
          rows={2}
          onCommit={(v) => {
            setEditing(false)
            void editComment(docId, annot.id, v)
          }}
        />
      ) : (
        <p className="break-words">{annot.contents}</p>
      )}
      <div className="mt-0.5 flex gap-1">
        <button type="button" className="btn h-6 px-2 text-xs" onClick={() => setEditing((v) => !v)} aria-label={`${editing ? 'Stop editing' : 'Edit'} reply by ${annot.author || 'unknown author'}`}>
          {editing ? 'Done' : 'Edit'}
        </button>
        <button
          type="button"
          className="btn h-6 px-2 text-xs"
          aria-label={`Delete reply by ${annot.author || 'unknown author'}`}
          onClick={() => void deleteAnnot(docId, annot)}
        >
          Delete
        </button>
      </div>
    </li>
  )
}

function ReplyForm({ docId, parent, onDone }: { docId: string; parent: AnnotInfo; onDone(): void }): JSX.Element {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  useEffect(() => ref.current?.focus(), [])
  const submit = async (): Promise<void> => {
    const t = text.trim()
    if (!t) return
    onDone()
    await replyTo(docId, parent.id, t)
  }
  return (
    <form
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onDone()
          announce('Reply cancelled')
        }
      }}
    >
      <label htmlFor={id} className="mb-0.5 block text-xs font-medium text-ink-muted">
        Reply
      </label>
      <textarea
        id={id}
        ref={ref}
        rows={2}
        className="field h-auto w-full resize-y py-1"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="mt-1 flex justify-end gap-1">
        <button type="button" className="btn h-7 px-2 text-xs" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn-primary h-7 px-2 text-xs" disabled={!text.trim()}>
          Post reply
        </button>
      </div>
    </form>
  )
}
