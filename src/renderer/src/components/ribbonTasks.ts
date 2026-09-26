import type { ToolDef } from '../features/api'
import type { IconName } from './Icons'

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
}

export const TASKS: Task[] = [
  { id: 'comment', label: 'Comment', groups: ['Comment'] },
  { id: 'draw', label: 'Draw', groups: [], tools: ['markup.ink', 'markup.rect', 'markup.ellipse', 'markup.line', 'markup.arrow'] },
  { id: 'edit', label: 'Edit', groups: ['Edit'] },
  { id: 'fill', label: 'Fill & sign', groups: ['Forms', 'Sign'] },
  { id: 'forms', label: 'Links & forms', groups: ['Links', 'Form builder'] },
  { id: 'redact', label: 'Redact', groups: ['Redact'] },
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
    items: tools.filter((x) => (t.tools?.includes(x.id) ?? false) || (t.groups.includes(x.group) && !claimed.has(x.id)))
  }))
  const known = new Set(TASKS.flatMap((t) => t.groups))
  for (const x of tools) {
    if (known.has(x.group) || claimed.has(x.id)) continue
    let t = out.find((o) => o.id === `group:${x.group}`)
    if (!t) out.push((t = { id: `group:${x.group}`, label: x.group, groups: [x.group], items: [] }))
    t.items.push(x)
  }
  return out.filter((t) => t.items.length > 0)
}

export const taskOfTool = (tasks: ResolvedTask[], toolId: string | null): ResolvedTask | undefined =>
  toolId ? tasks.find((t) => t.items.some((i) => i.id === toolId)) : undefined

/** Design icons for known tools (features keep their own icon as the fallback). */
export const TOOL_ICONS: Record<string, IconName> = {
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
