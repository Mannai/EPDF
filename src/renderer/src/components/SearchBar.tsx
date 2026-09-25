import { useEffect, useRef } from 'react'
import { getLoaded } from '../pdf/docCache'
import { stepSearch } from '../state/actions'
import { useSearch } from '../state/search'
import type { Tab } from '../state/tabs'
import { IconClose, IconDown, IconUp } from './Icons'

export function SearchBar({ tab }: { tab: Tab }): JSX.Element | null {
  const open = useSearch((s) => s.open)
  const query = useSearch((s) => s.query)
  const options = useSearch((s) => s.options)
  const flatCount = useSearch((s) => s.flat.length)
  const current = useSearch((s) => s.current)
  const searching = useSearch((s) => s.searching)
  const progress = useSearch((s) => s.progress)
  const input = useRef<HTMLInputElement>(null)
  const page = useRef(tab.view.page)
  page.current = tab.view.page

  useEffect(() => {
    const focus = (): void => {
      input.current?.focus()
      input.current?.select()
    }
    document.addEventListener('epdf:focus-search', focus)
    return () => document.removeEventListener('epdf:focus-search', focus)
  }, [])

  // (Re)run the search shortly after typing stops, or when the option set / document changes.
  const ready = tab.status === 'ready'
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      const doc = ready ? (getLoaded(tab.docId)?.doc ?? null) : null
      useSearch.getState().run(doc, page.current)
    }, 220)
    return () => clearTimeout(t)
  }, [open, query, options.matchCase, options.wholeWord, tab.docId, tab.loadSeq, tab.contentSeq, ready])

  if (!open) return null

  const status = !query.trim()
    ? ''
    : flatCount === 0
      ? searching
        ? 'Searching…'
        : 'No results'
      : `${current + 1} of ${flatCount}${searching ? '+' : ''}`

  return (
    <div
      role="search"
      aria-label="Find in document"
      className="absolute right-4 top-3 z-30 flex items-center gap-1 rounded-lg border border-line bg-raised p-1.5 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          useSearch.getState().setOpen(false)
          document.querySelector<HTMLElement>('[data-testid="viewer-scroll"]')?.focus()
        }
      }}
    >
      <input
        ref={input}
        autoFocus
        className="field w-56"
        type="text"
        aria-label="Find text"
        placeholder="Find in document"
        value={query}
        onChange={(e) => useSearch.getState().setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            stepSearch(e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="min-w-20 px-1 text-center text-xs tabular-nums text-ink-muted" role="status" aria-live="polite">
        {status}
      </span>
      {searching && (
        <progress className="h-1 w-10" value={progress} max={1} aria-label="Search progress" />
      )}
      <button className="btn-icon" aria-label="Previous match" disabled={flatCount === 0} onClick={() => stepSearch(-1)}>
        <IconUp />
      </button>
      <button className="btn-icon" aria-label="Next match" disabled={flatCount === 0} onClick={() => stepSearch(1)}>
        <IconDown />
      </button>
      <button
        className="btn-icon text-xs font-semibold"
        aria-label="Match case"
        aria-pressed={options.matchCase}
        title="Match case"
        onClick={() => useSearch.getState().setOptions({ matchCase: !options.matchCase })}
      >
        Aa
      </button>
      <button
        className="btn-icon text-xs font-semibold"
        aria-label="Whole word"
        aria-pressed={options.wholeWord}
        title="Whole word"
        onClick={() => useSearch.getState().setOptions({ wholeWord: !options.wholeWord })}
      >
        ab
      </button>
      <button className="btn-icon" aria-label="Close find" onClick={() => useSearch.getState().setOpen(false)}>
        <IconClose />
      </button>
    </div>
  )
}
