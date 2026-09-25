import { useEffect, useState } from 'react'
import type { ViewMode } from '@shared/types'
import { useEditInfo } from '../edit/session'
import { runCommand } from '../features/api'
import { openFiles, openSearch, pageBy, setViewMode, setZoomMode, toggleSidebar, zoomStep } from '../state/actions'
import { useSearch } from '../state/search'
import { useTabs, type Tab } from '../state/tabs'
import { useUi } from '../state/ui'
import { ZOOM_STEPS } from '../viewer/layout'
import {
  IconContinuous,
  IconDown,
  IconMinus,
  IconOpen,
  IconPlus,
  IconRedo,
  IconSave,
  IconSearch,
  IconSidebar,
  IconSingle,
  IconTwo,
  IconUndo,
  IconUp
} from './Icons'

const VIEW_MODES: { mode: ViewMode; label: string; icon: JSX.Element }[] = [
  { mode: 'continuous', label: 'Continuous scroll', icon: <IconContinuous /> },
  { mode: 'single', label: 'Single page', icon: <IconSingle /> },
  { mode: 'two', label: 'Two-page spread', icon: <IconTwo /> }
]

const PRESETS = ZOOM_STEPS.filter((z) => [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(z))

export function Toolbar({ tab }: { tab: Tab }): JSX.Element {
  const sidebarOpen = useUi((s) => s.sidebarOpen)
  const edit = useEditInfo(tab.docId)
  const searchOpen = useSearch((s) => s.open)
  const goToPage = useTabs((s) => s.goToPage)
  const { view, numPages } = tab
  const [pageText, setPageText] = useState(String(view.page))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setPageText(String(view.page))
  }, [view.page, editing])

  const commitPage = (): void => {
    const n = parseInt(pageText, 10)
    if (Number.isFinite(n)) goToPage(tab.docId, n)
    else setPageText(String(view.page))
    setEditing(false)
  }

  const percent = Math.round(view.zoom * 100)
  const zoomValue = view.zoomMode === 'custom' ? String(percent) : view.zoomMode
  const isPreset = view.zoomMode !== 'custom' || PRESETS.some((z) => Math.round(z * 100) === percent)
  const ready = tab.status === 'ready'

  return (
    <div role="toolbar" aria-label="Document tools" className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
      <button className="btn-icon" aria-label="Toggle sidebar" aria-pressed={sidebarOpen} title="Toggle sidebar (Ctrl+Shift+B)" onClick={toggleSidebar}>
        <IconSidebar />
      </button>
      <button className="btn-icon" aria-label="Open PDF" title="Open PDF (Ctrl+O)" onClick={() => void openFiles()}>
        <IconOpen />
      </button>
      <button className="btn-icon" aria-label="Save" title="Save (Ctrl+S)" disabled={!ready || !edit.dirty} onClick={() => void runCommand('file.save')}>
        <IconSave />
      </button>
      <button
        className="btn-icon"
        aria-label={edit.undoLabel ? `Undo ${edit.undoLabel}` : 'Undo'}
        title={edit.undoLabel ? `Undo ${edit.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
        disabled={!ready || !edit.canUndo}
        onClick={() => void runCommand('edit.undo')}
      >
        <IconUndo />
      </button>
      <button
        className="btn-icon"
        aria-label={edit.redoLabel ? `Redo ${edit.redoLabel}` : 'Redo'}
        title={edit.redoLabel ? `Redo ${edit.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}
        disabled={!ready || !edit.canRedo}
        onClick={() => void runCommand('edit.redo')}
      >
        <IconRedo />
      </button>

      <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />

      <button className="btn-icon" aria-label="Previous page" disabled={!ready || view.page <= 1} onClick={() => pageBy(-1)}>
        <IconUp />
      </button>
      <label className="flex items-center gap-1 text-ink-muted">
        <span className="sr-only">Page number</span>
        <input
          className="field w-14 text-center text-ink"
          inputMode="numeric"
          value={pageText}
          disabled={!ready}
          onFocus={(e) => {
            setEditing(true)
            e.currentTarget.select()
          }}
          onChange={(e) => setPageText(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commitPage}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitPage()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setPageText(String(view.page))
              e.currentTarget.blur()
            }
          }}
        />
        <span aria-hidden="true">/ {numPages || '–'}</span>
        <span className="sr-only">of {numPages}</span>
      </label>
      <button className="btn-icon" aria-label="Next page" disabled={!ready || view.page >= numPages} onClick={() => pageBy(1)}>
        <IconDown />
      </button>

      <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />

      <button className="btn-icon" aria-label="Zoom out" title="Zoom out (Ctrl+-)" disabled={!ready} onClick={() => zoomStep(-1)}>
        <IconMinus />
      </button>
      <select
        aria-label="Zoom level"
        className="field w-32"
        disabled={!ready}
        value={zoomValue}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'fit-width' || v === 'fit-page') setZoomMode(v)
          else setZoomMode('custom', parseInt(v, 10) / 100)
        }}
      >
        <option value="fit-width">Fit width</option>
        <option value="fit-page">Fit page</option>
        {!isPreset && <option value={String(percent)}>{percent}%</option>}
        {PRESETS.map((z) => (
          <option key={z} value={String(Math.round(z * 100))}>
            {Math.round(z * 100)}%
          </option>
        ))}
      </select>
      {view.zoomMode !== 'custom' && (
        <span className="w-10 text-xs text-ink-muted" aria-hidden="true">
          {percent}%
        </span>
      )}
      <button className="btn-icon" aria-label="Zoom in" title="Zoom in (Ctrl+=)" disabled={!ready} onClick={() => zoomStep(1)}>
        <IconPlus />
      </button>

      <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />

      <div role="group" aria-label="Page layout" className="flex">
        {VIEW_MODES.map(({ mode, label, icon }) => (
          <button key={mode} className="btn-icon" aria-label={label} title={label} aria-pressed={view.viewMode === mode} disabled={!ready} onClick={() => setViewMode(mode)}>
            {icon}
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center">
        <button className="btn-icon" aria-label="Find in document" title="Find (Ctrl+F)" aria-pressed={searchOpen} disabled={!ready} onClick={openSearch}>
          <IconSearch />
        </button>
      </div>
    </div>
  )
}
