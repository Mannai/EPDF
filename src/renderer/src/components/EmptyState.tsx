import { useCallback, useEffect, useState } from 'react'
import type { RecentFile } from '@shared/types'
import { runCommand } from '../features/api'
import { openFiles } from '../state/actions'
import { useTabs } from '../state/tabs'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function EmptyState(): JSX.Element {
  const [recent, setRecent] = useState<RecentFile[]>([])
  const refresh = useCallback(() => void window.epdf.listRecent().then(setRecent), [])

  useEffect(() => {
    refresh()
    return window.epdf.on('recent:changed', refresh)
  }, [refresh])

  const open = async (path: string): Promise<void> => {
    const h = await window.epdf.openPath(path)
    if (h) useTabs.getState().addHandles([h])
  }

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto px-6 py-14">
      <h1 className="text-2xl font-semibold">Epdf</h1>
      <p className="mt-2 text-ink-muted">Open a PDF, or drop files anywhere in this window.</p>
      <div className="mt-6 flex gap-2">
        <button className="btn-primary h-10 px-5" onClick={() => void openFiles()}>
          Open PDF…
        </button>
        <button className="btn h-10 px-5" onClick={() => void runCommand('library.open')}>
          Open Library
        </button>
      </div>

      <section aria-labelledby="recent-h" className="mt-10 w-full max-w-xl">
        <div className="flex items-center justify-between">
          <h2 id="recent-h" className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Recent files
          </h2>
          {recent.length > 0 && (
            <button className="text-sm text-accent underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-accent" onClick={() => void window.epdf.clearRecent()}>
              Clear
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <p className="mt-3 text-ink-muted">Files you open will show up here.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {recent.map((r) => (
              <li key={r.path} className="flex items-center">
                <button
                  className="flex min-w-0 flex-1 flex-col items-start px-3 py-2 text-left outline-none hover:bg-surface-alt focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                  onClick={() => void open(r.path)}
                >
                  <span className="max-w-full truncate font-medium">{r.name}</span>
                  <span className="max-w-full truncate text-xs text-ink-muted">
                    {r.path} · {formatSize(r.size)}
                  </span>
                </button>
                <button
                  className="btn-icon mr-1 shrink-0"
                  aria-label={`Remove ${r.name} from recent files`}
                  onClick={() => void window.epdf.removeRecent(r.path)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
