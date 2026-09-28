import { useEffect, useState } from 'react'
import type { ViewMode } from '@shared/types'
import { shortcutLabel } from '../features/keys'
import { pageBy, setViewMode, setZoomMode, zoomStep } from '../state/actions'
import { useTabs, type Tab } from '../state/tabs'
import { ZOOM_STEPS } from '../viewer/layout'
import { Icon, type IconName } from './Icons'

const VIEW_MODES: { mode: ViewMode; label: string; icon: IconName }[] = [
  { mode: 'continuous', label: 'Continuous scroll', icon: 'continuous' },
  { mode: 'single', label: 'Single page', icon: 'single' },
  { mode: 'two', label: 'Two-page spread', icon: 'two' }
]

const PRESETS = ZOOM_STEPS.filter((z) => [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(z))
const ZMIN = ZOOM_STEPS[0]
const ZMAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]
// The slider moves on a log scale, so 50%..100% gets as much travel as 100%..200%.
const toSlider = (z: number): number => Math.round((1000 * Math.log(z / ZMIN)) / Math.log(ZMAX / ZMIN))
const fromSlider = (v: number): number => ZMIN * Math.pow(ZMAX / ZMIN, v / 1000)

/** Status bar (Office convention): page on the left; layout and zoom on the right. */
export function StatusBar({ tab }: { tab: Tab }): JSX.Element {
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
  const small = 'inline-flex h-[22px] w-[22px] items-center justify-center rounded-sm hover:bg-hover disabled:text-ink-disabled disabled:hover:bg-transparent'

  return (
    <div role="toolbar" aria-label="Document tools" className="flex h-7 shrink-0 items-center gap-1 border-t border-black/[.08] bg-chrome px-2.5 text-caption dark:border-white/[.08]">
      <button className={small} aria-label="Previous page" title="Previous page" disabled={!ready || view.page <= 1} onClick={() => pageBy(-1)}>
        <Icon name="chev-up" size={14} />
      </button>
      <label className="flex items-center gap-1">
        <span aria-hidden="true">Page</span>
        <span className="sr-only">Page number</span>
        <input
          className="h-5 w-9 rounded-[3px] border border-line-strong bg-field text-center tabular-nums text-ink focus-visible:outline-offset-0"
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
        <span>of {numPages || '–'}</span>
      </label>
      <button className={small} aria-label="Next page" title="Next page" disabled={!ready || view.page >= numPages} onClick={() => pageBy(1)}>
        <Icon name="chev-down" size={14} />
      </button>

      <span className="flex-1" />

      <div role="group" aria-label="Page layout" className="flex items-center">
        {VIEW_MODES.map(({ mode, label, icon }) => (
          <button
            key={mode}
            className="inline-flex h-[22px] w-6 items-center justify-center rounded-[3px] hover:bg-hover disabled:text-ink-disabled aria-pressed:bg-accent-subtle aria-pressed:text-accent"
            aria-label={label}
            title={label}
            aria-pressed={view.viewMode === mode}
            disabled={!ready}
            onClick={() => setViewMode(mode)}
          >
            <Icon name={icon} size={14} />
          </button>
        ))}
      </div>
      <span aria-hidden="true" className="mx-2 h-3.5 w-px bg-black/[.15] dark:bg-white/[.15]" />
      <button className={small} aria-label="Zoom out" title={`Zoom out (${shortcutLabel('Ctrl+-')})`} disabled={!ready} onClick={() => zoomStep(-1)}>
        <Icon name="minus" size={14} />
      </button>
      <input
        type="range"
        aria-label="Zoom"
        aria-valuetext={`${percent}%`}
        min={0}
        max={1000}
        value={toSlider(view.zoom)}
        disabled={!ready}
        onChange={(e) => setZoomMode('custom', Math.round(fromSlider(Number(e.target.value)) * 100) / 100)}
        className="h-1 w-[120px] cursor-pointer accent-[rgb(var(--c-accent))] disabled:cursor-default"
      />
      <button className={small} aria-label="Zoom in" title={`Zoom in (${shortcutLabel('Ctrl+=')})`} disabled={!ready} onClick={() => zoomStep(1)}>
        <Icon name="plus" size={14} />
      </button>
      <select
        aria-label="Zoom level"
        title="Zoom (click for options)"
        className="h-[22px] min-w-[76px] cursor-pointer appearance-none rounded-sm bg-transparent pe-1 ps-1 text-end tabular-nums text-ink hover:bg-hover"
        disabled={!ready}
        value={zoomValue}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'fit-width' || v === 'fit-page') setZoomMode(v)
          else setZoomMode('custom', parseInt(v, 10) / 100)
        }}
      >
        <option value="fit-width">{view.zoomMode === 'fit-width' ? `${percent}% (fit width)` : 'Fit width'}</option>
        <option value="fit-page">{view.zoomMode === 'fit-page' ? `${percent}% (fit page)` : 'Fit page'}</option>
        {!isPreset && <option value={String(percent)}>{percent}%</option>}
        {PRESETS.map((z) => (
          <option key={z} value={String(Math.round(z * 100))}>
            {Math.round(z * 100)}%
          </option>
        ))}
      </select>
    </div>
  )
}
