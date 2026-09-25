import { memo, useEffect, useRef, useState } from 'react'
import { RenderingCancelledException, TextLayer, setLayerDimensions } from 'pdfjs-dist'
import type { PageViewport, RenderTask } from 'pdfjs-dist'
import { getPageOverlays } from '../features/api'
import type { LoadedDoc } from '../pdf/docCache'
import { getPageText, itemIndexAt } from '../pdf/search'
import { consumeFocus, useSearch } from '../state/search'
import { useViewerOptions } from '../state/viewerOptions'
import { outputScaleFor } from './layout'

interface Props {
  loaded: LoadedDoc
  pageIndex: number
  scale: number
  width: number
  height: number
  onGoToPage(page: number): void
}

interface Link {
  left: number
  top: number
  width: number
  height: number
  url?: string
  dest?: unknown
  title: string
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
  active: boolean
}

const NO_MATCHES: never[] = []

async function resolveDestPage(loaded: LoadedDoc, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await loaded.doc.getDestination(dest) : dest
    if (!Array.isArray(explicit) || explicit.length === 0) return null
    const target = explicit[0]
    if (typeof target === 'number') return target + 1
    return (await loaded.doc.getPageIndex(target)) + 1
  } catch {
    return null
  }
}

function PageViewImpl({ loaded, pageIndex, scale, width, height, onGoToPage }: Props): JSX.Element {
  const pageNo = pageIndex + 1
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasHost = useRef<HTMLDivElement>(null)
  const textDiv = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<TextLayer | null>(null)
  const firstRender = useRef(true)
  const [links, setLinks] = useState<Link[]>([])
  const [rendered, setRendered] = useState(0)
  const [viewport, setViewport] = useState<PageViewport | null>(null)
  const [rects, setRects] = useState<Rect[]>([])

  const annotationMode = useViewerOptions((s) => s.annotationMode)
  const matches = useSearch((s) => s.byPage.get(pageNo)) ?? NO_MATCHES
  const activeIdx = useSearch((s) => {
    const h = s.flat[s.current]
    return h && h.page === pageNo ? h.index : -1
  })

  // Render canvas + text layer + link overlay. Cancelled and restarted whenever the scale changes.
  useEffect(() => {
    let cancelled = false
    let task: RenderTask | undefined
    let textLayer: TextLayer | undefined
    // Zoom gestures fire many scale changes; wait briefly so only the final one renders.
    const delay = firstRender.current ? 0 : 90
    firstRender.current = false

    const timer = setTimeout(async () => {
      try {
        const page = await loaded.doc.getPage(pageNo)
        if (cancelled) return
        const viewport = page.getViewport({ scale })

        // First time we see the true size of a page whose size was still an estimate.
        const known = loaded.sizes[pageIndex]
        const w = viewport.width / scale
        const h = viewport.height / scale
        if (!known || Math.abs(known.w - w) > 0.5 || Math.abs(known.h - h) > 0.5) {
          loaded.sizes[pageIndex] = { w, h }
          loaded.sizesVersion++
          loaded.listeners.forEach((l) => l())
        }

        const out = outputScaleFor(viewport.width, viewport.height, window.devicePixelRatio || 1)
        // Render into a fresh canvas and swap it in, so a re-render at a new zoom never flashes blank.
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(viewport.width * out))
        canvas.height = Math.max(1, Math.floor(viewport.height * out))
        canvas.style.cssText = 'width:100%;height:100%;display:block'
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        task = page.render({
          canvasContext: ctx,
          canvas,
          viewport,
          annotationMode,
          transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined,
          background: 'rgb(255,255,255)'
        })
        await task.promise
        if (cancelled) return
        const host = canvasHost.current
        if (host) {
          const old = host.firstElementChild as HTMLCanvasElement | null
          host.replaceChildren(canvas)
          if (old) old.width = old.height = 0 // release the old backing store immediately
        }

        const td = textDiv.current
        if (td) {
          td.replaceChildren()
          setLayerDimensions(td, viewport)
          textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: td, viewport })
          textLayerRef.current = textLayer
          await textLayer.render()
          if (cancelled) return
        }
        setViewport(viewport)
        setRendered((v) => v + 1)

        const annots = (await page.getAnnotations({ intent: 'display' })) as {
          subtype: string
          rect: number[]
          url?: string
          unsafeUrl?: string
          dest?: unknown
        }[]
        if (cancelled) return
        const next: Link[] = []
        for (const a of annots) {
          if (a.subtype !== 'Link' || !(a.url || a.dest)) continue
          const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1])
          const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3])
          next.push({
            left: Math.min(x1, x2),
            top: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
            url: a.url,
            dest: a.dest,
            title: a.url ? a.url : 'Jump to page'
          })
        }
        setLinks(next)
      } catch (err) {
        if (!(err instanceof RenderingCancelledException) && !cancelled) console.error(`Page ${pageNo} failed`, err)
      }
    }, delay)

    return () => {
      cancelled = true
      clearTimeout(timer)
      task?.cancel()
      textLayer?.cancel()
    }
  }, [loaded, pageIndex, pageNo, scale, annotationMode])

  // Free the canvas memory when the page scrolls far out of view (component unmounts).
  useEffect(() => {
    const host = canvasHost.current
    return () => {
      const c = host?.firstElementChild as HTMLCanvasElement | null
      if (c) c.width = c.height = 0
      void loaded.doc.getPage(pageNo).then((p) => p.cleanup()).catch(() => undefined)
    }
  }, [loaded, pageNo])

  // Compute search-hit rectangles from the text layer's DOM.
  useEffect(() => {
    if (matches.length === 0 || !textLayerRef.current) {
      setRects((r) => (r.length ? [] : r))
      return
    }
    let cancelled = false
    void getPageText(loaded.doc, pageNo).then((pt) => {
      const layer = textLayerRef.current
      const page = pageRef.current
      if (cancelled || !layer || !page) return
      const divs = layer.textDivs
      const strs = layer.textContentItemsStr
      const box = page.getBoundingClientRect()
      const out: Rect[] = []
      matches.forEach((m, mi) => {
        const first = itemIndexAt(pt.itemStarts, m.start)
        const last = itemIndexAt(pt.itemStarts, Math.max(m.start, m.end - 1))
        for (let i = first; i <= last; i++) {
          const node = divs[i]?.firstChild
          if (!node || node.nodeType !== Node.TEXT_NODE) continue
          const from = Math.max(m.start, pt.itemStarts[i]) - pt.itemStarts[i]
          const to = Math.min(m.end, pt.itemStarts[i] + (strs[i]?.length ?? 0)) - pt.itemStarts[i]
          const len = node.textContent?.length ?? 0
          if (to <= from || from >= len) continue
          const range = document.createRange()
          range.setStart(node, from)
          range.setEnd(node, Math.min(to, len))
          for (const r of Array.from(range.getClientRects())) {
            out.push({ left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height, active: mi === activeIdx })
          }
        }
      })
      setRects(out)
    })
    return () => {
      cancelled = true
    }
  }, [loaded, pageNo, matches, activeIdx, rendered])

  // Bring the selected hit into view once per navigation request.
  useEffect(() => {
    if (activeIdx < 0 || rects.length === 0) return
    if (!rects.some((r) => r.active) || !consumeFocus()) return
    pageRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [activeIdx, rects])

  const onLink = async (l: Link, e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    if (l.url) window.open(l.url, '_blank', 'noopener') // main only forwards http(s)/mailto
    else {
      const target = await resolveDestPage(loaded, l.dest)
      if (target) onGoToPage(target)
    }
  }

  return (
    <div
      ref={pageRef}
      role="group"
      aria-label={`Page ${pageNo}`}
      data-page={pageNo}
      className="epdf-page"
      style={
        {
          width,
          height,
          '--scale-factor': scale,
          '--user-unit': 1,
          '--total-scale-factor': scale
        } as React.CSSProperties
      }
    >
      <div ref={canvasHost} aria-hidden="true" className="absolute inset-0" />
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        {rects.map((r, i) => (
          <div
            key={i}
            data-active={r.active}
            className={r.active ? 'epdf-hit epdf-hit-active' : 'epdf-hit'}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
          />
        ))}
      </div>
      <div ref={textDiv} className="textLayer" />
      {links.map((l, i) => (
        <a
          key={i}
          href={l.url ?? '#'}
          title={l.title}
          aria-label={l.title}
          className="epdf-link"
          style={{ left: l.left, top: l.top, width: l.width, height: l.height }}
          onClick={(e) => void onLink(l, e)}
        />
      ))}
      {/* Feature overlays (annotation editing, form fields, signatures, redaction marks, ...).
          The layer ignores the mouse; each overlay opts in with `pointer-events-auto` where needed. */}
      <div className="epdf-overlays">
        {getPageOverlays().map((Overlay, i) => (
          <Overlay
            key={i}
            docId={loaded.docId}
            pageIndex={pageIndex}
            pageNumber={pageNo}
            scale={scale}
            width={width}
            height={height}
            viewport={viewport}
            renderVersion={rendered}
          />
        ))}
      </div>
    </div>
  )
}

export const PageView = memo(PageViewImpl)
