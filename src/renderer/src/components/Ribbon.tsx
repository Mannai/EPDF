import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getTools } from '../features/api'
import { toggleSidebar } from '../state/actions'
import type { Tab } from '../state/tabs'
import { useUi } from '../state/ui'
import { useWorkspace } from '../state/workspace'
import { Icon, type IconName } from './Icons'
import { leavingTask, resolveTasks, taskOfTool, type ResolvedTask } from './ribbonTasks'

/** Design icons for known tools (features keep their own icon as the fallback). */
const TOOL_ICONS: Record<string, IconName> = {
  'markup.select': 'select',
  'markup.highlight': 'highlight',
  'markup.underline': 'underline',
  'markup.strikeout': 'strike',
  'markup.squiggly': 'squiggly',
  'markup.note': 'note',
  'markup.textbox': 'textbox',
  'markup.stamp': 'stamp',
  'markup.ink': 'draw',
  'markup.rect': 'rect',
  'markup.ellipse': 'ellipse',
  'markup.line': 'line',
  'markup.arrow': 'arrow',
  'forms.addText': 'text',
  'forms.stampCheck': 'check',
  'forms.stampCross': 'x',
  'forms.stampDot': 'dot',
  'forms.stampDate': 'date',
  'sign.signature': 'signature',
  'links.add': 'link',
  'links.edit': 'rename',
  'formbuilder.text': 'f-text',
  'formbuilder.checkbox': 'f-check',
  'formbuilder.radio': 'f-radio',
  'formbuilder.dropdown': 'f-list'
}

function useTasks(): ResolvedTask[] {
  // Tools are registered once at startup, so this is stable for the life of the window.
  return useMemo(() => resolveTasks(getTools()), [])
}

