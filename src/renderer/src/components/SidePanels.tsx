import { getPanel, getPanels } from '../features/api'
import type { Tab } from '../state/tabs'
import { useWorkspace } from '../state/workspace'
import { IconClose } from './Icons'

/** Short switcher labels (the design's "Pages | Bookmarks"); the full label stays the accessible name. */
const SHORT: Record<string, string> = { 'Page thumbnails': 'Pages', Thumbnails: 'Pages' }

/** Left sidebar: the selected panel under a row of text tabs (when several panels are registered). */
export function LeftSidebar({ tab }: { tab: Tab }): JSX.Element | null {
  const panels = getPanels('left')
  const current = useWorkspace((s) => s.leftPanel)
  const setLeft = useWorkspace((s) => s.setLeftPanel)
  if (panels.length === 0) return null
  const active = panels.find((p) => p.id === current) ?? panels[0]
  const Active = active.Component

  return (
    <aside aria-label={panels.length > 1 ? 'Sidebar' : active.label} className="flex shrink-0 flex-col border-e border-line bg-surface-alt" style={{ width: Math.max(active.width ?? 160, 160) }}>
      {panels.length > 1 && (
        // Toggle buttons styled as tabs: ARIA "tab" is reserved for the open documents (see Ribbon.tsx).
        <div role="toolbar" aria-label="Sidebar panels" className="flex h-9 shrink-0 gap-1 border-b border-line px-2">
          {panels.map((p) => {
            const on = p.id === active.id
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                aria-label={p.label}
                title={p.label}
                onClick={() => setLeft(p.id)}
                className={`focus-inset relative inline-flex items-center whitespace-nowrap px-2 ${on ? 'font-semibold text-ink' : 'text-ink-muted hover:text-ink'}`}
              >
                {SHORT[p.label] ?? p.label}
                {on && <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-[3px] rounded-full bg-accent" />}
              </button>
            )
          })}
        </div>
      )}
      <div role={panels.length > 1 ? 'region' : undefined} aria-label={active.label} className="min-h-0 min-w-0 flex-1">
        <Active tab={tab} />
      </div>
    </aside>
  )
}

/** Right sidebar: only visible while a feature has opened one of its panels (comments, bookmarks, ...). */
export function RightSidebar({ tab }: { tab: Tab }): JSX.Element | null {
  const id = useWorkspace((s) => s.rightPanel)
  const setRight = useWorkspace((s) => s.setRightPanel)
  const panel = id ? getPanel(id) : undefined
  if (!panel) return null
  const Panel = panel.Component
  return (
    <aside aria-label={panel.label} className="flex w-72 shrink-0 flex-col border-s border-line bg-surface-alt">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line pe-1.5 ps-3">
        <h2 className="text-title">{panel.label}</h2>
        <button className="btn-icon btn-icon-sm" aria-label={`Close ${panel.label}`} onClick={() => setRight(null)}>
          <IconClose />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Panel tab={tab} />
      </div>
    </aside>
  )
}
