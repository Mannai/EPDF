import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LibraryItem, SortKey } from '@shared/features/library'
import { formatBytes } from '@shared/features/library/text'
import { CloudIcon, FileIcon, StarIcon, WarnIcon } from './icons'
import { applySort, askAddToFolder, ensureRange, openRefs, refreshList, refreshState, revealRef, selectAll, selectOnly, selectRange, setFavorite, toggleSelect, useLibrary, removeRefs, selectedItems } from './store'
import { unwantThumb, useThumbs, wantThumb } from './thumbs'
import { libraryApi } from './api'
import { askConfirm } from '../../state/confirm'
import { notify } from '../../state/notify'
import { openContextMenu, type ContextItem } from '../../components/contextMenu'
import { detachActiveTab } from '../../state/actions'
import { useTabs } from '../../state/tabs'
import { formatDate } from './format'

export const DRAG_TYPE = 'application/x-epdf-library-refs'

const ROW_H = 60
const HEADER_H = 34
const CARD_W = 184
const CARD_H = 240
const OVERSCAN = 4

/** A first-page picture, or a placeholder while it is being made / when there is none (cloud, encrypted, ...). */
function Thumb({ item, width, height }: { item: LibraryItem; width: number; height: number }): JSX.Element {
  const url = useThumbs((s) => s.urls[item.ref])
  useEffect(() => {
    wantThumb(item)
    return () => unwantThumb(item.ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.ref, item.size, item.mtime, item.state, item.cloud])
  return url ? (
    <img src={url} alt="" width={width} height={height} className="shrink-0 rounded-sm border border-line bg-white object-contain" style={{ width, height }} draggable={false} />
  ) : (
    <div className="grid shrink-0 place-items-center rounded-sm border border-line bg-surface-alt text-ink-muted" style={{ width, height }} aria-hidden="true">
      {item.cloud ? <CloudIcon /> : <FileIcon size={width > 60 ? 28 : 16} />}
    </div>
  )
}

/** Short text saying why a file is not (fully) searchable; empty when everything is fine. */
export function stateLabel(item: LibraryItem): { text: string; warn: boolean } | null {
  switch (item.state) {
    case 'no_text':
      return { text: 'No text: run OCR to make it searchable', warn: true }
    case 'unindexable':
      return { text: `Not searchable: ${item.note || 'could not be read'}`, warn: true }
    case 'too_large':
      return { text: 'Too large to index', warn: true }
    case 'pending':
      return item.inLibrary ? { text: 'Waiting to be indexed', warn: false } : null
    case 'cloud':
      return { text: 'Cloud only: not indexed until downloaded', warn: false }
    default:
      return null
  }
}

function Badges({ item }: { item: LibraryItem }): JSX.Element | null {
  const st = stateLabel(item)
  if (!item.cloud && !st) return null
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
      {item.cloud && (
        <span className="inline-flex shrink-0 items-center gap-1" title="Stored in the cloud; opening it downloads it">
          <CloudIcon />
          <span>Cloud only</span>
        </span>
      )}
      {st && item.state !== 'cloud' && (
        <span className="inline-flex min-w-0 items-center gap-1" title={st.text}>
          {st.warn && <WarnIcon />}
          <span className="truncate">{st.text}</span>
        </span>
      )}
    </span>
  )
}

