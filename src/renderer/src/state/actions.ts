import type { MenuAction, ViewMode, ZoomMode } from '@shared/types'
import { isDirty, reloadFromDisk } from '../edit/session'
import { runCommand } from '../features/api'
import { closeTabInteractive } from '../features/core/closeFlow'
import { flushRecovery } from '../features/core/recovery'
import { nextZoomStep } from '../viewer/layout'
import { askConfirm } from './confirm'
import { useSearch } from './search'
import { selectActiveTab, useTabs, type Tab } from './tabs'
import { useUi } from './ui'

export const activeTab = (): Tab | undefined => selectActiveTab(useTabs.getState())

export async function openFiles(): Promise<void> {
  const handles = await window.epdf.openDialog(true)
  if (handles.length) useTabs.getState().addHandles(handles)
}

export function zoomStep(dir: 1 | -1): void {
  const t = activeTab()
  if (t) useTabs.getState().patchView(t.docId, { zoomMode: 'custom', zoom: nextZoomStep(t.view.zoom, dir) })
}

export function setZoomMode(mode: ZoomMode, zoom?: number): void {
  const t = activeTab()
  if (!t) return
  useTabs.getState().patchView(t.docId, zoom == null ? { zoomMode: mode } : { zoomMode: mode, zoom })
}

export function setViewMode(mode: ViewMode): void {
  const t = activeTab()
  if (!t) return
  const s = useTabs.getState()
  s.patchView(t.docId, { viewMode: mode })
  s.goToPage(t.docId, t.view.page) // re-anchor on the current page after the layout changes
}

export function pageBy(delta: number): void {
  const t = activeTab()
  if (t) useTabs.getState().goToPage(t.docId, t.view.page + delta)
}

export function pageTo(page: number | 'last'): void {
  const t = activeTab()
  if (t) useTabs.getState().goToPage(t.docId, page === 'last' ? t.numPages : page)
}

export function toggleSidebar(): void {
  const ui = useUi.getState()
  const next = !ui.sidebarOpen
  ui.setSidebarOpen(next)
  void window.epdf.setSetting({ key: 'sidebarOpen', value: next })
}

export function openSearch(): void {
  useSearch.getState().setOpen(true)
  document.dispatchEvent(new Event('epdf:focus-search'))
}

export function stepSearch(dir: 1 | -1): void {
  const s = useSearch.getState()
  if (!s.open) return openSearch()
  s.step(dir)
}

export async function detachActiveTab(): Promise<void> {
  const t = activeTab()
  if (!t) return
  // Unsaved edits travel through the recovery folder; the new window restores them automatically.
  await flushRecovery(t.docId)
  await window.epdf.detachTab({ docId: t.docId, view: t.view })
  useTabs.getState().closeTab(t.docId)
}

/** Reloads the active tab from disk, confirming first if that would throw away unsaved edits. */
async function reloadActiveTab(): Promise<void> {
  const t = activeTab()
  if (!t) return
  if (isDirty(t.docId)) {
    const choice = await askConfirm({
      title: 'Discard unsaved changes?',
      message: `Reloading “${t.name}” from disk will discard your unsaved changes.`,
      buttons: [
        { label: 'Discard and Reload', value: 'reload', variant: 'danger' },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    })
    if (choice !== 'reload') return
  }
  reloadFromDisk(t.docId)
}

export function runMenuAction(a: MenuAction): void {
  const s = useTabs.getState()
  const t = activeTab()
  switch (a.type) {
    case 'command':
      return void runCommand(a.id)
    case 'open':
      return void openFiles()
    case 'close-tab':
      return t ? void closeTabInteractive(t.docId) : window.close()
    case 'next-tab':
      return s.cycle(1)
    case 'prev-tab':
      return s.cycle(-1)
    case 'find':
      return openSearch()
    case 'find-next':
      return stepSearch(1)
    case 'find-prev':
      return stepSearch(-1)
    case 'zoom-in':
      return zoomStep(1)
    case 'zoom-out':
      return zoomStep(-1)
    case 'zoom-actual':
      return setZoomMode('custom', 1)
    case 'fit-width':
      return setZoomMode('fit-width')
    case 'fit-page':
      return setZoomMode('fit-page')
    case 'view-mode':
      return setViewMode(a.mode)
    case 'toggle-sidebar':
      return toggleSidebar()
    case 'page-next':
      return pageBy(t ? columnsStep(t) : 1)
    case 'page-prev':
      return pageBy(t ? -columnsStep(t) : -1)
    case 'page-first':
      return pageTo(1)
    case 'page-last':
      return pageTo('last')
    case 'goto-page':
      return useUi.getState().setGoToPageOpen(true)
    case 'detach-tab':
      return void detachActiveTab()
    case 'reload':
      return void reloadActiveTab()
  }
}

const columnsStep = (t: Tab): number => (t.view.viewMode === 'two' ? 2 : 1)
