import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Tab } from '../../state/tabs'
import { announce, unlock } from '../links/common'
import {
  addBookmarkHere,
  colorToHex,
  deleteAction,
  deleteAllAction,
  goToBookmark,
  hexToColor,
  indentAction,
  moveByAction,
  moveToAction,
  outdentAction,
  pointToCurrentView,
  renameAction,
  setAllOpenAction,
  styleAction
} from './actions'
import { refreshBookmarks, useDocBookmarks } from './data'
import { IconAddBookmark, IconChevron, IconClearFilter, IconDown, IconGenerate, IconIndent, IconOutdent, IconRename, IconTarget, IconTrash, IconUp } from './icons'
import type { BmNode } from './pdf/model'
import { contains, locate } from './pdf/tree'
import { allNodes, ancestorsOf, currentBookmark, flatten, visibleAncestor, type Row } from './rows'
import { useBookmarkUi } from './store'

const ROW_H = 30
const OVERSCAN = 8

const domId = (docId: string, id: string): string => `bm-${docId}-${id.replace(/[^A-Za-z0-9]+/g, '_')}`

const destLabel = (n: BmNode): string => {
  const t = n.target
  if (t.kind === 'page') return `p. ${t.dest.pageIndex + 1}`
  if (t.kind === 'uri') return 'link'
  if (t.kind === 'dead') return 'broken'
  return ''
}

const destDescription = (n: BmNode): string => {
  const t = n.target
  switch (t.kind) {
    case 'page':
      return t.named ? `Named destination “${t.named}” on page ${t.dest.pageIndex + 1}` : `Page ${t.dest.pageIndex + 1}`
    case 'uri':
      return `Web link ${t.uri}`
    case 'dead':
      return 'Points to a page that no longer exists'
    case 'other':
      return `${t.action} action (kept as is)`
    default:
      return 'No destination (heading only)'
  }
}

