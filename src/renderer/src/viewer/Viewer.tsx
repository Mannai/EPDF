import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { currentBytes, reloadFromDisk, undo, useEditInfo } from '../edit/session'
import { isEditableTarget } from '../features/keys'
import { PasswordCancelledError, loadDoc, type LoadedDoc } from '../pdf/docCache'
import { useSearch } from '../state/search'
import { useTabs, type Tab } from '../state/tabs'
import { useUi } from '../state/ui'
import { PageView } from './PageView'
import {
  CSS_SCALE,
  PAGE_GAP,
  PAGE_PAD_X,
  buildLayout,
  clampZoom,
  columnsFor,
  currentPageAt,
  fitPageScale,
  fitWidthScale,
  groupPages,
  rowAt,
  visibleRows,
  type PageSize
} from './layout'

const FALLBACK_SIZE: PageSize = { w: 612, h: 792 }
let docBaseUrl: string | null = null

async function getDocBaseUrl(): Promise<string> {
  docBaseUrl ??= (await window.epdf.getAppInfo()).docBaseUrl
  return docBaseUrl
}

/**
 * Loads the PDF for a tab and mirrors status/page-count into the tab store. A `loadSeq` change (reload
 * from disk) shows the "Opening…" state; a `contentSeq` change (edit/undo/redo) swaps the new document
 * in place, so the page you were looking at never flashes away.
 */
