import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RenderingCancelledException } from 'pdfjs-dist'
import type { RenderTask } from 'pdfjs-dist'
import type { LoadedDoc } from '../../pdf/docCache'
import { CSS_SCALE, outputScaleFor } from '../../viewer/layout'
import { charMarks } from './diff/charDiff'
import { pairedWords } from './diff/enrich'
import { charRects, highlightRects, type Rect } from './diff/rects'
import { changedPairIndexes, KIND_LABEL } from './diff/summary'
import type { Change, ChangeKind, PageModel } from './diff/types'
import type { Session } from './session'
import { useCompare } from './store'

const PAD = 16
const COLGAP = 16
const HEAD_H = 34
const LABEL_H = 28
const ROW_GAP = 18
const OVERSCAN = 900

export const SYMBOL: Record<ChangeKind, string> = { removed: '−', added: '+', modified: '~', moved: '↔' }

interface Overlay {
  id: number
  kind: ChangeKind
  rect: Rect
  first: boolean
  inner: Rect[]
}

/** The highlight rectangles of every change on one side of one page pair, from the words' real geometry. */
function overlaysFor(side: 'old' | 'new', pairIndex: number, changes: Change[], oldPage: PageModel | null, newPage: PageModel | null): Overlay[] {
  const page = side === 'old' ? oldPage : newPage
  if (!page) return []
  const out: Overlay[] = []
  for (const c of changes) {
    const loc = side === 'old' ? c.old : c.new
    if (!loc || loc.pair !== pairIndex) continue
    const rects = highlightRects(page, loc.parts, 1.2)
    // Character-level marks inside modified words (only when old and new words line up one to one).
    const inner = new Map<number, Rect[]>()
    if (c.kind === 'modified' && oldPage && newPage) {
      for (const [wo, wn] of pairedWords(c)) {
        const a = oldPage.text[wo]
        const b = newPage.text[wn]
        if (a === b) continue
        const marks = charMarks(a, b)
        const w = side === 'old' ? wo : wn
        const box = { x: page.box[w * 4], y: page.box[w * 4 + 1], w: page.box[w * 4 + 2], h: page.box[w * 4 + 3] }
        inner.set(w, charRects(page.text[w], box, side === 'old' ? marks.a : marks.b))
      }
    }
    const innerRects = [...inner.values()].flat()
    rects.forEach((rect, i) => out.push({ id: c.id, kind: c.kind, rect, first: i === 0, inner: i === 0 ? innerRects : [] }))
  }
  return out
}

interface CellProps {
  loaded: LoadedDoc
  pageNo: number
  model: PageModel
  scale: number
  label: string
  side: 'old' | 'new'
  overlays: Overlay[]
  current: number | null
  flashSeq: number
  onSelect(id: number): void
}

