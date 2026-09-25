import { useRef, useState } from 'react'
import { useEdits } from '../edit/session'
import { closeTabInteractive } from '../features/core/closeFlow'
import { useTabs } from '../state/tabs'
import { openFiles } from '../state/actions'
import { IconClose, IconPlus } from './Icons'

const TAB_MIME = 'application/x-epdf-tab'

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
    <div className="flex h-9 shrink-0 items-end gap-0.5 border-b border-line bg-surface-alt px-2">
      <div role="tablist" aria-label="Open documents" className="flex min-w-0 items-end gap-0.5 overflow-x-auto">
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
              className={`group relative flex h-8 max-w-56 min-w-28 shrink-0 cursor-default items-center gap-1 rounded-t-md border border-b-0 pl-3 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                active ? 'border-line bg-surface text-ink' : 'border-transparent text-ink-muted hover:bg-surface/60'
              }`}
            >
              {dropIndex === i && <span className="absolute -left-px top-1 bottom-1 w-0.5 bg-accent" />}
              {dropIndex === i + 1 && i === tabs.length - 1 && <span className="absolute -right-px top-1 bottom-1 w-0.5 bg-accent" />}
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
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-line/60"
              >
                <IconClose />
              </span>
            </div>
          )
        })}
      </div>
      <button type="button" className="btn-icon mb-0.5 shrink-0" aria-label="Open PDF" title="Open PDF (Ctrl+O)" onClick={() => void openFiles()}>
        <IconPlus />
      </button>
    </div>
  )
}
