import { activeTab } from '../../state/actions'
import { notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import { registerCommand, registerContextItems, registerDialog, registerPageOverlay, registerPanel, registerTool } from '../api'
import { RedactDialog } from './ApplyDialog'
import { IconApply, IconFind, IconMarkArea, IconMarkText, IconRedactPanel } from './icons'
import { RedactOptions } from './Options'
import { AREA_TOOL, FIND_TOOL, RedactOverlay, TEXT_TOOL } from './overlay'
import { clearSelection, marksFromSelection, selectionGroups } from './pages'
import { REDACT_PANEL, RedactPanel } from './Panel'
import { watchSaves } from './purge'
import { useRedact } from './store'

/**
 * Redaction (docs/features/redact.md): mark text, areas and search hits for permanent removal, review and preview
 * them, then apply as one undo step. The removal itself is pure logic in ./logic (unit-tested in Node).
 */

const GROUP = 'Redact'
const APPLY_TOOL = 'redact-apply'

const ready = (): boolean => activeTab()?.status === 'ready'

function openPanel(): void {
  useWorkspace.getState().setRightPanel(REDACT_PANEL)
}

function openApply(): void {
  const tab = activeTab()
  if (!tab) return
  if ((useRedact.getState().docs[tab.docId]?.marks.length ?? 0) === 0) {
    openPanel()
    notify('info', 'Nothing is marked for redaction yet. Select text, drag an area or use Find and mark.')
    return
  }
  useRedact.getState().openDialog(tab.docId)
}

registerTool({ id: TEXT_TOOL, label: 'Mark text', group: GROUP, order: 500, icon: <IconMarkText />, cursor: 'text', Options: RedactOptions, onActivate: openPanel })
registerTool({ id: AREA_TOOL, label: 'Mark area', group: GROUP, order: 501, icon: <IconMarkArea />, cursor: 'crosshair', Options: RedactOptions, onActivate: openPanel })
registerTool({
  id: FIND_TOOL,
  label: 'Find and mark',
  group: GROUP,
  order: 502,
  icon: <IconFind />,
  Options: RedactOptions,
  onActivate: () => {
    openPanel()
    setTimeout(() => document.querySelector<HTMLElement>('[data-testid="redact-find"] input, [data-testid="redact-find"] select')?.focus(), 50)
  }
})
registerTool({
  id: APPLY_TOOL,
  label: 'Apply redactions…',
  group: GROUP,
  order: 503,
  icon: <IconApply />,
  onActivate: (docId) => {
    // a button, not a mode: open the dialog and leave no tool selected
    queueMicrotask(() => {
      useWorkspace.getState().setActiveTool(null, docId)
      openApply()
    })
  }
})

registerPageOverlay(RedactOverlay)
registerPanel({ id: REDACT_PANEL, label: 'Redaction', icon: <IconRedactPanel />, side: 'right', order: 40, Component: RedactPanel })
registerDialog(RedactDialog)

registerCommand({
  id: 'redact.open',
  label: 'Redact…',
  enabled: ready,
  run: () => {
    const tab = activeTab()
    if (!tab) return
    openPanel()
    useWorkspace.getState().setActiveTool(TEXT_TOOL, tab.docId)
  }
})
registerCommand({ id: 'redact.apply', label: 'Apply Redactions…', enabled: ready, run: openApply })

// ---------------------------------------------------------------- behaviour

/** Marks the text selected on the active document's pages for redaction. */
function markSelection(): void {
  const tab = activeTab()
  if (!tab) return
  const groups = selectionGroups().filter((g) => g.docId === tab.docId)
  if (groups.length === 0) return
  void marksFromSelection(groups).then((marks) => {
    if (marks.length === 0) return
    const s = useRedact.getState()
    s.addMarks(tab.docId, marks)
    clearSelection()
    const text = marks.map((m) => m.text).filter(Boolean).join(' ')
    const msg = marks.length === 1 && marks[0].kind === 'text' ? `Marked “${text.length > 60 ? text.slice(0, 57) + '…' : text}” for redaction.` : `Marked ${marks.length} ${marks.length === 1 ? 'area' : 'areas'} for redaction.`
    s.announce(msg)
    notify('info', msg)
  })
}

/** With "Mark text" active, finishing a text selection on a page marks it. */
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || useWorkspace.getState().activeTool !== TEXT_TOOL) return
  setTimeout(markSelection, 0)
})

// Right-click on selected text: mark it for redaction (it is removed for good when the redactions are applied).
registerContextItems('selection', 40, () => [
  {
    label: 'Mark for redaction',
    run: () => {
      markSelection()
      openPanel()
    }
  }
])

// Escape leaves the mark selection alone but a closed tab drops its marks.
useTabs.subscribe((state, prev) => {
  if (state.tabs.length >= prev.tabs.length) return
  const open = new Set(state.tabs.map((t) => t.docId))
  for (const t of prev.tabs) {
    if (!open.has(t.docId)) {
      useRedact.getState().resetDoc(t.docId)
      useRedact.getState().markPending(t.docId, null)
    }
  }
})

watchSaves()
