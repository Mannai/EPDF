import { activeTab } from '../../state/actions'
import { useTabs } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import { isEditableTarget } from '../keys'
import { registerCommand, registerContextItems, registerPageOverlay, registerPanel, registerTool } from '../api'
import { CommentsPanel } from './CommentsPanel'
import { createTextMarkup, deleteAnnotByKey } from './actions'
import { useAnnots } from './data'
import {
  COMMENTS_PANEL,
  FilledShapeOptions,
  HighlightOptions,
  InkOptions,
  LineShapeOptions,
  NoteOptions,
  SelectOptions,
  SquigglyOptions,
  StampOptions,
  StrikeoutOptions,
  TextBoxOptions,
  UnderlineOptions
} from './Options'
import { MarkupOverlay } from './Overlay'
import {
  IconArrow,
  IconComments,
  IconEllipse,
  IconHighlight,
  IconInk,
  IconLine,
  IconNote,
  IconRect,
  IconSelect,
  IconSquiggly,
  IconStamp,
  IconStrike,
  IconTextBox,
  IconUnderline
} from './icons'
import { clearSelection, selectionQuads } from './pages'
import { placeDefault, type PlaceKind } from './placement'
import { TOOL, useMarkup, type TextMarkupKind } from './store'

/**
 * Comments and markup: standard PDF annotations (highlight, underline, strikethrough, squiggly, sticky
 * notes, text boxes, drawings, shapes, stamps) plus selecting/editing existing ones and a Comments panel
 * with replies and review status. See docs/features/markup.md.
 */

const GROUP = 'Comment'

registerTool({ id: TOOL.select, label: 'Select', group: GROUP, order: 100, icon: <IconSelect />, cursor: 'default', Options: SelectOptions })
registerTool({ id: TOOL.highlight, label: 'Highlight', group: GROUP, order: 110, icon: <IconHighlight />, Options: HighlightOptions })
registerTool({ id: TOOL.underline, label: 'Underline', group: GROUP, order: 111, icon: <IconUnderline />, Options: UnderlineOptions })
registerTool({ id: TOOL.strikeout, label: 'Strikethrough', group: GROUP, order: 112, icon: <IconStrike />, Options: StrikeoutOptions })
registerTool({ id: TOOL.squiggly, label: 'Squiggly', group: GROUP, order: 113, icon: <IconSquiggly />, Options: SquigglyOptions })
registerTool({ id: TOOL.note, label: 'Sticky note', group: GROUP, order: 120, icon: <IconNote />, cursor: 'crosshair', Options: NoteOptions })
registerTool({ id: TOOL.textbox, label: 'Text box', group: GROUP, order: 130, icon: <IconTextBox />, cursor: 'crosshair', Options: TextBoxOptions })
registerTool({ id: TOOL.ink, label: 'Draw', group: GROUP, order: 140, icon: <IconInk />, cursor: 'crosshair', Options: InkOptions })
registerTool({ id: TOOL.rect, label: 'Rectangle', group: GROUP, order: 150, icon: <IconRect />, cursor: 'crosshair', Options: FilledShapeOptions })
registerTool({ id: TOOL.ellipse, label: 'Ellipse', group: GROUP, order: 151, icon: <IconEllipse />, cursor: 'crosshair', Options: FilledShapeOptions })
registerTool({ id: TOOL.line, label: 'Line', group: GROUP, order: 152, icon: <IconLine />, cursor: 'crosshair', Options: LineShapeOptions })
registerTool({ id: TOOL.arrow, label: 'Arrow', group: GROUP, order: 153, icon: <IconArrow />, cursor: 'crosshair', Options: LineShapeOptions })
registerTool({ id: TOOL.stamp, label: 'Stamp', group: GROUP, order: 160, icon: <IconStamp />, cursor: 'copy', Options: StampOptions })

registerPageOverlay(MarkupOverlay)
registerPanel({ id: COMMENTS_PANEL, label: 'Comments', icon: <IconComments />, side: 'right', order: 10, Component: CommentsPanel })

// ---------------------------------------------------------------- commands and shortcuts

const TEXT_TOOLS: Record<string, TextMarkupKind> = {
  [TOOL.highlight]: 'highlight',
  [TOOL.underline]: 'underline',
  [TOOL.strikeout]: 'strikeout',
  [TOOL.squiggly]: 'squiggly'
}

const PLACE_TOOLS: Record<string, PlaceKind> = {
  [TOOL.note]: 'note',
  [TOOL.textbox]: 'textbox',
  [TOOL.stamp]: 'stamp',
  [TOOL.rect]: 'rect',
  [TOOL.ellipse]: 'ellipse',
  [TOOL.line]: 'line',
  [TOOL.arrow]: 'arrow'
}

/** Marks up whatever text is currently selected on the pages. Resolves false when nothing usable is selected. */
async function markupSelection(kind: TextMarkupKind): Promise<boolean> {
  const groups = selectionQuads()
  if (groups.length === 0) return false
  const docId = groups[0].docId
  const ok = await createTextMarkup(docId, kind, groups.filter((g) => g.docId === docId))
  clearSelection()
  return ok
}

function toggleTool(toolId: string): void {
  const kind = TEXT_TOOLS[toolId]
  // With text already selected, the text-markup shortcuts apply straight away (no tool needed).
  if (kind && selectionQuads().length > 0) {
    void markupSelection(kind)
    return
  }
  const ws = useWorkspace.getState()
  ws.setActiveTool(ws.activeTool === toolId ? null : toolId, activeTab()?.docId)
}