/** One rendered page with its highlight overlays. */
const PageCell = memo(function PageCell({ loaded, pageNo, model, scale, label, side, overlays, current, flashSeq, onSelect }: CellProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const w = model.width * scale
  const h = model.height * scale

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | undefined
    const timer = setTimeout(async () => {
      try {
        const page = await loaded.doc.getPage(pageNo)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const out = outputScaleFor(viewport.width, viewport.height, window.devicePixelRatio || 1)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(viewport.width * out))
        canvas.height = Math.max(1, Math.floor(viewport.height * out))
        canvas.style.cssText = 'width:100%;height:100%;display:block'
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        task = page.render({ canvasContext: ctx, canvas, viewport, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined, background: 'rgb(255,255,255)' })
        await task.promise
        if (cancelled) return
        const old = host.current?.firstElementChild as HTMLCanvasElement | null
        host.current?.replaceChildren(canvas)
        if (old) old.width = old.height = 0
        page.cleanup()
      } catch (err) {
        if (!(err instanceof RenderingCancelledException) && !cancelled) console.error(`Compare: page ${pageNo} failed to render`, err)
      }
    }, 60) // skip pages the user scrolls straight past
    return () => {
      cancelled = true
      clearTimeout(timer)
      task?.cancel()
    }
  }, [loaded, pageNo, scale])

  useEffect(
    () => () => {
      const c = host.current?.firstElementChild as HTMLCanvasElement | null
      if (c) c.width = c.height = 0 // release the backing store
    },
    []
  )

  return (
    <div className="epdf-page" role="group" aria-label={label} data-testid="cmp-page" data-side={side} data-page={pageNo} style={{ width: w, height: h }}>
      <div ref={host} aria-hidden="true" className="absolute inset-0" />
      <div aria-hidden="true" className="absolute inset-0">
        {overlays.map((o, i) => {
          const isCurrent = o.id === current
          return (
            <div
              key={`${o.id}-${i}-${isCurrent ? flashSeq : 0}`}
              className="cmp-hl"
              data-testid="cmp-hl"
              data-change={o.id}
              data-kind={o.kind}
              data-side={side}
              data-current={isCurrent ? 'true' : undefined}
              data-flash={isCurrent ? 'true' : undefined}
              style={{ left: o.rect.x * scale, top: o.rect.y * scale, width: o.rect.w * scale, height: o.rect.h * scale }}
              onClick={() => onSelect(o.id)}
            >
              {o.first && <span className="cmp-badge">{SYMBOL[o.kind]}</span>}
              {o.inner.map((r, k) => (
                <span key={k} className="cmp-hl-inner" style={{ left: (r.x - o.rect.x) * scale, top: (r.y - o.rect.y) * scale, width: r.w * scale, height: r.h * scale }} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
})

interface PanesProps {
  docId: string
  session: Session
  current: number | null
  jumpSeq: number
  onlyChanged: boolean
  onSelect(id: number): void
}

/**
 * The synchronized side-by-side view. Old and new pages sit in ONE scroller, one aligned row per page pair, so
 * scrolling, zooming and page position are synchronized by construction; only the rows near the viewport are
 * mounted (and rendered), so a 500-page comparison stays light.
 */
export function Panes({ docId, session, current, jumpSeq, onlyChanged, onSelect }: PanesProps): JSX.Element {
  const { result, oldPages, newPages, oldSide, newSide } = session
  const patch = useCompare((s) => s.patch)
  const scroller = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const [zoom, setZoom] = useState<'fit' | number>('fit')

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setDims({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowPairs = useMemo(() => (onlyChanged ? changedPairIndexes(result) : result.pairs.map((_, i) => i)), [result, onlyChanged])
  const rowOfPair = useMemo(() => new Map(rowPairs.map((p, i) => [p, i])), [rowPairs])
  const maxW = useMemo(() => Math.max(100, ...oldPages.map((p) => p.width), ...newPages.map((p) => p.width)), [oldPages, newPages])
  const changesByPair = useMemo(() => {
    const m = new Map<number, Change[]>()
    for (const c of result.changes) {
      for (const p of new Set([c.old?.pair, c.new?.pair].filter((x): x is number => x !== undefined))) m.set(p, [...(m.get(p) ?? []), c])
    }
    return m
  }, [result])

  const halfAvail = Math.max(50, (dims.w - 2 * PAD - COLGAP) / 2)
  const fitScale = halfAvail / maxW
  const scale = zoom === 'fit' ? fitScale : zoom
  const halfW = maxW * scale
  const contentW = Math.max(dims.w, 2 * halfW + COLGAP + 2 * PAD)
  const inset = (contentW - (2 * halfW + COLGAP)) / 2

  const { tops, heights, total } = useMemo(() => {
    const tops = new Float64Array(rowPairs.length)
    const heights = new Float64Array(rowPairs.length)
    let acc = 0
    rowPairs.forEach((pi, i) => {
      const p = result.pairs[pi]
      const h = Math.max(p.old ? (oldPages[p.old - 1]?.height ?? 0) : 0, p.new ? (newPages[p.new - 1]?.height ?? 0) : 0, 100)
      tops[i] = acc
      heights[i] = LABEL_H + h * scale + ROW_GAP
      acc += heights[i]
    })
    return { tops, heights, total: acc }
  }, [rowPairs, result, oldPages, newPages, scale])

  // Visible rows (binary search over the row tops).
  const [first, last] = useMemo(() => {
    if (rowPairs.length === 0) return [0, -1]
    const find = (y: number): number => {
      let lo = 0
      let hi = tops.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (tops[mid] <= y) lo = mid
        else hi = mid - 1
      }
      return lo
    }
    return [find(scrollTop - HEAD_H - OVERSCAN), find(scrollTop + dims.h + OVERSCAN)]
  }, [rowPairs, tops, scrollTop, dims.h])

  // Scroll to the current change whenever a jump is requested.
  useEffect(() => {
    if (jumpSeq === 0 || current === null || !scroller.current) return
    const c = result.changes[current]
    if (!c) return
    const side = c.new ? 'new' : 'old'
    const loc = c.new ?? c.old!
    const row = rowOfPair.get(loc.pair)
    if (row === undefined) return
    const page = side === 'new' ? newPages[loc.page - 1] : oldPages[loc.page - 1]
    const rect = highlightRects(page, loc.parts)[0]
    const el = scroller.current
    const top = HEAD_H + tops[row] + LABEL_H + (rect?.y ?? 0) * scale - el.clientHeight * 0.35
    const cellLeft = inset + (side === 'new' ? halfW + COLGAP : 0) + (halfW - page.width * scale) / 2
    const left = cellLeft + (rect?.x ?? 0) * scale - el.clientWidth * 0.5
    el.scrollTo({ top: Math.max(0, top), left: Math.max(0, left) })
    setScrollTop(Math.max(0, top))
    // Only a new jump request scrolls; geometry changes (zoom, resize) must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSeq])

  const zoomBy = (f: number): void => setZoom(Math.min(4, Math.max(0.15, scale * f)))

  const rows: JSX.Element[] = []
  for (let i = first; i <= last && i < rowPairs.length; i++) {
    const pi = rowPairs[i]
    const p = result.pairs[pi]
    const oPage = p.old ? oldPages[p.old - 1] : null
    const nPage = p.new ? newPages[p.new - 1] : null
    const changes = changesByPair.get(pi) ?? []
    const rowH = heights[i] - LABEL_H - ROW_GAP
    const tags = [p.moved && 'moved', p.old === null && 'page added', p.new === null && 'page removed', p.old !== null && p.new !== null && p.similarity < 1 && p.similarity > 0 && !p.moved && `${Math.round(p.similarity * 100)}% similar`].filter(Boolean)
    const title = `${p.old !== null ? `Old page ${p.old}` : 'No old page'}  ·  ${p.new !== null ? `New page ${p.new}` : 'No new page'}${tags.length ? `  (${tags.join(', ')})` : ''}`
    const cell = (side: 'old' | 'new', model: PageModel | null, loaded: LoadedDoc, pageNo: number | null): JSX.Element => {
      const x = inset + (side === 'new' ? halfW + COLGAP : 0)
      if (!model || pageNo === null) {
        return (
          <div key={side} className="cmp-absent absolute" data-testid="cmp-absent" data-side={side} style={{ left: x + (halfW - (halfW * 0.98)) / 2, top: LABEL_H, width: halfW * 0.98, height: rowH }}>
            {side === 'old' ? 'This page has no counterpart in the old version (it was added).' : 'This page has no counterpart in the new version (it was removed).'}
          </div>
        )
      }
      return (
        <div key={side} className="absolute" style={{ left: x + (halfW - model.width * scale) / 2, top: LABEL_H }}>
          <PageCell
            loaded={loaded}
            pageNo={pageNo}
            model={model}
            scale={scale}
            label={`${side === 'old' ? 'Old' : 'New'} page ${pageNo}`}
            side={side}
            overlays={overlaysFor(side, pi, changes, oPage, nPage)}
            current={current}
            flashSeq={jumpSeq}
            onSelect={onSelect}
          />
        </div>
      )
    }
    rows.push(
      <div key={pi} role="group" aria-label={title} data-testid="cmp-row" data-pair={pi} className="absolute left-0 right-0" style={{ top: HEAD_H + tops[i], height: heights[i] - ROW_GAP }}>
        <h3 className="absolute left-0 right-0 truncate px-4 text-center text-xs font-semibold text-ink" style={{ top: 4 }}>
          {title}
        </h3>
        {cell('old', oPage, oldSide.loaded, p.old)}
        {cell('new', nPage, newSide.loaded, p.new)}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="compare-panes">
      <div role="toolbar" aria-label="Pane view" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
        <button className="btn-icon" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          <span aria-hidden="true">−</span>
        </button>
        <button className="btn-icon" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.25)}>
          <span aria-hidden="true">+</span>
        </button>
        <button className="btn" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>
          Fit width
        </button>
        <span className="text-xs text-ink-muted" data-testid="compare-zoom">
          {Math.round((scale / CSS_SCALE) * 100)}%
        </span>
        <label className="ml-2 flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => patch(docId, { onlyChanged: e.target.checked })} />
          Only pages with changes
        </label>
      </div>
      <div
        ref={scroller}
        role="region"
        aria-label="Old and new pages side by side"
        tabIndex={0}
        data-testid="compare-scroller"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="relative min-h-0 flex-1 overflow-auto bg-canvas outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <div style={{ width: contentW, height: HEAD_H + total + PAD, position: 'relative' }}>
          <div className="sticky top-0 z-10 flex border-b border-line bg-surface text-sm font-semibold" style={{ height: HEAD_H, width: contentW }}>
            <div className="absolute truncate px-2 py-1.5" style={{ left: inset, width: halfW }} data-testid="compare-head-old">
              Old: {oldSide.name}
            </div>
            <div className="absolute truncate px-2 py-1.5" style={{ left: inset + halfW + COLGAP, width: halfW }} data-testid="compare-head-new">
              New: {newSide.name}
            </div>
          </div>
          {rows}
        </div>
      </div>
      <p className="sr-only">
        {KIND_LABEL.removed} text is struck through, {KIND_LABEL.added.toLowerCase()} text is underlined, modified text has a double underline and moved text a dashed frame.
      </p>
    </div>
  )
}
