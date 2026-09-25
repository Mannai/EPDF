import { useEffect } from 'react'
import { CloudIcon } from './icons'
import { runSearch, openRefs, useLibrary } from './store'

/** Results of a search inside the files: one row per page hit, with the matching words highlighted. */
export function ContentResults(): JSX.Element {
  const hits = useLibrary((s) => s.hits)
  const total = useLibrary((s) => s.hitTotal)
  const capped = useLibrary((s) => s.hitCapped)
  const ms = useLibrary((s) => s.hitMs)
  const error = useLibrary((s) => s.hitError)
  const searching = useLibrary((s) => s.searching)
  const active = useLibrary((s) => s.active)
  const query = useLibrary((s) => s.query.trim())
  const hitQuery = useLibrary((s) => s.hitQuery)

  useEffect(() => {
    if (active >= 0) document.getElementById(`lib-hit-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const open = (i: number): void => {
    const h = useLibrary.getState().hits[i]
    if (h) void openRefs([h.ref], { page: h.page, term: h.term })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const n = hits.length
    if (n === 0) return
    const a = active < 0 ? 0 : active
    const go = (i: number): void => {
      e.preventDefault()
      useLibrary.setState({ active: Math.min(n - 1, Math.max(0, i)), anchor: i })
    }
    if (e.key === 'ArrowDown') go(a + 1)
    else if (e.key === 'ArrowUp') go(a - 1)
    else if (e.key === 'PageDown') go(a + 5)
    else if (e.key === 'PageUp') go(a - 5)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(n - 1)
    else if (e.key === 'Enter') {
      e.preventDefault()
      open(a)
    }
  }

  const status = !query
    ? 'Type words to find inside your files.'
    : error
      ? ''
      : searching && hits.length === 0
        ? 'Searching…'
        : total === 0
          ? `No results for “${query}”.`
          : `${total.toLocaleString('en-US')}${capped ? '+' : ''} result${total === 1 ? '' : 's'} · ${ms} ms`

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="content-results" data-query={hitQuery} data-searching={searching}>
      <p className="px-4 py-2 text-sm text-ink-muted" role="status" data-testid="content-status">
        {status}
      </p>
      {error && (
        <p className="mx-4 mb-2 rounded-md border border-line bg-surface-alt px-3 py-2" role="alert" data-testid="content-error">
          {error}
        </p>
      )}
      {!error && !query && (
        <p className="px-4 pb-2 text-sm text-ink-muted">
          Tips: use quotes for an exact phrase (“annual report”), OR between alternatives, a dash to leave a word out (budget -draft) and * for word beginnings (invoi*).
        </p>
      )}
      {hits.length > 0 && (
        <div
          role="listbox"
          aria-label="Search results"
          tabIndex={0}
          aria-activedescendant={active >= 0 ? `lib-hit-${active}` : undefined}
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          {hits.map((h, i) => (
            <div
              key={`${h.ref}-${h.page}-${i}`}
              id={`lib-hit-${i}`}
              role="option"
              aria-selected={i === active}
              onClick={() => useLibrary.setState({ active: i, anchor: i })}
              onDoubleClick={() => open(i)}
              className={`cursor-default border-b border-line px-4 py-2 ${i === active ? 'bg-accent/15 ring-2 ring-inset ring-accent' : ''}`}
            >
              <div className="flex items-baseline gap-2">
                <span className="truncate font-medium">{h.name}</span>
                <span className="shrink-0 rounded border border-line px-1.5 text-xs text-ink-muted">Page {h.page}</span>
                {h.cloud && (
                  <span className="shrink-0 text-ink-muted" title="Stored in the cloud">
                    <CloudIcon label="Cloud only" />
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-ink-muted" title={h.dir}>
                {h.dir}
              </div>
              <p className="mt-1 break-words text-sm">
                {h.snippet.map((p, k) =>
                  p.hit ? (
                    <mark key={k} className="rounded-sm bg-accent/25 px-0.5 font-semibold text-ink underline decoration-accent decoration-2 underline-offset-2">
                      {p.text}
                    </mark>
                  ) : (
                    <span key={k}>{p.text}</span>
                  )
                )}
              </p>
            </div>
          ))}
        </div>
      )}
      {hits.length > 0 && hits.length < total && (
        <div className="border-t border-line px-4 py-2">
          <button className="btn" disabled={searching} onClick={() => void runSearch(true)}>
            Show more results
          </button>
          <span className="ml-3 text-sm text-ink-muted">
            Showing {hits.length.toLocaleString('en-US')} of {total.toLocaleString('en-US')}
            {capped ? '+' : ''}
          </span>
        </div>
      )}
    </div>
  )
}