/** Keeps the showing task in step with the active tool (a tool can be picked from a menu or a shortcut too). */
function useFollowActiveTool(tasks: ResolvedTask[]): string {
  const active = useWorkspace((s) => s.activeTool)
  const task = useUi((s) => s.ribbonTask)
  const setTask = useUi((s) => s.setRibbonTask)
  useEffect(() => {
    // Stay on the showing task if it has the tool (Select is on Draw too); otherwise go to the tool's own task.
    if (tasks.find((t) => t.id === task)?.items.some((i) => i.id === active)) return
    const owner = taskOfTool(tasks, active)
    if (owner && owner.id !== task) setTask(owner.id)
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  return tasks.some((t) => t.id === task) ? task : (tasks[0]?.id ?? '')
}

/** Office-style row under the title bar: side panel toggle, File (the app menu), then one tab per task. */
export function RibbonTabs({ tab }: { tab: Tab | null }): JSX.Element {
  const tasks = useTasks()
  const current = useFollowActiveTool(tasks)
  const setTask = useUi((s) => s.setRibbonTask)
  const sidebarOpen = useUi((s) => s.sidebarOpen)
  const fileRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const ready = tab?.status === 'ready'

  const openFileMenu = (): void => {
    const r = fileRef.current?.getBoundingClientRect()
    // Without an open document, the items that need one are greyed out.
    if (r) void window.epdf.call('chrome:menu', { x: r.left, y: r.bottom + 2, hasDocument: ready })
  }
  /** The user picks a task: a tool or panel of the task being left doesn't come along. */
  const pick = (t: ResolvedTask): void => {
    const ws = useWorkspace.getState()
    const { endTool, closePanel } = leavingTask(tasks.find((x) => x.id === current), t, ws.activeTool, ws.rightPanel)
    if (endTool) ws.setActiveTool(null, tab?.docId)
    if (closePanel) ws.setRightPanel(null)
    setTask(t.id)
  }
  const move = (i: number): void => {
    const t = tasks[(i + tasks.length) % tasks.length]
    pick(t)
    tabRefs.current.get(t.id)?.focus()
  }

  return (
    <div className="flex h-[34px] shrink-0 items-center gap-0.5 bg-chrome px-2.5">
      <button
        type="button"
        className="btn-icon btn-icon-sm me-1.5"
        aria-label="Toggle sidebar"
        aria-pressed={sidebarOpen}
        title="Show or hide the side panel (Ctrl+Shift+B)"
        disabled={!ready}
        onClick={toggleSidebar}
      >
        <Icon name="sidebar" />
      </button>
      <button
        ref={fileRef}
        type="button"
        aria-haspopup="menu"
        className="focus-inset inline-flex h-7 items-center rounded-sm px-2.5 font-semibold text-accent hover:bg-hover"
        onClick={openFileMenu}
      >
        File
      </button>
      {ready && (
        // Toggle buttons rather than ARIA tabs: "tab" is reserved for the open documents (the document tab strip is
        // the window's tablist), so assistive tech and tests find exactly one set of tabs.
        <div role="group" aria-label="Ribbon tasks" className="flex items-center gap-0.5">
          {tasks.map((t, i) => {
            const on = t.id === current
            return (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(t.id, el)
                  else tabRefs.current.delete(t.id)
                }}
                type="button"
                aria-pressed={on}
                aria-controls="ribbon-tools"
                data-task={t.id}
                data-tools={t.items.map((x) => x.id).join(' ')}
                data-tool-labels={t.items.map((x) => x.label).join('|')}
                onClick={() => pick(t)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') move(i + 1)
                  else if (e.key === 'ArrowLeft') move(i - 1)
                  else if (e.key === 'Home') move(0)
                  else if (e.key === 'End') move(tasks.length - 1)
                  else return
                  e.preventDefault()
                }}
                className={`focus-inset relative inline-flex h-7 items-center whitespace-nowrap rounded-sm px-2.5 ${on ? 'font-semibold text-ink' : 'text-ink hover:bg-hover'}`}
              >
                {t.label}
                {on && <span aria-hidden="true" className="absolute inset-x-2.5 bottom-0 h-[3px] rounded-full bg-accent" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Labels first; icons only when the labelled tools don't fit beside the options. Re-measured when the task, the
 * active tool (its options) or the ribbon's width changes.
 */
function useCompact(key: string): { on: boolean; ref: (el: HTMLDivElement | null) => void } {
  const [on, setOn] = useState(false)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.round(el.getBoundingClientRect().width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  // Try labels again whenever something changes, then fall back to icons if they overflow.
  useLayoutEffect(() => setOn(false), [key, width])
  useLayoutEffect(() => {
    if (el && !on && el.scrollWidth > el.clientWidth + 1) setOn(true)
  })
  return { on, ref: setEl }
}

/** A task's tools split by the feature group they came from; tools a task takes by id form a group named after it. */
function groupsOf(task: ResolvedTask): { label: string; items: ResolvedTask['items'] }[] {
  const out: { label: string; items: ResolvedTask['items'] }[] = []
  for (const t of task.items) {
    const label = task.tools?.includes(t.id) || task.shared?.includes(t.id) ? task.label : t.group
    const g = out.find((x) => x.label === label)
    if (g) g.items.push(t)
    else out.push({ label, items: [t] })
  }
  return out
}

/** The simplified ribbon: the current task's tools on one labelled line, and the active tool's options at the end. */
export function Ribbon({ tab }: { tab: Tab }): JSX.Element | null {
  const tasks = useTasks()
  const current = useFollowActiveTool(tasks)
  const active = useWorkspace((s) => s.activeTool)
  const setActive = useWorkspace((s) => s.setActiveTool)
  const task = tasks.find((t) => t.id === current) ?? tasks[0]
  const activeTool = task?.items.find((t) => t.id === active)
  const Options = activeTool?.Options
  const compact = useCompact(`${task?.id}|${activeTool?.id ?? ''}`)
  if (!task || tab.status !== 'ready') return null

  return (
    <div className="shrink-0 bg-chrome px-2 pb-2">
      <div
        id="ribbon-tools"
        role="toolbar"
        aria-label="Editing tools"
        data-compact={compact.on ? 'true' : undefined}
        className="flex h-10 items-center gap-0.5 overflow-hidden rounded-lg border border-black/[.06] bg-surface px-1.5 shadow-1 dark:border-white/[.06]"
      >
        <div ref={compact.ref} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {groupsOf(task).map((g, gi) => (
          <div key={g.label} className="flex min-w-0 items-center gap-0.5">
            {gi > 0 && <span aria-hidden="true" className="toolbar-sep" />}
            {/* One labelled group per feature group (e.g. "Forms" and "Sign" inside Fill & sign). */}
            <div role="group" aria-label={g.label} className="flex min-w-0 items-center gap-0.5">
              {g.items.map((t) => {
                const icon = TOOL_ICONS[t.id]
                return (
                  <button
                    key={t.id}
                    type="button"
                    className="tool"
                    aria-pressed={active === t.id}
                    title={t.label}
                    data-tool={t.id}
                    onClick={() => setActive(active === t.id ? null : t.id, tab.docId)}
                  >
                    {icon ? <Icon name={icon} /> : t.icon}
                    {/* Too many tools for the width: icons only (the label stays the name and the tooltip). */}
                    <span className={compact.on ? 'sr-only' : undefined}>{t.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        </div>
        {Options && (
          <div role="group" aria-label={`${activeTool!.label} options`} className="flex h-6 shrink-0 items-center gap-2 border-s border-line ps-3">
            <Options docId={tab.docId} />
          </div>
        )}
      </div>
    </div>
  )
}
