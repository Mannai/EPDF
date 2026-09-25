import { movePage, removePage, rotatePage, selectPage } from './pages'
import { useScan } from './store'
import { BitmapCanvas } from './ui'

/** The list of pages with the per-page actions (rotate, reorder, delete). Shown in the capture and adjust steps. */

export function PageStrip({ showTools = true }: { showTools?: boolean }): JSX.Element {
  const pages = useScan((s) => s.pages)
  const selectedId = useScan((s) => s.selectedId)
  const previews = useScan((s) => s.previews)
  const index = pages.findIndex((p) => p.id === selectedId)
  const sel = pages[index]

  if (pages.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-line p-3 text-sm text-ink-muted" data-testid="no-pages">
        No pages yet. Scan, capture or receive some above; they will appear here.
      </p>
    )
  }
  return (
    <div data-testid="page-strip">
      <h3 className="mb-1 text-sm font-medium" id="strip-h">
        Pages ({pages.length})
      </h3>
      <ul aria-labelledby="strip-h" className="flex gap-2 overflow-x-auto pb-2">
        {pages.map((p, i) => {
          const active = p.id === selectedId
          return (
            <li key={p.id} className="flex-none">
              <button
                type="button"
                onClick={() => selectPage(p.id)}
                aria-current={active ? 'true' : undefined}
                aria-label={`Page ${i + 1}${p.state === 'preparing' ? ', preparing' : p.state === 'error' ? ', could not be read' : ''}${active ? ', selected' : ''}`}
                className={`flex h-32 w-24 flex-col items-center justify-between rounded-md border p-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? 'border-accent bg-accent/10 ring-1 ring-accent' : 'border-line bg-surface'}`}
                data-testid="page-thumb"
              >
                <span className="flex h-24 w-full items-center justify-center overflow-hidden">
                  {previews[p.id]?.thumb ? (
                    <BitmapCanvas bitmap={previews[p.id]?.thumb} label="" className="max-h-24 max-w-full" />
                  ) : (
                    <span className="text-xs text-ink-muted">{p.state === 'error' ? 'Unreadable' : 'Preparing…'}</span>
                  )}
                </span>
                <span className="text-xs text-ink-muted" aria-hidden="true">
                  {i + 1}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {showTools && sel && (
        <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label={`Actions for page ${index + 1}`}>
          <button type="button" className="btn" onClick={() => rotatePage(sel.id, -1)} disabled={sel.state !== 'ready'}>
            Rotate left
          </button>
          <button type="button" className="btn" onClick={() => rotatePage(sel.id, 1)} disabled={sel.state !== 'ready'}>
            Rotate right
          </button>
          <button type="button" className="btn" onClick={() => movePage(sel.id, -1)} disabled={index === 0}>
            Move earlier
          </button>
          <button type="button" className="btn" onClick={() => movePage(sel.id, 1)} disabled={index === pages.length - 1}>
            Move later
          </button>
          <button type="button" className="btn" onClick={() => removePage(sel.id)} data-testid="delete-page">
            Delete page
          </button>
        </div>
      )}
      {sel?.state === 'error' && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          Page {index + 1}: {sel.error}
        </p>
      )}
    </div>
  )
}