/** The left sidebar panel: the document outline as an ARIA tree with editing, drag and drop and keyboard reordering. */
export function BookmarksPanel({ tab }: { tab: Tab }): JSX.Element {
  const docId = tab.docId
  const data = useDocBookmarks(docId, true)
  const selectedId = useBookmarkUi((s) => s.selected[docId] ?? null)
  const expandedMap = useBookmarkUi((s) => s.expanded[docId])
  const filter = useBookmarkUi((s) => s.filter)
  const editing = useBookmarkUi((s) => s.editing)
  const reveal = useBookmarkUi((s) => s.reveal)
  const ui = useBookmarkUi.getState

  const roots = data?.roots
  const rows = useMemo<Row[]>(() => (roots ? flatten(roots, { isOpen: (n) => expandedMap?.[n.id] ?? n.open, filter }) : []), [roots, expandedMap, filter])
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.node.id, i])), [rows])

  // ---- where am I: the bookmark for the page being viewed (shown on its nearest visible ancestor when collapsed)
  const currentId = useMemo(() => {
    if (!roots) return null
    const cur = currentBookmark(roots, tab.view.page - 1)
    return cur ? visibleAncestor(roots, rows, cur.id) : null
  }, [roots, rows, tab.view.page])

  // ---- virtual scrolling
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setHeight(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [data?.hasOutline])
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length - 1, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN)

  const scrollToIndex = useCallback((i: number) => {
    const el = scroller.current
    if (!el || i < 0) return
    const top = i * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
  }, [])

  // Keep the selected row in view (keyboard navigation, after adding or moving).
  useEffect(() => {
    if (selectedId !== null) scrollToIndex(rowIndex.get(selectedId) ?? -1)
  }, [selectedId, rowIndex, scrollToIndex])
  useEffect(() => {
    if (!reveal) return
    // A revealed item may sit inside a collapsed branch: open the branch first.
    if (roots) {
      const anc = ancestorsOf(roots, reveal.id)
      if (anc.some((a) => !(expandedMap?.[a] ?? locate(roots, a)?.node.open))) ui().setManyExpanded(docId, anc, true)
    }
    scrollToIndex(rowIndex.get(reveal.id) ?? -1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, rows])

  const treeRef = useRef<HTMLDivElement>(null)
  const focusTree = (): void => treeRef.current?.focus({ preventScroll: true })

  // ---- selection and actions
  const select = (id: string | null): void => ui().select(docId, id)
  const selectedRow = selectedId !== null ? rows[rowIndex.get(selectedId) ?? -1] : undefined
  const selectedNode = selectedId !== null && roots ? locate(roots, selectedId)?.node : undefined
  const canReorder = !!selectedNode
  const filtering = filter.trim().length > 0

  const toggle = (row: Row, open?: boolean): void => {
    if (filtering) return
    ui().setExpanded(docId, row.node.id, open ?? !row.expanded)
  }

  const onTreeKeyDown = (e: React.KeyboardEvent): void => {
    if (editing !== null || e.target !== e.currentTarget) return
    const idx = selectedId !== null ? (rowIndex.get(selectedId) ?? -1) : -1
    const row = idx >= 0 ? rows[idx] : undefined
    const go = (i: number): void => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))]
      if (r) select(r.node.id)
    }
    const stop = (): void => e.preventDefault()
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (!row) return
      if (e.key === 'ArrowUp') (stop(), void moveByAction(docId, row.node.id, -1))
      else if (e.key === 'ArrowDown') (stop(), void moveByAction(docId, row.node.id, 1))
      else if (e.key === 'ArrowRight') (stop(), void indentAction(docId, row.node.id))
      else if (e.key === 'ArrowLeft') (stop(), void outdentAction(docId, row.node.id))
      return
    }
    if (e.ctrlKey || e.metaKey) return
    switch (e.key) {
      case 'ArrowDown':
        stop()
        go(idx < 0 ? 0 : idx + 1)
        break
      case 'ArrowUp':
        stop()
        go(idx < 0 ? 0 : idx - 1)
        break
      case 'Home':
        stop()
        go(0)
        break
      case 'End':
        stop()
        go(rows.length - 1)
        break
      case 'ArrowRight':
        if (!row) break
        stop()
        if (row.hasChildren && !row.expanded) toggle(row, true)
        else if (row.expanded && rows[idx + 1]?.depth > row.depth) go(idx + 1)
        break
      case 'ArrowLeft':
        if (!row) break
        stop()
        if (row.expanded && !filtering) toggle(row, false)
        else if (row.parentId !== null) select(row.parentId)
        break
      case '*': {
        if (!row) break
        stop()
        // Expand every sibling of the focused item that has children (WAI-ARIA tree pattern).
        const ids = rows.filter((r) => r.parentId === row.parentId && r.hasChildren).map((r) => r.node.id)
        if (!filtering && ids.length) ui().setManyExpanded(docId, ids, true)
        break
      }
      case 'Enter':
        if (!row) break
        stop()
        void goToBookmark(docId, row.node)
        break
      case 'F2':
        if (!row) break
        stop()
        ui().setEditing(row.node.id)
        break
      case 'Delete':
        if (!row) break
        stop()
        void deleteAction(docId, row.node.id)
        break
      default:
    }
  }

  // ---- drag and drop
  const dragId = useRef<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; where: 'before' | 'after' | 'inside' } | null>(null)
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopAutoScroll = (): void => {
    if (scrollTimer.current) clearInterval(scrollTimer.current)
    scrollTimer.current = null
  }
  const endDrag = (): void => {
    dragId.current = null
    setDrop(null)
    stopAutoScroll()
  }
  const onRowDragOver = (e: React.DragEvent, row: Row): void => {
    const dragging = dragId.current
    if (!dragging || !roots) return
    const src = locate(roots, dragging)?.node
    if (!src || contains(src, row.node.id)) {
      setDrop(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = (e.clientY - r.top) / r.height
    const where = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside'
    setDrop((d) => (d && d.id === row.node.id && d.where === where ? d : { id: row.node.id, where }))
  }
  const onContainerDragOver = (e: React.DragEvent): void => {
    if (!dragId.current) return
    const el = scroller.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const speed = e.clientY < r.top + 28 ? -12 : e.clientY > r.bottom - 28 ? 12 : 0
    stopAutoScroll()
    if (speed) scrollTimer.current = setInterval(() => (el.scrollTop += speed), 30)
  }
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const src = dragId.current
    const target = drop
    endDrag()
    if (src && target && target.id !== src) void moveToAction(docId, src, target.id, target.where)
  }

  // ---- states other than a tree
  if (!data) return <div className="p-3 text-sm text-ink-muted">Loading bookmarks…</div>
  if (data.error) {
    return (
      <div className="flex h-full flex-col gap-3 p-3 text-sm" data-testid="bookmarks-panel">
        <p role="status">
          {data.error.kind === 'encrypted' ? 'This document is password protected. Unlock it to view and edit its bookmarks.' : 'The bookmarks of this document could not be read.'}
        </p>
        {data.error.kind === 'encrypted' ? (
          <button className="btn-primary self-start" onClick={() => void unlock(docId).then((ok) => (ok ? refreshBookmarks(docId) : undefined))}>
            Unlock to edit bookmarks
          </button>
        ) : (
          <p className="text-ink-muted">{data.error.message}</p>
        )}
      </div>
    )
  }

  const empty = !data.hasOutline || data.roots.length === 0
  const total = data.count

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bookmarks-panel" data-count={total}>
      {/* Toolbar */}
      <div role="toolbar" aria-label="Bookmark tools" className="flex flex-wrap items-center gap-0.5 border-b border-line p-1">
        <button className="btn-icon" title="Add bookmark for the selected text or the current page" aria-label="Add bookmark" onClick={() => void addBookmarkHere(docId)}>
          <IconAddBookmark />
        </button>
        <button className="btn-icon" title="Rename (F2)" aria-label="Rename bookmark" disabled={!canReorder} onClick={() => selectedId && ui().setEditing(selectedId)}>
          <IconRename />
        </button>
        <button className="btn-icon" title="Delete (Delete)" aria-label="Delete bookmark" disabled={!canReorder} onClick={() => selectedId && void deleteAction(docId, selectedId)}>
          <IconTrash />
        </button>
        <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        <button className="btn-icon" title="Nest under the previous bookmark (Alt+Right)" aria-label="Nest bookmark" disabled={!canReorder} onClick={() => selectedId && void indentAction(docId, selectedId)}>
          <IconIndent />
        </button>
        <button className="btn-icon" title="Move out one level (Alt+Left)" aria-label="Un-nest bookmark" disabled={!canReorder} onClick={() => selectedId && void outdentAction(docId, selectedId)}>
          <IconOutdent />
        </button>
        <button className="btn-icon" title="Move up (Alt+Up)" aria-label="Move bookmark up" disabled={!canReorder} onClick={() => selectedId && void moveByAction(docId, selectedId, -1)}>
          <IconUp />
        </button>
        <button className="btn-icon" title="Move down (Alt+Down)" aria-label="Move bookmark down" disabled={!canReorder} onClick={() => selectedId && void moveByAction(docId, selectedId, 1)}>
          <IconDown />
        </button>
        <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
        <button className="btn-icon" title="Generate bookmarks from headings" aria-label="Generate bookmarks from headings" onClick={() => ui().openGenerate(docId)}>
          <IconGenerate />
        </button>
      </div>

      {/* Filter */}
      <div className="relative border-b border-line p-1.5">
        <input
          type="search"
          dir="auto"
          aria-label="Filter bookmarks"
          placeholder="Filter bookmarks"
          value={filter}
          onChange={(e) => ui().setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.stopPropagation()
              ui().setFilter('')
            } else if (e.key === 'ArrowDown' && rows.length) {
              e.preventDefault()
              focusTree()
              if (selectedId === null || !rowIndex.has(selectedId)) select(rows[0].node.id)
            }
          }}
          className="field w-full ps-2 pe-7 text-sm"
        />
        {filter && (
          <button className="btn-icon absolute end-2 top-2.5 h-6 w-6" aria-label="Clear filter" onClick={() => ui().setFilter('')}>
            <IconClearFilter />
          </button>
        )}
      </div>

      {/* Selected bookmark's properties */}
      {selectedNode && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-2 py-1.5 text-xs" role="group" aria-label="Selected bookmark">
          <button
            className="btn-icon h-7 w-7 font-bold"
            aria-pressed={selectedNode.bold}
            aria-label="Bold"
            title="Bold"
            onClick={() => void styleAction(docId, selectedNode.id, { bold: !selectedNode.bold })}
          >
            B
          </button>
          <button
            className="btn-icon h-7 w-7 italic"
            aria-pressed={selectedNode.italic}
            aria-label="Italic"
            title="Italic"
            onClick={() => void styleAction(docId, selectedNode.id, { italic: !selectedNode.italic })}
          >
            I
          </button>
          <label className="flex items-center gap-1">
            <span className="text-ink-muted">Colour</span>
            <input
              type="color"
              aria-label="Bookmark colour"
              value={colorToHex(selectedNode.color)}
              onChange={(e) => void styleAction(docId, selectedNode.id, { color: hexToColor(e.target.value) })}
              className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent p-0"
            />
          </label>
          {selectedNode.color && (
            <button className="btn h-6 px-1.5 text-xs" onClick={() => void styleAction(docId, selectedNode.id, { color: null })}>
              No colour
            </button>
          )}
          {selectedNode.children.length > 0 && (
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={selectedNode.open} onChange={(e) => void styleAction(docId, selectedNode.id, { open: e.target.checked })} />
              <span>Open by default</span>
            </label>
          )}
          <button className="btn h-7 gap-1 px-1.5 text-xs" title="Point this bookmark at the selected text or the current position" onClick={() => void pointToCurrentView(docId, selectedNode.id)}>
            <IconTarget />
            <span>Point to current view</span>
          </button>
          <span className="w-full text-ink-muted" data-testid="bookmark-destination">
            {destDescription(selectedNode)}
          </span>
        </div>
      )}

      {empty ? (
        <div className="flex flex-col gap-3 p-3 text-sm" data-testid="bookmarks-empty">
          <p className="text-ink-muted">This document has no bookmarks.</p>
          <button className="btn justify-start" onClick={() => void addBookmarkHere(docId)}>
            <IconAddBookmark />
            <span>Add bookmark for this page</span>
          </button>
          <button className="btn justify-start" onClick={() => ui().openGenerate(docId)}>
            <IconGenerate />
            <span>Generate from headings…</span>
          </button>
        </div>
      ) : (
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          onDragOver={onContainerDragOver}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDrop(null)
          }}
          onDrop={onDrop}
        >
          <div
            ref={treeRef}
            role="tree"
            aria-label="Bookmarks"
            data-testid="bookmarks-tree"
            tabIndex={0}
            aria-activedescendant={selectedId !== null && rowIndex.has(selectedId) ? domId(docId, selectedId) : undefined}
            onKeyDown={onTreeKeyDown}
            onFocus={(e) => {
              if (e.target === e.currentTarget && (selectedId === null || !rowIndex.has(selectedId)) && rows.length) select((currentId && rowIndex.has(currentId) ? currentId : rows[0].node.id))
            }}
            className="group relative outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            style={{ height: rows.length * ROW_H }}
          >
            {rows.slice(first, last + 1).map((row, k) => {
              const i = first + k
              const n = row.node
              const selected = n.id === selectedId
              const isCurrent = n.id === currentId
              const dropHere = drop && drop.id === n.id ? drop.where : null
              const label = `${n.title || 'Untitled'}${destLabel(n) ? `, ${destDescription(n).toLowerCase()}` : ''}${isCurrent ? ', current position' : ''}`
              return (
                <div
                  key={n.id}
                  id={domId(docId, n.id)}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-setsize={row.setSize}
                  aria-posinset={row.posInSet}
                  aria-expanded={row.hasChildren ? row.expanded : undefined}
                  aria-selected={selected}
                  aria-current={isCurrent ? 'location' : undefined}
                  aria-label={label}
                  data-bookmark-id={n.id}
                  data-title={n.title}
                  draggable={editing === null}
                  onDragStart={(e) => {
                    dragId.current = n.id
                    e.dataTransfer.setData('application/x-epdf-bookmark', n.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => onRowDragOver(e, row)}
                  onDragEnd={endDrag}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('[data-chevron]')) return
                    select(n.id)
                    focusTree()
                    void goToBookmark(docId, n)
                  }}
                  onDoubleClick={() => ui().setEditing(n.id)}
                  style={{ position: 'absolute', top: i * ROW_H, insetInline: 0, height: ROW_H, paddingInlineStart: 6 + row.depth * 16 }}
                  className={`flex items-center gap-1 border-s-4 pe-2 text-sm ${isCurrent ? 'border-accent' : 'border-transparent'} ${
                    selected ? 'bg-accent/20 group-focus-within:ring-1 group-focus-within:ring-inset group-focus-within:ring-accent' : 'hover:bg-surface'
                  } ${dropHere === 'inside' ? 'ring-2 ring-inset ring-accent' : ''}`}
                >
                  {dropHere === 'before' && <span aria-hidden="true" data-drop="before" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-accent" />}
                  {dropHere === 'after' && <span aria-hidden="true" data-drop="after" className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
                  {row.hasChildren ? (
                    <span
                      data-chevron
                      aria-hidden="true"
                      className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-ink-muted hover:bg-surface-alt"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(row)
                      }}
                    >
                      <IconChevron open={row.expanded} />
                    </span>
                  ) : (
                    <span className="inline-block h-5 w-5 shrink-0" aria-hidden="true" />
                  )}
                  {n.color && <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-line" style={{ background: `rgb(${n.color.map((v) => Math.round(v * 255)).join(' ')})` }} />}
                  {editing === n.id ? (
                    <TitleEditor
                      initial={n.title}
                      onDone={(title) => {
                        ui().setEditing(null)
                        if (title !== null) void renameAction(docId, n.id, title)
                        setTimeout(focusTree, 0)
                      }}
                    />
                  ) : (
                    <span
                      dir="auto"
                      style={{ unicodeBidi: 'isolate' }}
                      className={`min-w-0 flex-1 truncate text-start ${n.bold || isCurrent ? 'font-bold' : ''} ${n.italic ? 'italic' : ''} ${row.matches ? 'underline decoration-2 underline-offset-2' : ''}`}
                      title={n.title}
                    >
                      {n.title || 'Untitled'}
                    </span>
                  )}
                  <span className="ms-1 shrink-0 text-xs tabular-nums text-ink-muted" aria-hidden="true">
                    {destLabel(n)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Footer: count, warnings, expand/collapse all */}
      <div className="flex items-center justify-between gap-2 border-t border-line px-2 py-1 text-xs text-ink-muted">
        <span role="status" aria-live="polite">
          {filtering ? `${rows.length} matching of ${total}` : `${total.toLocaleString()} ${total === 1 ? 'bookmark' : 'bookmarks'}`}
        </span>
        <span className="flex gap-1">
          <button className="btn h-6 px-1.5 text-xs" disabled={empty} onClick={() => ui().setManyExpanded(docId, allNodes(data.roots).filter((n) => n.children.length).map((n) => n.id), false)}>
            Collapse
          </button>
          <button className="btn h-6 px-1.5 text-xs" disabled={empty} onClick={() => ui().setManyExpanded(docId, allNodes(data.roots).filter((n) => n.children.length).map((n) => n.id), true)}>
            Expand
          </button>
        </span>
      </div>
      {!empty && (
        <div className="flex flex-wrap gap-1 border-t border-line px-2 py-1 text-xs text-ink-muted">
          <button className="btn h-6 px-1.5 text-xs" title="Save the current expanded/collapsed state as the default in the file" onClick={() => void setAllOpenAction(docId, true)}>
            Open all by default
          </button>
          <button className="btn h-6 px-1.5 text-xs" onClick={() => void setAllOpenAction(docId, false)}>
            Close all by default
          </button>
          <button className="btn h-6 px-1.5 text-xs" onClick={() => void deleteAllAction(docId)}>
            Delete all
          </button>
        </div>
      )}
      {data.warnings.length > 0 && !empty && (
        <p className="border-t border-line px-2 py-1 text-xs text-ink-muted" role="note" onFocus={() => announce(data.warnings[0])}>
          {data.warnings[0]}
        </p>
      )}
      {selectedRow === undefined && filtering && rows.length === 0 && <p className="p-3 text-sm text-ink-muted">No bookmark matches “{filter}”.</p>}
    </div>
  )
}

/** Inline title editor: Enter saves, Escape cancels, leaving the field saves. */
function TitleEditor({ initial, onDone }: { initial: string; onDone(title: string | null): void }): JSX.Element {
  const done = useRef(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (save: boolean): void => {
    if (done.current) return
    done.current = true
    const v = ref.current?.value.trim() ?? ''
    onDone(save && v && v !== initial.trim() ? v : null)
  }
  return (
    <input
      ref={ref}
      dir="auto"
      aria-label="Bookmark title"
      defaultValue={initial}
      maxLength={1000}
      className="field h-6 min-w-0 flex-1 px-1 text-sm"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}