const hasDoc = (): boolean => activeTab()?.status === 'ready'

const TOOL_COMMANDS: { tool: string; id: string; label: string; shortcut?: string }[] = [
  { tool: TOOL.select, id: 'markup.tool.select', label: 'Select Annotation Tool', shortcut: 'v' },
  { tool: TOOL.highlight, id: 'markup.tool.highlight', label: 'Highlight Text', shortcut: 'h' },
  { tool: TOOL.underline, id: 'markup.tool.underline', label: 'Underline Text', shortcut: 'u' },
  { tool: TOOL.strikeout, id: 'markup.tool.strikeout', label: 'Strikethrough Text', shortcut: 'k' },
  { tool: TOOL.squiggly, id: 'markup.tool.squiggly', label: 'Squiggly Underline Text' },
  { tool: TOOL.note, id: 'markup.tool.note', label: 'Sticky Note Tool', shortcut: 'n' },
  { tool: TOOL.textbox, id: 'markup.tool.textbox', label: 'Text Box Tool', shortcut: 't' },
  { tool: TOOL.ink, id: 'markup.tool.ink', label: 'Draw Tool', shortcut: 'd' },
  { tool: TOOL.rect, id: 'markup.tool.rect', label: 'Rectangle Tool', shortcut: 'r' },
  { tool: TOOL.ellipse, id: 'markup.tool.ellipse', label: 'Ellipse Tool', shortcut: 'o' },
  { tool: TOOL.line, id: 'markup.tool.line', label: 'Line Tool', shortcut: 'l' },
  { tool: TOOL.arrow, id: 'markup.tool.arrow', label: 'Arrow Tool', shortcut: 'a' },
  { tool: TOOL.stamp, id: 'markup.tool.stamp', label: 'Stamp Tool', shortcut: 'p' }
]
for (const c of TOOL_COMMANDS) registerCommand({ id: c.id, label: c.label, shortcut: c.shortcut, enabled: hasDoc, run: () => toggleTool(c.tool) })

registerCommand({
  id: 'markup.toggleComments',
  label: 'Comments Panel',
  shortcut: 'mod+alt+m',
  run: () => useWorkspace.getState().toggleRightPanel(COMMENTS_PANEL)
})
registerCommand({ id: 'markup.addNote', label: 'Add Sticky Note to Current Page', enabled: hasDoc, run: () => placeDefault('note') })

// Right-click: mark up the selected text straight away; add a note to the page.
registerContextItems('selection', 10, () => [
  { label: 'Highlight', run: () => void markupSelection('highlight') },
  { label: 'Underline', run: () => void markupSelection('underline') },
  { label: 'Strikethrough', run: () => void markupSelection('strikeout') },
  { label: 'Squiggly underline', run: () => void markupSelection('squiggly') }
])
registerContextItems('page', 20, () => [{ label: 'Add sticky note', command: 'markup.addNote' }])

// ---------------------------------------------------------------- global behaviour

/** With a text-markup tool active, finishing a text selection on a page marks it up. */
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return // a right-click on the selection opens the menu instead
  const kind = TEXT_TOOLS[useWorkspace.getState().activeTool ?? '']
  if (!kind) return
  setTimeout(() => void markupSelection(kind), 0) // let the browser finalize the selection
})

const inViewer = (t: EventTarget | null): boolean =>
  t === document.body || (t instanceof Element && !!t.closest('[data-testid="viewer-scroll"]'))

window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
  const tab = activeTab()
  if (!tab) return
  const state = useMarkup.getState()
  const sel = state.selection

  if ((e.key === 'Delete' || e.key === 'Backspace') && sel && sel.docId === tab.docId && inViewer(e.target)) {
    const a = useAnnots.getState().byDoc[sel.docId]?.annots.find((x) => x.id === sel.id)
    if (a) {
      e.preventDefault()
      void deleteAnnotByKey(sel.docId, a)
    }
  } else if (e.key === 'Escape' && sel) {
    state.select(sel.docId, null)
  } else if (e.key === 'Enter' && !e.shiftKey && inViewer(e.target)) {
    const place = PLACE_TOOLS[useWorkspace.getState().activeTool ?? '']
    if (place && !state.draft) {
      e.preventDefault()
      void placeDefault(place)
    }
  }
})

// Clicking outside the selected item confirms it: on the page that is the Select layer's job; on the grey area around
// the pages it happens here.
window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !useMarkup.getState().selection) return
  const t = e.target instanceof Element ? e.target : null
  if (t?.closest('[data-testid="viewer-scroll"]') && !t.closest('.epdf-page')) {
    const sel = useMarkup.getState().selection!
    useMarkup.getState().select(sel.docId, null)
  }
})

// A selection that no longer exists (undo of its creation, deleted elsewhere) is dropped.
useAnnots.subscribe((s) => {
  const sel = useMarkup.getState().selection
  if (!sel) return
  const data = s.byDoc[sel.docId]
  if (data && !data.annots.some((a) => a.id === sel.id)) useMarkup.getState().select(sel.docId, null)
})
useTabs.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) {
    useMarkup.getState().setDraft(null)
    useMarkup.getState().select(prev.activeId ?? '', null)
  }
})

// Default author: the OS user name (main), unless the user stored their own.
void window.epdf
  .call<string>('markup:defaultAuthor', {})
  .then((name) => useMarkup.getState().setSystemAuthor(name))
  .catch(() => undefined)
