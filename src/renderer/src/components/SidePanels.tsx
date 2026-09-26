import { getPanel, getPanels } from '../features/api'
import type { Tab } from '../state/tabs'
import { useWorkspace } from '../state/workspace'
import { IconClose } from './Icons'

/** Left sidebar: shows the selected panel, with an icon strip to switch when several are registered. */
export function LeftSidebar({ tab }: { tab: Tab }): JSX.Element | null {
  const panels = getPanels('left')
  const current = useWorkspace((s) => s.leftPanel)
  const setLeft = useWorkspace((s) => s.setLeftPanel)
  if (panels.length === 0) return null
  const active = panels.find((p) => p.id === current) ?? panels[0]
  const Active = active.Component

  return (
    <aside aria-label={panels.length > 1 ? 'Sidebar' : active.label} className="flex shrink-0 border-r border-line bg-surface-alt">
      {panels.length > 1 && (
        <div role="tablist" aria-label="Sidebar panels" aria-orientation="vertical" className="flex w-10 flex-col items-center gap-1 border-r border-line py-2">
          {panels.map((p) => (
            <button
              key={p.id}
              role="tab"
              type="button"
              aria-selected={p.id === active.id}
              aria-label={p.label}
              title={p.label}
              onClick={() => setLeft(p.id)}
              className="btn-icon aria-selected:bg-accent/20 aria-selected:ring-1 aria-selected:ring-accent"
            >
              {p.icon}
            </button>
          ))}
        </div>
      )}
      <div role={panels.length > 1 ? 'tabpanel' : undefined} aria-label={active.label} className="min-w-0" style={{ width: active.width ?? 160 }}>
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
    <aside aria-label={panel.label} className="flex w-72 shrink-0 flex-col border-l border-line bg-surface-alt">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-sm font-semibold">{panel.label}</h2>
        <button className="btn-icon" aria-label={`Close ${panel.label}`} onClick={() => setRight(null)}>
          <IconClose />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Panel tab={tab} />
      </div>
    </aside>
  )
}
