import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IconRedo, IconUndo } from '../../components/Icons'
import { useEditInfo } from '../../edit/session'
import {
  EMPTY_SELECTION,
  clampSelection,
  clickSelect,
  columnsFor,
  describeMove,
  dropSlot,
  navigate,
  planMoveByStep,
  planReorder,
  selectAll,
  visibleRowRange,
  type NavKey,
  type PagePlan,
  type Selection
} from '@shared/features/pages/order'
import { useTabs, type Tab } from '../../state/tabs'
import { useWorkspace } from '../../state/workspace'
import { runCommand } from '../api'
import { shortcutLabel } from '../keys'
import { announce, applyPlan, deletePages, deletePagesByKey, duplicatePages, movePages, rotatePages } from './actions'
import { MAX_THUMB, MIN_THUMB, loadThumbWidth, saveThumbWidth, useOrganizerSelection, usePageDialog } from './store'
import { Thumb } from './Thumb'
import { useCurrentDoc } from './useCurrentDoc'

const PAD = 20
const CELL_PAD = 6
const GAP = 12
const LABEL_H = 24

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

interface DragState {
  indices: number[]
  slot: number
  x: number
  y: number
}

const btn = 'btn'

/**
 * The page organizer: a full-tab grid of page thumbnails. Rows are windowed (only the ones near the viewport
 * are mounted and rendered), pages can be selected with the mouse or keyboard, dragged (or moved with
 * Alt+Arrow) to reorder them, and rotated, deleted, duplicated, extracted... Each action is one undo step.
 */
