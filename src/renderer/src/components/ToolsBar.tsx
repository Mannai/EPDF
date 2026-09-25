import { getTools } from '../features/api'
import type { Tab } from '../state/tabs'
import { useWorkspace } from '../state/workspace'

/** The editing ribbon: one button per registered tool, grouped, plus the active tool's own options. */
export function ToolsBar({ tab }: { tab: Tab }): JSX.Element | null {
  const active = useWorkspace((s) => s.activeTool)
  const setActive = useWorkspace((s) => s.setActiveTool)
  const tools = getTools()
  if (tools.length === 0 || tab.status !== 'ready') return null

  const groups: { name: string; items: typeof tools[number][] }[] = []
  for (const t of tools) {
    const g = groups.find((x) => x.name === t.group)
    if (g) g.items.push(t)
    else groups.push({ name: t.group, items: [t] })
  }
  const activeTool = tools.find((t) => t.id === active)
  const Options = activeTool?.Options

  return (
    <div role="toolbar" aria-label="Editing tools" className="flex min-h-10 shrink-0 items-center gap-3 overflow-x-auto border-b border-line bg-surface-alt px-2 py-1">
      {groups.map((g) => (
        <div key={g.name} role="group" aria-label={g.name} className="flex items-center gap-0.5">
          {g.items.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={active === t.id}
              title={t.label}
              data-tool={t.id}
              onClick={() => setActive(active === t.id ? null : t.id, tab.docId)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-ink outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent aria-pressed:bg-accent/15 aria-pressed:text-accent"
            >
              {t.icon}
              <span className="text-xs">{t.label}</span>
            </button>
          ))}
        </div>
      ))}
      {Options && (
        <div role="group" aria-label={`${activeTool!.label} options`} className="ml-auto flex items-center gap-2 border-l border-line pl-3">
          <Options docId={tab.docId} />
        </div>
      )}
    </div>
  )
}
