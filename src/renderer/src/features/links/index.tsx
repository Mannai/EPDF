import { activeTab } from '../../state/actions'
import { notify } from '../../state/notify'
import { useTabs } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import { registerCommand, registerContextItems, registerDialog, registerPageOverlay, registerTool } from '../api'
import { removeLinksAction } from './actions'
import { announce, unlock } from './common'
import { DetectDialogHost, LinkDialogHost } from './Dialogs'
import { IconAddLink, IconEditLinks } from './icons'
import { AddLinkOptions, EditLinkOptions } from './Options'
import { LinksOverlay, newLinkForm } from './Overlay'
import { clearSelection, defaultRegion, selectionRegions } from './pages'
import { checkUrl } from './pdf/url'
import { LINK_TOOL, useLinkUi } from './store'

/**
 * Links: real PDF link annotations (web addresses, e-mail, phone numbers, pages, named destinations) that other
 * readers honour. Tools: Add link (draw a box, or link the selected text) and Edit links (select, move, resize,
 * retarget, restyle, delete; links from other software included). Also: find addresses in the text and turn them
 * into links, remove all links, and a highlight of every link. The PDF logic lives in ./pdf (pure pdf-lib).
 * See docs/features/links-bookmarks.md.
 */

const GROUP = 'Links'

registerTool({
  id: LINK_TOOL.add,
  label: 'Add link',
  group: GROUP,
  order: 600,
  icon: <IconAddLink />,
  cursor: 'crosshair',
  Options: AddLinkOptions,
  onActivate: (docId) => void unlock(docId)
})
registerTool({
  id: LINK_TOOL.edit,
  label: 'Edit links',
  group: GROUP,
  order: 610,
  icon: <IconEditLinks />,
  cursor: 'default',
  Options: EditLinkOptions,
  onActivate: (docId) => void unlock(docId),
  onDeactivate: () => useLinkUi.getState().select('', null)
})

registerPageOverlay(LinksOverlay)
registerDialog(LinkDialogHost)
registerDialog(DetectDialogHost)

const hasDoc = (): boolean => activeTab()?.status === 'ready'
const toggleTool = (tool: string): void => {
  const ws = useWorkspace.getState()
  ws.setActiveTool(ws.activeTool === tool ? null : tool, activeTab()?.docId)
}

registerCommand({ id: 'links.tool.add', label: 'Add Link Tool', enabled: hasDoc, run: () => toggleTool(LINK_TOOL.add) })
registerCommand({ id: 'links.tool.edit', label: 'Edit Links Tool', enabled: hasDoc, run: () => toggleTool(LINK_TOOL.edit) })

registerCommand({
  id: 'links.fromSelection',
  label: 'Link from Selected Text',
  shortcut: 'mod+alt+k',
  enabled: hasDoc,
  run: async () => {
    const sel = selectionRegions()
    if (!sel) {
      notify('info', 'Select some text on a page first, then choose Link from Selected Text.')
      return
    }
    if (!(await unlock(sel.docId))) return
    const check = checkUrl(sel.text)
    useLinkUi.getState().openDialog({ mode: 'create', docId: sel.docId, regions: sel.regions }, newLinkForm(sel.regions[0].pageIndex, check.ok ? { uri: sel.text } : {}))
    clearSelection()
  }
})

registerCommand({
  id: 'links.addHere',
  label: 'Add Link on Current Page',
  enabled: hasDoc,
  run: async () => {
    const t = activeTab()
    if (!t) return
    if (!(await unlock(t.docId))) return
    const region = defaultRegion(t.docId, t.view.page - 1)
    if (!region) {
      announce('The page is not ready yet. Try again in a moment.')
      return
    }
    useLinkUi.getState().openDialog({ mode: 'create', docId: t.docId, regions: [region] }, newLinkForm(t.view.page - 1))
  }
})

// Right-click: link the selected text; add a link on the page that was clicked.
registerContextItems('selection', 30, () => [{ label: 'Link selected text…', command: 'links.fromSelection', keys: 'Ctrl+Alt+K' }])
registerContextItems('page', 30, (at) => [
  {
    label: 'Add link here…',
    run: async () => {
      if (!(await unlock(at.docId))) return
      const region = defaultRegion(at.docId, at.pageIndex)
      if (!region) return announce('The page is not ready yet. Try again in a moment.')
      useLinkUi.getState().openDialog({ mode: 'create', docId: at.docId, regions: [region] }, newLinkForm(at.pageIndex))
    }
  }
])

registerCommand({
  id: 'links.detect',
  label: 'Find Web and E-mail Addresses…',
  enabled: hasDoc,
  run: () => {
    const t = activeTab()
    if (t) useLinkUi.getState().openDetect(t.docId)
  }
})
registerCommand({
  id: 'links.removePage',
  label: 'Remove Links from Current Page',
  enabled: hasDoc,
  run: async () => {
    const t = activeTab()
    if (t && (await unlock(t.docId))) await removeLinksAction(t.docId, t.view.page - 1)
  }
})
registerCommand({
  id: 'links.removeAll',
  label: 'Remove All Links…',
  enabled: hasDoc,
  run: async () => {
    const t = activeTab()
    if (t && (await unlock(t.docId))) await removeLinksAction(t.docId)
  }
})
registerCommand({
  id: 'links.toggleHighlight',
  label: 'Highlight Links',
  enabled: hasDoc,
  run: () => {
    const ui = useLinkUi.getState()
    ui.setHighlight(!ui.highlight)
    announce(ui.highlight ? 'Links are no longer highlighted' : 'All links are highlighted')
  }
})

// ---------------------------------------------------------------- global behaviour

// Escape while choosing a target position goes back to the dialog.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && useLinkUi.getState().picking) {
      e.preventDefault()
      e.stopPropagation()
      useLinkUi.getState().setPicking(false)
    }
  },
  true
)

// A dialog or selection that belongs to a tab that is no longer active is dropped.
useTabs.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) {
    const ui = useLinkUi.getState()
    if (ui.dialog) ui.closeDialog()
    ui.select('', null)
  }
})
