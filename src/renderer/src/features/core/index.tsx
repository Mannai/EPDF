import { IconThumbnails } from '../../components/Icons'
import { redo, undo } from '../../edit/session'
import { activeTab } from '../../state/actions'
import { initJobs } from '../../state/jobs'
import { Thumbnails } from '../../viewer/Thumbnails'
import { registerCommand, registerDialog, registerPanel } from '../api'
import { handleWindowCloseRequest } from './closeFlow'
import { initRecovery } from './recovery'
import { saveDoc, saveDocAs, saveDocCopy } from './save'
import { VersionHistoryDialog, useVersionHistory } from './VersionHistory'

/**
 * Built-in behaviour that is itself a feature: file commands, undo/redo, the thumbnails panel,
 * autosave + crash recovery, version history and the unsaved-changes guard on window close.
 */

const isTextField = (el: Element | null): boolean =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)

registerCommand({ id: 'file.save', label: 'Save', run: () => void (activeTab() && saveDoc(activeTab()!.docId)) })
registerCommand({ id: 'file.saveAs', label: 'Save As…', run: () => void (activeTab() && saveDocAs(activeTab()!.docId)) })
registerCommand({ id: 'file.saveCopy', label: 'Save a Copy…', run: () => void (activeTab() && saveDocCopy(activeTab()!.docId)) })
registerCommand({
  id: 'file.versionHistory',
  label: 'Version History…',
  run: () => {
    const t = activeTab()
    if (t) useVersionHistory.getState().open(t.docId)
  }
})

// Undo/redo apply to a focused text field first (search box, form input), otherwise to the document.
registerCommand({
  id: 'edit.undo',
  label: 'Undo',
  run: () => {
    if (isTextField(document.activeElement)) return void document.execCommand('undo')
    const t = activeTab()
    if (t) void undo(t.docId) // queued behind any edit still in flight
  }
})
registerCommand({
  id: 'edit.redo',
  label: 'Redo',
  run: () => {
    if (isTextField(document.activeElement)) return void document.execCommand('redo')
    const t = activeTab()
    if (t) void redo(t.docId)
  }
})

registerPanel({ id: 'thumbnails', label: 'Page thumbnails', icon: <IconThumbnails />, side: 'left', order: 0, Component: Thumbnails })
registerDialog(VersionHistoryDialog)

initRecovery()
initJobs()
window.epdf.on('window:closeRequested', () => void handleWindowCloseRequest())