function useLoadedDoc(tab: Tab): LoadedDoc | null {
  const [loaded, setLoaded] = useState<LoadedDoc | null>(null)
  const { docId, loadSeq, contentSeq } = tab
  const nameRef = useRef(tab.name)
  nameRef.current = tab.name
  const lastLoadSeq = useRef(loadSeq)

  useEffect(() => {
    let cancelled = false
    if (lastLoadSeq.current !== loadSeq) {
      lastLoadSeq.current = loadSeq
      setLoaded(null)
    }
    void (async () => {
      try {
        const base = await getDocBaseUrl()
        // Unedited documents stream from disk; edited ones come from the in-memory edit history.
        const source = contentSeq > 0 ? { data: await currentBytes(docId) } : { url: base + docId }
        const l = await loadDoc(docId, `${loadSeq}:${contentSeq}`, source, (incorrect) =>
          useUi.getState().askPassword(nameRef.current, incorrect)
        )
        if (cancelled) return
        const t = useTabs.getState().tabs.find((x) => x.docId === docId)
        useTabs.getState().patchTab(docId, {
          status: 'ready',
          numPages: l.numPages,
          error: undefined,
          view: t && t.view.page > l.numPages ? { ...t.view, page: Math.max(1, l.numPages) } : t?.view
        } as Partial<Tab>)
        setLoaded(l)
      } catch (err) {
        if (cancelled) return
        const message =
          err instanceof PasswordCancelledError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'This file could not be opened.'
        useTabs.getState().patchTab(docId, { status: 'error', error: message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [docId, loadSeq, contentSeq])

  // Never show another tab's document while this tab's is still loading.
  return loaded && loaded.docId === docId ? loaded : null
}

interface Anchor {
  pageIndex: number
  frac: number
}

export function Viewer({ tab }: { tab: Tab }): JSX.Element {
  const loaded = useLoadedDoc(tab)
  const edit = useEditInfo(tab.docId)

  if (tab.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" role="alert">
        <p className="text-lg font-medium">Can’t open “{tab.name}”</p>
        <p className="max-w-md text-ink-muted">{tab.error}</p>
        <div className="flex gap-2">
          {edit.canUndo && (
            <button className="btn-primary" onClick={() => void undo(tab.docId)}>
              Undo {edit.undoLabel ?? 'last change'}
            </button>
          )}
          <button className={edit.canUndo ? 'btn' : 'btn-primary'} onClick={() => reloadFromDisk(tab.docId)}>
            {edit.dirty ? 'Discard changes and reload' : 'Try again'}
          </button>
        </div>
      </div>
    )
  }
  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-ink-muted" role="status">
        Opening {tab.name}…
      </div>
    )
  }
  return <LoadedViewer key={`${tab.docId}:${tab.loadSeq}`} tab={tab} loaded={loaded} />
}

function LoadedViewer({ tab, loaded }: { tab: Tab; loaded: LoadedDoc }): JSX.Element {
  const { docId, view } = tab
  const edit = useEditInfo(docId)
  const patchView = useTabs((s) => s.patchView)
  const goToPage = useTabs((s) => s.goToPage)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const [sizesVersion, setSizesVersion] = useState(loaded.sizesVersion)
  const anchor = useRef<Anchor | null>(null)
  const handledNav = useRef(0)
  const numPages = loaded.numPages

  // Track viewport size.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Re-layout as page sizes are discovered.
  useEffect(() => {
    const cb = (): void => setSizesVersion(loaded.sizesVersion)
    loaded.listeners.add(cb)
    return () => {
      loaded.listeners.delete(cb)
    }
  }, [loaded])

  const ref = loaded.sizes[0] ?? FALLBACK_SIZE
  const cols = columnsFor(view.viewMode)

  const scale = useMemo(() => {
    if (view.zoomMode === 'custom') return clampZoom(view.zoom) * CSS_SCALE
    if (size.w <= 0) return CSS_SCALE
    const input = { containerW: size.w, containerH: size.h, ref, columns: cols }
    return view.zoomMode === 'fit-width' ? fitWidthScale(input) : fitPageScale(input)
  }, [view.zoomMode, view.zoom, size.w, size.h, ref, cols])

  // Keep the stored zoom equal to the effective zoom so the toolbar and session snapshot are accurate.
  useEffect(() => {
    if (view.zoomMode === 'custom') return
    const z = Math.min(16, Math.max(0.05, scale / CSS_SCALE))
    if (Math.abs(z - view.zoom) > 0.002) patchView(docId, { zoom: z })
  }, [scale, view.zoomMode, view.zoom, docId, patchView])

  const singleIndex = view.page - 1
  const layout = useMemo(
    () =>
      buildLayout(
        numPages,
        groupPages(numPages, view.viewMode, singleIndex),
        (i) => loaded.sizes[i] ?? ref,
        scale
      ),
    // sizesVersion is the change signal for the mutable `loaded.sizes` array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [numPages, view.viewMode, view.viewMode === 'single' ? singleIndex : 0, scale, ref, sizesVersion, loaded]
  )

  const captureAnchor = useCallback(
    (top: number) => {
      const ri = rowAt(layout.rows, top)
      if (ri < 0) return
      const row = layout.rows[ri]
      anchor.current = { pageIndex: row.pages[0], frac: (top - row.top) / Math.max(row.height, 1) }
    },
    [layout]
  )

  // After any layout change (zoom, mode, discovered page sizes), keep the same content at the top.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = anchor.current
    if (!el || !a) return
    const ri = layout.pageRow[a.pageIndex]
    if (ri < 0) return
    const row = layout.rows[ri]
    const target = row.top + a.frac * row.height
    if (Math.abs(el.scrollTop - target) > 0.5) el.scrollTop = target
    setScrollTop(el.scrollTop)
  }, [layout])

  const scrollToPage = useCallback(
    (page: number) => {
      const el = scrollRef.current
      if (!el) return
      const ri = view.viewMode === 'single' ? 0 : layout.pageRow[page - 1]
      if (ri == null || ri < 0) return
      const target = Math.max(0, layout.rows[ri].top - PAGE_GAP)
      el.scrollTop = target
      captureAnchor(target)
      setScrollTop(target)
    },
    [layout, view.viewMode, captureAnchor]
  )

  // Handle goto requests (toolbar, thumbnails, menu, search, restore).
  useLayoutEffect(() => {
    if (size.w === 0 || handledNav.current === tab.navSeq) return
    handledNav.current = tab.navSeq
    scrollToPage(tab.navPage)
  }, [tab.navSeq, tab.navPage, size.w, scrollToPage])

  // Single-page mode shows a different row per page: reset to top on page change.
  useLayoutEffect(() => {
    if (view.viewMode === 'single' && scrollRef.current) {
      scrollRef.current.scrollTop = 0
      setScrollTop(0)
    }
  }, [view.viewMode, view.page])

  // Scroll → visible window, current page, anchor.
  const raf = useRef(0)
  const onScroll = useCallback(() => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const el = scrollRef.current
      if (!el) return
      const top = el.scrollTop
      setScrollTop(top)
      captureAnchor(top)
      if (view.viewMode === 'single') return
      const atEnd = top + el.clientHeight >= layout.totalHeight - 2 && top > 0
      const p = atEnd ? numPages : currentPageAt(layout, top, el.clientHeight) + 1
      if (p !== useTabs.getState().tabs.find((t) => t.docId === docId)?.view.page) patchView(docId, { page: p })
    })
  }, [layout, view.viewMode, numPages, docId, patchView, captureAnchor])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  // Ctrl/Cmd + wheel zooms (must be a non-passive listener to preventDefault).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const cur = useTabs.getState().tabs.find((t) => t.docId === docId)
      if (!cur) return
      // In fit modes `view.zoom` already mirrors the effective zoom, so it is always the right base.
      patchView(docId, { zoomMode: 'custom', zoom: clampZoom(cur.view.zoom * Math.pow(1.0015, -e.deltaY)) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [docId, patchView])

  // Bring a search hit's page into view when it is not on screen.
  const focusSeq = useSearch((s) => s.focusSeq)
  useEffect(() => {
    const s = useSearch.getState()
    const hit = s.flat[s.current]
    if (!hit || size.h === 0) return
    if (view.viewMode === 'single') {
      if (hit.page !== view.page) goToPage(docId, hit.page)
      return
    }
    const ri = layout.pageRow[hit.page - 1]
    if (ri < 0) return
    const row = layout.rows[ri]
    const el = scrollRef.current
    const top = el?.scrollTop ?? 0
    const onScreen = row.top < top + size.h && row.top + row.height > top
    if (!onScreen) goToPage(docId, hit.page)
    // Only when a new hit is selected, not on every layout change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq])

  // Announce page changes to assistive tech (debounced so scrolling isn't chatty).
  useEffect(() => {
    const t = setTimeout(() => useUi.getState().announce(`Page ${view.page} of ${numPages}`), 600)
    return () => clearTimeout(t)
  }, [view.page, numPages])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // Keys typed into an input/select/textarea that lives on a page (form fields, signature placement,
    // text boxes...) belong to that control, not to page navigation.
    if (isEditableTarget(e.target)) return
    const el = scrollRef.current
    if (!el) return
    const step = cols
    const noHScroll = el.scrollWidth <= el.clientWidth + 1
    const go = (p: number): void => {
      e.preventDefault()
      goToPage(docId, p)
    }
    if (e.key === 'ArrowRight' && noHScroll) go(Math.min(numPages, view.page + step))
    else if (e.key === 'ArrowLeft' && noHScroll) go(Math.max(1, view.page - step))
    else if (e.key === 'PageDown' && view.viewMode === 'single' && el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
      go(Math.min(numPages, view.page + 1))
    else if (e.key === 'PageUp' && view.viewMode === 'single' && el.scrollTop <= 1) go(Math.max(1, view.page - 1))
    else if (e.key === 'Home') go(1)
    else if (e.key === 'End') go(numPages)
  }

  const [first, last] = visibleRows(layout.rows, scrollTop, size.h, size.h)
  const onGoToPage = useCallback((p: number) => goToPage(docId, p), [goToPage, docId])
  const innerWidth = Math.max(size.w, layout.maxRowWidth + 2 * PAGE_PAD_X)

  return (
    <div className="relative h-full">
      {tab.changedOnDisk && (
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-3 rounded-md border border-line bg-raised px-4 py-2 shadow-lg" role="alert">
          <span>{edit.dirty ? 'This file changed on disk, and you have unsaved changes.' : 'This file changed on disk.'}</span>
          <button className="btn-primary" onClick={() => reloadFromDisk(docId)}>
            {edit.dirty ? 'Discard my changes and reload' : 'Reload'}
          </button>
          <button className="btn" onClick={() => useTabs.getState().patchTab(docId, { changedOnDisk: false })}>
            Dismiss
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        role="region"
        aria-label={`Document: ${tab.name}`}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        data-testid="viewer-scroll"
        className="absolute inset-0 overflow-auto bg-canvas outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <div style={{ height: layout.totalHeight, width: innerWidth, position: 'relative' }}>
          {layout.rows.slice(first, last + 1).map((row) => (
            <div
              key={row.pages[0]}
              style={{
                position: 'absolute',
                top: row.top,
                left: 0,
                right: 0,
                height: row.height,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-start',
                gap: PAGE_GAP
              }}
            >
              {row.pages.map((pi) => {
                const s = loaded.sizes[pi] ?? ref
                return (
                  <PageView
                    key={pi}
                    loaded={loaded}
                    pageIndex={pi}
                    scale={scale}
                    width={s.w * scale}
                    height={s.h * scale}
                    onGoToPage={onGoToPage}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
