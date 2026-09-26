import { useEditInfo } from '../edit/session'
import { runCommand } from '../features/api'
import { openSearch } from '../state/actions'
import { useSearch } from '../state/search'
import type { Tab } from '../state/tabs'
import { useUi } from '../state/ui'
import { Icon } from './Icons'
import { TabBar } from './TabBar'

/** Windows reserves this much of the title bar's right end for its minimise / maximise / close buttons (3 x 46 px). */
const CAPTION_WIDTH = 138

/**
 * The title bar (Windows design v3): app mark, quick access (Save, Undo, Redo), the document tabs, a centred search
 * box and, on Windows, room for the caption buttons that Windows draws itself. Empty areas drag the window.
 */
export function TitleBar({ tab, quickAccess = true }: { tab: Tab | null; quickAccess?: boolean }): JSX.Element {
  const custom = useUi((s) => s.customTitleBar)
  const edit = useEditInfo(tab?.docId ?? null)
  const searchOpen = useSearch((s) => s.open)
  // Full-tab views (page organizer, ...) bring their own Undo / Save and have no page search.
  const ready = tab?.status === 'ready' && quickAccess

  return (
    <div className={`flex h-10 shrink-0 items-center gap-1 bg-chrome ps-2.5 ${custom ? 'app-drag' : ''}`}>
      <span
        aria-hidden="true"
        className="me-1.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-accent text-[11px] font-bold leading-none text-accent-ink"
      >
        E
      </span>
      {quickAccess && (
        <>
          <button className="btn-icon btn-icon-sm" aria-label="Save" title="Save (Ctrl+S)" disabled={!ready || !edit.dirty} onClick={() => void runCommand('file.save')}>
            <Icon name="save" />
          </button>
          <button
            className="btn-icon btn-icon-sm"
            aria-label={edit.undoLabel ? `Undo ${edit.undoLabel}` : 'Undo'}
            title={edit.undoLabel ? `Undo ${edit.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
            disabled={!ready || !edit.canUndo}
            onClick={() => void runCommand('edit.undo')}
          >
            <Icon name="undo" />
          </button>
          <button
            className="btn-icon btn-icon-sm"
            aria-label={edit.redoLabel ? `Redo ${edit.redoLabel}` : 'Redo'}
            title={edit.redoLabel ? `Redo ${edit.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}
            disabled={!ready || !edit.canRedo}
            onClick={() => void runCommand('edit.redo')}
          >
            <Icon name="redo" />
          </button>
        </>
      )}
      <span aria-hidden="true" className="mx-2 h-[18px] w-px shrink-0 bg-black/[.12] dark:bg-white/[.12]" />
      <TabBar />
      <div className="flex min-w-[120px] flex-1 justify-center px-3">
        {quickAccess && (
        <button
          type="button"
          aria-label="Find in document"
          aria-pressed={searchOpen}
          aria-keyshortcuts="Control+F"
          title="Find (Ctrl+F)"
          disabled={!ready}
          onClick={openSearch}
          className="inline-flex h-[30px] w-full max-w-[360px] items-center gap-2 rounded-md border border-black/10 border-b-black/25 bg-white/75 px-2.5 text-ink-muted transition-colors duration-fast hover:bg-white disabled:cursor-default disabled:opacity-60 aria-pressed:border-b-2 aria-pressed:border-b-accent dark:border-white/10 dark:border-b-white/20 dark:bg-white/[.06] dark:hover:bg-white/10"
        >
          <Icon name="search" size={14} />
          <span className="truncate">Search in document (Ctrl+F)</span>
        </button>
        )}
      </div>
      {custom && <div aria-hidden="true" className="h-full shrink-0" style={{ width: CAPTION_WIDTH }} />}
    </div>
  )
}