export function Organizer({ tab }: { tab: Tab }): JSX.Element {
  const { docId } = tab
  const loaded = useCurrentDoc(tab)
  const edit = useEditInfo(docId)
  const n = loaded?.numPages ?? 0

  const scroller = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const [thumbW, setThumbW] = useState(loadThumbWidth)
  const [sel, setSel] = useState<Selection>({ ...EMPTY_SELECTION, focus: Math.max(0, tab.view.page - 1) })
  const selRef = useRef(sel)
  selRef.current = sel
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [focused, setFocused] = useState(false)
  const [sizesVersion, setSizesVersion] = useState(0)
  const pendingSel = useRef<number[] | null>(null)

  // ---- geometry -------------------------------------------------------------------------------------------
  const itemW = thumbW + 2 * CELL_PAD
  const cellW = itemW + GAP
  const cols = columnsFor(dims.w - 2 * PAD + GAP, cellW)
  const leftOff = Math.max(PAD, Math.floor((dims.w - (cols * cellW - GAP)) / 2))

  const aspect = useMemo(() => {
    let a = 0
    for (const s of loaded?.sizes ?? []) if (s) a = Math.max(a, s.h / s.w)
    return Math.min(1.9, Math.max(0.75, a || 1.294))
    // `sizesVersion` signals that loaded.sizes gained entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, sizesVersion])
  const thumbH = Math.round(thumbW * aspect)
  const itemH = thumbH + 2 * CELL_PAD + LABEL_H
  const rowH = itemH + GAP
  const rows = Math.ceil(n / cols)
  const total = rows * rowH + 2 * PAD
  const [firstRow, lastRow] = visibleRowRange(scrollTop - PAD, dims.h, rowH, rows, 1)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setDims({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!loaded) return
    const cb = (): void => setSizesVersion(loaded.sizesVersion)
    loaded.listeners.add(cb)
    setSizesVersion(loaded.sizesVersion)
    return () => {
      loaded.listeners.delete(cb)
    }
  }, [loaded])

  const ensureVisible = useCallback(
    (index: number) => {
      const el = scroller.current
      if (!el || cols < 1) return
      const top = PAD + Math.floor(index / cols) * rowH
      let next = el.scrollTop
      if (top - GAP < el.scrollTop) next = Math.max(0, top - PAD)
      else if (top + itemH + GAP > el.scrollTop + el.clientHeight) next = top + itemH + PAD - el.clientHeight
      if (next !== el.scrollTop) {
        el.scrollTop = next
        setScrollTop(next)
      }
    },
    [cols, rowH, itemH]
  )

  // ---- keep the tab and selection in step with the document -------------------------------------------------
  useEffect(() => {
    if (!loaded) return
    const t = useTabs.getState().tabs.find((x) => x.docId === docId)
    if (t && (t.numPages !== loaded.numPages || t.view.page > loaded.numPages)) {
      useTabs.getState().patchTab(docId, {
        numPages: loaded.numPages,
        view: t.view.page > loaded.numPages ? { ...t.view, page: Math.max(1, loaded.numPages) } : t.view
      })
    }
    const pending = pendingSel.current
    pendingSel.current = null
    if (pending) {
      setSel({ selected: pending, anchor: pending[0] ?? null, focus: pending[0] ?? 0 })
      if (pending.length) setTimeout(() => ensureVisible(pending[0]), 0)
    } else setSel((prev) => clampSelection(prev, loaded.numPages))
    if (waitingLoad.current) release()
    // ensureVisible depends on geometry; only react to a new document here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  useEffect(() => {
    useOrganizerSelection.getState().set(docId, sel.selected)
  }, [docId, sel.selected])
  useEffect(() => () => useOrganizerSelection.getState().set(docId, null), [docId])

  // Start at the page the viewer was on.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !loaded || dims.h === 0) return
    started.current = true
    ensureVisible(Math.min(Math.max(0, tab.view.page - 1), loaded.numPages - 1))
    scroller.current?.focus()
  }, [loaded, dims.h, ensureVisible, tab.view.page])

  // ---- actions ----------------------------------------------------------------------------------------------
  const targets = (): number[] => (selRef.current.selected.length ? selRef.current.selected : n ? [selRef.current.focus] : [])

  // An action stays "busy" until the edited document has loaded, so the grid never shows (or acts on) stale pages.
  const waitingLoad = useRef(false)
  const release = useCallback(() => {
    waitingLoad.current = false
    busyRef.current = false
    setBusy(false)
    scroller.current?.focus()
  }, [])

  const run = useCallback(
    async (fn: () => Promise<PagePlan | boolean | null>): Promise<void> => {
      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      let edited = false
      try {
        const r = await fn()
        if (r && typeof r === 'object') pendingSel.current = r.selection
        edited = !!r
      } finally {
        if (edited) {
          waitingLoad.current = true
          setTimeout(() => waitingLoad.current && release(), 10_000) // safety net
        } else release()
      }
    },
    [release]
  )

  const done = useCallback(
    (page?: number) => {
      const p = page ?? selRef.current.focus + 1
      useWorkspace.getState().setView(docId, null)
      if (n) useTabs.getState().goToPage(docId, p)
    },
    [docId, n]
  )

  const doRotate = (delta: 90 | -90): void => void run(() => rotatePages(docId, n, targets(), delta))
  const doDelete = (): void => void run(() => deletePages(docId, n, targets()))
  const doDuplicate = (): void => void run(() => duplicatePages(docId, n, targets()))
  const doMoveStep = (delta: number): void =>
    void run(async () => {
      const pages = targets()
      const plan = planMoveByStep(n, pages, delta)
      if (!plan) return null
      const ok = await applyPlan(docId, pages.length === 1 ? `Move page ${pages[0] + 1}` : `Move ${pages.length} pages`, plan)
      if (!ok) return null
      announce(describeMove(plan.selection))
      return plan
    })
  const doMoveTo = (slot: number): void =>
    void run(async () => {
      const pages = targets()
      const plan = planReorder(n, pages, slot)
      if (!plan) return null
      const ok = await applyPlan(docId, pages.length === 1 ? `Move page ${pages[0] + 1}` : `Move ${pages.length} pages`, plan)
      if (!ok) return null
      announce(describeMove(plan.selection))
      return plan
    })
  const openDialog = (kind: 'blank' | 'insert' | 'extract' | 'split'): void => usePageDialog.getState().open(kind, docId, { pages: selRef.current.selected })

  // ---- mouse: select and drag ------------------------------------------------------------------------------
  const slotAt = useCallback(
    (clientX: number, clientY: number): number => {
      const el = scroller.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const x = clientX - rect.left + el.scrollLeft - (leftOff - GAP / 2)
      const y = clientY - rect.top + el.scrollTop - (PAD - GAP / 2)
      return dropSlot(x, y, cellW, rowH, cols, n)
    },
    [leftOff, cellW, rowH, cols, n]
  )

  const onItemPointerDown = (e: React.PointerEvent, i: number): void => {
    if (e.button !== 0 || busyRef.current) return
    scroller.current?.focus()
    const cur = selRef.current
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }
    if (mods.ctrl || mods.shift) {
      setSel(clickSelect(mods.shift && cur.anchor === null ? { ...cur, anchor: cur.focus } : cur, i, mods, n))
      return
    }
    const alreadySelected = cur.selected.includes(i)
    setSel(alreadySelected ? { ...cur, focus: i } : clickSelect(cur, i, {}, n))

    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    let lastX = startX
    let lastY = startY
    let lastSlot = 0
    let raf = 0
    let autoDir = 0
    const indices = (): number[] => (selRef.current.selected.includes(i) ? selRef.current.selected : [i])

    const update = (): void => {
      lastSlot = slotAt(lastX, lastY)
      setDrag({ indices: indices(), slot: lastSlot, x: lastX, y: lastY })
    }
    const tick = (): void => {
      const el = scroller.current
      if (el && autoDir) {
        el.scrollTop += autoDir * 16
        setScrollTop(el.scrollTop)
        update()
      }
      raf = requestAnimationFrame(tick)
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      cancelAnimationFrame(raf)
      setDrag(null)
    }
    const move = (ev: PointerEvent): void => {
      lastX = ev.clientX
      lastY = ev.clientY
      if (!dragging) {
        if (Math.hypot(lastX - startX, lastY - startY) < 5) return
        dragging = true
        raf = requestAnimationFrame(tick)
      }
      const rect = scroller.current?.getBoundingClientRect()
      autoDir = rect ? (lastY < rect.top + 48 ? -1 : lastY > rect.bottom - 48 ? 1 : 0) : 0
      update()
    }
    const up = (): void => {
      const moved = dragging
      const moving = indices()
      const slot = lastSlot
      cleanup()
      if (moved) {
        void run(async () => {
          const plan = await movePages(docId, n, moving, slot)
          if (plan) announce(describeMove(plan.selection))
          return plan
        })
      } else if (alreadySelected) setSel(clickSelect(selRef.current, i, {}, n))
    }
    const cancel = (): void => cleanup()
    const key = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        cleanup()
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }

  // ---- keyboard --------------------------------------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!loaded || busyRef.current) return
    const cur = selRef.current
    const mod = e.ctrlKey || e.metaKey
    if (e.altKey && NAV_KEYS.has(e.key)) {
      e.preventDefault()
      if (cur.selected.length === 0) setSel({ selected: [cur.focus], anchor: cur.focus, focus: cur.focus })
      if (e.key === 'Home') doMoveTo(0)
      else if (e.key === 'End') doMoveTo(n)
      else if (e.key === 'ArrowLeft') doMoveStep(-1)
      else if (e.key === 'ArrowRight') doMoveStep(1)
      else if (e.key === 'ArrowUp') doMoveStep(-cols)
      else if (e.key === 'ArrowDown') doMoveStep(cols)
      return
    }
    if (NAV_KEYS.has(e.key) && !e.altKey) {
      e.preventDefault()
      const rowsPerPage = Math.max(1, Math.floor(dims.h / rowH) - 1)
      const next = navigate(cur.focus, e.key as NavKey, cols, n, rowsPerPage, mod)
      if (e.shiftKey) setSel(clickSelect({ ...cur, anchor: cur.anchor ?? cur.focus }, next, { shift: true, ctrl: false }, n))
      else setSel({ ...cur, focus: next })
      ensureVisible(next)
      return
    }
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      setSel(selectAll(n, cur.focus))
      announce(`All ${n} pages selected.`)
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      const next = e.shiftKey ? clickSelect({ ...cur, anchor: cur.anchor ?? cur.focus }, cur.focus, { shift: true }, n) : clickSelect(cur, cur.focus, { ctrl: true }, n)
      setSel(next)
      announce(`Page ${cur.focus + 1} ${next.selected.includes(cur.focus) ? 'selected' : 'deselected'}. ${next.selected.length} selected.`)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // By key it asks first (the toolbar's Delete button is already deliberate).
      e.preventDefault()
      void run(() => deletePagesByKey(docId, n, targets()))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      done(cur.focus + 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      done(cur.focus + 1)
    }
  }

  // ---- render ----------------------------------------------------------------------------------------------
  const selected = useMemo(() => new Set(sel.selected), [sel.selected])
  const draggedSet = useMemo(() => new Set(drag?.indices ?? []), [drag?.indices])
  const items: number[] = []
  if (loaded && n > 0) for (let i = firstRow * cols; i < Math.min(n, (lastRow + 1) * cols); i++) items.push(i)
  const focusValid = loaded && sel.focus >= 0 && sel.focus < n
  const activeId = focusValid && items.includes(sel.focus) ? `org-page-${sel.focus + 1}` : undefined

  const posOf = (i: number): { left: number; top: number } => ({ left: leftOff + (i % cols) * cellW, top: PAD + Math.floor(i / cols) * rowH })
  const indicator = (() => {
    if (!drag || n === 0) return null
    const s = drag.slot
    const at = s < n ? s : n - 1
    const p = posOf(at)
    const x = s < n ? p.left - GAP / 2 - 1 : p.left + itemW + GAP / 2 - 2
    return { left: x, top: p.top, height: itemH }
  })()

  const count = sel.selected.length
  const none = count === 0

  return (
    <div
      className="flex h-full flex-col bg-surface"
      data-testid="organizer"
      aria-busy={busy || !loaded}
      onKeyDown={(e) => {
        // Escape finishes from anywhere in the organizer (the grid handles it itself when it has focus).
        if (e.key === 'Escape' && !e.defaultPrevented && e.target !== scroller.current) done()
      }}
    >
      <div role="toolbar" aria-label="Page organizer actions" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-surface px-3 py-2">
        <button className="btn-primary" onClick={() => done()}>
          Done
        </button>
        <h2 className="mx-2 text-sm font-semibold">Organize pages</h2>
        <button className="btn-icon" aria-label={edit.undoLabel ? `Undo ${edit.undoLabel}` : 'Undo'} disabled={!edit.canUndo || busy} onClick={() => void runCommand('edit.undo')}>
          <IconUndo />
        </button>
        <button className="btn-icon" aria-label={edit.redoLabel ? `Redo ${edit.redoLabel}` : 'Redo'} disabled={!edit.canRedo || busy} onClick={() => void runCommand('edit.redo')}>
          <IconRedo />
        </button>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <button className={btn} disabled={busy || !n} onClick={() => doRotate(-90)} title={`Rotate selected pages counterclockwise (${shortcutLabel('Ctrl+[')})`}>
          Rotate left
        </button>
        <button className={btn} disabled={busy || !n} onClick={() => doRotate(90)} title={`Rotate selected pages clockwise (${shortcutLabel('Ctrl+]')})`}>
          Rotate right
        </button>
        <button className={btn} disabled={busy || !n} onClick={doDuplicate}>
          Duplicate
        </button>
        <button className={btn} disabled={busy || !n} onClick={doDelete} title="Delete selected pages (Delete)">
          Delete
        </button>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <button className={btn} disabled={busy || !n || none} onClick={() => doMoveStep(-1)} title="Move selected pages earlier (Alt+Left)">
          Move earlier
        </button>
        <button className={btn} disabled={busy || !n || none} onClick={() => doMoveStep(1)} title="Move selected pages later (Alt+Right)">
          Move later
        </button>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <button className={btn} disabled={busy || !n} onClick={() => openDialog('blank')}>
          Insert blank page…
        </button>
        <button className={btn} disabled={busy || !n} onClick={() => openDialog('insert')}>
          Insert from PDF…
        </button>
        <button className={btn} disabled={busy || !n} onClick={() => openDialog('extract')}>
          Extract…
        </button>
        <button className={btn} disabled={busy || !n} onClick={() => openDialog('split')}>
          Split…
        </button>
        <span className="ml-auto flex items-center gap-2 text-ink-muted">
          <span data-testid="organizer-count">{count === 0 ? `${n} pages` : `${count} of ${n} selected`}</span>
          <label className="flex items-center gap-1.5">
            <span className="text-xs">Size</span>
            <input
              type="range"
              min={MIN_THUMB}
              max={MAX_THUMB}
              step={10}
              value={thumbW}
              aria-label="Thumbnail size"
              onChange={(e) => {
                const v = Number(e.target.value)
                setThumbW(v)
                saveThumbWidth(v)
              }}
            />
          </label>
        </span>
      </div>

      <p id="organizer-help" className="sr-only">
        Use the arrow keys to move between pages, Space to select or deselect a page, Shift plus arrows to select a range, Control A to select all,
        Alt plus arrows to move the selected pages, Delete to delete them, and Escape to finish.
      </p>

      <div
        ref={scroller}
        role="listbox"
        aria-label="Pages"
        aria-multiselectable="true"
        aria-describedby="organizer-help"
        aria-activedescendant={activeId}
        tabIndex={0}
        data-testid="organizer-grid"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-canvas outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        style={{ cursor: drag ? 'grabbing' : undefined }}
      >
        {!loaded ? (
          <p role="status" className="p-6 text-ink-muted">
            Loading pages…
          </p>
        ) : (
          <div style={{ height: total, position: 'relative' }}>
            {items.map((i) => {
              const p = posOf(i)
              const isSel = selected.has(i)
              const isFocus = focused && sel.focus === i
              return (
                <div
                  key={i}
                  id={`org-page-${i + 1}`}
                  role="option"
                  aria-selected={isSel}
                  aria-label={`Page ${i + 1} of ${n}`}
                  data-testid="organizer-page"
                  data-page={i + 1}
                  data-selected={isSel ? 'true' : 'false'}
                  onPointerDown={(e) => onItemPointerDown(e, i)}
                  className={`absolute flex touch-none flex-col items-center rounded-md ${isSel ? 'bg-accent/20 ring-2 ring-accent' : 'hover:bg-surface/60'} ${
                    isFocus ? 'outline outline-2 outline-offset-2 outline-ink' : ''
                  }`}
                  style={{ left: p.left, top: p.top, width: itemW, height: itemH, padding: CELL_PAD, opacity: draggedSet.has(i) ? 0.4 : 1, cursor: drag ? 'grabbing' : 'grab' }}
                >
                  <Thumb loaded={loaded} pageIndex={i} boxW={thumbW} boxH={thumbH} />
                  <span className={`mt-1 text-xs ${isSel ? 'font-semibold text-ink' : 'text-ink'}`} style={{ height: LABEL_H - 4 }} aria-hidden="true">
                    {i + 1}
                  </span>
                </div>
              )
            })}
            {indicator && (
              <div
                data-testid="drop-indicator"
                aria-hidden="true"
                className="pointer-events-none absolute rounded bg-accent"
                style={{ left: indicator.left, top: indicator.top, width: 4, height: indicator.height }}
              />
            )}
          </div>
        )}
      </div>

      {drag && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 rounded-md border border-accent bg-raised px-2 py-1 text-xs font-medium shadow-lg"
          style={{ left: drag.x + 14, top: drag.y + 14 }}
        >
          {drag.indices.length === 1 ? `Page ${drag.indices[0] + 1}` : `${drag.indices.length} pages`}
        </div>
      )}
    </div>
  )
}