function FavoriteButton({ item }: { item: LibraryItem }): JSX.Element {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`btn-icon ${item.favorite ? 'text-accent' : 'text-ink-muted'}`}
      aria-label={item.favorite ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`}
      aria-pressed={item.favorite}
      onClick={(e) => {
        e.stopPropagation()
        void setFavorite([item.ref], !item.favorite)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <StarIcon filled={item.favorite} />
    </button>
  )
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'folder', label: 'Folder' },
  { key: 'size', label: 'Size' },
  { key: 'modified', label: 'Modified' },
  { key: 'pages', label: 'Pages' }
]
const TEMPLATE = 'minmax(0,3fr) minmax(0,2fr) 5rem 7.5rem 4rem 2.75rem'

export function FileGrid(): JSX.Element {
  const items = useLibrary((s) => s.items)
  const total = useLibrary((s) => s.total)
  const view = useLibrary((s) => s.view)
  const selected = useLibrary((s) => s.selected)
  const active = useLibrary((s) => s.active)
  const sort = useLibrary((s) => s.sort)
  const descending = useLibrary((s) => s.descending)
  const loading = useLibrary((s) => s.loading)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ top: 0, height: 600, width: 900 })
  const viaKeyboard = useRef(false)

  const list = view === 'list'
  const cols = list ? 1 : Math.max(1, Math.floor((box.width - 16) / CARD_W))
  const rowH = list ? ROW_H : CARD_H
  const headerH = list ? HEADER_H : 0
  const rowCount = Math.ceil(total / cols)
  const first = Math.max(0, Math.floor(Math.max(0, box.top - headerH) / rowH) - OVERSCAN)
  const last = Math.min(rowCount - 1, Math.ceil((box.top + box.height - headerH) / rowH) + OVERSCAN)
  const selectedSet = useMemo(() => new Set(selected), [selected])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setBox({ top: el.scrollTop, height: el.clientHeight, width: el.clientWidth })
    measure()
    let raf = 0
    const onScroll = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [total > 0])

  useEffect(() => {
    if (rowCount > 0) ensureRange(first * cols, Math.min(total - 1, (last + 1) * cols - 1))
  }, [first, last, cols, rowCount, total, items])

  // Keep the active row in view when the keyboard moved it.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || active < 0 || !viaKeyboard.current) return
    viaKeyboard.current = false
    const r = Math.floor(active / cols)
    const top = headerH + r * rowH
    if (top < el.scrollTop + headerH) el.scrollTop = Math.max(0, top - headerH)
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight
  }, [active, cols, rowH, headerH])

  const activeId = active >= 0 ? `lib-item-${active}` : undefined

  const move = (to: number, e: React.KeyboardEvent): void => {
    const idx = Math.min(Math.max(0, to), total - 1)
    viaKeyboard.current = true
    if (e.shiftKey) selectRange(idx)
    else if (e.ctrlKey || e.metaKey) useLibrary.setState({ active: idx })
    else selectOnly(idx)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (total === 0) return
    const a = active < 0 ? 0 : active
    const page = Math.max(1, Math.floor((box.height - headerH) / rowH)) * cols
    switch (e.key) {
      case 'ArrowDown':
        return void (e.preventDefault(), move(a + cols, e))
      case 'ArrowUp':
        return void (e.preventDefault(), move(a - cols, e))
      case 'ArrowRight':
        if (!list) return void (e.preventDefault(), move(a + 1, e))
        return
      case 'ArrowLeft':
        if (!list) return void (e.preventDefault(), move(a - 1, e))
        return
      case 'PageDown':
        return void (e.preventDefault(), move(a + page, e))
      case 'PageUp':
        return void (e.preventDefault(), move(a - page, e))
      case 'Home':
        return void (e.preventDefault(), move(0, e))
      case 'End':
        return void (e.preventDefault(), move(total - 1, e))
      case ' ':
        e.preventDefault()
        return toggleSelect(a)
      case 'Enter': {
        e.preventDefault()
        const sel = selectedItems()
        const refs = sel.length > 0 ? sel.map((i) => i.ref) : items[a] ? [items[a]!.ref] : []
        return void openRefs(refs)
      }
      case 'a':
      case 'A':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          selectAll()
        }
        return
      case 'd':
      case 'D':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          const sel = selectedItems()
          const targets = sel.length > 0 ? sel : items[a] ? [items[a]!] : []
          if (targets.length) void setFavorite(targets.map((t) => t.ref), !targets.every((t) => t.favorite))
        }
        return
      case 'Delete': {
        const sel = selectedItems()
        if (sel.length === 0) return
        e.preventDefault()
        void confirmRemove(sel)
        return
      }
      default:
    }
  }

  const onRowClick = (e: React.MouseEvent, index: number): void => {
    if (e.shiftKey) selectRange(index)
    else if (e.ctrlKey || e.metaKey) toggleSelect(index)
    else selectOnly(index)
    scrollRef.current?.focus({ preventScroll: true })
  }

  // Right-click on a file (or Shift+F10 / the Menu key on the grid, for the file with the cursor).
  const onContextMenu = (e: React.MouseEvent): void => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[id^="lib-item-"]')
    const index = cell ? Number(cell.id.slice('lib-item-'.length)) : active
    const item = items[index]
    if (!item) return
    if (!useLibrary.getState().selected.includes(item.ref)) selectOnly(index)
    const anchor = cell ?? document.getElementById(`lib-item-${index}`) ?? e.currentTarget
    const sel = selectedItems()
    void openContextMenu({ clientX: e.clientX, clientY: e.clientY, currentTarget: anchor, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() }, fileMenu(sel.length ? sel : [item]))
  }

  const onDragStart = (e: React.DragEvent, item: LibraryItem, index: number): void => {
    const sel = useLibrary.getState().selected
    if (!sel.includes(item.ref)) selectOnly(index)
    const refs = sel.includes(item.ref) ? sel : [item.ref]
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(refs))
    e.dataTransfer.setData('text/plain', refs.length === 1 ? item.name : `${refs.length} files`)
    e.dataTransfer.effectAllowed = 'copy'
  }

  if (total === 0) return <div className="min-h-0 flex-1" />

  const rows: JSX.Element[] = []
  for (let r = first; r <= last; r++) {
    const cells: JSX.Element[] = []
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (i >= total) break
      const item = items[i]
      const isSel = !!item && selectedSet.has(item.ref)
      const isActive = i === active
      if (list) {
        cells.push(
          <ListRowCells key={i} item={item} />
        )
      } else {
        cells.push(
          <div
            key={i}
            id={`lib-item-${i}`}
            role="gridcell"
            aria-colindex={c + 1}
            aria-selected={isSel}
            aria-label={item ? item.name : 'Loading'}
            data-active={isActive}
            draggable={!!item}
            onDragStart={item ? (e) => onDragStart(e, item, i) : undefined}
            onClick={(e) => onRowClick(e, i)}
            onDoubleClick={() => item && void openRefs([item.ref])}
            className={`relative m-1 flex flex-col items-center gap-1 rounded-md border p-2 ${isSel ? 'border-accent bg-accent/15' : 'border-line bg-surface'} ${isActive ? 'ring-2 ring-accent ring-offset-0 group-focus-visible:ring-2' : ''}`}
            style={{ width: CARD_W - 8, height: CARD_H - 8 }}
          >
            {item ? (
              <>
                <Thumb item={item} width={112} height={144} />
                <span className="w-full truncate text-center font-medium" title={item.name}>
                  {item.name}
                </span>
                <span className="text-xs text-ink-muted">
                  {formatBytes(item.size)}
                  {item.pages ? ` · ${item.pages} p.` : ''}
                </span>
                <Badges item={item} />
                <span className="absolute right-0.5 top-0.5">
                  <FavoriteButton item={item} />
                </span>
              </>
            ) : (
              <span className="text-ink-muted">Loading…</span>
            )}
          </div>
        )
      }
    }
    if (list) {
      const i = r
      const item = items[i]
      const isSel = !!item && selectedSet.has(item.ref)
      const isActive = i === active
      rows.push(
        <div
          key={i}
          id={`lib-item-${i}`}
          role="row"
          aria-rowindex={i + 2}
          aria-selected={isSel}
          data-active={isActive}
          draggable={!!item}
          onDragStart={item ? (e) => onDragStart(e, item, i) : undefined}
          onClick={(e) => onRowClick(e, i)}
          onDoubleClick={() => item && void openRefs([item.ref])}
          className={`absolute left-0 right-0 grid items-center gap-2 border-b border-line px-3 ${isSel ? 'bg-accent/15' : i % 2 ? 'bg-surface' : 'bg-surface'} ${isActive ? 'ring-2 ring-inset ring-accent' : ''}`}
          style={{ top: i * rowH, height: rowH, gridTemplateColumns: TEMPLATE }}
        >
          {cells}
        </div>
      )
    } else {
      rows.push(
        <div key={r} role="row" aria-rowindex={r + 1} className="absolute left-0 right-0 flex px-1" style={{ top: r * rowH, height: rowH }}>
          {cells}
        </div>
      )
    }
  }

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Files"
      aria-rowcount={list ? total + 1 : rowCount}
      aria-colcount={list ? 6 : cols}
      aria-multiselectable="true"
      aria-activedescendant={activeId}
      aria-busy={loading}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      className="group relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      {list && (
        <div role="rowgroup" className="sticky top-0 z-10 border-b border-line bg-surface-alt">
          <div role="row" aria-rowindex={1} className="grid items-center gap-2 px-3" style={{ gridTemplateColumns: TEMPLATE, height: HEADER_H }}>
            {COLUMNS.map((c) => (
              <div key={c.key} role="columnheader" aria-sort={sort === c.key ? (descending ? 'descending' : 'ascending') : 'none'} className="min-w-0">
                <button type="button" tabIndex={-1} className="flex items-center gap-1 rounded px-1 text-xs font-semibold uppercase tracking-wide text-ink-muted hover:text-ink" onClick={() => applySort(c.key)}>
                  {c.label}
                  <span aria-hidden="true">{sort === c.key ? (descending ? '▼' : '▲') : ''}</span>
                </button>
              </div>
            ))}
            <div role="columnheader" className="text-center text-xs text-ink-muted">
              <span className="sr-only">Favorite</span>
            </div>
          </div>
        </div>
      )}
      <div role="rowgroup" className="relative" style={{ height: rowCount * rowH }}>
        {rows}
      </div>
    </div>
  )
}

/** The six cells of one list row. */
function ListRowCells({ item }: { item: LibraryItem | undefined }): JSX.Element {
  if (!item) {
    return (
      <>
        <div role="gridcell" className="text-ink-muted">
          Loading…
        </div>
        {[2, 3, 4, 5, 6].map((c) => (
          <div key={c} role="gridcell" aria-hidden="true" />
        ))}
      </>
    )
  }
  return (
    <>
      <div role="gridcell" className="flex min-w-0 items-center gap-3">
        <Thumb item={item} width={34} height={44} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium" title={item.name}>
            {item.name}
          </span>
          <Badges item={item} />
        </div>
      </div>
      <div role="gridcell" className="truncate text-ink-muted" title={item.dir}>
        {item.dir}
      </div>
      <div role="gridcell" className="tabular-nums text-ink-muted">
        {formatBytes(item.size)}
      </div>
      <div role="gridcell" className="text-ink-muted">
        {item.mtime ? formatDate(item.mtime) : item.lastOpenedAt ? `Opened ${formatDate(item.lastOpenedAt)}` : ''}
      </div>
      <div role="gridcell" className="tabular-nums text-ink-muted">
        {item.pages ?? ''}
      </div>
      <div role="gridcell" className="text-center">
        <FavoriteButton item={item} />
      </div>
    </>
  )
}

/** Opens one file in a window of its own (in this window when nothing else is open here). */
async function openInNewWindow(ref: string): Promise<void> {
  await openRefs([ref])
  if (useTabs.getState().tabs.length > 1) await detachActiveTab()
}

/** Right-click on a file: acts on the selection (a click on an unselected file selects just that one first). */
function fileMenu(t: LibraryItem[]): ContextItem[] {
  const one = t.length === 1 ? t[0] : undefined
  const allFav = t.every((i) => i.favorite)
  const lib = t.filter((i) => i.inLibrary)
  const scope = useLibrary.getState().scope
  return [
    { label: one ? 'Open' : `Open ${t.length} files`, keys: 'Enter', run: () => openRefs(t.map((i) => i.ref)) },
    { label: 'Open in new window', enabled: !!one, run: () => one && openInNewWindow(one.ref) },
    { label: 'Show in File Explorer', enabled: !!one, run: () => one && revealRef(one.ref) },
    { type: 'separator' },
    { label: 'Favorite', keys: 'Ctrl+D', checked: allFav, run: () => setFavorite(t.map((i) => i.ref), !allFav) },
    { label: 'Add to folder…', enabled: lib.length > 0, run: () => askAddToFolder(lib.map((i) => i.ref)) },
    ...(scope.kind === 'collection'
      ? [
          {
            label: 'Remove from this folder',
            run: async () => {
              const r = await libraryApi.removeFromCollection(scope.id, t.map((i) => i.ref))
              if (!r.ok) notify('error', r.error)
              await refreshList(true)
              void refreshState()
            }
          }
        ]
      : []),
    { type: 'separator' },
    { label: 'Remove from library…', keys: 'Delete', run: () => confirmRemove(t) }
  ]
}

export async function confirmRemove(sel: LibraryItem[]): Promise<void> {
  const inLib = sel.filter((s) => s.inLibrary)
  const what = sel.length === 1 ? `“${sel[0].name}”` : `${sel.length} files`
  const choice = await askConfirm({
    title: 'Remove from library?',
    message: `${what} will no longer appear in the library or in search results. The ${sel.length === 1 ? 'file itself is' : 'files themselves are'} not deleted from your computer.${inLib.length ? '' : ' (They stay in the Recent list until you clear it.)'}`,
    buttons: [
      { label: 'Remove from library', value: 'remove', variant: 'danger' },
      { label: 'Cancel', value: 'cancel' }
    ],
    cancelValue: 'cancel'
  })
  if (choice === 'remove') await removeRefs(sel.map((s) => s.ref))
}
