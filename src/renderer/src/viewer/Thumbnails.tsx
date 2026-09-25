import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RenderingCancelledException } from 'pdfjs-dist'
import type { RenderTask } from 'pdfjs-dist'
import { getLoaded, type LoadedDoc } from '../pdf/docCache'
import { useTabs, type Tab } from '../state/tabs'
import { rowAt, type PageSize } from './layout'
const THUMB_W = 128
const LABEL_H = 22
const GAP = 10
const PAD = 12

interface Item {
  top: number
  height: number
  thumbH: number
}

function ThumbImpl({ loaded, pageIndex, height, current, onSelect }: {
  loaded: LoadedDoc
  pageIndex: number
  height: number
  current: boolean
  onSelect(page: number): void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | undefined
    const timer = setTimeout(async () => {
      try {
        const page = await loaded.doc.getPage(pageIndex + 1)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const scale = THUMB_W / base.width
        const viewport = page.getViewport({ scale })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.cssText = 'width:100%;height:100%;display:block'
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        task = page.render({
          canvasContext: ctx,
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          background: 'rgb(255,255,255)'
        })
        await task.promise
        if (!cancelled) host.current?.replaceChildren(canvas)
        page.cleanup()
      } catch (err) {
        if (!(err instanceof RenderingCancelledException) && !cancelled) console.error('Thumbnail failed', err)
      }
    }, 40) // skip thumbnails the user scrolls straight past
    return () => {
      cancelled = true
      clearTimeout(timer)
      task?.cancel()
      const c = host.current?.firstElementChild as HTMLCanvasElement | null
      if (c) c.width = c.height = 0
    }
  }, [loaded, pageIndex])

  return (
    <button
      type="button"
      onClick={() => onSelect(pageIndex + 1)}
      aria-label={`Go to page ${pageIndex + 1}`}
      aria-current={current ? 'page' : undefined}
      className={`flex w-full flex-col items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        current ? 'bg-accent/15' : 'hover:bg-surface-raised'
      }`}
      style={{ height }}
    >
      <div
        ref={host}
        aria-hidden="true"
        className={`bg-white shadow ${current ? 'ring-2 ring-accent' : 'ring-1 ring-line'}`}
        style={{ width: THUMB_W, height: height - LABEL_H }}
      />
      <span className="mt-1 text-xs text-ink-muted">{pageIndex + 1}</span>
    </button>
  )
}
const Thumb = memo(ThumbImpl)

export function Thumbnails({ tab }: { tab: Tab }): JSX.Element {
  const loaded = getLoaded(tab.docId)
  const goToPage = useTabs((s) => s.goToPage)
  const scroller = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  const [top, setTop] = useState(0)
  const [version, setVersion] = useState(loaded?.sizesVersion ?? 0)
  const numPages = loaded?.numPages ?? 0

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!loaded) return
    const cb = (): void => setVersion(loaded.sizesVersion)
    loaded.listeners.add(cb)
    return () => {
      loaded.listeners.delete(cb)
    }
  }, [loaded])

  const { items, total } = useMemo(() => {
    const out: Item[] = []
    let y = PAD
    const fallback: PageSize = loaded?.sizes[0] ?? { w: 612, h: 792 }
    for (let i = 0; i < numPages; i++) {
      const s = loaded?.sizes[i] ?? fallback
      const thumbH = (THUMB_W * s.h) / s.w
      const height = thumbH + LABEL_H
      out.push({ top: y, height, thumbH })
      y += height + GAP
    }
    return { items: out, total: y + PAD }
    // `version` signals mutation of loaded.sizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, numPages, version])

  // Keep the current page's thumbnail visible.
  useEffect(() => {
    const el = scroller.current
    const it = items[tab.view.page - 1]
    if (!el || !it) return
    if (it.top < el.scrollTop || it.top + it.height > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, it.top - el.clientHeight / 3)
    }
    // Only when the page changes, not when sizes trickle in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.view.page])

  if (!loaded) return <div className="p-3 text-sm text-ink-muted">Loading…</div>

  const first = Math.max(0, rowAt(items, top - h))
  const last = Math.max(first, rowAt(items, top + 2 * h))

  return (
    <div
      ref={scroller}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      className="h-full overflow-y-auto overflow-x-hidden"
      data-testid="thumbnails"
    >
      <div style={{ height: total, position: 'relative' }}>
        {items.slice(first, last + 1).map((it, k) => {
          const i = first + k
          return (
            <div key={i} style={{ position: 'absolute', top: it.top, left: 0, right: 0, padding: '0 10px' }}>
              <Thumb loaded={loaded} pageIndex={i} height={it.height} current={tab.view.page === i + 1} onSelect={(p) => goToPage(tab.docId, p)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
