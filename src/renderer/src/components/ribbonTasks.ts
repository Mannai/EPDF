import type { ToolDef } from '../features/api'

/**
 * Ribbon tasks (Windows design v3: "File" plus task tabs above a one-line ribbon). Tools are registered by features
 * with a `group`; a task collects groups (and, for Draw, individual tools out of the Comment group). A group no task
 * claims becomes its own task, named after the group, so a new feature's tools always show up somewhere.
 */
export interface Task {
  id: string
  label: string
  groups: string[]
  /** Tool ids taken from another group into this task. */
  tools?: string[]
  /** Tool ids shown in this task as well as in their own (listed first). */
  shared?: string[]
  /** A right-hand panel that belongs to this task: it closes when the user moves to another task. */
  panel?: string
}

export const TASKS: Task[] = [
  { id: 'comment', label: 'Comment', groups: ['Comment'] },
  // Select is here too: a shape is selected once drawn, and the ribbon should stay on Draw while it is.
  { id: 'draw', label: 'Draw', groups: [], tools: ['markup.ink', 'markup.rect', 'markup.ellipse', 'markup.line', 'markup.arrow'], shared: ['markup.select'] },
  { id: 'edit', label: 'Edit', groups: ['Edit'] },
  { id: 'fill', label: 'Fill & sign', groups: ['Forms', 'Sign'] },
  { id: 'forms', label: 'Links & forms', groups: ['Links', 'Form builder'] },
  { id: 'redact', label: 'Redact', groups: ['Redact'], panel: 'redact.panel' },
  { id: 'pagemarks', label: 'Page marks', groups: ['Page marks', 'headerfooter', 'bates', 'watermark', 'background'] }
]

export interface ResolvedTask extends Task {
  items: ToolDef[]
}

/** Splits the registered tools into tasks, in the order above, keeping each tool's registered order. */
export function resolveTasks(tools: readonly ToolDef[]): ResolvedTask[] {
  const claimed = new Set(TASKS.flatMap((t) => t.tools ?? []))
  const out: ResolvedTask[] = TASKS.map((t) => ({
    ...t,
    items: [
      ...tools.filter((x) => t.shared?.includes(x.id)),
      ...tools.filter((x) => (t.tools?.includes(x.id) ?? false) || (t.groups.includes(x.group) && !claimed.has(x.id)))
    ]
  }))
  const known = new Set(TASKS.flatMap((t) => t.groups))
  for (const x of tools) {
    if (known.has(x.group) || claimed.has(x.id)) continue
    let t = out.find((o) => o.id === `group:${x.group}`)
    if (!t) out.push((t = { id: `group:${x.group}`, label: x.group, groups: [x.group], items: [] }))
    t.items.push(x)
  }
  // A task made only of shared tools has nothing of its own to show.
  return out.filter((t) => t.items.some((i) => !t.shared?.includes(i.id)))
}

/**
 * What moving from task `from` to task `to` should turn off: the active tool when `to` doesn't have it (its button and
 * options would be out of sight while it kept working, e.g. marking text for redaction under the Comment tools), and
 * `from`'s own panel.
 */
export function leavingTask(from: ResolvedTask | undefined, to: ResolvedTask, activeTool: string | null, rightPanel: string | null): { endTool: boolean; closePanel: boolean } {
  return {
    endTool: !!activeTool && !to.items.some((i) => i.id === activeTool),
    closePanel: !!from && from.id !== to.id && !!from.panel && rightPanel === from.panel
  }
}

/** The task a tool lives in (for a shared tool, its own task, not one that also shows it). */
export const taskOfTool = (tasks: ResolvedTask[], toolId: string | null): ResolvedTask | undefined =>
  toolId ? tasks.find((t) => t.items.some((i) => i.id === toolId) && !t.shared?.includes(toolId)) : undefined
