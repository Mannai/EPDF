import { describe, expect, it } from 'vitest'
import type { ToolDef } from '../../src/renderer/src/features/api'
import { leavingTask, resolveTasks, taskOfTool } from '../../src/renderer/src/components/ribbonTasks'

const tool = (id: string, group: string): ToolDef => ({ id, label: id, group, icon: null }) as unknown as ToolDef

const TOOLS = [
  tool('markup.select', 'Comment'),
  tool('markup.highlight', 'Comment'),
  tool('markup.rect', 'Comment'),
  tool('redact-text', 'Redact'),
  tool('redact-area', 'Redact'),
  tool('my.tool', 'Mine')
]

describe('ribbon tasks', () => {
  const tasks = resolveTasks(TOOLS)
  const byId = (id: string) => tasks.find((t) => t.id === id)!

  it('drops a task that would only hold shared tools', () => {
    expect(resolveTasks([tool('markup.select', 'Comment')]).map((t) => t.id)).toEqual(['comment'])
  })

  it('splits tools into tasks, moves the shape tools to Draw, and gives an unknown group its own task', () => {
    expect(tasks.map((t) => [t.id, t.items.map((i) => i.id)])).toEqual([
      ['comment', ['markup.select', 'markup.highlight']],
      ['draw', ['markup.select', 'markup.rect']], // Select is shared with Draw
      ['redact', ['redact-text', 'redact-area']],
      ['group:Mine', ['my.tool']]
    ])
    expect(taskOfTool(tasks, 'redact-area')?.id).toBe('redact')
    expect(taskOfTool(tasks, 'markup.select')?.id).toBe('comment') // its own task, not the one sharing it
    expect(taskOfTool(tasks, null)).toBeUndefined()
  })

  it('leaving Redact for Comment ends the redaction tool and closes the Redaction panel', () => {
    expect(leavingTask(byId('redact'), byId('comment'), 'redact-text', 'redact.panel')).toEqual({ endTool: true, closePanel: true })
  })

  it('keeps a tool the new task has, and panels that belong to no task being left', () => {
    expect(leavingTask(byId('comment'), byId('comment'), 'markup.highlight', 'redact.panel')).toEqual({ endTool: false, closePanel: false })
    // Comments panel open while moving from Comment to Draw: Comment owns no panel, so it stays.
    expect(leavingTask(byId('comment'), byId('draw'), 'markup.highlight', 'markup.comments')).toEqual({ endTool: true, closePanel: false })
    // Select is on both, so it survives the move.
    expect(leavingTask(byId('comment'), byId('draw'), 'markup.select', null)).toEqual({ endTool: false, closePanel: false })
    expect(leavingTask(byId('redact'), byId('draw'), null, 'markup.comments')).toEqual({ endTool: false, closePanel: false })
  })
})
