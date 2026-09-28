import { useRef, useState } from 'react'
import { useEdits } from '../edit/session'
import { closeTabInteractive } from '../features/core/closeFlow'
import { SHOW_IN_FILE_MANAGER, shortcutLabel } from '../features/keys'
import { useTabs } from '../state/tabs'
import { detachActiveTab, openFiles } from '../state/actions'
import { openContextMenu, type ContextItem } from './contextMenu'
import { Icon } from './Icons'

const TAB_MIME = 'application/x-epdf-tab'

/** Closes documents one after another, each asking about unsaved changes; stops if the user cancels one. */
async function closeAll(ids: string[]): Promise<void> {
  for (const id of ids) if (!(await closeTabInteractive(id))) return
}

/** Right-click on a document tab. */
function tabMenu(docId: string, path: string): ContextItem[] {
  const { tabs } = useTabs.getState()
  const i = tabs.findIndex((t) => t.docId === docId)
  const others = tabs.filter((t) => t.docId !== docId).map((t) => t.docId)
  const right = tabs.slice(i + 1).map((t) => t.docId)
  return [
    { label: 'Close', keys: 'Ctrl+W', run: () => void closeTabInteractive(docId) },
    { label: 'Close other tabs', enabled: others.length > 0, run: () => closeAll(others) },
    { label: 'Close tabs to the right', enabled: right.length > 0, run: () => closeAll(right) },
    { type: 'separator' },
    {
      label: 'Move to new window',
      enabled: tabs.length > 1,
      run: () => {
        useTabs.getState().setActive(docId)
        return detachActiveTab()
      }
    },
    { type: 'separator' },
    { label: SHOW_IN_FILE_MANAGER, run: () => void window.epdf.revealDoc(docId) },
    { label: 'Copy file path', run: () => navigator.clipboard.writeText(path) }
  ]
}

export function TabBar(): JSX.Element {
  const tabs = useTabs((s) => s.tabs)
  const activeId = useTabs((s) => s.activeId)
  const setActive = useTabs((s) => s.setActive)
  const closeTab = (docId: string): void => void closeTabInteractive(docId) // asks first if unsaved
  const moveTab = useTabs((s) => s.moveTab)
  const edits = useEdits()
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const refs = useRef(new Map<string, HTMLDivElement>())

  const focusTab = (id: string): void => {
    setActive(id)
    refs.current.get(id)?.focus()
  }

  // WAI-ARIA tabs pattern: roving tabindex, arrows move+activate, Home/End jump, Delete closes.
  const onKeyDown = (e: React.KeyboardEvent, i: number): void => {
    const n = tabs.length
    if (e.key === 'ArrowRight') focusTab(tabs[(i + 1) % n].docId)
    else if (e.key === 'ArrowLeft') focusTab(tabs[(i - 1 + n) % n].docId)
    else if (e.key === 'Home') focusTab(tabs[0].docId)
    else if (e.key === 'End') focusTab(tabs[n - 1].docId)
    else if (e.key === 'Delete') closeTab(tabs[i].docId)
    else return
    e.preventDefault()
  }

  return (
    // Lives in the title bar: tabs sit on its bottom edge, like browser and Office document tabs.
    <div className="flex min-w-0 shrink items-end gap-0.5 self-end">
      <div role="tablist" aria-label="Open documents" className="flex min-w-0 items-end gap-0.5 overflow-hidden">
        {tabs.map((t, i) => {
          const active = t.docId === activeId
          return (
            // A tab may not contain focusable controls, and a tablist may only contain tabs
            // (WCAG 4.1.2). So the ✕ is a mouse-only affordance hidden from assistive tech; the
            // keyboard equivalents are Delete on the focused tab and Ctrl+W (File ▸ Close Tab).
            <div
              key={t.docId}
              ref={(el) => {
                if (el) refs.current.set(t.docId, el)
                else refs.current.delete(t.docId)
              }}
              role="tab"
              id={`tab-${t.docId}`}
              aria-selected={active}
              aria-controls="doc-panel"
              aria-keyshortcuts="Delete"
              tabIndex={active ? 0 : -1}
              title={t.path}
              draggable
              onClick={() => setActive(t.docId)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onContextMenu={(e) => void openContextMenu(e, tabMenu(t.docId, t.path))}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(t.docId)
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, t.docId)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(TAB_MIME)) return
                e.preventDefault()
                e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                setDropIndex(e.clientX < r.left + r.width / 2 ? i : i + 1)
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(TAB_MIME)
                if (!id) return // a file drop: let the window-level handler open it
                e.preventDefault()
                e.stopPropagation()
                const from = tabs.findIndex((x) => x.docId === id)
                if (dropIndex != null) moveTab(id, dropIndex > from ? dropIndex - 1 : dropIndex)
                setDropIndex(null)
              }}
              onDragEnd={() => setDropIndex(null)}
              className={`focus-inset group relative flex h-8 min-w-28 max-w-56 shrink cursor-default items-center gap-2 rounded-t-lg pe-1 ps-3 ${
                active ? 'bg-surface text-ink shadow-[0_0_0_1px_rgb(0_0_0/.06)] dark:shadow-[0_0_0_1px_rgb(255_255_255/.06)]' : 'text-ink-muted hover:bg-hover'
              }`}
            >
              {dropIndex === i && <span className="absolute -left-px bottom-1 top-1 w-0.5 bg-accent" />}
              {dropIndex === i + 1 && i === tabs.length - 1 && <span className="absolute -right-px bottom-1 top-1 w-0.5 bg-accent" />}
              <Icon name="file" size={14} className="shrink-0 text-danger" />
              <span className="min-w-0 flex-1 truncate">
                {t.name}
                {edits[t.docId]?.dirty && (
                  <>
                    <span aria-hidden="true" className="ml-1 text-accent" data-testid="unsaved-dot">
                      ●
                    </span>
                    <span className="sr-only"> (unsaved changes)</span>
                  </>
                )}
              </span>
              <span
                aria-hidden="true"
                data-close={t.name}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.docId)
                }}
                className="app-no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-hover hover:text-ink"
              >
                <Icon name="x" size={12} />
              </span>
            </div>
          )
        })}
      </div>
      <button type="button" className="btn-icon btn-icon-sm mb-0.5 shrink-0" aria-label="Open PDF" title={`Open PDF (${shortcutLabel('Ctrl+O')})`} onClick={() => void openFiles()}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  )
}
